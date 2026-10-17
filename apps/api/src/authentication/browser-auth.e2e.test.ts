import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createClient } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabaseClient } from '@authcore/db';
import { hashPassword, sessionCredentialDigest } from '@authcore/crypto';
import { BrowserAuthModule } from './browser-auth.module.js';
import { configureBrowserAuthHttp } from './browser-http.js';
import { configureSignupHttp, SignupHttpAdapter } from '../identity/signup-http.js';
import { GlobalExceptionFilter } from '../common/filters/global-exception.filter.js';

const source = process.env.TEST_DATABASE_URL,
  redisSource = process.env.TEST_REDIS_URL;
if (source) {
  const url = new URL(source);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    !['5432', '55433'].includes(url.port) ||
    url.pathname !== '/authcore_test' ||
    url.search ||
    url.hash ||
    source === process.env.DATABASE_URL
  )
    throw new Error('Authentication HTTP tests require the disposable test cluster');
}
if (redisSource) {
  const url = new URL(redisSource);
  if (
    url.protocol !== 'redis:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    !['6380', '56380'].includes(url.port) ||
    !['', '/'].includes(url.pathname) ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error('Authentication HTTP tests require the isolated test Redis');
}
describe.skipIf(!source || !redisSource)(
  'Browser authentication real PostgreSQL Redis Argon2 HTTP',
  () => {
    const name = 'auth_http_' + randomUUID().replaceAll('-', '');
    const role = 'authcore_auth_runtime_' + randomUUID().replaceAll('-', '');
    const target = new URL(source ?? 'postgresql://127.0.0.1:55433/authcore_test');
    target.pathname = '/' + name;
    const authUrl = new URL(target);
    authUrl.username = role;
    authUrl.password = randomBytes(32).toString('hex');
    const admin = createDatabaseClient({ connectionString: source ?? target.toString() }).pool;
    const owner = createDatabaseClient({ connectionString: target.toString() }).pool;
    const redisUrl = new URL(redisSource ?? 'redis://127.0.0.1:56380');
    // Dedicated empty logical database. Never flush or clear another suite's data.
    redisUrl.pathname = '/13';
    const redis = createClient({ url: redisUrl.toString(), socket: { reconnectStrategy: false } });
    const headers = {
      'content-type': 'application/json',
      origin: 'http://127.0.0.1:3000',
      'x-authcore-request': 'browser',
    };
    const email = 'browser@example.invalid',
      password = '  Public isolated HTTP fixture password  ';
    let created = false,
      roleCreated = false,
      redisOwned = false;
    let app: INestApplication | undefined, base: string, passwordHash: string, userId: string;
    const post = (
      path: string,
      body: unknown = {},
      cookie?: string,
      extra: Record<string, string> = {},
    ) =>
      fetch(base + path, {
        method: 'POST',
        headers: { ...headers, ...(cookie ? { cookie } : {}), ...extra },
        body: JSON.stringify(body),
      });
    const get = (path: string, cookie?: string) =>
      fetch(base + path, { headers: cookie ? { cookie } : {} });
    async function login(cookie?: string, identity = email) {
      const reply = await post('login', { email: identity, password }, cookie);
      expect(reply.status).toBe(200);
      const value = reply.headers.get('set-cookie')?.split(';')[0];
      if (!value) throw new Error('Expected session cookie');
      return value;
    }
    async function clearRates() {
      const keys = await redis.keys('*');
      if (keys.some((key) => !key.startsWith('authcore:{browser-auth}:')))
        throw new Error('Refusing to clear non-owned Redis keys');
      if (keys.length) await redis.del(keys);
    }
    beforeAll(async () => {
      await redis.connect();
      if ((await redis.dbSize()) !== 0)
        throw new Error('Authentication fixture requires empty Redis DB13');
      redisOwned = true;
      await admin.query('CREATE DATABASE "' + name + '"');
      created = true;
      const folder = new URL('../../../../packages/db/drizzle/', import.meta.url);
      for (const file of (await readdir(folder)).filter((file) => file.endsWith('.sql')).sort())
        await owner.query(await readFile(new URL(file, folder), 'utf8'));
      await owner.query('REVOKE TEMPORARY ON DATABASE "' + name + '" FROM PUBLIC');
      const statement = (
        await admin.query(
          "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',$1::text,$2::text) AS sql",
          [role, authUrl.password],
        )
      ).rows[0].sql;
      await admin.query(statement);
      roleCreated = true;
      const connection = await owner.connect();
      try {
        await connection.query('BEGIN');
        await connection.query("SELECT set_config('authcore.auth_role',$1,true)", [role]);
        await connection.query(
          await readFile(
            new URL('../../../../packages/db/permissions/auth-runtime-role.sql', import.meta.url),
            'utf8',
          ),
        );
        await connection.query('COMMIT');
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
      passwordHash = await hashPassword(password);
      vi.stubEnv('NODE_ENV', 'test');
      vi.stubEnv('DATABASE_URL', target.toString());
      vi.stubEnv('AUTH_DATABASE_URL', authUrl.toString());
      vi.stubEnv('AUTH_RATE_HMAC_KEY', randomBytes(32).toString('hex'));
      vi.stubEnv('REDIS_URL', redisUrl.toString());
      vi.stubEnv('WEB_ORIGIN', headers.origin);
      vi.stubEnv('SIGNUP_ENABLED', 'false');
      app = await NestFactory.create(BrowserAuthModule, new SignupHttpAdapter(), {
        logger: false,
        bodyParser: false,
      });
      configureSignupHttp(app);
      configureBrowserAuthHttp(app);
      app.setGlobalPrefix('api/v1');
      app.useGlobalFilters(new GlobalExceptionFilter());
      await app.listen(0, '127.0.0.1');
      base =
        'http://127.0.0.1:' + (app.getHttpServer().address() as AddressInfo).port + '/api/v1/auth/';
    }, 30000);
    beforeEach(async () => {
      await clearRates();
      await owner.query('DELETE FROM authentication_events');
      await owner.query('DELETE FROM browser_sessions');
      await owner.query('DELETE FROM users');
      userId = (
        await owner.query(
          'INSERT INTO users(email,email_normalized,email_verified_at) VALUES($1,$1,clock_timestamp()) RETURNING id',
          [email],
        )
      ).rows[0].id;
      await owner.query('INSERT INTO password_credentials(user_id,password_hash) VALUES($1,$2)', [
        userId,
        passwordHash,
      ]);
    });
    afterAll(async () => {
      try {
        await app?.close();
        if (redisOwned) await clearRates();
      } finally {
        if (redis.isOpen) await redis.close();
        await owner.end();
        try {
          if (created) await admin.query('DROP DATABASE "' + name + '"');
          if (roleCreated) await admin.query('DROP ROLE "' + role + '"');
        } finally {
          await admin.end();
          vi.unstubAllEnvs();
        }
      }
    }, 20000);
    it('authenticates native password proof, resolves profile, and invalidates logout replay', async () => {
      const cookie = await login();
      const credential = cookie.slice(cookie.indexOf('=') + 1);
      const stored = (await owner.query('SELECT token_digest FROM browser_sessions')).rows;
      expect(stored).toHaveLength(1);
      expect(stored[0].token_digest === sessionCredentialDigest(credential)).toBe(true);
      expect(JSON.stringify(stored).includes(credential)).toBe(false);
      const profile = await get('me', cookie);
      expect(profile.status).toBe(200);
      expect(await profile.json()).toEqual({
        user: { id: userId, email, emailVerified: true, createdAt: expect.any(String) },
      });
      const devices = await get('sessions', cookie);
      expect(devices.status).toBe(200);
      const listing = await devices.json();
      expect(listing.sessions).toHaveLength(1);
      expect(listing.sessions[0].current).toBe(true);
      expect(JSON.stringify(listing).includes(credential)).toBe(false);
      expect(JSON.stringify(listing).includes('digest')).toBe(false);
      expect((await post('logout', {}, cookie)).status).toBe(204);
      expect((await get('me', cookie)).status).toBe(401);
      expect(
        (await owner.query('SELECT event_type FROM authentication_events ORDER BY occurred_at'))
          .rows,
      ).toEqual([{ event_type: 'auth.login_succeeded' }, { event_type: 'auth.logout' }]);
    });
    it('uses one generic failure for wrong, unknown, unverified and disabled accounts', async () => {
      const attempts = [
        { email, password: 'Wrong public fixture password' },
        { email: 'missing@example.invalid', password },
        { email, password },
        { email, password },
      ];
      for (let index = 0; index < attempts.length; index++) {
        if (index === 2) await owner.query('UPDATE users SET email_verified_at=NULL');
        if (index === 3)
          await owner.query(
            'UPDATE users SET email_verified_at=clock_timestamp(),disabled_at=clock_timestamp()',
          );
        const reply = await post('login', attempts[index]);
        expect(reply.status).toBe(401);
        expect(await reply.json()).toEqual({
          error: { code: 'HTTP_401', message: 'Invalid credentials' },
        });
        expect(reply.headers.has('set-cookie')).toBe(false);
      }
      expect((await owner.query('SELECT id FROM browser_sessions')).rows).toHaveLength(0);
      expect(
        (
          await owner.query(
            "SELECT id FROM authentication_events WHERE event_type='auth.login_failed'",
          )
        ).rows,
      ).toHaveLength(4);
    });
    it('rotates existing credentials and enforces revoke-other and revoke-all operations', async () => {
      const first = await login();
      const second = await login(first);
      expect(first === second).toBe(false);
      expect((await get('me', first)).status).toBe(401);
      const third = await login();
      expect((await post('logout-others', {}, third)).status).toBe(204);
      expect((await get('me', second)).status).toBe(401);
      expect((await get('me', third)).status).toBe(200);
      expect((await post('logout-all', {}, third)).status).toBe(204);
      expect((await get('me', third)).status).toBe(401);
    });
    it('cannot revoke another account using a forged device identifier', async () => {
      const attacker = await login();
      const victimId = (
        await owner.query(
          "INSERT INTO users(email,email_normalized,email_verified_at) VALUES('victim@example.invalid','victim@example.invalid',clock_timestamp()) RETURNING id",
        )
      ).rows[0].id;
      await owner.query('INSERT INTO password_credentials(user_id,password_hash) VALUES($1,$2)', [
        victimId,
        passwordHash,
      ]);
      const victim = await login(undefined, 'victim@example.invalid');
      const sessionId = (
        await owner.query('SELECT id FROM browser_sessions WHERE user_id=$1', [victimId])
      ).rows[0].id;
      expect((await post('sessions/revoke', { sessionId }, attacker)).status).toBe(401);
      expect((await get('me', victim)).status).toBe(200);
      expect((await post('sessions/revoke', { sessionId }, victim)).status).toBe(204);
      expect((await get('me', victim)).status).toBe(401);
    });
    it('enforces Redis account limits before further native work and audit mutations', async () => {
      for (let i = 0; i < 5; i++)
        expect(
          (await post('login', { email, password: 'Wrong public fixture password' })).status,
        ).toBe(401);
      expect((await post('login', { email, password })).status).toBe(429);
      expect((await owner.query('SELECT id FROM authentication_events')).rows).toHaveLength(5);
      expect((await owner.query('SELECT id FROM browser_sessions')).rows).toHaveLength(0);
    });
    it('enforces database idle expiry, absolute expiry and disabled-account policy', async () => {
      const idle = await login();
      await owner.query(
        "UPDATE browser_sessions SET last_seen_at=clock_timestamp()-interval '31 minutes'",
      );
      expect((await get('me', idle)).status).toBe(401);
      const expired = await login();
      await owner.query(
        "UPDATE browser_sessions SET created_at=clock_timestamp()-interval '1 day',expires_at=clock_timestamp()-interval '1 minute'",
      );
      expect((await get('me', expired)).status).toBe(401);
      const disabled = await login();
      await owner.query('UPDATE users SET disabled_at=clock_timestamp()');
      expect((await get('me', disabled)).status).toBe(401);
    });
    it('rejects missing or forged CSRF proof without consuming the real session', async () => {
      const cookie = await login();
      expect((await post('logout', {}, cookie, { origin: 'https://example.invalid' })).status).toBe(
        403,
      );
      expect(
        (
          await fetch(base + 'logout', {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie },
            body: '{}',
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(base + 'logout', {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: headers.origin, cookie },
            body: '{}',
          })
        ).status,
      ).toBe(403);
      expect((await get('me', cookie)).status).toBe(200);
      expect((await owner.query('SELECT id FROM authentication_events')).rows).toHaveLength(1);
    });
  },
);
