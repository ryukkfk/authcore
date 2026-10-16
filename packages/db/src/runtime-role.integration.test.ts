import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SignupIdempotencyClaimRepository,
  SignupIdempotencyConflictError,
  SignupIdempotencyExpiryError,
  SignupIdempotencyResultRepository,
  type SignupClaimBinding,
} from './repositories/signup-idempotency.repository.js';
import { UserRepository } from './repositories/user.repository.js';
import { PasswordCredentialRepository } from './repositories/password-credential.repository.js';
import { SecurityAuditEventRepository } from './repositories/security-audit-event.repository.js';
import { runSignupTransaction } from './signup-transaction.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (connectionString) {
  const url = new URL(connectionString);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    !['', '5432'].includes(url.port) ||
    url.pathname !== '/authcore_test' ||
    url.search ||
    url.hash ||
    connectionString === process.env.DATABASE_URL
  )
    throw new Error('TEST_DATABASE_URL must target dedicated local port 5432 authcore_test');
}

describe.skipIf(!connectionString)('Signup runtime database privileges', () => {
  const suffix = randomUUID().replaceAll('-', '');
  const databaseName = `audit_permissions_test_${suffix}`;
  const roleName = `audit_runtime_test_${suffix}`;
  const password = randomUUID();
  const databaseUrl = new URL(connectionString ?? 'postgresql://localhost/authcore_test');
  databaseUrl.pathname = `/${databaseName}`;
  const runtimeUrl = new URL(databaseUrl);
  runtimeUrl.username = roleName;
  runtimeUrl.password = password;
  const admin = new Pool({ connectionString, connectionTimeoutMillis: 5_000 });
  const owner = new Pool({
    connectionString: databaseUrl.toString(),
    connectionTimeoutMillis: 5_000,
  });
  const runtime = new Pool({
    connectionString: runtimeUrl.toString(),
    connectionTimeoutMillis: 5_000,
  });
  const tables =
    'public.users, public.password_credentials, public.security_audit_events, public.signup_idempotency_claims, public.signup_idempotency_results, public.signup_idempotency_namespace, public.signup_idempotency_terminal_events, public.verification_events';
  const runtimeDb = drizzle(runtime);
  const claims = new SignupIdempotencyClaimRepository(runtimeDb);
  const results = new SignupIdempotencyResultRepository(runtimeDb);
  const binding = (): SignupClaimBinding => ({
    keyVersion: 1,
    hmacKeyVersion: 1,
    keyDigest: randomBytes(32).toString('hex'),
    payloadVersion: 1,
    payloadDigest: randomBytes(32).toString('hex'),
  });
  const expiry = () => new Date(Date.now() + 86_400_000);
  let databaseCreated = false;
  let roleCreated = false;
  let provisionSql: string;
  let userId: string;
  let ownerName: string;

  async function provision(name = roleName) {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('authcore.runtime_role', $1, true)", [name]);
      await client.query(provisionSql);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    expect((await admin.query('SELECT current_database() AS name')).rows[0].name).toBe(
      'authcore_test',
    );
    ownerName = (await admin.query('SELECT current_user AS name')).rows[0].name;
    // Only the explicitly selected isolated test administrator creates roles.
    const roleSql = (
      await admin.query(
        "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', $1::text, $2::text) AS sql",
        [roleName, password],
      )
    ).rows[0].sql;
    await admin.query(roleSql);
    roleCreated = true;
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;
    const folder = new URL('../drizzle/', import.meta.url);
    for (const name of (await readdir(folder)).filter((x) => x.endsWith('.sql')).sort()) {
      await owner.query(await readFile(new URL(name, folder), 'utf8'));
    }
    await owner.query(`REVOKE TEMPORARY ON DATABASE "${databaseName}" FROM PUBLIC`);
    provisionSql = await readFile(
      new URL('../permissions/signup-runtime-role.sql', import.meta.url),
      'utf8',
    );
  }, 15_000);

  beforeEach(async () => {
    await owner.query('DELETE FROM public.signup_idempotency_terminal_events');
    await owner.query('DELETE FROM public.signup_idempotency_namespace');
    await owner.query('DELETE FROM public.signup_idempotency_results');
    await owner.query('DELETE FROM public.signup_idempotency_claims');
    await owner.query('DELETE FROM public.security_audit_events');
    await owner.query('DELETE FROM public.users');
    await owner.query(`GRANT ALL ON ${tables} TO "${roleName}"`);
    userId = (
      await owner.query(
        "INSERT INTO public.users(email, email_normalized) VALUES ('fixture@example.com', 'fixture@example.com') RETURNING id",
      )
    ).rows[0].id;
    await owner.query(
      "INSERT INTO public.security_audit_events(event_type, user_id) VALUES ('identity.user_created', $1)",
      [userId],
    );
  });

  afterAll(async () => {
    try {
      await runtime.end();
    } finally {
      try {
        await owner.end();
      } finally {
        try {
          // Dropping this suite's own DB removes only its role dependencies.
          if (databaseCreated) await admin.query(`DROP DATABASE "${databaseName}"`);
        } finally {
          try {
            if (roleCreated) await admin.query(`DROP ROLE "${roleName}"`);
          } finally {
            await admin.end();
          }
        }
      }
    }
  });

  it('denies audit updates after provisioning and preserves existing rows', async () => {
    await provision();
    await expect(
      runtime.query('UPDATE public.security_audit_events SET occurred_at = now()'),
    ).rejects.toMatchObject({ code: '42501' });
    expect((await owner.query('SELECT user_id FROM public.security_audit_events')).rows).toEqual([
      { user_id: userId },
    ]);
  });

  it('grants namespace SELECT only and detects effective PUBLIC namespace INSERT atomically', async () => {
    await owner.query(
      "INSERT INTO public.signup_idempotency_namespace(hmac_key_version, attestation_key_digest, attestation_payload_digest) VALUES(1, repeat('a',64), repeat('b',64))",
    );
    await provision();
    const anchor = (await runtime.query('SELECT * FROM public.signup_idempotency_namespace')).rows;
    expect(anchor).toHaveLength(1);
    for (const statement of [
      "INSERT INTO public.signup_idempotency_namespace(hmac_key_version, attestation_key_digest, attestation_payload_digest) VALUES(1, repeat('a',64), repeat('b',64))",
      'UPDATE public.signup_idempotency_namespace SET hmac_key_version=2',
      'DELETE FROM public.signup_idempotency_namespace',
      'TRUNCATE public.signup_idempotency_namespace',
      'SELECT * FROM public.signup_idempotency_namespace FOR UPDATE',
    ])
      await expect(runtime.query(statement)).rejects.toMatchObject({ code: '42501' });
    expect((await runtime.query('SELECT * FROM public.signup_idempotency_namespace')).rows).toEqual(
      anchor,
    );
    await owner.query('GRANT INSERT ON public.signup_idempotency_namespace TO PUBLIC');
    try {
      await expect(provision()).rejects.toThrow('Unsafe effective table privileges');
    } finally {
      await owner.query('REVOKE INSERT ON public.signup_idempotency_namespace FROM PUBLIC');
    }
  });

  it('keeps terminal expiry events immutable, unique and linked to retained claims', async () => {
    await provision();
    const { claim } = await claims.reserve(binding(), expiry());
    const event = (
      await runtime.query(
        "INSERT INTO public.signup_idempotency_terminal_events(claim_id,event_type,policy_version,observed_at) VALUES($1,'signup.expired',1,$2) RETURNING *",
        [claim.id, claim.expiresAt],
      )
    ).rows[0];
    expect(event).toMatchObject({
      claim_id: claim.id,
      event_type: 'signup.expired',
      policy_version: 1,
    });
    for (const statement of [
      'UPDATE public.signup_idempotency_terminal_events SET policy_version=1',
      'DELETE FROM public.signup_idempotency_terminal_events',
      'TRUNCATE public.signup_idempotency_terminal_events',
      'SELECT * FROM public.signup_idempotency_terminal_events FOR UPDATE',
    ])
      await expect(runtime.query(statement)).rejects.toMatchObject({ code: '42501' });
    await expect(
      runtime.query(
        "INSERT INTO public.signup_idempotency_terminal_events(claim_id,event_type,policy_version,observed_at) VALUES($1,'signup.expired',1,$2)",
        [claim.id, claim.expiresAt],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      runtime.query(
        "INSERT INTO public.signup_idempotency_terminal_events(claim_id,event_type,policy_version,observed_at) VALUES($1,'signup.expired',1,now())",
        [randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      owner.query('DELETE FROM public.signup_idempotency_claims WHERE id=$1', [claim.id]),
    ).rejects.toMatchObject({ code: '23503' });
    expect(
      (await runtime.query('SELECT * FROM public.signup_idempotency_terminal_events')).rows,
    ).toEqual([event]);
  });

  it.each([
    ['signup.expired', 2, 'now()'],
    ['identity.user_created', 1, 'now()'],
    ['signup.expired', 1, "'infinity'::timestamptz"],
  ])('rejects unsupported terminal event shape %#', async (type, version, observed) => {
    await provision();
    const { claim } = await claims.reserve(binding(), expiry());
    await expect(
      runtime.query(
        `INSERT INTO public.signup_idempotency_terminal_events(claim_id,event_type,policy_version,observed_at) VALUES($1,$2,$3,${observed})`,
        [claim.id, type, version],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('inventories all eight effective relation/column privileges without grant options', async () => {
    await provision();
    const inventory = (
      await owner.query(
        "SELECT c.relname, a.attname, has_column_privilege($1,c.oid,a.attname,'SELECT') AS readable, has_column_privilege($1,c.oid,a.attname,'INSERT') AS insertable, has_column_privilege($1,c.oid,a.attname,'UPDATE') AS updatable, has_column_privilege($1,c.oid,a.attname,'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION') AS grantable FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum",
        [roleName],
      )
    ).rows;
    expect(new Set(inventory.map((row) => row.relname)).size).toBe(8);
    for (const row of inventory)
      expect(row).toMatchObject({
        readable: true,
        insertable: row.relname !== 'signup_idempotency_namespace',
        updatable: row.relname === 'signup_idempotency_claims' && row.attname === 'lock_anchor',
        grantable: false,
      });
    console.info(
      JSON.stringify({
        scope: 'S2_RUNTIME_INVENTORY',
        tables: 8,
        columns: inventory.length,
        namespaceWrite: false,
        mutationGrant: 'claims.lock_anchor only',
        grantOptions: false,
      }),
    );
  });
  it('allows durable notification intent but denies its mutation and deletion', async () => {
    await provision();
    const event = (
      await runtime.query(
        'INSERT INTO public.verification_events(user_id) VALUES($1) RETURNING id',
        [userId],
      )
    ).rows[0];
    for (const statement of [
      "UPDATE public.verification_events SET reason='resend' WHERE id=$1",
      'DELETE FROM public.verification_events WHERE id=$1',
    ])
      await expect(runtime.query(statement, [event.id])).rejects.toMatchObject({ code: '42501' });
    await expect(runtime.query('TRUNCATE public.verification_events')).rejects.toMatchObject({
      code: '42501',
    });
    expect(
      (await owner.query('SELECT id FROM public.verification_events WHERE id=$1', [event.id])).rows,
    ).toHaveLength(1);
  });

  it.each([
    'DELETE FROM public.security_audit_events',
    'TRUNCATE public.security_audit_events',
    'TRUNCATE public.users CASCADE',
    'ALTER TABLE public.security_audit_events ADD COLUMN forbidden text',
    'DROP TABLE public.security_audit_events',
    'GRANT UPDATE ON public.security_audit_events TO PUBLIC',
  ])('denies destructive or privilege-escalating SQL: %s', async (sql) => {
    await provision();
    // GRANT can warn without throwing. Effective privileges must stay absent.
    if (sql.startsWith('GRANT')) {
      await runtime.query(sql);
      expect(
        (
          await owner.query(
            "SELECT has_table_privilege('public', 'public.security_audit_events', 'UPDATE') AS allowed",
          )
        ).rows[0].allowed,
      ).toBe(false);
    } else {
      await expect(runtime.query(sql)).rejects.toMatchObject({ code: '42501' });
    }
    expect((await owner.query('SELECT user_id FROM public.security_audit_events')).rows).toEqual([
      { user_id: userId },
    ]);
  });

  it('uses a genuine restricted login that cannot assume the owner or create objects', async () => {
    await provision();
    expect((await runtime.query('SELECT current_user, session_user')).rows[0]).toEqual({
      current_user: roleName,
      session_user: roleName,
    });
    await expect(
      runtime.query(`SET ROLE "${ownerName.replaceAll('"', '""')}"`),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(runtime.query('CREATE TABLE public.forbidden(id int)')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(runtime.query('CREATE TEMP TABLE forbidden(id int)')).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('supports current repository inserts and RETURNING', async () => {
    await provision();
    const id = (
      await runtime.query(
        "INSERT INTO public.users(email, email_normalized) VALUES ('new@example.com', 'new@example.com') ON CONFLICT(email_normalized) DO NOTHING RETURNING *",
      )
    ).rows[0].id;
    await runtime.query(
      'INSERT INTO public.password_credentials(user_id, password_hash) VALUES ($1, $2) RETURNING *',
      [id, 'synthetic-hash'],
    );
    const event = (
      await runtime.query(
        "INSERT INTO public.security_audit_events(event_type, user_id, payload) VALUES ('identity.user_created', $1, '{}') RETURNING *",
        [id],
      )
    ).rows[0];
    expect(event).toMatchObject({ user_id: id, payload: {} });
  });

  it('removes a direct column UPDATE grant as well as table privileges', async () => {
    await owner.query(`GRANT UPDATE(occurred_at) ON public.security_audit_events TO "${roleName}"`);
    await provision();
    await expect(
      runtime.query('UPDATE public.security_audit_events SET occurred_at = now()'),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('rejects PUBLIC mutation privileges and rolls back the provisioning changes', async () => {
    await owner.query('GRANT UPDATE(occurred_at) ON public.security_audit_events TO PUBLIC');
    try {
      await expect(provision()).rejects.toThrow('Unsafe effective table privileges');
      expect(
        (
          await owner.query(
            "SELECT has_table_privilege($1::text, 'public.security_audit_events', 'DELETE') AS allowed",
            [roleName],
          )
        ).rows[0].allowed,
      ).toBe(true);
    } finally {
      await owner.query('REVOKE UPDATE(occurred_at) ON public.security_audit_events FROM PUBLIC');
    }
  });

  it('rejects a role with membership even when its membership cannot inherit', async () => {
    const group = `audit_group_test_${suffix}`;
    await admin.query(`CREATE ROLE "${group}" NOLOGIN`);
    try {
      await admin.query(`GRANT "${group}" TO "${roleName}" WITH INHERIT FALSE, SET TRUE`);
      await expect(provision()).rejects.toThrow('Runtime role must have no role memberships');
    } finally {
      await admin.query(`DROP ROLE "${group}"`);
    }
  });

  it.each([
    ['CREATEROLE', 'NOCREATEROLE'],
    ['CREATEDB', 'NOCREATEDB'],
    ['SUPERUSER', 'NOSUPERUSER'],
    ['REPLICATION', 'NOREPLICATION'],
    ['BYPASSRLS', 'NOBYPASSRLS'],
    ['NOLOGIN', 'LOGIN'],
  ])('rejects unsafe runtime role attribute %s', async (unsafe, safe) => {
    await admin.query(`ALTER ROLE "${roleName}" ${unsafe}`);
    try {
      await expect(provision()).rejects.toThrow('Runtime role must be an unprivileged login');
    } finally {
      await admin.query(`ALTER ROLE "${roleName}" ${safe}`);
    }
  });

  it.each([
    { kind: 'schema', object: 'SCHEMA public' },
    { kind: 'audit table', object: 'TABLE public.security_audit_events' },
    { kind: 'database', object: `DATABASE "${databaseName}"` },
  ])('rejects ownership of $kind by the runtime principal', async ({ object }) => {
    await owner.query(`ALTER ${object} OWNER TO "${roleName}"`);
    try {
      await expect(provision()).rejects.toThrow('Runtime role must not own database objects');
    } finally {
      await owner.query(`ALTER ${object} OWNER TO "${ownerName.replaceAll('"', '""')}"`);
    }
  });

  it('rejects PUBLIC temporary-object privileges without changing PUBLIC grants', async () => {
    await owner.query(`GRANT TEMPORARY ON DATABASE "${databaseName}" TO PUBLIC`);
    try {
      await expect(provision()).rejects.toThrow('Unsafe effective database or schema privileges');
    } finally {
      await owner.query(`REVOKE TEMPORARY ON DATABASE "${databaseName}" FROM PUBLIC`);
    }
  });

  it('rejects callable application SECURITY DEFINER routines', async () => {
    await owner.query(
      'CREATE FUNCTION public.unsafe_test() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$',
    );
    try {
      await expect(provision()).rejects.toThrow(
        'Runtime role can execute a SECURITY DEFINER routine',
      );
    } finally {
      await owner.query('DROP FUNCTION public.unsafe_test()');
    }
  });

  it('rejects writable views that could bypass the audit table ACL', async () => {
    await owner.query(
      'CREATE VIEW public.audit_escape AS SELECT * FROM public.security_audit_events',
    );
    await owner.query(`GRANT UPDATE ON public.audit_escape TO "${roleName}"`);
    try {
      await expect(provision()).rejects.toThrow(
        'Unsafe effective privileges outside signup tables',
      );
    } finally {
      await owner.query('DROP VIEW public.audit_escape');
    }
  });

  it('rejects privileged server-parameter grants to the test role', async () => {
    await admin.query(`GRANT SET ON PARAMETER session_replication_role TO "${roleName}"`);
    try {
      await expect(provision()).rejects.toThrow('Unsafe runtime server-parameter privileges');
    } finally {
      await admin.query(`REVOKE SET ON PARAMETER session_replication_role FROM "${roleName}"`);
    }
  });

  it('rejects unexpected direct system-catalog grants', async () => {
    await owner.query(`GRANT SELECT ON pg_catalog.pg_authid TO "${roleName}"`);
    try {
      await expect(provision()).rejects.toThrow('Unsafe explicit privileges outside signup tables');
    } finally {
      await owner.query(`REVOKE SELECT ON pg_catalog.pg_authid FROM "${roleName}"`);
    }
  });

  it('rejects explicit privileged built-in routine grants', async () => {
    await owner.query(`GRANT EXECUTE ON FUNCTION pg_catalog.lo_export(oid, text) TO "${roleName}"`);
    try {
      await expect(provision()).rejects.toThrow('Unsafe explicit routine privileges');
    } finally {
      await owner.query(
        `REVOKE EXECUTE ON FUNCTION pg_catalog.lo_export(oid, text) FROM "${roleName}"`,
      );
    }
  });

  it('fails atomically when a required schema migration is missing', async () => {
    await owner.query(
      'ALTER TABLE public.security_audit_events RENAME TO temporarily_missing_audit',
    );
    try {
      await expect(provision()).rejects.toThrow(
        'Apply signup schema migrations before permission provisioning',
      );
      expect(
        (
          await owner.query(
            "SELECT has_table_privilege($1::text, 'public.users', 'DELETE') AS allowed",
            [roleName],
          )
        ).rows[0].allowed,
      ).toBe(true);
    } finally {
      await owner.query(
        'ALTER TABLE public.temporarily_missing_audit RENAME TO security_audit_events',
      );
    }
  });

  it('rejects an unknown or SQL-looking role name without modifying the schema', async () => {
    await expect(provision('missing_runtime_role')).rejects.toThrow(
      'Runtime role must be an unprivileged login',
    );
    await expect(provision('bad"; DROP TABLE users; --')).rejects.toThrow(
      'Invalid runtime role name',
    );
    expect((await owner.query('SELECT id FROM public.users')).rows).toHaveLength(1);
  });

  it('is repeatable and leaves the owner able to manage its disposable schema', async () => {
    await provision();
    await provision();
    await owner.query('CREATE TABLE public.migration_probe(id int)');
    await owner.query('DROP TABLE public.migration_probe');
    await expect(
      runtime.query('UPDATE public.security_audit_events SET occurred_at = now()'),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('reserves and looks up only allowed claim fields; retry preserves identity and expiry', async () => {
    await provision();
    const key = binding();
    expect(await claims.findByKey(key)).toBeNull();
    const first = await claims.reserve(
      {
        ...key,
        ...{ id: randomUUID(), createdAt: new Date(0), lockAnchor: true, rawKey: 'do-not-store' },
      },
      expiry(),
    );
    expect(first.reserved).toBe(true);
    expect(first.claim).toMatchObject({ ...key, lockAnchor: false });
    expect(first.claim.createdAt.getTime()).toBeGreaterThan(0);
    const retry = await claims.reserve(key, new Date(Date.now() + 172_800_000));
    expect(retry).toEqual({ claim: first.claim, reserved: false });
    expect(await claims.findByKey(key)).toEqual(first.claim);
    expect(await results.findByClaimId(first.claim.id)).toBeNull();
  });

  it('concurrent identical claims establish exactly one durable identity', async () => {
    await provision();
    const key = binding();
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => claims.reserve(key, expiry())),
    );
    expect(attempts.filter((attempt) => attempt.reserved)).toHaveLength(1);
    expect(new Set(attempts.map((attempt) => attempt.claim.id)).size).toBe(1);
    expect((await owner.query('SELECT * FROM public.signup_idempotency_claims')).rows).toHaveLength(
      1,
    );
  });

  it('concurrent conflicting payloads cannot both reserve or change the winning binding', async () => {
    await provision();
    const first = binding();
    const second = { ...first, payloadDigest: randomBytes(32).toString('hex') };
    const attempts = await Promise.allSettled([
      claims.reserve(first, expiry()),
      claims.reserve(second, expiry()),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    const failure = attempts.find((attempt) => attempt.status === 'rejected');
    expect(failure?.reason).toBeInstanceOf(SignupIdempotencyConflictError);
    expect(failure?.reason).not.toHaveProperty('cause');
    expect(failure?.reason.message).not.toContain(first.payloadDigest);
    const winner = await claims.findByKey(first);
    expect([first.payloadDigest, second.payloadDigest]).toContain(winner?.payloadDigest);
    expect((await owner.query('SELECT * FROM public.signup_idempotency_claims')).rows).toHaveLength(
      1,
    );
  });

  it('holds the claim row lock until transaction end with only the inert UPDATE grant', async () => {
    await provision();
    const key = binding();
    const reserved = await claims.reserve(key, expiry());
    const first = await runtime.connect();
    const second = await runtime.connect();
    try {
      await first.query('BEGIN');
      await second.query('BEGIN');
      expect(await SignupIdempotencyClaimRepository.lockByKey(drizzle(first), key)).toEqual(
        reserved.claim,
      );
      await second.query("SET LOCAL lock_timeout = '100ms'");
      await expect(
        SignupIdempotencyClaimRepository.lockByKey(drizzle(second), key),
      ).rejects.toMatchObject({ cause: { code: '55P03' } });
      await second.query('ROLLBACK');
      await first.query('COMMIT');
      await second.query('BEGIN');
      expect(await SignupIdempotencyClaimRepository.lockByKey(drizzle(second), key)).toEqual(
        reserved.claim,
      );
      expect(
        await SignupIdempotencyClaimRepository.lockByKey(drizzle(second), binding()),
      ).toBeNull();
      await expect(
        SignupIdempotencyClaimRepository.lockByKey(drizzle(second), {
          ...key,
          payloadDigest: randomBytes(32).toString('hex'),
        }),
      ).rejects.toBeInstanceOf(SignupIdempotencyConflictError);
    } finally {
      await first.query('ROLLBACK');
      await second.query('ROLLBACK');
      first.release();
      second.release();
    }
  });

  it.each([
    ['COMMIT', false],
    ['COMMIT', true],
    ['ROLLBACK', false],
    ['ROLLBACK', true],
  ] as const)(
    'waits for an invisible reservation: %s, conflicting payload=%s',
    async (outcome, conflict) => {
      await provision();
      const key = binding();
      const first = await runtime.connect();
      const second = await runtime.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await first.query('BEGIN');
        await first.query("SET LOCAL statement_timeout = '3s'");
        const original = await new SignupIdempotencyClaimRepository(drizzle(first)).reserve(
          key,
          expiry(),
        );
        const pid = (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        await second.query("SET statement_timeout = '3s'");
        const contender = conflict ? { ...key, payloadDigest: binding().payloadDigest } : key;
        pending = new SignupIdempotencyClaimRepository(drizzle(second)).reserve(
          contender,
          expiry(),
        );
        // Register rejection immediately, including if lock observation fails.
        void pending.catch(() => undefined);
        const deadline = Date.now() + 2_000;
        let blocked = false;
        while (Date.now() < deadline) {
          blocked = (
            await owner.query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid])
          ).rows[0].blocked;
          if (blocked) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
        await first.query(outcome);
        if (outcome === 'COMMIT' && conflict) {
          await expect(pending).rejects.toBeInstanceOf(SignupIdempotencyConflictError);
          expect(await claims.findByKey(key)).toEqual(original.claim);
        } else if (outcome === 'COMMIT') {
          expect(await pending).toEqual({ claim: original.claim, reserved: false });
        } else {
          expect(await pending).toMatchObject({ reserved: true, claim: contender });
          expect((await claims.findByKey(key))?.id).not.toBe(original.claim.id);
        }
      } finally {
        await first.query('ROLLBACK');
        await pending?.catch(() => undefined);
        await second.query('RESET statement_timeout');
        first.release();
        second.release();
      }
    },
  );

  it.each([
    'id = gen_random_uuid()',
    'key_version = 1',
    'hmac_key_version = 2',
    "key_digest = repeat('b', 64)",
    'payload_version = 1',
    "payload_digest = repeat('c', 64)",
    'created_at = now()',
    "expires_at = now() + interval '2 days'",
  ])('denies claim identity/binding/timestamp UPDATE: %s', async (assignment) => {
    await provision();
    const key = binding();
    const original = await claims.reserve(key, expiry());
    await expect(
      runtime.query(`UPDATE public.signup_idempotency_claims SET ${assignment}`),
    ).rejects.toMatchObject({ code: '42501' });
    expect(await claims.findByKey(key)).toEqual(original.claim);
  });

  it('allows an inert no-op but rejects changing the locking anchor and removing claims', async () => {
    await provision();
    await claims.reserve(binding(), expiry());
    await runtime.query('UPDATE public.signup_idempotency_claims SET lock_anchor = false');
    await expect(
      runtime.query('UPDATE public.signup_idempotency_claims SET lock_anchor = true'),
    ).rejects.toMatchObject({ code: '23514' });
    for (const sql of [
      'DELETE FROM public.signup_idempotency_claims',
      'TRUNCATE public.signup_idempotency_claims CASCADE',
    ]) {
      await expect(runtime.query(sql)).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('keeps results immutable, unique, secret-free and linked to a retained claim', async () => {
    await provision();
    const { claim } = await claims.reserve(binding(), expiry());
    const original = await results.recordAccepted(claim.id);
    expect(original).toMatchObject({
      claimId: claim.id,
      resultVersion: 1,
      statusCode: 202,
      responseBody: { status: 'accepted' },
    });
    await expect(results.recordAccepted(claim.id)).rejects.toMatchObject({
      cause: { code: '23505' },
    });
    await expect(results.recordAccepted(randomUUID())).rejects.toMatchObject({
      cause: { code: '23503' },
    });
    for (const sql of [
      'UPDATE public.signup_idempotency_results SET created_at = now()',
      'UPDATE public.signup_idempotency_results SET claim_id = gen_random_uuid()',
      'DELETE FROM public.signup_idempotency_results',
      'TRUNCATE public.signup_idempotency_results',
      'SELECT * FROM public.signup_idempotency_results FOR UPDATE',
    ])
      await expect(runtime.query(sql)).rejects.toMatchObject({ code: '42501' });
    await expect(
      owner.query('DELETE FROM public.signup_idempotency_claims WHERE id = $1', [claim.id]),
    ).rejects.toMatchObject({ code: '23503' });
    expect(await results.findByClaimId(claim.id)).toEqual(original);
  });

  it.each([
    [2, 202, { status: 'accepted' }],
    [1, 201, { status: 'accepted' }],
    [1, 202, {}],
    [1, 202, { status: 'accepted', password: 'do-not-store' }],
    [1, 202, { status: 'accepted', idempotencyKey: 'do-not-store' }],
    [1, 202, null],
    [1, 202, []],
  ])('rejects unsupported or secret-bearing result shapes %#', async (version, status, body) => {
    await provision();
    const { claim } = await claims.reserve(binding(), expiry());
    await expect(
      runtime.query(
        'INSERT INTO public.signup_idempotency_results(claim_id, result_version, status_code, response_body) VALUES($1, $2, $3, $4::jsonb)',
        [claim.id, version, status, JSON.stringify(body)],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await results.findByClaimId(claim.id)).toBeNull();
  });

  it.each([
    { keyVersion: 2 },
    { payloadVersion: 2 },
    { hmacKeyVersion: 0 },
    { keyDigest: 'raw-idempotency-key' },
    { payloadDigest: 'raw-password' },
    { keyDigest: 'A'.repeat(64) },
    { payloadDigest: 'a'.repeat(63) },
  ])('rejects invalid claim contracts and digests %#', async (invalid) => {
    await provision();
    await expect(claims.reserve({ ...binding(), ...invalid }, expiry())).rejects.toMatchObject({
      cause: { code: '23514' },
    });
    expect((await owner.query('SELECT * FROM public.signup_idempotency_claims')).rows).toHaveLength(
      0,
    );
  });

  it.each(['now()', "now() - interval '1 day'", "'infinity'::timestamptz"])(
    'rejects non-future/non-finite initial expiry: %s',
    async (expiresAt) => {
      await provision();
      await expect(
        runtime.query(
          `INSERT INTO public.signup_idempotency_claims
        (key_version, hmac_key_version, key_digest, payload_version, payload_digest, expires_at)
        VALUES (1, 1, $1, 1, $2, ${expiresAt})`,
          [binding().keyDigest, binding().payloadDigest],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    },
  );

  it('retains expired bindings and results; expiry never authorizes rebinding', async () => {
    await provision();
    const key = binding();
    const stored = await owner.query(
      `INSERT INTO public.signup_idempotency_claims
      (key_version, hmac_key_version, key_digest, payload_version, payload_digest, created_at, expires_at)
      VALUES (1, 1, $1, 1, $2, now() - interval '2 days', now() - interval '1 day')
      RETURNING id, expires_at`,
      [key.keyDigest, key.payloadDigest],
    );
    const originalExpiry = stored.rows[0].expires_at as Date;
    const result = await results.recordAccepted(stored.rows[0].id);
    const original = await claims.reserve(key, originalExpiry);
    expect(original.reserved).toBe(false);
    expect(original.claim.expiresAt.getTime()).toBeLessThan(Date.now());
    expect(original.claim.expiresAt).toEqual(originalExpiry);
    expect(await claims.reserve(key, expiry())).toEqual(original);
    await expect(
      claims.reserve({ ...key, payloadDigest: binding().payloadDigest }, originalExpiry),
    ).rejects.toBeInstanceOf(SignupIdempotencyConflictError);
    expect(await results.findByClaimId(original.claim.id)).toEqual(result);
    expect(await claims.findByKey(key)).toEqual(original.claim);
    await expect(results.recordAccepted(original.claim.id)).rejects.toMatchObject({
      cause: { code: '23505' },
    });
    expect(await results.findByClaimId(original.claim.id)).toEqual(result);
  });

  it.each([new Date(0), new Date(NaN)])(
    'rejects invalid new-claim expiry through a sanitized domain error: %s',
    async (invalid) => {
      await provision();
      const key = binding();
      const pending = claims.reserve(key, invalid);
      await expect(pending).rejects.toBeInstanceOf(SignupIdempotencyExpiryError);
      await expect(pending).rejects.not.toHaveProperty('cause');
      expect(await claims.findByKey(key)).toBeNull();
    },
  );

  it('maps a database expiry CHECK caused by clock disagreement without leaking query details', async () => {
    await provision();
    const key = binding();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(new Date('1999-01-01').getTime());
    try {
      const pending = claims.reserve(key, new Date('2000-01-01'));
      await expect(pending).rejects.toBeInstanceOf(SignupIdempotencyExpiryError);
      await expect(pending).rejects.not.toHaveProperty('cause');
    } finally {
      clock.mockRestore();
    }
    expect(await claims.findByKey(key)).toBeNull();
  });

  it.each(['COMMIT', 'ROLLBACK'] as const)(
    'fails closed for invalid expiry while a retained claim is invisible: %s',
    async (outcome) => {
      await provision();
      const key = binding();
      const first = await runtime.connect();
      const originalExpiry = new Date('2000-01-02');
      try {
        await first.query('BEGIN');
        await first.query(
          `INSERT INTO public.signup_idempotency_claims
        (key_version, hmac_key_version, key_digest, payload_version, payload_digest, created_at, expires_at)
        VALUES (1, 1, $1, 1, $2, '2000-01-01', $3)`,
          [key.keyDigest, key.payloadDigest, originalExpiry],
        );
        await expect(claims.reserve(key, originalExpiry)).rejects.toBeInstanceOf(
          SignupIdempotencyExpiryError,
        );
        await first.query(outcome);
        if (outcome === 'COMMIT') {
          expect(await claims.reserve(key, originalExpiry)).toMatchObject({
            reserved: false,
            claim: { ...key, expiresAt: originalExpiry },
          });
        } else {
          await expect(claims.reserve(key, originalExpiry)).rejects.toBeInstanceOf(
            SignupIdempotencyExpiryError,
          );
          expect(await claims.findByKey(key)).toBeNull();
        }
      } finally {
        await first.query('ROLLBACK');
        first.release();
      }
    },
  );

  it('atomically rolls back user, credential, audit and result while keeping the durable claim', async () => {
    await provision();
    const key = binding();
    const { claim } = await claims.reserve(key, expiry());
    const email = `${randomUUID()}@example.com`;
    const failure = new Error('intentional caller rollback');
    const database = { db: runtimeDb, pool: runtime };
    const write = async (rollback: boolean) =>
      runSignupTransaction(database, async (tx) => {
        await SignupIdempotencyClaimRepository.lockByKey(tx, key);
        const user = await new UserRepository(tx).create({ email, emailNormalized: email });
        await new PasswordCredentialRepository(tx).create({
          userId: user.id,
          passwordHash: 'synthetic-hash',
        });
        await new SecurityAuditEventRepository(tx).recordUserCreated({ userId: user.id });
        await new SignupIdempotencyResultRepository(tx).recordAccepted(claim.id);
        if (rollback) throw failure;
        return user;
      });
    await expect(write(true)).rejects.toBe(failure);
    expect(await claims.findByKey(key)).toEqual(claim);
    expect(await results.findByClaimId(claim.id)).toBeNull();
    expect(await new UserRepository(runtimeDb).findByNormalizedEmail(email)).toBeNull();
    expect((await owner.query('SELECT * FROM public.password_credentials')).rows).toHaveLength(0);
    expect((await owner.query('SELECT * FROM public.security_audit_events')).rows).toHaveLength(1);
    const user = await write(false);
    expect(await results.findByClaimId(claim.id)).not.toBeNull();
    expect(await new PasswordCredentialRepository(runtimeDb).findByUserId(user.id)).not.toBeNull();
    expect(
      (
        await owner.query('SELECT * FROM public.security_audit_events WHERE user_id = $1', [
          user.id,
        ])
      ).rows,
    ).toHaveLength(1);
    // Existing result failure must roll back subsequent account writes too.
    const otherEmail = `${randomUUID()}@example.com`;
    await expect(
      runSignupTransaction(database, async (tx) => {
        await new UserRepository(tx).create({ email: otherEmail, emailNormalized: otherEmail });
        await new SignupIdempotencyResultRepository(tx).recordAccepted(claim.id);
      }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
    expect(await new UserRepository(runtimeDb).findByNormalizedEmail(otherEmail)).toBeNull();
  });

  it('rolls back a reservation with its caller transaction and permits a later binding', async () => {
    await provision();
    const key = binding();
    const failure = new Error('reservation not committed');
    await expect(
      runSignupTransaction({ db: runtimeDb, pool: runtime }, async (tx) => {
        await new SignupIdempotencyClaimRepository(tx).reserve(key, expiry());
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await claims.findByKey(key)).toBeNull();
    expect(
      (await claims.reserve({ ...key, payloadDigest: binding().payloadDigest }, expiry())).reserved,
    ).toBe(true);
  });

  it('rejects PUBLIC binding UPDATE and rolls back all attempted provisioning grants', async () => {
    await owner.query('GRANT UPDATE(payload_digest) ON public.signup_idempotency_claims TO PUBLIC');
    try {
      await expect(provision()).rejects.toThrow('Unsafe effective table privileges');
      expect(
        (
          await owner.query(
            "SELECT has_table_privilege($1::text, 'public.signup_idempotency_results', 'DELETE') AS allowed",
            [roleName],
          )
        ).rows[0].allowed,
      ).toBe(true);
    } finally {
      await owner.query(
        'REVOKE UPDATE(payload_digest) ON public.signup_idempotency_claims FROM PUBLIC',
      );
    }
  });
});
