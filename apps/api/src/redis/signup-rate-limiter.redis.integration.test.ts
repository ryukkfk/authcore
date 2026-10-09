import { createHash, randomUUID } from 'node:crypto';
import { connect, createServer, type Socket } from 'node:net';

import { Logger, type ExecutionContext } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SignupRateLimitGuard } from '../identity/signup-rate-limit.guard.js';
import { SignupRateLimiter } from '../identity/signup-rate-limiter.js';
import { RedisService } from './redis.service.js';

// Deliberately reject credentials, other hosts/ports/DBs and all fallback URLs.
if (process.env.TEST_REDIS_URL !== 'redis://127.0.0.1:6380') {
  throw new Error('Set TEST_REDIS_URL=redis://127.0.0.1:6380 for the isolated test container');
}
const testUrl = process.env.TEST_REDIS_URL;
type Client = Awaited<ReturnType<RedisService['getClient']>>;

function contextFor(ip: string) {
  const setHeader = vi.fn();
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ socket: { remoteAddress: ip } }),
      getResponse: () => ({ setHeader }),
    }),
  } as unknown as ExecutionContext;
  return { context, setHeader };
}

// Only our TCP proxy is toggled. The Redis container and other clients are untouched.
async function createProxy() {
  let available = true;
  let replies = true;
  let attempts = 0;
  const sockets = new Set<Socket>();
  const server = createServer((downstream) => {
    attempts++;
    sockets.add(downstream);
    downstream.on('close', () => sockets.delete(downstream));
    downstream.on('error', () => downstream.destroy());
    if (!available) {
      downstream.destroy();
      return;
    }
    const upstream = connect({ host: '127.0.0.1', port: 6380 });
    sockets.add(upstream);
    upstream.on('close', () => {
      sockets.delete(upstream);
      downstream.destroy();
    });
    upstream.on('error', () => downstream.destroy());
    downstream.on('close', () => upstream.destroy());
    downstream.pipe(upstream);
    upstream.on('data', (data) => {
      if (replies) downstream.write(data);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing proxy address');
  return {
    get attempts() {
      return attempts;
    },
    url: `redis://127.0.0.1:${address.port}`,
    setReplies(value: boolean) {
      replies = value;
    },
    setAvailable(value: boolean) {
      available = value;
      if (!value) for (const socket of sockets) socket.destroy();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

describe('Real Redis signup limits and connection lifecycle', () => {
  let redis: RedisService;
  let client: Client;
  let limiter: SignupRateLimiter;
  let prefix: string;
  let ownedKeys: Set<string>;
  let services: RedisService[];
  let proxies: Awaited<ReturnType<typeof createProxy>>[];

  function newService(url = testUrl) {
    // RedisService's production constructor consumes REDIS_URL. Always replace it
    // with the validated explicit test URL (or our proxy to that URL), never read it.
    vi.stubEnv('REDIS_URL', url);
    const service = new RedisService();
    services.push(service);
    return service;
  }

  function ipKey(ip: string) {
    const key = `${prefix}ip:${createHash('sha256').update(ip).digest('hex')}`;
    ownedKeys.add(key);
    return key;
  }

  function globalKey() {
    const key = `${prefix}global`;
    ownedKeys.add(key);
    return key;
  }

  function isolatedLimiter(service: RedisService) {
    // Change keys only. Execute the exact production Lua, arguments and return
    // decoding against the real client. No mocked Redis commands or replies.
    const isolated = {
      async getClient() {
        const real = await service.getClient();
        return {
          eval(script: string, options: { keys: string[]; arguments: string[] }) {
            const keys = options.keys.map((key) => {
              if (!key.startsWith('authcore:{signup}:')) {
                throw new Error('Unexpected production rate-limit key');
              }
              const isolatedKey = key.replace('authcore:{signup}:', prefix);
              ownedKeys.add(isolatedKey);
              return isolatedKey;
            });
            return real.eval(script, { ...options, keys });
          },
        };
      },
    } as unknown as RedisService;
    return new SignupRateLimiter(isolated);
  }

  beforeEach(async () => {
    services = [];
    proxies = [];
    ownedKeys = new Set();
    prefix = `authcore:{signup-test-${randomUUID()}}:`;
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('DATABASE_URL', 'postgresql://unused:unused@127.0.0.1:1/unused');
    vi.stubEnv('WEB_ORIGIN', 'http://127.0.0.1');
    vi.stubEnv('SIGNUP_ENABLED', 'false');
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    redis = newService();
    client = await redis.getClient();
    expect(await client.ping()).toBe('PONG');
    limiter = isolatedLimiter(redis);
  });

  afterEach(async () => {
    try {
      // Exact keys registered by this test only; never scan or flush a database.
      if (ownedKeys.size) {
        const cleanup = await redis.getClient();
        await cleanup.del([...ownedKeys]);
        expect(await cleanup.exists([...ownedKeys])).toBe(0);
      }
    } finally {
      for (const service of services) service.onApplicationShutdown();
      for (const proxy of proxies) await proxy.close();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  });

  it('allows exactly five attempts per IP in a ten-minute fixed window', async () => {
    const ip = '192.0.2.1';
    for (let n = 0; n < 5; n++) {
      expect(await limiter.consume(ip)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    }
    expect(await limiter.consume(ip)).toMatchObject({ allowed: false });
    expect(await client.get(ipKey(ip))).toBe('5');
    expect(await client.get(globalKey())).toBe('5');
    expect(await client.pTTL(ipKey(ip))).toBeGreaterThan(590_000);
    expect(await client.pTTL(ipKey(ip))).toBeLessThanOrEqual(600_000);
    expect(await client.pTTL(globalKey())).toBeGreaterThan(50_000);
    expect(await client.pTTL(globalKey())).toBeLessThanOrEqual(60_000);
  });

  it('separates distinct IP counters while sharing the global budget', async () => {
    for (let n = 0; n < 5; n++) await limiter.consume('192.0.2.2');
    expect((await limiter.consume('192.0.2.2')).allowed).toBe(false);
    expect((await limiter.consume('192.0.2.3')).allowed).toBe(true);
    expect(await client.get(ipKey('192.0.2.2'))).toBe('5');
    expect(await client.get(ipKey('192.0.2.3'))).toBe('1');
    expect(await client.get(globalKey())).toBe('6');
  });

  it('allows exactly thirty distinct-IP attempts per minute without charging rejected IPs', async () => {
    for (let n = 0; n < 30; n++) {
      expect((await limiter.consume(`192.0.2.${n + 10}`)).allowed).toBe(true);
    }
    const rejectedIp = '198.51.100.1';
    expect(await limiter.consume(rejectedIp)).toMatchObject({ allowed: false });
    expect(await client.get(globalKey())).toBe('30');
    expect(await client.exists(ipKey(rejectedIp))).toBe(0);
  });

  it('atomically caps Promise.all requests for the same IP across independent clients', async () => {
    const other = newService();
    const otherLimiter = isolatedLimiter(other);
    const results = await Promise.all(
      Array.from({ length: 80 }, (_, n) => (n % 2 ? limiter : otherLimiter).consume('192.0.2.50')),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    expect(results.filter((result) => !result.allowed)).toHaveLength(75);
    expect(await client.get(ipKey('192.0.2.50'))).toBe('5');
    expect(await client.get(globalKey())).toBe('5');
  });

  it('atomically caps concurrent distinct IPs globally across independent clients', async () => {
    const otherLimiter = isolatedLimiter(newService());
    const results = await Promise.all(
      Array.from({ length: 80 }, (_, n) =>
        (n % 2 ? limiter : otherLimiter).consume(`198.51.100.${n + 1}`),
      ),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(30);
    expect(results.filter((result) => !result.allowed)).toHaveLength(50);
    expect(await client.get(globalKey())).toBe('30');
    const counts = await Promise.all(
      Array.from({ length: 80 }, (_, n) => client.get(ipKey(`198.51.100.${n + 1}`))),
    );
    expect(counts.filter((count) => count === '1')).toHaveLength(30);
    expect(counts.filter((count) => count === null)).toHaveLength(50);
  });

  it('enforces both limits together under concurrent repeated IPs', async () => {
    const otherLimiter = isolatedLimiter(newService());
    const ips = Array.from({ length: 200 }, (_, n) => `198.51.100.${(n % 20) + 1}`);
    const results = await Promise.all(
      ips.map((ip, n) => (n % 2 ? limiter : otherLimiter).consume(ip)),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(30);
    const counts = await Promise.all(
      Array.from({ length: 20 }, (_, n) => client.get(ipKey(`198.51.100.${n + 1}`))),
    );
    expect(counts.every((count) => Number(count) <= 5)).toBe(true);
    expect(counts.reduce((sum, count) => sum + Number(count), 0)).toBe(30);
    expect(await client.get(globalKey())).toBe('30');
  });
  it('does not extend fixed windows on accepted or denied attempts', async () => {
    const ip = '192.0.2.60';
    await limiter.consume(ip);
    await client.pExpire(ipKey(ip), 20_000);
    await client.pExpire(globalKey(), 10_000);
    for (let n = 0; n < 4; n++) await limiter.consume(ip);
    const ipTtl = await client.pTTL(ipKey(ip));
    const globalTtl = await client.pTTL(globalKey());
    expect(ipTtl).toBeGreaterThan(15_000);
    expect(ipTtl).toBeLessThanOrEqual(20_000);
    expect(globalTtl).toBeGreaterThan(5_000);
    expect(globalTtl).toBeLessThanOrEqual(10_000);
    for (let n = 0; n < 3; n++) expect((await limiter.consume(ip)).allowed).toBe(false);
    expect(await client.pTTL(ipKey(ip))).toBeLessThanOrEqual(ipTtl);
    expect(await client.pTTL(globalKey())).toBeLessThanOrEqual(globalTtl);
    expect(await client.get(ipKey(ip))).toBe('5');
    expect(await client.get(globalKey())).toBe('5');
  });

  it('rounds per-IP retry milliseconds up to seconds and emits Retry-After through the guard', async () => {
    const ip = '192.0.2.61';
    await client.set(ipKey(ip), '5', { PX: 42_800 });
    const guard = new SignupRateLimitGuard(limiter);
    const { context, setHeader } = contextFor(ip);
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 429,
      message: 'Too many requests',
    });
    expect(setHeader).toHaveBeenCalledExactlyOnceWith('Retry-After', '43');
    expect(await client.exists(globalKey())).toBe(0);
  });

  it('uses the global TTL when only the global limit is exceeded', async () => {
    await client.set(ipKey('192.0.2.62'), '1', { PX: 42_800 });
    await client.set(globalKey(), '30', { PX: 12_800 });
    expect(await limiter.consume('192.0.2.62')).toEqual({
      allowed: false,
      retryAfterSeconds: 13,
    });
    expect(await client.get(ipKey('192.0.2.62'))).toBe('1');
  });

  it.each([
    { ipTtl: 42_800, globalTtl: 12_800 },
    { ipTtl: 12_800, globalTtl: 42_800 },
  ])('uses the longer exceeded TTL ($ipTtl / $globalTtl)', async ({ ipTtl, globalTtl }) => {
    const ip = '192.0.2.63';
    await client.set(ipKey(ip), '5', { PX: ipTtl });
    await client.set(globalKey(), '30', { PX: globalTtl });
    expect(await limiter.consume(ip)).toEqual({ allowed: false, retryAfterSeconds: 43 });
    expect(await client.get(ipKey(ip))).toBe('5');
    expect(await client.get(globalKey())).toBe('30');
  });

  it('returns at least one second near expiry', async () => {
    await client.set(ipKey('192.0.2.64'), '5', { PX: 900 });
    expect(await limiter.consume('192.0.2.64')).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
  });

  it('admits again after actual per-IP expiry and starts a fresh ten-minute window', async () => {
    const ip = '192.0.2.65';
    for (let n = 0; n < 5; n++) await limiter.consume(ip);
    await client.pExpire(ipKey(ip), 100);
    await expect.poll(() => client.exists(ipKey(ip)), { timeout: 3000 }).toBe(0);
    expect(await limiter.consume(ip)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(await client.get(ipKey(ip))).toBe('1');
    expect(await client.get(globalKey())).toBe('6');
    expect(await client.pTTL(ipKey(ip))).toBeGreaterThan(590_000);
  });

  it('resets only the expired global window while keeping per-IP history', async () => {
    for (let n = 0; n < 30; n++) await limiter.consume(`203.0.113.${n + 1}`);
    await client.pExpire(globalKey(), 100);
    await expect.poll(() => client.exists(globalKey()), { timeout: 3000 }).toBe(0);
    expect((await limiter.consume('203.0.113.1')).allowed).toBe(true);
    expect(await client.get(globalKey())).toBe('1');
    expect(await client.get(ipKey('203.0.113.1'))).toBe('2');
    expect(await client.pTTL(globalKey())).toBeGreaterThan(50_000);
  });

  it('fails closed on a real Lua command error without exposing Redis details', async () => {
    await client.lPush(globalKey(), 'test-owned-wrong-type');
    await client.pExpire(globalKey(), 60_000);
    const { context, setHeader } = contextFor('192.0.2.70');
    await expect(new SignupRateLimitGuard(limiter).canActivate(context)).rejects.toMatchObject({
      status: 503,
      message: 'Signup temporarily unavailable',
    });
    expect(setHeader).not.toHaveBeenCalled();
    expect(await client.exists(ipKey('192.0.2.70'))).toBe(0);
  });

  it('shares the lazy connection across concurrent callers and reuses a ready client', async () => {
    const service = newService();
    const clients = await Promise.all(Array.from({ length: 40 }, () => service.getClient()));
    expect(new Set(clients).size).toBe(1);
    expect(await service.getClient()).toBe(clients[0]);
    expect(clients[0]?.isReady).toBe(true);
    expect(await clients[0]?.ping()).toBe('PONG');
  });

  it('terminates stalled real handshake replies and recovers with one shared attempt', async () => {
    const proxy = await createProxy();
    proxies.push(proxy);
    proxy.setReplies(false);
    const service = newService(proxy.url);
    const results = await Promise.allSettled(
      Array.from({ length: 100 }, () => service.getClient()),
    );
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(proxy.attempts).toBe(1);
    await Promise.allSettled(Array.from({ length: 100 }, () => service.getClient()));
    expect(proxy.attempts).toBe(1);
    proxy.setReplies(true);
    await expect
      .poll(
        async () => {
          try {
            return await (await service.getClient()).ping();
          } catch {
            return false;
          }
        },
        { timeout: 4000 },
      )
      .toBe('PONG');
    expect(proxy.attempts).toBe(2);
  });

  it('fails closed after a sent consume loses its reply, rejects all pending commands and never replays it', async () => {
    const proxy = await createProxy();
    proxies.push(proxy);
    const service = newService(proxy.url);
    const connected = await service.getClient();
    const guard = new SignupRateLimitGuard(isolatedLimiter(service));
    const { context } = contextFor('192.0.2.82');
    proxy.setReplies(false);
    const outcomes = Promise.allSettled([guard.canActivate(context), connected.ping()]);
    // A separate connection proves the Lua reached Redis before the timeout.
    await expect.poll(() => client.get(ipKey('192.0.2.82'))).toBe('1');
    const results = await outcomes;
    expect(results[0]).toMatchObject({
      status: 'rejected',
      reason: {
        status: 503,
        message: 'Signup temporarily unavailable',
      },
    });
    expect(results[1]?.status).toBe('rejected');
    expect(connected.isOpen).toBe(false);
    expect(connected.isReady).toBe(false);
    await Promise.allSettled(Array.from({ length: 100 }, () => service.getClient()));
    expect(proxy.attempts).toBe(1);
    proxy.setReplies(true);
    await expect
      .poll(
        async () => {
          try {
            return await (await service.getClient()).ping();
          } catch {
            return false;
          }
        },
        { timeout: 4000 },
      )
      .toBe('PONG');
    await expect(connected.eval('return 1')).rejects.toThrow('Redis connection unavailable');
    expect(await client.get(ipKey('192.0.2.82'))).toBe('1');
    expect(await client.get(globalKey())).toBe('1');
    expect(await guard.canActivate(context)).toBe(true);
    expect(await client.get(ipKey('192.0.2.82'))).toBe('2');
    expect(proxy.attempts).toBe(2);
  });

  it('closes the real socket on shutdown and tolerates repeated shutdown', async () => {
    const service = newService();
    const connected = await service.getClient();
    service.onApplicationShutdown();
    expect(connected.isOpen).toBe(false);
    expect(connected.isReady).toBe(false);
    expect(() => service.onApplicationShutdown()).not.toThrow();
  });

  it('rejects concurrent initial connection failures, fails closed, then reconnects on demand', async () => {
    const proxy = await createProxy();
    proxies.push(proxy);
    proxy.setAvailable(false);
    const service = newService(proxy.url);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => service.getClient()));
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(proxy.attempts).toBe(1);
    await Promise.allSettled(Array.from({ length: 100 }, () => service.getClient()));
    expect(proxy.attempts).toBe(1);
    const guard = new SignupRateLimitGuard(isolatedLimiter(service));
    const { context, setHeader } = contextFor('192.0.2.80');
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 503,
      message: 'Signup temporarily unavailable',
    });
    expect(setHeader).not.toHaveBeenCalled();
    proxy.setAvailable(true);
    await expect
      .poll(() => guard.canActivate(context).catch(() => false), { timeout: 4000 })
      .toBe(true);
    expect(await (await service.getClient()).ping()).toBe('PONG');
    expect(await client.get(ipKey('192.0.2.80'))).toBe('1');
  });

  it('fails closed after an established socket drops and preserves counters after recovery', async () => {
    const proxy = await createProxy();
    proxies.push(proxy);
    const service = newService(proxy.url);
    const guard = new SignupRateLimitGuard(isolatedLimiter(service));
    const { context } = contextFor('192.0.2.81');
    await expect(guard.canActivate(context)).resolves.toBe(true);
    const connected = await service.getClient();
    proxy.setAvailable(false);
    await expect.poll(() => connected.isOpen, { timeout: 3000 }).toBe(false);
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 503,
      message: 'Signup temporarily unavailable',
    });
    proxy.setAvailable(true);
    await expect
      .poll(() => guard.canActivate(context).catch(() => false), { timeout: 4000 })
      .toBe(true);
    expect(await client.get(ipKey('192.0.2.81'))).toBe('2');
    expect(await client.get(globalKey())).toBe('2');
    expect(Logger.prototype.warn).toHaveBeenCalledWith('Redis connection error');
  });
});
