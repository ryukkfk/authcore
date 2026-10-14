import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { hashPassword, verifyPassword } from '@authcore/crypto';
import {
  runOwnedSignupTransaction,
  signupIdempotencyResults,
  type DatabaseClient,
} from '@authcore/db';
import { approvedTestUrl, bounded, deferred } from '@authcore/testing';
import type { RedisService } from '../redis/redis.service.js';
import { createProtocolFixture, type ProtocolFixture } from './signup-protocol.test-support.js';
const approved =
  process.env.S4_POSTGRES_APPROVED === 'true'
    ? approvedTestUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL)
    : undefined;
if (
  approved &&
  (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted')
)
  throw new Error('S4 requires disposable GitHub-hosted services');
const request = () => ({
  key: 's4_' + randomUUID(),
  input: {
    email: 'S4_' + randomUUID() + '@example.com',
    password: 'public Unicode fixture ' + String.fromCodePoint(0x1f600) + ' password 123',
  },
});
type Ready = Awaited<ReturnType<ProtocolFixture['ready']>>;
type Started = ReturnType<Ready['start']>;
type QueryResult = { command: string; rows: Record<string, unknown>[] };
function intercept(
  database: DatabaseClient,
  handler: (
    text: string,
    next: () => Promise<QueryResult>,
    execute: (text: string) => Promise<QueryResult>,
  ) => Promise<QueryResult>,
) {
  const original = database.pool.connect.bind(database.pool);
  const wrapped = new WeakSet<object>();
  vi.spyOn(database.pool, 'connect').mockImplementation((async () => {
    const client = await original();
    if (!wrapped.has(client)) {
      wrapped.add(client);
      const query = client.query.bind(client);
      vi.spyOn(client, 'query').mockImplementation(((config: unknown, ...args: unknown[]) =>
        handler(
          typeof config === 'string' ? config : (config as { text: string }).text,
          () => Reflect.apply(query, client, [config, ...args]) as Promise<QueryResult>,
          (text) => query(text) as unknown as Promise<QueryResult>,
        )) as typeof client.query);
    }
    return client;
  }) as typeof database.pool.connect);
}
describe.skipIf(!approved)('S4 real restricted PostgreSQL, Redis and Argon2 protocol', () => {
  let f: ProtocolFixture;
  beforeAll(async () => {
    if (!approved) throw new Error('S4 approval missing');
    f = await createProtocolFixture(approved);
  }, 30000);
  afterEach(async () => {
    vi.restoreAllMocks();
    if (f) {
      await f.seedAnchor();
      await f.drainAdmissions();
    }
  });
  afterAll(async () => {
    await f?.close();
  }, 30000);
  async function complete(started: Started) {
    const response = await bounded(started.response, 'S4 response', 12000);
    await bounded(started.settlement, 'S4 actual settlement', 12000);
    return response;
  }
  const counts = () => f.writes();
  async function retained(key: string, input: unknown, boundary: Ready['boundary']) {
    const binding = await boundary.bind(key, input);
    return (
      await f.owner.pool.query('SELECT * FROM signup_idempotency_claims WHERE key_digest=$1', [
        binding.keyDigest,
      ])
    ).rows[0];
  }
  async function credential(email: string) {
    return (
      await f.owner.pool.query(
        'SELECT p.password_hash FROM users u JOIN password_credentials p ON p.user_id=u.id WHERE u.email_normalized=$1',
        [email.toLowerCase()],
      )
    ).rows[0]?.password_hash as string | undefined;
  }
  const role = () => '"' + f.runtimeUrl.username + '"';
  it('atomically commits user, Argon2 credential, security audit and exact accepted result', async () => {
    const service = await f.ready();
    const r = request();
    const before = await counts();
    const started = service.start(r.key, r.input);
    expect(await complete(started)).toEqual({ status: 202, body: { status: 'accepted' } });
    const after = await counts();
    expect(after).toEqual({
      ...before,
      users: before.users + 1,
      credentials: before.credentials + 1,
      audits: before.audits + 1,
      results: before.results + 1,
    });
    const encoded = await credential(r.input.email);
    expect(await verifyPassword(encoded!, r.input.password)).toBe(true);
    expect(encoded?.startsWith('$argon2id$v=19$m=65536,p=1,t=3$')).toBe(true);
    expect(started.operation.proof?.source).toBe('T2_COMMIT_ACK');
    console.info(
      JSON.stringify({
        scenario: 'S4_ATOMIC_ACCEPTED',
        users: 1,
        credentials: 1,
        audits: 1,
        results: 1,
        proof: started.operation.proof?.source,
      }),
    );
  });
  it('accepted replay uses a fresh T1 result without hashing or duplicate side effects', async () => {
    const service = await f.ready();
    const r = request();
    expect((await complete(service.start(r.key, r.input))).status).toBe(202);
    const before = await counts();
    const claim = await retained(r.key, r.input, service.boundary);
    service.hash.mockClear();
    const replay = service.start(r.key, r.input);
    expect((await complete(replay)).status).toBe(202);
    expect(replay.operation.proof?.source).toBe('RETAINED_RESULT_T1');
    expect(service.hash).not.toHaveBeenCalled();
    expect(await counts()).toEqual(before);
    expect(await retained(r.key, r.input, service.boundary)).toEqual(claim);
  });
  it('a conflicting retained binding cannot renew expiry or hash/create a substitute account', async () => {
    const service = await f.ready();
    const r = request();
    await complete(service.start(r.key, r.input));
    const claim = await retained(r.key, r.input, service.boundary);
    const before = await counts();
    service.hash.mockClear();
    expect(
      await complete(
        service.start(r.key, { ...r.input, password: 'different public fixture password 123' }),
      ),
    ).toEqual({ status: 409, code: 'SIGNUP_IDEMPOTENCY_CONFLICT' });
    expect(await retained(r.key, r.input, service.boundary)).toEqual(claim);
    expect(service.hash).not.toHaveBeenCalled();
    expect(await counts()).toEqual(before);
  });
  it('four concurrent identical requests across independent pools create exactly one domain result', async () => {
    const r = request();
    const services = await Promise.all(Array.from({ length: 4 }, () => f.ready(f.database())));
    const before = await counts();
    const responses = await Promise.all(
      services.map((service) => complete(service.start(r.key, r.input))),
    );
    expect(responses.every((response) => response.status === 202)).toBe(true);
    const after = await counts();
    expect(after).toEqual({
      ...before,
      users: before.users + 1,
      credentials: before.credentials + 1,
      audits: before.audits + 1,
      results: before.results + 1,
    });
  }, 20000);
  it('concurrent conflicting requests establish one immutable winner with no duplicate domain writes', async () => {
    const r = request();
    const [a, b] = await Promise.all([f.ready(f.database()), f.ready(f.database())]);
    const before = await counts();
    const replies = await Promise.all([
      complete(a.start(r.key, r.input)),
      complete(b.start(r.key, { ...r.input, password: 'another public fixture password 123' })),
    ]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([202, 409]);
    const after = await counts();
    expect(after).toEqual({
      ...before,
      users: before.users + 1,
      credentials: before.credentials + 1,
      audits: before.audits + 1,
      results: before.results + 1,
    });
  });
  it('an existing account gets generic acceptance without changing its credential or fabricating a user-created audit', async () => {
    const service = await f.ready();
    const r = request();
    await complete(service.start(r.key, r.input));
    const before = await counts();
    const next = { ...r.input, password: 'different existing-account fixture 123' };
    expect((await complete(service.start('s4_' + randomUUID(), next))).status).toBe(202);
    expect(await counts()).toEqual({ ...before, results: before.results + 1 });
    const encoded = await credential(r.input.email);
    expect(await verifyPassword(encoded!, r.input.password)).toBe(true);
    expect(await verifyPassword(encoded!, next.password)).toBe(false);
  });
  it('mandatory audit permission failure rolls back all domain writes and accepted result', async () => {
    const service = await f.ready();
    const r = request();
    const before = await counts();
    await f.owner.pool.query('REVOKE INSERT ON security_audit_events FROM ' + role());
    try {
      expect((await complete(service.start(r.key, r.input))).status).toBe(500);
      expect(await counts()).toEqual(before);
      expect(await retained(r.key, r.input, service.boundary)).toBeDefined();
    } finally {
      await f.owner.pool.query('GRANT INSERT ON security_audit_events TO ' + role());
    }
  });
  it('accepted-result insertion failure rolls back user, credential and mandatory audit together', async () => {
    const service = await f.ready();
    const r = request();
    const before = await counts();
    await f.owner.pool.query('REVOKE INSERT ON signup_idempotency_results FROM ' + role());
    try {
      expect((await complete(service.start(r.key, r.input))).status).toBe(500);
      expect(await counts()).toEqual(before);
    } finally {
      await f.owner.pool.query('GRANT INSERT ON signup_idempotency_results TO ' + role());
    }
  });
  it('T1 lost COMMIT ACK proves the retained claim before hashing and keeps immutable expiry', async () => {
    const proxy = await f.proxy();
    const service = await f.ready(f.database(proxy.url));
    const r = request();
    proxy.arm();
    const started = service.start(r.key, r.input);
    await proxy.waitForDrop();
    expect((await complete(started)).status).toBe(202);
    expect(service.hash).toHaveBeenCalledOnce();
    expect(started.operation.evidence()[0]?.outcome).toBe('COMMIT_UNKNOWN');
    expect(started.operation.proof?.source).toBe('T2_COMMIT_ACK');
    const before = await retained(r.key, r.input, service.boundary);
    await complete(service.start(r.key, r.input));
    expect(await retained(r.key, r.input, service.boundary)).toEqual(before);
  });
  it('T2 lost COMMIT ACK recovers only by a fresh T3 accepted result with one domain execution', async () => {
    const proxy = await f.proxy();
    const service = await f.ready(f.database(proxy.url), {
      hash: async (password) => {
        const encoded = await hashPassword(password);
        proxy.arm();
        return encoded;
      },
    });
    const r = request();
    const before = await counts();
    const started = service.start(r.key, r.input);
    await proxy.waitForDrop();
    expect((await complete(started)).status).toBe(202);
    expect(started.operation.proof?.source).toBe('RETAINED_RESULT_T3');
    expect(started.operation.evidence().map((record) => record.outcome)).toEqual([
      'COMMIT_ACK',
      'COMMIT_UNKNOWN',
      'ABORT_CONFIRMED',
    ]);
    const after = await counts();
    expect(after).toEqual({
      ...before,
      users: before.users + 1,
      credentials: before.credentials + 1,
      audits: before.audits + 1,
      results: before.results + 1,
    });
    console.info(
      JSON.stringify({
        scenario: 'S4_T2_ACK_LOSS',
        proof: started.operation.proof?.source,
        domainExecutions: 1,
        t3DomainWrites: 0,
      }),
    );
  });
  it('a real COMMIT returning ROLLBACK never accepts the callback own uncommitted result', async () => {
    const database = f.database();
    let armed = false;
    let tag: string | undefined;
    const service = await f.ready(database, {
      hash: async (password) => {
        const encoded = await hashPassword(password);
        armed = true;
        return encoded;
      },
    });
    intercept(database, async (text, next, execute) => {
      if (text === 'COMMIT' && armed) {
        armed = false;
        await expect(execute('SELECT 1/0')).rejects.toMatchObject({ code: '22012' });
        const result = await next();
        tag = result.command;
        return result;
      }
      return next();
    });
    const before = await counts();
    const r = request();
    const started = service.start(r.key, r.input);
    expect((await complete(started)).status).toBe(500);
    expect(tag).toBe('ROLLBACK');
    expect(started.operation.proof).toBeUndefined();
    expect(
      started.operation.evidence().some((record) => record.outcome === 'COMMIT_ROLLBACK'),
    ).toBe(true);
    expect(await counts()).toEqual(before);
    console.info(
      JSON.stringify({ scenario: 'S4_ROLLBACK_TAG', serverCommandTag: tag, accepted: false }),
    );
  });
  it('verified T2 COMMIT survives a deliberately throwing release observer', async () => {
    const database = f.database();
    let armed = false;
    const service = await f.ready(database, {
      hash: async (password) => {
        const encoded = await hashPassword(password);
        armed = true;
        return encoded;
      },
    });
    const fault = () => {
      if (armed) {
        armed = false;
        throw new Error('controlled release observer fault');
      }
    };
    database.pool.on('release', fault);
    try {
      const r = request();
      const started = service.start(r.key, r.input);
      expect((await complete(started)).status).toBe(202);
      expect(started.operation.proof?.source).toBe('T2_COMMIT_ACK');
      expect(
        started.operation
          .evidence()
          .some(
            (record) =>
              record.outcome === 'COMMIT_ACK' &&
              record.cleanup === 'EVICTED' &&
              record.diagnosticCount > 0,
          ),
      ).toBe(true);
    } finally {
      database.pool.removeListener('release', fault);
    }
  });
  it('T3 positive result survives deliberately failed ROLLBACK commands', async () => {
    const proxy = await f.proxy();
    const database = f.database(proxy.url);
    const service = await f.ready(database, {
      hash: async (password) => {
        const encoded = await hashPassword(password);
        proxy.arm();
        return encoded;
      },
    });
    intercept(database, async (text, next) => {
      if (text === 'ROLLBACK' && started?.operation.proof?.source === 'RETAINED_RESULT_T3')
        throw new Error('controlled recovery rollback fault');
      return next();
    });
    const r = request();
    const started = service.start(r.key, r.input);
    await proxy.waitForDrop();
    expect((await complete(started)).status).toBe(202);
    expect(started.operation.proof?.source).toBe('RETAINED_RESULT_T3');
    expect(started.operation.evidence().at(-1)?.cleanup).toBe('EVICTED');
  });
  it('T3 positive result survives release failure and client cancellation', async () => {
    const proxy = await f.proxy();
    const database = f.database(proxy.url);
    const service = await f.ready(database, {
      hash: async (password) => {
        const encoded = await hashPassword(password);
        proxy.arm();
        return encoded;
      },
    });
    const signal = new AbortController();
    let started: Started | undefined;
    let injected = false;
    const fault = () => {
      if (!injected && started?.operation.proof?.source === 'RETAINED_RESULT_T3') {
        injected = true;
        signal.abort();
        throw new Error('controlled proof-after-release fault');
      }
    };
    database.pool.on('release', fault);
    try {
      const r = request();
      started = service.start(r.key, r.input, signal.signal);
      await proxy.waitForDrop();
      expect((await complete(started)).status).toBe(202);
      expect(started.operation.proof?.source).toBe('RETAINED_RESULT_T3');
      expect(injected).toBe(true);
    } finally {
      database.pool.removeListener('release', fault);
    }
  });
  it('an unknown T2 with a fresh missing result returns503 without automatic domain retry', async () => {
    const database = f.database();
    let armed = false;
    const service = await f.ready(database, {
      hash: async (password) => {
        const encoded = await hashPassword(password);
        armed = true;
        return encoded;
      },
    });
    intercept(database, async (text, next) => {
      if (text === 'COMMIT' && armed) {
        armed = false;
        throw new Error('controlled before-send COMMIT rejection');
      }
      return next();
    });
    const before = await counts();
    const r = request();
    const started = service.start(r.key, r.input);
    expect((await complete(started)).status).toBe(503);
    expect(service.hash).toHaveBeenCalledOnce();
    expect(started.operation.proof).toBeUndefined();
    expect(started.operation.evidence().map((record) => record.outcome)).toEqual([
      'COMMIT_ACK',
      'COMMIT_UNKNOWN',
      'ABORT_CONFIRMED',
    ]);
    expect(await counts()).toEqual(before);
  });
  it('identified recovery SELECT permission failure cannot fabricate acceptance', async () => {
    const proxy = await f.proxy();
    let verifies = 0;
    const service = await f.ready(f.database(proxy.url), {
      hash: async (password) => {
        const encoded = await hashPassword(password);
        proxy.arm();
        return encoded;
      },
      boundary: (original) => ({
        ...original,
        verify: async (tx, binding) => {
          if (++verifies === 2)
            await f.owner.pool.query('REVOKE SELECT ON signup_idempotency_results FROM ' + role());
          await original.verify(tx, binding);
        },
      }),
    });
    try {
      const r = request();
      const started = service.start(r.key, r.input);
      await proxy.waitForDrop();
      expect((await complete(started)).status).toBe(500);
      expect(started.operation.proof).toBeUndefined();
    } finally {
      await f.owner.pool.query('GRANT SELECT ON signup_idempotency_results TO ' + role());
    }
  });
  it('terminal COMMIT ACK loss requires authoritative retained expiry before409 and never hashes or writes domain state', async () => {
    const proxy = await f.proxy();
    const service = await f.ready(f.database(proxy.url), {
      boundary: (original) => ({
        ...original,
        reserve: async (...args) => {
          const reservation = await original.reserve(...args);
          proxy.arm();
          return reservation;
        },
      }),
    });
    const r = request();
    const binding = await service.boundary.bind(r.key, r.input);
    const claim = (
      await f.owner.pool.query(
        "INSERT INTO signup_idempotency_claims(key_version,hmac_key_version,key_digest,payload_version,payload_digest,created_at,expires_at) VALUES($1,$2,$3,$4,$5,now()-interval '2 days',now()-interval '1 day') RETURNING *",
        [
          binding.keyVersion,
          binding.hmacKeyVersion,
          binding.keyDigest,
          binding.payloadVersion,
          binding.payloadDigest,
        ],
      )
    ).rows[0];
    const before = await counts();
    const started = service.start(r.key, r.input);
    await proxy.waitForDrop();
    expect(await complete(started)).toEqual({ status: 409, code: 'SIGNUP_IDEMPOTENCY_EXPIRED' });
    expect(service.hash).not.toHaveBeenCalled();
    expect(await counts()).toEqual({ ...before, terminals: before.terminals + 1 });
    expect(await retained(r.key, r.input, service.boundary)).toEqual(claim);
  });
  it('a genuinely committed result replays after immutable expiry without hashing', async () => {
    const service = await f.ready(f.database(), { windowMs: 3000 });
    const r = request();
    expect((await complete(service.start(r.key, r.input))).status).toBe(202);
    const claim = await retained(r.key, r.input, service.boundary);
    await expect
      .poll(
        async () =>
          Boolean(
            (
              await f.owner.pool.query(
                'SELECT clock_timestamp()>expires_at AS expired FROM signup_idempotency_claims WHERE id=$1',
                [claim.id],
              )
            ).rows[0].expired,
          ),
        { interval: 30, timeout: 4000 },
      )
      .toBe(true);
    service.hash.mockClear();
    const before = await counts();
    expect((await complete(service.start(r.key, r.input))).status).toBe(202);
    expect(service.hash).not.toHaveBeenCalled();
    expect(await counts()).toEqual(before);
    expect(await retained(r.key, r.input, service.boundary)).toEqual(claim);
  }, 10000);
  it('cancellation during actual native Argon2 retains admission until native work settles and starts no T2', async () => {
    const signal = new AbortController();
    const entered = deferred<void>();
    const service = await f.ready(f.database(), {
      hash: async (password) => {
        const native = hashPassword(password);
        entered.resolve();
        signal.abort();
        return native;
      },
    });
    const r = request();
    const before = await counts();
    const started = service.start(r.key, r.input, signal.signal);
    await entered.promise;
    expect((await started.response).status).toBe(503);
    expect(service.admission.inventory().active).toBe(1);
    await started.settlement;
    expect(service.admission.inventory().active).toBe(0);
    expect(started.operation.evidence()).toHaveLength(1);
    expect(await counts()).toEqual(before);
  });
  it('Redis release acknowledgement failure does not erase verified account acceptance', async () => {
    const adapter = {
      getClient: async () => {
        const client = await f.redis.getClient();
        return {
          withCommandOptions: (options: Parameters<typeof client.withCommandOptions>[0]) => {
            const commands = client.withCommandOptions(options);
            return {
              eval: async (script: string, args: Parameters<typeof commands.eval>[1]) => {
                const value = await commands.eval(script, args);
                if (script.startsWith("return redis.call('ZREM'"))
                  throw new Error('controlled Redis release ACK loss');
                return value;
              },
            };
          },
        };
      },
    } as unknown as RedisService;
    const service = await f.ready(f.database(), { redis: adapter });
    const r = request();
    const started = service.start(r.key, r.input);
    expect((await complete(started)).status).toBe(202);
    expect(started.operation.proof?.source).toBe('T2_COMMIT_ACK');
    expect(service.admission.inventory()).toMatchObject({ active: 0, cleanupFaults: 1 });
  });
  it('namespace drift during hashing stops T2 before any account or accepted-result write', async () => {
    const service = await f.ready(f.database(), {
      hash: async (password) => {
        const encoded = await hashPassword(password);
        await f.owner.pool.query(
          "UPDATE signup_idempotency_namespace SET attestation_key_digest=repeat('0',64)",
        );
        return encoded;
      },
    });
    const r = request();
    const before = await counts();
    const started = service.start(r.key, r.input);
    expect((await complete(started)).status).toBe(500);
    expect(started.operation.proof).toBeUndefined();
    expect(await counts()).toEqual(before);
  });
  it('the recovery reader rejects accidental repository INSERT despite runtime INSERT privilege', async () => {
    const before = await counts();
    const record = await runOwnedSignupTransaction(
      f.runtime,
      async (tx) =>
        tx.insert(signupIdempotencyResults).values({
          claimId: randomUUID(),
          resultVersion: 1,
          statusCode: 202,
          responseBody: { status: 'accepted' },
        }),
      { profile: 'recovery', completion: 'rollback' },
    );
    await record.settlement;
    expect(record.primary?.error).toMatchObject({ cause: { code: 'RECOVERY_WRITE_FORBIDDEN' } });
    expect(record.value).toBeUndefined();
    expect(await counts()).toEqual(before);
  });
  it('T3 accepted proof remains deliverable while owned disposal is quarantined and admission stays retained', async () => {
    const proxy = await f.proxy();
    const database = f.database(proxy.url);
    const service = await f.ready(database, {
      hash: async (password) => {
        const encoded = await hashPassword(password);
        proxy.arm();
        return encoded;
      },
    });
    const cleanup = deferred<void>();
    const entered = deferred<void>();
    let started: Started | undefined;
    const wrapped = new WeakSet<object>();
    const connect = database.pool.connect.bind(database.pool);
    vi.spyOn(database.pool, 'connect').mockImplementation((async () => {
      const client = await connect();
      const owned = client as typeof client & {
        dispose(): Promise<{
          removed: true;
          transportSettled: true;
          diagnostics: readonly unknown[];
        }>;
      };
      const dispose = owned.dispose.bind(owned);
      owned.dispose = async () => {
        if (started?.operation.proof?.source === 'RETAINED_RESULT_T3') {
          entered.resolve();
          await cleanup.promise;
        }
        return dispose();
      };
      if (!wrapped.has(client)) {
        wrapped.add(client);
        const query = client.query.bind(client);
        vi.spyOn(client, 'query').mockImplementation(((config: unknown, ...args: unknown[]) => {
          if (config === 'ROLLBACK' && started?.operation.proof?.source === 'RETAINED_RESULT_T3')
            return Promise.reject(
              new Error('controlled read-end failure before quarantined disposal'),
            );
          return Reflect.apply(query, client, [config, ...args]);
        }) as typeof client.query);
      }
      return client;
    }) as typeof database.pool.connect);
    try {
      const r = request();
      started = service.start(r.key, r.input);
      await proxy.waitForDrop();
      expect((await bounded(started.response, 'S4 accepted before disposal', 5000)).status).toBe(
        202,
      );
      await bounded(entered.promise, 'S4 owned disposal gate');
      expect(service.admission.inventory().active).toBe(1);
      await expect
        .poll(() => started!.operation.evidence().at(-1)?.cleanup, { interval: 20, timeout: 2500 })
        .toBe('QUARANTINED_WITH_OWNER');
      expect(started.operation.proof?.source).toBe('RETAINED_RESULT_T3');
    } finally {
      cleanup.resolve();
      if (started)
        await bounded(started.settlement, 'S4 quarantined cleanup final settlement', 10000);
    }
    expect(service.admission.inventory().active).toBe(0);
    expect(started?.operation.proof?.source).toBe('RETAINED_RESULT_T3');
  });
  it.each(['after_t1', 'after_result', 'after_commit'] as const)(
    'process crash %s preserves claim identity and requires a fresh synchronized retry',
    async (phase) => {
      const service = await f.ready();
      const r = request();
      const before = await counts();
      const beforeMembers = await f.observer.zRange('authcore:{signup}:admission', 0, -1);
      const appName = 's4_crash_' + randomUUID().replaceAll('-', '');
      const url = new URL(f.runtimeUrl);
      url.searchParams.set('application_name', appName);
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL('./signup-protocol-crash.test-support.mjs', import.meta.url))],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          env: Object.fromEntries(
            Object.entries(process.env).filter(
              ([name]) => !['DATABASE_URL', 'REDIS_URL'].includes(name),
            ),
          ),
        },
      );
      const checkpoint = deferred<{ phase: string; pid: number }>();
      const errors: string[] = [];
      let buffer = '';
      let stderr = '';
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => child.once('close', (code, signal) => resolve({ code, signal })),
      );
      child.on('error', () => errors.push('worker startup error'));
      child.stdin.on('error', () => errors.push('worker stdin error'));
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (value) => {
        stderr += String(value);
      });
      child.stdout.on('data', (value) => {
        buffer += String(value);
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            const event = JSON.parse(line);
            if (event.kind === 'CHECKPOINT') checkpoint.resolve(event);
            else errors.push('worker failure');
          } catch {
            errors.push('worker protocol failure');
          }
        }
      });
      child.stdin.write(
        JSON.stringify({
          databaseUrl: url.toString(),
          redisUrl: f.redisUrl.toString(),
          secret: Array.from({ length: 32 }, (_, i) => i),
          metadata: service.boundary.metadata,
          phase,
          key: r.key,
          input: r.input,
        }) + '\n',
      );
      try {
        const observed = await bounded(
          Promise.race([
            checkpoint.promise,
            exited.then(() => {
              throw new Error('S4 worker exited before checkpoint');
            }),
          ]),
          'S4 crash checkpoint',
          10000,
        );
        expect(observed.phase).toBe(phase);
        const claim = await retained(r.key, r.input, service.boundary);
        expect(claim).toBeDefined();
        expect(await counts()).toEqual(
          phase === 'after_commit'
            ? {
                ...before,
                users: before.users + 1,
                credentials: before.credentials + 1,
                audits: before.audits + 1,
                results: before.results + 1,
              }
            : before,
        );
        child.kill('SIGKILL');
        const end = await bounded(exited, 'S4 deliberate worker crash', 5000);
        expect(end.signal).toBe('SIGKILL');
        await expect
          .poll(
            async () =>
              Number(
                (
                  await f.owner.pool.query(
                    'SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=$1 AND datname=current_database()',
                    [appName],
                  )
                ).rows[0].n,
              ),
            { interval: 20, timeout: 3000 },
          )
          .toBe(0);
        expect(await counts()).toEqual(
          phase === 'after_commit'
            ? {
                ...before,
                users: before.users + 1,
                credentials: before.credentials + 1,
                audits: before.audits + 1,
                results: before.results + 1,
              }
            : before,
        );
        service.hash.mockClear();
        const replay = service.start(r.key, r.input);
        expect((await complete(replay)).status).toBe(202);
        if (phase === 'after_commit') expect(service.hash).not.toHaveBeenCalled();
        expect(await retained(r.key, r.input, service.boundary)).toEqual(claim);
        expect(await counts()).toEqual({
          ...before,
          users: before.users + 1,
          credentials: before.credentials + 1,
          audits: before.audits + 1,
          results: before.results + 1,
        });
        expect(errors).toEqual([]);
        expect(stderr).toBe('');
        console.info(
          JSON.stringify({
            scenario: 'S4_PROCESS_CRASH',
            phase,
            authoritativeBackendAbsent: true,
            immutableClaim: true,
            domainExecutions: 1,
          }),
        );
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await bounded(exited, 'S4 crash worker cleanup', 5000);
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        await f.removeOwnedCrashLeases(beforeMembers);
      }
    },
    20000,
  );
});
