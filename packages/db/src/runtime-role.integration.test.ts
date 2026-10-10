import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
  const tables = 'public.users, public.password_credentials, public.security_audit_events';
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

  it.each(['SCHEMA public', 'TABLE public.security_audit_events', `DATABASE "${databaseName}"`])(
    'rejects ownership of %s by the runtime principal',
    async (object) => {
      await owner.query(`ALTER ${object} OWNER TO "${roleName}"`);
      try {
        await expect(provision()).rejects.toThrow('Runtime role must not own database objects');
      } finally {
        await owner.query(`ALTER ${object} OWNER TO "${ownerName.replaceAll('"', '""')}"`);
      }
    },
  );

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
});
