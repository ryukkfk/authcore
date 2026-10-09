import { afterEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';

import { RedisService } from '../redis/redis.service.js';
import {
  assertSignupLease,
  SignupAdmission,
  SignupAdmissionUnavailable,
} from './signup-admission.js';

function setup() {
  const evalCommand = vi.fn().mockResolvedValue(1);
  const getClient = vi
    .fn()
    .mockResolvedValue({ withCommandOptions: () => ({ eval: evalCommand }) });
  const admission = new SignupAdmission({ getClient } as unknown as RedisService);
  return { admission, evalCommand, getClient };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('SignupAdmission', () => {
  it('rejects an expired local lease after an event-loop pause without waiting for renewal', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { admission } = setup();
    await expect(
      admission.run(async () => {
        now = 31_000;
        assertSignupLease();
      }),
    ).rejects.toBeInstanceOf(SignupAdmissionUnavailable);
  });

  it('does not start work when an acquire response arrives after the local deadline', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { admission, evalCommand } = setup();
    evalCommand.mockImplementationOnce(async () => {
      now = 31_000;
      return 1;
    });
    const work = vi.fn();
    await expect(admission.run(work)).rejects.toBeInstanceOf(SignupAdmissionUnavailable);
    expect(work).not.toHaveBeenCalled();
    expect(evalCommand.mock.calls[1]![0]).toContain('ZREM');
  });
  it.each([0, null, [1], '1'])('fails closed before work on reply %j', async (reply) => {
    const { admission, evalCommand } = setup();
    evalCommand.mockResolvedValue(reply);
    const work = vi.fn();
    await expect(admission.run(work)).rejects.toBeInstanceOf(SignupAdmissionUnavailable);
    expect(work).not.toHaveBeenCalled();
  });

  it('fails closed on connection failure', async () => {
    const { admission, getClient } = setup();
    getClient.mockRejectedValue(new Error('secret'));
    const work = vi.fn();
    await expect(admission.run(work)).rejects.toMatchObject({
      message: 'Signup temporarily unavailable',
    });
    expect(work).not.toHaveBeenCalled();
  });

  it('uses a different token each time and preserves committed success if release fails', async () => {
    const { admission, evalCommand } = setup();
    evalCommand.mockResolvedValueOnce(1).mockRejectedValueOnce(new Error('release failed'));
    await expect(admission.run(async () => 42)).resolves.toBe(42);
    await admission.run(async () => 43);
    expect(evalCommand.mock.calls[0]![1].arguments[0]).not.toBe(
      evalCommand.mock.calls[2]![1].arguments[0],
    );
  });

  it('retains the original failure when release also fails', async () => {
    const { admission, evalCommand } = setup();
    const failure = new Error('work');
    evalCommand.mockResolvedValueOnce(1).mockRejectedValueOnce(new Error('release'));
    await expect(
      admission.run(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  it('renews long work serially and stops renewing after settlement', async () => {
    vi.useFakeTimers();
    const { admission, evalCommand } = setup();
    let finish!: () => void;
    const result = admission.run(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(40_000);
    expect(evalCommand).toHaveBeenCalledTimes(5);
    finish();
    await result;
    expect(evalCommand).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(evalCommand).toHaveBeenCalledTimes(6);
  });

  it.each([0, 'error'])(
    'blocks subsequent stages after renewal loss %s while draining work',
    async (reply) => {
      vi.useFakeTimers();
      const { admission, evalCommand } = setup();
      let finish!: () => void;
      const result = admission.run(async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        assertSignupLease();
      });
      const rejected = expect(result).rejects.toBeInstanceOf(SignupAdmissionUnavailable);
      await vi.advanceTimersByTimeAsync(1);
      if (reply === 'error') evalCommand.mockRejectedValueOnce(new Error('redis'));
      else evalCommand.mockResolvedValueOnce(0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(evalCommand).toHaveBeenCalledTimes(2);
      finish();
      await rejected;
      expect(evalCommand).toHaveBeenCalledTimes(3);
    },
  );

  it('caps local in-flight acquisitions without queuing more work', async () => {
    const { admission, evalCommand } = setup();
    let finish!: (value: number) => void;
    evalCommand.mockReturnValue(
      new Promise<number>((resolve) => {
        finish = resolve;
      }),
    );
    const work = vi.fn(async () => undefined);
    const pending = Array.from({ length: 4 }, () => admission.run(work));
    await expect(admission.run(work)).rejects.toBeInstanceOf(SignupAdmissionUnavailable);
    expect(work).not.toHaveBeenCalled();
    finish(1);
    await Promise.all(pending);
    expect(work).toHaveBeenCalledTimes(4);
  });
});
