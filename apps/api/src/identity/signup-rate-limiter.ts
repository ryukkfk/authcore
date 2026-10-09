import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { RedisService } from '../redis/redis.service.js';

const PER_IP_LIMIT = 5;
const PER_IP_WINDOW_MS = 10 * 60 * 1000;

const GLOBAL_LIMIT = 30;
const GLOBAL_WINDOW_MS = 60 * 1000;

// Redis executes the entire script atomically.
const CONSUME_SCRIPT = `
local ipLimit = tonumber(ARGV[1])
local ipWindow = tonumber(ARGV[2])
local globalLimit = tonumber(ARGV[3])
local globalWindow = tonumber(ARGV[4])

local ipCount = tonumber(redis.call('GET', KEYS[1]) or '0')
local globalCount = tonumber(redis.call('GET', KEYS[2]) or '0')

local ipExceeded = ipCount >= ipLimit
local globalExceeded = globalCount >= globalLimit

if ipExceeded or globalExceeded then
  local retryMs = 0

  if ipExceeded then
    retryMs = math.max(retryMs, redis.call('PTTL', KEYS[1]))
  end

  if globalExceeded then
    retryMs = math.max(retryMs, redis.call('PTTL', KEYS[2]))
  end

  return {0, math.max(1000, retryMs)}
end

local nextIpCount = redis.call('INCR', KEYS[1])

if nextIpCount == 1 then
  redis.call('PEXPIRE', KEYS[1], ipWindow)
end

local nextGlobalCount = redis.call('INCR', KEYS[2])

if nextGlobalCount == 1 then
  redis.call('PEXPIRE', KEYS[2], globalWindow)
end

return {1, 0}
`;

export interface SignupRateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

@Injectable()
export class SignupRateLimiter {
  constructor(
    @Inject(RedisService)
    private readonly redis: RedisService,
  ) {}

  async consume(remoteAddress: string): Promise<SignupRateLimitResult> {
    if (!remoteAddress) {
      throw new Error('Missing client address');
    }

    const addressHash = createHash('sha256').update(remoteAddress).digest('hex');

    const client = await this.redis.getClient();

    // Both keys use the same Redis Cluster hash tag.
    const reply = await client.eval(CONSUME_SCRIPT, {
      keys: [`authcore:{signup}:ip:${addressHash}`, 'authcore:{signup}:global'],
      arguments: [
        String(PER_IP_LIMIT),
        String(PER_IP_WINDOW_MS),
        String(GLOBAL_LIMIT),
        String(GLOBAL_WINDOW_MS),
      ],
    });

    if (
      !Array.isArray(reply) ||
      reply.length !== 2 ||
      (reply[0] !== 0 && reply[0] !== 1) ||
      typeof reply[1] !== 'number' ||
      !Number.isFinite(reply[1]) ||
      reply[1] < 0
    ) {
      throw new Error('Invalid Redis rate-limit response');
    }

    return {
      allowed: reply[0] === 1,
      retryAfterSeconds: reply[0] === 1 ? 0 : Math.max(1, Math.ceil(reply[1] / 1000)),
    };
  }
}
