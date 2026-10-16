import { timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { acquireSignupCapacity } from './signup-capacity.js';
import type { SignupTransaction } from './signup-transaction.js';
import {
  SignupIdempotencyClaimRepository as Claims,
  SignupIdempotencyResultRepository as Results,
  type SignupClaimBinding,
} from './repositories/signup-idempotency.repository.js';
import {
  signupIdempotencyNamespace as namespace,
  signupIdempotencyTerminalEvents as terminal,
  type SignupIdempotencyNamespace,
  type SignupIdempotencyTerminalEvent,
} from './schema/signup-terminal.js';
import type {
  SignupIdempotencyClaim,
  SignupIdempotencyResult,
} from './schema/signup-idempotency.js';

export class SignupProtocolError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'SignupProtocolError';
  }
}
export async function assertSignupDatabaseAuthority(tx: SignupTransaction): Promise<void> {
  const row = (
    await tx.execute(
      "SELECT pg_is_in_recovery() AS recovery, current_setting('fsync') AS fsync, " +
        "current_setting('synchronous_commit') AS synchronous_commit, current_setting('transaction_isolation') AS isolation",
    )
  ).rows[0];
  if (
    !row ||
    row.recovery !== false ||
    row.fsync !== 'on' ||
    row.synchronous_commit !== 'on' ||
    row.isolation !== 'read committed'
  )
    throw new SignupProtocolError('SIGNUP_DATABASE_AUTHORITY_UNAVAILABLE');
  // This checks the connected primary, not failover lineage or acknowledged-data-loss guarantees.
}
export async function readSignupDatabaseClock(tx: SignupTransaction): Promise<Date> {
  // Drizzle raw queries deliberately retain timestamptz strings. Use an explicit
  // numeric server-clock representation, avoiding client timezone/date parsing.
  const value = (
    await tx.execute(
      'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::double precision AS observed_ms',
    )
  ).rows[0]?.observed_ms;
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new SignupProtocolError('SIGNUP_CLOCK_UNAVAILABLE');
  const observed = new Date(value);
  if (!Number.isFinite(observed.getTime()))
    throw new SignupProtocolError('SIGNUP_CLOCK_UNAVAILABLE');
  return observed;
}
/** Equal prerequisite for every new execution, before account-dependent duplicate handling.
 * A later concurrent administrative grant change remains an operational containment concern.
 * Previously committed accepted proof must be observed before calling this gate.
 */
export async function assertSignupDomainPrivileges(tx: SignupTransaction): Promise<void> {
  const permitted = (
    await tx.execute(
      "SELECT bool_and(pg_catalog.has_table_privilege(current_user, relation, 'SELECT') AND " +
        "pg_catalog.has_table_privilege(current_user, relation, 'INSERT')) AS permitted " +
        "FROM (VALUES ('public.users'), ('public.password_credentials'), " +
        "('public.security_audit_events'), ('public.signup_idempotency_results'), " +
        "('public.verification_events')) AS required(relation)",
    )
  ).rows[0]?.permitted;
  if (permitted !== true) throw new SignupProtocolError('SIGNUP_REQUIRED_PRIVILEGE_UNAVAILABLE');
}
export async function readSignupNamespace(
  tx: SignupTransaction,
): Promise<SignupIdempotencyNamespace> {
  const [row] = await tx.select().from(namespace).where(eq(namespace.id, 1)).limit(1);
  if (!row) throw new SignupProtocolError('SIGNUP_NAMESPACE_UNAVAILABLE');
  const versions = (
    await tx.execute(
      'SELECT min(hmac_key_version) AS minimum, max(hmac_key_version) AS maximum FROM public.signup_idempotency_claims',
    )
  ).rows[0];
  if (
    !versions ||
    !(
      (versions.minimum === null && versions.maximum === null) ||
      (versions.minimum === row.hmacKeyVersion && versions.maximum === row.hmacKeyVersion)
    )
  )
    throw new SignupProtocolError('SIGNUP_NAMESPACE_VERSION_DRIFT');
  return row;
}
export function validateSignupClaim(
  claim: SignupIdempotencyClaim,
  binding: SignupClaimBinding,
): void {
  const sameDigest = (a: string, b: string) =>
    typeof a === 'string' &&
    typeof b === 'string' &&
    /^[0-9a-f]{64}$/.test(a) &&
    /^[0-9a-f]{64}$/.test(b) &&
    timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  if (
    claim.keyVersion !== binding.keyVersion ||
    claim.hmacKeyVersion !== binding.hmacKeyVersion ||
    claim.payloadVersion !== binding.payloadVersion ||
    !sameDigest(claim.keyDigest, binding.keyDigest) ||
    !sameDigest(claim.payloadDigest, binding.payloadDigest) ||
    !(claim.createdAt instanceof Date) ||
    !(claim.expiresAt instanceof Date) ||
    !Number.isFinite(claim.createdAt.getTime()) ||
    !Number.isFinite(claim.expiresAt.getTime()) ||
    claim.expiresAt <= claim.createdAt
  )
    throw new SignupProtocolError('SIGNUP_CLAIM_INTEGRITY_FAILURE');
}
export function validateSignupResult(result: SignupIdempotencyResult, claimId: string): void {
  if (
    result.claimId !== claimId ||
    result.resultVersion !== 1 ||
    result.statusCode !== 202 ||
    !result.responseBody ||
    Array.isArray(result.responseBody) ||
    result.responseBody.status !== 'accepted' ||
    Object.keys(result.responseBody).length !== 1 ||
    !(result.createdAt instanceof Date) ||
    !Number.isFinite(result.createdAt.getTime())
  )
    throw new SignupProtocolError('SIGNUP_RESULT_INTEGRITY_FAILURE');
}
function validateTerminal(
  event: SignupIdempotencyTerminalEvent,
  claim: SignupIdempotencyClaim,
): void {
  if (
    event.claimId !== claim.id ||
    event.eventType !== 'signup.expired' ||
    event.policyVersion !== 1 ||
    !(event.observedAt instanceof Date) ||
    !Number.isFinite(event.observedAt.getTime()) ||
    event.observedAt < claim.expiresAt ||
    !(event.recordedAt instanceof Date) ||
    !Number.isFinite(event.recordedAt.getTime())
  )
    throw new SignupProtocolError('SIGNUP_TERMINAL_INTEGRITY_FAILURE');
}
export type SignupClaimDecision =
  | { kind: 'RESULT_FOUND'; claim: SignupIdempotencyClaim; result: SignupIdempotencyResult }
  | {
      kind: 'TERMINAL_RETAINED' | 'TERMINAL_PENDING';
      claim: SignupIdempotencyClaim;
      event: SignupIdempotencyTerminalEvent;
    }
  | { kind: 'ELIGIBLE' | 'EXPIRED_WITHOUT_TERMINAL'; claim: SignupIdempotencyClaim };
