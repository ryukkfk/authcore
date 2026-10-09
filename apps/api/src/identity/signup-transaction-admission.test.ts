import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runSignupTransaction, type DatabaseClient } from '@authcore/db';

import type { RedisService } from '../redis/redis.service.js';
import {
  assertSignupLease,
  SignupAdmission,
  SignupAdmissionUnavailable,
} from './signup-admission.js';

function setup() {
  const connections: ReturnType<typeof connection>[] = [];
  function connection() {
    return Object.assign(new EventEmitter(), {
      connection: { stream: new PassThrough() },
      query: vi.fn(async (command: string) => {
        if (command === 'ROLLBACK') throw new Error('rollback failed');
        return { rows: [] };
      }),
      end: vi.fn(() => new Promise<void>(() => {})),
      release: vi.fn(),
    });
  }
  const database = {
    pool: {
      connect: async () => {
        const client = connection();
        connections.push(client);
        return client;
      },
    },
  } as unknown as DatabaseClient;
  const evalCommand = vi.fn().mockResolvedValue(1);
  const admission = new SignupAdmission({
    getClient: async () => ({ withCommandOptions: () => ({ eval: evalCommand }) }),
  } as unknown as RedisService);
  return { connections, database, evalCommand, admission };
}

afterEach(() => vi.useRealTimers());

describe('signup admission through transaction teardown', () => {
  it('preserves idle SQLSTATE over the actual ALS lease assertion and waits for paused work', async () => {
    vi.useFakeTimers();
    const { admission, connections, database, evalCommand } = setup();
    evalCommand.mockResolvedValueOnce(1).mockResolvedValueOnce(0).mockResolvedValue(1);
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const fatal = Object.assign(new Error('idle transaction expiration'), {
      code: '25P03',
      severity: 'FATAL',
    });
    const pending = admission
      .run(() =>
        runSignupTransaction(database, async () => {
          await gate;
          assertSignupLease();
        }),
      )
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    connections[0]!.emit('error', fatal);
    connections[0]!.emit('end');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(evalCommand).toHaveBeenCalledTimes(2); // Acquired, then renewal lost.
    expect(connections[0]!.release).not.toHaveBeenCalled();
    resume();
    expect(await pending).toBe(fatal);
    expect(evalCommand).toHaveBeenCalledTimes(3);
    expect(connections[0]!.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each(['delayed end', 'forced socket close'])(
    'retains all local and Redis slots until %s, then permits reuse',
    async (mode) => {
      vi.useFakeTimers();
      const { admission, connections, database, evalCommand } = setup();
      const primary = new Error('operation failed');
      const pending = Array.from({ length: 4 }, () =>
        admission
          .run(() =>
            runSignupTransaction(database, async () => {
              throw primary;
            }),
          )
          .catch((error: unknown) => error),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(connections).toHaveLength(4);
      expect(connections.every((client) => client.end.mock.calls.length === 1)).toBe(true);
      expect(evalCommand).toHaveBeenCalledTimes(4); // Acquire only, no release.
      expect(connections.every((client) => client.release.mock.calls.length === 0)).toBe(true);
      await expect(admission.run(async () => 'overflow')).rejects.toBeInstanceOf(
        SignupAdmissionUnavailable,
      );
      expect(evalCommand).toHaveBeenCalledTimes(4);
      if (mode === 'delayed end') {
        // An error is not terminal: only end/close or forced transport destruction is.
        for (const client of connections)
          client.emit('error', new Error('secondary teardown error'));
        await vi.advanceTimersByTimeAsync(0);
        expect(evalCommand).toHaveBeenCalledTimes(4);
        for (const client of connections) client.emit('end');
      } else {
        await vi.advanceTimersByTimeAsync(999);
        expect(evalCommand).toHaveBeenCalledTimes(4);
        await vi.advanceTimersByTimeAsync(1);
        expect(connections.every((client) => client.connection.stream.destroyed)).toBe(true);
      }
      expect(await Promise.all(pending)).toEqual([primary, primary, primary, primary]);
      expect(evalCommand).toHaveBeenCalledTimes(8);
      for (const client of connections)
        expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
      await expect(
        admission.run(() => runSignupTransaction(database, async () => 42)),
      ).resolves.toBe(42);
      expect(evalCommand).toHaveBeenCalledTimes(10);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
