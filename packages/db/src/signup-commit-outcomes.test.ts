import { disposalMock } from './signup-disposal.test-support.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from './client.js';
import { runSignupTransaction, SIGNUP_TEARDOWN_TIMEOUT_MS } from './signup-transaction.js';
import { approvedTestUrl, Frames } from './s0-commit-proxy.test-support.js';

function fixture() {
  const client = Object.assign(new EventEmitter(), {
    connection: { stream: new PassThrough() },
    query: vi.fn(async (command: string) => ({
      command: command.split(' ')[0]!,
      rows: [{ prior: '0', timeout_ms: 0 }] as unknown[],
    })),
    release: vi.fn(),
    end: vi.fn(async () => {
      client.emit('end');
    }),
  });
  const owned = Object.assign(client, { dispose: disposalMock(client) });
  return {
    client: owned,
    database: { pool: { connect: async () => client } } as unknown as DatabaseClient,
  };
}
afterEach(() => vi.useRealTimers());

describe('S1 corrected inherited owner regressions', () => {
  it('S1-01 rejects callback success when COMMIT resolves with ROLLBACK tag', async () => {
    const { client, database } = fixture();
    client.query.mockImplementation(async (command) => ({
      command: command === 'COMMIT' ? 'ROLLBACK' : command.split(' ')[0]!,
      rows: [{ prior: '0', timeout_ms: 0 }],
    }));
    await expect(
      runSignupTransaction(database, async () => 'unsafe-current-success'),
    ).rejects.toBeInstanceOf(Error);
    expect(client.dispose).toHaveBeenCalledExactlyOnceWith();
    // COMMIT_ROLLBACK never exposes the callback value.
  });
  it('S1-02 acknowledged COMMIT survives release failure', async () => {
    const { client, database } = fixture();
    const cleanup = new Error('synthetic post-ACK release failure');
    client.release.mockImplementation(() => {
      throw cleanup;
    });
    await expect(runSignupTransaction(database, async () => 'accepted')).resolves.toBe('accepted');
    expect(
      client.query.mock.calls
        .map(([command]) => command.split(' ')[0]!)
        .filter((command) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(command)),
    ).toEqual(['BEGIN', 'COMMIT']);
    expect(client.end).toHaveBeenCalledOnce();
    // Acknowledged transaction success survives cleanup; this alone is not signup business proof.
  });
  it('S1 simulated ACK loss preserves uncertainty without a misleading later ROLLBACK', async () => {
    const { client, database } = fixture();
    const unknown = new Error('synthetic lost acknowledgement — no DB outcome evidence');
    client.query.mockImplementation(async (command) => {
      if (command === 'COMMIT') throw unknown;
      return { command: command.split(' ')[0]!, rows: [{ prior: '0', timeout_ms: 0 }] };
    });
    await expect(runSignupTransaction(database, async () => 42)).rejects.toBe(unknown);
    expect(
      client.query.mock.calls
        .map(([command]) => command.split(' ')[0]!)
        .filter((command) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(command)),
    ).toEqual(['BEGIN', 'COMMIT']);
    expect(client.dispose).toHaveBeenCalledExactlyOnceWith();
  });
  it('S1 bounds stalled COMMIT and retains its unsettled command ownership', async () => {
    vi.useFakeTimers();
    const { client, database } = fixture();
    let rejectCommit!: (error: Error) => void;
    client.query.mockImplementation(async (command) => {
      if (command === 'COMMIT')
        await new Promise<never>((_resolve, reject) => {
          rejectCommit = reject;
        });
      return { command: command.split(' ')[0]!, rows: [{ prior: '0', timeout_ms: 0 }] };
    });
    let settled = false;
    const pending = runSignupTransaction(database, async () => 42).catch((error: unknown) => {
      settled = true;
      return error;
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false); // Broken fixture query is still owned after local disposal.
    expect(client.release).not.toHaveBeenCalled();
    expect(client.connection.stream.destroyed).toBe(true);
    const late = new Error('late COMMIT transport rejection');
    rejectCommit(late);
    expect(await pending).toMatchObject({ code: 'TRANSACTION_DEADLINE' });
    expect(client.dispose).toHaveBeenCalledExactlyOnceWith();
  });
  it('S1 bounds pending acquisition and disposes late clients without invoking work', async () => {
    vi.useFakeTimers();
    const { client } = fixture();
    let deliver!: (value: typeof client) => void;
    const database = {
      pool: {
        connect: () =>
          new Promise((resolve) => {
            deliver = resolve;
          }),
      },
    } as unknown as DatabaseClient;
    const work = vi.fn(async () => 42);
    const pending = runSignupTransaction(database, work).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(work).not.toHaveBeenCalled();
    expect(client.release).not.toHaveBeenCalled();
    deliver(client);
    await vi.advanceTimersByTimeAsync(0);
    expect(await pending).toMatchObject({ code: 'ACQUIRE_DEADLINE' });
    expect(work).not.toHaveBeenCalled();
    expect(client.dispose).toHaveBeenCalledOnce();
    expect(client.query).not.toHaveBeenCalled();
    // The retained acquisition owner completes cleanup without starting callback work.
  });
  it('S0-07 evicts after teardown deadline and preserves primary error through late end', async () => {
    vi.useFakeTimers();
    const { client, database } = fixture();
    let finish!: () => void;
    client.end.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const primary = new Error('synthetic work failure');
    const pending = runSignupTransaction(database, async () => {
      throw primary;
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(SIGNUP_TEARDOWN_TIMEOUT_MS - 1);
    expect(client.release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe(primary);
    expect(client.connection.stream.destroyed).toBe(true);
    expect(client.dispose).toHaveBeenCalledExactlyOnceWith();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.dispose).toHaveBeenCalledOnce();
    expect(client.release).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('S0 harness safety and protocol decoding', () => {
  it.each([
    undefined,
    'postgresql://localhost/authcore',
    'postgresql://remote/authcore_test',
    'postgresql://localhost:5433/authcore_test',
    'postgresql://localhost/authcore_test?sslmode=disable',
    'postgresql://localhost/authcore_test#fragment',
    'invalid',
  ])('rejects unsafe target %s without connecting', (value) => {
    expect(() => approvedTestUrl(value)).toThrow();
  });
  it('rejects application URL reuse and accepts only explicit dedicated target', () => {
    const value = 'postgresql://localhost:5432/authcore_test';
    expect(() => approvedTestUrl(value, value)).toThrow();
    expect(approvedTestUrl(value).pathname).toBe('/authcore_test');
  });
  it('decodes fragmented/coalesced CommandComplete and ReadyForQuery frames', () => {
    const decoder = new Frames();
    const commit = Buffer.from([67, 0, 0, 0, 11, ...Buffer.from('COMMIT\0')]);
    const ready = Buffer.from([90, 0, 0, 0, 5, 73]);
    expect(decoder.push(commit.subarray(0, 3))).toEqual([]);
    expect(decoder.push(Buffer.concat([commit.subarray(3), ready]))).toEqual([commit, ready]);
  });
  it.each([3, 1_048_577])('rejects invalid frame length %s', (length) => {
    const frame = Buffer.alloc(5);
    frame[0] = 67;
    frame.writeInt32BE(length, 1);
    expect(() => new Frames().push(frame)).toThrow('Invalid S0 protocol frame length');
  });
});
