import 'reflect-metadata';

import type { AddressInfo } from 'node:net';

import { type INestApplication, Logger, Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as passwordCrypto from '@authcore/crypto';

import { DatabaseService } from '../database/database.service.js';
import { GlobalExceptionFilter } from '../common/filters/global-exception.filter.js';
import { AuthController } from './auth.controller.js';
import { EmailAlreadyInUseError } from './identity.errors.js';
import { SignupService } from './signup.service.js';

const signup = vi.fn();
const transaction = vi.fn();

@Module({
  controllers: [AuthController],
  providers: [
    SignupService,
    {
      provide: DatabaseService,
      useValue: { getClient: () => ({ db: { transaction } }) },
    },
  ],
})
class DisabledSignupHttpTestModule {}

@Module({
  controllers: [AuthController],
  providers: [
    {
      provide: SignupService,
      useValue: { signup },
    },
  ],
})
class SignupHttpTestModule {}

let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  // Synthetic test configuration only; never load the developer's .env.
  vi.stubEnv('DATABASE_URL', 'postgresql://localhost/authcore_test');
  vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
  vi.stubEnv('WEB_ORIGIN', 'http://localhost:3000');
  vi.stubEnv('SIGNUP_ENABLED', 'true');
  app = await NestFactory.create(SignupHttpTestModule, {
    logger: false,
  });

  app.setGlobalPrefix('api/v1');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: false,
      },
      validationError: {
        target: false,
        value: false,
      },
    }),
  );

  app.useGlobalFilters(new GlobalExceptionFilter());

  await app.listen(0, '127.0.0.1');

  const address = app.getHttpServer().address() as AddressInfo;

  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app?.close();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  signup.mockReset();
});

async function sendSignup(body: unknown) {
  return fetch(`${baseUrl}/api/v1/auth/signup`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

const validInput = {
  email: 'User@Example.COM',
  password: 'correct horse battery staple',
};

describe('POST /api/v1/auth/signup', () => {
  it.each([undefined, 'false'])(
    'rejects signup before hashing or database access with flag %s',
    async (flag) => {
      vi.stubEnv('SIGNUP_ENABLED', flag);
      const hash = vi.spyOn(passwordCrypto, 'hashPassword').mockResolvedValue('test-encoded-hash');
      transaction.mockReset().mockRejectedValue(new Error('Database access is forbidden'));
      let disabledApp: INestApplication | undefined;
      try {
        disabledApp = await NestFactory.create(DisabledSignupHttpTestModule, { logger: false });
        disabledApp.setGlobalPrefix('api/v1');
        disabledApp.useGlobalPipes(
          new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
        );
        disabledApp.useGlobalFilters(new GlobalExceptionFilter());
        await disabledApp.listen(0, '127.0.0.1');
        const disabledUrl = await disabledApp.getUrl();
        // Both valid and invalid DTOs receive the same disabled response.
        for (const body of [validInput, { email: 'invalid', password: 'x', role: 'admin' }]) {
          const response = await fetch(`${disabledUrl}/api/v1/auth/signup`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          expect(response.status).toBe(403);
          expect(await response.json()).toEqual({
            error: { code: 'HTTP_403', message: 'Signup is disabled' },
          });
        }
        expect(hash).not.toHaveBeenCalled();
        expect(transaction).not.toHaveBeenCalled();
      } finally {
        await disabledApp?.close();
        hash.mockRestore();
        vi.stubEnv('SIGNUP_ENABLED', 'true');
      }
    },
  );

  it.each([12, 128])(
    'accepts a password at the %i-character boundary when enabled',
    async (length) => {
      signup.mockResolvedValue(undefined);
      const password = 'x'.repeat(length);
      const response = await sendSignup({ ...validInput, password });
      expect(response.status).toBe(202);
      expect(signup).toHaveBeenCalledExactlyOnceWith({ ...validInput, password });
    },
  );

  it.each([11, 129])('rejects a password of %i characters before signup', async (length) => {
    const response = await sendSignup({ ...validInput, password: 'x'.repeat(length) });
    expect(response.status).toBe(400);
    expect(signup).not.toHaveBeenCalled();
  });

  it.each([null, 123456789012, {}, []])(
    'rejects non-string passwords before signup: %j',
    async (password) => {
      const response = await sendSignup({ ...validInput, password });
      expect(response.status).toBe(400);
      expect(signup).not.toHaveBeenCalled();
    },
  );

  it('does not log sensitive query strings on unexpected errors', async () => {
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    signup.mockRejectedValue(new Error('private dependency details'));
    try {
      const response = await fetch(
        `${baseUrl}/api/v1/auth/signup?token=query-secret-sentinel&password=query-password-sentinel`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(validInput),
        },
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' },
      });
      expect(log).toHaveBeenCalledExactlyOnceWith({
        event: 'http.unhandled_exception',
        method: 'POST',
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain('query-secret-sentinel');
      expect(JSON.stringify(log.mock.calls)).not.toContain('query-password-sentinel');
      expect(JSON.stringify(log.mock.calls)).not.toContain('private dependency details');
    } finally {
      log.mockRestore();
    }
  });

  it('returns HTTP 202 for valid signup', async () => {
    signup.mockResolvedValue(undefined);

    const response = await sendSignup(validInput);

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      status: 'accepted',
    });

    expect(signup).toHaveBeenCalledWith(validInput);
  });

  it('returns the same response for duplicate email', async () => {
    signup.mockResolvedValueOnce(undefined);

    const success = await sendSignup(validInput);
    const successBody = await success.text();

    signup.mockRejectedValueOnce(new EmailAlreadyInUseError());

    const duplicate = await sendSignup(validInput);
    const duplicateBody = await duplicate.text();

    expect(success.status).toBe(202);
    expect(duplicate.status).toBe(202);
    expect(duplicateBody).toBe(successBody);
  });

  it('rejects invalid email', async () => {
    const response = await sendSignup({
      ...validInput,
      email: 'not-an-email',
    });

    expect(response.status).toBe(400);
    expect(signup).not.toHaveBeenCalled();
  });

  it('rejects short passwords', async () => {
    const response = await sendSignup({
      ...validInput,
      password: 'short',
    });

    expect(response.status).toBe(400);
    expect(signup).not.toHaveBeenCalled();
  });

  it('rejects unexpected request properties', async () => {
    const response = await sendSignup({
      ...validInput,
      role: 'admin',
    });

    expect(response.status).toBe(400);
    expect(signup).not.toHaveBeenCalled();
  });

  it('does not modify password whitespace', async () => {
    signup.mockResolvedValue(undefined);

    const password = '  correct horse battery staple  ';

    const response = await sendSignup({
      email: ' User@Example.COM ',
      password,
    });

    expect(response.status).toBe(202);

    expect(signup).toHaveBeenCalledWith({
      email: 'User@Example.COM',
      password,
    });
  });

  it('sanitizes unexpected server errors', async () => {
    signup.mockRejectedValue(new Error('Sensitive database connection details'));

    const response = await sendSignup(validInput);
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toContain('INTERNAL_SERVER_ERROR');
    expect(body).not.toContain('Sensitive database connection details');
    expect(body).not.toContain(validInput.password);
  });
});
