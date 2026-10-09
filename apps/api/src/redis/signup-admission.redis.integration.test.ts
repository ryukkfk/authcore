import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertSignupLease,
  SignupAdmission,
  SignupAdmissionUnavailable,
} from '../identity/signup-admission.js';
import { RedisService } from './redis.service.js';

if (process.env.TEST_REDIS_URL !== 'redis://127.0.0.1:6380') {
  throw new Error('Set TEST_REDIS_URL=redis://127.0.0.1:6380 for the isolated test container');
}

describe('Real Redis signup admission', () => {
  let services: RedisService[];
  let key: string;
  let client: Awaited<ReturnType<RedisService['getClient']>>;
  let scripts: Record<string, string>;

  function instance() {
    const service = new RedisService();
    services.push(service);
    const adapter = {
      async getClient() {
        const real = await service.getClient();
        return {
          withCommandOptions(options: { timeout: number }) {
            return {
              eval(script: string, args: { keys: string[]; arguments: string[] }) {
                expect(args.keys).toEqual(['authcore:{signup}:admission']);
                const kind = script.includes('ZCARD')
                  ? 'acquire'
                  : script.includes('ZSCORE')
                    ? 'renew'
                    : 'release';
                scripts[kind] = script;
                return real.withCommandOptions(options).eval(script, { ...args, keys: [key] });
              },
            };
          },
        };
      },
    } as unknown as RedisService;
    return new SignupAdmission(adapter);
  }

  beforeEach(async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('DATABASE_URL', 'postgresql://unused:unused@127.0.0.1:1/unused');
    vi.stubEnv('WEB_ORIGIN', 'http://127.0.0.1');
    vi.stubEnv('SIGNUP_ENABLED', 'false');
    vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:6380');
    services = [];
    scripts = {};
    key = `authcore:test:{signup-${randomUUID()}}:admission`;
    const cleanup = new RedisService();
    services.push(cleanup);
    client = await cleanup.getClient();
    expect(await client.ping()).toBe('PONG');
  });

  afterEach(async () => {
    try {
      await client.del(key);
      expect(await client.exists(key)).toBe(0);
    } finally {
      for (const service of services) service.onApplicationShutdown();
      vi.unstubAllEnvs();
    }
  });

  it('admits exactly four concurrent requests across twenty independent API clients', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let entered = 0;
    let rejected = 0;
    const pending = Array.from({ length: 20 }, () =>
      instance()
        .run(async () => {
          entered++;
          await gate;
        })
        .catch((error: unknown) => {
          expect(error).toBeInstanceOf(SignupAdmissionUnavailable);
          rejected++;
        }),
    );
    try {
      await expect.poll(() => entered + rejected).toBe(20);
      expect(entered).toBe(4);
      expect(rejected).toBe(16);
      expect(await client.zCard(key)).toBe(4);
      expect(await client.pTTL(key)).toBeGreaterThan(25_000);
    } finally {
      finish();
      await Promise.all(pending);
    }
    expect(await client.zCard(key)).toBe(0);
    await expect(instance().run(async () => 'reused')).resolves.toBe('reused');
  });

  it.each(['success', 'failure'])('releases the exact token on %s', async (outcome) => {
    const admission = instance();
    const work = admission.run(async () => {
      expect(await client.zCard(key)).toBe(1);
      if (outcome === 'failure') throw new Error('synthetic failure');
      return 42;
    });
    if (outcome === 'failure') await expect(work).rejects.toThrow('synthetic failure');
    else await expect(work).resolves.toBe(42);
    expect(await client.zCard(key)).toBe(0);
  });

  it('reclaims crashed-owner leases and rejects stale-owner release without touching replacements', async () => {
    await instance().run(async () => undefined);
    await client.zAdd(
      key,
      Array.from({ length: 4 }, (_, n) => ({ score: 1, value: `expired-${n}` })),
    );
    await client.pExpire(key, 30_000);
    await instance().run(async () => {
      const owners = await client.zRange(key, 0, -1);
      expect(owners).toHaveLength(1);
      expect(await client.eval(scripts.release!, { keys: [key], arguments: ['expired-0'] })).toBe(
        0,
      );
      expect(await client.zRange(key, 0, -1)).toEqual(owners);
    });
  });

  it('does not renew an expired token or resurrect it after replacement', async () => {
    const admission = instance();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const running = admission.run(async () => {
      await gate;
      assertSignupLease();
    });
    const rejected = expect(running).rejects.toBeInstanceOf(SignupAdmissionUnavailable);
    try {
      await expect.poll(() => client.zCard(key)).toBe(1);
      const [token] = await client.zRange(key, 0, -1);
      await client.zAdd(key, { score: 1, value: token! });
      await expect
        .poll(() => scripts.renew !== undefined, { timeout: 12_000, interval: 100 })
        .toBe(true);
      expect(
        await client.eval(scripts.renew!, { keys: [key], arguments: [token!, '4', '30000'] }),
      ).toBe(0);
      await instance().run(async () => {
        expect(await client.zCard(key)).toBe(1);
        expect(await client.zScore(key, token!)).toBeNull();
      });
    } finally {
      finish();
      await rejected;
    }
  }, 15_000);

  it('renews a real lease beyond its original thirty-second expiration', async () => {
    await instance().run(async () => {
      const [token] = await client.zRange(key, 0, -1);
      const original = await client.zScore(key, token!);
      await new Promise((resolve) => setTimeout(resolve, 31_000));
      assertSignupLease();
      expect(await client.zScore(key, token!)).toBeGreaterThan(original! + 20_000);
      expect(await client.pTTL(key)).toBeGreaterThan(20_000);
      expect(await client.zCard(key)).toBe(1);
    });
    expect(await client.zCard(key)).toBe(0);
  }, 40_000);

  it('fails closed on a real Lua error without executing work', async () => {
    await client.set(key, 'wrong-type', { PX: 30_000 });
    const work = vi.fn();
    await expect(instance().run(work)).rejects.toMatchObject({
      message: 'Signup temporarily unavailable',
    });
    expect(work).not.toHaveBeenCalled();
  });
});
