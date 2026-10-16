import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import { type INestApplication, Logger, Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { verifyPassword } from '@authcore/crypto';
import {
  createDatabaseClient,
  PasswordCredentialRepository,
  SecurityAuditEventRepository,
  signupOwnerInventory,
  UserRepository,
} from '@authcore/db';

import { GlobalExceptionFilter } from '../common/filters/global-exception.filter.js';
import { DatabaseService } from '../database/database.service.js';
import { RedisService } from '../redis/redis.service.js';
import { AuthController } from './auth.controller.js';
import { SignupAdmission, SIGNUP_RENEW_MS } from './signup-admission.js';
import { SignupAdmissionInterceptor } from './signup-admission.interceptor.js';
import { SignupEnabledGuard } from './signup-enabled.guard.js';
import { SignupRateLimitGuard } from './signup-rate-limit.guard.js';
import { SignupRateLimiter } from './signup-rate-limiter.js';
import { SignupService, SIGNUP_CONFIGURATION } from './signup.service.js';
import { SignupKeyGuard } from './signup-key.guard.js';
import { configureSignupHttp, SignupHttpAdapter } from './signup-http.js';
import { testSignupConfiguration } from './signup-reservation.test-support.js';

// Explicit E2E config, no .env loading, no fallback to the application's URL.
const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || process.env.TEST_REDIS_URL !== 'redis://127.0.0.1:6380') {
  throw new Error('E2E requires TEST_DATABASE_URL and dedicated TEST_REDIS_URL on port 6380');
}
const source = new URL(connectionString);
if (
  !['postgres:', 'postgresql:'].includes(source.protocol) ||
  !['127.0.0.1', 'localhost'].includes(source.hostname) ||
  !['', '5432'].includes(source.port) ||
  source.pathname !== '/authcore_test' ||
  source.search ||
  source.hash
) {
  throw new Error('E2E requires local port 5432 authcore_test without URL options');
}

