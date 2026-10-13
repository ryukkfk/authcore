import { disposalMock } from './signup-disposal.test-support.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Pool, type Client } from 'pg';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DatabaseClient } from './client.js';
import { runSignupTransaction, SIGNUP_TEARDOWN_TIMEOUT_MS } from './signup-transaction.js';

function setup() {
  const connection = Object.assign(new EventEmitter(), {
    connection: { stream: new PassThrough() },
    query: vi
      .fn<(command: string) => Promise<{ command: string; rows: unknown[] }>>()
      .mockImplementation(async (command) => ({
        command: command.split(' ')[0]!,
        rows: [{ prior: '0', timeout_ms: 0 }],
      })),
    release: vi.fn(),
    end: vi.fn(async () => {
      connection.emit('end');
    }),
  });
  const owned = Object.assign(connection, { dispose: disposalMock(connection) });
  const database = { pool: { connect: async () => connection } } as unknown as DatabaseClient;
  return { connection: owned, database };
}

afterEach(() => vi.useRealTimers());

describe('signup transaction error precedence and teardown', () => {
  it.each(['dead query', 'lease assertion'])(
    'preserves earlier 25P03 over a later %s error',
    async (stage) => {
      const { connection, database } = setup();
      const fatal = Object.assign(new Error('idle expiration'), {
        code: '25P03',
        severity: 'FATAL',
      });
      await expect(
        runSignupTransaction(database, async (tx) => {
          connection.emit('error', fatal);
          connection.emit('error', new Error('socket closed'));
          if (stage === 'dead query') {
            connection.query.mockRejectedValue(new Error('client is not queryable'));
            await tx.execute('SELECT 1');
          }
          throw new Error('lease assertion failed');
        }),
      ).rejects.toBe(fatal);
      expect(connection.dispose).toHaveBeenCalledExactlyOnceWith();
    },
  );

  it('reuses a successful connection without ending it', async () => {
    const { connection, database } = setup();
    await expect(runSignupTransaction(database, async () => 42)).resolves.toBe(42);
    expect(
      connection.query.mock.calls
        .map(([command]) => command.split(' ')[0]!)
        .filter((command) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(command)),
    ).toEqual(['BEGIN', 'COMMIT']);
    expect(connection.end).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledExactlyOnceWith();
    expect(connection.listenerCount('error')).toBe(0);
    expect(connection.listenerCount('end')).toBe(0);
    expect(connection.connection.stream.listenerCount('close')).toBe(0);
  });

  it.each(['BEGIN', 'COMMIT', 'work'])(
    'preserves the primary %s error through eviction',
    async (stage) => {
      const { connection, database } = setup();
      const primary = Object.assign(new Error('primary SQL failure'), { code: '57014' });
      connection.query.mockImplementation(async (command) => {
        if (command.split(' ')[0] === stage) throw primary;
        return { command: command.split(' ')[0]!, rows: [{ prior: '0', timeout_ms: 0 }] };
      });
      await expect(
        runSignupTransaction(database, async () => {
          if (stage === 'work') throw primary;
          return 42;
        }),
      ).rejects.toBe(primary);
      expect(connection.dispose).toHaveBeenCalledExactlyOnceWith();
      if (stage === 'BEGIN') expect(connection.query).not.toHaveBeenCalledWith('ROLLBACK');
    },
  );

  it('does not let a fatal error first observed during rollback replace an application error', async () => {
    const { connection, database } = setup();
    const primary = new Error('application failure');
    connection.query.mockImplementation(async (command) => {
      if (command === 'ROLLBACK') {
        connection.emit(
          'error',
          Object.assign(new Error('cleanup fatal'), { code: '25P03', severity: 'FATAL' }),
        );
        throw new Error('rollback failed');
      }
      return { command: command.split(' ')[0]!, rows: [{ prior: '0', timeout_ms: 0 }] };
    });
    await expect(
      runSignupTransaction(database, async () => {
        throw primary;
      }),
    ).rejects.toBe(primary);
  });

  it.each(['application', 'SQLSTATE'])(
    'does not let a generic socket event hide the primary %s rejection',
    async (kind) => {
      const { connection, database } = setup();
      const primary =
        kind === 'SQLSTATE'
          ? Object.assign(new Error('statement failed'), { code: '57014' })
          : new Error('application failed');
      await expect(
        runSignupTransaction(database, async () => {
          connection.emit('error', new Error('socket closed'));
          throw primary;
        }),
      ).rejects.toBe(primary);
      expect(connection.dispose).toHaveBeenCalledExactlyOnceWith();
    },
  );

  it('preserves server SQLSTATE independently of localized severity text', async () => {
    const { connection, database } = setup();
    const fatal = Object.assign(new Error('idle expiration'), {
      code: '25P03',
      severity: 'localized fatal',
    });
    await expect(
      runSignupTransaction(database, async () => {
        connection.emit('error', fatal);
        throw new Error('client is not queryable');
      }),
    ).rejects.toBe(fatal);
  });

  it('preserves an application rejection of undefined', async () => {
    const { database } = setup();
    await expect(
      runSignupTransaction(database, () => Promise.reject(undefined)),
    ).rejects.toBeUndefined();
  });

  it('holds settlement and checkout until delayed termination after rollback failure', async () => {
    const { connection, database } = setup();
    const primary = new Error('application failure');
    connection.query.mockImplementation(async (command) => {
      if (command === 'ROLLBACK') throw new Error('rollback failed');
      return { command: command.split(' ')[0]!, rows: [{ prior: '0', timeout_ms: 0 }] };
    });
    connection.end.mockImplementation(() => new Promise(() => {}));
    let settled = false;
    const pending = runSignupTransaction(database, async () => {
      throw primary;
    }).catch((error: unknown) => {
      settled = true;
      return error;
    });
    await vi.waitFor(() => expect(connection.end).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(connection.release).not.toHaveBeenCalled();
    connection.emit('end');
    expect(await pending).toBe(primary);
    expect(connection.dispose).toHaveBeenCalledExactlyOnceWith();
  });

  it.each(['synchronous', 'asynchronous'])(
    'does not overwrite the application error with rollback, %s end, or release failures',
    async (mode) => {
      const { connection, database } = setup();
      const primary = new Error('application failure');
      connection.query.mockImplementation(async (command) => {
        if (command === 'ROLLBACK') throw new Error('rollback failed');
        return { command: command.split(' ')[0]!, rows: [{ prior: '0', timeout_ms: 0 }] };
      });
      if (mode === 'synchronous')
        connection.end.mockImplementation(() => {
          throw new Error('end failed');
        });
      else connection.end.mockRejectedValue(new Error('end failed'));
      connection.release.mockImplementation(() => {
        throw new Error('release failed');
      });
      await expect(
        runSignupTransaction(database, async () => {
          throw primary;
        }),
      ).rejects.toBe(primary);
      expect(connection.connection.stream.destroyed).toBe(true);
      expect(connection.dispose).toHaveBeenCalledOnce();
      expect(connection.release).not.toHaveBeenCalled();
    },
  );

  it('forces actual socket destruction at the teardown deadline before settling', async () => {
    vi.useFakeTimers();
    const { connection, database } = setup();
    const primary = new Error('application failure');
    connection.end.mockImplementation(() => new Promise(() => {}));
    let settled = false;
    const pending = runSignupTransaction(database, async () => {
      throw primary;
    }).catch((error: unknown) => {
      settled = true;
      return error;
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(SIGNUP_TEARDOWN_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    expect(connection.connection.stream.destroyed).toBe(false);
    expect(connection.release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe(primary);
    expect(connection.connection.stream.destroyed).toBe(true);
    expect(connection.dispose).toHaveBeenCalledExactlyOnceWith();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a stalled rollback by closing its actual transport and awaiting its rejection', async () => {
    vi.useFakeTimers();
    const { connection, database } = setup();
    const primary = new Error('application failure');
    let rollbackSettled = false;
    connection.query.mockImplementation(async (command) => {
      if (command === 'ROLLBACK') {
        await new Promise<void>((_resolve, reject) => {
          connection.connection.stream.once('close', () => {
            rollbackSettled = true;
            reject(new Error('rollback connection closed'));
          });
        });
      }
      return { command: command.split(' ')[0]!, rows: [{ prior: '0', timeout_ms: 0 }] };
    });
    const pending = runSignupTransaction(database, async () => {
      throw primary;
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SIGNUP_TEARDOWN_TIMEOUT_MS);
    expect(await pending).toBe(primary);
    expect(rollbackSettled).toBe(true);
    expect(connection.connection.stream.destroyed).toBe(true);
    expect(connection.dispose).toHaveBeenCalledExactlyOnceWith();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recognizes termination that happened before work rejected', async () => {
    const { connection, database } = setup();
    const fatal = Object.assign(new Error('idle expiration'), { code: '25P03', severity: 'FATAL' });
    await expect(
      runSignupTransaction(database, async () => {
        connection.emit('error', fatal);
        connection.emit('end');
        throw new Error('later lease failure');
      }),
    ).rejects.toBe(fatal);
    expect(connection.connection.stream.closed).toBe(true);
    expect(connection.dispose).toHaveBeenCalledExactlyOnceWith();
  });

  it('reuses healthy pg-pool clients, waits for eviction, and never reuses an ended client', async () => {
    let close!: () => void;
    let created = 0;
    class Transport extends EventEmitter {
      connection = { stream: new PassThrough() };
      _queryable = true;
      _ending = false;
      closed = false;
      id = ++created;
      connect(callback: () => void) {
        callback();
      }
      async query(command: string) {
        if (this.closed) throw new Error('Client was closed and is not queryable');
        if (command === 'ROLLBACK') throw new Error('rollback transport error');
        return { command: command.split(' ')[0]!, rows: [{ prior: '0', timeout_ms: 0 }] };
      }
      terminate() {
        return new Promise((resolve) => {
          this.end(() => resolve({ transportSettled: true, queriesSettled: true }));
        });
      }
      end(callback?: () => void): Promise<void> | void {
        if (this.closed) {
          callback?.();
          return Promise.resolve();
        }
        const complete = () => {
          this.closed = true;
          this.emit('end');
          callback?.();
        };
        close = complete;
        return new Promise<void>((resolve) => this.once('end', resolve));
      }
    }
    // Real pool lifecycle, deterministic in-memory transport; no PostgreSQL access.
    const pool = new Pool({
      Client: Transport as unknown as typeof Client,
      max: 1,
      idleTimeoutMillis: 0,
    });
    const database = { pool } as DatabaseClient;
    const removed = vi.fn();
    pool.on('remove', removed);
    const primary = new Error('application failure');
    await expect(runSignupTransaction(database, async () => 42)).resolves.toBe(42);
    const healthy = await pool.connect();
    expect((healthy as unknown as Transport).id).toBe(1);
    healthy.release();
    await expect(runSignupTransaction(database, async () => 43)).resolves.toBe(43);
    expect(created).toBe(1);
    const pending = runSignupTransaction(database, async () => {
      throw primary;
    }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(close).toBeTypeOf('function'));
    expect(pool.totalCount).toBe(0);
    expect((pool as Pool & { closingCount: number }).closingCount).toBe(1);
    expect(pool.idleCount).toBe(0);
    expect(removed).not.toHaveBeenCalled();
    close();
    expect(await pending).toBe(primary);
    expect(removed).toHaveBeenCalledOnce();
    expect(removed).toHaveBeenCalledWith(healthy);
    await expect(healthy.query('SELECT 1')).rejects.toThrow(
      'Client was closed and is not queryable',
    );
    const next = await pool.connect();
    expect((next as unknown as Transport).id).toBe(2);
    next.release();
    const ending = pool.end();
    close();
    await ending;
  });
});
