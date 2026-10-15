import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { vi } from 'vitest';
import type { DatabaseClient } from '@authcore/db';
import { GlobalExceptionFilter } from '../common/filters/global-exception.filter.js';
import { DatabaseService } from '../database/database.service.js';
import { RedisService } from '../redis/redis.service.js';
import { AuthController } from './auth.controller.js';
import { SignupService, SIGNUP_CONFIGURATION } from './signup.service.js';
import { SignupAdmission } from './signup-admission.js';
import { SignupAdmissionInterceptor } from './signup-admission.interceptor.js';
import { SignupEnabledGuard } from './signup-enabled.guard.js';
import { SignupKeyGuard } from './signup-key.guard.js';
import { SignupRateLimitGuard } from './signup-rate-limit.guard.js';
import { SignupRateLimiter } from './signup-rate-limiter.js';
import { configureSignupHttp, SignupHttpAdapter } from './signup-http.js';
import { testSignupConfiguration } from './signup-reservation.test-support.js';
import type { ProtocolFixture } from './signup-protocol.test-support.js';

export async function startSignupHttp(
  f: ProtocolFixture,
  database: DatabaseClient = f.database(),
  enabled = true,
) {
  const namespace = 'authcore:test:{signup-s5-' + randomUUID() + '}';
  const keys = new Set<string>();
  let rateCalls = 0;
  let admissionAcquires = 0;
  const evalCommand = async (script: string, args: { keys: string[]; arguments: string[] }) => {
    const mapped = args.keys.map((key) => {
      if (!key.startsWith('authcore:{signup}:')) throw new Error('S5 Redis key rejected');
      const owned = namespace + ':' + key.slice('authcore:{signup}:'.length);
      keys.add(owned);
      return owned;
    });
    if (script.includes('ipLimit')) rateCalls++;
    if (script.includes('ZCARD')) admissionAcquires++;
    const client = await f.redis.getClient();
    return client.withCommandOptions({ timeout: 1000 }).eval(script, { ...args, keys: mapped });
  };
  const redis = {
    getClient: async () => ({
      eval: evalCommand,
      withCommandOptions: () => ({ eval: evalCommand }),
    }),
  };
  const admission = new SignupAdmission(redis as unknown as RedisService);
  f.admissions.add(admission);
  @Module({
    controllers: [AuthController],
    providers: [
      SignupService,
      SignupEnabledGuard,
      SignupKeyGuard,
      SignupRateLimitGuard,
      SignupRateLimiter,
      SignupAdmissionInterceptor,
      { provide: SignupAdmission, useValue: admission },
      { provide: RedisService, useValue: redis },
      { provide: DatabaseService, useValue: { getClient: () => database } },
      {
        provide: SIGNUP_CONFIGURATION,
        useValue: { hmac: testSignupConfiguration(), executionWindowMs: 86400000 },
      },
    ],
  })
  class HttpFixtureModule {}
  vi.stubEnv('SIGNUP_ENABLED', enabled ? 'true' : 'false');
  const app = await NestFactory.create(HttpFixtureModule, new SignupHttpAdapter(), {
    logger: false,
    bodyParser: false,
  });
  try {
    configureSignupHttp(app);
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
        validationError: { target: false, value: false },
      }),
    );
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.listen(0, '127.0.0.1');
  } catch (error) {
    await app.close();
    throw error;
  } finally {
    vi.stubEnv('SIGNUP_ENABLED', 'false');
  }
  const url = await app.getUrl();
  const clearOwnedRate = async () => {
    const client = await f.redis.getClient();
    for (const key of keys) if (!key.endsWith(':admission')) await client.del(key);
  };
  return {
    app,
    database,
    url,
    admission,
    get rateCalls() {
      return rateCalls;
    },
    get admissionAcquires() {
      return admissionAcquires;
    },
    clearOwnedRate,
    async close() {
      await app.close();
      if (admission.inventory().active || admission.inventory().owners)
        throw new Error('S5 admission retained');
      const client = await f.redis.getClient();
      for (const key of keys) {
        await client.del(key);
        if (await client.exists(key)) throw new Error('S5 owned Redis key retained');
      }
    },
  };
}
