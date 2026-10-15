// Test-only full HTTP API process. Disposable credentials/configuration use private stdin.
import 'reflect-metadata';
import process from 'node:process';
import { URL } from 'node:url';
import { createInterface } from 'node:readline';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createDatabaseClient, drainSignupTransactionOwners } from '@authcore/db';
import { GlobalExceptionFilter } from '../../dist/common/filters/global-exception.filter.js';
import { DatabaseService } from '../../dist/database/database.service.js';
import { RedisService } from '../../dist/redis/redis.service.js';
import { AuthController } from '../../dist/identity/auth.controller.js';
import { SignupService, SIGNUP_CONFIGURATION } from '../../dist/identity/signup.service.js';
import { SignupAdmission } from '../../dist/identity/signup-admission.js';
import { SignupAdmissionInterceptor } from '../../dist/identity/signup-admission.interceptor.js';
import { SignupEnabledGuard } from '../../dist/identity/signup-enabled.guard.js';
import { SignupKeyGuard } from '../../dist/identity/signup-key.guard.js';
import { SignupRateLimitGuard } from '../../dist/identity/signup-rate-limit.guard.js';
import { SignupRateLimiter } from '../../dist/identity/signup-rate-limiter.js';
import { configureSignupHttp, SignupHttpAdapter } from '../../dist/identity/signup-http.js';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const lines = createInterface({ input: process.stdin });
let app,
  database,
  redis,
  admission,
  started = false,
  stopping = false;
async function close() {
  if (stopping) return;
  stopping = true;
  if (app) await app.close();
  if (database) {
    await drainSignupTransactionOwners(database);
    await database.pool.end();
  }
  redis?.onApplicationShutdown();
  lines.close();
  process.stdin.destroy();
}
lines.on('line', (line) => {
  void (async () => {
    if (started) {
      if (JSON.parse(line).command !== 'STOP') throw new Error('rejected');
      await close();
      return;
    }
    started = true;
    if (
      process.env.GITHUB_ACTIONS !== 'true' ||
      process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
      process.env.S5_POSTGRES_APPROVED !== 'true'
    )
      throw new Error('rejected');
    const config = JSON.parse(line),
      url = new URL(config.databaseUrl),
      target = new URL(config.redisUrl);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      url.port !== '5432' ||
      !/^\/s2_[a-f0-9]{32}$/.test(url.pathname)
    )
      throw new Error('rejected');
    if (
      target.protocol !== 'redis:' ||
      !['localhost', '127.0.0.1'].includes(target.hostname) ||
      target.port !== '6380' ||
      target.pathname !== '/15' ||
      target.search ||
      target.hash
    )
      throw new Error('rejected');
    if (!/^authcore:test:\{signup-s5-process-[a-f0-9-]{36}\}$/.test(config.namespace))
      throw new Error('rejected');
    process.env.DATABASE_URL = url.toString();
    process.env.REDIS_URL = target.toString();
    process.env.WEB_ORIGIN = 'http://localhost:3000';
    process.env.SIGNUP_ENABLED = 'true';
    database = createDatabaseClient({ connectionString: url.toString() });
    database.pool.on('error', () => send({ kind: 'FAILED', code: 'IDLE_POOL_ERROR' }));
    redis = new RedisService();
    const evaluate = async (script, args) => {
      const keys = args.keys.map((key) => {
        if (!key.startsWith('authcore:{signup}:')) throw new Error('rejected');
        return config.namespace + ':' + key.slice('authcore:{signup}:'.length);
      });
      return (await redis.getClient())
        .withCommandOptions({ timeout: 1000 })
        .eval(script, { ...args, keys });
    };
    const adapter = {
      getClient: async () => ({ eval: evaluate, withCommandOptions: () => ({ eval: evaluate }) }),
    };
    admission = new SignupAdmission(adapter);
    class HttpWorkerModule {}
    Module({
      controllers: [AuthController],
      providers: [
        SignupService,
        SignupEnabledGuard,
        SignupKeyGuard,
        SignupRateLimitGuard,
        SignupRateLimiter,
        SignupAdmissionInterceptor,
        { provide: SignupAdmission, useValue: admission },
        { provide: RedisService, useValue: adapter },
        { provide: DatabaseService, useValue: { getClient: () => database } },
        {
          provide: SIGNUP_CONFIGURATION,
          useValue: {
            hmac: { secret: Uint8Array.from(config.secret), metadata: config.metadata },
            executionWindowMs: 86400000,
          },
        },
      ],
    })(HttpWorkerModule);
    app = await NestFactory.create(HttpWorkerModule, new SignupHttpAdapter(), {
      logger: false,
      bodyParser: false,
    });
    configureSignupHttp(app);
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        validationError: { target: false, value: false },
      }),
    );
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.listen(0, '127.0.0.1');
    send({ kind: 'READY', url: await app.getUrl() });
  })().catch(async () => {
    send({ kind: 'FAILED', code: 'HTTP_WORKER_FAILURE' });
    process.exitCode = 1;
    try {
      await close();
    } catch {
      send({ kind: 'FAILED', code: 'HTTP_WORKER_CLEANUP' });
    }
  });
});
