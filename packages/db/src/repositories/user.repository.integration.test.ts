import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { users } from '../schema/index.js';
import { DuplicateUserEmailError, UserRepository } from './user.repository.js';

// Opt in explicitly: never fall back to an application's DATABASE_URL.
const connectionString = process.env.TEST_DATABASE_URL;

describe.skipIf(!connectionString)('UserRepository PostgreSQL integration', () => {
  const schema = `identity_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString, connectionTimeoutMillis: 5_000 });
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 5_000,
    options: `-c search_path=${schema}`,
  });
  const db = drizzle(pool);
  const repository = new UserRepository(db);
  const input = { email: 'User@Example.COM', emailNormalized: 'user@example.com' };
  let schemaCreated = false;

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)),
      migrationsSchema: schema,
    });
  }, 15_000);

  beforeEach(async () => {
    await db.delete(users);
  });

  afterAll(async () => {
    try {
      await pool.end();
    } finally {
      try {
        if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await admin.end();
      }
    }
  });

  it('creates a user with database defaults and finds the persisted row', async () => {
    const user = await repository.create(input);

    expect(user).toMatchObject({ ...input, emailVerifiedAt: null, disabledAt: null });
    expect(user.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.updatedAt).toBeInstanceOf(Date);
    expect(await repository.findByNormalizedEmail(input.emailNormalized)).toEqual(user);
  });

  it('returns null for an unknown email and treats SQL-looking text as data', async () => {
    await repository.create(input);

    expect(await repository.findByNormalizedEmail('missing@example.com')).toBeNull();
    expect(await repository.findByNormalizedEmail("' OR 1=1 --")).toBeNull();
  });

  it('leaves normalization to the caller for both writes and reads', async () => {
    const supplied = { email: '  Mixed@Example.COM  ', emailNormalized: 'Mixed@Example.COM' };
    const user = await repository.create(supplied);

    expect(user).toMatchObject(supplied);
    expect(await repository.findByNormalizedEmail(supplied.emailNormalized)).toEqual(user);
    expect(await repository.findByNormalizedEmail('mixed@example.com')).toBeNull();
  });

  it('reports duplicate normalized email without changing the existing user or exposing PII', async () => {
    const user = await repository.create(input);
    const duplicate = repository.create({ ...input, email: 'USER@example.com' });

    await expect(duplicate).rejects.toBeInstanceOf(DuplicateUserEmailError);
    await expect(duplicate).rejects.toMatchObject({ code: 'DUPLICATE_EMAIL' });
    await expect(duplicate).rejects.not.toHaveProperty('cause');
    await expect(duplicate).rejects.not.toHaveProperty(
      'message',
      expect.stringContaining(input.emailNormalized),
    );
    expect(await repository.findByNormalizedEmail(input.emailNormalized)).toEqual(user);
  });

  it('allows exactly one concurrent create for the same normalized email', async () => {
    const results = await Promise.allSettled([
      repository.create(input),
      repository.create({ ...input, email: 'USER@EXAMPLE.COM' }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(DuplicateUserEmailError);
    expect(await db.select().from(users)).toHaveLength(1);
  });

  it('propagates unrelated database failures without labeling them duplicate email', async () => {
    const invalid = repository.create({ ...input, email: 'a'.repeat(255) });

    await expect(invalid).rejects.toBeInstanceOf(Error);
    await expect(invalid).rejects.not.toBeInstanceOf(DuplicateUserEmailError);
    await expect(invalid).rejects.toMatchObject({ cause: { code: '22001' } });
    expect(await repository.findByNormalizedEmail(input.emailNormalized)).toBeNull();
  });

  it('does not mistake a different unique constraint for a duplicate normalized email', async () => {
    await pool.query('CREATE UNIQUE INDEX test_email_unique ON users (email)');
    try {
      await repository.create(input);
      const conflicting = repository.create({ ...input, emailNormalized: 'other@example.com' });

      await expect(conflicting).rejects.not.toBeInstanceOf(DuplicateUserEmailError);
      await expect(conflicting).rejects.toMatchObject({
        cause: { code: '23505', constraint: 'test_email_unique' },
      });
    } finally {
      await pool.query('DROP INDEX test_email_unique');
    }
  });

  it('ignores privileged fields even when extra properties arrive at runtime', async () => {
    const user = await repository.create({
      ...input,
      ...{ id: randomUUID(), emailVerifiedAt: new Date(), disabledAt: new Date() },
    });

    expect(user.emailVerifiedAt).toBeNull();
    expect(user.disabledAt).toBeNull();
  });

  it('participates in a caller-owned transaction and rolls back with it', async () => {
    const rollback = new Error('intentional rollback');

    await expect(
      db.transaction(async (tx) => {
        const transactionalRepository = new UserRepository(tx);
        const user = await transactionalRepository.create(input);
        expect(await transactionalRepository.findByNormalizedEmail(input.emailNormalized)).toEqual(
          user,
        );
        throw rollback;
      }),
    ).rejects.toBe(rollback);

    expect(await repository.findByNormalizedEmail(input.emailNormalized)).toBeNull();
  });

  it('allows a caller to handle duplicate email without aborting its transaction', async () => {
    await repository.create(input);
    const other = { email: 'other@example.com', emailNormalized: 'other@example.com' };

    await db.transaction(async (tx) => {
      const transactionalRepository = new UserRepository(tx);
      await expect(transactionalRepository.create(input)).rejects.toBeInstanceOf(
        DuplicateUserEmailError,
      );
      await transactionalRepository.create(other);
    });

    expect(await repository.findByNormalizedEmail(other.emailNormalized)).toMatchObject(other);
  });
});