const inspected = new WeakSet<SignupTransaction>();
/** One claim per owned transaction, before any domain/result writes. RESULT_FOUND is a
 * validated candidate; the service must establish fresh committed provenance before latching it.
 * A newly appended event remains PENDING until the enclosing COMMIT is independently proved.
 */
export async function inspectSignupClaim(
  tx: SignupTransaction,
  binding: SignupClaimBinding,
  mode: 'execution' | 'recovery',
  clock = readSignupDatabaseClock,
): Promise<SignupClaimDecision> {
  if (mode !== 'execution' && mode !== 'recovery')
    throw new SignupProtocolError('SIGNUP_CLAIM_MODE_INVALID');
  if (inspected.has(tx)) throw new SignupProtocolError('SIGNUP_CLAIM_ALREADY_INSPECTED');
  inspected.add(tx);
  await assertSignupDatabaseAuthority(tx);
  await acquireSignupCapacity(tx);
  const locked = await Claims.lockByKey(tx, binding);
  if (!locked) throw new SignupProtocolError('SIGNUP_CLAIM_UNAVAILABLE');
  // Fresh statements after the row-lock barrier; never infer history from a miss.
  const claim = await new Claims(tx).findByKey(binding);
  if (!claim || claim.id !== locked.id || claim.expiresAt.getTime() !== locked.expiresAt.getTime())
    throw new SignupProtocolError('SIGNUP_CLAIM_INTEGRITY_FAILURE');
  validateSignupClaim(claim, binding);
  const result = await new Results(tx).findByClaimId(claim.id);
  if (result) {
    validateSignupResult(result, claim.id);
    // No later fallible read may hide this positive candidate before the service latches it.
    return { kind: 'RESULT_FOUND', claim, result };
  }
  const [event] = await tx.select().from(terminal).where(eq(terminal.claimId, claim.id)).limit(1);
  if (event) {
    validateTerminal(event, claim);
    return { kind: 'TERMINAL_RETAINED', claim, event };
  }
  const observedAt = await clock(tx);
  if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime()))
    throw new SignupProtocolError('SIGNUP_CLOCK_UNAVAILABLE');
  if (observedAt < claim.expiresAt) return { kind: 'ELIGIBLE', claim };
  if (mode === 'recovery') return { kind: 'EXPIRED_WITHOUT_TERMINAL', claim };
  const [inserted] = await tx
    .insert(terminal)
    .values({ claimId: claim.id, eventType: 'signup.expired', policyVersion: 1, observedAt })
    .returning();
  if (!inserted) throw new SignupProtocolError('SIGNUP_TERMINAL_UNAVAILABLE');
  validateTerminal(inserted, claim);
  return { kind: 'TERMINAL_PENDING', claim, event: inserted };
}