function latch() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe('Isolated HTTP + Redis + PostgreSQL signup security', () => {
  const suffix = randomUUID().replaceAll('-', '');
  const databaseName = `signup_e2e_${suffix}`;
  const runtimeRole = `signup_e2e_runtime_${suffix}`;
  const url = new URL(source);
  url.pathname = `/${databaseName}`;
  const runtimeUrl = new URL(url);
  runtimeUrl.username = runtimeRole;
  runtimeUrl.password = randomUUID();
  const admin = createDatabaseClient({ connectionString: source.toString() });
  // Fixtures/migrations use the owner; every HTTP signup uses a real limited login.
  const database = createDatabaseClient({ connectionString: url.toString() });
  const runtime = createDatabaseClient({ connectionString: runtimeUrl.toString() });
  let created = false;
  let roleCreated = false;
  let permissionsSql: string;
  let app: INestApplication | undefined;
  let baseUrl: string;
  let redisService: RedisService | undefined;
  let redis: Awaited<ReturnType<RedisService['getClient']>>;
  let namespace: string;
  let keys: Set<string>;
  let acquireCount: number;
  let renewFailures: number;
  let releases: { token: string; emails: string[]; localOwners: number }[];
  const input = { email: 'lease@example.com', password: 'correct horse battery staple' };
  const admissionKey = () => `${namespace}:admission`;

  async function provisionRuntime() {
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('authcore.runtime_role', $1, true)", [runtimeRole]);
      await client.query(permissionsSql);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    expect((await admin.pool.query('SELECT current_database() AS name')).rows[0].name).toBe(
      'authcore_test',
    );
    const roleSql = (
      await admin.pool.query(
        "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', $1::text, $2::text) AS sql",
        [runtimeRole, runtimeUrl.password],
      )
    ).rows[0].sql;
    await admin.pool.query(roleSql);
    roleCreated = true;
    await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    expect((await database.pool.query('SELECT current_database() AS name')).rows[0].name).toBe(
      databaseName,
    );
    const folder = new URL('../../../../packages/db/drizzle/', import.meta.url);
    for (const name of (await readdir(folder)).filter((name) => name.endsWith('.sql')).sort()) {
      await database.pool.query(await readFile(new URL(name, folder), 'utf8'));
    }
    // This explicit prerequisite is confined to the suite's disposable database.
    const configuration = testSignupConfiguration();
    await database.pool.query(
      'INSERT INTO signup_idempotency_namespace(id,hmac_key_version,attestation_key_digest,attestation_payload_digest) VALUES(1,$1,$2,$3)',
      [
        configuration.metadata.hmacKeyVersion,
        configuration.metadata.keyDigest,
        configuration.metadata.payloadDigest,
      ],
    );
    await database.pool.query(`REVOKE TEMPORARY ON DATABASE "${databaseName}" FROM PUBLIC`);
    permissionsSql = await readFile(
      new URL('../../../../packages/db/permissions/signup-runtime-role.sql', import.meta.url),
      'utf8',
    );
    await provisionRuntime();
    expect((await runtime.pool.query('SELECT current_user, session_user')).rows[0]).toEqual({
      current_user: runtimeRole,
      session_user: runtimeRole,
    });
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('DATABASE_URL', runtimeUrl.toString());
    vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:6380');
    vi.stubEnv('WEB_ORIGIN', 'http://127.0.0.1');
    // Only this ephemeral test app opts in; .env and actual API stay disabled.
    vi.stubEnv('SIGNUP_ENABLED', 'true');
    redisService = new RedisService();
    redis = await redisService.getClient();
    expect(await redis.ping()).toBe('PONG');
    const evalIsolated = async (script: string, args: { keys: string[]; arguments: string[] }) => {
      const mapped = args.keys.map((key) => {
        if (!key.startsWith('authcore:{signup}:')) throw new Error('Unexpected Redis key');
        const owned = `${namespace}:${key.slice('authcore:{signup}:'.length)}`;
        keys.add(owned);
        return owned;
      });
      if (script.includes('ZCARD')) acquireCount++;
      if (script.includes("redis.call('ZREM',")) {
        // Observe committed DB state at the actual release boundary.
        releases.push({
          token: args.arguments[0]!,
          emails: (await database.pool.query('SELECT email_normalized FROM users')).rows.map(
            (row) => String(row.email_normalized),
          ),
          localOwners: signupOwnerInventory(runtime).length,
        });
      }
      const reply = await redis
        .withCommandOptions({ timeout: 1000 })
        .eval(script, { ...args, keys: mapped });
      if (script.includes('ZSCORE') && reply === 0) renewFailures++;
      return reply;
    };
    const isolatedRedis = {
      getClient: async () => ({
        eval: evalIsolated,
        withCommandOptions: () => ({ eval: evalIsolated }),
      }),
    };
    @Module({
      controllers: [AuthController],
      providers: [
        SignupService,
        SignupEnabledGuard,
        SignupKeyGuard,
        {
          provide: SIGNUP_CONFIGURATION,
          useValue: { hmac: configuration, executionWindowMs: 86400000 },
        },
        SignupRateLimitGuard,
        SignupRateLimiter,
        SignupAdmission,
        SignupAdmissionInterceptor,
        { provide: DatabaseService, useValue: { getClient: () => runtime } },
        { provide: RedisService, useValue: isolatedRedis },
      ],
    })
    class IsolatedSignupModule {}
    app = await NestFactory.create(IsolatedSignupModule, new SignupHttpAdapter(), {
      logger: false,
      bodyParser: false,
    });
    configureSignupHttp(app);
    vi.stubEnv('SIGNUP_ENABLED', 'false');
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        validationError: { target: false, value: false },
      }),
    );
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  }, 15_000);

  beforeEach(async () => {
    await database.pool.query('DELETE FROM security_audit_events');
    await database.pool.query('DELETE FROM users');
    namespace = `authcore:test:{signup-e2e-${randomUUID()}}`;
    keys = new Set();
    acquireCount = 0;
    renewFailures = 0;
    releases = [];
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    // Accelerate only renewal scheduling. HTTP, pg, Redis, monotonic clocks,
    // lease expiry, and every Lua reply are real; no fake global clock.
    const schedule = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: (...args: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => schedule(callback, ms === SIGNUP_RENEW_MS ? 25 : ms, ...args)) as typeof setTimeout);
  });

  afterEach(async () => {
    // Observe actual settlement separately from the now-independent HTTP response.
    await expect
      .poll(() => app!.get(SignupAdmission).inventory().active, { timeout: 8000 })
      .toBe(0);
    await expect
      .poll(() => app!.get(SignupAdmission).inventory().owners, { timeout: 8000 })
      .toBe(0);
    vi.restoreAllMocks();
    for (const key of keys) {
      await redis.del(key);
      expect(await redis.exists(key)).toBe(0);
    }
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      redisService?.onApplicationShutdown();
      vi.unstubAllEnvs();
      try {
        await runtime.pool.end();
      } finally {
        try {
          await database.pool.end();
        } finally {
          try {
            if (created) await admin.pool.query(`DROP DATABASE "${databaseName}"`);
          } finally {
            try {
              if (roleCreated) await admin.pool.query(`DROP ROLE "${runtimeRole}"`);
            } finally {
              await admin.pool.end();
            }
          }
        }
      }
    }
  });

  const send = (email = input.email) =>
    fetch(`${baseUrl}/api/v1/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'e2e_' + randomUUID() },
      body: JSON.stringify({ ...input, email }),
    });
  async function assertRemoteTransactionsSettled() {
    // A1 local transport closure is not synchronous server-side rollback proof.
    // Observe the HTTP writer's actual backend, excluding owner/witness queries.
    await expect
      .poll(async () =>
        Number(
          (
            await database.pool.query(
              'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND usename = $1 AND xact_start IS NOT NULL',
              [runtimeRole],
            )
          ).rows[0].n,
        ),
      )
      .toBe(0);
  }
  async function unavailable(response: Response) {
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    expect(await response.json()).toEqual({
      error: { code: 'HTTP_503', message: 'Signup temporarily unavailable' },
    });
  }

  it.each(['user', 'credential', 'audit'])(
    'propagates lease loss after the real %s write, rolls back, and releases only its token',
    async (stage) => {
      const entered = latch();
      const finish = latch();
      if (stage === 'user') {
        const original = UserRepository.prototype.create;
        vi.spyOn(UserRepository.prototype, 'create').mockImplementation(async function (
          this: UserRepository,
          value,
        ) {
          const result = await original.call(this, value);
          entered.open();
          await finish.promise;
          return result;
        });
      } else if (stage === 'credential') {
        const original = PasswordCredentialRepository.prototype.create;
        vi.spyOn(PasswordCredentialRepository.prototype, 'create').mockImplementation(
          async function (this: PasswordCredentialRepository, value) {
            const result = await original.call(this, value);
            entered.open();
            await finish.promise;
            return result;
          },
        );
      } else {
        const original = SecurityAuditEventRepository.prototype.recordUserCreated;
        vi.spyOn(SecurityAuditEventRepository.prototype, 'recordUserCreated').mockImplementation(
          async function (this: SecurityAuditEventRepository, value) {
            const result = await original.call(this, value);
            entered.open();
            await finish.promise;
            return result;
          },
        );
      }
      let settled = false;
      const pending = send().then((response) => {
        settled = true;
        return response;
      });
      try {
        await entered.promise;
        const [token] = await redis.zRange(admissionKey(), 0, -1);
        expect(token).toBeDefined();
        await redis.zAdd(admissionKey(), { score: 1, value: token! });
        await expect.poll(() => renewFailures, { interval: 10 }).toBe(1);
        const replacement = `replacement-${randomUUID()}`;
        await redis.zAdd(admissionKey(), { score: Date.now() + 30_000, value: replacement });
        await expect.poll(() => settled).toBe(true);
        expect(app!.get(SignupAdmission).inventory().active).toBe(1);
        expect(releases).toHaveLength(0);
        // Cancellation evicts SQL ownership promptly while the paused callback is still retained.
        await expect
          .poll(async () =>
            Number(
              (
                await database.pool.query(
                  "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'",
                )
              ).rows[0].n,
            ),
          )
          .toBe(0);
        finish.open();
        await unavailable(await pending);
        await expect.poll(() => releases).toEqual([{ token, emails: [], localOwners: 0 }]);
        await assertRemoteTransactionsSettled();
        expect(await redis.zRange(admissionKey(), 0, -1)).toEqual([replacement]);
        expect((await database.pool.query('SELECT * FROM users')).rows).toHaveLength(0);
        expect(
          (await database.pool.query('SELECT * FROM security_audit_events')).rows,
        ).toHaveLength(0);
        expect((await database.pool.query('SELECT * FROM password_credentials')).rows).toHaveLength(
          0,
        );
        expect(Logger.prototype.log).not.toHaveBeenCalled();
        await redis.del(admissionKey());
        const retry = await send();
        expect(retry.status).toBe(202);
        expect(await retry.json()).toEqual({ status: 'accepted' });
        expect((await database.pool.query('SELECT * FROM users')).rows).toHaveLength(1);
        expect(
          (await database.pool.query('SELECT * FROM security_audit_events')).rows,
        ).toHaveLength(1);
        expect((await database.pool.query('SELECT * FROM password_credentials')).rows).toHaveLength(
          1,
        );
        await expect.poll(async () => redis.zCard(admissionKey())).toBe(0);
      } finally {
        finish.open();
        await pending;
      }
    },
  );

  it('holds all four local slots after lease loss until real transaction work settles', async () => {
    const finish = latch();
    let entered = 0;
    const original = PasswordCredentialRepository.prototype.create;
    vi.spyOn(PasswordCredentialRepository.prototype, 'create').mockImplementation(async function (
      this: PasswordCredentialRepository,
      value,
    ) {
      const result = await original.call(this, value);
      entered++;
      await finish.promise;
      return result;
    });
    const pending = Array.from({ length: 4 }, (_, n) => send(`capacity-${n}@example.com`));
    try {
      await expect.poll(() => entered, { interval: 10 }).toBe(4);
      const tokens = await redis.zRange(admissionKey(), 0, -1);
      expect(tokens).toHaveLength(4);
      for (const token of tokens) await redis.zAdd(admissionKey(), { score: 1, value: token });
      await expect.poll(() => renewFailures, { interval: 10 }).toBe(4);
      await unavailable(await send('overflow@example.com'));
      expect(acquireCount).toBe(4);
      expect(releases).toHaveLength(0);
      finish.open();
      for (const response of await Promise.all(pending)) await unavailable(response);
      await expect.poll(() => releases.length).toBe(4);
      expect(releases.every((release) => release.emails.length === 0)).toBe(true);
      await expect.poll(async () => redis.zCard(admissionKey())).toBe(0);
      expect((await database.pool.query('SELECT * FROM users')).rows).toHaveLength(0);
      expect((await database.pool.query('SELECT * FROM security_audit_events')).rows).toHaveLength(
        0,
      );
      expect((await database.pool.query('SELECT * FROM password_credentials')).rows).toHaveLength(
        0,
      );
      // Clear only this test's rate-limit keys to exercise post-failure reuse.
      for (const key of keys) if (key !== admissionKey()) await redis.del(key);
      expect((await send()).status).toBe(202);
      await expect.poll(async () => redis.zCard(admissionKey())).toBe(0);
    } finally {
      finish.open();
      await Promise.all(pending);
    }
  });

  it.each(['password_credentials', 'security_audit_events', 'verification_events'])(
    'sanitizes a real PostgreSQL %s constraint failure, rolls back, and recovers HTTP admission',
    async (table) => {
      const errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      await database.pool.query(`ALTER TABLE ${table} ADD CONSTRAINT e2e_reject CHECK (false)`);
      try {
        const response = await send();
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({
          error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' },
        });
        await expect.poll(() => releases.length).toBe(1);
        expect(releases[0]!.emails).toEqual([]);
        expect(releases[0]!.localOwners).toBe(0);
        await assertRemoteTransactionsSettled();
        await expect.poll(async () => redis.zCard(admissionKey())).toBe(0);
        expect((await database.pool.query('SELECT * FROM users')).rows).toHaveLength(0);
        expect(
          (await database.pool.query('SELECT * FROM security_audit_events')).rows,
        ).toHaveLength(0);
        expect((await database.pool.query('SELECT * FROM password_credentials')).rows).toHaveLength(
          0,
        );
        expect((await database.pool.query('SELECT * FROM verification_events')).rows).toHaveLength(
          0,
        );
        expect(errorLog).toHaveBeenCalledExactlyOnceWith({
          event: 'http.unhandled_exception',
          method: 'POST',
        });
        expect(Logger.prototype.log).not.toHaveBeenCalled();
      } finally {
        await database.pool.query(`ALTER TABLE ${table} DROP CONSTRAINT e2e_reject`);
      }
      expect((await send()).status).toBe(202);
      await expect.poll(async () => redis.zCard(admissionKey())).toBe(0);
      expect((await database.pool.query('SELECT * FROM security_audit_events')).rows).toHaveLength(
        1,
      );
    },
  );

  it('returns identical generic acceptance for successful and duplicate signup without changing credentials or audit', async () => {
    const first = await send();
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ status: 'accepted' });
    const credentials = (await database.pool.query('SELECT * FROM password_credentials')).rows;
    const events = (await database.pool.query('SELECT * FROM security_audit_events')).rows;
    const verification = (await database.pool.query('SELECT * FROM verification_events')).rows;
    expect(events).toHaveLength(1);
    expect(verification).toHaveLength(1);
    const duplicate = await fetch(`${baseUrl}/api/v1/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'e2e_' + randomUUID() },
      body: JSON.stringify({ email: 'LEASE@EXAMPLE.COM', password: 'a different secure password' }),
    });
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toEqual({ status: 'accepted' });
    expect((await database.pool.query('SELECT * FROM users')).rows).toHaveLength(1);
    expect((await database.pool.query('SELECT * FROM password_credentials')).rows).toEqual(
      credentials,
    );
    expect((await database.pool.query('SELECT * FROM security_audit_events')).rows).toEqual(events);
    expect((await database.pool.query('SELECT * FROM verification_events')).rows).toEqual(
      verification,
    );
  });

  it('commits signup through the restricted login while audit mutation is denied', async () => {
    expect((await send()).status).toBe(202);
    const user = (await database.pool.query('SELECT * FROM users')).rows[0];
    const credential = (await database.pool.query('SELECT * FROM password_credentials')).rows[0];
    const event = (await database.pool.query('SELECT * FROM security_audit_events')).rows[0];
    expect(credential.user_id).toBe(user.id);
    expect(await verifyPassword(credential.password_hash, input.password)).toBe(true);
    expect(event).toMatchObject({
      user_id: user.id,
      event_type: 'identity.user_created',
      payload: {},
    });
    for (const sql of [
      'UPDATE security_audit_events SET occurred_at = now()',
      'DELETE FROM security_audit_events',
      'TRUNCATE security_audit_events',
    ]) {
      await expect(runtime.pool.query(sql)).rejects.toMatchObject({ code: '42501' });
    }
    expect((await database.pool.query('SELECT * FROM security_audit_events')).rows).toEqual([
      event,
    ]);
  });

  it('rolls back all signup writes on denied audit INSERT and returns a safe HTTP error', async () => {
    const errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    await database.pool.query(`REVOKE INSERT ON security_audit_events FROM "${runtimeRole}"`);
    try {
      const response = await send();
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' },
      });
      for (const table of ['users', 'password_credentials', 'security_audit_events']) {
        expect((await database.pool.query(`SELECT * FROM ${table}`)).rows).toHaveLength(0);
      }
      expect(Logger.prototype.log).not.toHaveBeenCalled();
      expect(errorLog).toHaveBeenCalledExactlyOnceWith({
        event: 'http.unhandled_exception',
        method: 'POST',
      });
      await expect.poll(() => releases.length).toBe(1);
      expect(releases[0]).toMatchObject({ emails: [], localOwners: 0 });
      await assertRemoteTransactionsSettled();
      await expect.poll(async () => redis.zCard(admissionKey())).toBe(0);
    } finally {
      await provisionRuntime();
    }
    expect((await send()).status).toBe(202);
    for (const table of ['users', 'password_credentials', 'security_audit_events']) {
      expect((await database.pool.query(`SELECT * FROM ${table}`)).rows).toHaveLength(1);
    }
  });
  it('denied verification intent privileges fail identically before fresh or duplicate account handling', async () => {
    expect((await send()).status).toBe(202);
    const before = (await database.pool.query('SELECT * FROM verification_events')).rows;
    const acceptedBefore = (await database.pool.query('SELECT * FROM signup_idempotency_results'))
      .rows;
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    await database.pool.query(`REVOKE INSERT ON verification_events FROM "${runtimeRole}"`);
    try {
      for (const email of [input.email, 'fresh-outbox@example.invalid']) {
        const response = await send(email);
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({
          error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' },
        });
      }
      await expect.poll(async () => redis.zCard(admissionKey())).toBe(0);
      expect((await database.pool.query('SELECT * FROM verification_events')).rows).toEqual(before);
      expect((await database.pool.query('SELECT * FROM signup_idempotency_results')).rows).toEqual(
        acceptedBefore,
      );
      expect((await database.pool.query('SELECT id FROM users')).rows).toHaveLength(1);
    } finally {
      await provisionRuntime();
    }
  });
});
