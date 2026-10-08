import { describe, expect, it, vi } from 'vitest';

import { passwordCredentials } from '../schema/index.js';
import {
  PasswordCredentialRepository,
  type PasswordCredentialRepositoryDatabase,
} from './password-credential.repository.js';

function setup() {
  const returning = vi.fn();
  const values = vi.fn(() => ({ returning }));
  const insert = vi.fn(() => ({ values }));
  const limit = vi.fn();
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const database = { insert, select } as unknown as PasswordCredentialRepositoryDatabase;

  return {
    repository: new PasswordCredentialRepository(database),
    insert,
    values,
    returning,
    limit,
  };
}

describe('PasswordCredentialRepository', () => {
  it('persists only the user ID and encoded hash and returns the database row', async () => {
    const { repository, insert, values, returning } = setup();
    const input = { userId: 'user-id', passwordHash: 'encoded-hash' };
    const row = { ...input, createdAt: new Date(), updatedAt: new Date() };
    returning.mockResolvedValue([row]);

    await expect(
      repository.create({
        ...input,
        ...{ password: 'never-persist-this', createdAt: new Date(0), updatedAt: new Date(0) },
      }),
    ).resolves.toBe(row);
    expect(insert).toHaveBeenCalledExactlyOnceWith(passwordCredentials);
    expect(values).toHaveBeenCalledExactlyOnceWith(input);
  });

  it('rejects an insert that unexpectedly returns no row', async () => {
    const { repository, returning } = setup();
    returning.mockResolvedValue([]);

    await expect(
      repository.create({ userId: 'user-id', passwordHash: 'encoded-hash' }),
    ).rejects.toThrow('Password credential insert returned no row');
  });

  it('propagates insert errors so the caller can roll back its transaction', async () => {
    const { repository, returning } = setup();
    const failure = new Error('insert failed');
    returning.mockRejectedValue(failure);

    await expect(
      repository.create({ userId: 'user-id', passwordHash: 'encoded-hash' }),
    ).rejects.toBe(failure);
  });

  it('returns the matching row or null for a missing credential', async () => {
    const { repository, limit } = setup();
    const row = {
      userId: 'user-id',
      passwordHash: 'encoded-hash',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    limit.mockResolvedValueOnce([row]).mockResolvedValueOnce([]);

    await expect(repository.findByUserId(row.userId)).resolves.toBe(row);
    await expect(repository.findByUserId('missing-user')).resolves.toBeNull();
  });

  it('propagates lookup failures instead of reporting a missing credential', async () => {
    const { repository, limit } = setup();
    const failure = new Error('lookup failed');
    limit.mockRejectedValue(failure);

    await expect(repository.findByUserId('user-id')).rejects.toBe(failure);
  });
});
