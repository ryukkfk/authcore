import { hashPassword } from '@authcore/crypto';
import {
  AcceptedProofLatch,
  DuplicateUserEmailError,
  PasswordCredentialRepository,
  SecurityAuditEventRepository,
  UserRepository,
  VerificationEventRepository,
  SignupIdempotencyResultRepository as Results,
  SignupIdempotencyConflictError,
  SignupCapacityUnavailable,
  SignupOwnerError,
  SignupProtocolError,
  inspectSignupClaim,
  assertSignupDomainPrivileges,
  runOwnedSignupTransaction,
  validateSignupClaim,
  validateSignupResult,
  type DatabaseClient,
  type SignupClaimBinding,
  type SignupIdempotencyClaim,
  type SignupIdempotencyResult,
  type SignupTransactionEvidence,
} from '@authcore/db';
import {
  requireSignupAdmission,
  retainSignupWorkSettlement,
  SignupAdmissionUnavailable,
} from './signup-admission.js';
import {
  SignupBindingInputInvalid,
  SignupReservationUnavailable,
  type SignupReservationBoundary,
} from './signup-reservation.js';

export type SignupProtocolResponse =
  | { readonly status: 202; readonly body: { readonly status: 'accepted' } }
  | { readonly status: 400 | 409 | 500 | 503; readonly code: string };
export type SignupAcceptanceSource =
  'RETAINED_RESULT_T1' | 'T2_COMMIT_ACK' | 'RETAINED_RESULT_T2' | 'RETAINED_RESULT_T3';
