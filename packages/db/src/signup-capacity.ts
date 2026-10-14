import { sql } from 'drizzle-orm';
import { assertSignupTransactionWork, type SignupTransaction } from './signup-transaction-owner.js';

// Reserved two-int32 namespace (ASCII AUTH). Never derive either key from request input.
export const SIGNUP_CAPACITY_NAMESPACE = 0x41555448;
export const SIGNUP_POSTGRES_SLOTS = 4;
export class SignupCapacityUnavailable extends Error {
  readonly code = 'SIGNUP_POSTGRES_CAPACITY_UNAVAILABLE';
  constructor() {
    super('SIGNUP_POSTGRES_CAPACITY_UNAVAILABLE');
    this.name = 'SignupCapacityUnavailable';
  }
}
export class SignupCapacityProtocolError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'SignupCapacityProtocolError';
  }
}
const attempted = new WeakSet<SignupTransaction>();
/** One bounded pass, one successful transaction-level slot, before any claim lock.
 * This returns a local diagnostic slot number, never a lease/fencing token or hash cap.
 * Server transaction end owns release; no explicit unlock/retry/background waiter.
 */
export async function acquireSignupCapacity(tx: SignupTransaction): Promise<number> {
  assertSignupTransactionWork(tx);
  if (attempted.has(tx)) throw new SignupCapacityProtocolError('SIGNUP_CAPACITY_ALREADY_ATTEMPTED');
  attempted.add(tx);
  for (let slot = 0; slot < SIGNUP_POSTGRES_SLOTS; slot++) {
    const row = (
      await tx.execute(
        sql`SELECT pg_catalog.pg_try_advisory_xact_lock(${SIGNUP_CAPACITY_NAMESPACE}::integer, ${slot}::integer) AS acquired`,
      )
    ).rows[0];
    if (row?.acquired === true) return slot;
    if (row?.acquired !== false)
      throw new SignupCapacityProtocolError('SIGNUP_CAPACITY_RESPONSE_INVALID');
  }
  throw new SignupCapacityUnavailable();
}
