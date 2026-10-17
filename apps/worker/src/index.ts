import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDatabaseClient, EmailDeliveryRepository } from '@authcore/db';
import { LocalMailboxTransport } from './email.js';
import { VerificationWorker } from './verification-worker.js';

async function main() {
  if (process.env.NODE_ENV !== 'development' || process.env.AUTHCORE_LOCAL_DEMO !== 'true')
    throw new Error('WORKER_REQUIRES_EXPLICIT_LOCAL_CONFIGURATION');
  const value = JSON.parse(
    await readFile(resolve(process.argv[2] ?? '../../.local-demo/worker.json'), 'utf8'),
  );
  if (
    value.localDemo !== true ||
    typeof value.databaseUrl !== 'string' ||
    typeof value.deliveryKey !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.deliveryKey)
  )
    throw new Error('WORKER_CONFIGURATION_INVALID');
  const target = new URL(value.databaseUrl);
  if (
    !['postgres:', 'postgresql:'].includes(target.protocol) ||
    target.hostname !== '127.0.0.1' ||
    target.pathname !== '/authcore_demo'
  )
    throw new Error('WORKER_DATABASE_TARGET_REJECTED');
  const transport = new LocalMailboxTransport({
    localDemo: true,
    nodeEnvironment: process.env.NODE_ENV,
    mailboxOrigin: value.mailboxOrigin,
    webOrigin: value.webOrigin,
  });
  const database = createDatabaseClient({ connectionString: value.databaseUrl });
  database.pool.on('error', () =>
    process.stdout.write('{"event":"worker.idle_connection_error"}\n'),
  );
  const shutdown = new AbortController();
  process.once('SIGINT', () => shutdown.abort());
  process.once('SIGTERM', () => shutdown.abort());
  process.on('message', (message) => {
    if (message === 'authcore:shutdown') shutdown.abort();
  });
  process.send?.('authcore:ready');
  try {
    await new VerificationWorker(new EmailDeliveryRepository(database.pool), transport, [
      { id: 'local-v1', key: Buffer.from(value.deliveryKey, 'hex') },
    ]).run(shutdown.signal);
  } finally {
    await database.pool.end();
    process.disconnect?.();
  }
}
void main().catch(() => {
  process.stderr.write('{"event":"worker.startup_failed"}\n');
  process.exitCode = 1;
  process.disconnect?.();
});
