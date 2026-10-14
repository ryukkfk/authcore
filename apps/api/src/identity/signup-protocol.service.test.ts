import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  UserRepository,
  PasswordCredentialRepository,
  SecurityAuditEventRepository,
  SignupIdempotencyResultRepository as Results,
  runOwnedSignupTransaction,
  inspectSignupClaim,
  type DatabaseClient,
  type SignupTransactionEvidence,
  type TransactionOutcome,
  type CleanupHealth,
} from '@authcore/db';
import { deferred } from '@authcore/testing';
import { IdempotentSignupService } from './signup-protocol.service.js';
import { SignupAdmission, SignupAdmissionUnavailable } from './signup-admission.js';
import type { RedisService } from '../redis/redis.service.js';
import {
  SignupBindingInputInvalid,
  SignupReservationUnavailable,
  type SignupReservationBoundary,
} from './signup-reservation.js';
vi.mock('@authcore/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authcore/db')>()),
  runOwnedSignupTransaction: vi.fn(),
  inspectSignupClaim: vi.fn(),
}));
const binding = Object.freeze({
  keyVersion: 1,
  hmacKeyVersion: 1,
  keyDigest: 'a'.repeat(64),
  payloadVersion: 1,
  payloadDigest: 'b'.repeat(64),
});
const claim = {
  ...binding,
  id: '11111111-1111-4111-8111-111111111111',
  lockAnchor: false,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  expiresAt: new Date('2027-01-01T00:00:00Z'),
};
const result = {
  claimId: claim.id,
  resultVersion: 1,
  statusCode: 202,
  responseBody: { status: 'accepted' },
  createdAt: new Date('2026-01-01T00:00:01Z'),
} as const;
const input = Object.freeze({
  email: 'Unit@Example.com',
  password: 'public unit fixture password 123',
});
function record<T>(
  outcome: TransactionOutcome,
  value?: T,
  primary?: unknown,
  cleanup: CleanupHealth = 'CLEAN',
  settlement = Promise.resolve(),
): SignupTransactionEvidence<T> {
  return {
    id: 'unit-owner',
    phase: 'DISPOSING',
    outcome,
    cleanup,
    commandTag: outcome === 'COMMIT_ACK' ? 'COMMIT' : undefined,
    value: outcome === 'COMMIT_ACK' ? value : undefined,
    ...(primary ? { primary: { error: primary } } : {}),
    diagnostics: [],
    elapsedMs: 1,
    settlement,
    workSettlement: Promise.resolve(),
  };
}
function setup(
  schedules: {
    outcome: TransactionOutcome;
    primary?: unknown;
    cleanup?: CleanupHealth;
    settlement?: Promise<void>;
  }[] = [{ outcome: 'COMMIT_ACK' }],
) {
  vi.mocked(runOwnedSignupTransaction).mockReset();
  vi.mocked(inspectSignupClaim).mockReset().mockResolvedValue({ kind: 'ELIGIBLE', claim });
  vi.mocked(runOwnedSignupTransaction).mockImplementation((async (
    _database: unknown,
    work: (tx: unknown) => Promise<unknown>,
  ) => {
    try {
      const value = await work({});
      const next = schedules.shift();
      if (!next) throw new Error('unexpected extra transaction');
      return record(next.outcome, value, next.primary, next.cleanup, next.settlement);
    } catch (error) {
      return record('ABORT_CONFIRMED', undefined, error, 'EVICTED');
    }
  }) as typeof runOwnedSignupTransaction);
  const hash = vi.fn(async () => '$argon2id$unit-fixture-only');
  const create = vi.spyOn(UserRepository.prototype, 'create').mockResolvedValue({
    id: claim.id,
    email: input.email,
    emailNormalized: input.email.toLowerCase(),
    emailVerifiedAt: null,
    disabledAt: null,
    createdAt: claim.createdAt,
    updatedAt: claim.createdAt,
  });
  const credential = vi.spyOn(PasswordCredentialRepository.prototype, 'create').mockResolvedValue({
    userId: claim.id,
    passwordHash: '$argon2id$unit-fixture-only',
    createdAt: claim.createdAt,
    updatedAt: claim.createdAt,
  });
  const audit = vi
    .spyOn(SecurityAuditEventRepository.prototype, 'recordUserCreated')
    .mockResolvedValue({
      id: claim.id,
      userId: claim.id,
      eventType: 'identity.user_created',
      payload: {},
      occurredAt: claim.createdAt,
    });
  const accepted = vi
    .spyOn(Results.prototype, 'recordAccepted')
    .mockResolvedValue({ ...result, responseBody: { status: 'accepted' } });
  const boundary = {
    prepare: vi.fn(async () => ({ binding, input })),
    verify: vi.fn(async () => {}),
    reserve: vi.fn(
      async (
        _binding: unknown,
        _options: unknown,
        observations?: { owner?: (record: SignupTransactionEvidence<unknown>) => void },
      ) => {
        observations?.owner?.(record('COMMIT_ACK'));
        return { claim, proof: 'T1_COMMIT_ACK', observedAt: new Date('2026-01-01T00:00:01Z') };
      },
    ),
  };
  const evalCommand = vi.fn(async () => 1);
  const admission = new SignupAdmission({
    getClient: async () => ({ withCommandOptions: () => ({ eval: evalCommand }) }),
  } as unknown as RedisService);
  const service = new IdempotentSignupService(
    {} as DatabaseClient,
    boundary as unknown as SignupReservationBoundary,
    { hashPassword: hash },
  );
  let operation!: ReturnType<IdempotentSignupService['start']>;
  const start = (signal?: AbortSignal) => {
    const admitted = admission.start(async () => {
      operation = service.start('public_unit_key_12345', input, signal ? { signal } : {});
      return operation.response;
    });
    return admitted;
  };
  return {
    service,
    boundary,
    hash,
    create,
    credential,
    audit,
    accepted,
    admission,
    evalCommand,
    start,
    get operation() {
      return operation;
    },
  };
}
afterEach(() => vi.restoreAllMocks());
describe('S4 internal protocol proof and ownership regressions', () => {
  it('requires explicit admission before binding, hashing or database work', () => {
    const f = setup();
    expect(() => f.service.start('public_unit_key_12345', input)).toThrow(
      SignupAdmissionUnavailable,
    );
    expect(f.boundary.prepare).not.toHaveBeenCalled();
    expect(f.hash).not.toHaveBeenCalled();
  });
  it('rejects invalid binding input before T1 or hashing', async () => {
    const f = setup();
    f.boundary.prepare.mockRejectedValue(new SignupBindingInputInvalid());
    const admitted = f.start();
    expect((await admitted.response).status).toBe(400);
    await admitted.settlement;
    expect(f.boundary.reserve).not.toHaveBeenCalled();
    expect(f.hash).not.toHaveBeenCalled();
  });
  it('T1 reservation proof alone is not accepted business success', async () => {
    const f = setup();
    f.hash.mockRejectedValue(new Error('controlled native hash failure'));
    const admitted = f.start();
    expect((await admitted.response).status).toBe(500);
    await admitted.settlement;
    expect(f.operation.proof).toBeUndefined();
    expect(runOwnedSignupTransaction).not.toHaveBeenCalled();
  });
  it('native hash cancellation returns retryable failure while retaining local capacity until native settlement', async () => {
    const f = setup();
    const entered = deferred<void>();
    const resume = deferred<string>();
    const signal = new AbortController();
    f.hash.mockImplementation(async () => {
      entered.resolve();
      return resume.promise;
    });
    const admitted = f.start(signal.signal);
    await entered.promise;
    signal.abort();
    expect((await admitted.response).status).toBe(503);
    expect(f.admission.inventory().active).toBe(1);
    expect(runOwnedSignupTransaction).not.toHaveBeenCalled();
    resume.resolve('$argon2id$unit-fixture-only');
    await admitted.settlement;
    expect(f.admission.inventory().active).toBe(0);
    expect(runOwnedSignupTransaction).not.toHaveBeenCalled();
  });
  it('preserves a retained T1 result before quarantined reservation cleanup settles', async () => {
    const f = setup();
    const cleanup = deferred<void>();
    f.boundary.reserve.mockImplementation((async (
      _binding: unknown,
      _options: unknown,
      observations: {
        accepted: (claim: unknown, result: unknown) => void;
        owner: (record: SignupTransactionEvidence<unknown>) => void;
      },
    ) => {
      observations.accepted(claim, result);
      observations.owner(
        record('COMMIT_UNKNOWN', undefined, undefined, 'QUARANTINED_WITH_OWNER', cleanup.promise),
      );
      await cleanup.promise;
      throw new SignupReservationUnavailable();
    }) as never);
    const admitted = f.start();
    expect(await admitted.response).toEqual({ status: 202, body: { status: 'accepted' } });
    expect(f.operation.proof?.source).toBe('RETAINED_RESULT_T1');
    expect(f.admission.inventory().active).toBe(1);
    expect(f.hash).not.toHaveBeenCalled();
    cleanup.resolve();
    await admitted.settlement;
    expect(f.operation.proof?.source).toBe('RETAINED_RESULT_T1');
    expect(f.admission.inventory().active).toBe(0);
    expect(runOwnedSignupTransaction).not.toHaveBeenCalled();
  });
  it('accepts atomic writes only after an exact T2 ACK', async () => {
    const f = setup();
    const admitted = f.start();
    expect((await admitted.response).status).toBe(202);
    await admitted.settlement;
    expect(f.operation.proof?.source).toBe('T2_COMMIT_ACK');
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.credential).toHaveBeenCalledOnce();
    expect(f.audit).toHaveBeenCalledOnce();
    expect(f.accepted).toHaveBeenCalledOnce();
  });
  it('a ROLLBACK command tag cannot accept the callback own uncommitted result', async () => {
    const f = setup([{ outcome: 'COMMIT_ROLLBACK' }]);
    const admitted = f.start();
    expect((await admitted.response).status).toBe(500);
    await admitted.settlement;
    expect(f.operation.proof).toBeUndefined();
    expect(runOwnedSignupTransaction).toHaveBeenCalledOnce();
  });
  it('a fresh T2 retained result survives a later owner failure without domain writes', async () => {
    const f = setup([
      { outcome: 'NOT_SUBMITTED', primary: new Error('ending failure'), cleanup: 'EVICTED' },
    ]);
    vi.mocked(inspectSignupClaim).mockResolvedValue({
      kind: 'RESULT_FOUND',
      claim,
      result: { ...result, responseBody: { status: 'accepted' } },
    });
    const admitted = f.start();
    expect((await admitted.response).status).toBe(202);
    await admitted.settlement;
    expect(f.operation.proof?.source).toBe('RETAINED_RESULT_T2');
    expect(f.create).not.toHaveBeenCalled();
    expect(f.accepted).not.toHaveBeenCalled();
  });
  it('unknown T2 recovers through one fresh T3 result despite T3 rollback failure', async () => {
    const f = setup([
      { outcome: 'COMMIT_UNKNOWN', primary: new Error('lost ACK'), cleanup: 'EVICTED' },
      { outcome: 'NOT_SUBMITTED', primary: new Error('T3 rollback failed'), cleanup: 'EVICTED' },
    ]);
    vi.mocked(inspectSignupClaim)
      .mockResolvedValueOnce({ kind: 'ELIGIBLE', claim })
      .mockResolvedValueOnce({
        kind: 'RESULT_FOUND',
        claim,
        result: { ...result, responseBody: { status: 'accepted' } },
      });
    const admitted = f.start();
    expect((await admitted.response).status).toBe(202);
    await admitted.settlement;
    expect(f.operation.proof?.source).toBe('RETAINED_RESULT_T3');
    expect(runOwnedSignupTransaction).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runOwnedSignupTransaction).mock.calls[1]![2]).toMatchObject({
      profile: 'recovery',
      completion: 'rollback',
    });
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.accepted).toHaveBeenCalledOnce();
  });
  it('a T3 missing result remains uncertainty and never retries account creation', async () => {
    const f = setup([
      { outcome: 'COMMIT_UNKNOWN', primary: new Error('lost ACK'), cleanup: 'EVICTED' },
      { outcome: 'ABORT_CONFIRMED' },
    ]);
    const admitted = f.start();
    expect((await admitted.response).status).toBe(503);
    await admitted.settlement;
    expect(f.operation.proof).toBeUndefined();
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.accepted).toHaveBeenCalledOnce();
    expect(runOwnedSignupTransaction).toHaveBeenCalledTimes(2);
  });
  it('permission failure during no-proof recovery remains a sanitized internal failure', async () => {
    const f = setup([
      { outcome: 'COMMIT_UNKNOWN', primary: new Error('lost ACK'), cleanup: 'EVICTED' },
      {
        outcome: 'NOT_SUBMITTED',
        primary: Object.assign(new Error('private permission detail'), { code: '42501' }),
      },
    ]);
    const admitted = f.start();
    expect(await admitted.response).toEqual({ status: 500, code: 'SIGNUP_INTERNAL_FAILURE' });
    await admitted.settlement;
    expect(f.operation.proof).toBeUndefined();
  });
  it('a quarantined unknown T2 returns retryable failure and starts no recovery or duplicate writes', async () => {
    const cleanup = deferred<void>();
    const f = setup([
      { outcome: 'COMMIT_UNKNOWN', cleanup: 'QUARANTINED_WITH_OWNER', settlement: cleanup.promise },
    ]);
    const admitted = f.start();
    expect((await admitted.response).status).toBe(503);
    expect(f.admission.inventory().active).toBe(1);
    cleanup.resolve();
    await admitted.settlement;
    expect(runOwnedSignupTransaction).toHaveBeenCalledOnce();
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.operation.proof).toBeUndefined();
  });
  it('verified T2 ACK survives quarantined cleanup and later cancellation while capacity stays retained', async () => {
    const cleanup = deferred<void>();
    const signal = new AbortController();
    const f = setup([
      { outcome: 'COMMIT_ACK', cleanup: 'QUARANTINED_WITH_OWNER', settlement: cleanup.promise },
    ]);
    const admitted = f.start(signal.signal);
    expect((await admitted.response).status).toBe(202);
    signal.abort();
    expect(f.operation.proof?.source).toBe('T2_COMMIT_ACK');
    expect(f.admission.inventory().active).toBe(1);
    cleanup.resolve();
    await admitted.settlement;
    expect(f.operation.proof?.source).toBe('T2_COMMIT_ACK');
    expect(f.admission.inventory().active).toBe(0);
  });
});
