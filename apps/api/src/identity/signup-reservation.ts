import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  sameSignupHmacMetadata,
  validateSignupHmacStartup,
  type AttestedSignupHasher,
  type SignupHmacConfiguration,
} from '@authcore/crypto';
import {
  acquireSignupCapacity,
  assertSignupDatabaseAuthority,
  readSignupDatabaseClock,
  readSignupNamespace,
  runOwnedSignupTransaction,
  SignupIdempotencyClaimRepository as Claims,
  SignupIdempotencyResultRepository as Results,
  SignupProtocolError,
  validateSignupClaim,
  validateSignupResult,
  type DatabaseClient,
  type SignupClaimBinding,
  type SignupIdempotencyClaim,
  type SignupIdempotencyResult,
  type SignupOwnerOptions,
  type SignupTransactionEvidence,
} from '@authcore/db';
import { SignupDto } from './dto/signup.dto.js';

export class SignupReservationUnavailable extends Error {
  constructor() {
    super('SIGNUP_RESERVATION_UNAVAILABLE');
    this.name = 'SignupReservationUnavailable';
  }
}
export class SignupBindingInputInvalid extends Error {
  constructor() {
    super('SIGNUP_INPUT_INVALID');
    this.name = 'SignupBindingInputInvalid';
  }
}
type Transaction = Parameters<Parameters<typeof runOwnedSignupTransaction>[1]>[0];
async function assertNamespace(tx: Transaction, hasher: AttestedSignupHasher) {
  await assertSignupDatabaseAuthority(tx);
  const anchor = await readSignupNamespace(tx);
  if (!sameSignupHmacMetadata(anchor, hasher.metadata))
    throw new SignupProtocolError('SIGNUP_NAMESPACE_ATTESTATION_DRIFT');
}
async function settled<T>(evidence: SignupTransactionEvidence<T>) {
  await evidence.workSettlement;
  await evidence.settlement;
  return evidence;
}
/** Call at startup. Disabled mode needs neither secret nor namespace access.
 * No secret-manager source or production anchor is implicitly created here.
 */
export async function createSignupReservationBoundary(
  database: DatabaseClient,
  options: {
    enabled: boolean;
    configuration?: SignupHmacConfiguration;
    executionWindowMs?: number;
  },
) {
  const hasher = validateSignupHmacStartup(options.enabled, options.configuration);
  if (!hasher) return undefined;
  const executionWindowMs = options.executionWindowMs;
  if (
    !Number.isSafeInteger(executionWindowMs) ||
    executionWindowMs! < 1 ||
    executionWindowMs! > 86400000
  )
    throw new SignupReservationUnavailable();
  const startup = await settled(
    await runOwnedSignupTransaction(
      database,
      async (tx) => {
        await assertNamespace(tx, hasher);
      },
      { profile: 'recovery' },
    ),
  );
  if (startup.outcome !== 'COMMIT_ACK') throw new SignupReservationUnavailable();
  const issuedBindings = new WeakSet<object>();
  const prepare = async (rawKey: string, input: unknown) => {
    try {
      const dto = plainToInstance(SignupDto, input);
      if (
        !(dto instanceof SignupDto) ||
        (
          await validate(dto, {
            whitelist: true,
            forbidNonWhitelisted: true,
            forbidUnknownValues: true,
            validationError: { target: false, value: false },
          })
        ).length
      )
        throw new SignupBindingInputInvalid();
      const binding = hasher.bind(rawKey, dto);
      issuedBindings.add(binding);
      return Object.freeze({
        binding,
        input: Object.freeze({ email: dto.email, password: dto.password }),
      });
    } catch {
      throw new SignupBindingInputInvalid();
    }
  };
  return Object.freeze({
    metadata: hasher.metadata,
    prepare,
    async bind(rawKey: string, input: unknown): Promise<SignupClaimBinding> {
      return (await prepare(rawKey, input)).binding;
    },
    async verify(tx: Transaction, binding: SignupClaimBinding): Promise<void> {
      if (!issuedBindings.has(binding)) throw new SignupReservationUnavailable();
      await assertNamespace(tx, hasher);
    },
    async reserve(
      binding: SignupClaimBinding,
      ownerOptions: SignupOwnerOptions = {},
      observations: {
        accepted?: (claim: SignupIdempotencyClaim, result: SignupIdempotencyResult) => void;
        owner?: (evidence: SignupTransactionEvidence<unknown>) => void;
        shouldContinue?: () => boolean;
      } = {},
    ): Promise<{
      claim: SignupIdempotencyClaim;
      proof: 'T1_COMMIT_ACK' | 'RETAINED_CLAIM';
      observedAt: Date;
    }> {
      // Binding must belong to the attested namespace; payload validation remains frozen v1.
      if (!issuedBindings.has(binding) || binding.hmacKeyVersion !== hasher.metadata.hmacKeyVersion)
        throw new SignupReservationUnavailable();
      const reservationRecord = await runOwnedSignupTransaction(
        database,
        async (tx) => {
          await assertNamespace(tx, hasher);
          await acquireSignupCapacity(tx);
          const now = await readSignupDatabaseClock(tx);
          const expiresAt = new Date(now.getTime() + executionWindowMs!);
          if (!Number.isFinite(expiresAt.getTime())) throw new SignupReservationUnavailable();
          const { claim } = await new Claims(tx).reserve(binding, expiresAt);
          validateSignupClaim(claim, binding);
          const result = await new Results(tx).findByClaimId(claim.id);
          if (result) {
            validateSignupResult(result, claim.id);
            observations.accepted?.(claim, result);
          }
          return { claim, observedAt: now };
        },
        ownerOptions,
      );
      observations.owner?.(reservationRecord);
      const reservation = await settled(reservationRecord);
      if (reservation.outcome === 'COMMIT_ACK' && reservation.value)
        return { ...reservation.value, proof: 'T1_COMMIT_ACK' };
      if (reservation.outcome !== 'COMMIT_UNKNOWN') {
        if (reservation.primary) throw reservation.primary.error;
        throw new SignupReservationUnavailable();
      }
      if (observations.shouldContinue?.() === false) throw new SignupReservationUnavailable();
      // At most one no-domain-write recovery. A missing claim is not rollback proof.
      const recoveryRecord = await runOwnedSignupTransaction(
        database,
        async (tx) => {
          await assertNamespace(tx, hasher);
          await acquireSignupCapacity(tx);
          const locked = await Claims.lockByKey(tx, binding);
          if (!locked) return undefined;
          const fresh = await new Claims(tx).findByKey(binding);
          if (
            !fresh ||
            fresh.id !== locked.id ||
            fresh.expiresAt.getTime() !== locked.expiresAt.getTime()
          )
            throw new SignupProtocolError('SIGNUP_CLAIM_INTEGRITY_FAILURE');
          validateSignupClaim(fresh, binding);
          const result = await new Results(tx).findByClaimId(fresh.id);
          if (result) {
            validateSignupResult(result, fresh.id);
            observations.accepted?.(fresh, result);
          }
          return { claim: fresh, observedAt: await readSignupDatabaseClock(tx) };
        },
        { ...ownerOptions, profile: 'recovery' },
      );
      observations.owner?.(recoveryRecord);
      const recovery = await settled(recoveryRecord);
      if (recovery.outcome === 'COMMIT_ACK' && recovery.value)
        return { ...recovery.value, proof: 'RETAINED_CLAIM' };
      throw new SignupReservationUnavailable();
    },
  });
}
export type SignupReservationBoundary = NonNullable<
  Awaited<ReturnType<typeof createSignupReservationBoundary>>
>;
