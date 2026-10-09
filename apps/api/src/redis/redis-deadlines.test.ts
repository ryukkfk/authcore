import { createServer, type Socket } from 'node:net';

import { afterEach, expect, it, vi } from 'vitest';

import { RedisService } from './redis.service.js';

const services: RedisService[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) service.onApplicationShutdown();
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// Real node-redis and TCP, with a controllable RESP peer. Synchronize on received
// commands before advancing deadlines, so a timeout cannot pass before send.
async function peer() {
  let reply = false;
  let connections = 0;
  const commands: string[][] = [];
  const sockets = new Set<Socket>();
  let closed: (() => void) | undefined;
  const firstClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  let observed: (() => void) | undefined;
  const server = createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
      closed?.();
    });
    socket.on('error', () => {});
    let buffer = '';
    socket.on('data', (data) => {
      buffer += data.toString();
      while (buffer) {
        const header = /^\*(\d+)\r\n/.exec(buffer);
        if (!header) return;
        let offset = header[0].length;
        const args: string[] = [];
        for (let n = 0; n < Number(header[1]); n++) {
          const bulk = /^\$(\d+)\r\n/.exec(buffer.slice(offset));
          if (!bulk) return;
          offset += bulk[0].length;
          const length = Number(bulk[1]);
          if (buffer.length < offset + length + 2) return;
          args.push(buffer.slice(offset, offset + length));
          offset += length + 2;
        }
        buffer = buffer.slice(offset);
        commands.push(args);
        if (reply) socket.write(args[0] === 'PING' ? '+PONG\r\n' : '+OK\r\n');
        observed?.();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing peer address');
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DATABASE_URL', 'postgresql://unused:unused@127.0.0.1:1/unused');
  vi.stubEnv('WEB_ORIGIN', 'http://127.0.0.1');
  vi.stubEnv('SIGNUP_ENABLED', 'false');
  vi.stubEnv('REDIS_URL', `redis://127.0.0.1:${address.port}`);
  return {
    commands,
    firstClosed,
    get connections() {
      return connections;
    },
    setReply(value: boolean) {
      reply = value;
    },
    received(count: number) {
      return new Promise<void>((resolve) => {
        observed = () => {
          if (commands.length >= count) resolve();
        };
        observed();
      });
    },
  };
}

function service() {
  const redis = new RedisService();
  services.push(redis);
  return redis;
}

it('tears down stalled handshake replies, rejects shared waiters and recovers after cooldown', async () => {
  const server = await peer();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const redis = service();
  const outcomes = Promise.allSettled(Array.from({ length: 100 }, () => redis.getClient()));
  let settled = false;
  void outcomes.then(() => {
    settled = true;
  });
  await server.received(1);
  expect(server.connections).toBe(1);
  await vi.advanceTimersByTimeAsync(3001);
  expect(settled).toBe(true);
  expect((await outcomes).every((result) => result.status === 'rejected')).toBe(true);
  await server.firstClosed;
  await expect(redis.getClient()).rejects.toThrow();
  expect(server.connections).toBe(1);
  server.setReply(true);
  await vi.advanceTimersByTimeAsync(1001);
  const client = await redis.getClient();
  expect(await client.ping()).toBe('PONG');
  expect(server.connections).toBe(2);
});

it('destroys the affected connection and rejects all sent commands without replay, then recovers', async () => {
  const server = await peer();
  server.setReply(true);
  const redis = service();
  const client = await redis.getClient();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  server.setReply(false);
  const initial = server.commands.length;
  const outcomes = Promise.allSettled([
    client.eval('return 1'),
    client.withCommandOptions({ timeout: 1000 }).eval('return 2'),
    client.ping(),
  ]);
  let settled = false;
  void outcomes.then(() => {
    settled = true;
  });
  await server.received(initial + 3);
  await vi.advanceTimersByTimeAsync(1001);
  expect(client.isOpen).toBe(false);
  expect(client.isReady).toBe(false);
  expect(settled).toBe(true);
  expect((await outcomes).every((result) => result.status === 'rejected')).toBe(true);
  await server.firstClosed;
  await Promise.allSettled(Array.from({ length: 100 }, () => redis.getClient()));
  expect(server.connections).toBe(1);
  server.setReply(true);
  await vi.advanceTimersByTimeAsync(1001);
  expect(await (await redis.getClient()).ping()).toBe('PONG');
  expect(server.connections).toBe(2);
  expect(server.commands.filter((args) => args[0] === 'EVAL')).toHaveLength(2);
  // Settled deadlines must not tear down the recovered connection later.
  await vi.advanceTimersByTimeAsync(4000);
  expect(await (await redis.getClient()).ping()).toBe('PONG');
});

it('shutdown tears down a pending handshake, clears its deadline and forbids reopening', async () => {
  const server = await peer();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const redis = service();
  const outcomes = Promise.allSettled(Array.from({ length: 10 }, () => redis.getClient()));
  await server.received(1);
  redis.onApplicationShutdown();
  expect((await outcomes).every((result) => result.status === 'rejected')).toBe(true);
  await server.firstClosed;
  await vi.advanceTimersByTimeAsync(5000);
  await expect(redis.getClient()).rejects.toThrow('Redis service stopped');
  expect(server.connections).toBe(1);
});
