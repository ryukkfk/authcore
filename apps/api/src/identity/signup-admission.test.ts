import { afterEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';

import { RedisService } from '../redis/redis.service.js';
import {
  assertSignupLease,
  requireSignupAdmission,
  retainSignupWorkSettlement,
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

describe('S4 independent response and retained admission', () => {
  function gate() {
    let resolve!: () => void;
    return {
      promise: new Promise<void>((done) => {
        resolve = done;
      }),
      resolve: () => resolve(),
    };
  }
  it('requires admission for new protocol operations and retained ownership', () => {
    expect(() => requireSignupAdmission()).toThrow(SignupAdmissionUnavailable);
    expect(() => retainSignupWorkSettlement(Promise.resolve())).toThrow(SignupAdmissionUnavailable);
  });
  it('preserves an early accepted response while all four local slots retain unsettled work', async () => {
    const { admission, evalCommand } = setup();
    const pending = gate();
    const operations = Array.from({ length: 4 }, () =>
      admission.start(async () => {
        retainSignupWorkSettlement(pending.promise);
        return 202;
      }),
    );
    expect(await Promise.all(operations.map((value) => value.response))).toEqual([
      202, 202, 202, 202,
    ]);
    expect(admission.inventory()).toMatchObject({ active: 4, owners: 4, cleanupFaults: 0 });
    expect(() => admission.start(async () => 202)).toThrow(SignupAdmissionUnavailable);
    expect(
      evalCommand.mock.calls.filter(([script]) =>
        String(script).startsWith("return redis.call('ZREM'"),
      ),
    ).toHaveLength(0);
    pending.resolve();
    await Promise.all(operations.map((value) => value.settlement));
    expect(admission.inventory()).toMatchObject({ active: 0, owners: 0, cleanupFaults: 0 });
  });
  it('legacy run still waits for actual retained settlement', async () => {
    const { admission } = setup();
    const pending = gate();
    const entered = gate();
    let settled = false;
    const response = admission
      .run(async () => {
        retainSignupWorkSettlement(pending.promise);
        entered.resolve();
        return 202;
      })
      .then((value) => {
        settled = true;
        return value;
      });
    await entered.promise;
    await Promise.resolve();
    expect(settled).toBe(false);
    pending.resolve();
    expect(await response).toBe(202);
    expect(admission.inventory().active).toBe(0);
  });
  it('continues renewal until retained work settles and marks an observed renewal loss', async () => {
    vi.useFakeTimers();
    const { admission, evalCommand } = setup();
    const pending = gate();
    let signal!: AbortSignal;
    const operation = admission.start(async () => {
      signal = requireSignupAdmission().signal;
      retainSignupWorkSettlement(pending.promise);
      return 202;
    });
    expect(await operation.response).toBe(202);
    evalCommand.mockRejectedValueOnce(new Error('controlled renewal loss'));
    await vi.advanceTimersByTimeAsync(10000);
    expect(signal.aborted).toBe(true);
    expect(admission.inventory().active).toBe(1);
    pending.resolve();
    await operation.settlement;
    expect(admission.inventory().active).toBe(0);
  });
  it('shutdown rejects new admission and waits for retained native work', async () => {
    const { admission } = setup();
    const pending = gate();
    let signal!: AbortSignal;
    let drained = false;
    const operation = admission.start(async () => {
      signal = requireSignupAdmission().signal;
      retainSignupWorkSettlement(pending.promise);
      return 202;
    });
    await operation.response;
    const shutdown = admission.onApplicationShutdown().then(() => {
      drained = true;
    });
    expect(signal.aborted).toBe(true);
    expect(drained).toBe(false);
    expect(() => admission.start(async () => 202)).toThrow(SignupAdmissionUnavailable);
    pending.resolve();
    await operation.settlement;
    await shutdown;
    expect(drained).toBe(true);
    expect(admission.inventory()).toMatchObject({ active: 0, owners: 0, closing: true });
  });
  it('retention rejection is visible as cleanup degradation without erasing accepted response', async () => {
    const { admission } = setup();
    const operation = admission.start(async () => {
      retainSignupWorkSettlement(Promise.reject(new Error('controlled cleanup fault')));
      return 202;
    });
    expect(await operation.response).toBe(202);
    await operation.settlement;
    expect(admission.inventory()).toMatchObject({ active: 0, owners: 0, cleanupFaults: 1 });
  });
  it('closed response context cannot start or register late work', async () => {
    const { admission } = setup();
    const pending = gate();
    const operation = admission.start(async () => {
      const late = pending.promise.then(() => {
        expect(() => requireSignupAdmission()).toThrow(SignupAdmissionUnavailable);
        expect(() => retainSignupWorkSettlement(Promise.resolve())).toThrow(
          SignupAdmissionUnavailable,
        );
      });
      retainSignupWorkSettlement(late);
      return 202;
    });
    expect(await operation.response).toBe(202);
    pending.resolve();
    await operation.settlement;
    expect(admission.inventory().active).toBe(0);
  });
});
