import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { createVerificationToken } from '@authcore/crypto';
import { LocalMailboxTransport, localHttpOrigin } from './email.js';

const origin = process.env.TEST_MAILBOX_URL;
if (origin) localHttpOrigin(origin);
describe.skipIf(!origin)('Actual local mailbox capture', () => {
  it('captures a labeled verification email with an HTTP-safe fragment link', async () => {
    const endpoint = origin!;
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const response = await fetch(endpoint + '/api/v1/info', {
          signal: AbortSignal.timeout(1000),
        });
        await response.body?.cancel();
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        /* Startup readiness only; never send to another provider. */
      }
      await setTimeout(100);
    }
    expect(ready).toBe(true);
    const token = createVerificationToken(),
      recipient = randomUUID() + '@example.invalid';
    await new LocalMailboxTransport({
      localDemo: true,
      nodeEnvironment: 'development',
      mailboxOrigin: endpoint,
      webOrigin: 'http://127.0.0.1:3000',
    }).send({ eventId: randomUUID(), recipient, token }, AbortSignal.timeout(5000));
    const response = await fetch(endpoint + '/api/v1/message/latest', {
      signal: AbortSignal.timeout(3000),
    });
    const message = (await response.json()) as {
      Subject: string;
      Text: string;
      To: { Address: string }[];
    };
    expect(message.Subject).toBe('[LOCAL DEMO ONLY] Verify your AuthCore email');
    expect(message.Text.includes('http://127.0.0.1:3000/verify#token=' + token)).toBe(true);
    expect(message.To.some((value) => value.Address === recipient)).toBe(true);
  }, 10000);
});
