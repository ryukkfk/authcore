import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  sameSignupHmacMetadata,
  validateSignupHmacStartup,
  type AttestedSignupHasher,
  type SignupHmacConfiguration,
} from '@authcore/crypto';
import {
  assertSignupDatabaseAuthority,
  readSignupDatabaseClock,
  readSignupNamespace,
  runOwnedSignupTransaction,
  SignupIdempotencyClaimRepository as Claims,
  SignupProtocolError,
  validateSignupClaim,
  type DatabaseClient,
  type SignupClaimBinding,
  type SignupIdempotencyClaim,
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
  return Object.freeze({
    metadata: hasher.metadata,
    async bind(rawKey: string, input: unknown): Promise<SignupClaimBinding> {
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
        return binding;
      } catch {
        throw new SignupBindingInputInvalid();
      }
    },
    async reserve(
      binding: SignupClaimBinding,
      ownerOptions: SignupOwnerOptions = {},
    ): Promise<{
      claim: SignupIdempotencyClaim;
      proof: 'T1_COMMIT_ACK' | 'RETAINED_CLAIM';
    }> {
      // Binding must belong to the attested namespace; payload validation remains frozen v1.
      if (!issuedBindings.has(binding) || binding.hmacKeyVersion !== hasher.metadata.hmacKeyVersion)
        throw new SignupReservationUnavailable();
      const reservation = await settled(
        await runOwnedSignupTransaction(
          database,
          async (tx) => {
            await assertNamespace(tx, hasher);
            const now = await readSignupDatabaseClock(tx);
            const expiresAt = new Date(now.getTime() + executionWindowMs!);
            if (!Number.isFinite(expiresAt.getTime())) throw new SignupReservationUnavailable();
            const { claim } = await new Claims(tx).reserve(binding, expiresAt);
            validateSignupClaim(claim, binding);
            return claim;
          },
          ownerOptions,
        ),
      );
      if (reservation.outcome === 'COMMIT_ACK' && reservation.value)
        return { claim: reservation.value, proof: 'T1_COMMIT_ACK' };
      if (reservation.outcome !== 'COMMIT_UNKNOWN') {
        if (reservation.primary) throw reservation.primary.error;
        throw new SignupReservationUnavailable();
      }
      // At most one no-domain-write recovery. A missing claim is not rollback proof.
      const recovery = await settled(
        await runOwnedSignupTransaction(
          database,
          async (tx) => {
            await assertNamespace(tx, hasher);
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
            return fresh;
          },
          { ...ownerOptions, profile: 'recovery' },
        ),
      );
      if (recovery.outcome === 'COMMIT_ACK' && recovery.value)
        return { claim: recovery.value, proof: 'RETAINED_CLAIM' };
      throw new SignupReservationUnavailable();
    },
  });
}
export type SignupReservationBoundary = NonNullable<
  Awaited<ReturnType<typeof createSignupReservationBoundary>>
>;
