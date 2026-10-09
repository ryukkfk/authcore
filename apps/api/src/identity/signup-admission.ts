import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';

import { RedisService } from '../redis/redis.service.js';

export const SIGNUP_CONCURRENCY = 4;
export const SIGNUP_LEASE_MS = 30_000;
export const SIGNUP_RENEW_MS = 10_000;
const KEY = 'authcore:{signup}:admission';

// Redis time avoids clock skew between API instances. Expired owners cannot renew.
const TIME = `local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
`;
const ACQUIRE = `${TIME}
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[3]), ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return 1`;
const RENEW = `${TIME}
local expiry = tonumber(redis.call('ZSCORE', KEYS[1], ARGV[1]) or '0')
if expiry <= now then return 0 end
redis.call('ZADD', KEYS[1], 'XX', now + tonumber(ARGV[3]), ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return 1`;
const RELEASE = `return redis.call('ZREM', KEYS[1], ARGV[1])`;

const leaseContext = new AsyncLocalStorage<() => void>();

export function assertSignupLease(): void {
  // Internal service callers remain supported; HTTP signup always supplies a lease.
  leaseContext.getStore()?.();
}

export class SignupAdmissionUnavailable extends ServiceUnavailableException {
  constructor() {
    super('Signup temporarily unavailable');
  }
}

@Injectable()
export class SignupAdmission {
  // Keep local capacity occupied until actual work settles, even after lease loss.
  private active = 0;

  constructor(@Inject(RedisService) private readonly redis: RedisService) {}

  private async command(script: string, token: string): Promise<number> {
    const client = await this.redis.getClient();
    const reply = await client.withCommandOptions({ timeout: 1000 }).eval(script, {
      keys: [KEY],
      arguments: [token, String(SIGNUP_CONCURRENCY), String(SIGNUP_LEASE_MS)],
    });
    if (reply !== 0 && reply !== 1) throw new SignupAdmissionUnavailable();
    return reply;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= SIGNUP_CONCURRENCY) throw new SignupAdmissionUnavailable();
    this.active++;
    const token = randomUUID();
    let acquired: boolean;
    let lost = false;
    let deadline = performance.now() + SIGNUP_LEASE_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let renewal: Promise<void> | undefined;
    let stopped = false;
    const assertActive = () => {
      if (lost || performance.now() >= deadline) throw new SignupAdmissionUnavailable();
    };
    const schedule = () => {
      timer = setTimeout(() => {
        renewal = (async () => {
          const started = performance.now();
          try {
            assertActive();
            if ((await this.command(RENEW, token)) !== 1) throw new SignupAdmissionUnavailable();
            // Never revive a locally expired lease, even if a delayed reply arrives.
            assertActive();
            deadline = started + SIGNUP_LEASE_MS;
          } catch {
            lost = true;
          }
          if (!stopped && !lost) schedule();
        })();
      }, SIGNUP_RENEW_MS);
      timer.unref();
    };
    try {
      try {
        acquired = (await this.command(ACQUIRE, token)) === 1;
      } catch {
        throw new SignupAdmissionUnavailable();
      }
      if (!acquired) throw new SignupAdmissionUnavailable();
      assertActive();
      schedule();
      return await leaseContext.run(assertActive, work);
    } finally {
      stopped = true;
      clearTimeout(timer);
      await renewal;
      // An acquire timeout has an unknown outcome. Releasing this unique token is
      // harmless; TTL is the final fallback if Redis is still unavailable.
      try {
        await this.command(RELEASE, token);
      } catch {
        // Never mask a committed success or the original operation failure.
      }
      this.active--;
    }
  }
}
