import {
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { SignupRateLimitGuard } from './signup-rate-limit.guard.js';
import type { SignupRateLimiter } from './signup-rate-limiter.js';

function createGuard() {
  const consume = vi.fn();

  const limiter = {
    consume,
  } as unknown as SignupRateLimiter;

  return {
    guard: new SignupRateLimitGuard(limiter),
    consume,
  };
}

function createContext(remoteAddress?: string, forwardedFor?: string) {
  const setHeader = vi.fn();

  const request = {
    socket: { remoteAddress },
    headers: {
      'x-forwarded-for': forwardedFor,
    },
  } as unknown as Request;

  const response = {
    setHeader,
  } as unknown as Response;

  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;

  return { context, setHeader };
}

describe('SignupRateLimitGuard', () => {
  it('allows a request within the rate limit', async () => {
    const { guard, consume } = createGuard();
    const { context, setHeader } = createContext('127.0.0.1');

    consume.mockResolvedValue({
      allowed: true,
      retryAfterSeconds: 0,
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(consume).toHaveBeenCalledWith('127.0.0.1');
    expect(setHeader).not.toHaveBeenCalled();
  });

  it('rejects excessive requests with HTTP 429', async () => {
    const { guard, consume } = createGuard();
    const { context, setHeader } = createContext('127.0.0.1');

    consume.mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 42,
    });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });

    expect(setHeader).toHaveBeenCalledWith('Retry-After', '42');
  });

  it('fails closed when Redis is unavailable', async () => {
    const { guard, consume } = createGuard();
    const { context } = createContext('127.0.0.1');

    consume.mockRejectedValue(new Error('Sensitive Redis connection details'));

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('rejects requests without a socket address', async () => {
    const { guard, consume } = createGuard();
    const { context } = createContext();

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(consume).not.toHaveBeenCalled();
  });

  it('ignores spoofed X-Forwarded-For headers', async () => {
    const { guard, consume } = createGuard();

    const { context } = createContext('127.0.0.1', '203.0.113.99');

    consume.mockResolvedValue({
      allowed: true,
      retryAfterSeconds: 0,
    });

    await guard.canActivate(context);

    expect(consume).toHaveBeenCalledWith('127.0.0.1');
    expect(consume).not.toHaveBeenCalledWith('203.0.113.99');
  });

  it('does not expose Redis errors to the client', async () => {
    const { guard, consume } = createGuard();
    const { context } = createContext('127.0.0.1');

    consume.mockRejectedValue(new Error('redis://private-credentials'));

    let caught: unknown;

    try {
      await guard.canActivate(context);
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HttpException);

    const exception = caught as HttpException;

    expect(exception.getStatus()).toBe(503);
    expect(exception.message).not.toContain('private-credentials');
  });
});
