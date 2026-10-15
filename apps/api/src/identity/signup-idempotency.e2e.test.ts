import 'reflect-metadata';
import { randomUUID, createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connect } from 'node:net';
import { request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import * as crypto from '@authcore/crypto';
import { SignupIdempotencyResultRepository as Results, UserRepository } from '@authcore/db';
import { approvedTestUrl, bounded, deferred } from '@authcore/testing';
import { createProtocolFixture, type ProtocolFixture } from './signup-protocol.test-support.js';
import { startSignupHttp } from './signup-http.test-support.js';
import { SIGNUP_BODY_BYTES } from './signup-http.js';
import { SignupService } from './signup.service.js';
import type { Response as ExpressResponse } from 'express';
import { SignupRateLimitGuard } from './signup-rate-limit.guard.js';
import { SignupRateLimiter } from './signup-rate-limiter.js';
import { SignupAdmissionInterceptor } from './signup-admission.interceptor.js';
import { testSignupConfiguration } from './signup-reservation.test-support.js';
const approved =
  process.env.S5_POSTGRES_APPROVED === 'true'
    ? approvedTestUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL)
    : undefined;
if (
  approved &&
  (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted')
)
  throw new Error('S5 requires disposable GitHub-hosted services');
type HttpFixture = Awaited<ReturnType<typeof startSignupHttp>>;
const fresh = () => ({
  key: 's5_' + randomUUID(),
  input: {
    email: 's5_' + randomUUID() + '@example.com',
    password: 'public Unicode ' + String.fromCodePoint(0x1f600) + ' fixture password 123',
  },
});
function raw(
  url: string,
  body: Buffer | string,
  headers: Record<string, string | string[]> | string[] = {},
  chunked = false,
) {
  return new Promise<{ status: number; body: string; headers: IncomingHttpHeaders }>(
    (resolve, reject) => {
      const request = httpRequest(
        url + '/api/v1/auth/signup',
        {
          method: 'POST',
          headers: Array.isArray(headers)
            ? [
                'Host',
                new URL(url).host,
                'Content-Type',
                'application/json',
                ...(chunked
                  ? ['Transfer-Encoding', 'chunked']
                  : ['Content-Length', String(Buffer.byteLength(body))]),
                ...headers,
              ]
            : {
                'Content-Type': 'application/json',
                ...(chunked
                  ? { 'Transfer-Encoding': 'chunked' }
                  : { 'Content-Length': String(Buffer.byteLength(body)) }),
                ...headers,
              },
        },
        (response) => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            text += chunk;
          });
          response.on('end', () =>
            resolve({ status: response.statusCode!, body: text, headers: response.headers }),
          );
          response.on('error', reject);
        },
      );
      request.on('error', reject);
      request.end(body);
    },
  );
}
describe.skipIf(!approved)('S5 real HTTP PostgreSQL Redis idempotency contract', () => {
  it('a client disconnected during real rate-limit waiting starts no late reservation or hashing', async () => {
    const app = await ready();
    const r = fresh();
    const before = await f.writes();
    const beforeClaims = Number(
      (await f.owner.pool.query('SELECT count(*)::int AS n FROM signup_idempotency_claims')).rows[0]
        .n,
    );
    const rateEntered = deferred<void>(),
      continueRate = deferred<void>(),
      closed = deferred<void>(),
      intercepted = deferred<void>();
    const guard = SignupRateLimitGuard.prototype.canActivate;
    vi.spyOn(SignupRateLimitGuard.prototype, 'canActivate').mockImplementation(function (
      this: SignupRateLimitGuard,
      context,
    ) {
      context
        .switchToHttp()
        .getResponse<ExpressResponse>()
        .once('close', () => closed.resolve());
      return guard.call(this, context);
    });
    const consume = SignupRateLimiter.prototype.consume;
    vi.spyOn(SignupRateLimiter.prototype, 'consume').mockImplementation(async function (
      this: SignupRateLimiter,
      address,
    ) {
      const result = await consume.call(this, address);
      rateEntered.resolve();
      await continueRate.promise;
      return result;
    });
    const intercept = SignupAdmissionInterceptor.prototype.intercept;
    vi.spyOn(SignupAdmissionInterceptor.prototype, 'intercept').mockImplementation(function (
      this: SignupAdmissionInterceptor,
      context,
      next,
    ) {
      const result = intercept.call(this, context, next);
      intercepted.resolve();
      return result;
    });
    const hash = vi.spyOn(crypto, 'hashPassword');
    const cancellation = new AbortController();
    const pending = fetch(app.url + '/api/v1/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': r.key },
      body: JSON.stringify(r.input),
      signal: cancellation.signal,
    }).catch(() => undefined);
    try {
      await bounded(rateEntered.promise, 'S5 real rate operation entered');
      cancellation.abort();
      await pending;
      await bounded(closed.promise, 'S5 response closed before interceptor');
      continueRate.resolve();
      await bounded(intercepted.promise, 'S5 late interceptor observed');
      await expect.poll(() => app.admission.inventory().active, { timeout: 5000 }).toBe(0);
      expect(hash).not.toHaveBeenCalled();
      expect(app.rateCalls).toBe(1);
      expect(await f.writes()).toEqual(before);
      expect(
        Number(
          (await f.owner.pool.query('SELECT count(*)::int AS n FROM signup_idempotency_claims'))
            .rows[0].n,
        ),
      ).toBe(beforeClaims);
    } finally {
      continueRate.resolve();
      cancellation.abort();
      await pending;
    }
  });
  it.each(['password_credentials', 'security_audit_events'])(
    'missing %s INSERT privilege gives the same fixed failure for new and existing accounts while preserving accepted replay',
    async (table) => {
      const app = await ready();
      const r = fresh();
      accepted(await send(app, r));
      const before = await f.writes();
      const role = '"' + f.runtimeUrl.username + '"';
      await f.owner.pool.query('REVOKE INSERT ON ' + table + ' FROM ' + role);
      const create = vi.spyOn(UserRepository.prototype, 'create');
      try {
        const existing = await send(app, { ...r, key: fresh().key });
        const created = await send(app, fresh());
        expect(existing.status).toBe(500);
        expect(created.status).toBe(500);
        expect(existing.body).toBe(created.body);
        expect(existing.body).toBe(
          '{"error":{"code":"INTERNAL_SERVER_ERROR","message":"Internal server error"}}',
        );
        expect(create).not.toHaveBeenCalled();
        accepted(await send(app, r));
        expect(await f.writes()).toEqual(before);
      } finally {
        await f.owner.pool.query('GRANT INSERT ON ' + table + ' TO ' + role);
      }
    },
  );
  it('deeply nested invalid JSON data is rejected after rate/admission without recursive transformation or database work', async () => {
    const app = await ready();
    const before = await f.writes();
    const body =
      '{"email":"user@example.com","password":' +
      '['.repeat(2000) +
      '"sensitive-sentinel"' +
      ']'.repeat(2000) +
      '}';
    expect(Buffer.byteLength(body)).toBeLessThan(SIGNUP_BODY_BYTES);
    const response = await raw(app.url, body, { 'Idempotency-Key': fresh().key });
    expect(response.status).toBe(400);
    expect(response.body).toBe('{"error":{"code":"HTTP_400","message":"Invalid signup request"}}');
    expect(app.rateCalls).toBe(1);
    await expect.poll(() => app.admission.inventory().active).toBe(0);
    expect(await f.writes()).toEqual(before);
  });
  it('actual incomplete headers are bounded by the configured Node checking interval before application admission', async () => {
    const app = await ready();
    const before = await f.writes();
    const started = performance.now();
    const target = new URL(app.url);
    const socket = connect({ host: '127.0.0.1', port: Number(target.port) });
    let text = '';
    const ended = new Promise<void>((resolve, reject) => {
      socket.on('error', reject);
      socket.on('data', (value) => {
        text += value.toString('utf8');
      });
      socket.on('end', resolve);
      socket.on('connect', () =>
        socket.write('POST /api/v1/auth/signup HTTP/1.1\r\nHost: localhost\r\n'),
      );
    });
    try {
      await bounded(ended, 'S5 partial headers', 8000);
      expect(text.startsWith('HTTP/1.1 408')).toBe(true);
      expect(performance.now() - started).toBeLessThan(7500);
      expect(app.rateCalls).toBe(0);
      expect(await f.writes()).toEqual(before);
    } finally {
      socket.destroy();
    }
  }, 10000);
  it('four independent full HTTP API processes share SQL synchronization and create exactly once', async () => {
    const namespace = 'authcore:test:{signup-s5-process-' + randomUUID() + '}';
    const before = await f.writes();
    const r = fresh();
    const workers: {
      child: ChildProcessWithoutNullStreams;
      ready: Promise<string>;
      exited: Promise<number | null>;
      name: string;
      errors: string[];
    }[] = [];
    try {
      for (let i = 0; i < 4; i++) {
        const name = 's5_http_' + randomUUID().replaceAll('-', '');
        const url = new URL(f.runtimeUrl);
        url.searchParams.set('application_name', name);
        const child = spawn(
          process.execPath,
          [fileURLToPath(new URL('./signup-http-process.test-support.mjs', import.meta.url))],
          {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            env: Object.fromEntries(
              Object.entries(process.env).filter(
                ([key]) => !['DATABASE_URL', 'REDIS_URL'].includes(key),
              ),
            ),
          },
        );
        const gate = deferred<string>();
        const errors: string[] = [];
        let buffer = '';
        child.on('error', () => errors.push('worker start failure'));
        child.stdin.on('error', () => errors.push('worker stdin failure'));
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', () => errors.push('worker stderr'));
        child.stdout.on('data', (value) => {
          buffer += String(value);
          let end;
          while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            try {
              const event = JSON.parse(line);
              if (event.kind === 'READY') {
                const target = new URL(event.url);
                if (target.hostname !== '127.0.0.1' || target.protocol !== 'http:')
                  throw new Error('rejected');
                gate.resolve(event.url);
              } else errors.push('worker protocol failure');
            } catch {
              errors.push('worker output failure');
            }
          }
        });
        const exited = new Promise<number | null>((resolve) =>
          child.once('close', (code) => resolve(code)),
        );
        const ready = Promise.race([
          gate.promise,
          exited.then(() => {
            throw new Error('S5 worker exited before ready');
          }),
        ]);
        void ready.catch(() => {});
        workers.push({ child, ready, exited, name, errors });
        const hmac = testSignupConfiguration();
        child.stdin.write(
          JSON.stringify({
            databaseUrl: url.toString(),
            redisUrl: f.redisUrl.toString(),
            namespace,
            secret: [...hmac.secret],
            metadata: hmac.metadata,
          }) + '\n',
        );
      }
      const urls = await bounded(
        Promise.all(workers.map((worker) => worker.ready)),
        'S5 HTTP workers ready',
        12000,
      );
      const responses = await Promise.all(
        urls.map((url) => raw(url, JSON.stringify(r.input), { 'Idempotency-Key': r.key })),
      );
      for (const response of responses) accepted(response);
      expect(await f.writes()).toEqual({
        ...before,
        users: before.users + 1,
        credentials: before.credentials + 1,
        audits: before.audits + 1,
        results: before.results + 1,
      });
      for (const worker of workers) worker.child.stdin.write('{"command":"STOP"}\n');
      for (const worker of workers) {
        expect(await bounded(worker.exited, 'S5 HTTP worker stopped', 10000)).toBe(0);
        expect(worker.errors).toEqual([]);
      }
      await expect
        .poll(async () =>
          Number(
            (
              await f.owner.pool.query(
                'SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=ANY($1::text[])',
                [workers.map((worker) => worker.name)],
              )
            ).rows[0].n,
          ),
        )
        .toBe(0);
      console.info(
        JSON.stringify({
          scenario: 'S5_FULL_HTTP_PROCESSES',
          processes: 4,
          accepted: 4,
          domainExecutions: 1,
          authoritativeBackendsAbsent: true,
        }),
      );
    } finally {
      for (const worker of workers) {
        if (worker.child.exitCode === null && worker.child.signalCode === null)
          worker.child.kill('SIGKILL');
        await bounded(worker.exited, 'S5 HTTP child cleanup', 5000);
        worker.child.stdin.destroy();
        worker.child.stdout.destroy();
        worker.child.stderr.destroy();
      }
      const client = await f.redis.getClient();
      for (const key of [
        namespace + ':global',
        namespace + ':admission',
        namespace + ':ip:' + createHash('sha256').update('127.0.0.1').digest('hex'),
      ])
        await client.del(key);
    }
  }, 30000);
  it('startup namespace drift fails closed before an enabled HTTP listener is available', async () => {
    const before = await f.writes();
    await f.owner.pool.query(
      "UPDATE signup_idempotency_namespace SET attestation_key_digest=repeat('0',64)",
    );
    await expect(ready()).rejects.toThrow();
    expect(await f.writes()).toEqual(before);
  });
  it('unknown T2 with a fresh missing result returns503 and never performs an internal creation retry', async () => {
    const database = f.database();
    const app = await ready(database);
    const before = await f.writes();
    const r = fresh();
    let commits = 0;
    const connect = database.pool.connect.bind(database.pool);
    const wrapped = new WeakSet<object>();
    vi.spyOn(database.pool, 'connect').mockImplementation((async () => {
      const client = await connect();
      if (!wrapped.has(client)) {
        wrapped.add(client);
        const query = client.query.bind(client);
        vi.spyOn(client, 'query').mockImplementation(((config: unknown, ...args: unknown[]) => {
          if (config === 'COMMIT' && ++commits === 2)
            return Promise.reject(new Error('controlled before-send COMMIT rejection'));
          return Reflect.apply(query, client, [config, ...args]);
        }) as typeof client.query);
      }
      return client;
    }) as typeof database.pool.connect);
    const create = vi.spyOn(UserRepository.prototype, 'create');
    const response = await send(app, r);
    expect(response.status).toBe(503);
    expect(response.headers['retry-after']).toBe('1');
    expect(response.body).toBe(
      '{"error":{"code":"HTTP_503","message":"Signup temporarily unavailable"}}',
    );
    await expect.poll(() => app.admission.inventory().active).toBe(0);
    expect(create).toHaveBeenCalledOnce();
    expect(await f.writes()).toEqual(before);
    vi.restoreAllMocks();
    accepted(await send(app, r));
    expect(await f.writes()).toEqual({
      ...before,
      users: before.users + 1,
      credentials: before.credentials + 1,
      audits: before.audits + 1,
      results: before.results + 1,
    });
  });
  let f: ProtocolFixture;
  const apps = new Set<HttpFixture>();
  beforeAll(async () => {
    f = await createProtocolFixture(approved!);
  }, 30000);
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const app of apps) await app.close();
    apps.clear();
    await f?.drainAdmissions();
    await f?.seedAnchor();
  }, 15000);
  afterAll(async () => {
    await f?.close();
  }, 30000);
  async function ready(database = f.database(), enabled = true) {
    const app = await startSignupHttp(f, database, enabled);
    apps.add(app);
    return app;
  }
  async function send(app: HttpFixture, value = fresh()) {
    return raw(app.url, JSON.stringify(value.input), { 'Idempotency-Key': value.key });
  }
  function accepted(response: Awaited<ReturnType<typeof raw>>) {
    expect(response.status).toBe(202);
    expect(response.body).toBe('{"status":"accepted"}');
    expect(response.headers['cache-control']).toBe('no-store');
    for (const name of ['idempotency-replayed', 'location', 'x-user-id', 'x-account-exists'])
      expect(response.headers[name]).toBeUndefined();
  }
  it('commits exact202 then replays without hashing, account reads or duplicate side effects', async () => {
    const app = await ready();
    const r = fresh();
    accepted(await send(app, r));
    const before = await f.writes();
    const hash = vi.spyOn(crypto, 'hashPassword');
    const lookup = vi.spyOn(UserRepository.prototype, 'findByNormalizedEmail');
    accepted(await send(app, r));
    expect(hash).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(await f.writes()).toEqual(before);
    expect(app.rateCalls).toBe(2);
  });
  it('retained binding conflict gives fixed409 without changing claim or account state', async () => {
    const app = await ready();
    const r = fresh();
    accepted(await send(app, r));
    const before = await f.writes();
    const hash = vi.spyOn(crypto, 'hashPassword');
    const response = await send(app, {
      ...r,
      input: { ...r.input, password: r.input.password + ' changed' },
    });
    expect(response.status).toBe(409);
    expect(response.body).toBe(
      '{"error":{"code":"HTTP_409","message":"Idempotency key unavailable"}}',
    );
    expect(response.headers['cache-control']).toBe('no-store');
    expect(hash).not.toHaveBeenCalled();
    expect(await f.writes()).toEqual(before);
  });
  it('four identical HTTP retries through independent API instances commit once', async () => {
    const instances = await Promise.all(Array.from({ length: 4 }, () => ready()));
    const r = fresh();
    const before = await f.writes();
    for (const response of await Promise.all(instances.map((app) => send(app, r))))
      accepted(response);
    expect(await f.writes()).toEqual({
      ...before,
      users: before.users + 1,
      credentials: before.credentials + 1,
      audits: before.audits + 1,
      results: before.results + 1,
    });
  });
  it('concurrent conflicting HTTP requests retain one winner and reject the loser', async () => {
    const app = await ready();
    const r = fresh();
    const before = await f.writes();
    const responses = await Promise.all([
      send(app, r),
      send(app, { ...r, input: { ...r.input, email: 'other_' + randomUUID() + '@example.com' } }),
    ]);
    expect(responses.map((x) => x.status).sort()).toEqual([202, 409]);
    expect(await f.writes()).toEqual({
      ...before,
      users: before.users + 1,
      credentials: before.credentials + 1,
      audits: before.audits + 1,
      results: before.results + 1,
    });
  });
  it.each([
    'missing',
    'short',
    'long',
    'comma',
    'quote',
    'space',
    'unicode',
    'identical-duplicate',
    'mixed-case-duplicate',
  ])(
    'rejects %s key after rate limiting and before admission or claim reservation',
    async (kind) => {
      const app = await ready();
      const r = fresh();
      const before = await f.writes();
      const beforeClaims = Number(
        (await f.owner.pool.query('SELECT count(*)::int AS n FROM signup_idempotency_claims'))
          .rows[0].n,
      );
      const values: Record<string, string | string[] | undefined> = {
        missing: undefined,
        short: 'x'.repeat(15),
        long: 'x'.repeat(129),
        comma: r.key + ',' + r.key,
        quote: '"' + r.key + '"',
        space: r.key + ' x',
        unicode: r.key + 'é',
        'identical-duplicate': [r.key, r.key],
      };
      const headers: Record<string, string | string[]> = {};
      if (kind === 'mixed-case-duplicate') {
        headers['Idempotency-Key'] = r.key;
        headers['idempotency-key'] = r.key;
      } else if (values[kind] !== undefined) headers['Idempotency-Key'] = values[kind]!;
      const response = await raw(
        app.url,
        JSON.stringify(r.input),
        kind === 'mixed-case-duplicate'
          ? ['Idempotency-Key', r.key, 'idempotency-key', r.key]
          : headers,
      );
      expect(response.status).toBe(400);
      expect(response.body).toBe(
        '{"error":{"code":"HTTP_400","message":"Invalid Idempotency-Key"}}',
      );
      expect(response.headers['cache-control']).toBe('no-store');
      expect(app.rateCalls).toBe(1);
      expect(app.admissionAcquires).toBe(0);
      expect(
        Number(
          (await f.owner.pool.query('SELECT count(*)::int AS n FROM signup_idempotency_claims'))
            .rows[0].n,
        ),
      ).toBe(beforeClaims);
      expect(app.admission.inventory().active).toBe(0);
      expect(await f.writes()).toEqual(before);
    },
  );
  it.each([16, 128])('accepts the frozen %i-character header boundary', async (length) => {
    const app = await ready();
    accepted(await send(app, { ...fresh(), key: 'A'.repeat(length) }));
  });
  it('Node optional header whitespace is parsed without extra application decoding', async () => {
    const app = await ready();
    const r = fresh();
    accepted(
      await raw(app.url, JSON.stringify(r.input), { 'iDeMpOtEnCy-KeY': '  ' + r.key + '  ' }),
    );
  });
  it('accepts128 Unicode scalar password characters and escaped JSON well below16KiB', async () => {
    const app = await ready();
    const r = fresh();
    r.input.password = String.fromCodePoint(0x1f600).repeat(128);
    const body = JSON.stringify(r.input).replaceAll(
      String.fromCodePoint(0x1f600),
      '\\ud83d\\ude00',
    );
    expect(Buffer.byteLength(body)).toBeLessThan(SIGNUP_BODY_BYTES);
    accepted(await raw(app.url, body, { 'Idempotency-Key': r.key }));
    const encoded = (
      await f.owner.pool.query(
        'SELECT p.password_hash FROM password_credentials p JOIN users u ON u.id=p.user_id WHERE u.email_normalized=$1',
        [r.input.email],
      )
    ).rows[0].password_hash;
    expect(await crypto.verifyPassword(encoded, r.input.password)).toBe(true);
  });
  it('accepts an exactly16KiB valid JSON entity and rejects the next byte before rate or database work', async () => {
    const app = await ready();
    const r = fresh();
    const json = JSON.stringify(r.input);
    const body = json + ' '.repeat(SIGNUP_BODY_BYTES - Buffer.byteLength(json));
    accepted(await raw(app.url, body, { 'Idempotency-Key': r.key }));
    const before = await f.writes();
    const response = await raw(app.url, body + ' ', { 'Idempotency-Key': fresh().key });
    expect(response.status).toBe(413);
    expect(response.body).toBe('{"error":{"code":"HTTP_413","message":"Request too large"}}');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(app.rateCalls).toBe(1);
    expect(await f.writes()).toEqual(before);
  });
  it('bounds a chunked body at16KiB without waiting for unbounded drain', async () => {
    const app = await ready();
    const before = await f.writes();
    const response = await raw(
      app.url,
      ' '.repeat(SIGNUP_BODY_BYTES + 1),
      { 'Idempotency-Key': fresh().key },
      true,
    );
    expect(response.status).toBe(413);
    expect(app.rateCalls).toBe(0);
    expect(await f.writes()).toEqual(before);
  });
  it.each(['gzip', 'text', 'charset', 'duplicate-type'])(
    'rejects %s request bodies with fixed415 before rate or database work',
    async (kind) => {
      const app = await ready();
      const r = fresh();
      const before = await f.writes();
      const headers: Record<string, string | string[]> = { 'Idempotency-Key': r.key };
      if (kind === 'gzip') headers['Content-Encoding'] = 'gzip';
      if (kind === 'text') headers['Content-Type'] = 'text/plain';
      if (kind === 'charset') headers['Content-Type'] = 'application/json; charset=utf-16';
      if (kind === 'duplicate-type')
        headers['Content-Type'] = ['application/json', 'application/json'];
      const response = await raw(
        app.url,
        kind === 'gzip' ? gzipSync(JSON.stringify(r.input)) : JSON.stringify(r.input),
        headers,
      );
      expect(response.status).toBe(415);
      expect(response.body).toBe(
        '{"error":{"code":"HTTP_415","message":"Unsupported request body"}}',
      );
      expect(response.headers['cache-control']).toBe('no-store');
      expect(app.rateCalls).toBe(0);
      expect(await f.writes()).toEqual(before);
    },
  );
  it.each(['malformed', 'unknown-property', 'short-password'])(
    'normalizes %s JSON/DTO errors without echoing input',
    async (kind) => {
      const app = await ready();
      const r = fresh();
      const before = await f.writes();
      const body =
        kind === 'malformed'
          ? '{"password":"sensitive-sentinel"'
          : JSON.stringify({
              ...r.input,
              ...(kind === 'unknown-property'
                ? { role: 'sensitive-sentinel' }
                : { password: 'short' }),
            });
      const response = await raw(app.url, body, { 'Idempotency-Key': r.key });
      expect(response.status).toBe(400);
      expect(response.body).toBe(
        '{"error":{"code":"HTTP_400","message":"Invalid signup request"}}',
      );
      expect(response.headers['cache-control']).toBe('no-store');
      expect(await f.writes()).toEqual(before);
    },
  );
  it('disabled signup retains403 and consumes no rate/admission/claim even with a missing key', async () => {
    const app = await ready(f.database(), false);
    const before = await f.writes();
    const response = await raw(app.url, JSON.stringify(fresh().input));
    expect(response.status).toBe(403);
    expect(response.body).toBe('{"error":{"code":"HTTP_403","message":"Signup is disabled"}}');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(app.rateCalls).toBe(0);
    expect(await f.writes()).toEqual(before);
  });
  it('accepted replays still consume real Redis quota and the sixth request gets429', async () => {
    const app = await ready();
    const r = fresh();
    for (let i = 0; i < 5; i++) accepted(await send(app, r));
    const before = await f.writes();
    const response = await send(app, r);
    expect(response.status).toBe(429);
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(await f.writes()).toEqual(before);
  });
  it('T1 acknowledgement loss reconciles the retained claim then creates exactly once', async () => {
    const proxy = await f.proxy();
    const app = await ready(f.database(proxy.url));
    const before = await f.writes();
    const r = fresh();
    proxy.arm();
    const pending = send(app, r);
    await proxy.waitForDrop();
    accepted(await pending);
    expect(await f.writes()).toEqual({
      ...before,
      users: before.users + 1,
      credentials: before.credentials + 1,
      audits: before.audits + 1,
      results: before.results + 1,
    });
  });
  it('T2 lost acknowledgement uses T3 positive proof and HTTP replay without duplicate domain work', async () => {
    const proxy = await f.proxy();
    const app = await ready(f.database(proxy.url));
    const before = await f.writes();
    const r = fresh();
    const original = Results.prototype.recordAccepted;
    vi.spyOn(Results.prototype, 'recordAccepted').mockImplementation(async function (
      this: Results,
      id,
    ) {
      const value = await original.call(this, id);
      proxy.arm();
      return value;
    });
    const pending = send(app, r);
    await proxy.waitForDrop();
    accepted(await pending);
    vi.restoreAllMocks();
    accepted(await send(app, r));
    expect(await f.writes()).toEqual({
      ...before,
      users: before.users + 1,
      credentials: before.credentials + 1,
      audits: before.audits + 1,
      results: before.results + 1,
    });
  });
  it('acknowledged acceptance survives a deliberately throwing release listener', async () => {
    const database = f.database();
    const app = await ready(database);
    let releases = 0;
    const fault = () => {
      if (++releases === 2) throw new Error('controlled release fault');
    };
    database.pool.on('release', fault);
    try {
      accepted(await send(app));
    } finally {
      database.pool.removeListener('release', fault);
    }
    expect(releases).toBeGreaterThanOrEqual(2);
  });
  it('actual client disconnect during hashing retains native work and starts no T2', async () => {
    const app = await ready();
    const r = fresh();
    const before = await f.writes();
    const entered = deferred<void>();
    const gate = deferred<void>();
    const original = crypto.hashPassword;
    let requestSignal: AbortSignal | undefined;
    const signup = SignupService.prototype.signup;
    vi.spyOn(SignupService.prototype, 'signup').mockImplementation(async function (
      this: SignupService,
      input,
      key,
      options,
    ) {
      requestSignal = options?.signal;
      return signup.call(this, input, key, options);
    });
    vi.spyOn(crypto, 'hashPassword').mockImplementation(async (password) => {
      const native = original(password);
      entered.resolve();
      await gate.promise;
      return native;
    });
    const controller = new AbortController();
    const pending = fetch(app.url + '/api/v1/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': r.key },
      body: JSON.stringify(r.input),
      signal: controller.signal,
    }).catch(() => undefined);
    try {
      await bounded(entered.promise, 'S5 native hash entered');
      controller.abort();
      await pending;
      await expect.poll(() => requestSignal?.aborted).toBe(true);
      expect(app.admission.inventory().active).toBe(1);
    } finally {
      gate.resolve();
    }
    await expect.poll(() => app.admission.inventory().active, { timeout: 5000 }).toBe(0);
    expect(await f.writes()).toEqual(before);
  });
  it('bounded incomplete upload returns controlled503 with no admitted or reserved work', async () => {
    const app = await ready();
    const before = await f.writes();
    const started = performance.now();
    let upload: ReturnType<typeof httpRequest> | undefined;
    const pending = new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest(
        app.url + '/api/v1/auth/signup',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': '100',
            'Idempotency-Key': fresh().key,
          },
        },
        (response) => {
          let body = '';
          response.on('data', (chunk) => {
            body += String(chunk);
          });
          response.on('end', () => resolve({ status: response.statusCode!, body }));
          response.on('error', reject);
        },
      );
      request.on('error', reject);
      upload = request;
      request.write('{');
    });
    let response: Awaited<typeof pending>;
    try {
      response = await bounded(pending, 'S5 upload response', 8000);
    } finally {
      upload?.destroy();
    }
    expect(response.status).toBe(503);
    expect(response.body).toBe(
      '{"error":{"code":"HTTP_503","message":"Signup temporarily unavailable"}}',
    );
    expect(performance.now() - started).toBeLessThan(7500);
    expect(app.rateCalls).toBe(0);
    expect(await f.writes()).toEqual(before);
  }, 10000);
  it('header budgets retain the complete raw inventory and reject oversized or late duplicate fields', async () => {
    const app = await ready();
    const r = fresh();
    const before = await f.writes();
    const headers: Record<string, string | string[]> = { 'Idempotency-Key': r.key };
    for (let i = 0; i < 65; i++) headers['X-Padding-' + i] = 'x';
    headers['idempotency-key'] = r.key;
    expect((await raw(app.url, JSON.stringify(r.input), headers)).status).toBe(400);
    expect(
      (
        await raw(app.url, JSON.stringify(r.input), {
          'Idempotency-Key': r.key,
          'X-Padding': 'x'.repeat(9000),
        })
      ).status,
    ).toBe(431);
    const transport = await raw(app.url, JSON.stringify(r.input), {
      'Idempotency-Key': r.key,
      'X-Padding': 'x'.repeat(17000),
    });
    expect(transport.status).toBe(431);
    const server = app.app.getHttpServer() as Server;
    expect(server.maxHeadersCount).toBe(0);
    expect(server.headersTimeout).toBe(5000);
    expect(server.requestTimeout).toBe(10000);
    expect(app.rateCalls).toBe(0);
    expect(await f.writes()).toEqual(before);
  });
  it('existing and new accounts have the same body/headers, run actual Argon2 and meet a coarse isolated timing target', async () => {
    const app = await ready();
    const r = fresh();
    accepted(await send(app, r));
    const hash = vi.spyOn(crypto, 'hashPassword');
    const timings = { existing: [] as number[], created: [] as number[] };
    for (let i = 0; i < 8; i++) {
      await app.clearOwnedRate(); // Calibration only: delete this test's own ephemeral quota keys.
      for (const kind of (i % 2 ? ['existing', 'created'] : ['created', 'existing']) as (
        'existing' | 'created'
      )[]) {
        const value = fresh();
        if (kind === 'existing') value.input.email = r.input.email;
        const started = performance.now();
        accepted(await send(app, value));
        timings[kind].push(performance.now() - started);
      }
    }
    expect(hash).toHaveBeenCalledTimes(16);
    const median = (samples: number[]) =>
      [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;
    const ratio = median(timings.existing) / median(timings.created);
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
    console.info(
      JSON.stringify({
        scenario: 'S5_ENUMERATION_TIMING',
        samplesPerGroup: 8,
        medianExistingMs: median(timings.existing),
        medianCreatedMs: median(timings.created),
        ratio,
        scope: 'isolated coarse regression; not production statistical proof',
      }),
    );
  }, 15000);
  it('permission failure is safe500 and logs no input, key, DSN or raw infrastructure exception', async () => {
    const app = await ready();
    const r = fresh();
    const role = '"' + f.runtimeUrl.username + '"';
    const before = await f.writes();
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    await f.owner.pool.query('REVOKE INSERT ON security_audit_events FROM ' + role);
    try {
      const response = await send(app, r);
      expect(response.status).toBe(500);
      expect(response.body).toBe(
        '{"error":{"code":"INTERNAL_SERVER_ERROR","message":"Internal server error"}}',
      );
      expect(response.headers['cache-control']).toBe('no-store');
      expect(log).toHaveBeenCalledExactlyOnceWith({
        event: 'http.unhandled_exception',
        method: 'POST',
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain(r.key);
      expect(JSON.stringify(log.mock.calls)).not.toContain(r.input.password);
      expect(await f.writes()).toEqual(before);
    } finally {
      await f.owner.pool.query('GRANT INSERT ON security_audit_events TO ' + role);
    }
  });
});
