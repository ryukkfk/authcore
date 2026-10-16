// Test-only worker process. Disposable credentials arrive through private stdin.
import { createInterface } from 'node:readline';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { setInterval } from 'node:timers';
import { createDatabaseClient, EmailDeliveryRepository } from '../dist/index.js';
const input = createInterface({ input: process.stdin });
input.once('line', (line) => {
  void (async () => {
    if (process.env.AUTHCORE_EMAIL_CRASH_TEST !== 'true') throw new Error();
    const configuration = JSON.parse(line),
      target = new URL(configuration.databaseUrl);
    if (
      !['postgres:', 'postgresql:'].includes(target.protocol) ||
      target.hostname !== '127.0.0.1' ||
      !['5432', '55433'].includes(target.port) ||
      !/^\/email_[a-f0-9]{32}$/.test(target.pathname) ||
      !target.username.startsWith('authcore_email_worker_') ||
      !/^[a-f0-9]{64}$/.test(configuration.key)
    )
      throw new Error();
    const database = createDatabaseClient({ connectionString: target.toString() });
    database.pool.on('error', () => {});
    const delivery = await new EmailDeliveryRepository(database.pool).claim({
      id: 'test-v1',
      key: Buffer.from(configuration.key, 'hex'),
    });
    if (!delivery) throw new Error();
    process.stdout.write('{"claimed":true}\n');
    setInterval(() => {}, 1000); // Parent kills this owned process before transport delivery.
  })().catch(() => {
    process.stdout.write('{"failed":true}\n');
    process.exit(1);
  });
});
