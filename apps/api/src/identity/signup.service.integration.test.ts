import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import { Logger } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { verifyPassword } from '@authcore/crypto';
import {
  createDatabaseClient,
  PasswordCredentialRepository,
  UserRepository,
  runSignupTransaction,
  setSignupTransactionTimeouts,
} from '@authcore/db';

import type { DatabaseService } from '../database/database.service.js';
import { assertSignupLease, SignupAdmission, SIGNUP_RENEW_MS } from './signup-admission.js';
import type { RedisService } from '../redis/redis.service.js';
import { EmailAlreadyInUseError } from './identity.errors.js';
import { SignupService } from './signup.service.js';

// Explicit opt-in only. Never use DATABASE_URL or application tables for tests.
const connectionString = process.env.TEST_DATABASE_URL;
if (connectionString) {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('TEST_DATABASE_URL must be a valid dedicated local test URL');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    !['', '5432'].includes(url.port) ||
    url.pathname !== '/authcore_test' ||
    url.search ||
    url.hash ||
    connectionString === process.env.DATABASE_URL
  ) {
    throw new Error(
      'TEST_DATABASE_URL must target local port 5432 authcore_test without URL options',
    );
  }
}

describe.skipIf(!connectionString)('SignupService PostgreSQL integration', () => {
  const databaseName = `signup_test_${randomUUID().replaceAll('-', '')}`;
  const testUrl = new URL(connectionString ?? 'postgresql://localhost/postgres');
  testUrl.pathname = `/${databaseName}`;
  const admin = createDatabaseClient({ connectionString: connectionString ?? '' });
  const client = createDatabaseClient({ connectionString: testUrl.toString() });
  const database = { getClient: () => client } as DatabaseService;
  const service = new SignupService(database);
  const credentials = new PasswordCredentialRepository(client.db);
  const users = new UserRepository(client.db);
  const input = { email: ' User@Example.COM ', password: '  correct horse battery staple  ' };
  let databaseCreated = false;

  beforeAll(async () => {
    expect((await admin.pool.query('SELECT current_database() AS name')).rows[0].name).toBe(
      'authcore_test',
    );
    await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;
    expect((await client.pool.query('SELECT current_database() AS name')).rows[0].name).toBe(
      databaseName,
    );
    // Apply the unchanged checked-in SQL, including its public.users foreign key.
    const folder = new URL('../../../../packages/db/drizzle/', import.meta.url);
    const migrations = (await readdir(folder)).filter((name) => name.endsWith('.sql')).sort();
    for (const name of migrations) {
      if (name === '0002_security_audit_events.sql') {
        // Exercise the additive migration against a populated pre-audit schema.
        const legacy = await users.create({
          email: 'historical@example.com',
          emailNormalized: 'historical@example.com',
        });
        const original = await credentials.create({
          userId: legacy.id,
          passwordHash: 'legacy-hash',
        });
        await client.pool.query(await readFile(new URL(name, folder), 'utf8'));
        expect((await client.pool.query('SELECT * FROM security_audit_events')).rows).toHaveLength(
          0,
        );
        expect(await users.findByNormalizedEmail(legacy.emailNormalized)).toEqual(legacy);
        expect(await credentials.findByUserId(legacy.id)).toEqual(original);
        continue;
      }
      await client.pool.query(await readFile(new URL(name, folder), 'utf8'));
    }
  }, 15_000);

  beforeEach(async () => {
    // Explicit cleanup is confined to this suite's disposable UUID database.
    await client.pool.query('DELETE FROM security_audit_events');
    await client.pool.query('DELETE FROM users');
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    try {
      await client.pool.end();
    } finally {
      try {
        if (databaseCreated) await admin.pool.query(`DROP DATABASE "${databaseName}"`);
      } finally {
        await admin.pool.end();
      }
    }
  });

  it.each(['idle', 'lifetime'])(
    'rolls back and replaces a session killed by the %s limit',
    async (limit) => {
      let pid = 0;
      const running = runSignupTransaction(client, async (tx) => {
        await setSignupTransactionTimeouts(tx);
        const settings = await tx.execute(`SELECT pg_backend_pid() AS pid,
        current_setting('transaction_timeout') AS lifetime,
        current_setting('idle_in_transaction_session_timeout') AS idle`);
        pid = Number(settings.rows[0]!.pid);
        expect(settings.rows[0]).toMatchObject({ lifetime: '15s', idle: '3s' });
        const user = await new UserRepository(tx).create({
          email: 'limit@example.com',
          emailNormalized: 'limit@example.com',
        });
        await new PasswordCredentialRepository(tx).create({
          userId: user.id,
          passwordHash: 'test-hash',
        });
        if (limit === 'idle') {
          // pg emits an unsolicited error while application work is paused.
          await new Promise((resolve) => setTimeout(resolve, 3_500));
        } else {
          // Every statement is below 5s and every idle gap below 3s. Only the
          // aggregate transaction lifetime can terminate this sequence.
          for (let n = 0; n < 100; n++) await tx.execute('SELECT pg_sleep(0.2)');
        }
      });
      const failure: unknown = await running.catch((error: unknown) => error);
      // Require the server's exact termination reason, not any incidental failure.
      const expectedCode = limit === 'idle' ? '25P03' : '25P04';
      const codes: unknown[] = [];
      for (let error: unknown = failure; error && typeof error === 'object' && codes.length < 5;) {
        codes.push('code' in error ? error.code : undefined);
        error = 'cause' in error ? error.cause : undefined;
      }
      expect(codes).toContain(expectedCode);
      expect(await users.findByNormalizedEmail('limit@example.com')).toBeNull();
      expect((await client.pool.query('SELECT * FROM password_credentials')).rows).toHaveLength(0);
      expect(
        (await client.pool.query('SELECT pid FROM pg_stat_activity WHERE pid = $1', [pid])).rows,
      ).toHaveLength(0);
      await expect(service.signup(input)).resolves.toHaveProperty('id');
    },
    22_000,
  );

  it.each(['query', 'lease assertion'])(
    'preserves idle expiry SQLSTATE when paused work resumes with a failing %s',
    async (stage) => {
      const schedule = globalThis.setTimeout;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
        callback: (...args: unknown[]) => void,
        ms?: number,
        ...args: unknown[]
      ) => schedule(callback, ms === SIGNUP_RENEW_MS ? 25 : ms, ...args)) as typeof setTimeout);
      const evalCommand = vi.fn().mockResolvedValueOnce(1).mockResolvedValue(0);
      const admission = new SignupAdmission({
        getClient: async () => ({ withCommandOptions: () => ({ eval: evalCommand }) }),
      } as unknown as RedisService);
      let pid = 0;
      const pending = admission.run(() =>
        runSignupTransaction(client, async (tx) => {
          await setSignupTransactionTimeouts(tx);
          pid = Number((await tx.execute('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
          const user = await new UserRepository(tx).create({
            email: 'expired@example.com',
            emailNormalized: 'expired@example.com',
          });
          await new PasswordCredentialRepository(tx).create({
            userId: user.id,
            passwordHash: 'test-hash',
          });
          await new Promise((resolve) => setTimeout(resolve, 3_500));
          if (stage === 'query') await tx.execute('SELECT 1');
          else assertSignupLease();
        }),
      );
      await expect(pending).rejects.toMatchObject({ code: '25P03' });
      expect(await users.findByNormalizedEmail('expired@example.com')).toBeNull();
      expect((await client.pool.query('SELECT * FROM password_credentials')).rows).toHaveLength(0);
      expect(
        (await client.pool.query('SELECT pid FROM pg_stat_activity WHERE pid = $1', [pid])).rows,
      ).toHaveLength(0);
      await expect(service.signup(input)).resolves.toHaveProperty('id');
    },
    10_000,
  );

  it.each(['BEGIN', 'COMMIT', 'ROLLBACK'])(
    'evicts connections after %s failure and preserves the original error',
    async (command) => {
      const pinned = await client.pool.connect();
      const pid = (await pinned.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const original = pinned.query.bind(pinned);
      const failure = new Error(`synthetic ${command} transport failure`);
      const operationFailure = new Error('caller aborted');
      const connect = vi
        .spyOn(client.pool, 'connect')
        .mockImplementation(() => Promise.resolve(pinned));
      const query = vi.spyOn(pinned, 'query');
      // Fault injection at the transport boundary; all other SQL uses real pg.
      query.mockImplementation(((text: string, ...args: unknown[]) => {
        if (text === command) return Promise.reject(failure);
        return Reflect.apply(original, pinned, [text, ...args]);
      }) as typeof pinned.query);
      try {
        await expect(
          runSignupTransaction(client, async (tx) => {
            await setSignupTransactionTimeouts(tx);
            await new UserRepository(tx).create({
              email: 'failure@example.com',
              emailNormalized: 'failure@example.com',
            });
            if (command === 'ROLLBACK') throw operationFailure;
          }),
        ).rejects.toBe(command === 'ROLLBACK' ? operationFailure : failure);
      } finally {
        query.mockRestore();
        connect.mockRestore();
      }
      await expect
        .poll(
          async () =>
            (await client.pool.query('SELECT pid FROM pg_stat_activity WHERE pid = $1', [pid])).rows
              .length,
        )
        .toBe(0);
      expect(await users.findByNormalizedEmail('failure@example.com')).toBeNull();
      await expect(service.signup(input)).resolves.toHaveProperty('id');
    },
  );

  it('rolls back when PostgreSQL rejects COMMIT and recovers a new connection', async () => {
    await client.pool.query(
      'ALTER TABLE password_credentials ALTER CONSTRAINT password_credentials_user_id_users_id_fk DEFERRABLE INITIALLY DEFERRED',
    );
    try {
      await expect(
        runSignupTransaction(client, async (tx) => {
          await setSignupTransactionTimeouts(tx);
          await new UserRepository(tx).create({
            email: 'commit@example.com',
            emailNormalized: 'commit@example.com',
          });
          await tx.execute(
            "INSERT INTO password_credentials (user_id, password_hash) VALUES ('00000000-0000-4000-8000-000000000001', 'test-hash')",
          );
        }),
      ).rejects.toMatchObject({ code: '23503' });
      expect(await users.findByNormalizedEmail('commit@example.com')).toBeNull();
      expect((await client.pool.query('SELECT * FROM password_credentials')).rows).toHaveLength(0);
    } finally {
      await client.pool.query(
        'ALTER TABLE password_credentials ALTER CONSTRAINT password_credentials_user_id_users_id_fk NOT DEFERRABLE',
      );
    }
    await expect(service.signup(input)).resolves.toHaveProperty('id');
  });

  it('cancels a blocked credential insert, rolls back the user, and recovers admission after rollback', async () => {
    const blocker = await client.pool.connect();
    const evalCommand = vi.fn().mockResolvedValue(1);
    const admission = new SignupAdmission({
      getClient: async () => ({ withCommandOptions: () => ({ eval: evalCommand }) }),
    } as unknown as RedisService);
    let running: Promise<unknown> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE password_credentials IN ACCESS EXCLUSIVE MODE');
      running = admission.run(() => service.signup(input));
      const rejected = expect(running).rejects.toMatchObject({ cause: { code: '55P03' } });
      await expect
        .poll(
          async () => {
            const result = await client.pool.query(
              `SELECT count(*)::int AS count FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'
           AND query LIKE 'insert into "password_credentials"%'`,
            );
            return result.rows[0].count;
          },
          { timeout: 5_000, interval: 20 },
        )
        .toBe(1);
      // The Redis release command has not run while PostgreSQL is blocked.
      expect(evalCommand).toHaveBeenCalledTimes(1);
      await rejected;
      expect(evalCommand).toHaveBeenCalledTimes(2);
      expect(await users.findByNormalizedEmail('user@example.com')).toBeNull();
      expect(Logger.prototype.log).not.toHaveBeenCalled();
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await running?.catch(() => undefined);
    }
    expect((await client.pool.query('SELECT * FROM password_credentials')).rows).toHaveLength(0);
    // Same admission instance and email can succeed after actual rollback.
    await expect(admission.run(() => service.signup(input))).resolves.toHaveProperty('id');
    expect(evalCommand).toHaveBeenCalledTimes(4);
  }, 10_000);

  it('cancels slow credential execution on PostgreSQL and rolls back both records', async () => {
    await client.pool.query(`
      CREATE FUNCTION slow_signup_credential() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(10); RETURN NEW; END $$;
      CREATE TRIGGER slow_signup_credential BEFORE INSERT ON password_credentials
      FOR EACH ROW EXECUTE FUNCTION slow_signup_credential();
    `);
    try {
      await expect(service.signup(input)).rejects.toMatchObject({ cause: { code: '57014' } });
      expect(await users.findByNormalizedEmail('user@example.com')).toBeNull();
      expect((await client.pool.query('SELECT * FROM password_credentials')).rows).toHaveLength(0);
      expect(Logger.prototype.log).not.toHaveBeenCalled();
    } finally {
      await client.pool.query('DROP TRIGGER slow_signup_credential ON password_credentials');
      await client.pool.query('DROP FUNCTION slow_signup_credential()');
    }
    await expect(service.signup(input)).resolves.toHaveProperty('id');
  }, 10_000);

  it('restores connection timeout settings after successful and failed signup transactions', async () => {
    // A real, single-connection pool proves healthy reuse without returning an
    // evicted client from a connect mock. It only accesses this suite's UUID DB.
    const owned = createDatabaseClient({ connectionString: testUrl.toString() });
    owned.pool.options.max = 1;
    const isolatedService = new SignupService({ getClient: () => owned } as DatabaseService);
    let borrowed: { release: (destroy?: boolean) => void } | undefined;
    const settingsSql = `SELECT current_setting('statement_timeout') AS statement,
      current_setting('lock_timeout') AS lock,
      current_setting('transaction_timeout') AS lifetime,
      current_setting('idle_in_transaction_session_timeout') AS idle`;
    try {
      const pinned = await owned.pool.connect();
      borrowed = pinned;
      const baseline = (await pinned.query(settingsSql)).rows;
      pinned.release();
      borrowed = undefined;

      await isolatedService.signup(input);
      const reused = await owned.pool.connect();
      borrowed = reused;
      expect(reused).toBe(pinned);
      expect((await reused.query(settingsSql)).rows).toEqual(baseline);
      reused.release();
      borrowed = undefined;

      // Observe transaction-local settings AFTER acknowledged rollback, BEFORE
      // end closes this session. Querying it after failed signup is invalid.
      let rollbackSettings: unknown;
      const originalQuery = pinned.query.bind(pinned);
      const query = vi.spyOn(pinned, 'query').mockImplementation(((
        text: unknown,
        ...args: unknown[]
      ) => {
        const result: unknown = Reflect.apply(originalQuery, pinned, [text, ...args]);
        if (text !== 'ROLLBACK') return result;
        return (result as Promise<unknown>).then(async (reply) => {
          rollbackSettings = (await originalQuery(settingsSql)).rows;
          return reply;
        });
      }) as typeof pinned.query);
      const releases: unknown[] = [];
      owned.pool.on('release', (error) => releases.push(error));
      const removed = vi.fn();
      owned.pool.on('remove', removed);
      try {
        await expect(isolatedService.signup(input)).rejects.toBeInstanceOf(EmailAlreadyInUseError);
      } finally {
        query.mockRestore();
      }
      expect(rollbackSettings).toEqual(baseline);
      expect(releases).toEqual([true]);
      expect(removed).toHaveBeenCalledExactlyOnceWith(pinned);
      await expect(pinned.query('SELECT 1')).rejects.toThrow(/closed|not queryable/i);

      const replacement = await owned.pool.connect();
      borrowed = replacement;
      expect(replacement).not.toBe(pinned);
      expect((await replacement.query(settingsSql)).rows).toEqual(baseline);
      replacement.release();
      borrowed = undefined;
      await expect(
        isolatedService.signup({ ...input, email: 'recovered@example.com' }),
      ).resolves.toHaveProperty('id');
    } finally {
      borrowed?.release(true);
      await owned.pool.end();
    }
  });

  it('commits a normalized user, verifiable credential and exactly one safe audit event', async () => {
    const user = await service.signup(input);
    expect(user).toMatchObject({ email: 'User@Example.COM', emailNormalized: 'user@example.com' });
    expect(await users.findByNormalizedEmail('user@example.com')).toEqual(user);
    const credential = await credentials.findByUserId(user.id);
    expect(credential?.passwordHash).toMatch(/^\$argon2id\$/);
    await expect(verifyPassword(credential!.passwordHash, input.password)).resolves.toBe(true);
    await expect(verifyPassword(credential!.passwordHash, input.password.trim())).resolves.toBe(
      false,
    );
    expect(user).not.toHaveProperty('passwordHash');
    const stored = await client.pool.query(
      'SELECT row_to_json(u) AS user, row_to_json(c) AS credential FROM users u JOIN password_credentials c ON c.user_id = u.id',
    );
    expect(JSON.stringify(stored.rows)).not.toContain(input.password);
    const events = (await client.pool.query('SELECT * FROM security_audit_events')).rows;
    expect(events).toEqual([
      {
        id: expect.any(String),
        event_type: 'identity.user_created',
        user_id: user.id,
        occurred_at: expect.any(Date),
        payload: {},
      },
    ]);
    const serialized = JSON.stringify(events);
    for (const sensitive of [
      input.password,
      credential!.passwordHash,
      input.email,
      'password',
      'idempotency',
    ]) {
      expect(serialized).not.toContain(sensitive);
    }
    expect(Logger.prototype.log).toHaveBeenCalledExactlyOnceWith({
      event: 'identity.user_created',
      userId: user.id,
    });
  });

  it('maps a duplicate normalized email and preserves the original credential', async () => {
    const user = await service.signup(input);
    const original = await credentials.findByUserId(user.id);
    await expect(
      service.signup({ email: 'USER@example.com', password: 'different password' }),
    ).rejects.toBeInstanceOf(EmailAlreadyInUseError);
    expect(await credentials.findByUserId(user.id)).toEqual(original);
    expect((await client.pool.query('SELECT * FROM users')).rows).toHaveLength(1);
    expect((await client.pool.query('SELECT * FROM password_credentials')).rows).toHaveLength(1);
    expect((await client.pool.query('SELECT * FROM security_audit_events')).rows).toHaveLength(1);
    expect(Logger.prototype.log).toHaveBeenCalledOnce();
  });

  it('allows exactly one concurrent signup for the same normalized email', async () => {
    const results = await Promise.allSettled([
      service.signup(input),
      service.signup({ email: 'USER@example.com', password: 'other password' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failures = results.filter((result) => result.status === 'rejected');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toBeInstanceOf(EmailAlreadyInUseError);
    expect((await client.pool.query('SELECT * FROM users')).rows).toHaveLength(1);
    expect((await client.pool.query('SELECT * FROM password_credentials')).rows).toHaveLength(1);
    const [winner] = results.filter((result) => result.status === 'fulfilled');
    const user = winner!.value;
    const credential = await credentials.findByUserId(user.id);
    const winningPassword = results[0]?.status === 'fulfilled' ? input.password : 'other password';
    await expect(verifyPassword(credential!.passwordHash, winningPassword)).resolves.toBe(true);
    expect((await client.pool.query('SELECT * FROM security_audit_events')).rows).toEqual([
      expect.objectContaining({
        user_id: user.id,
        event_type: 'identity.user_created',
        payload: {},
      }),
    ]);
  });

  it('rolls back the user when PostgreSQL rejects its credential insert', async () => {
    await client.pool.query(
      'ALTER TABLE password_credentials ADD CONSTRAINT reject_test_credential CHECK (false)',
    );
    try {
      await expect(service.signup(input)).rejects.toMatchObject({ cause: { code: '23514' } });
      expect(await users.findByNormalizedEmail('user@example.com')).toBeNull();
      expect((await client.pool.query('SELECT * FROM password_credentials')).rows).toHaveLength(0);
      expect((await client.pool.query('SELECT * FROM security_audit_events')).rows).toHaveLength(0);
      expect(Logger.prototype.log).not.toHaveBeenCalled();
    } finally {
      await client.pool.query(
        'ALTER TABLE password_credentials DROP CONSTRAINT reject_test_credential',
      );
    }
    // A failed signup must not poison later transactions or claim the email.
    await expect(service.signup(input)).resolves.toHaveProperty('id');
  });

  it('rolls back the user and credential when PostgreSQL rejects the mandatory audit insert', async () => {
    await client.pool.query(
      'ALTER TABLE security_audit_events ADD CONSTRAINT reject_test_audit CHECK (false)',
    );
    try {
      await expect(service.signup(input)).rejects.toMatchObject({ cause: { code: '23514' } });
      for (const table of ['users', 'password_credentials', 'security_audit_events']) {
        expect((await client.pool.query(`SELECT * FROM ${table}`)).rows).toHaveLength(0);
      }
      expect(Logger.prototype.log).not.toHaveBeenCalled();
    } finally {
      await client.pool.query(
        'ALTER TABLE security_audit_events DROP CONSTRAINT reject_test_audit',
      );
    }
    await expect(service.signup(input)).resolves.toHaveProperty('id');
    expect((await client.pool.query('SELECT * FROM security_audit_events')).rows).toHaveLength(1);
  });

  it('does not invent an event or replace credentials for a legacy account on duplicate signup', async () => {
    const user = await users.create({
      email: 'User@Example.COM',
      emailNormalized: 'user@example.com',
    });
    const original = await credentials.create({ userId: user.id, passwordHash: 'legacy-hash' });
    await expect(service.signup(input)).rejects.toBeInstanceOf(EmailAlreadyInUseError);
    expect(await credentials.findByUserId(user.id)).toEqual(original);
    expect((await client.pool.query('SELECT * FROM security_audit_events')).rows).toHaveLength(0);
    expect(Logger.prototype.log).not.toHaveBeenCalled();
  });
});
