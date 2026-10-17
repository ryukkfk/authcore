import 'reflect-metadata';
import { Module, type INestApplication, UnauthorizedException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AddressInfo } from 'node:net';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { createSessionCredential } from '@authcore/crypto';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SignupDto } from '../identity/dto/signup.dto.js';
import { BrowserAuthController } from './browser-auth.controller.js';
import { BrowserAuthService } from './browser-auth.service.js';
import { configureBrowserAuthHttp } from './browser-http.js';
import { configureSignupHttp, SignupHttpAdapter } from '../identity/signup-http.js';
import { GlobalExceptionFilter } from '../common/filters/global-exception.filter.js';

const credential = createSessionCredential();
const account = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'fixture@example.invalid',
  emailVerified: true as const,
  createdAt: '2026-10-16T00:00:00.000Z',
  sessionId: '22222222-2222-4222-8222-222222222222',
};
const auth = { login: vi.fn(), me: vi.fn(), list: vi.fn(), revoke: vi.fn() };
@Module({
  controllers: [BrowserAuthController],
  providers: [{ provide: BrowserAuthService, useValue: auth }],
})
class BrowserHttpFixture {}

describe('Browser authentication real HTTP boundary with controlled domain outcomes', () => {
  let app: INestApplication, base: string;
  const headers = {
    'content-type': 'application/json',
    origin: 'http://127.0.0.1:3000',
    'x-authcore-request': 'browser',
  };
  const post = (path: string, body: unknown = {}, extra: Record<string, string> = {}) =>
    fetch(base + path, {
      method: 'POST',
      headers: { ...headers, ...extra },
      body: JSON.stringify(body),
    });
  beforeAll(async () => {
    vi.stubEnv('WEB_ORIGIN', 'http://127.0.0.1:3000');
    vi.stubEnv('NODE_ENV', 'development');
    app = await NestFactory.create(BrowserHttpFixture, new SignupHttpAdapter(), {
      logger: false,
      bodyParser: false,
    });
    configureSignupHttp(app);
    configureBrowserAuthHttp(app);
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.listen(0, '127.0.0.1');
    base =
      'http://127.0.0.1:' + (app.getHttpServer().address() as AddressInfo).port + '/api/v1/auth/';
  });
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
    auth.login.mockReset().mockResolvedValue({ account, credential });
    auth.me.mockReset().mockImplementation(async (value: unknown) => {
      if (value !== credential) throw new UnauthorizedException('Authentication required');
      return account;
    });
    auth.list.mockReset().mockResolvedValue([]);
    auth.revoke.mockReset().mockResolvedValue({ authorized: true, currentRevoked: true });
  });
  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });
  it('sets HttpOnly session cookies and never serializes the credential or persistence details', async () => {
    const password = '  public fixture with preserved spaces  ';
    const reply = await post('login', { email: account.email, password });
    expect(reply.status).toBe(200);
    const cookie = reply.headers.get('set-cookie') ?? '';
    for (const part of [
      'authcore_session=',
      'HttpOnly',
      'SameSite=Lax',
      'Path=/api/v1/auth;',
      'Max-Age=43200',
    ])
      expect(cookie.includes(part)).toBe(true);
    expect(cookie.includes('Secure')).toBe(false);
    const body = await reply.text();
    expect(body.includes(credential)).toBe(false);
    expect(body.includes('passwordHash')).toBe(false);
    expect(auth.login.mock.calls[0]?.[0].password === password).toBe(true);
    expect(reply.headers.get('cache-control')).toBe('no-store');
  });
  it('uses a Secure host-only production cookie with the required root path', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const reply = await post('login', {
      email: account.email,
      password: 'Public fixture password',
    });
    const cookie = reply.headers.get('set-cookie') ?? '';
    for (const part of ['__Host-authcore_session=', 'Secure', 'HttpOnly', 'Path=/', 'SameSite=Lax'])
      expect(cookie.includes(part)).toBe(true);
    expect(cookie.includes('Domain=')).toBe(false);
  });
  it('accepts the same maximum Unicode password length as signup without normalization', async () => {
    const input = { email: account.email, password: '\u{1f510}\ufe0f'.repeat(128) };
    expect(validateSync(plainToInstance(SignupDto, input))).toHaveLength(0);
    const reply = await post('login', input);
    expect(reply.status).toBe(200);
    expect(auth.login.mock.calls[0]?.[0].password === input.password).toBe(true);
  });
  it('requires server session resolution and rejects absent, malformed or ambiguous cookies', async () => {
    expect((await fetch(base + 'me')).status).toBe(401);
    expect(
      (await fetch(base + 'me', { headers: { cookie: 'authcore_session=invalid' } })).status,
    ).toBe(401);
    expect(
      (
        await fetch(base + 'me', {
          headers: {
            cookie: 'authcore_session=' + credential + '; authcore_session=' + credential,
          },
        })
      ).status,
    ).toBe(401);
    const reply = await fetch(base + 'me', {
      headers: { cookie: 'authcore_session=' + credential },
    });
    expect(reply.status).toBe(200);
    expect((await reply.json()).user.email).toBe(account.email);
  });
  it('rejects cross-origin and simple cookie-authenticated state changes before domain work', async () => {
    expect((await post('logout', {}, { origin: 'https://example.invalid' })).status).toBe(403);
    expect(
      (
        await fetch(base + 'logout', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(base + 'logout', {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: headers.origin },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    expect((await fetch(base + 'me', { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(
      403,
    );
    expect(auth.revoke).not.toHaveBeenCalled();
  });
  it.each([
    { email: 'invalid', password: 'Public fixture password' },
    { email: account.email, password: 'x'.repeat(129) },
    { email: account.email, password: '\u{1f510}\ufe0f'.repeat(129) },
    { email: account.email, password: '' },
    { email: account.email, password: 'Public fixture password', extra: true },
  ])('rejects invalid login input %# before native/domain work', async (body) => {
    expect((await post('login', body)).status).toBe(400);
    expect(auth.login).not.toHaveBeenCalled();
  });
  it('rejects oversized, compressed, malformed UTF-8 and query credentials', async () => {
    expect(
      (await fetch(base + 'login', { method: 'POST', headers, body: 'x'.repeat(4097) })).status,
    ).toBe(413);
    expect((await post('login', {}, { 'content-encoding': 'gzip' })).status).toBe(415);
    expect(
      (
        await fetch(base + 'login', {
          method: 'POST',
          headers,
          body: Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]).buffer,
        })
      ).status,
    ).toBe(400);
    expect((await fetch(base + 'me?token=synthetic')).status).toBe(400);
    expect(auth.login).not.toHaveBeenCalled();
  });
  it('uses generic invalid-login responses and sanitizes storage/native failures', async () => {
    auth.login.mockRejectedValue(new UnauthorizedException('Invalid credentials'));
    const invalid = await post('login', {
      email: account.email,
      password: 'Wrong public fixture password',
    });
    expect(invalid.status).toBe(401);
    expect(await invalid.json()).toEqual({
      error: { code: 'HTTP_401', message: 'Invalid credentials' },
    });
    auth.login.mockRejectedValue(new Error('Synthetic internal detail'));
    const failed = await post('login', {
      email: account.email,
      password: 'Public fixture password',
    });
    expect(failed.status).toBe(503);
    expect((await failed.text()).includes('Synthetic')).toBe(false);
  });
  it('clears the same cookie on logout and validates device identifiers', async () => {
    const reply = await post('logout', {}, { cookie: 'authcore_session=' + credential });
    expect(reply.status).toBe(204);
    const cookie = reply.headers.get('set-cookie') ?? '';
    expect(cookie.includes('authcore_session=;')).toBe(true);
    expect(cookie.includes('Path=/api/v1/auth;')).toBe(true);
    expect((await post('sessions/revoke', { sessionId: 'forged' })).status).toBe(400);
  });
});
