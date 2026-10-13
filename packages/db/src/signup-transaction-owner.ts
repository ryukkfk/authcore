import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import type { DatabaseClient } from './client.js';
import {
  deferred,
  newTransactionId,
  registerOwner,
  SignupOwnerError,
  type OwnershipRecord,
  type TransactionOutcome,
  type CleanupHealth,
} from './signup-owner-state.js';

export const SIGNUP_ACQUIRE_TIMEOUT_MS = 1_000;
export const SIGNUP_SETUP_TIMEOUT_MS = 1_000;
export const SIGNUP_LOCK_TIMEOUT_MS = 1_000;
export const SIGNUP_STATEMENT_TIMEOUT_MS = 5_000;
export const SIGNUP_TRANSACTION_TIMEOUT_MS = 15_000;
export const SIGNUP_IDLE_TRANSACTION_TIMEOUT_MS = 3_000;
export const SIGNUP_TEARDOWN_TIMEOUT_MS = 1_000;
export type SignupTransaction = Pick<DatabaseClient['db'], 'execute' | 'insert' | 'select'>;
export interface SignupOwnerOptions {
  signal?: AbortSignal;
  profile?: 'normal' | 'recovery';
}
export interface SignupTransactionEvidence<T> {
  readonly id: string;
  readonly phase: OwnershipRecord['phase'];
  readonly commandTag: string | undefined;
  readonly outcome: TransactionOutcome;
  readonly cleanup: CleanupHealth;
  readonly value: T | undefined;
  readonly primary?: { readonly error: unknown };
  readonly diagnostics: readonly unknown[];
  readonly elapsedMs: number;
  readonly settlement: Promise<void>;
  readonly workSettlement: Promise<void>;
}
interface DisposalReceipt {
  removed: true;
  transportSettled: true;
  diagnostics: readonly unknown[];
}
type OwnedClient = PoolClient & { dispose(): Promise<DisposalReceipt> };

/** Conservative single-statement boundary; values stay separately parameterized.
 * This is ownership enforcement, not SQL authorization or a substitute for restricted roles.
 */
function assertWorkStatement(text: string): void {
  let plain = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "'" || ch === '"') {
      const quote = ch;
      plain += ' ';
      i++;
      let closed = false;
      while (i < text.length) {
        if (text[i] === '\\') throw new SignupOwnerError('UNSUPPORTED_SQL_ESCAPE');
        if (text[i++] === quote) {
          if (text[i] === quote) {
            i++;
            continue;
          }
          closed = true;
          break;
        }
      }
      if (!closed) throw new SignupOwnerError('UNTERMINATED_SQL_LITERAL');
    } else if (text.startsWith('--', i)) {
      i = text.indexOf('\n', i);
      if (i < 0) break;
    } else if (text.startsWith('/*', i)) {
      let depth = 1;
      i += 2;
      while (i < text.length && depth) {
        if (text.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (text.startsWith('*/', i)) {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth) throw new SignupOwnerError('UNTERMINATED_SQL_COMMENT');
      plain += ' ';
    } else {
      if (ch === ';' || (ch === '$' && !/[0-9]/.test(text[i + 1] ?? '')))
        throw new SignupOwnerError('MULTIPLE_OR_UNSUPPORTED_SQL_STATEMENT');
      plain += ch;
      i++;
    }
  }
  if (!/^\s*(SELECT\b|INSERT\b|SET\s+LOCAL\b)/i.test(plain))
    throw new SignupOwnerError('TRANSACTION_CONTROL_FORBIDDEN');
}

