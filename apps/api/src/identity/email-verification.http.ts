import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { json, type Request, type Response } from 'express';

export const isEmailVerificationRequest = (request: Request) =>
  request.path === '/api/v1/auth/verify-email';
const correlation = new WeakMap<Request, string>();
export const emailVerificationRequestId = (request: Request) =>
  correlation.get(request) ?? randomUUID();
export function configureEmailVerificationHttp(app: INestApplication) {
  const parser = json({
    limit: 1024,
    inflate: false,
    strict: true,
    verify: (_request, _response, buffer) => {
      new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    },
  });
  app.use((request: Request, response: Response, next: () => void) => {
    if (!isEmailVerificationRequest(request)) return next();
    response.setHeader('Cache-Control', 'no-store');
    const requestId = randomUUID();
    correlation.set(request, requestId);
    response.setHeader('X-Request-ID', requestId);
    const deny = (status: number, message: string) => {
      response.setHeader('Connection', 'close');
      response.once('finish', () => request.destroy());
      response.status(status).json({ error: { code: `HTTP_${status}`, message } });
    };
    if (request.method !== 'POST') return deny(405, 'Method not allowed');
    if (
      request.rawHeaders.length > 128 ||
      Buffer.byteLength(request.rawHeaders.join('\r\n')) > 8192
    )
      return deny(400, 'Invalid verification request');
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
    if (request.originalUrl.includes('?')) return deny(400, 'Invalid verification request');
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      deny(503, 'Verification temporarily unavailable');
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
          'Invalid verification request',
        );
      next();
    });
  });
}
