import { EventEmitter } from 'node:events';
import { acquireSignupCapacity, SignupCapacityUnavailable } from './signup-capacity.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from './client.js';
import {
  runOwnedSignupTransaction,
  runSignupTransaction,
  type SignupTransaction,
} from './signup-transaction-owner.js';
import {
  AcceptedProofLatch,
  deferred,
  drainSignupTransactionOwners,
  signupOwnerInventory,
} from './signup-owner-state.js';

function fixture() {
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn(async (command: string | { text: string }) => ({
      command: (typeof command === 'string' ? command : command.text).split(' ')[0]!,
      rows: [{ prior: '0', timeout_ms: 0 }],
    })),
    release: vi.fn(),
    dispose: vi.fn(async () => ({
      removed: true as const,
      transportSettled: true as const,
      diagnostics: [],
    })),
  });
  const connect = vi.fn(async () => client);
  const database = { pool: { connect, options: { max: 1 } } } as unknown as DatabaseClient;
  return { client, database, connect };
}
afterEach(() => vi.useRealTimers());
describe('S1 evidence and owned cancellation', () => {
  it('compatibility callers retain admission while quarantined disposal remains unsettled', async () => {
    vi.useFakeTimers();
    const { database, client } = fixture();
    const gate = deferred<Awaited<ReturnType<typeof client.dispose>>>();
    client.dispose.mockReturnValue(gate.promise);
    const failure = new Error('work');
    let settled = false;
    const pending = runSignupTransaction(database, async () => {
      throw failure;
    }).catch((error) => {
      settled = true;
      return error;
    });
    await vi.advanceTimersByTimeAsync(1001);
    expect(settled).toBe(false);
    expect(signupOwnerInventory(database)).toHaveLength(1);
    gate.resolve({ removed: true, transportSettled: true, diagnostics: [] });
    expect(await pending).toBe(failure);
    expect(signupOwnerInventory(database)).toEqual([]);
  });
  it.each([0, 1000, 30000])(
    'installs a bounded session timeout before BEGIN and restores inherited %s ms',
    async (inherited) => {
      const { database, client } = fixture();
      client.query.mockImplementation(async (text) => ({
        command: String(text).split(' ')[0]!,
        rows: [{ prior: String(inherited), timeout_ms: inherited }],
      }));
      const result = await runOwnedSignupTransaction(database, async () => 42);
      await result.settlement;
      const calls = client.query.mock.calls as unknown as [string, string[] | undefined][];
      const installing = calls.findIndex(
        ([q, v]) =>
          q === "SELECT set_config('transaction_timeout', $1, false)" &&
          v?.[0] === String(inherited > 0 ? Math.min(inherited, 15000) : 15000),
      );
      const begin = calls.findIndex(([q]) => q.startsWith('BEGIN'));
      expect(installing).toBeGreaterThan(-1);
      expect(installing).toBeLessThan(begin);
      expect(calls.at(-1)).toEqual([
        "SELECT set_config('transaction_timeout', $1, false)",
        [String(inherited)],
      ]);
      expect(result.outcome).toBe('COMMIT_ACK');
      expect(client.release).toHaveBeenCalledOnce();
    },
  );
  it('cancellation revokes a paused callback before any resumed SQL and retains its work', async () => {
    const { database, client } = fixture();
    const controller = new AbortController();
    const entered = deferred<void>();
    const resume = deferred<void>();
    const pending = runOwnedSignupTransaction(
      database,
      async (tx) => {
        entered.resolve();
        await resume.promise;
        await tx.execute('SELECT 999');
        return 42;
      },
      { signal: controller.signal },
    );
    await entered.promise;
    controller.abort();
    const result = await pending;
    expect(result.outcome).toBe('NOT_SUBMITTED');
    expect(signupOwnerInventory(database)).toHaveLength(1);
    resume.resolve();
    await result.workSettlement;
    await result.settlement;
    expect(
      client.query.mock.calls.some(([q]) => typeof q === 'object' && q.text === 'SELECT 999'),
    ).toBe(false);
    expect(signupOwnerInventory(database)).toEqual([]);
  });
  it('a correlated late COMMIT ACK survives cancellation and retains its callback value', async () => {
    const { database, client } = fixture();
    const controller = new AbortController();
    client.query.mockImplementation(async (text) => {
      if (text === 'COMMIT') controller.abort();
      return { command: String(text).split(' ')[0]!, rows: [{ prior: '0', timeout_ms: 0 }] };
    });
    const result = await runOwnedSignupTransaction(database, async () => 42, {
      signal: controller.signal,
    });
    await result.settlement;
    expect(result.outcome).toBe('COMMIT_ACK');
    expect(result.value).toBe(42);
    expect(client.dispose).toHaveBeenCalledOnce();
  });
  it('recovery budget starts before BEGIN rather than restarting after setup', async () => {
    vi.useFakeTimers();
    const { database, client } = fixture();
    const begin = deferred<{ command: string; rows: { prior: string; timeout_ms: number }[] }>();
    const work = deferred<number>();
    client.query.mockImplementation(async (text) =>
      text === 'BEGIN ISOLATION LEVEL READ COMMITTED'
        ? begin.promise
        : { command: String(text).split(' ')[0]!, rows: [{ prior: '0', timeout_ms: 0 }] },
    );
    const pending = runOwnedSignupTransaction(database, () => work.promise, {
      profile: 'recovery',
    });
    await vi.advanceTimersByTimeAsync(2000);
    begin.resolve({ command: 'BEGIN', rows: [{ prior: '0', timeout_ms: 0 }] });
    await vi.advanceTimersByTimeAsync(999);
    expect(client.dispose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result.primary?.error).toMatchObject({ code: 'TRANSACTION_DEADLINE' });
    expect(client.dispose).toHaveBeenCalledOnce();
    work.resolve(42);
    await result.settlement;
  });
  it('disposal rejection cannot erase ACK or fabricate successful cleanup/shutdown', async () => {
    const { database, client } = fixture();
    const fault = new Error('dispose failed');
    client.release.mockImplementation(() => {
      throw new Error('release failed');
    });
    client.dispose.mockRejectedValue(fault);
    const result = await runOwnedSignupTransaction(database, async () => 42);
    expect(result).toMatchObject({
      outcome: 'COMMIT_ACK',
      value: 42,
      cleanup: 'QUARANTINED_WITH_OWNER',
    });
    expect(result.diagnostics).toContain(fault);
    expect(signupOwnerInventory(database)).toHaveLength(1);
    let settled = false;
    void drainSignupTransactionOwners(database).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
  });
  it.each(['COMMIT', 'ROLLBACK', 'SELECT', '', 'commit'])(
    'classifies exact COMMIT completion %s',
    async (tag) => {
      const { client, database } = fixture();
      client.query.mockImplementation(async (text) => ({
        command: text === 'COMMIT' ? tag : String(text).split(' ')[0]!,
        rows: [{ prior: '0', timeout_ms: 0 }],
      }));
      const result = await runOwnedSignupTransaction(database, async () => 42);
      expect(result.outcome).toBe(
        tag === 'COMMIT' ? 'COMMIT_ACK' : tag === 'ROLLBACK' ? 'COMMIT_ROLLBACK' : 'COMMIT_UNKNOWN',
      );
      expect(result.value).toBe(tag === 'COMMIT' ? 42 : undefined);
      await result.settlement;
      expect(signupOwnerInventory(database)).toEqual([]);
    },
  );
  it('ACK survives release failure with eviction and separate diagnostic evidence', async () => {
    const { client, database } = fixture();
    const error = new Error('cleanup');
    client.release.mockImplementation(() => {
      throw error;
    });
    const result = await runOwnedSignupTransaction(database, async () => 'accepted');
    expect(result).toMatchObject({ outcome: 'COMMIT_ACK', value: 'accepted', cleanup: 'EVICTED' });
    expect(result.diagnostics).toContain(error);
    expect(client.release).toHaveBeenCalledOnce();
    expect(client.dispose).toHaveBeenCalledOnce();
  });
  it('pre-COMMIT ROLLBACK is correlated abort evidence and preserves the exact primary', async () => {
    const { database } = fixture();
    const error = new Error('work');
    const result = await runOwnedSignupTransaction(database, async () => {
      throw error;
    });
    expect(result).toMatchObject({
      outcome: 'ABORT_CONFIRMED',
      primary: { error },
      cleanup: 'EVICTED',
    });
  });
  it('lost acknowledgement stays unknown and never dispatches a cleanup ROLLBACK as proof', async () => {
    const { client, database } = fixture();
    const error = new Error('lost ACK');
    client.query.mockImplementation(async (text) => {
      if (text === 'COMMIT') throw error;
      return { command: String(text).split(' ')[0]!, rows: [{ prior: '0', timeout_ms: 0 }] };
    });
    const result = await runOwnedSignupTransaction(database, async () => 42);
    expect(result).toMatchObject({ outcome: 'COMMIT_UNKNOWN', primary: { error } });
    expect(client.query).not.toHaveBeenCalledWith('ROLLBACK', undefined);
  });
  it('pre-abort does not queue acquisition', async () => {
    const { database, connect } = fixture();
    const signal = AbortSignal.abort();
    const result = await runOwnedSignupTransaction(database, async () => 42, { signal });
    expect(result.outcome).toBe('NOT_SUBMITTED');
    expect(connect).not.toHaveBeenCalled();
    await result.settlement;
  });
  it('late checkout is retained, capacity bounded, disposed once, and never starts work', async () => {
    vi.useFakeTimers();
    const { database, client, connect } = fixture();
    const gate = deferred<typeof client>();
    connect.mockReturnValue(gate.promise);
    const work = vi.fn(async () => 42);
    const pending = runOwnedSignupTransaction(database, work);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(result).toMatchObject({ outcome: 'NOT_SUBMITTED', cleanup: 'QUARANTINED_WITH_OWNER' });
    expect(signupOwnerInventory(database)).toHaveLength(1);
    const overflow = await runOwnedSignupTransaction(database, work);
    expect(overflow.primary?.error).toMatchObject({ code: 'OWNER_CAPACITY_UNAVAILABLE' });
    expect(connect).toHaveBeenCalledOnce();
    gate.resolve(client);
    await result.settlement;
    expect(client.query).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
    expect(client.dispose).toHaveBeenCalledOnce();
    expect(signupOwnerInventory(database)).toEqual([]);
  });
  it('shutdown retains late acquisition ownership until terminal receipt', async () => {
    const { database, client, connect } = fixture();
    const gate = deferred<typeof client>();
    connect.mockReturnValue(gate.promise);
    const pending = runOwnedSignupTransaction(database, async () => 42);
    await Promise.resolve();
    let settled = false;
    const closing = drainSignupTransactionOwners(database).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve(client);
    await pending;
    await closing;
    expect(client.query).not.toHaveBeenCalled();
    expect(settled).toBe(true);
  });
  it('stalled COMMIT reaches the transaction target, owns query rejection and stays unknown', async () => {
    vi.useFakeTimers();
    const { database, client } = fixture();
    const gate = deferred<{ command: string; rows: { prior: string; timeout_ms: number }[] }>();
    client.query.mockImplementation(async (text) =>
      text === 'COMMIT'
        ? gate.promise
        : { command: String(text).split(' ')[0]!, rows: [{ prior: '0', timeout_ms: 0 }] },
    );
    client.dispose.mockImplementation(async () => {
      gate.reject(new Error('transport closed'));
      return { removed: true, transportSettled: true, diagnostics: [] };
    });
    const pending = runOwnedSignupTransaction(database, async () => 42);
    await vi.advanceTimersByTimeAsync(15000);
    const result = await pending;
    await result.settlement;
    expect(result.outcome).toBe('COMMIT_UNKNOWN');
    expect(result.value).toBeUndefined();
    expect(client.dispose).toHaveBeenCalledOnce();
    expect(signupOwnerInventory(database)).toEqual([]);
  });
  it('unsettled disposal stays quarantined past cleanup target and keeps local capacity', async () => {
    vi.useFakeTimers();
    const { database, client } = fixture();
    const gate = deferred<Awaited<ReturnType<typeof client.dispose>>>();
    client.dispose.mockReturnValue(gate.promise);
    const pending = runOwnedSignupTransaction(database, async () => {
      throw new Error('work');
    });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(result.cleanup).toBe('QUARANTINED_WITH_OWNER');
    expect(signupOwnerInventory(database)).toHaveLength(1);
    gate.resolve({ removed: true, transportSettled: true, diagnostics: [] });
    await result.settlement;
    expect(result.cleanup).toBe('EVICTED');
    expect(signupOwnerInventory(database)).toEqual([]);
  });
  it.each([
    'COMMIT',
    'ROLLBACK',
    'BEGIN',
    'SELECT 1; COMMIT',
    '/* nested /* x */ */ COMMIT',
    'SELECT $$;COMMIT$$',
  ])('forbids callback transaction control or unsupported statement: %s', async (text) => {
    const { database, client } = fixture();
    const result = await runOwnedSignupTransaction(database, async (tx) => {
      await tx.execute(text);
      return 42;
    });
    expect(result.outcome).toBe('ABORT_CONFIRMED');
    expect(result.value).toBeUndefined();
    expect(client.query.mock.calls.some(([q]) => typeof q === 'object' && q.text === text)).toBe(
      false,
    );
  });
  it('a retained adapter cannot submit after owner completion', async () => {
    const { database, client } = fixture();
    let retained!: SignupTransaction;
    const result = await runOwnedSignupTransaction(database, async (tx) => {
      retained = tx;
      return 42;
    });
    await result.settlement;
    const count = client.query.mock.calls.length;
    await expect(retained.execute('SELECT 1')).rejects.toThrow();
    expect(client.query).toHaveBeenCalledTimes(count);
  });
  it('accepted proof latch survives unrelated cleanup and attempted replacement', () => {
    const latch = new AcceptedProofLatch<Readonly<{ claimId: string }>>();
    const proof = Object.freeze({ claimId: 'test-retained-claim' });
    latch.accept(proof);
    try {
      throw new Error('cleanup');
    } catch {
      latch.accept({ claimId: 'other' });
    }
    expect(latch.proof).toBe(proof);
  });
});

