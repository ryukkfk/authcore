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

interface LeaseContext {
  assertActive(): void;
  signal: AbortSignal;
  retained: Set<Promise<void>>;
  retentionFaults: number;
  open: boolean;
}
const leaseContext = new AsyncLocalStorage<LeaseContext>();
export function requireSignupAdmission(): Readonly<{ signal: AbortSignal; assertActive(): void }> {
  const context = leaseContext.getStore();
  if (!context?.open) throw new SignupAdmissionUnavailable();
  context.assertActive();
  return Object.freeze({ signal: context.signal, assertActive: context.assertActive });
}
export function retainSignupWorkSettlement(pending: Promise<unknown>): void {
  const context = leaseContext.getStore();
  if (!context?.open) throw new SignupAdmissionUnavailable();
  const observed = Promise.resolve(pending).then(
    () => {},
    () => {
      context.retentionFaults++;
    },
  );
  context.retained.add(observed);
}

export function assertSignupLease(): void {
  // Internal service callers remain supported; HTTP signup always supplies a lease.
  leaseContext.getStore()?.assertActive();
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
  private closing = false;
  private cleanupFaults = 0;
  private readonly owners = new Set<{ signal: AbortController; settlement: Promise<void> }>();

  inventory() {
    return Object.freeze({
      active: this.active,
      owners: this.owners.size,
      cleanupFaults: this.cleanupFaults,
      closing: this.closing,
    });
  }

  async onApplicationShutdown(): Promise<void> {
    this.closing = true;
    for (const owner of this.owners) owner.signal.abort();
    await Promise.all([...this.owners].map((owner) => owner.settlement));
  }

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
    const operation = this.start(work);
    try {
      return await operation.response;
    } finally {
      await operation.settlement;
    }
  }

  /** An early proven response never releases admission before retained work settles. */
  start<T>(work: () => Promise<T>): { response: Promise<T>; settlement: Promise<void> } {
    if (this.closing || this.active >= SIGNUP_CONCURRENCY) throw new SignupAdmissionUnavailable();
    let resolveResponse!: (value: T) => void;
    let rejectResponse!: (error: unknown) => void;
    const response = new Promise<T>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    void response.catch(() => {});
    const cancellation = new AbortController();
    const context: LeaseContext = {
      assertActive: () => {},
      signal: cancellation.signal,
      retained: new Set(),
      retentionFaults: 0,
      open: true,
    };

    this.active++;
    const token = randomUUID();
    let acquired: boolean;
    let lost = false;
    let deadline = performance.now() + SIGNUP_LEASE_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let renewal: Promise<void> | undefined;
    let stopped = false;
    const assertActive = () => {
      if (this.closing || cancellation.signal.aborted || lost || performance.now() >= deadline) {
        cancellation.abort();
        throw new SignupAdmissionUnavailable();
      }
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
            cancellation.abort();
          }
          if (!stopped && !lost) schedule();
        })();
      }, SIGNUP_RENEW_MS);
      timer.unref();
    };
    context.assertActive = assertActive;
    const execute = async () => {
      try {
        try {
          acquired = (await this.command(ACQUIRE, token)) === 1;
        } catch {
          throw new SignupAdmissionUnavailable();
        }
        if (!acquired) throw new SignupAdmissionUnavailable();
        assertActive();
        schedule();
        const value = await leaseContext.run(context, work);
        resolveResponse(value);
      } catch (error) {
        rejectResponse(error);
      } finally {
        context.open = false;
        // Renewal and local capacity remain owned through native work and quarantined cleanup.
        await Promise.all([...context.retained]);
        this.cleanupFaults += context.retentionFaults;
        stopped = true;
        clearTimeout(timer);
        await renewal;
        // An acquire timeout has an unknown outcome. Releasing this unique token is
        // harmless; TTL is the final fallback if Redis is still unavailable.
        try {
          await this.command(RELEASE, token);
        } catch {
          this.cleanupFaults++;
          // Never mask a committed success or the original operation failure.
        }
        this.active--;
      }
    };
    const owner = { signal: cancellation, settlement: Promise.resolve() };
    const settlement = execute();
    owner.settlement = settlement;
    this.owners.add(owner);
    void settlement.then(
      () => this.owners.delete(owner),
      () => {
        this.cleanupFaults++;
        this.owners.delete(owner);
      },
    );
    return Object.freeze({ response, settlement });
  }
}
