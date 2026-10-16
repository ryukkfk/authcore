import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  createVerificationToken,
  verificationTokenDigest,
  sealDeliveryPayload,
  type DeliveryEnvelope,
  type DeliveryEncryptionKey,
} from '@authcore/crypto';
import { runSecurityTransaction } from '../security-transaction.js';

export interface ClaimedEmailDelivery {
  readonly eventId: string;
  readonly owner: string;
  readonly attempt: number;
  readonly envelope: DeliveryEnvelope;
}
export class EmailDeliveryRepository {
  constructor(private readonly pool: Pool) {}

  async claim(key: DeliveryEncryptionKey): Promise<ClaimedEmailDelivery | undefined> {
    return runSecurityTransaction(this.pool, async (client) => {
      // Unique event identity makes concurrent materialization idempotent.
      await client.query(`INSERT INTO email_deliveries(event_id)
        SELECT e.id FROM verification_events e LEFT JOIN email_deliveries d ON d.event_id=e.id
        WHERE d.event_id IS NULL ORDER BY e.created_at,e.id LIMIT 32 ON CONFLICT DO NOTHING`);
      // A worker can crash on its final lease. Retire it after expiry rather than
      // leaving a permanently processing row or silently resetting attempts.
      await client.query(`WITH retired AS (
        UPDATE email_deliveries SET status='dead',owner=NULL,locked_until=NULL,envelope=NULL,updated_at=clock_timestamp()
        WHERE status='processing' AND locked_until <= clock_timestamp() AND attempts=5 RETURNING event_id,attempts)
        INSERT INTO email_delivery_attempts(event_id,attempt,phase) SELECT event_id,attempts,'dead' FROM retired ON CONFLICT DO NOTHING`);
      const row = (
        await client.query(`SELECT d.event_id,d.attempts,d.envelope,e.user_id,u.email,u.disabled_at,u.email_verified_at,
          t.expires_at <= clock_timestamp() AS token_expired
        FROM email_deliveries d JOIN verification_events e ON e.id=d.event_id JOIN users u ON u.id=e.user_id
        LEFT JOIN email_verification_tokens t ON t.event_id=e.id
        WHERE d.attempts < 5 AND ((d.status='pending' AND d.next_attempt_at <= clock_timestamp())
          OR (d.status='processing' AND d.locked_until <= clock_timestamp()))
        ORDER BY d.next_attempt_at,d.event_id FOR UPDATE OF d SKIP LOCKED LIMIT 1`)
      ).rows[0];
      if (!row) return undefined;
      const attempt = Number(row.attempts) + 1;
      if (row.disabled_at || row.email_verified_at || row.token_expired) {
        await client.query(
          "UPDATE email_deliveries SET status='cancelled',attempts=$2,owner=NULL,locked_until=NULL,envelope=NULL,updated_at=clock_timestamp() WHERE event_id=$1",
          [row.event_id, attempt],
        );
        await client.query(
          "INSERT INTO email_delivery_attempts(event_id,attempt,phase) VALUES($1,$2,'cancelled')",
          [row.event_id, attempt],
        );
        return undefined;
      }
      let envelope: DeliveryEnvelope = row.envelope;
      if (!envelope) {
        const token = createVerificationToken();
        envelope = sealDeliveryPayload(
          JSON.stringify({ recipient: row.email, token }),
          row.event_id,
          key,
        );
        await client.query(
          "INSERT INTO email_verification_tokens(event_id,digest,expires_at) VALUES($1,$2,clock_timestamp()+interval '30 minutes')",
          [row.event_id, verificationTokenDigest(token)],
        );
      }
      const owner = randomUUID();
      await client.query(
        "UPDATE email_deliveries SET status='processing',attempts=$2,owner=$3,locked_until=clock_timestamp()+interval '30 seconds',envelope=$4,updated_at=clock_timestamp() WHERE event_id=$1",
        [row.event_id, attempt, owner, envelope],
      );
      await client.query(
        "INSERT INTO email_delivery_attempts(event_id,attempt,phase) VALUES($1,$2,'claimed')",
        [row.event_id, attempt],
      );
      return Object.freeze({ eventId: row.event_id as string, owner, attempt, envelope });
    });
  }

  async complete(delivery: ClaimedEmailDelivery, sent: boolean): Promise<boolean> {
    return runSecurityTransaction(this.pool, async (client) => {
      const phase = sent ? 'sent' : delivery.attempt >= 5 ? 'dead' : 'retry';
      const status = phase === 'retry' ? 'pending' : phase;
      const result = await client.query(
        `UPDATE email_deliveries SET status=$3,owner=NULL,locked_until=NULL,
        envelope=CASE WHEN $3='pending' THEN envelope ELSE NULL END,
        next_attempt_at=clock_timestamp()+($4::int*interval '1 second'),updated_at=clock_timestamp()
        WHERE event_id=$1 AND owner=$2 AND status='processing' AND locked_until > clock_timestamp() RETURNING event_id`,
        [delivery.eventId, delivery.owner, status, Math.min(60, 2 ** delivery.attempt)],
      );
      if (result.rowCount !== 1) return false;
      await client.query(
        'INSERT INTO email_delivery_attempts(event_id,attempt,phase) VALUES($1,$2,$3)',
        [delivery.eventId, delivery.attempt, phase],
      );
      return true;
    });
  }
}
