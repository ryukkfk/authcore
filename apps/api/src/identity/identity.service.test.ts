import { describe, expect, it, vi } from 'vitest';

import {
  DuplicateUserEmailError,
  UserRepository,
  type User,
} from '@authcore/db';

import { EmailAlreadyInUseError } from './identity.errors.js';
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
    create: vi.fn(),
  } as unknown as UserRepository;

  return {
    service: new IdentityService(userRepository),
    userRepository,
  };
}

describe('IdentityService', () => {
  it('finds a user using a normalized email', async () => {
    const { service, userRepository } = createService();
    const user = createUser();

    vi.mocked(
      userRepository.findByNormalizedEmail,
    ).mockResolvedValue(user);

    await expect(
      service.findUserByEmail(' User@Example.COM '),
    ).resolves.toBe(user);

    expect(
      userRepository.findByNormalizedEmail,
    ).toHaveBeenCalledWith('user@example.com');
  });

  it('creates a user with normalized lookup email', async () => {
    const { service, userRepository } = createService();
    const user = createUser();

    vi.mocked(userRepository.create).mockResolvedValue(user);

    await expect(
      service.createUser(' User@Example.COM '),
    ).resolves.toBe(user);

    expect(userRepository.create).toHaveBeenCalledWith({
      email: 'User@Example.COM',
      emailNormalized: 'user@example.com',
    });
  });

  it('translates duplicate database errors', async () => {
    const { service, userRepository } = createService();

    vi.mocked(userRepository.create).mockRejectedValue(
      new DuplicateUserEmailError(),
    );

    await expect(
      service.createUser('user@example.com'),
    ).rejects.toBeInstanceOf(EmailAlreadyInUseError);
  });
});