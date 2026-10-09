import 'reflect-metadata';

import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { hashPassword } from '@authcore/crypto';
import {
  DuplicateUserEmailError,
  PasswordCredentialRepository,
  UserRepository,
} from '@authcore/db';

import { DatabaseService } from '../database/database.service.js';
import { EmailAlreadyInUseError } from './identity.errors.js';
import { SignupService } from './signup.service.js';
import { SignupAdmission, SignupAdmissionUnavailable } from './signup-admission.js';
import { RedisService } from '../redis/redis.service.js';

vi.mock('@authcore/crypto', () => ({ hashPassword: vi.fn() }));

function setup() {
  const tx = { insert: vi.fn(), select: vi.fn() };
  const transaction = vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) =>
    callback(tx),
  );
  const database = { getClient: () => ({ db: { transaction } }) } as unknown as DatabaseService;
  const user = {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'User@Example.COM',
    emailNormalized: 'user@example.com',
    emailVerifiedAt: null,
    disabledAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const createUser = vi.spyOn(UserRepository.prototype, 'create').mockResolvedValue(user);
  const createCredential = vi
    .spyOn(PasswordCredentialRepository.prototype, 'create')
    .mockResolvedValue({
      userId: user.id,
      passwordHash: 'encoded-hash',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  const audit = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  vi.mocked(hashPassword).mockReset().mockResolvedValue('encoded-hash');
  return {
    service: new SignupService(database),
    transaction,
    user,
    createUser,
    createCredential,
    audit,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('SignupService', () => {
  it.each(['hash', 'user insert'])(
    'stops subsequent database work after lease loss during %s',
    async (stage) => {
      vi.useFakeTimers();
      const { service, transaction, createUser, createCredential, user, audit } = setup();
      const evalCommand = vi.fn().mockResolvedValueOnce(1).mockResolvedValue(0);
      const admission = new SignupAdmission({
        getClient: async () => ({ withCommandOptions: () => ({ eval: evalCommand }) }),
      } as unknown as RedisService);
      let finish!: () => void;
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      if (stage === 'hash')
        vi.mocked(hashPassword).mockImplementation(async () => {
          await gate;
          return 'encoded-hash';
        });
      else
        createUser.mockImplementation(async () => {
          await gate;
          return user;
        });
      const result = admission.run(() =>
        service.signup({ email: 'user@example.com', password: 'secret' }),
      );
      const rejected = expect(result).rejects.toBeInstanceOf(SignupAdmissionUnavailable);
      await vi.advanceTimersByTimeAsync(10_001);
      finish();
      await rejected;
      if (stage === 'hash') expect(transaction).not.toHaveBeenCalled();
      expect(createCredential).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    },
  );
  it('hashes before opening the transaction and passes only allowed fields to persistence', async () => {
    const { service, transaction, user, createUser, createCredential, audit } = setup();
    vi.mocked(hashPassword).mockImplementation(async () => {
      expect(transaction).not.toHaveBeenCalled();
      return 'encoded-hash';
    });
    const password = '  keep password whitespace  ';

    await expect(service.signup({ email: ' User@Example.COM ', password })).resolves.toEqual(user);

    expect(hashPassword).toHaveBeenCalledExactlyOnceWith(password);
    expect(transaction).toHaveBeenCalledOnce();
    expect(createUser).toHaveBeenCalledExactlyOnceWith({
      email: 'User@Example.COM',
      emailNormalized: 'user@example.com',
    });
    expect(createCredential).toHaveBeenCalledExactlyOnceWith({
      userId: user.id,
      passwordHash: 'encoded-hash',
    });
    expect(audit).toHaveBeenCalledExactlyOnceWith({
      event: 'identity.user_created',
      userId: user.id,
    });
    expect(JSON.stringify(user)).not.toContain(password);
  });

  it('does not write or emit a success audit event when hashing fails', async () => {
    const { service, transaction, audit } = setup();
    const failure = new Error('hash failure');
    vi.mocked(hashPassword).mockRejectedValue(failure);
    await expect(service.signup({ email: 'user@example.com', password: 'secret' })).rejects.toBe(
      failure,
    );
    expect(transaction).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('maps duplicate email without inserting a credential or exposing error details', async () => {
    const { service, createUser, createCredential, audit } = setup();
    createUser.mockRejectedValue(new DuplicateUserEmailError());
    const result = service.signup({ email: 'user@example.com', password: 'secret' });
    await expect(result).rejects.toBeInstanceOf(EmailAlreadyInUseError);
    await expect(result).rejects.not.toHaveProperty('cause');
    expect(createCredential).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('propagates credential failure out of the transaction without a success audit event', async () => {
    const { service, createCredential, audit } = setup();
    const failure = new Error('credential insert failed');
    createCredential.mockRejectedValue(failure);
    await expect(service.signup({ email: 'user@example.com', password: 'secret' })).rejects.toBe(
      failure,
    );
    expect(audit).not.toHaveBeenCalled();
  });

  it('does not mislabel unrelated user insert errors', async () => {
    const { service, createUser, createCredential } = setup();
    const failure = new Error('database unavailable');
    createUser.mockRejectedValue(failure);
    await expect(service.signup({ email: 'user@example.com', password: 'secret' })).rejects.toBe(
      failure,
    );
    expect(createCredential).not.toHaveBeenCalled();
  });

  it('emits no success audit event when commit fails', async () => {
    const { service, transaction, audit } = setup();
    const failure = new Error('commit failed');
    transaction.mockImplementation(async (callback) => {
      await callback({ insert: vi.fn(), select: vi.fn() });
      expect(audit).not.toHaveBeenCalled();
      throw failure;
    });
    await expect(service.signup({ email: 'user@example.com', password: 'secret' })).rejects.toBe(
      failure,
    );
    expect(audit).not.toHaveBeenCalled();
  });

  it('never logs passwords or hashes, even when a dependency includes them in an error', async () => {
    const { service, createCredential, audit } = setup();
    const otherLogs = (['error', 'warn', 'debug', 'verbose', 'fatal'] as const).map((method) =>
      vi.spyOn(Logger.prototype, method).mockImplementation(() => {}),
    );
    const password = 'private password';
    const failure = new Error(`${password}: encoded-hash`);
    createCredential.mockRejectedValue(failure);

    await expect(service.signup({ email: 'user@example.com', password })).rejects.toBe(failure);
    for (const log of [audit, ...otherLogs]) expect(log).not.toHaveBeenCalled();
  });

  it('resolves its database dependency in Nest without emitted constructor type metadata', async () => {
    const { service, transaction, user } = setup();
    const database = { getClient: () => ({ db: { transaction } }) };
    @Module({
      providers: [SignupService, { provide: DatabaseService, useValue: database }],
    })
    class SignupTestModule {}

    // The development runner does not emit design:paramtypes; @Inject must suffice.
    const metadata = Reflect.getOwnMetadata('design:paramtypes', SignupService);
    Reflect.deleteMetadata('design:paramtypes', SignupService);
    try {
      const app = await NestFactory.createApplicationContext(SignupTestModule, { logger: false });
      try {
        const injected = app.get(SignupService);
        expect(injected).not.toBe(service);
        await expect(
          injected.signup({ email: 'user@example.com', password: 'secret' }),
        ).resolves.toEqual(user);
        expect(transaction).toHaveBeenCalledOnce();
      } finally {
        await app.close();
      }
    } finally {
      if (metadata !== undefined)
        Reflect.defineMetadata('design:paramtypes', metadata, SignupService);
    }
  });
});
