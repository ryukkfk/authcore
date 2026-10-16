import { setTimeout } from 'node:timers/promises';
import { EmailDeliveryRepository } from '@authcore/db';
import { openDeliveryPayload, type DeliveryEncryptionKey } from '@authcore/crypto';
import type { EmailTransport } from './email.js';

export class VerificationWorker {
  constructor(
    private readonly repository: EmailDeliveryRepository,
    private readonly transport: EmailTransport,
    private readonly keys: readonly DeliveryEncryptionKey[],
    private readonly report: (event: string) => void = (event) =>
      process.stdout.write(JSON.stringify({ event }) + '\n'),
  ) {
    if (!keys.length || new Set(keys.map((key) => key.id)).size !== keys.length)
      throw new Error('DELIVERY_KEY_CONFIGURATION_INVALID');
  }
  async tick(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    const delivery = await this.repository.claim(this.keys[0]!);
    if (!delivery) return false;
    let sent = false;
    try {
      const payload: unknown = JSON.parse(
        openDeliveryPayload(delivery.envelope, delivery.eventId, this.keys),
      );
      if (
        !payload ||
        typeof payload !== 'object' ||
        !('recipient' in payload) ||
        !('token' in payload) ||
        typeof payload.recipient !== 'string' ||
        typeof payload.token !== 'string'
      )
        throw new Error('DELIVERY_PAYLOAD_INVALID');
      await this.transport.send(
        { eventId: delivery.eventId, recipient: payload.recipient, token: payload.token },
        AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      );
      sent = true;
    } catch {
      // Do not serialize exceptions: transport errors can include the message.
      this.report('worker.verification_delivery_failed');
    }
    const retained = await this.repository.complete(delivery, sent);
    this.report(
      retained
        ? sent
          ? 'worker.verification_delivered'
          : 'worker.verification_retry_recorded'
        : 'worker.verification_lease_lost',
    );
    return true;
  }
  async run(signal: AbortSignal): Promise<void> {
    this.report('worker.ready');
    while (!signal.aborted) {
      try {
        await this.tick(signal);
      } catch {
        this.report('worker.verification_storage_unavailable');
      }
      try {
        await setTimeout(500, undefined, { signal });
      } catch {
        if (!signal.aborted) throw new Error('WORKER_WAIT_FAILED');
      }
    }
    this.report('worker.stopped');
  }
}
