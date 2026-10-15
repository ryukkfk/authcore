import type { INestApplication } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { json, type Request, type Response } from 'express';
import { createServer, type Server } from 'node:http';
import { createServer as createHttpsServer, type ServerOptions as HttpsOptions } from 'node:https';

const configuredServers = new WeakSet<object>();
/** Public Nest adapter lifecycle and Node server options; no private timer manipulation. */
export class SignupHttpAdapter extends ExpressAdapter {
  override initHttpServer(options?: {
    httpsOptions?: HttpsOptions;
    forceCloseConnections?: boolean;
  }): void {
    if (options?.forceCloseConnections) throw new Error('FORCED_CONNECTION_SHUTDOWN_UNSUPPORTED');
    const budgets = {
      maxHeaderSize: 8192,
      headersTimeout: 5000,
      requestTimeout: 10000,
      connectionsCheckingInterval: 250,
      keepAliveTimeout: 5000,
    };
    this.setHttpServer(
      options?.httpsOptions
        ? createHttpsServer({ ...options.httpsOptions, ...budgets }, this.getInstance())
        : createServer(budgets, this.getInstance()),
    );
    configuredServers.add(this.getHttpServer());
  }
}

export const SIGNUP_BODY_BYTES = 16 * 1024;
export const SIGNUP_UPLOAD_MS = 5000;
export const isSignupRequest = (request: Pick<Request, 'method' | 'path'>) =>
  request.method === 'POST' && /^\/api\/v1\/auth\/signup\/?$/i.test(request.path);
export function signupHttpFailure(response: Response, status: number, message: string): void {
  response.setHeader('Cache-Control', 'no-store');
  if (status === 503) response.setHeader('Retry-After', '1');
  response.status(status).json({
    error: { code: status === 500 ? 'INTERNAL_SERVER_ERROR' : `HTTP_${status}`, message },
  });
}

/** Install before app.init/listen with Nest bodyParser:false. All parser errors are sanitized. */
export function configureSignupHttp(app: INestApplication): void {
  const parser = json({ limit: SIGNUP_BODY_BYTES, inflate: false, strict: true });
  app.use((request: Request, response: Response, next: () => void) => {
    if (!isSignupRequest(request)) return next();
    response.setHeader('Cache-Control', 'no-store');
    const deny = (status: number, message: string) => {
      response.setHeader('Connection', 'close');
      response.once('finish', () => request.destroy());
      signupHttpFailure(response, status, message);
    };
    // Keep the complete raw inventory; never truncate away a duplicate key.
    if (
      request.rawHeaders.length > 128 ||
      Buffer.byteLength(request.rawHeaders.join('\r\n')) > 8192
    )
      return deny(400, 'Invalid signup request');
    if (Number(request.headers['content-length'] ?? 0) > SIGNUP_BODY_BYTES)
      return deny(413, 'Request too large');
    const fields = (name: string) =>
      request.rawHeaders.filter(
        (_, i) => i % 2 === 0 && request.rawHeaders[i]!.toLowerCase() === name,
      ).length;
    if (
      fields('content-type') !== 1 ||
      fields('content-encoding') > 1 ||
      !/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?\s*$/i.test(
        request.headers['content-type'] ?? '',
      ) ||
      !['', 'identity'].includes(request.headers['content-encoding']?.toLowerCase() ?? '')
    )
      return deny(415, 'Unsupported request body');
    let finished = false;
    let received = 0;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      close();
      deny(503, 'Signup temporarily unavailable');
    }, SIGNUP_UPLOAD_MS);
    timer.unref();
    const close = () => {
      finished = true;
      clearTimeout(timer);
      request.removeListener('data', count);
    };
    const count = (chunk: Buffer) => {
      received += chunk.byteLength;
      if (received > SIGNUP_BODY_BYTES && !finished) {
        close();
        deny(413, 'Request too large');
      }
    };
    request.on('data', count);
    response.once('close', close);
    parser(request, response, (error?: unknown) => {
      if (finished) return;
      close();
      response.removeListener('close', close);
      if (error) {
        const kind =
          typeof error === 'object' && error !== null && 'type' in error ? error.type : undefined;
        return deny(
          kind === 'entity.too.large' ? 413 : 400,
          kind === 'entity.too.large' ? 'Request too large' : 'Invalid signup request',
        );
      }
      next();
    });
  });
  const server = app.getHttpServer() as Server;
  // Require this adapter's constructor policy, without inspecting Node private fields.
  if (!configuredServers.has(server)) throw new Error('SIGNUP_HTTP_HEADER_BUDGET_INVALID');
  // Disable count truncation: bounded bytes and the complete raw count enforce denial.
  server.maxHeadersCount = 0;
  server.headersTimeout = 5000;
  server.requestTimeout = 10000;
  server.keepAliveTimeout = 5000;
  // Node timeout checks have scheduling granularity, not hard whole-request deadlines.
}

const signals = new WeakMap<Request, AbortSignal>();
export function setSignupRequestSignal(request: Request, signal: AbortSignal): void {
  signals.set(request, signal);
}
export function signupRequestSignal(request: Request): AbortSignal | undefined {
  return signals.get(request);
}
