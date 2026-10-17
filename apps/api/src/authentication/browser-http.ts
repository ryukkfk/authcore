import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { json, type Request, type Response, type CookieOptions } from 'express';
import { sessionCredentialDigest } from '@authcore/crypto';

const methods = new Map<string, string>([
  ['/api/v1/auth/login', 'POST'],
  ['/api/v1/auth/me', 'GET'],
  ['/api/v1/auth/sessions', 'GET'],
  ['/api/v1/auth/logout', 'POST'],
  ['/api/v1/auth/logout-all', 'POST'],
  ['/api/v1/auth/logout-others', 'POST'],
  ['/api/v1/auth/sessions/revoke', 'POST'],
]);
const contexts = new WeakMap<Request, { requestId: string; signal: AbortSignal }>();
export const browserRequestContext = (request: Request) => {
  const value = contexts.get(request);
  if (!value) throw new Error('BROWSER_HTTP_BOUNDARY_REQUIRED');
  return value;
};
export function sessionCookiePolicy(production: boolean): { name: string; options: CookieOptions } {
  return {
    name: production ? '__Host-authcore_session' : 'authcore_session',
    options: {
      httpOnly: true,
      secure: production,
      sameSite: 'lax',
      path: production ? '/' : '/api/v1',
      maxAge: 12 * 60 * 60 * 1000,
    },
  };
}
export function readSessionCredential(request: Request): string | undefined {
  const name = sessionCookiePolicy(process.env.NODE_ENV === 'production').name;
  const matches = (request.headers.cookie ?? '')
    .split(';')
    .map((value) => value.trim())
    .filter((value) => value.startsWith(name + '='));
  if (matches.length !== 1) return undefined;
  const value = matches[0]!.slice(name.length + 1);
  return sessionCredentialDigest(value) ? value : undefined;
}
export function configureBrowserAuthHttp(app: INestApplication) {
  const parser = json({
    limit: 4096,
    inflate: false,
    strict: true,
    verify: (_request, _response, buffer) => {
      new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    },
  });
  app.use((request: Request, response: Response, next: () => void) => {
    const allowed = methods.get(request.path);
    if (!allowed || request.method === 'OPTIONS') return next();
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const abort = new AbortController(),
      requestId = randomUUID();
    contexts.set(request, { requestId, signal: abort.signal });
    response.setHeader('X-Request-ID', requestId);
    const interrupted = () => abort.abort();
    request.once('aborted', interrupted);
    response.once('close', () => {
      request.removeListener('aborted', interrupted);
      if (!response.writableFinished) abort.abort();
    });
    const deny = (status: number, message: string) => {
      response.setHeader('Connection', 'close');
      response.once('finish', () => request.destroy());
      response.status(status).json({ error: { code: 'HTTP_' + status, message } });
    };
    if (request.method !== allowed) return deny(405, 'Method not allowed');
    if (
      request.rawHeaders.length > 128 ||
      Buffer.byteLength(request.rawHeaders.join('\r\n')) > 8192 ||
      request.originalUrl.includes('?')
    )
      return deny(400, 'Invalid authentication request');
    const origin = request.headers.origin,
      expected = process.env.WEB_ORIGIN;
    if (request.headers['sec-fetch-site'] === 'cross-site' || (origin && origin !== expected))
      return deny(403, 'Request origin rejected');
    if (allowed === 'GET') return next();
    // SameSite alone is insufficient. Browser writes require an exact trusted
    // Origin, JSON and a non-simple header, forcing cross-origin preflight.
    if (!expected || origin !== expected || request.headers['x-authcore-request'] !== 'browser')
      return deny(403, 'Request origin rejected');
    const count = (name: string) =>
      request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === name)
        .length;
    if (
      count('content-type') !== 1 ||
      count('content-encoding') > 1 ||
      !/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?\s*$/i.test(
        request.headers['content-type'] ?? '',
      ) ||
      !['', 'identity'].includes(request.headers['content-encoding']?.toLowerCase() ?? '')
    )
      return deny(415, 'Unsupported request body');
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        abort.abort();
        deny(503, 'Authentication temporarily unavailable');
      }
    }, 5000);
    const close = () => {
      finished = true;
      clearTimeout(timer);
    };
    response.once('close', close);
    parser(request, response, (error?: unknown) => {
      if (finished) return;
      close();
      response.removeListener('close', close);
      if (error)
        return deny(
          typeof error === 'object' &&
            error !== null &&
            'type' in error &&
            error.type === 'entity.too.large'
            ? 413
            : 400,
          'Invalid authentication request',
        );
      next();
    });
  });
}
