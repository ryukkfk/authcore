import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  SignupIdempotencyClaimRepository as Claims,
  SignupIdempotencyConflictError,
  SignupIdempotencyExpiryError,
  inspectSignupClaim,
  runSignupTransaction,
  type SignupClaimBinding,
} from '@authcore/db';
import { approvedTestUrl, bounded } from '@authcore/testing';
import { createProtocolFixture, type ProtocolFixture } from './signup-protocol.test-support.js';

const approved =
  process.env.PB_POSTGRES_APPROVED === 'true'
    ? approvedTestUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL)
    : undefined;
if (
  approved &&
  (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted')
)
  throw new Error('Phase B remediation requires disposable GitHub-hosted services');
const input = {
  email: 'clock-fixture@example.invalid',
  password: 'public clock fixture password 123',
};
const key = () => 'pb_' + randomUUID();

describe.skipIf(!approved)('PB-001/PB-002 real restricted PostgreSQL regression witnesses', () => {
  let f: ProtocolFixture;
  beforeAll(async () => {
    if (!approved) throw new Error('Phase B disposable approval missing');
    f = await createProtocolFixture(approved);
  }, 30000);
  afterEach(async () => {
    vi.restoreAllMocks();
    await f?.drainAdmissions();
  });
  afterAll(async () => {
    await f?.close();
  }, 30000);
  const dbTime = async (offset = 0) =>
    new Date(
      Number(
        (
          await f.owner.pool.query(
            'SELECT floor(extract(epoch FROM clock_timestamp())*1000)::double precision AS ms',
          )
        ).rows[0].ms,
      ) + offset,
    );
  const witness = async (binding: SignupClaimBinding) =>
    (
      await f.owner.pool.query(
        'SELECT id,created_at,expires_at,payload_digest FROM signup_idempotency_claims WHERE key_digest=$1',
        [binding.keyDigest],
      )
    ).rows;
  async function expired(binding: SignupClaimBinding) {
    return (
      await f.owner.pool.query(
        "INSERT INTO signup_idempotency_claims(key_version,hmac_key_version,key_digest,payload_version,payload_digest,created_at,expires_at) VALUES($1,$2,$3,$4,$5,now()-interval '2 days',now()-interval '1 day') RETURNING id",
        [
          binding.keyVersion,
          binding.hmacKeyVersion,
          binding.keyDigest,
          binding.payloadVersion,
          binding.payloadDigest,
        ],
      )
    ).rows[0].id as string;
  }

  it('01 app ahead: DB-valid T1 succeeds with a committed independent witness and no domain work', async () => {
    const ready = await f.ready();
    const binding = await ready.boundary.bind(key(), input);
    const before = await f.writes();
    vi.spyOn(Date, 'now').mockReturnValue((await dbTime(3 * 86400000)).getTime());
    const result = await ready.boundary.reserve(binding);
    expect(result.proof).toBe('T1_COMMIT_ACK');
    const [row] = await witness(binding);
    expect(row.id).toBe(result.claim.id);
    expect(row.expires_at).toEqual(result.claim.expiresAt);
    expect(row.expires_at.getTime()).toBeGreaterThan((await dbTime()).getTime());
    expect(row.created_at.getTime()).toBeLessThan(row.expires_at.getTime());
    expect(await f.writes()).toEqual(before);
    expect(ready.hash).not.toHaveBeenCalled();
  });

  it('02 app behind: DB-invalid finite new expiry is rejected without a committed claim', async () => {
    const ready = await f.ready();
    const binding = await ready.boundary.bind(key(), input);
    const before = await f.writes();
    vi.spyOn(Date, 'now').mockReturnValue((await dbTime(-3 * 86400000)).getTime());
    await expect(
      new Claims(f.runtime.db).reserve(binding, await dbTime(-86400000)),
    ).rejects.toBeInstanceOf(SignupIdempotencyExpiryError);
    expect(await witness(binding)).toEqual([]);
    expect(await f.writes()).toEqual(before);
  });

  it('03 exact PostgreSQL created_at boundary is rejected at timestamptz(3) precision', async () => {
    const ready = await f.ready();
    const binding = await ready.boundary.bind(key(), input);
    await expect(
      runSignupTransaction(f.runtime, async (tx) => {
        const ms = Number(
          (
            await tx.execute(
              'SELECT (extract(epoch FROM now()::timestamptz(3))*1000)::double precision AS ms',
            )
          ).rows[0]!.ms,
        );
        return new Claims(tx).reserve(binding, new Date(ms));
      }),
    ).rejects.toBeInstanceOf(SignupIdempotencyExpiryError);
    expect(await witness(binding)).toEqual([]);
  });

  it('04 retained claim identity and original expiry survive both app clock directions', async () => {
    const ready = await f.ready();
    const binding = await ready.boundary.bind(key(), input);
    const original = await ready.boundary.reserve(binding);
    const before = await witness(binding);
    const clock = vi.spyOn(Date, 'now');
    for (const offset of [-3 * 86400000, 3 * 86400000]) {
      clock.mockReturnValue((await dbTime(offset)).getTime());
      expect((await ready.boundary.reserve(binding)).claim).toEqual(original.claim);
    }
    expect(await witness(binding)).toEqual(before);
  });

  it('05 expired retained claims cannot be rebound or renewed after app time reversal', async () => {
    const ready = await f.ready();
    const raw = key();
    const binding = await ready.boundary.bind(raw, input);
    const id = await expired(binding);
    const before = await witness(binding);
    vi.spyOn(Date, 'now').mockReturnValue(0);
    expect((await ready.boundary.reserve(binding)).claim.id).toBe(id);
    const conflict = await ready.boundary.bind(raw, {
      ...input,
      password: input.password + ' changed',
    });
    await expect(ready.boundary.reserve(conflict)).rejects.toBeInstanceOf(
      SignupIdempotencyConflictError,
    );
    expect(await witness(binding)).toEqual(before);
  });

  it('06 committed terminal expiry precedes an injected backward policy clock', async () => {
    const ready = await f.ready();
    const binding = await ready.boundary.bind(key(), input);
    const id = await expired(binding);
    expect(
      (await runSignupTransaction(f.runtime, (tx) => inspectSignupClaim(tx, binding, 'execution')))
        .kind,
    ).toBe('TERMINAL_PENDING');
    const clock = vi.fn(async () => new Date(0));
    vi.spyOn(Date, 'now').mockReturnValue(0);
    expect(
      (
        await runSignupTransaction(f.runtime, (tx) =>
          inspectSignupClaim(tx, binding, 'execution', clock),
        )
      ).kind,
    ).toBe('TERMINAL_RETAINED');
    expect(clock).not.toHaveBeenCalled();
    expect(
      (
        await f.owner.pool.query(
          'SELECT claim_id FROM signup_idempotency_terminal_events WHERE claim_id=$1',
          [id],
        )
      ).rowCount,
    ).toBe(1);
  });

  it('07 independent concurrent identical T1 reservations retain one claim under app skew', async () => {
    const a = await f.ready();
    const b = await f.ready(f.database());
    const raw = key();
    const bindings = await Promise.all([a.boundary.bind(raw, input), b.boundary.bind(raw, input)]);
    vi.spyOn(Date, 'now').mockReturnValue((await dbTime(3 * 86400000)).getTime());
    const results = await Promise.all([
      a.boundary.reserve(bindings[0]!),
      b.boundary.reserve(bindings[1]!),
    ]);
    expect(results[0]!.claim).toEqual(results[1]!.claim);
    expect(await witness(bindings[0]!)).toHaveLength(1);
  });

  it('08 conflicting payload never becomes valid because of forward or backward app drift', async () => {
    const ready = await f.ready();
    const raw = key();
    const binding = await ready.boundary.bind(raw, input);
    await ready.boundary.reserve(binding);
    const before = await witness(binding);
    const conflict = await ready.boundary.bind(raw, {
      ...input,
      password: input.password + ' changed',
    });
    const clock = vi.spyOn(Date, 'now');
    for (const offset of [-3 * 86400000, 3 * 86400000]) {
      clock.mockReturnValue((await dbTime(offset)).getTime());
      await expect(ready.boundary.reserve(conflict)).rejects.toBeInstanceOf(
        SignupIdempotencyConflictError,
      );
    }
    expect(await witness(binding)).toEqual(before);
  });

  it('09 actual SQLSTATE and constraint identify only expiry failures for sanitized mapping', async () => {
    const ready = await f.ready();
    const binding = await ready.boundary.bind(key(), input);
    // Independent PostgreSQL witness of the error fields, never emit SQL or DETAIL.
    await expect(
      f.runtime.pool.query(
        'INSERT INTO signup_idempotency_claims(key_version,hmac_key_version,key_digest,payload_version,payload_digest,expires_at) VALUES(1,1,$1,1,$2,now())',
        [binding.keyDigest, binding.payloadDigest],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'signup_idempotency_claims_expiry_check',
    });
    await expect(
      new Claims(f.runtime.db).reserve(binding, await dbTime(-86400000)),
    ).rejects.toBeInstanceOf(SignupIdempotencyExpiryError);
    const bad = { ...binding, keyVersion: 2 };
    await expect(
      new Claims(f.runtime.db).reserve(bad, await dbTime(86400000)),
    ).rejects.toMatchObject({
      cause: { code: '23514', constraint: 'signup_idempotency_claims_versions_check' },
    });
    expect(await witness(binding)).toEqual([]);
  });

  it('10 rejected real T1 expiry performs no hashing, domain work or replacement reservation', async () => {
    const ready = await f.ready();
    const before = await f.writes();
    let binding: SignupClaimBinding | undefined;
    // Isolated test injection supplies a DB-invalid timestamp to the real repository.
    // All SQL, transaction failure/rollback, admission and protocol mapping remain real.
    const implementation = Claims.prototype.reserve;
    const reserve = vi.spyOn(Claims.prototype, 'reserve').mockImplementation(async function (
      this: Claims,
      value,
    ) {
      binding = value;
      return implementation.call(this, value, await dbTime(-86400000));
    });
    const operation = ready.start(key(), input);
    expect(await bounded(operation.response, 'PB rejected T1 response')).toEqual({
      status: 500,
      code: 'SIGNUP_INTERNAL_FAILURE',
    });
    await bounded(operation.settlement, 'PB rejected T1 settlement');
    expect(binding).toBeDefined();
    expect(reserve).toHaveBeenCalledOnce();
    expect(await witness(binding!)).toEqual([]);
    expect(ready.hash).not.toHaveBeenCalled();
    expect(await f.writes()).toEqual(before);
  });
});
