import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SignupIdempotencyClaimRepository,
  SignupIdempotencyConflictError,
  SignupIdempotencyExpiryError,
  SignupIdempotencyResultRepository,
} from './signup-idempotency.repository.js';

const binding = {
  keyVersion: 1,
  hmacKeyVersion: 1,
  keyDigest: 'a'.repeat(64),
  payloadVersion: 1,
  payloadDigest: 'b'.repeat(64),
};
const expiresAt = new Date('2030-01-02T00:00:00Z');
const claim = {
  ...binding,
  id: 'claim-id',
  expiresAt,
  createdAt: new Date('2030-01-01T00:00:00Z'),
  lockAnchor: false,
};

function setup() {
  const returning = vi.fn().mockResolvedValue([claim]);
  const onConflictDoNothing = vi.fn(() => ({ returning }));
  const values = vi.fn(() => ({ onConflictDoNothing, returning }));
  const limit = vi.fn().mockResolvedValueOnce([]).mockResolvedValue([claim]);
  const db = {
    insert: vi.fn(() => ({ values })),
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit }) }) })),
  };
  const typed = db as unknown as ConstructorParameters<typeof SignupIdempotencyClaimRepository>[0];
  return {
    values,
    insert: db.insert,
    returning,
    limit,
    claims: new SignupIdempotencyClaimRepository(typed),
    results: new SignupIdempotencyResultRepository(typed),
  };
}