describe('S3 capacity under the actual owner work capability', () => {
  function capacityFixture(schedule: unknown[]) {
    const value = fixture();
    let queries = 0;
    value.client.query.mockImplementation(async (command) => {
      const text = typeof command === 'string' ? command : command.text;
      if (text.includes('pg_try_advisory_xact_lock'))
        return { command: 'SELECT', rows: [{ acquired: schedule[queries++] }] } as never;
      return { command: text.split(' ')[0]!, rows: [{ prior: '0', timeout_ms: 0 }] };
    });
    return { ...value, queries: () => queries };
  }
  it('rejects an autocommit adapter before SQL', async () => {
    const tx = { execute: vi.fn() } as unknown as SignupTransaction;
    await expect(acquireSignupCapacity(tx)).rejects.toMatchObject({
      code: 'WORK_OWNERSHIP_REQUIRED',
    });
    expect(tx.execute).not.toHaveBeenCalled();
  });
  it('stops at one successful slot and rejects any second attempt', async () => {
    const value = capacityFixture([false, true, true, true]);
    const result = await runSignupTransaction(value.database, async (tx) => {
      const slot = await acquireSignupCapacity(tx);
      await expect(acquireSignupCapacity(tx)).rejects.toMatchObject({
        code: 'SIGNUP_CAPACITY_ALREADY_ATTEMPTED',
      });
      await expect(acquireSignupCapacity({ ...tx })).rejects.toMatchObject({
        code: 'WORK_OWNERSHIP_REQUIRED',
      });
      return slot;
    });
    expect(result).toBe(1);
    expect(value.queries()).toBe(2);
  });
  it('exhausts exactly four nonblocking probes without hidden retries', async () => {
    const value = capacityFixture([false, false, false, false]);
    await expect(
      runSignupTransaction(value.database, acquireSignupCapacity),
    ).rejects.toBeInstanceOf(SignupCapacityUnavailable);
    expect(value.queries()).toBe(4);
    expect(value.client.dispose).toHaveBeenCalledOnce();
  });
  it.each([undefined, 'true', 1])('rejects malformed server boolean %s', async (reply) => {
    const value = capacityFixture([reply]);
    await expect(runSignupTransaction(value.database, acquireSignupCapacity)).rejects.toMatchObject(
      { code: 'SIGNUP_CAPACITY_RESPONSE_INVALID' },
    );
    expect(value.queries()).toBe(1);
  });
  it('revokes the capability after transaction end without sending new SQL', async () => {
    const value = capacityFixture([true]);
    let captured!: SignupTransaction;
    await runSignupTransaction(value.database, async (tx) => {
      captured = tx;
      return acquireSignupCapacity(tx);
    });
    await expect(acquireSignupCapacity(captured)).rejects.toMatchObject({
      code: 'WORK_OWNERSHIP_REQUIRED',
    });
    expect(value.queries()).toBe(1);
  });
});
