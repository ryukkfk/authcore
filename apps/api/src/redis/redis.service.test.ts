import { afterEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({
  isReady: false,
  isOpen: false,
  connect: vi.fn(),
  destroy: vi.fn(),
  on: vi.fn(),
  once: vi.fn(),
  off: vi.fn(),
}));
vi.mock('redis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('redis')>()),
  createClient: () => client,
}));
vi.mock('@authcore/config', () => ({
  parseEnvironment: () => ({ REDIS_URL: 'redis://127.0.0.1:6380' }),
}));

import { RedisService } from './redis.service.js';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('Redis outage connection pressure', () => {
  it('shares one failed attempt and bounds repeated outage attempts by cooldown', async () => {
    vi.useFakeTimers();
    client.connect.mockRejectedValue(new Error('synthetic outage'));
    const service = new RedisService();
    const burst = () => Promise.allSettled(Array.from({ length: 100 }, () => service.getClient()));
    expect((await burst()).every((result) => result.status === 'rejected')).toBe(true);
    expect(client.connect).toHaveBeenCalledTimes(1);
    for (let n = 0; n < 10; n++) await burst();
    expect(client.connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1001);
    await burst();
    expect(client.connect).toHaveBeenCalledTimes(2);
    service.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(1001);
    await burst();
    expect(client.connect).toHaveBeenCalledTimes(2);
  });
});
