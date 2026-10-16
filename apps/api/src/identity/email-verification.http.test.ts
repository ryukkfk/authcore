import 'reflect-metadata';
import { type INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { createVerificationToken } from '@authcore/crypto';
import type { AddressInfo } from 'node:net';
import { GlobalExceptionFilter } from '../common/filters/global-exception.filter.js';
import { RedisService } from '../redis/redis.service.js';
import { EmailVerificationService } from './email-verification.service.js';
import { EmailVerificationController } from './email-verification.controller.js';
import { configureEmailVerificationHttp } from './email-verification.http.js';
import { configureSignupHttp, SignupHttpAdapter } from './signup-http.js';

const verify = vi.fn(),
  evaluate = vi.fn();
@Module({
  controllers: [EmailVerificationController],
  providers: [
    { provide: EmailVerificationService, useValue: { verify } },
    { provide: RedisService, useValue: { getClient: async () => ({ eval: evaluate }) } },
  ],
})
class VerificationHttpFixture {}

describe('Email verification real HTTP boundary with controlled domain outcomes', () => {
  let app: INestApplication, url: string;
  beforeAll(async () => {
    vi.stubEnv('WEB_ORIGIN', 'http://127.0.0.1:3000');
    app = await NestFactory.create(VerificationHttpFixture, new SignupHttpAdapter(), {
      logger: false,
      bodyParser: false,
    });
    configureSignupHttp(app);
    configureEmailVerificationHttp(app);
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.listen(0, '127.0.0.1');
    url =
      'http://127.0.0.1:' +
      (app.getHttpServer().address() as AddressInfo).port +
      '/api/v1/auth/verify-email';
  });
  beforeEach(() => {
    verify.mockReset().mockResolvedValue(true);
    evaluate.mockReset().mockResolvedValue(1);
  });
  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });
  const send = (body: string | Buffer, headers: Record<string, string> = {}) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : Uint8Array.from(body).buffer,
    });
  it('validates proof, sets no-store and correlates transactional audit', async () => {
    const token = createVerificationToken(),
      reply = await send(JSON.stringify({ token }));
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({ status: 'verified' });
    expect(reply.headers.get('cache-control')).toBe('no-store');
    expect(reply.headers.get('x-request-id')).toMatch(/^[a-f0-9-]{36}$/);
    expect(verify.mock.calls[0]?.[0] === token).toBe(true);
    expect(verify.mock.calls[0]?.[1]).toBe(reply.headers.get('x-request-id'));
    expect(reply.headers.get('set-cookie')).toBeNull();
  });
  it.each(['expired', 'consumed', 'unknown', 'disabled'])(
    'uses the same unavailable-credential result for %s domain state',
    async () => {
      verify.mockResolvedValue(false);
      const reply = await send(JSON.stringify({ token: createVerificationToken() }));
      expect(reply.status).toBe(400);
      expect(await reply.json()).toEqual({
        error: { code: 'HTTP_400', message: 'Verification credential unavailable' },
      });
    },
  );
  it.each([
    { value: {} },
    { value: [] },
    { value: { token: 'invalid' } },
    { value: { token: 'invalid', extra: true } },
    { value: null },
  ])('rejects invalid input %# before domain work', async ({ value }) => {
    const reply = await send(JSON.stringify(value));
    expect(reply.status).toBe(400);
    expect(verify).not.toHaveBeenCalled();
  });
  it('rejects oversized, compressed and malformed UTF-8 before domain work', async () => {
    expect((await send('x'.repeat(1025))).status).toBe(413);
    expect((await send('{}', { 'content-encoding': 'gzip' })).status).toBe(415);
    expect(
      (await send(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]))).status,
    ).toBe(400);
    expect(verify).not.toHaveBeenCalled();
  });
  it('fails closed on rate limits, Redis failure and database failure', async () => {
    const body = JSON.stringify({ token: createVerificationToken() });
    evaluate.mockResolvedValue(0);
    expect((await send(body)).status).toBe(429);
    expect(verify).not.toHaveBeenCalled();
    evaluate.mockRejectedValue(new Error('Synthetic Redis failure'));
    expect((await send(body)).status).toBe(503);
    evaluate.mockResolvedValue(1);
    verify.mockRejectedValue(new Error('Synthetic SQL detail'));
    const reply = await send(body);
    expect(reply.status).toBe(503);
    expect((await reply.text()).includes('Synthetic')).toBe(false);
  });
  it('rejects cross-origin submission, query credentials and unsupported methods', async () => {
    expect(
      (
        await send(JSON.stringify({ token: createVerificationToken() }), {
          origin: 'https://example.invalid',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(url + '?token=synthetic', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(400);
    expect((await fetch(url)).status).toBe(405);
    expect(verify).not.toHaveBeenCalled();
  });
});
