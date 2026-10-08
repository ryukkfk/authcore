import { describe, expect, it } from 'vitest';

import {
  hashPassword,
  verifyPassword,
} from './password.js';

describe('password hashing', () => {
  it('hashes passwords with Argon2id', async () => {
    const password = 'correct horse battery staple';

    const hash = await hashPassword(password);

    expect(hash).not.toBe(password);
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).toContain('m=65536,p=1,t=3');
  });

  it('verifies the correct password', async () => {
    const password = 'correct horse battery staple';
    const hash = await hashPassword(password);

    await expect(
      verifyPassword(hash, password),
    ).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword(
      'correct horse battery staple',
    );

    await expect(
      verifyPassword(hash, 'incorrect password'),
    ).resolves.toBe(false);
  });

  it('produces different hashes for the same password', async () => {
    const password = 'correct horse battery staple';

    const first = await hashPassword(password);
    const second = await hashPassword(password);

    expect(first).not.toBe(second);
  });

  it('rejects malformed hashes safely', async () => {
    await expect(
      verifyPassword('not-an-argon2-hash', 'password'),
    ).resolves.toBe(false);
  });
});