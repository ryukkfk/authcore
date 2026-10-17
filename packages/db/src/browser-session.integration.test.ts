import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSessionCredential, sessionCredentialDigest, hashPassword } from '@authcore/crypto';
import { BrowserSessionRepository } from './repositories/browser-session.repository.js';

const source = process.env.TEST_DATABASE_URL;
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
    throw new Error('Session tests require the dedicated disposable test database');
}
describe.skipIf(!source)('Browser session real PostgreSQL security boundaries', () => {
  const name = 'sessions_' + randomUUID().replaceAll('-', ''),
    role = 'authcore_auth_runtime_' + randomUUID().replaceAll('-', '');
  const target = new URL(source ?? 'postgresql://127.0.0.1:55433/authcore_test');
  target.pathname = '/' + name;
  const runtimeUrl = new URL(target);
  runtimeUrl.hostname = '127.0.0.1';
  runtimeUrl.username = role;
  runtimeUrl.password = randomUUID();
  const admin = new Pool({ connectionString: source }),
    owner = new Pool({ connectionString: target.toString() }),
    runtime = new Pool({ connectionString: runtimeUrl.toString() });
  const repository = new BrowserSessionRepository(runtime);
  let created = false,
    roleCreated = false,
    userId: string,
    passwordHash: string;
  beforeAll(async () => {
    await admin.query('CREATE DATABASE "' + name + '"');
    created = true;
    const folder = new URL('../drizzle/', import.meta.url);
    for (const file of (await readdir(folder)).filter((file) => file.endsWith('.sql')).sort())
      await owner.query(await readFile(new URL(file, folder), 'utf8'));
    await owner.query('REVOKE TEMPORARY ON DATABASE "' + name + '" FROM PUBLIC');
    const statement = (
      await admin.query(
        "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',$1::text,$2::text) AS sql",
        [role, runtimeUrl.password],
      )
    ).rows[0].sql;
    await admin.query(statement);
    roleCreated = true;
    const connection = await owner.connect();
    try {
      await connection.query('BEGIN');
      await connection.query("SELECT set_config('authcore.auth_role',$1,true)", [role]);
      await connection.query(
        await readFile(new URL('../permissions/auth-runtime-role.sql', import.meta.url), 'utf8'),
      );
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
    passwordHash = await hashPassword('Public isolated session fixture password');
  }, 15000);
  beforeEach(async () => {
    await owner.query('DELETE FROM authentication_events');
    await owner.query('DELETE FROM browser_sessions');
    await owner.query('DELETE FROM users');
    userId = (
      await owner.query(
        "INSERT INTO users(email,email_normalized,email_verified_at) VALUES('session@example.invalid','session@example.invalid',clock_timestamp()) RETURNING id",
      )
    ).rows[0].id;
    await owner.query('INSERT INTO password_credentials(user_id,password_hash) VALUES($1,$2)', [
      userId,
      passwordHash,
    ]);
  });
  afterAll(async () => {
    await runtime.end();
    await owner.end();
    try {
      if (created) await admin.query('DROP DATABASE "' + name + '"');
      if (roleCreated) await admin.query('DROP ROLE "' + role + '"');
    } finally {
      await admin.end();
    }
  });
  async function login(previous?: string) {
    const credential = createSessionCredential(),
      snapshot = await repository.credentials('session@example.invalid');
    const account = await repository.completeLogin(
      snapshot,
      true,
      credential,
      previous,
      'Other',
      randomUUID(),
    );
    if (!account) throw new Error('Expected synthetic login proof admission');
    return { credential, account };
  }
  it('stores only a credential digest and serializes a verified account and safe device metadata', async () => {
    const session = await login();
    const rows = (await owner.query('SELECT * FROM browser_sessions')).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].token_digest).toBe(sessionCredentialDigest(session.credential));
    expect(JSON.stringify(rows).includes(session.credential)).toBe(false);
    expect(await repository.resolve(session.credential)).toEqual(session.account);
    const devices = await repository.list(session.credential);
    expect(devices).toHaveLength(1);
    expect(devices![0]!.current).toBe(true);
    expect(JSON.stringify(devices).includes('digest')).toBe(false);
    expect((await owner.query('SELECT event_type FROM authentication_events')).rows).toEqual([
      { event_type: 'auth.login_succeeded' },
    ]);
  });
  it('denies invalid proof and unknown account using auditable generic outcomes', async () => {
    const snapshot = await repository.credentials('session@example.invalid');
    expect(
      await repository.completeLogin(
        snapshot,
        false,
        createSessionCredential(),
        undefined,
        'Other',
        randomUUID(),
      ),
    ).toBeNull();
    expect(await repository.credentials('unknown@example.invalid')).toBeNull();
    expect(
      await repository.completeLogin(
        null,
        false,
        createSessionCredential(),
        undefined,
        'Other',
        randomUUID(),
      ),
    ).toBeNull();
    expect((await owner.query('SELECT id FROM browser_sessions')).rows).toHaveLength(0);
    expect((await owner.query('SELECT event_type FROM authentication_events')).rows).toEqual([
      { event_type: 'auth.login_failed' },
      { event_type: 'auth.login_failed' },
    ]);
  });
  it('rejects unverified and disabled accounts despite valid password proof', async () => {
    const snapshot = await repository.credentials('session@example.invalid');
    await owner.query('UPDATE users SET email_verified_at=NULL');
    expect(
      await repository.completeLogin(
        snapshot,
        true,
        createSessionCredential(),
        undefined,
        'Other',
        randomUUID(),
      ),
    ).toBeNull();
    await owner.query(
      'UPDATE users SET email_verified_at=clock_timestamp(),disabled_at=clock_timestamp()',
    );
    expect(
      await repository.completeLogin(
        snapshot,
        true,
        createSessionCredential(),
        undefined,
        'Other',
        randomUUID(),
      ),
    ).toBeNull();
    expect((await owner.query('SELECT id FROM browser_sessions')).rows).toHaveLength(0);
  });
  it('refuses a stale password snapshot after a concurrent credential replacement', async () => {
    const snapshot = await repository.credentials('session@example.invalid');
    await owner.query('UPDATE password_credentials SET password_hash=$1', [
      await hashPassword('Different public isolated fixture password'),
    ]);
    expect(
      await repository.completeLogin(
        snapshot,
        true,
        createSessionCredential(),
        undefined,
        'Other',
        randomUUID(),
      ),
    ).toBeNull();
  });
  it('rejects expired, idle and newly disabled sessions using database state', async () => {
    const first = await login();
    await owner.query(
      "UPDATE browser_sessions SET created_at=clock_timestamp()-interval '1 day',expires_at=clock_timestamp()-interval '1 minute'",
    );
    expect(await repository.resolve(first.credential)).toBeNull();
    const second = await login();
    await owner.query(
      "UPDATE browser_sessions SET last_seen_at=clock_timestamp()-interval '31 minutes' WHERE id=$1",
      [second.account.sessionId],
    );
    expect(await repository.resolve(second.credential)).toBeNull();
    const third = await login();
    await owner.query('UPDATE users SET disabled_at=clock_timestamp()');
    expect(await repository.resolve(third.credential)).toBeNull();
  });
  it('rotates credentials on login and prevents replay of a logged-out session', async () => {
    const first = await login(),
      second = await login(first.credential);
    expect(first.credential !== second.credential).toBe(true);
    expect(await repository.resolve(first.credential)).toBeNull();
    expect(
      (await repository.revoke(second.credential, randomUUID(), 'current')).currentRevoked,
    ).toBe(true);
    expect(await repository.resolve(second.credential)).toBeNull();
    const events = (await owner.query('SELECT event_type FROM authentication_events')).rows.map(
      (row) => row.event_type,
    );
    expect(events.filter((value) => value === 'auth.session_rotated')).toHaveLength(1);
    expect(events.filter((value) => value === 'auth.logout')).toHaveLength(1);
  });
  it('scopes device revocation to the authenticated account', async () => {
    const current = await login();
    const otherId = (
      await owner.query(
        "INSERT INTO users(email,email_normalized,email_verified_at) VALUES('other@example.invalid','other@example.invalid',clock_timestamp()) RETURNING id",
      )
    ).rows[0].id;
    await owner.query('INSERT INTO password_credentials(user_id,password_hash) VALUES($1,$2)', [
      otherId,
      passwordHash,
    ]);
    const otherCredential = createSessionCredential(),
      other = await repository.completeLogin(
        await repository.credentials('other@example.invalid'),
        true,
        otherCredential,
        undefined,
        'Firefox',
        randomUUID(),
      );
    expect(
      (await repository.revoke(current.credential, randomUUID(), { id: other!.sessionId }))
        .authorized,
    ).toBe(false);
    expect(await repository.resolve(otherCredential)).not.toBeNull();
  });
  it('revokes other sessions and all sessions atomically with audit', async () => {
    const first = await login(),
      second = await login();
    expect((await repository.revoke(second.credential, randomUUID(), 'others')).authorized).toBe(
      true,
    );
    expect(await repository.resolve(first.credential)).toBeNull();
    expect(await repository.resolve(second.credential)).not.toBeNull();
    await repository.revoke(second.credential, randomUUID(), 'all');
    expect(await repository.resolve(second.credential)).toBeNull();
  });
  it('serializes concurrent logins and retains at most ten active credentials', async () => {
    await Promise.all(Array.from({ length: 14 }, () => login()));
    expect(
      Number(
        (await owner.query('SELECT count(*) AS n FROM browser_sessions WHERE revoked_at IS NULL'))
          .rows[0].n,
      ),
    ).toBe(10);
    expect(
      (
        await owner.query(
          "SELECT id FROM authentication_events WHERE event_type='auth.login_succeeded'",
        )
      ).rows,
    ).toHaveLength(14);
  }, 15000);
  it('rechecks revocation after a waiting account lock before mutating another device', async () => {
    const first = await login(),
      second = await login();
    const blocker = await owner.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
      const pending = repository.revoke(first.credential, randomUUID(), 'others');
      await expect
        .poll(
          async () =>
            Number(
              (
                await owner.query(
                  'SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND usename=$1 AND cardinality(pg_blocking_pids(pid))>0',
                  [role],
                )
              ).rows[0].n,
            ),
          { timeout: 900 },
        )
        .toBe(1);
      await blocker.query('UPDATE browser_sessions SET revoked_at=clock_timestamp() WHERE id=$1', [
        first.account.sessionId,
      ]);
      await blocker.query('COMMIT');
      expect((await pending).authorized).toBe(false);
      expect(await repository.resolve(second.credential)).not.toBeNull();
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });
  it('rolls back a new session if its mandatory audit write fails', async () => {
    await owner.query('ALTER TABLE authentication_events ADD CONSTRAINT test_reject CHECK(false)');
    try {
      await expect(login()).rejects.toThrow();
    } finally {
      await owner.query('ALTER TABLE authentication_events DROP CONSTRAINT test_reject');
    }
    expect((await owner.query('SELECT id FROM browser_sessions')).rows).toHaveLength(0);
  });
  it('does not mint credentials after cancellation and denies account/audit privilege escalation', async () => {
    const signal = new AbortController();
    signal.abort();
    expect(
      await repository.completeLogin(
        await repository.credentials('session@example.invalid'),
        true,
        createSessionCredential(),
        undefined,
        'Other',
        randomUUID(),
        signal.signal,
      ),
    ).toBeNull();
    for (const statement of [
      "INSERT INTO users(email,email_normalized) VALUES('forbidden@example.invalid','forbidden@example.invalid')",
      'UPDATE users SET email_verified_at=clock_timestamp()',
      'UPDATE password_credentials SET password_hash=password_hash',
      'DELETE FROM browser_sessions',
      'DELETE FROM authentication_events',
      'SELECT envelope FROM email_deliveries',
    ])
      await expect(runtime.query(statement)).rejects.toMatchObject({ code: '42501' });
  });
});
