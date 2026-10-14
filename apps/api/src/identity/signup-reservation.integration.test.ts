import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  inspectSignupClaim,
  runOwnedSignupTransaction,
  runSignupTransaction,
  signupIdempotencyResults,
  SignupIdempotencyConflictError,
  type SignupClaimBinding,
} from '@authcore/db';
import { approvedTestUrl, bounded, deferred } from '@authcore/testing';
import {
  createSignupReservationBoundary,
  SignupBindingInputInvalid,
  SignupReservationUnavailable,
  type SignupReservationBoundary,
} from './signup-reservation.js';
import {
  createReservationFixture,
  testSignupConfiguration,
  type ReservationFixture,
} from './signup-reservation.test-support.js';

const approved =
  process.env.S2_POSTGRES_APPROVED === 'true'
    ? approvedTestUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL)
    : undefined;
if (
  approved &&
  (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted')
)
  throw new Error('S2 requires disposable GitHub-hosted PostgreSQL');
const input = { email: ' S2Unicode@Example.com ', password: 'Unicode က😀 password 123' };
const key = () => 's2_' + randomUUID();
describe.skipIf(!approved)(
  'S2 real restricted-role binding, reservation and durable expiry',
  () => {
    let fixture: ReservationFixture;
    let boundary: SignupReservationBoundary;
    const ready = (database = fixture.runtime, configuration = testSignupConfiguration()) =>
      createSignupReservationBoundary(database, {
        enabled: true,
        configuration,
        executionWindowMs: 86400000,
      });
    const bound = (raw = key()) => boundary.bind(raw, input);
    async function expired(binding: SignupClaimBinding) {
      return (
        await fixture.owner.pool.query(
          "INSERT INTO signup_idempotency_claims(key_version,hmac_key_version,key_digest,payload_version,payload_digest,created_at,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 day') RETURNING id",
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
    beforeAll(async () => {
      if (!approved) throw new Error('S2 approval missing');
      fixture = await createReservationFixture(approved);
      boundary = (await ready())!;
    }, 30000);
    afterEach(async () => {
      vi.restoreAllMocks();
      await fixture?.seedAnchor();
    });
    afterAll(async () => {
      await fixture?.close();
    }, 30000);
    it('rejects enabled startup when the retained namespace anchor is missing', async () => {
      await fixture.owner.pool.query('DELETE FROM signup_idempotency_namespace');
      await expect(ready()).rejects.toBeInstanceOf(SignupReservationUnavailable);
    });
    it('rejects version-only configuration drift against the durable anchor', async () => {
      const configuration = testSignupConfiguration();
      await expect(
        ready(fixture.runtime, {
          ...configuration,
          metadata: { ...configuration.metadata, hmacKeyVersion: 2 },
        }),
      ).rejects.toBeInstanceOf(SignupReservationUnavailable);
    });
    it('rejects a retained claim version outside the approved namespace without deleting it', async () => {
      const binding = await bound();
      const id = (
        await fixture.owner.pool.query(
          "INSERT INTO signup_idempotency_claims(key_version,hmac_key_version,key_digest,payload_version,payload_digest,expires_at) VALUES(1,2,$1,1,$2,now()+interval '1 day') RETURNING id",
          [binding.keyDigest, binding.payloadDigest],
        )
      ).rows[0].id;
      try {
        await expect(ready()).rejects.toBeInstanceOf(SignupReservationUnavailable);
        expect(
          (
            await fixture.owner.pool.query('SELECT id FROM signup_idempotency_claims WHERE id=$1', [
              id,
            ])
          ).rowCount,
        ).toBe(1);
      } finally {
        await fixture.owner.pool.query('DELETE FROM signup_idempotency_claims WHERE id=$1', [id]);
      } // Exact disposable fault fixture only.
    });
    it('rejects malformed DTO/key and caller-fabricated bindings before reservation', async () => {
      const binding = await bound();
      const before = await fixture.writes();
      await expect(bound('short')).rejects.toBeInstanceOf(SignupBindingInputInvalid);
      await expect(boundary.bind(key(), { ...input, extra: 'forbidden' })).rejects.toBeInstanceOf(
        SignupBindingInputInvalid,
      );
      await expect(boundary.bind(key(), null)).rejects.toBeInstanceOf(SignupBindingInputInvalid);
      await expect(boundary.reserve({ ...binding })).rejects.toBeInstanceOf(
        SignupReservationUnavailable,
      );
      expect(await fixture.writes()).toEqual(before);
    });
    it('independently commits T1 and retains exact claim identity/binding/expiry on retry', async () => {
      const binding = await bound();
      const before = await fixture.writes();
      const first = await boundary.reserve(binding);
      const next = await boundary.reserve(binding);
      expect(first.proof).toBe('T1_COMMIT_ACK');
      expect(next.claim).toEqual(first.claim);
      expect(await fixture.writes()).toEqual(before);
    });
    it('concurrent identical reservations from independent pools retain one claim', async () => {
      const other = (await ready(fixture.database()))!;
      const raw = key();
      const [a, b] = await Promise.all([boundary.bind(raw, input), other.bind(raw, input)]);
      const reservations = await Promise.all([
        boundary.reserve(a),
        other.reserve(b),
        boundary.reserve(a),
        other.reserve(b),
      ]);
      expect(new Set(reservations.map((value) => value.claim.id)).size).toBe(1);
      expect(new Set(reservations.map((value) => value.claim.expiresAt.getTime())).size).toBe(1);
    });
    it('conflicting payloads cannot rebind or renew a retained key', async () => {
      const raw = key();
      const original = await bound(raw);
      const first = await boundary.reserve(original);
      const conflict = await boundary.bind(raw, {
        ...input,
        password: 'different secure password 123',
      });
      await expect(boundary.reserve(conflict)).rejects.toBeInstanceOf(
        SignupIdempotencyConflictError,
      );
      expect((await boundary.reserve(original)).claim).toEqual(first.claim);
    });
    it('T1 lost COMMIT ACK reconciles only through a fresh retained matching claim', async () => {
      const proxy = await fixture.proxy();
      const proxied = fixture.database(proxy.url);
      const service = (await ready(proxied))!;
      const binding = await service.bind(key(), input);
      const before = await fixture.writes();
      proxy.arm();
      const pending = service.reserve(binding);
      await proxy.waitForDrop();
      const result = await bounded(pending, 'S2 T1 retained-claim recovery', 10000);
      expect(result.proof).toBe('RETAINED_CLAIM');
      const witness = (
        await fixture.owner.pool.query(
          'SELECT id,expires_at FROM signup_idempotency_claims WHERE key_digest=$1',
          [binding.keyDigest],
        )
      ).rows[0];
      expect(witness.id).toBe(result.claim.id);
      expect(witness.expires_at).toEqual(result.claim.expiresAt);
      expect(await fixture.writes()).toEqual(before);
      console.info(
        JSON.stringify({
          scenario: 'S2_T1_ACK_LOSS',
          proof: result.proof,
          immutableExpiry: true,
          domainWrites: 0,
        }),
      );
    });
    it('an unknown T1 with no retained claim stays retryable and never recreates a claim internally', async () => {
      const binding = await bound();
      const pinned = await fixture.runtime.pool.connect();
      const original = pinned.query.bind(pinned);
      const query = vi.spyOn(pinned, 'query');
      query.mockImplementation(((text: unknown, ...args: unknown[]) =>
        text === 'COMMIT'
          ? Promise.reject(new Error('controlled before-send COMMIT loss'))
          : Reflect.apply(original, pinned, [text, ...args])) as typeof pinned.query);
      const connect = vi
        .spyOn(fixture.runtime.pool, 'connect')
        .mockImplementationOnce(() => Promise.resolve(pinned));
      try {
        await expect(boundary.reserve(binding)).rejects.toBeInstanceOf(
          SignupReservationUnavailable,
        );
      } finally {
        query.mockRestore();
        connect.mockRestore();
      }
      expect(
        (
          await fixture.owner.pool.query(
            'SELECT id FROM signup_idempotency_claims WHERE key_digest=$1',
            [binding.keyDigest],
          )
        ).rowCount,
      ).toBe(0);
    });
    it('an unexpired claim remains eligible without terminal or result writes', async () => {
      const binding = await bound();
      await boundary.reserve(binding);
      const before = await fixture.writes();
      const decision = await runSignupTransaction(fixture.runtime, (tx) =>
        inspectSignupClaim(tx, binding, 'execution'),
      );
      expect(decision.kind).toBe('ELIGIBLE');
      expect(await fixture.writes()).toEqual(before);
    });
    it('committed terminal expiry survives an earlier test clock and preserves immutable claim bytes', async () => {
      const binding = await bound();
      const id = await expired(binding);
      const before = (
        await fixture.owner.pool.query('SELECT * FROM signup_idempotency_claims WHERE id=$1', [id])
      ).rows;
      const first = await runOwnedSignupTransaction(fixture.runtime, (tx) =>
        inspectSignupClaim(tx, binding, 'execution'),
      );
      await first.settlement;
      expect(first.outcome).toBe('COMMIT_ACK');
      expect(first.value?.kind).toBe('TERMINAL_PENDING');
      const reversed = vi.fn(async () => new Date('2000-01-01T00:00:00Z'));
      const retry = await runSignupTransaction(fixture.runtime, (tx) =>
        inspectSignupClaim(tx, binding, 'execution', reversed),
      );
      expect(retry.kind).toBe('TERMINAL_RETAINED');
      expect(reversed).not.toHaveBeenCalled();
      expect(
        (
          await fixture.owner.pool.query('SELECT * FROM signup_idempotency_claims WHERE id=$1', [
            id,
          ])
        ).rows,
      ).toEqual(before);
      expect(
        (
          await fixture.owner.pool.query(
            'SELECT * FROM signup_idempotency_terminal_events WHERE claim_id=$1',
            [id],
          )
        ).rowCount,
      ).toBe(1);
    });
    it('rolled-back terminal observation is not a durable refusal', async () => {
      const binding = await bound();
      const id = await expired(binding);
      const fault = new Error('terminalizer crash before commit');
      await expect(
        runSignupTransaction(fixture.runtime, async (tx) => {
          expect((await inspectSignupClaim(tx, binding, 'execution')).kind).toBe(
            'TERMINAL_PENDING',
          );
          throw fault;
        }),
      ).rejects.toBe(fault);
      expect(
        (
          await fixture.owner.pool.query(
            'SELECT * FROM signup_idempotency_terminal_events WHERE claim_id=$1',
            [id],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await runSignupTransaction(fixture.runtime, (tx) =>
            inspectSignupClaim(
              tx,
              binding,
              'execution',
              async () => new Date('2000-01-01T00:00:00Z'),
            ),
          )
        ).kind,
      ).toBe('ELIGIBLE');
    });
    it('lost terminal COMMIT ACK requires fresh retained terminal evidence', async () => {
      const binding = await bound();
      const id = await expired(binding);
      const proxy = await fixture.proxy();
      const proxied = fixture.database(proxy.url);
      proxy.arm();
      const pending = runOwnedSignupTransaction(proxied, (tx) =>
        inspectSignupClaim(tx, binding, 'execution'),
      );
      await proxy.waitForDrop();
      const unknown = await pending;
      await unknown.settlement;
      expect(unknown.outcome).toBe('COMMIT_UNKNOWN');
      expect(unknown.value).toBeUndefined();
      const recovered = await runSignupTransaction(fixture.runtime, (tx) =>
        inspectSignupClaim(tx, binding, 'recovery', async () => new Date('2000-01-01T00:00:00Z')),
      );
      expect(recovered.kind).toBe('TERMINAL_RETAINED');
      expect(
        (
          await fixture.owner.pool.query(
            'SELECT * FROM signup_idempotency_terminal_events WHERE claim_id=$1',
            [id],
          )
        ).rowCount,
      ).toBe(1);
    });
    it('recovery never terminalizes a timestamp-only expiry observation', async () => {
      const binding = await bound();
      const id = await expired(binding);
      const result = await runSignupTransaction(fixture.runtime, (tx) =>
        inspectSignupClaim(tx, binding, 'recovery'),
      );
      expect(result.kind).toBe('EXPIRED_WITHOUT_TERMINAL');
      expect(
        (
          await fixture.owner.pool.query(
            'SELECT * FROM signup_idempotency_terminal_events WHERE claim_id=$1',
            [id],
          )
        ).rowCount,
      ).toBe(0);
    });
    it('fresh retained result takes precedence over expiry and even an injected coexistence incident', async () => {
      const binding = await bound();
      const id = await expired(binding);
      await fixture.owner.pool.query(
        'INSERT INTO signup_idempotency_results VALUES($1,1,202,\'{"status":"accepted"}\',now())',
        [id],
      );
      await fixture.owner.pool.query(
        "INSERT INTO signup_idempotency_terminal_events(claim_id,event_type,policy_version,observed_at) SELECT id,'signup.expired',1,expires_at FROM signup_idempotency_claims WHERE id=$1",
        [id],
      );
      const clock = vi.fn(async () => new Date());
      const result = await runSignupTransaction(fixture.runtime, (tx) =>
        inspectSignupClaim(tx, binding, 'recovery', clock),
      );
      expect(result.kind).toBe('RESULT_FOUND');
      expect(clock).not.toHaveBeenCalled();
      expect(
        (
          await fixture.owner.pool.query(
            'SELECT * FROM signup_idempotency_results r JOIN signup_idempotency_terminal_events e USING(claim_id) WHERE claim_id=$1',
            [id],
          )
        ).rowCount,
      ).toBe(1);
    });
    it('a writer authorized before cutoff commits before a waiting terminalizer makes its fresh decision', async () => {
      const binding = await bound();
      const id = await expired(binding);
      const entered = deferred<number>();
      const resume = deferred<void>();
      const writer = runSignupTransaction(fixture.runtime, async (tx) => {
        expect(
          (
            await inspectSignupClaim(
              tx,
              binding,
              'execution',
              async () => new Date('2000-01-01T00:00:00Z'),
            )
          ).kind,
        ).toBe('ELIGIBLE');
        entered.resolve(Number((await tx.execute('SELECT pg_backend_pid() AS pid')).rows[0]!.pid));
        await resume.promise;
        await tx.insert(signupIdempotencyResults).values({
          claimId: id,
          resultVersion: 1,
          statusCode: 202,
          responseBody: { status: 'accepted' },
        });
      });
      const pid = await entered.promise;
      const terminalizer = runSignupTransaction(fixture.database(), (tx) =>
        inspectSignupClaim(tx, binding, 'execution'),
      );
      try {
        await expect
          .poll(
            async () =>
              Number(
                (
                  await fixture.owner.pool.query(
                    'SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))',
                    [pid],
                  )
                ).rows[0].n,
              ),
            { interval: 10, timeout: 700 },
          )
          .toBe(1);
      } finally {
        resume.resolve();
      }
      await writer;
      expect((await terminalizer).kind).toBe('RESULT_FOUND');
      expect(
        (
          await fixture.owner.pool.query(
            'SELECT * FROM signup_idempotency_terminal_events WHERE claim_id=$1',
            [id],
          )
        ).rowCount,
      ).toBe(0);
    });
    it('concurrent terminalizers append exactly one durable event', async () => {
      const binding = await bound();
      const id = await expired(binding);
      const decisions = await Promise.all(
        [fixture.runtime, fixture.database()].map((database) =>
          runSignupTransaction(database, (tx) => inspectSignupClaim(tx, binding, 'execution')),
        ),
      );
      expect(decisions.map((value) => value.kind).sort()).toEqual([
        'TERMINAL_PENDING',
        'TERMINAL_RETAINED',
      ]);
      expect(
        (
          await fixture.owner.pool.query(
            'SELECT * FROM signup_idempotency_terminal_events WHERE claim_id=$1',
            [id],
          )
        ).rowCount,
      ).toBe(1);
    });
    it('a missing retained claim cannot become eligible or be recreated by policy inspection', async () => {
      const binding = await bound();
      await expect(
        runSignupTransaction(fixture.runtime, (tx) => inspectSignupClaim(tx, binding, 'execution')),
      ).rejects.toMatchObject({ code: 'SIGNUP_CLAIM_UNAVAILABLE' });
      expect(
        (
          await fixture.owner.pool.query(
            'SELECT id FROM signup_idempotency_claims WHERE key_digest=$1',
            [binding.keyDigest],
          )
        ).rowCount,
      ).toBe(0);
    });
    it('namespace drift after startup stops reservation before a new claim is inserted', async () => {
      const binding = await bound();
      await fixture.owner.pool.query(
        "UPDATE signup_idempotency_namespace SET attestation_key_digest=repeat('0',64)",
      );
      await expect(boundary.reserve(binding)).rejects.toMatchObject({
        code: 'SIGNUP_NAMESPACE_ATTESTATION_DRIFT',
      });
      expect(
        (
          await fixture.owner.pool.query(
            'SELECT id FROM signup_idempotency_claims WHERE key_digest=$1',
            [binding.keyDigest],
          )
        ).rowCount,
      ).toBe(0);
    });
  },
);
