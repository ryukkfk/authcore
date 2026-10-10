import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import type { DatabaseClient } from './client.js';

export const SIGNUP_LOCK_TIMEOUT_MS = 1_000;
export const SIGNUP_STATEMENT_TIMEOUT_MS = 5_000;
export const SIGNUP_TRANSACTION_TIMEOUT_MS = 15_000;
export const SIGNUP_IDLE_TRANSACTION_TIMEOUT_MS = 3_000;
export const SIGNUP_TEARDOWN_TIMEOUT_MS = 1_000;

type SignupTransaction = Pick<DatabaseClient['db'], 'execute' | 'insert' | 'select'>;

/** A deadline stops the actual transport, never just the caller's wait. */
function forceClose(connection: PoolClient): void {
  connection.connection.stream.destroy();
}

/** Own the checked-out connection, including BEGIN and session-fatal failures. */
export async function runSignupTransaction<T>(
  database: DatabaseClient,
  work: (tx: SignupTransaction) => Promise<T>,
): Promise<T> {
  const connection = await database.pool.connect();
  let fatal: Error | undefined;
  let postgresFatal: Error | undefined;
  let failed = false;
  let began = false;
  let result!: T;
  let releaseFailure: { error: unknown } | undefined;
  const stream = connection.connection.stream;
  let ended = stream.closed;
  let signalEnd!: () => void;
  const termination = new Promise<void>((resolve) => {
    signalEnd = resolve;
  });
  const onEnd = () => {
    ended = true;
    signalEnd();
  };
  // Register before BEGIN: a fatal error may close pg while work is still paused.
  connection.once('end', onEnd);
  stream.once('close', onEnd);
  const onError = (error: Error) => {
    // pg can follow the server's SQLSTATE with a generic socket-closed error.
    // Keep the first failure so cleanup cannot erase the actual timeout reason.
    fatal ??= error;
    // Unsolicited server errors carry SQLSTATE and severity (which pg exposes
    // localized). Generic socket events must not hide an operation's SQLSTATE.
    if (
      'severity' in error &&
      typeof error.severity === 'string' &&
      'code' in error &&
      typeof error.code === 'string'
    )
      postgresFatal ??= error;
  };
  // Idle transaction expiry arrives as an unsolicited pg client error event.
  connection.on('error', onError);
  const terminate = async () => {
    if (ended) return;
    const timer = setTimeout(() => {
      // A destroyed Node socket cannot send further database work. This fallback
      // is local transport settlement, NOT proof of a server-side rollback or of
      // the durable outcome of an unacknowledged COMMIT.
      forceClose(connection);
      signalEnd();
    }, SIGNUP_TEARDOWN_TIMEOUT_MS);
    try {
      try {
        // pg end()/stream close are terminal signals; pool.release(true) alone
        // only initiates end asynchronously. Keep checkout until settlement.
        void connection.end().catch(() => forceClose(connection));
      } catch {
        forceClose(connection);
      }
      await termination;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    await connection.query('BEGIN');
    began = true;
    result = await work(drizzle(connection));
    if (fatal) throw fatal;
    await connection.query('COMMIT');
  } catch (error) {
    failed = true;
    // Freeze precedence BEFORE rollback/end/release can produce secondary errors.
    // An earlier unsolicited fatal DB error supersedes a later query/lease error;
    // otherwise preserve the exact operation/setup/COMMIT error, even non-Errors.
    const primary = postgresFatal ?? error;
    if (began && !fatal) {
      const timer = setTimeout(() => forceClose(connection), SIGNUP_TEARDOWN_TIMEOUT_MS);
      try {
        await connection.query('ROLLBACK');
      } catch {
        // The primary error is already selected. Teardown below owns transport
        // cleanup even if rollback failed; no automatic COMMIT retry is safe.
      } finally {
        clearTimeout(timer);
      }
    }
    throw primary;
  } finally {
    // Conservatively evict every failed transaction, including unknown BEGIN or
    // COMMIT outcomes. Never return an aborted/dead session to another request.
    if (failed || fatal) {
      try {
        await terminate();
      } finally {
        try {
          connection.release(true);
        } catch {
          // Release/cleanup cannot replace the frozen primary transaction error.
        }
        connection.removeListener('end', onEnd);
        stream.removeListener('close', onEnd);
      }
    } else {
      try {
        connection.release();
      } catch (error) {
        releaseFailure = { error };
        await terminate();
      } finally {
        connection.removeListener('error', onError);
        connection.removeListener('end', onEnd);
        stream.removeListener('close', onEnd);
      }
    }
  }
  if (releaseFailure) throw releaseFailure.error;
  return result;
}

/** Call on the signup transaction before any writes; never on the shared pool. */
export async function setSignupTransactionTimeouts(tx: SignupTransaction): Promise<void> {
  // set_config(..., true) is transaction-local, including rollback. PostgreSQL
  // cancels statements or terminates the session; the owner must await cleanup.
  await tx.execute(sql`
    select set_config('lock_timeout', ${String(SIGNUP_LOCK_TIMEOUT_MS)}, true),
           set_config('statement_timeout', ${String(SIGNUP_STATEMENT_TIMEOUT_MS)}, true),
           set_config('idle_in_transaction_session_timeout', ${String(SIGNUP_IDLE_TRANSACTION_TIMEOUT_MS)}, true),
           set_config('transaction_timeout', ${String(SIGNUP_TRANSACTION_TIMEOUT_MS)}, true)
  `);
}
