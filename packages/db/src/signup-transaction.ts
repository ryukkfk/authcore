import { sql } from 'drizzle-orm';
import {
  SIGNUP_LOCK_TIMEOUT_MS,
  SIGNUP_STATEMENT_TIMEOUT_MS,
  SIGNUP_IDLE_TRANSACTION_TIMEOUT_MS,
  SIGNUP_TRANSACTION_TIMEOUT_MS,
  type SignupTransaction,
} from './signup-transaction-owner.js';
export * from './signup-transaction-owner.js';

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