/** A lost COMMIT acknowledgement stays unknown, independently of disposal health. */
export async function runOwnedSignupTransaction<T>(
  database: DatabaseClient,
  work: (tx: SignupTransaction) => Promise<T>,
  options: SignupOwnerOptions = {},
): Promise<SignupTransactionEvidence<T>> {
  const started = performance.now();
  const completion = deferred<void>();
  const interruption = deferred<never>();
  void interruption.promise.catch(() => {});
  const tasks = new Set<Promise<unknown>>();
  const diagnostics: unknown[] = [];
  const diagnose = (error: unknown) => {
    if (diagnostics.length < 32) diagnostics.push(error);
  };
  let connection: OwnedClient | undefined;
  let disposer: (() => Promise<DisposalReceipt>) | undefined;
  let disposal: Promise<void> | undefined;
  let acquiredSettled = false;
  let transportSettled = false;
  let returning = false;
  let stopped = false;
  let began = false;
  let primary: { error: unknown } | undefined;
  let postgresFatal: unknown;
  let fatal = false;
  let value: T | undefined;
  let commandTag: string | undefined;
  let unregister = () => {};
  let workSettlement = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const record: OwnershipRecord = {
    id: newTransactionId(),
    phase: 'ACQUIRING',
    outcome: 'NOT_SUBMITTED',
    cleanup: 'QUARANTINED_WITH_OWNER',
    stop: () => stop(new SignupOwnerError('OWNER_SHUTDOWN')),
    settled: completion.promise,
  };
  const finish = () => {
    if (!returning || !acquiredSettled || tasks.size || (connection && !transportSettled)) return;
    connection?.removeListener('error', onError);
    unregister();
    completion.resolve();
  };
  const track = <R>(pending: Promise<R>): Promise<R> => {
    tasks.add(pending);
    void pending.then(
      () => {
        tasks.delete(pending);
        finish();
      },
      () => {
        tasks.delete(pending);
        finish();
      },
    );
    return pending;
  };
  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    record.cleanup = 'QUARANTINED_WITH_OWNER';
    if (!disposer) {
      diagnose(new SignupOwnerError('DRIVER_DISPOSAL_CONTRACT_MISSING'));
      disposal = new Promise<void>(() => {});
    } else {
      disposal = Promise.resolve()
        .then(() => disposer!())
        .then((receipt) => {
          if (receipt?.removed !== true || receipt.transportSettled !== true)
            throw new SignupOwnerError('DRIVER_DISPOSAL_RECEIPT_INVALID');
          for (const item of receipt.diagnostics) diagnose(item);
          transportSettled = true;
          record.cleanup = 'EVICTED';
          finish();
        });
    }
    track(disposal);
    void disposal.catch(diagnose);
    return disposal;
  };
  function stop(error: unknown): void {
    if (stopped) return;
    stopped = true;
    interruption.reject(error);
    if (connection) void dispose();
  }
  function onError(error: Error): void {
    fatal = true;
    if ('code' in error && typeof error.code === 'string' && 'severity' in error)
      postgresFatal ??= error;
    if (connection) void dispose();
  }
  const abort = () => stop(new SignupOwnerError('OWNER_CANCELLED'));
  const arm = (ms: number, code: string) => {
    clearTimeout(timer);
    timer = setTimeout(() => stop(new SignupOwnerError(code)), Math.max(0, ms));
  };
  const race = <R>(pending: Promise<R>) => Promise.race([track(pending), interruption.promise]);
  const query = (text: string, values?: string[]) => {
    if (!connection) throw new SignupOwnerError('CHECKOUT_UNAVAILABLE');
    return connection.query(text, values);
  };
  try {
    unregister = registerOwner(database, record);
    if (options.signal?.aborted) throw new SignupOwnerError('OWNER_CANCELLED');
    options.signal?.addEventListener('abort', abort, { once: true });
    arm(SIGNUP_ACQUIRE_TIMEOUT_MS, 'ACQUIRE_DEADLINE');
    const acquisition = Promise.resolve()
      .then(() => {
        if (stopped) throw new SignupOwnerError('OWNER_CANCELLED');
        return database.pool.connect();
      })
      .then(
        (client) => {
          acquiredSettled = true;
          connection = client as OwnedClient;
          disposer =
            typeof connection.dispose === 'function'
              ? connection.dispose.bind(connection)
              : undefined;
          connection.on('error', onError);
          if (stopped) void dispose();
          return connection;
        },
        (error) => {
          acquiredSettled = true;
          throw error;
        },
      );
    await race(acquisition);
    if (stopped) throw new SignupOwnerError('OWNER_CANCELLED');
    record.phase = 'ACQUIRED';
    if (!disposer) throw new SignupOwnerError('DRIVER_DISPOSAL_CONTRACT_MISSING');
    const beforeBegin = performance.now();
    arm(options.profile === 'recovery' ? 3000 : SIGNUP_SETUP_TIMEOUT_MS, 'SETUP_DEADLINE');
    record.phase = 'BEGINNING';
    if ((await race(query('BEGIN ISOLATION LEVEL READ COMMITTED'))).command !== 'BEGIN')
      throw new SignupOwnerError('BEGIN_TAG_INVALID');
    began = true;
    const afterBegin = performance.now();
    const recovery = options.profile === 'recovery';
    await race(
      query(
        "SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true), " +
          "set_config('idle_in_transaction_session_timeout', $3, true), set_config('transaction_timeout', $4, true), set_config('synchronous_commit', 'on', true)",
        recovery ? ['500', '1000', '1000', '3000'] : ['1000', '5000', '3000', '15000'],
      ),
    );
    arm(
      (recovery ? beforeBegin + 3000 : afterBegin + SIGNUP_TRANSACTION_TIMEOUT_MS) -
        performance.now(),
      'TRANSACTION_DEADLINE',
    );
    record.phase = 'WORK';
    let serial = Promise.resolve();
    const failures: unknown[] = [];
    const adapter = {
      query: (config: string | { text: string }, values?: unknown[]) => {
        const pending = serial.then(async () => {
          if (stopped || fatal || record.phase !== 'WORK')
            throw new SignupOwnerError('WORK_OWNERSHIP_ENDED');
          assertWorkStatement(typeof config === 'string' ? config : config.text);
          return connection!.query(config, values);
        });
        serial = pending.then(
          () => {},
          (error) => {
            if (failures.length === 0) failures.push(error);
          },
        );
        track(pending);
        return pending;
      },
    };
    const db = drizzle(adapter as unknown as PoolClient);
    const tx = Object.freeze({
      execute: db.execute.bind(db),
      insert: db.insert.bind(db),
      select: db.select.bind(db),
    });
    const working = Promise.resolve().then(() => {
      if (stopped || fatal) throw new SignupOwnerError('WORK_OWNERSHIP_ENDED');
      return work(tx);
    });
    workSettlement = working.then(
      () => {},
      () => {},
    );
    value = await race(working);
    await race(serial);
    if (failures.length) throw failures[0];
    if (stopped || fatal) throw postgresFatal ?? new SignupOwnerError('WORK_OWNERSHIP_ENDED');
    record.phase = 'COMMIT_DISPATCH';
    record.outcome = 'COMMIT_UNKNOWN';
    const committed = track(
      query('COMMIT').then((result) => {
        if (!Array.isArray(result) && typeof result.command === 'string')
          commandTag = result.command;
        if (!Array.isArray(result) && result.command === 'COMMIT') record.outcome = 'COMMIT_ACK';
        else if (!Array.isArray(result) && result.command === 'ROLLBACK')
          record.outcome = 'COMMIT_ROLLBACK';
        return result;
      }),
    );
    await race(committed);
    if ((record.outcome as TransactionOutcome) !== 'COMMIT_ACK')
      throw new SignupOwnerError('COMMIT_TAG_NOT_ACKNOWLEDGED');
    record.phase = 'TERMINAL';
  } catch (error) {
    primary = { error: postgresFatal ?? error };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    const cleanup = async () => {
      if (!connection) return;
      record.phase = 'DISPOSING';
      if (record.outcome === 'COMMIT_ACK' && !stopped && !fatal) {
        try {
          connection.removeListener('error', onError);
          connection.release();
          transportSettled = true;
          record.cleanup = 'CLEAN';
          return;
        } catch (error) {
          connection.on('error', onError);
          diagnose(error);
        }
      }
      if (began && record.outcome === 'NOT_SUBMITTED' && !stopped && !fatal) {
        try {
          const rollback = await track(query('ROLLBACK'));
          if (!Array.isArray(rollback) && rollback.command === 'ROLLBACK')
            record.outcome = 'ABORT_CONFIRMED';
        } catch (error) {
          diagnose(error);
        }
      }
      await dispose();
    };
    const expired = deferred<void>();
    const cleanupTimer = setTimeout(() => {
      if (connection && !transportSettled) void dispose();
      expired.resolve();
    }, SIGNUP_TEARDOWN_TIMEOUT_MS);
    try {
      await Promise.race([track(cleanup()), expired.promise]);
    } catch (error) {
      diagnose(error);
    } finally {
      clearTimeout(cleanupTimer);
    }
    if (!connection && !tasks.size) acquiredSettled = true;
    if (!connection && acquiredSettled) record.cleanup = 'CLEAN';
    returning = true;
    finish();
  }
  return Object.freeze({
    id: record.id,
    get phase() {
      return record.phase;
    },
    get commandTag() {
      return commandTag;
    },
    get outcome() {
      return record.outcome;
    },
    get cleanup() {
      return record.cleanup;
    },
    get value() {
      return record.outcome === 'COMMIT_ACK' ? value : undefined;
    },
    ...(primary ? { primary: Object.freeze(primary) } : {}),
    get diagnostics() {
      return Object.freeze(diagnostics.slice());
    },
    elapsedMs: performance.now() - started,
    settlement: completion.promise,
    workSettlement,
  });
}

/** Compatibility API keeps exact operation errors. Detailed callers use the evidence API. */
export async function runSignupTransaction<T>(
  database: DatabaseClient,
  work: (tx: SignupTransaction) => Promise<T>,
  options: SignupOwnerOptions = {},
): Promise<T> {
  const evidence = await runOwnedSignupTransaction(database, work, options);
  await evidence.workSettlement;
  if (evidence.outcome === 'COMMIT_ACK') return evidence.value as T;
  if (evidence.primary) throw evidence.primary.error;
  throw new SignupOwnerError('TRANSACTION_NOT_COMMITTED');
}
