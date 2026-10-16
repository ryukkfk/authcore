import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createVerificationToken, sealDeliveryPayload } from '@authcore/crypto';
import type { EmailDeliveryRepository } from '@authcore/db';
import { VerificationWorker } from './verification-worker.js';
import { LocalMailboxTransport } from './email.js';

describe('Verification worker transport boundaries', () => {
  it('refuses production, external origins, credentials and non-loopback mailbox hosts', () => {
    const base = {
      localDemo: true as const,
      nodeEnvironment: 'development',
      mailboxOrigin: 'http://127.0.0.1:18025',
      webOrigin: 'http://127.0.0.1:3000',
    };
    expect(() => new LocalMailboxTransport({ ...base, nodeEnvironment: 'production' })).toThrow();
    for (const mailboxOrigin of [
      'https://example.com',
      'http://localhost:18025',
      'http://user:password@127.0.0.1:18025',
      'http://127.0.0.1:18025/path',
    ])
      expect(() => new LocalMailboxTransport({ ...base, mailboxOrigin })).toThrow();
  });
  it('settles cancellation through a durable retry without logging delivery secrets', async () => {
    const key = { id: 'test', key: randomBytes(32) },
      eventId = randomUUID(),
      token = createVerificationToken();
    const delivery = {
      eventId,
      owner: randomUUID(),
      attempt: 1,
      envelope: sealDeliveryPayload(
        JSON.stringify({ recipient: 'fixture@example.invalid', token }),
        eventId,
        key,
      ),
    };
    const claim = vi.fn(async () => delivery),
      complete = vi.fn(async () => true),
      report = vi.fn();
    const shutdown = new AbortController();
    const send = vi.fn(async (_message: unknown, signal: AbortSignal) => {
      shutdown.abort();
      signal.throwIfAborted();
    });
    const worker = new VerificationWorker(
      { claim, complete } as unknown as EmailDeliveryRepository,
      { send },
      [key],
      report,
    );
    expect(await worker.tick(shutdown.signal)).toBe(true);
    expect(complete).toHaveBeenCalledExactlyOnceWith(delivery, false);
    expect(JSON.stringify(report.mock.calls).includes(token)).toBe(false);
    expect(JSON.stringify(report.mock.calls).includes('fixture@example.invalid')).toBe(false);
    expect(await worker.tick(shutdown.signal)).toBe(false);
    expect(claim).toHaveBeenCalledOnce();
  });
  it('bounds a stalled provider with a real abort deadline and records retry disposition', async () => {
    const key = { id: 'test', key: randomBytes(32) },
      eventId = randomUUID();
    const delivery = {
      eventId,
      owner: randomUUID(),
      attempt: 1,
      envelope: sealDeliveryPayload(
        JSON.stringify({ recipient: 'fixture@example.invalid', token: createVerificationToken() }),
        eventId,
        key,
      ),
    };
    const complete = vi.fn(async () => true);
    const worker = new VerificationWorker(
      { claim: async () => delivery, complete } as unknown as EmailDeliveryRepository,
      {
        send: async (_message, signal) =>
          new Promise<void>((_resolve, reject) =>
            signal.addEventListener(
              'abort',
              () => reject(new Error('Synthetic provider timeout')),
              { once: true },
            ),
          ),
      },
      [key],
      () => {},
    );
    await worker.tick(new AbortController().signal);
    expect(complete).toHaveBeenCalledExactlyOnceWith(delivery, false);
  }, 10000);
});
