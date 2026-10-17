import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword, recoveryPasswordBinding, recoveryEmailBinding } from '@authcore/crypto';
import { PasswordRecoveryRepository } from './repositories/password-recovery.repository.js';

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
    throw new Error('Recovery tests require the explicitly disposable local test cluster');
}
describe.skipIf(!source)('Password recovery real PostgreSQL boundary', () => {
  const name = 'recovery_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: source, connectionTimeoutMillis: 5000 });
  const target = new URL(source ?? 'postgresql://127.0.0.1:55433/authcore_test');
  target.pathname = '/' + name;
  const owner = new Pool({ connectionString: target.toString(), connectionTimeoutMillis: 5000 });
  const role = 'authcore_recovery_requester_' + randomUUID().replaceAll('-', '');
  const requesterUrl = new URL(target);
  requesterUrl.username = role;
  requesterUrl.password = randomUUID();
  const requester = new Pool({
    connectionString: requesterUrl.toString(),
    connectionTimeoutMillis: 5000,
  });
  const recovery = new PasswordRecoveryRepository(requester);
  let created = false,
    roleCreated = false,
    userId: string,
    passwordHash: string;
  async function provision() {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('authcore.recovery_role',$1,true)", [role]);
      await client.query(
        await readFile(
          new URL('../permissions/recovery-requester-role.sql', import.meta.url),
          'utf8',
        ),
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
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
        [role, requesterUrl.password],
      )
    ).rows[0].sql;
    await admin.query(statement);
    roleCreated = true;
    await provision();
    passwordHash = await hashPassword('Public disposable recovery fixture password');
  });
  beforeEach(async () => {
    for (const table of [
      'password_recovery_audit',
      'password_recovery_attempts',
      'password_recovery_tokens',
      'password_recovery_deliveries',
      'password_recovery_requests',
      'users',
    ])
      await owner.query('DELETE FROM ' + table);
    userId = (
      await owner.query(
        "INSERT INTO users(email,email_normalized,email_verified_at) VALUES('fixture@example.invalid','fixture@example.invalid',clock_timestamp()) RETURNING id",
      )
    ).rows[0].id;
    await owner.query('INSERT INTO password_credentials(user_id,password_hash) VALUES($1,$2)', [
      userId,
      passwordHash,
    ]);
  });
  afterAll(async () => {
    await requester.end();
    await owner.end();
    try {
      if (created) await admin.query('DROP DATABASE "' + name + '"');
      if (roleCreated) await admin.query('DROP ROLE "' + role + '"');
    } finally {
      await admin.end();
    }
  });
  it('migrates the durable recovery request boundary', async () => {
    expect(
      (await owner.query("SELECT to_regclass('public.password_recovery_requests') AS relation"))
        .rows[0].relation,
    ).not.toBeNull();
  });
  it('queues one correlated credential-bound request and pending delivery across concurrent calls', async () => {
    await Promise.all(
      Array.from({ length: 6 }, () => recovery.request('fixture@example.invalid', randomUUID())),
    );
    const rows = (await owner.query('SELECT * FROM password_recovery_requests')).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].credential_binding === recoveryPasswordBinding(passwordHash)).toBe(true);
    expect(rows[0].email_binding === recoveryEmailBinding('fixture@example.invalid')).toBe(true);
    expect(rows[0].request_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(JSON.stringify(rows).includes(passwordHash)).toBe(false);
    expect(JSON.stringify(rows).includes('fixture@example.invalid')).toBe(false);
    expect(
      (await owner.query('SELECT status,attempts,envelope,owner FROM password_recovery_deliveries'))
        .rows,
    ).toEqual([{ status: 'pending', attempts: 0, envelope: null, owner: null }]);
    expect((await owner.query('SELECT id FROM users')).rows).toHaveLength(1);
  });
  it('returns no eligibility result and never queues unknown unverified disabled or missing-credential accounts', async () => {
    expect(await recovery.request("' OR true --", randomUUID())).toBeUndefined();
    await owner.query('UPDATE users SET email_verified_at=NULL');
    expect(await recovery.request('fixture@example.invalid', randomUUID())).toBeUndefined();
    await owner.query(
      'UPDATE users SET email_verified_at=clock_timestamp(),disabled_at=clock_timestamp()',
    );
    await recovery.request('fixture@example.invalid', randomUUID());
    await owner.query('UPDATE users SET disabled_at=NULL');
    await owner.query('DELETE FROM password_credentials');
    await recovery.request('fixture@example.invalid', randomUUID());
    expect((await owner.query('SELECT id FROM password_recovery_requests')).rows).toHaveLength(0);
    expect(
      (await owner.query('SELECT event_id FROM password_recovery_deliveries')).rows,
    ).toHaveLength(0);
  });
  it('enforces database cooldown rolling cap and conservative future-clock refusal', async () => {
    await recovery.request('fixture@example.invalid', randomUUID());
    await recovery.request('fixture@example.invalid', randomUUID());
    expect((await owner.query('SELECT id FROM password_recovery_requests')).rows).toHaveLength(1);
    for (let attempt = 0; attempt < 6; attempt++) {
      await owner.query(
        "UPDATE password_recovery_requests SET created_at=clock_timestamp()-interval '2 minutes'",
      );
      await recovery.request('fixture@example.invalid', randomUUID());
    }
    expect((await owner.query('SELECT id FROM password_recovery_requests')).rows).toHaveLength(5);
    await owner.query(
      "UPDATE password_recovery_requests SET created_at=clock_timestamp()-interval '25 hours'",
    );
    await recovery.request('fixture@example.invalid', randomUUID());
    expect((await owner.query('SELECT id FROM password_recovery_requests')).rows).toHaveLength(6);
    await owner.query(
      "UPDATE password_recovery_requests SET expires_at=clock_timestamp()+interval '2 hours',created_at=clock_timestamp()+interval '1 hour'",
    );
    await recovery.request('fixture@example.invalid', randomUUID());
    expect((await owner.query('SELECT id FROM password_recovery_requests')).rows).toHaveLength(6);
  });
  it('rolls back immutable request/audit when pending delivery creation fails', async () => {
    await owner.query(
      'ALTER TABLE password_recovery_deliveries ADD CONSTRAINT fixture_reject CHECK(false)',
    );
    try {
      await expect(recovery.request('fixture@example.invalid', randomUUID())).rejects.toMatchObject(
        { code: '23514' },
      );
    } finally {
      await owner.query('ALTER TABLE password_recovery_deliveries DROP CONSTRAINT fixture_reject');
    }
    expect((await owner.query('SELECT id FROM password_recovery_requests')).rows).toHaveLength(0);
    expect(
      (await owner.query('SELECT event_id FROM password_recovery_deliveries')).rows,
    ).toHaveLength(0);
  });
  it('denies a queued request after a post-lock account-state transition', async () => {
    const blocker = await owner.connect();
    let pending: Promise<void> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
      pending = recovery.request('fixture@example.invalid', randomUUID());
      await expect
        .poll(
          async () =>
            Number(
              (
                await owner.query(
                  "SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM users WHERE email_normalized=%'",
                )
              ).rows[0].n,
            ),
          { timeout: 750, interval: 10 },
        )
        .toBe(1);
      await blocker.query('UPDATE users SET disabled_at=clock_timestamp() WHERE id=$1', [userId]);
      await blocker.query('COMMIT');
      await pending;
      expect((await owner.query('SELECT id FROM password_recovery_requests')).rows).toHaveLength(0);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await pending;
    }
  });
  it('denies requester account credentials session proof and immutable-event mutation privileges', async () => {
    for (const statement of [
      "INSERT INTO users(email,email_normalized) VALUES('forged@example.invalid','forged@example.invalid')",
      'UPDATE users SET email_verified_at=clock_timestamp()',
      "UPDATE password_credentials SET password_hash='invalid'",
      'DELETE FROM password_recovery_requests',
      'UPDATE password_recovery_requests SET request_id=gen_random_uuid()',
      'SELECT credential_binding FROM password_recovery_requests',
      'SELECT * FROM browser_sessions',
      'SELECT * FROM password_recovery_tokens',
      'SELECT * FROM password_recovery_audit',
      "INSERT INTO password_recovery_deliveries(event_id,status) VALUES(gen_random_uuid(),'sent')",
    ])
      await expect(requester.query(statement)).rejects.toMatchObject({ code: '42501' });
  });
  it('removes a directly added credential mutation grant during explicit reprovisioning', async () => {
    await owner.query('GRANT UPDATE(password_hash) ON password_credentials TO "' + role + '"');
    await provision();
    await expect(
      requester.query("UPDATE password_credentials SET password_hash='invalid'"),
    ).rejects.toMatchObject({ code: '42501' });
    await recovery.request('fixture@example.invalid', randomUUID());
    expect((await owner.query('SELECT id FROM password_recovery_requests')).rows).toHaveLength(1);
  });
  it('rejects any inherited role membership rather than silently adopting broader authority', async () => {
    const group = 'recovery_group_' + randomUUID().replaceAll('-', '');
    await admin.query('CREATE ROLE "' + group + '" NOLOGIN');
    try {
      await admin.query('GRANT "' + group + '" TO "' + role + '"');
      await expect(provision()).rejects.toMatchObject({ code: 'P0001' });
    } finally {
      await admin.query('REVOKE "' + group + '" FROM "' + role + '"');
      await admin.query('DROP ROLE "' + group + '"');
    }
  });
  it('rejects effective DELETE outside public even when inherited through PUBLIC', async () => {
    await owner.query('CREATE SCHEMA recovery_fixture_external');
    await owner.query('CREATE TABLE recovery_fixture_external.resource(id integer)');
    try {
      await owner.query('GRANT DELETE ON recovery_fixture_external.resource TO PUBLIC');
      await expect(provision()).rejects.toMatchObject({ code: 'P0001' });
    } finally {
      await owner.query('DROP TABLE recovery_fixture_external.resource');
      await owner.query('DROP SCHEMA recovery_fixture_external');
    }
  });
});
