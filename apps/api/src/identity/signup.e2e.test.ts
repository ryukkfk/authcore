import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import { type INestApplication, Logger, Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDatabaseClient, PasswordCredentialRepository, UserRepository } from '@authcore/db';

import { GlobalExceptionFilter } from '../common/filters/global-exception.filter.js';
import { DatabaseService } from '../database/database.service.js';
import { RedisService } from '../redis/redis.service.js';
import { AuthController } from './auth.controller.js';
import { SignupAdmission, SIGNUP_RENEW_MS } from './signup-admission.js';
import { SignupAdmissionInterceptor } from './signup-admission.interceptor.js';
import { SignupEnabledGuard } from './signup-enabled.guard.js';
import { SignupRateLimitGuard } from './signup-rate-limit.guard.js';
import { SignupRateLimiter } from './signup-rate-limiter.js';
import { SignupService } from './signup.service.js';

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
  const databaseName = `signup_e2e_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(source);
  url.pathname = `/${databaseName}`;
  const admin = createDatabaseClient({ connectionString: source.toString() });
  const database = createDatabaseClient({ connectionString: url.toString() });
  let created = false;
  let app: INestApplication | undefined;
  let baseUrl: string;
  let redisService: RedisService | undefined;
  let redis: Awaited<ReturnType<RedisService['getClient']>>;
  let namespace: string;
  let keys: Set<string>;
  let acquireCount: number;
  let renewFailures: number;
  let releases: { token: string; emails: string[]; openTransactions: number }[];
  const input = { email: 'lease@example.com', password: 'correct horse battery staple' };
  const admissionKey = () => `${namespace}:admission`;

  beforeAll(async () => {
    expect((await admin.pool.query('SELECT current_database() AS name')).rows[0].name).toBe(
      'authcore_test',
    );
    await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    expect((await database.pool.query('SELECT current_database() AS name')).rows[0].name).toBe(
      databaseName,
    );
    const folder = new URL('../../../../packages/db/drizzle/', import.meta.url);
    for (const name of (await readdir(folder)).filter((name) => name.endsWith('.sql')).sort()) {
      await database.pool.query(await readFile(new URL(name, folder), 'utf8'));
    }
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('DATABASE_URL', url.toString());
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
          openTransactions: Number(
            (
              await database.pool.query(`SELECT count(*)::int AS n
            FROM pg_stat_activity WHERE datname = current_database()
            AND pid <> pg_backend_pid() AND xact_start IS NOT NULL`)
            ).rows[0].n,
          ),
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
        SignupRateLimitGuard,
        SignupRateLimiter,
        SignupAdmission,
        SignupAdmissionInterceptor,
        { provide: DatabaseService, useValue: { getClient: () => database } },
        { provide: RedisService, useValue: isolatedRedis },
      ],
    })
    class IsolatedSignupModule {}
    app = await NestFactory.create(IsolatedSignupModule, { logger: false });
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
        await database.pool.end();
      } finally {
        try {
          if (created) await admin.pool.query(`DROP DATABASE "${databaseName}"`);
        } finally {
          await admin.pool.end();
        }
      }
    }
  });

  const send = (email = input.email) =>
    fetch(`${baseUrl}/api/v1/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...input, email }),
    });
  async function unavailable(response: Response) {
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    expect(await response.json()).toEqual({
      error: { code: 'HTTP_503', message: 'Signup temporarily unavailable' },
    });
  }

  it.each(['user', 'credential'])(
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
      } else {
        const original = PasswordCredentialRepository.prototype.create;
        vi.spyOn(PasswordCredentialRepository.prototype, 'create').mockImplementation(
          async function (this: PasswordCredentialRepository, value) {
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
        expect(settled).toBe(false);
        expect(releases).toHaveLength(0);
        expect(
          (
            await database.pool.query(
              "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'",
            )
          ).rows[0].n,
        ).toBe(1);
        finish.open();
        await unavailable(await pending);
        expect(releases).toEqual([{ token, emails: [], openTransactions: 0 }]);
        expect(await redis.zRange(admissionKey(), 0, -1)).toEqual([replacement]);
        expect((await database.pool.query('SELECT * FROM users')).rows).toHaveLength(0);
        expect((await database.pool.query('SELECT * FROM password_credentials')).rows).toHaveLength(
          0,
        );
        expect(Logger.prototype.log).not.toHaveBeenCalled();
        await redis.del(admissionKey());
        const retry = await send();
        expect(retry.status).toBe(202);
        expect(await retry.json()).toEqual({ status: 'accepted' });
        expect((await database.pool.query('SELECT * FROM users')).rows).toHaveLength(1);
        expect((await database.pool.query('SELECT * FROM password_credentials')).rows).toHaveLength(
          1,
        );
        expect(await redis.zCard(admissionKey())).toBe(0);
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
      expect(releases).toHaveLength(4);
      expect(releases.every((release) => release.emails.length === 0)).toBe(true);
      expect(await redis.zCard(admissionKey())).toBe(0);
      expect((await database.pool.query('SELECT * FROM users')).rows).toHaveLength(0);
      expect((await database.pool.query('SELECT * FROM password_credentials')).rows).toHaveLength(
        0,
      );
      // Clear only this test's rate-limit keys to exercise post-failure reuse.
      for (const key of keys) if (key !== admissionKey()) await redis.del(key);
      expect((await send()).status).toBe(202);
      expect(await redis.zCard(admissionKey())).toBe(0);
    } finally {
      finish.open();
      await Promise.all(pending);
    }
  });

  it('sanitizes a real PostgreSQL constraint failure, rolls back, and recovers HTTP admission', async () => {
    const errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    await database.pool.query(
      'ALTER TABLE password_credentials ADD CONSTRAINT e2e_reject CHECK (false)',
    );
    try {
      const response = await send();
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' },
      });
      expect(releases).toHaveLength(1);
      expect(releases[0]!.emails).toEqual([]);
      expect(releases[0]!.openTransactions).toBe(0);
      expect(await redis.zCard(admissionKey())).toBe(0);
      expect((await database.pool.query('SELECT * FROM password_credentials')).rows).toHaveLength(
        0,
      );
      expect(errorLog).toHaveBeenCalledExactlyOnceWith({
        event: 'http.unhandled_exception',
        method: 'POST',
      });
      expect(Logger.prototype.log).not.toHaveBeenCalled();
    } finally {
      await database.pool.query('ALTER TABLE password_credentials DROP CONSTRAINT e2e_reject');
    }
    expect((await send()).status).toBe(202);
    expect(await redis.zCard(admissionKey())).toBe(0);
  });
});