const accepted: SignupProtocolResponse = Object.freeze({
  status: 202,
  body: Object.freeze({ status: 'accepted' }),
});
function mappedFailure(error: unknown): Exclude<SignupProtocolResponse, { status: 202 }> {
  if (error instanceof SignupBindingInputInvalid)
    return { status: 400, code: 'SIGNUP_INPUT_INVALID' };
  if (error instanceof SignupIdempotencyConflictError)
    return { status: 409, code: 'SIGNUP_IDEMPOTENCY_CONFLICT' };
  if (
    error instanceof SignupCapacityUnavailable ||
    error instanceof SignupAdmissionUnavailable ||
    error instanceof SignupReservationUnavailable
  )
    return { status: 503, code: 'SIGNUP_TEMPORARILY_UNAVAILABLE' };
  if (
    error instanceof SignupOwnerError &&
    /DEADLINE|CANCELLED|SHUTDOWN|CAPACITY_UNAVAILABLE|WORK_OWNERSHIP_ENDED/.test(error.code)
  )
    return { status: 503, code: 'SIGNUP_TEMPORARILY_UNAVAILABLE' };
  let current = error;
  for (let depth = 0; depth < 5; depth++) {
    if (typeof current !== 'object' || current === null) break;
    if (
      current instanceof SignupProtocolError &&
      [
        'SIGNUP_DATABASE_AUTHORITY_UNAVAILABLE',
        'SIGNUP_CLOCK_UNAVAILABLE',
        'SIGNUP_NAMESPACE_UNAVAILABLE',
        'SIGNUP_NAMESPACE_VERSION_DRIFT',
        'SIGNUP_NAMESPACE_ATTESTATION_DRIFT',
        'SIGNUP_CLAIM_UNAVAILABLE',
        'SIGNUP_RETAINED_CLAIM_CHANGED',
        'SIGNUP_TERMINAL_UNAVAILABLE',
      ].includes(current.code)
    )
      return { status: 503, code: 'SIGNUP_TEMPORARILY_UNAVAILABLE' };
    if (
      'code' in current &&
      typeof current.code === 'string' &&
      [
        '40001',
        '40P01',
        '55P03',
        '57014',
        '25P03',
        '25P04',
        '57P01',
        '57P02',
        '57P03',
        '08000',
        '08001',
        '08003',
        '08004',
        '08006',
        '08007',
        '53300',
        '53400',
      ].includes(current.code)
    )
      return { status: 503, code: 'SIGNUP_TEMPORARILY_UNAVAILABLE' };
    current = 'cause' in current ? current.cause : undefined;
  }
  return { status: 500, code: 'SIGNUP_INTERNAL_FAILURE' };
}
// Recovery transport failure defaults to retryable uncertainty. Only an identified
// protocol/permission/SQL invariant overrides it with a sanitized internal failure.
function explicitInternalFailure(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5; depth++) {
    if (current instanceof SignupProtocolError) return true;
    if (typeof current !== 'object' || current === null) return false;
    if ('code' in current && typeof current.code === 'string') {
      const code = current.code;
      if (
        /_INVALID|_INTEGRITY|_DRIFT|_CHANGED|_MISSING|_FORBIDDEN|COMMIT_TAG_NOT_ACKNOWLEDGED/.test(
          code,
        )
      )
        return true;
      if (['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENETUNREACH'].includes(code))
        return false;
      if (/^[0-9A-Z]{5}$/.test(code)) return mappedFailure(current).status === 500;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}
function assertKnownClaim(
  claim: SignupIdempotencyClaim,
  binding: SignupClaimBinding,
  known: SignupIdempotencyClaim,
): void {
  validateSignupClaim(claim, binding);
  if (
    claim.id !== known.id ||
    claim.expiresAt.getTime() !== known.expiresAt.getTime() ||
    claim.createdAt.getTime() !== known.createdAt.getTime()
  )
    throw new SignupProtocolError('SIGNUP_RETAINED_CLAIM_CHANGED');
}
/** Internal application protocol only. S5 owns HTTP wiring; this class never enables signup.
 * The injected hashing dependency is trusted application wiring, defaulting to established Argon2id.
 */
export class IdempotentSignupService {
  constructor(
    private readonly database: DatabaseClient,
    private readonly boundary: SignupReservationBoundary,
    private readonly dependencies: { hashPassword?: typeof hashPassword } = {},
  ) {}

  start(rawKey: string, input: unknown, options: { signal?: AbortSignal } = {}) {
    const permit = requireSignupAdmission();
    const signal = AbortSignal.any(
      options.signal ? [permit.signal, options.signal] : [permit.signal],
    );
    const proof = new AcceptedProofLatch<{ claimId: string; source: SignupAcceptanceSource }>();
    const owners: SignupTransactionEvidence<unknown>[] = [];
    const settlements: Promise<void>[] = [];
    let resolveResponse!: (value: SignupProtocolResponse) => void;
    const response = new Promise<SignupProtocolResponse>((resolve) => {
      resolveResponse = resolve;
    });
    let finalized = false;
    let phase: 'preparing' | 'reservation' | 'hashing' | 'domain' | 'recovery' | 'settling' =
      'preparing';
    const finish = (failure: SignupProtocolResponse) => {
      if (finalized) return;
      finalized = true;
      resolveResponse(proof.proof ? accepted : Object.freeze(failure));
    };
    const accept = (
      claim: SignupIdempotencyClaim,
      result: SignupIdempotencyResult,
      binding: SignupClaimBinding,
      source: SignupAcceptanceSource,
    ) => {
      validateSignupClaim(claim, binding);
      validateSignupResult(result, claim.id);
      proof.accept(Object.freeze({ claimId: claim.id, source }));
      finish(accepted);
    };
    const unavailable = () => finish({ status: 503, code: 'SIGNUP_TEMPORARILY_UNAVAILABLE' });
    const assertLive = () => {
      permit.assertActive();
      if (signal.aborted || finalized) throw new SignupAdmissionUnavailable();
    };
    const onAbort = () => {
      if (phase === 'hashing') unavailable();
    };
    signal.addEventListener('abort', onAbort);
    const observeOwner = (record: SignupTransactionEvidence<unknown>, lateProof?: () => void) => {
      owners.push(record);
      const settlement = Promise.all([record.workSettlement, record.settlement]).then(() => {
        // A correlated late ACK can refine business evidence, never start new work.
        if (record.outcome === 'COMMIT_ACK') lateProof?.();
      });
      settlements.push(settlement);
    };
    const healthyRead = (record: SignupTransactionEvidence<unknown>) =>
      record.cleanup !== 'QUARANTINED_WITH_OWNER' &&
      record.diagnostics.length === 0 &&
      !record.primary;
    const flow = Promise.resolve()
      .then(async () => {
        assertLive();
        const prepared = await this.boundary.prepare(rawKey, input);
        const { binding } = prepared;
        if (finalized) return;
        assertLive();
        phase = 'reservation';
        const reservation = await this.boundary.reserve(
          binding,
          { signal },
          {
            accepted: (claim, result) => accept(claim, result, binding, 'RETAINED_RESULT_T1'),
            owner: (record) => {
              observeOwner(record);
              if (record.cleanup === 'QUARANTINED_WITH_OWNER' && !proof.proof) unavailable();
            },
            shouldContinue: () => !finalized && !signal.aborted,
          },
        );
        if (finalized) return;
        assertLive();
        const known = reservation.claim;
        let passwordHash: string | undefined;
        // This is only a cost hint. T2 independently locks and freshly decides eligibility.
        if (reservation.observedAt < known.expiresAt) {
          phase = 'hashing';
          passwordHash = await (this.dependencies.hashPassword ?? hashPassword)(
            prepared.input.password,
          );
          if (finalized) return;
          assertLive();
        }
        phase = 'domain';
        let candidate: SignupIdempotencyResult | undefined;
        let terminalRetained = false;
        const t2 = await runOwnedSignupTransaction(
          this.database,
          async (tx) => {
            assertLive();
            await this.boundary.verify(tx, binding);
            const decision = await inspectSignupClaim(tx, binding, 'execution');
            assertKnownClaim(decision.claim, binding, known);
            if (decision.kind === 'RESULT_FOUND') {
              accept(decision.claim, decision.result, binding, 'RETAINED_RESULT_T2');
              return { kind: 'READ_ACCEPTED' } as const;
            }
            if (decision.kind === 'TERMINAL_RETAINED') {
              terminalRetained = true;
              return { kind: decision.kind } as const;
            }
            if (decision.kind === 'TERMINAL_PENDING') return { kind: decision.kind } as const;
            if (decision.kind !== 'ELIGIBLE')
              throw new SignupProtocolError('SIGNUP_EXECUTION_POLICY_INVALID');
            if (!passwordHash) throw new SignupReservationUnavailable();
            assertLive();
            await assertSignupDomainPrivileges(tx);
            assertLive();
            let created: Awaited<ReturnType<UserRepository['create']>> | undefined;
            // Only the reviewed JS duplicate error is caught; SQL failures still abort the owner.
            try {
              created = await new UserRepository(tx).create({
                email: prepared.input.email,
                emailNormalized: prepared.input.email.toLowerCase(),
              });
            } catch (error) {
              if (!(error instanceof DuplicateUserEmailError)) throw error;
            }
            if (created) {
              assertLive();
              await new PasswordCredentialRepository(tx).create({
                userId: created.id,
                passwordHash,
              });
              assertLive();
              await new VerificationEventRepository(tx).requestInitial(created.id);
              assertLive();
              await new SecurityAuditEventRepository(tx).recordUserCreated({ userId: created.id });
            }
            assertLive();
            candidate = await new Results(tx).recordAccepted(known.id);
            validateSignupResult(candidate, known.id);
            assertLive();
            return { kind: 'ATOMIC_ACCEPTED' } as const;
          },
          { signal },
        );
        // Own uncommitted result data is never a replay proof. Only exact owner ACK upgrades it.
        const acceptAtomic = () => {
          if (candidate) accept(known, candidate, binding, 'T2_COMMIT_ACK');
        };
        if (t2.outcome === 'COMMIT_ACK' && candidate) acceptAtomic();
        observeOwner(t2, acceptAtomic);
        if (finalized) return;
        if (t2.cleanup === 'QUARANTINED_WITH_OWNER') {
          unavailable();
          return;
        }
        if (
          t2.outcome === 'COMMIT_ACK' &&
          healthyRead(t2) &&
          (terminalRetained || t2.value?.kind === 'TERMINAL_PENDING')
        ) {
          finish({ status: 409, code: 'SIGNUP_IDEMPOTENCY_EXPIRED' });
          return;
        }
        if (t2.outcome !== 'COMMIT_UNKNOWN') {
          finish(mappedFailure(t2.primary?.error));
          return;
        }
        if (signal.aborted) {
          unavailable();
          return;
        }
        // Exactly one recovery; never reserve/hash/create/append a result or terminal event here.
        phase = 'recovery';
        let recoveryTerminal = false;
        const t3 = await runOwnedSignupTransaction(
          this.database,
          async (tx) => {
            await this.boundary.verify(tx, binding);
            const decision = await inspectSignupClaim(tx, binding, 'recovery');
            assertKnownClaim(decision.claim, binding, known);
            if (decision.kind === 'RESULT_FOUND')
              accept(decision.claim, decision.result, binding, 'RETAINED_RESULT_T3');
            else if (decision.kind === 'TERMINAL_RETAINED') recoveryTerminal = true;
            // A missing result is not historical rollback proof or permission to retry domain work.
          },
          { signal, profile: 'recovery', completion: 'rollback' },
        );
        observeOwner(t3);
        if (finalized) return;
        if (recoveryTerminal && t3.outcome === 'ABORT_CONFIRMED' && healthyRead(t3))
          finish({ status: 409, code: 'SIGNUP_IDEMPOTENCY_EXPIRED' });
        else if (t3.primary)
          finish(
            explicitInternalFailure(t3.primary.error)
              ? mappedFailure(t3.primary.error)
              : { status: 503, code: 'SIGNUP_TEMPORARILY_UNAVAILABLE' },
          );
        else if (t2.primary && explicitInternalFailure(t2.primary.error))
          finish(mappedFailure(t2.primary.error));
        else unavailable();
      })
      .catch((error) => finish(mappedFailure(error)))
      .finally(async () => {
        phase = 'settling';
        signal.removeEventListener('abort', onAbort);
        // Local admission retains this whole flow; no resource is called settled early.
        await Promise.all(settlements);
        if (!finalized) unavailable();
      });
    retainSignupWorkSettlement(flow);
    return Object.freeze({
      response,
      settlement: flow,
      get proof() {
        return proof.proof;
      },
      get phase() {
        return phase;
      },
      evidence() {
        return Object.freeze(
          owners.map((record) =>
            Object.freeze({
              phase: record.phase,
              outcome: record.outcome,
              cleanup: record.cleanup,
              elapsedMs: record.elapsedMs,
              diagnosticCount: record.diagnostics.length,
            }),
          ),
        );
      },
    });
  }
}
