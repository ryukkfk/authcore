import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { VerificationEventRepository } from './repositories/verification-event.repository.js';

// Explicit disposable database only, never the application connection.
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
    throw new Error('Verification tests require the dedicated disposable local test cluster');
}
describe.skipIf(!source)('Durable verification PostgreSQL boundary', () => {
  const name = 'verify_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: source, connectionTimeoutMillis: 5000 });
  const target = new URL(source ?? 'postgresql://127.0.0.1:55433/authcore_test');
  target.pathname = '/' + name;
  const owner = new Pool({ connectionString: target.toString(), connectionTimeoutMillis: 5000 });
  let created = false;
  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const folder = new URL('../drizzle/', import.meta.url);
    for (const file of (await readdir(folder)).filter((x) => x.endsWith('.sql')).sort())
      await owner.query(await readFile(new URL(file, folder), 'utf8'));
  });
  afterAll(async () => {
    await owner.end();
    try {
      if (created) await admin.query(`DROP DATABASE "${name}"`);
    } finally {
      await admin.end();
    }
  });
  it('provides a durable verification event outbox after migrations', async () => {
    expect(
      (await owner.query("SELECT to_regclass('public.verification_events') AS relation")).rows[0]
        .relation,
    ).not.toBeNull();
  });
  it('rolls back notification intent with its account transaction', async () => {
    const connection = await owner.connect();
    const email = randomUUID() + '@example.invalid';
    try {
      await connection.query('BEGIN');
      const user = (
        await connection.query(
          'INSERT INTO users(email,email_normalized) VALUES($1,$1) RETURNING id',
          [email],
        )
      ).rows[0];
      await new VerificationEventRepository(drizzle(connection)).requestInitial(user.id);
      expect((await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows).toHaveLength(
        0,
      );
      await connection.query('ROLLBACK');
      expect((await owner.query('SELECT id FROM users WHERE email=$1', [email])).rows).toHaveLength(
        0,
      );
      expect((await owner.query('SELECT id FROM verification_events')).rows).toHaveLength(0);
    } finally {
      connection.release();
    }
  });
  it('retains exactly one initial intent after concurrent issuance and fresh connection reads', async () => {
    const email = randomUUID() + '@example.invalid';
    const user = (
      await owner.query('INSERT INTO users(email,email_normalized) VALUES($1,$1) RETURNING id', [
        email,
      ])
    ).rows[0];
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        new VerificationEventRepository(drizzle(owner)).requestInitial(user.id),
      ),
    );
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((x) => x.status === 'rejected')).toHaveLength(3);
    const reader = new Pool({ connectionString: target.toString() });
    try {
      const events = (
        await reader.query('SELECT * FROM verification_events WHERE user_id=$1', [user.id])
      ).rows;
      expect(events).toHaveLength(1);
      expect(Object.keys(events[0]).sort()).toEqual([
        'created_at',
        'event_type',
        'id',
        'reason',
        'user_id',
      ]);
      expect(events[0].event_type).toBe('identity.email_verification_requested');
    } finally {
      await reader.end();
    }
  });
  it('rejects orphaned intent and invalid notification kinds', async () => {
    await expect(
      owner.query('INSERT INTO verification_events(user_id) VALUES($1)', [randomUUID()]),
    ).rejects.toMatchObject({ code: '23503' });
    const email = randomUUID() + '@example.invalid';
    const user = (
      await owner.query('INSERT INTO users(email,email_normalized) VALUES($1,$1) RETURNING id', [
        email,
      ])
    ).rows[0];
    await expect(
      owner.query("INSERT INTO verification_events(user_id,event_type) VALUES($1,'unsafe')", [
        user.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      owner.query("INSERT INTO verification_events(user_id,reason) VALUES($1,'unsafe')", [user.id]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