describe('signup idempotency repository boundaries', () => {
  afterEach(() => vi.restoreAllMocks());
  it('PB-002 lets PostgreSQL decide a finite expiry even when the application clock is ahead', async () => {
    const { claims, insert, limit } = setup();
    limit.mockReset().mockResolvedValue([]);
    vi.spyOn(Date, 'now').mockReturnValue(expiresAt.getTime() + 120_000);
    expect(await claims.reserve(binding, expiresAt)).toEqual({ claim, reserved: true });
    expect(insert).toHaveBeenCalledOnce();
  });
  it('returns a retained expired claim before attempting an invalid INSERT', async () => {
    const { claims, limit, returning, insert } = setup();
    const expired = {
      ...claim,
      expiresAt: new Date('2000-01-02'),
      createdAt: new Date('2000-01-01'),
    };
    limit.mockReset().mockResolvedValue([expired]);
    returning.mockRejectedValue(Object.assign(new Error('expiry CHECK'), { code: '23514' }));
    expect(await claims.reserve(binding, expired.expiresAt)).toEqual({
      claim: expired,
      reserved: false,
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it('rejects a conflicting expired binding before INSERT', async () => {
    const { claims, limit, insert } = setup();
    limit.mockReset().mockResolvedValue([{ ...claim, expiresAt: new Date(0) }]);
    await expect(
      claims.reserve({ ...binding, payloadDigest: 'c'.repeat(64) }, new Date(0)),
    ).rejects.toBeInstanceOf(SignupIdempotencyConflictError);
    expect(insert).not.toHaveBeenCalled();
  });

  it.each([new Date(NaN), 'not a timestamp' as unknown as Date])(
    'rejects invalid expiry for a new claim without INSERT: %s',
    async (invalid) => {
      const { claims, limit, insert } = setup();
      limit.mockReset().mockResolvedValue([]);
      const pending = claims.reserve(binding, invalid);
      await expect(pending).rejects.toBeInstanceOf(SignupIdempotencyExpiryError);
      await expect(pending).rejects.toMatchObject({ code: 'SIGNUP_IDEMPOTENCY_INVALID_EXPIRY' });
      await expect(pending).rejects.not.toHaveProperty('cause');
      expect(insert).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'checks a just-committed binding before rejecting invalid expiry (conflict=%s)',
    async (conflict) => {
      const { claims, insert } = setup();
      const pending = claims.reserve(
        { ...binding, ...(conflict ? { payloadDigest: 'c'.repeat(64) } : {}) },
        new Date(NaN),
      );
      if (conflict) await expect(pending).rejects.toBeInstanceOf(SignupIdempotencyConflictError);
      else expect(await pending).toEqual({ claim, reserved: false });
      expect(insert).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'sanitizes only the authoritative database expiry CHECK (wrapped=%s)',
    async (wrapped) => {
      const { claims, returning } = setup();
      const databaseError = Object.assign(new Error('database detail must not escape'), {
        code: '23514',
        constraint: 'signup_idempotency_claims_expiry_check',
      });
      returning.mockRejectedValue(
        wrapped ? new Error('query detail', { cause: databaseError }) : databaseError,
      );
      const pending = claims.reserve(binding, expiresAt);
      await expect(pending).rejects.toBeInstanceOf(SignupIdempotencyExpiryError);
      await expect(pending).rejects.not.toHaveProperty('cause');
    },
  );

  it('does not relabel other CHECK failures as expiry errors', async () => {
    const { claims, returning } = setup();
    const failure = new Error('query failed', {
      cause: {
        code: '23514',
        constraint: 'signup_idempotency_claims_digests_check',
      },
    });
    returning.mockRejectedValue(failure);
    await expect(claims.reserve(binding, expiresAt)).rejects.toBe(failure);
  });

  it('submits finite past timestamps to the PostgreSQL constraint even with an earlier app clock', async () => {
    const { claims, returning, insert, limit } = setup();
    limit.mockReset().mockResolvedValue([]);
    vi.spyOn(Date, 'now').mockReturnValue(-86400000);
    returning.mockRejectedValue(
      Object.assign(new Error('private SQL detail'), {
        code: '23514',
        constraint: 'signup_idempotency_claims_expiry_check',
      }),
    );
    await expect(claims.reserve(binding, new Date(0))).rejects.toBeInstanceOf(
      SignupIdempotencyExpiryError,
    );
    expect(insert).toHaveBeenCalledOnce();
  });

  it('requires both SQLSTATE and the expiry constraint name for controlled mapping', async () => {
    const { claims, returning } = setup();
    const failure = Object.assign(new Error('unrelated SQL error'), {
      code: '23505',
      constraint: 'signup_idempotency_claims_expiry_check',
    });
    returning.mockRejectedValue(failure);
    await expect(claims.reserve(binding, expiresAt)).rejects.toBe(failure);
  });

  it('strips runtime extras from claim reservation input', async () => {
    const { claims, values } = setup();
    expect(
      await claims.reserve(
        {
          ...binding,
          ...{
            id: 'forged',
            rawKey: 'secret',
            password: 'secret',
            createdAt: new Date(0),
            lockAnchor: true,
          },
        },
        expiresAt,
      ),
    ).toEqual({ claim, reserved: true });
    expect(values).toHaveBeenCalledExactlyOnceWith({ ...binding, expiresAt });
  });

  it('returns the original binding on a conflict, including original expiry', async () => {
    const { claims, returning, limit } = setup();
    returning.mockResolvedValue([]);
    expect(await claims.reserve(binding, new Date('2031-01-01'))).toEqual({
      claim,
      reserved: false,
    });
    expect(limit).toHaveBeenCalledTimes(2);
  });

  it.each([{ payloadDigest: 'c'.repeat(64) }, { payloadDigest: 'short' }, { payloadVersion: 2 }])(
    'reports mismatching bindings with a sanitized conflict %#',
    async (changed) => {
      const { claims, returning } = setup();
      returning.mockResolvedValue([]);
      const pending = claims.reserve({ ...binding, ...changed }, expiresAt);
      await expect(pending).rejects.toBeInstanceOf(SignupIdempotencyConflictError);
      await expect(pending).rejects.toMatchObject({ code: 'SIGNUP_IDEMPOTENCY_CONFLICT' });
      await expect(pending).rejects.not.toHaveProperty('cause');
    },
  );

  it('fails closed if the post-conflict claim is absent, rather than retrying a write', async () => {
    const { claims, returning, limit, values } = setup();
    returning.mockResolvedValue([]);
    limit.mockResolvedValue([]);
    await expect(claims.reserve(binding, expiresAt)).rejects.toThrow(
      'Signup idempotency claim unavailable',
    );
    expect(values).toHaveBeenCalledTimes(1);
  });

  it('propagates unrelated reservation failures without calling them payload conflicts', async () => {
    const { claims, returning } = setup();
    const failure = new Error('database unavailable');
    returning.mockRejectedValue(failure);
    await expect(claims.reserve(binding, expiresAt)).rejects.toBe(failure);
  });

  it('appends only the fixed accepted response and fails if no row is returned', async () => {
    const { results, values, returning } = setup();
    await results.recordAccepted('claim-id');
    expect(values).toHaveBeenCalledExactlyOnceWith({
      claimId: 'claim-id',
      resultVersion: 1,
      statusCode: 202,
      responseBody: { status: 'accepted' },
    });
    returning.mockResolvedValue([]);
    await expect(results.recordAccepted('claim-id')).rejects.toThrow(
      'Signup idempotency result insert returned no row',
    );
  });

  it('propagates duplicate result inserts and distinguishes missing lookups', async () => {
    const { results, returning, limit } = setup();
    const failure = Object.assign(new Error('duplicate result'), { code: '23505' });
    returning.mockRejectedValue(failure);
    await expect(results.recordAccepted('claim-id')).rejects.toBe(failure);
    limit.mockResolvedValue([]);
    expect(await results.findByClaimId('missing')).toBeNull();
  });
});
