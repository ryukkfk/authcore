import { createClient } from 'redis';
import { bounded } from '@authcore/testing';
import { hashPassword } from '@authcore/crypto';
import type { DatabaseClient } from '@authcore/db';
import { vi } from 'vitest';
import { RedisService } from '../redis/redis.service.js';
import { SignupAdmission } from './signup-admission.js';
import { IdempotentSignupService } from './signup-protocol.service.js';
import {
  createSignupReservationBoundary,
  type SignupReservationBoundary,
} from './signup-reservation.js';
import {
  createReservationFixture,
  testSignupConfiguration,
} from './signup-reservation.test-support.js';

export const S4_ADMISSION_KEY = 'authcore:{signup}:admission';
export async function createProtocolFixture(approved: URL) {
  const fixture = await createReservationFixture(approved);
  const raw = process.env.TEST_REDIS_URL;
  if (!raw) {
    await fixture.close();
    throw new Error('S4 disposable Redis missing');
  }
  let redisUrl: URL;
  try {
    redisUrl = new URL(raw);
  } catch {
    await fixture.close();
    throw new Error('S4 disposable Redis target malformed');
  }
  if (
    redisUrl.protocol !== 'redis:' ||
    !['localhost', '127.0.0.1'].includes(redisUrl.hostname) ||
    redisUrl.port !== '6380' ||
    redisUrl.search ||
    redisUrl.hash ||
    !['', '/'].includes(redisUrl.pathname)
  ) {
    await fixture.close();
    throw new Error('S4 disposable Redis target rejected');
  }
  // Dedicated CI-only logical DB; preserve the production fixed admission key.
  redisUrl.pathname = '/15';
  const observer = createClient({
    url: redisUrl.toString(),
    socket: { connectTimeout: 1000, reconnectStrategy: false },
  });
  let redisFault = false;
  observer.on('error', () => {
    redisFault = true;
  });
  const admissions = new Set<SignupAdmission>();
  vi.stubEnv('DATABASE_URL', fixture.runtimeUrl.toString());
  vi.stubEnv('REDIS_URL', redisUrl.toString());
  vi.stubEnv('WEB_ORIGIN', 'http://localhost:3000');
  vi.stubEnv('SIGNUP_ENABLED', 'false');
  const redis = new RedisService();
  let before: string[] = [];
  try {
    await observer.connect();
    before = (await observer.keys('*')).sort();
    if (before.length) throw new Error('S4 Redis logical DB15 must start empty');
    await redis.getClient();
  } catch (error) {
    redis.onApplicationShutdown();
    if (observer.isOpen) observer.destroy();
    await fixture.close();
    vi.unstubAllEnvs();
    throw error;
  }
  async function close() {
    const failures: unknown[] = [];
    for (const admission of admissions)
      try {
        await bounded(admission.onApplicationShutdown(), 'S4 admission shutdown', 10000);
      } catch (error) {
        failures.push(error);
      }
    redis.onApplicationShutdown();
    try {
      const after = (await observer.keys('*')).sort();
      if (JSON.stringify(after) !== JSON.stringify(before) || redisFault)
        throw new Error('S4 Redis resource inventory differs');
      console.info(
        JSON.stringify({
          scope: 'S4_REDIS',
          database: 15,
          beforeKeys: before.length,
          afterKeys: after.length,
          connectionFault: redisFault,
        }),
      );
    } catch (error) {
      failures.push(error);
    } finally {
      if (observer.isOpen) observer.destroy();
    }
    try {
      await fixture.close();
    } catch (error) {
      failures.push(error);
    } finally {
      vi.unstubAllEnvs();
    }
    if (failures.length) throw new AggregateError(failures, 'S4 fixture cleanup failed');
  }
  async function ready(
    database: DatabaseClient = fixture.runtime,
    options: {
      windowMs?: number;
      hash?: typeof hashPassword;
      boundary?: (value: SignupReservationBoundary) => SignupReservationBoundary;
      redis?: RedisService;
    } = {},
  ) {
    const original = (await createSignupReservationBoundary(database, {
      enabled: true,
      configuration: testSignupConfiguration(),
      executionWindowMs: options.windowMs ?? 86400000,
    }))!;
    const boundary = options.boundary ? options.boundary(original) : original;
    const hash = vi.fn(options.hash ?? hashPassword);
    const service = new IdempotentSignupService(database, boundary, { hashPassword: hash });
    const admission = new SignupAdmission(options.redis ?? redis);
    admissions.add(admission);
    return {
      service,
      boundary,
      hash,
      admission,
      start(rawKey: string, input: unknown, signal?: AbortSignal) {
        let operation!: ReturnType<IdempotentSignupService['start']>;
        const admitted = admission.start(async () => {
          operation = service.start(rawKey, input, signal ? { signal } : {});
          return operation.response;
        });
        return {
          response: admitted.response,
          settlement: admitted.settlement,
          get operation() {
            return operation;
          },
        };
      },
    };
  }
  return {
    ...fixture,
    redis,
    redisUrl,
    observer: {
      zRange: (key: string, start: number, stop: number): Promise<string[]> =>
        observer.zRange(key, start, stop),
    },
    admissions,
    ready,
    close,
    async drainAdmissions() {
      for (const admission of admissions)
        await bounded(admission.onApplicationShutdown(), 'S4 per-test admission drain', 10000);
      admissions.clear();
    },
    async removeOwnedCrashLeases(beforeMembers: string[]) {
      const members = await observer.zRange(S4_ADMISSION_KEY, 0, -1);
      const owned = members.filter((member) => !beforeMembers.includes(member));
      if (
        owned.some(
          (member) =>
            !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(member),
        )
      )
        throw new Error('S4 unexpected crash lease identity');
      if (owned.length) await observer.zRem(S4_ADMISSION_KEY, owned);
    },
  };
}
export type ProtocolFixture = Awaited<ReturnType<typeof createProtocolFixture>>;
