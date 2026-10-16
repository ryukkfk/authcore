import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDeliveryPayload, verificationTokenDigest } from '@authcore/crypto';
import { EmailDeliveryRepository } from './repositories/email-delivery.repository.js';
import { EmailVerificationRepository } from './repositories/email-verification.repository.js';

const source = process.env.TEST_DATABASE_URL;
if (source) {
  const url = new URL(source);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    !['5432', '55433'].includes(url.port) ||
    url.pathname !== '/authcore_test' ||
    url.search ||
    url.hash ||
    source === process.env.DATABASE_URL
  )
    throw new Error('Email tests require the dedicated disposable test database');
}
describe.skipIf(!source)('Email worker and verification real PostgreSQL lifecycle', () => {
  const name = 'email_' + randomUUID().replaceAll('-', '');
  const target = new URL(source ?? 'postgresql://127.0.0.1:55433/authcore_test');
  target.pathname = '/' + name;
  const admin = new Pool({ connectionString: source }),
    owner = new Pool({ connectionString: target.toString() });
  const suffix = randomUUID().replaceAll('-', '');
  const workerRole = 'authcore_email_worker_' + suffix,
    verifierRole = 'authcore_email_verifier_' + suffix;
  const workerUrl = new URL(target),
    verifierUrl = new URL(target);
  workerUrl.hostname = '127.0.0.1';
  verifierUrl.hostname = '127.0.0.1';
  workerUrl.username = workerRole;
  workerUrl.password = randomUUID();
  verifierUrl.username = verifierRole;
  verifierUrl.password = randomUUID();
  const worker = new Pool({ connectionString: workerUrl.toString() }),
    verifier = new Pool({ connectionString: verifierUrl.toString() });
  const repository = new EmailDeliveryRepository(worker),
    verification = new EmailVerificationRepository(verifier);
  const createdRoles: string[] = [];
  async function provision(role: string, capability: string) {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('authcore.email_role',$1,true),set_config('authcore.email_capability',$2,true)",
        [role, capability],
      );
      await client.query(
        await readFile(new URL('../permissions/email-runtime-role.sql', import.meta.url), 'utf8'),
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  const key = { id: 'test-v1', key: randomBytes(32) };
  let created = false,
    userId: string;
  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const folder = new URL('../drizzle/', import.meta.url);
    for (const file of (await readdir(folder)).filter((value) => value.endsWith('.sql')).sort())
      await owner.query(await readFile(new URL(file, folder), 'utf8'));
    await owner.query(`REVOKE TEMPORARY ON DATABASE "${name}" FROM PUBLIC`);
    for (const url of [workerUrl, verifierUrl]) {
      const statement = (
        await admin.query(
          "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',$1::text,$2::text) AS sql",
          [url.username, url.password],
        )
      ).rows[0].sql;
      await admin.query(statement);
      createdRoles.push(url.username);
    }
    await provision(workerRole, 'worker');
    await provision(verifierRole, 'verification');
  });
  beforeEach(async () => {
    await owner.query('DELETE FROM account_security_events');
    await owner.query('DELETE FROM email_delivery_attempts');
    await owner.query('DELETE FROM users');
    userId = (
      await owner.query(
        "INSERT INTO users(email,email_normalized) VALUES('fixture@example.invalid','fixture@example.invalid') RETURNING id",
      )
    ).rows[0].id;
    await owner.query('INSERT INTO verification_events(user_id) VALUES($1)', [userId]);
  });
  afterAll(async () => {
    await worker.end();
    await verifier.end();
    await owner.end();
    try {
      if (created) await admin.query(`DROP DATABASE "${name}"`);
      for (const role of createdRoles) await admin.query(`DROP ROLE "${role}"`);
    } finally {
      await admin.end();
    }
  });
  async function claimed() {
    const value = await repository.claim(key);
    if (!value) throw new Error('Expected claimed fixture');
    return value;
  }
  const payload = (delivery: Awaited<ReturnType<typeof claimed>>) =>
    JSON.parse(openDeliveryPayload(delivery.envelope, delivery.eventId, [key])) as {
      token: string;
      recipient: string;
    };

  it('commits hash-only issuance and encrypted retry material before transport delivery', async () => {
    const delivery = await claimed(),
      message = payload(delivery);
    const stored = (await owner.query('SELECT * FROM email_verification_tokens')).rows;
    expect(stored).toHaveLength(1);
    expect(stored[0].digest).toBe(verificationTokenDigest(message.token));
    expect(JSON.stringify(stored).includes(message.token)).toBe(false);
    expect(
      JSON.stringify((await owner.query('SELECT * FROM email_deliveries')).rows).includes(
        message.token,
      ),
    ).toBe(false);
    expect(await repository.complete(delivery, true)).toBe(true);
    const final = (
      await owner.query('SELECT status,envelope,owner,locked_until FROM email_deliveries')
    ).rows[0];
    expect(final).toEqual({ status: 'sent', envelope: null, owner: null, locked_until: null });
    expect(
      (
        await owner.query('SELECT phase FROM email_delivery_attempts ORDER BY occurred_at,phase')
      ).rows
        .map((row) => row.phase)
        .sort(),
    ).toEqual(['claimed', 'sent']);
  });
  it('allows one live claim across independent database checkouts', async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => repository.claim(key)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await owner.query('SELECT event_id FROM email_verification_tokens')).rows).toHaveLength(
      1,
    );
  });
  it('reclaims a crashed lease with the same token and rejects the stale worker completion', async () => {
    const first = await claimed();
    await owner.query(
      "UPDATE email_deliveries SET locked_until=clock_timestamp()-interval '1 second'",
    );
    const second = await claimed();
    expect(second.owner).not.toBe(first.owner);
    expect(second.attempt).toBe(2);
    expect(payload(second).token === payload(first).token).toBe(true);
    expect(await repository.complete(first, true)).toBe(false);
    expect(await repository.complete(second, true)).toBe(true);
  });
  it('recovers a real worker-process crash after committed issuance and before delivery', async () => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./email-worker-crash.test-support.mjs', import.meta.url))],
      {
        env: { ...process.env, AUTHCORE_EMAIL_CRASH_TEST: 'true' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const exited = once(child, 'exit');
    const lines = createInterface({ input: child.stdout });
    try {
      const next = once(lines, 'line');
      child.stdin.end(
        JSON.stringify({ databaseUrl: workerUrl.toString(), key: key.key.toString('hex') }) + '\n',
      );
      const [line] = await next;
      expect(JSON.parse(line)).toEqual({ claimed: true });
      const retained = (await owner.query('SELECT envelope FROM email_deliveries')).rows[0]
        .envelope;
      child.kill('SIGKILL');
      await exited;
      await owner.query(
        "UPDATE email_deliveries SET locked_until=clock_timestamp()-interval '1 second'",
      );
      const recovered = await claimed();
      expect(recovered.envelope).toEqual(retained);
      expect(recovered.attempt).toBe(2);
      expect(
        (await owner.query('SELECT event_id FROM email_verification_tokens')).rows,
      ).toHaveLength(1);
      expect(await repository.complete(recovered, true)).toBe(true);
    } finally {
      lines.close();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
    }
  }, 15000);
  it('retains retry material and enforces database-backed backoff', async () => {
    const first = await claimed();
    expect(await repository.complete(first, false)).toBe(true);
    expect(await repository.claim(key)).toBeUndefined();
    await owner.query(
      "UPDATE email_deliveries SET next_attempt_at=clock_timestamp()-interval '1 second'",
    );
    expect(payload(await claimed()).token === payload(first).token).toBe(true);
  });
  it('retires a crashed final attempt with durable dead-letter audit', async () => {
    let delivery = await claimed();
    for (let attempt = 1; attempt < 5; attempt++) {
      await repository.complete(delivery, false);
      await owner.query(
        "UPDATE email_deliveries SET next_attempt_at=clock_timestamp()-interval '1 second'",
      );
      delivery = await claimed();
    }
    expect(delivery.attempt).toBe(5);
    await owner.query(
      "UPDATE email_deliveries SET locked_until=clock_timestamp()-interval '1 second'",
    );
    expect(await repository.claim(key)).toBeUndefined();
    expect((await owner.query('SELECT status,envelope FROM email_deliveries')).rows[0]).toEqual({
      status: 'dead',
      envelope: null,
    });
    expect(
      (await owner.query("SELECT phase FROM email_delivery_attempts WHERE phase='dead'")).rows,
    ).toHaveLength(1);
  });
  it('consumes a credential once under concurrency and atomically verifies and audits the account', async () => {
    const token = payload(await claimed()).token;
    const results = await Promise.all(
      Array.from({ length: 4 }, () => verification.consume(token, randomUUID())),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await verification.consume(token, randomUUID())).toBe(false);
    expect(
      (await owner.query('SELECT email_verified_at FROM users')).rows[0].email_verified_at,
    ).not.toBeNull();
    expect((await owner.query('SELECT event_type FROM account_security_events')).rows).toEqual([
      { event_type: 'identity.email_verified' },
    ]);
  });
  it('rejects expired, disabled and malformed credentials without verifying an account', async () => {
    const token = payload(await claimed()).token;
    expect(await verification.consume('invalid', randomUUID())).toBe(false);
    await owner.query('UPDATE users SET disabled_at=clock_timestamp()');
    expect(await verification.consume(token, randomUUID())).toBe(false);
    await owner.query('UPDATE users SET disabled_at=NULL');
    await owner.query(
      "UPDATE email_verification_tokens SET created_at=clock_timestamp()-interval '1 hour',expires_at=clock_timestamp()-interval '1 minute'",
    );
    expect(await verification.consume(token, randomUUID())).toBe(false);
    expect(
      (await owner.query('SELECT email_verified_at FROM users')).rows[0].email_verified_at,
    ).toBeNull();
    expect((await owner.query('SELECT id FROM account_security_events')).rows).toHaveLength(0);
  });
  it('rolls back token consumption and verification when the mandatory audit write fails', async () => {
    const token = payload(await claimed()).token;
    await owner.query(
      'ALTER TABLE account_security_events ADD CONSTRAINT fixture_reject CHECK(false)',
    );
    try {
      await expect(verification.consume(token, randomUUID())).rejects.toThrow();
    } finally {
      await owner.query('ALTER TABLE account_security_events DROP CONSTRAINT fixture_reject');
    }
    expect(
      (await owner.query('SELECT consumed_at FROM email_verification_tokens')).rows[0].consumed_at,
    ).toBeNull();
    expect(
      (await owner.query('SELECT email_verified_at FROM users')).rows[0].email_verified_at,
    ).toBeNull();
    expect(await verification.consume(token, randomUUID())).toBe(true);
  });
  it('denies worker account mutation, password access and token-digest access', async () => {
    for (const query of [
      'SELECT password_hash FROM password_credentials',
      'UPDATE users SET email_verified_at=clock_timestamp()',
      'SELECT digest FROM email_verification_tokens',
      'DELETE FROM verification_events',
      'DELETE FROM email_delivery_attempts',
    ])
      await expect(worker.query(query)).rejects.toMatchObject({ code: '42501' });
  });
  it('denies verification account creation, delivery payload access and audit deletion', async () => {
    for (const query of [
      "INSERT INTO users(email,email_normalized) VALUES('forbidden@example.invalid','forbidden@example.invalid')",
      'SELECT envelope FROM email_deliveries',
      'DELETE FROM account_security_events',
      "INSERT INTO email_verification_tokens(event_id,digest,expires_at) VALUES(gen_random_uuid(),repeat('a',64),clock_timestamp()+interval '1 hour')",
    ])
      await expect(verifier.query(query)).rejects.toMatchObject({ code: '42501' });
  });
  it('rejects unsafe effective PUBLIC grants during explicit provisioning', async () => {
    await owner.query('GRANT SELECT ON password_credentials TO PUBLIC');
    try {
      await expect(provision(workerRole, 'worker')).rejects.toThrow(
        'Unsafe email column privileges',
      );
    } finally {
      await owner.query('REVOKE SELECT ON password_credentials FROM PUBLIC');
    }
  });
});
