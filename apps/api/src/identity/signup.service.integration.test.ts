import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import { Logger } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { verifyPassword } from '@authcore/crypto';
import { createDatabaseClient, PasswordCredentialRepository, UserRepository } from '@authcore/db';

import type { DatabaseService } from '../database/database.service.js';
import { EmailAlreadyInUseError } from './identity.errors.js';
import { SignupService } from './signup.service.js';

// Explicit opt-in only. Never use DATABASE_URL or application tables for tests.
const connectionString = process.env.TEST_DATABASE_URL;

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
    await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;
    // Apply the unchanged checked-in SQL, including its public.users foreign key.
    const folder = new URL('../../../../packages/db/drizzle/', import.meta.url);
    const migrations = (await readdir(folder)).filter((name) => name.endsWith('.sql')).sort();
    for (const name of migrations) {
      await client.pool.query(await readFile(new URL(name, folder), 'utf8'));
    }
  }, 15_000);

  beforeEach(async () => {
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

  it('commits a normalized user and verifiable Argon2id credential without plaintext', async () => {
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
  });

  it('rolls back the user when PostgreSQL rejects its credential insert', async () => {
    await client.pool.query(
      'ALTER TABLE password_credentials ADD CONSTRAINT reject_test_credential CHECK (false)',
    );
    try {
      await expect(service.signup(input)).rejects.toMatchObject({ cause: { code: '23514' } });
      expect(await users.findByNormalizedEmail('user@example.com')).toBeNull();
      expect((await client.pool.query('SELECT * FROM password_credentials')).rows).toHaveLength(0);
      expect(Logger.prototype.log).not.toHaveBeenCalled();
    } finally {
      await client.pool.query(
        'ALTER TABLE password_credentials DROP CONSTRAINT reject_test_credential',
      );
    }
    // A failed signup must not poison later transactions or claim the email.
    await expect(service.signup(input)).resolves.toHaveProperty('id');
  });
});
