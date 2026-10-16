import { describe, expect, it, vi } from 'vitest';

import type { User } from '@authcore/db';

import { IdentityService } from './identity.service.js';

function createUser(): User {
  const now = new Date();

  return {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'User@Example.com',
    emailNormalized: 'user@example.com',
    emailVerifiedAt: null,
    disabledAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function createService() {
  const userRepository = {
    findByNormalizedEmail: vi.fn(),
  };

  return {
    service: new IdentityService(userRepository),
    userRepository,
  };
}

describe('IdentityService', () => {
  it('finds a user using a normalized email', async () => {
    const { service, userRepository } = createService();
    const user = createUser();

    vi.mocked(userRepository.findByNormalizedEmail).mockResolvedValue(user);

    await expect(service.findUserByEmail(' User@Example.COM ')).resolves.toBe(user);

    expect(userRepository.findByNormalizedEmail).toHaveBeenCalledWith('user@example.com');
  });

  it('preserves a missing read result without writing a user', async () => {
    const { service, userRepository } = createService();
    userRepository.findByNormalizedEmail.mockResolvedValue(null);
    expect(await service.findUserByEmail('missing@example.com')).toBeNull();
    expect(Object.getOwnPropertyNames(IdentityService.prototype).sort()).toEqual([
      'constructor',
      'findUserByEmail',
    ]);
  });

  it('propagates lookup errors without trying an account creation fallback', async () => {
    const { service, userRepository } = createService();

    const failure = new Error('lookup unavailable');
    userRepository.findByNormalizedEmail.mockRejectedValue(failure);

    await expect(service.findUserByEmail('user@example.com')).rejects.toBe(failure);
  });
});
