// Test-only crash worker: credentials/configuration arrive only through private stdin.
import 'reflect-metadata';
import process from 'node:process';
import { URL } from 'node:url';
import { createInterface } from 'node:readline';
import { createDatabaseClient, drainSignupTransactionOwners } from '@authcore/db';
import { hashPassword } from '@authcore/crypto';
import { SignupAdmission } from '../../dist/identity/signup-admission.js';
import { RedisService } from '../../dist/redis/redis.service.js';
import { createSignupReservationBoundary } from '../../dist/identity/signup-reservation.js';
import { IdempotentSignupService } from '../../dist/identity/signup-protocol.service.js';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const lines = createInterface({ input: process.stdin });
let started = false;
let database;
let redis;
let admission;
lines.on('line', (line) => {
  if (started) return;
  started = true;
  void (async () => {
    if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted')
      throw new Error('rejected');
    const config = JSON.parse(line);
    const url = new URL(config.databaseUrl);
    const redisUrl = new URL(config.redisUrl);
    if (
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      !/^\/s2_[a-f0-9]{32}$/.test(url.pathname) ||
      url.port !== '5432'
    )
      throw new Error('rejected');
    if (
      !['localhost', '127.0.0.1'].includes(redisUrl.hostname) ||
      redisUrl.port !== '6380' ||
      redisUrl.pathname !== '/15'
    )
      throw new Error('rejected');
    process.env.DATABASE_URL = url.toString();
    process.env.REDIS_URL = redisUrl.toString();
    process.env.WEB_ORIGIN = 'http://localhost:3000';
    process.env.SIGNUP_ENABLED = 'false';
    database = createDatabaseClient({ connectionString: url.toString() });
    database.pool.on('error', () => send({ kind: 'FAILED', code: 'IDLE_POOL_ERROR' }));
    redis = new RedisService();
    admission = new SignupAdmission(redis);
    const boundary = await createSignupReservationBoundary(database, {
      enabled: true,
      configuration: { secret: Uint8Array.from(config.secret), metadata: config.metadata },
      executionWindowMs: 86400000,
    });
    const blocked = () => new Promise(() => {});
    const checkpoint = async (phase, query) => {
      const row = (await query('SELECT pg_backend_pid() AS pid')).rows[0];
      send({ kind: 'CHECKPOINT', phase, pid: Number(row.pid) });
      await blocked();
    };
    if (config.phase !== 'after_t1') {
      const connect = database.pool.connect.bind(database.pool);
      const wrapped = new WeakSet();
      let commits = 0;
      database.pool.connect = async () => {
        const client = await connect();
        if (!wrapped.has(client)) {
          wrapped.add(client);
          const query = client.query.bind(client);
          client.query = async (text, ...args) => {
            const sql = typeof text === 'string' ? text : text.text;
            const result = await query(text, ...args);
            if (
              config.phase === 'after_result' &&
              /^\s*insert/i.test(sql) &&
              sql.includes('signup_idempotency_results')
            )
              await checkpoint('after_result', query);
            if (config.phase === 'after_commit' && sql === 'COMMIT' && ++commits === 2) {
              if (result.command !== 'COMMIT') throw new Error('unexpected tag');
              await checkpoint('after_commit', query);
            }
            return result;
          };
        }
        return client;
      };
    }
    const service = new IdempotentSignupService(database, boundary, {
      hashPassword:
        config.phase === 'after_t1'
          ? async () => {
              await checkpoint('after_t1', database.pool.query.bind(database.pool));
              return '';
            }
          : hashPassword,
    });
    const operation = admission.start(async () => service.start(config.key, config.input).response);
    const response = await operation.response;
    await operation.settlement;
    send({ kind: 'FAILED', code: 'UNEXPECTED_REQUEST_COMPLETION', status: response.status });
    process.exitCode = 1;
  })().catch(async () => {
    send({ kind: 'FAILED', code: 'CRASH_WORKER_FAILURE' });
    process.exitCode = 1;
    try {
      if (admission) await admission.onApplicationShutdown();
      if (database) {
        await drainSignupTransactionOwners(database);
        await database.pool.end();
      }
      redis?.onApplicationShutdown();
    } catch {
      send({ kind: 'FAILED', code: 'CRASH_WORKER_CLEANUP' });
    } finally {
      lines.close();
      process.stdin.destroy();
    }
  });
});
