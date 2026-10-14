import 'reflect-metadata';

import type { AddressInfo } from 'node:net';

import { type INestApplication, Logger, Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as passwordCrypto from '@authcore/crypto';

import { DatabaseService } from '../database/database.service.js';
import { GlobalExceptionFilter } from '../common/filters/global-exception.filter.js';
import { AuthController } from './auth.controller.js';
import { EmailAlreadyInUseError } from './identity.errors.js';
import { SignupService } from './signup.service.js';
import { SignupEnabledGuard } from './signup-enabled.guard.js';
import { SignupRateLimitGuard } from './signup-rate-limit.guard.js';
import { SignupRateLimiter } from './signup-rate-limiter.js';
import { RedisService } from '../redis/redis.service.js';
import { assertSignupLease, SignupAdmission } from './signup-admission.js';
import { SignupAdmissionInterceptor } from './signup-admission.interceptor.js';

const signup = vi.fn();
const transaction = vi.fn();
const consume = vi.fn();
const admissionEval = vi.fn();
const admissionClient = { withCommandOptions: () => ({ eval: admissionEval }) };
const admissionProviders = [
  SignupAdmission,
  SignupAdmissionInterceptor,
  { provide: RedisService, useValue: { getClient: async () => admissionClient } },
];

const rateLimitProvider = {
  provide: SignupRateLimiter,
  useValue: { consume },
};

// Test module for disabled signup
@Module({
  controllers: [AuthController],
  providers: [
    SignupService,
    SignupEnabledGuard,
    SignupRateLimitGuard,
    rateLimitProvider,
    ...admissionProviders,
    {
      provide: DatabaseService,
      useValue: {
        getClient: () => ({
          db: { transaction },
        }),
      },
    },
  ],
})
class DisabledSignupHttpTestModule {}

// Test module for enabled signup
@Module({
  controllers: [AuthController],
  providers: [
    SignupEnabledGuard,
    SignupRateLimitGuard,
    rateLimitProvider,
    ...admissionProviders,
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
  // Preload the real HTTP adapter during module import; retain the strict hook deadline.
  app = await NestFactory.create(SignupHttpTestModule, new ExpressAdapter(), {
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
  admissionEval.mockReset().mockResolvedValue(1);
  signup.mockReset();

  consume.mockReset();
  consume.mockResolvedValue({
    allowed: true,
    retryAfterSeconds: 0,
  });
});

async function sendSignup(body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/api/v1/auth/signup`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const validInput = {
  email: 'User@Example.COM',
  password: 'correct horse battery staple',
};

describe('POST /api/v1/auth/signup', () => {
  it('propagates lease loss through the real HTTP async context and recovers capacity', async () => {
    let entered!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    // Fake only renewal timers; HTTP sockets and monotonic time remain real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    admissionEval.mockResolvedValueOnce(1).mockResolvedValueOnce(0).mockResolvedValue(1);
    signup.mockImplementation(async () => {
      entered();
      await gate;
      assertSignupLease();
    });
    const pending = sendSignup(validInput);
    try {
      await started;
      await vi.advanceTimersByTimeAsync(10_001);
      expect(admissionEval).toHaveBeenCalledTimes(2);
      finish();
      const response = await pending;
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('1');
      expect(await response.json()).toEqual({
        error: { code: 'HTTP_503', message: 'Signup temporarily unavailable' },
      });
      expect(admissionEval).toHaveBeenCalledTimes(3);
    } finally {
      finish();
      vi.useRealTimers();
      await pending;
    }
    signup.mockResolvedValue(undefined);
    expect((await sendSignup(validInput)).status).toBe(202);
  });

  it('rejects excess concurrent HTTP requests while keeping four operations admitted', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    signup.mockImplementation(() => gate);
    const admitted = Array.from({ length: 4 }, () => sendSignup(validInput));
    try {
      await expect.poll(() => signup.mock.calls.length).toBe(4);
      const overload = await sendSignup(validInput);
      expect(overload.status).toBe(503);
      expect(overload.headers.get('retry-after')).toBe('1');
      expect(signup).toHaveBeenCalledTimes(4);
      expect(admissionEval).toHaveBeenCalledTimes(4);
    } finally {
      finish();
      const responses = await Promise.all(admitted);
      expect(responses.map((response) => response.status)).toEqual([202, 202, 202, 202]);
    }
    expect(admissionEval).toHaveBeenCalledTimes(8);
  });
  it.each([undefined, 'false'])(
    'rejects signup before hashing or database access with flag %s',
    async (flag) => {
      vi.stubEnv('SIGNUP_ENABLED', flag);
      consume.mockRejectedValue(new Error('Rate limiter must not run when signup is disabled'));
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
        expect(consume).not.toHaveBeenCalled();
        expect(admissionEval).not.toHaveBeenCalled();
        expect(hash).not.toHaveBeenCalled();
        expect(transaction).not.toHaveBeenCalled();
      } finally {
        await disabledApp?.close();
        hash.mockRestore();
        vi.stubEnv('SIGNUP_ENABLED', 'true');
      }
    },
  );

  it.each([
    ['valid', validInput],
    ['invalid', { email: 'invalid', password: 'x', role: 'admin' }],
  ])(
    'returns sanitized HTTP 429 before signup or validation for a %s DTO',
    async (_label, input) => {
      consume.mockResolvedValue({ allowed: false, retryAfterSeconds: 42 });

      const response = await sendSignup(input);

      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('42');
      expect(await response.json()).toEqual({
        error: { code: 'HTTP_429', message: 'Too many requests' },
      });
      expect(consume).toHaveBeenCalledExactlyOnceWith('127.0.0.1');
      expect(signup).not.toHaveBeenCalled();
      expect(admissionEval).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['valid', validInput],
    ['invalid', { email: 'invalid', password: 'x', role: 'admin' }],
  ])(
    'fails closed with sanitized HTTP 503 for a %s DTO when Redis fails',
    async (_label, input) => {
      const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      consume.mockRejectedValue(new Error('Redis connection failed: redis://private-credentials'));
      try {
        const response = await sendSignup(input);

        expect(response.status).toBe(503);
        expect(response.headers.get('retry-after')).toBeNull();
        expect(await response.json()).toEqual({
          error: { code: 'HTTP_503', message: 'Signup temporarily unavailable' },
        });
        expect(consume).toHaveBeenCalledExactlyOnceWith('127.0.0.1');
        expect(signup).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();
      } finally {
        log.mockRestore();
      }
    },
  );

  it.each(['203.0.113.99', '203.0.113.99, 198.51.100.10'])(
    'uses the socket peer instead of untrusted X-Forwarded-For: %s',
    async (forwardedFor) => {
      signup.mockResolvedValue(undefined);

      const response = await sendSignup(validInput, { 'x-forwarded-for': forwardedFor });

      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ status: 'accepted' });
      // The HTTP server listens on IPv4 loopback, so this is the actual socket peer.
      expect(consume).toHaveBeenCalledExactlyOnceWith('127.0.0.1');
      expect(signup).toHaveBeenCalledExactlyOnceWith(validInput);
      expect(consume.mock.invocationCallOrder[0]).toBeLessThan(signup.mock.invocationCallOrder[0]!);
    },
  );

  it('consumes rate limit before DTO validation rejects an allowed request', async () => {
    const response = await sendSignup({ email: 'invalid', password: 'x', role: 'admin' });

    expect(response.status).toBe(400);
    expect(response.headers.get('retry-after')).toBeNull();
    expect(await response.json()).toMatchObject({ error: { code: 'HTTP_400' } });
    expect(consume).toHaveBeenCalledExactlyOnceWith('127.0.0.1');
    expect(signup).not.toHaveBeenCalled();
  });

  it.each(['full', 'unavailable'])(
    'sanitizes admission %s as 503 with a one-second retry hint',
    async (reason) => {
      if (reason === 'full') admissionEval.mockResolvedValue(0);
      else admissionEval.mockRejectedValue(new Error('private Redis credentials'));
      const response = await sendSignup(validInput);
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('1');
      expect(await response.json()).toEqual({
        error: { code: 'HTTP_503', message: 'Signup temporarily unavailable' },
      });
      expect(signup).not.toHaveBeenCalled();
    },
  );

  it.each(['success', 'duplicate', 'validation', 'exception'])(
    'releases the owned admission token after %s',
    async (outcome) => {
      if (outcome === 'duplicate') signup.mockRejectedValue(new EmailAlreadyInUseError());
      else if (outcome === 'exception') signup.mockRejectedValue(new Error('unexpected'));
      else signup.mockResolvedValue(undefined);
      const response = await sendSignup(
        outcome === 'validation' ? { email: 'invalid' } : validInput,
      );
      expect(response.status).toBe(
        outcome === 'validation' ? 400 : outcome === 'exception' ? 500 : 202,
      );
      expect(admissionEval).toHaveBeenCalledTimes(2);
      const acquire = admissionEval.mock.calls[0]!;
      const release = admissionEval.mock.calls[1]!;
      expect(release[0]).toContain('ZREM');
      expect(release[1].arguments[0]).toBe(acquire[1].arguments[0]);
      if (outcome === 'validation') expect(signup).not.toHaveBeenCalled();
    },
  );

  it('holds admission until the signup promise actually settles', async () => {
    let finish!: () => void;
    signup.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const request = sendSignup(validInput);
    await expect.poll(() => signup.mock.calls.length).toBe(1);
    expect(admissionEval).toHaveBeenCalledTimes(1);
    finish();
    expect((await request).status).toBe(202);
    expect(admissionEval).toHaveBeenCalledTimes(2);
  });

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
