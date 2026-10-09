import { describe, expect, it, vi } from 'vitest';

import type { RedisService } from '../redis/redis.service.js';
import { SignupRateLimiter } from './signup-rate-limiter.js';

function createTestLimiter(reply: unknown = [1, 0]) {
  const evalCommand = vi.fn().mockResolvedValue(reply);

  const redis = {
    getClient: vi.fn().mockResolvedValue({
      eval: evalCommand,
    }),
  } as unknown as RedisService;

  return {
    limiter: new SignupRateLimiter(redis),
    evalCommand,
    redis,
  };
}

describe('SignupRateLimiter', () => {
  it('allows requests within the limits', async () => {
    const { limiter } = createTestLimiter();

    await expect(limiter.consume('127.0.0.1')).resolves.toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
  });

  it('returns a retry delay when a limit is exceeded', async () => {
    const { limiter } = createTestLimiter([0, 65000]);

    await expect(limiter.consume('127.0.0.1')).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 65,
    });
  });

  it('does not put the plaintext address in Redis keys', async () => {
    const { limiter, evalCommand } = createTestLimiter();

    await limiter.consume('192.0.2.10');

    const options = evalCommand.mock.calls[0]?.[1] as {
      keys: string[];
      arguments: string[];
    };

    expect(options.keys[0]).not.toContain('192.0.2.10');
    expect(options.keys[1]).toBe('authcore:{signup}:global');
    expect(options.arguments).toEqual(['5', '600000', '30', '60000']);
  });

  it('fails when Redis is unavailable', async () => {
    const { limiter, redis } = createTestLimiter();

    vi.mocked(redis.getClient).mockRejectedValue(new Error('Redis unavailable'));

    await expect(limiter.consume('127.0.0.1')).rejects.toThrow();
  });

  it('rejects invalid Redis responses', async () => {
    const { limiter } = createTestLimiter(['invalid']);

    await expect(limiter.consume('127.0.0.1')).rejects.toThrow('Invalid Redis rate-limit response');
  });

  it('rejects missing client addresses', async () => {
    const { limiter } = createTestLimiter();

    await expect(limiter.consume('')).rejects.toThrow('Missing client address');
  });
});
