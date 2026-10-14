import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import {
  createDatabaseClient,
  drainSignupTransactionOwners,
  type DatabaseClient,
} from '@authcore/db';
import { bounded, commitAckProxy } from '@authcore/testing';
import type { SignupHmacConfiguration } from '@authcore/crypto';

export const TEST_SIGNUP_METADATA = Object.freeze({
  hmacKeyVersion: 1,
  keyDigest: '8177f8ae43c29713fe6ca3145295691cab3dd75d57a06341a88c246b42e4d9f7',
  payloadDigest: '0eae9db6f7cd38f10e14fa66fbf53735203597c21bc5d3eb27dc388f9658fa55',
});
export function testSignupConfiguration(): SignupHmacConfiguration {
  return { secret: Uint8Array.from({ length: 32 }, (_, i) => i), metadata: TEST_SIGNUP_METADATA };
}
export async function createReservationFixture(approved: URL) {
  const name = 's2_' + randomUUID().replaceAll('-', '');
  const role = 's2_runtime_' + randomUUID().replaceAll('-', '');
  const inventoryUrl = new URL(approved);
  inventoryUrl.searchParams.set('application_name', name + '_inventory');
  const admin = createDatabaseClient({ connectionString: inventoryUrl.toString() });
  const target = new URL(approved);
  target.pathname = '/' + name;
  target.searchParams.set('application_name', name);
  const runtimeUrl = new URL(target);
  runtimeUrl.username = role;
  runtimeUrl.password = randomUUID();
  const clients = new Set<DatabaseClient>();
  const proxies = new Set<Awaited<ReturnType<typeof commitAckProxy>>>();
  let created = false;
  let roleCreated = false;
  let dropped = false;
  const inventory = async () => ({
    databases: (await admin.pool.query('SELECT datname FROM pg_database ORDER BY datname')).rows,
    roles: (await admin.pool.query('SELECT rolname FROM pg_roles ORDER BY rolname')).rows,
    schemas: (await admin.pool.query('SELECT nspname FROM pg_namespace ORDER BY nspname')).rows,
    sessions: (
      await admin.pool.query(
        'SELECT pid, datname FROM pg_stat_activity WHERE application_name=$1 ORDER BY pid',
        [name],
      )
    ).rows,
  });
  const before = await inventory();
  if (
    (await admin.pool.query('SELECT current_database() AS name')).rows[0].name !== 'authcore_test'
  )
    throw new Error('S2 fixture target rejected');
  console.info(JSON.stringify({ scope: 'S2', stage: 'before', inventory: before }));
  const database = (url = runtimeUrl) => {
    const value = createDatabaseClient({ connectionString: url.toString() });
    clients.add(value);
    return value;
  };
  const owner = database(target);
  const seedAnchor = () =>
    owner.pool.query(
      'INSERT INTO public.signup_idempotency_namespace(hmac_key_version,attestation_key_digest,attestation_payload_digest) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET hmac_key_version=EXCLUDED.hmac_key_version,attestation_key_digest=EXCLUDED.attestation_key_digest,attestation_payload_digest=EXCLUDED.attestation_payload_digest',
      [
        TEST_SIGNUP_METADATA.hmacKeyVersion,
        TEST_SIGNUP_METADATA.keyDigest,
        TEST_SIGNUP_METADATA.payloadDigest,
      ],
    );
  async function close() {
    const errors: unknown[] = [];
    for (const proxy of proxies)
      try {
        await proxy.close();
      } catch (error) {
        errors.push(error);
      }
    for (const value of clients) {
      try {
        await bounded(drainSignupTransactionOwners(value), 'S2 owner drain');
      } catch (error) {
        errors.push(error);
      }
      try {
        await bounded(value.pool.end(), 'S2 pool end');
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      const deadline = performance.now() + 5000;
      while ((await inventory()).sessions.length && performance.now() < deadline)
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      if ((await inventory()).sessions.length) throw new Error('S2 owned sessions remain');
      if (created) {
        await admin.pool.query('DROP DATABASE "' + name + '"');
        dropped = true;
      }
      if (roleCreated && (!created || dropped)) await admin.pool.query('DROP ROLE "' + role + '"');
      const after = await inventory();
      console.info(JSON.stringify({ scope: 'S2', stage: 'after', inventory: after }));
      if (JSON.stringify(after) !== JSON.stringify(before))
        throw new Error('S2 resource inventory differs');
    } catch (error) {
      errors.push(error);
    } finally {
      await admin.pool.end();
    }
    if (errors.length) throw new AggregateError(errors, 'S2 fixture cleanup failed');
  }
  try {
    await admin.pool.query('CREATE DATABASE "' + name + '"');
    created = true;
    const roleSql = (
      await admin.pool.query(
        "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', $1::text, $2::text) AS sql",
        [role, runtimeUrl.password],
      )
    ).rows[0].sql;
    await admin.pool.query(roleSql);
    roleCreated = true;
    const folder = new URL('../../../../packages/db/drizzle/', import.meta.url);
    for (const file of (await readdir(folder)).filter((file) => file.endsWith('.sql')).sort())
      await owner.pool.query(await readFile(new URL(file, folder), 'utf8'));
    await owner.pool.query('REVOKE TEMPORARY ON DATABASE "' + name + '" FROM PUBLIC');
    const sql = await readFile(
      new URL('../../../../packages/db/permissions/signup-runtime-role.sql', import.meta.url),
      'utf8',
    );
    const connection = await owner.pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query("SELECT set_config('authcore.runtime_role',$1,true)", [role]);
      await connection.query(sql);
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
    await seedAnchor();
  } catch (error) {
    await close();
    throw error;
  }
  return {
    owner,
    runtime: database(),
    target,
    runtimeUrl,
    database,
    seedAnchor,
    close,
    async proxy() {
      const proxy = await commitAckProxy(runtimeUrl);
      proxies.add(proxy);
      return proxy;
    },
    async writes() {
      return (
        await owner.pool.query(
          'SELECT (SELECT count(*) FROM users)::int AS users,(SELECT count(*) FROM password_credentials)::int AS credentials,(SELECT count(*) FROM security_audit_events)::int AS audits,(SELECT count(*) FROM signup_idempotency_results)::int AS results,(SELECT count(*) FROM signup_idempotency_terminal_events)::int AS terminals',
        )
      ).rows[0];
    },
  };
}
export type ReservationFixture = Awaited<ReturnType<typeof createReservationFixture>>;
