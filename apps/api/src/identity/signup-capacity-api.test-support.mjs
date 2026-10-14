// Disposable loopback HTTP test process. No production route or environment loading.
import { createServer } from 'node:http';
import process from 'node:process';
import { URL } from 'node:url';
import { setTimeout } from 'node:timers';
import { createInterface } from 'node:readline';
import {
  createDatabaseClient,
  runOwnedSignupTransaction,
  acquireSignupCapacity,
  drainSignupTransactionOwners,
} from '@authcore/db';
const lines = createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
let database;
let server;
let finish;
let stopping = false;
let active;
async function stop() {
  if (stopping) return;
  stopping = true;
  finish?.();
  try {
    if (server)
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    if (active) await active;
    if (database) {
      await drainSignupTransactionOwners(database);
      await database.pool.end();
    }
  } catch {
    process.exitCode = 1;
    send({ kind: 'FAILED', code: 'TEST_PROCESS_CLEANUP' });
  }
  lines.close();
  process.stdin.destroy();
}
lines.on('line', (line) => {
  if (database) {
    if (line === 'stop') void stop();
    return;
  }
  void (async () => {
    const config = JSON.parse(line);
    const url = new URL(config.url);
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') throw new Error('rejected');
    if (!/^\/s2_[a-f0-9]{32}$/.test(url.pathname)) throw new Error('rejected');
    database = createDatabaseClient({ connectionString: url.toString() });
    database.pool.on('error', () => {
      process.exitCode = 1;
      send({ kind: 'FAILED', code: 'TEST_IDLE_POOL_ERROR' });
    });
    server = createServer((request, response) => {
      request.resume();
      if (stopping) {
        response.writeHead(503).end();
        return;
      }
      if (request.method === 'POST' && request.url === '/release') {
        finish?.();
        response.writeHead(200).end();
        return;
      }
      if (request.method !== 'POST' || request.url !== '/hold' || active) {
        response.writeHead(404).end();
        return;
      }
      let done = false;
      const release = new Promise((resolve) => {
        finish = () => {
          done = true;
          resolve();
        };
      });
      active = (async () => {
        const result = await runOwnedSignupTransaction(database, async (tx) => {
          const slot = await acquireSignupCapacity(tx);
          const row = (await tx.execute('SELECT pg_backend_pid() AS pid, current_user AS login'))
            .rows[0];
          send({ kind: 'HELD', slot, pid: Number(row.pid), login: row.login });
          while (!done) {
            await Promise.race([release, new Promise((resolve) => setTimeout(resolve, 100))]);
            if (!done) await tx.execute('SELECT 1');
          }
          return slot;
        });
        await result.workSettlement;
        await result.settlement;
        response.writeHead(result.outcome === 'COMMIT_ACK' ? 202 : 503, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        });
        response.end(JSON.stringify({ outcome: result.outcome, slot: result.value }));
        if (result.outcome !== 'COMMIT_ACK') process.exitCode = 1;
      })().catch(() => {
        process.exitCode = 1;
        send({ kind: 'FAILED', code: 'TEST_CAPACITY_REQUEST' });
        response.writeHead(503).end();
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    send({ kind: 'READY', port: server.address().port });
  })().catch(() => {
    process.exitCode = 1;
    send({ kind: 'FAILED', code: 'TEST_PROCESS_STARTUP' });
    void stop();
  });
});
lines.on('close', () => {
  if (!stopping) void stop();
});
process.on('SIGTERM', () => void stop());
