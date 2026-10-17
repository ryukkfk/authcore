import { eq, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { verificationTokenDigest } from '@authcore/crypto';
import { runSecurityTransaction } from '../security-transaction.js';
import { users } from '../schema/users.js';
import { accountSecurityEvents } from '../schema/email-delivery.js';

export class EmailVerificationRepository {
  constructor(private readonly pool: Pool) {}

  /** Generic public request: no eligibility result escapes this boundary.
   * The append-only verification event is both durable work and correlated audit.
   * Account locking is shared with consumption; policy reads happen AFTER locking.
   * Keep existing proofs valid to prevent resend-based denial of service.
   */
  async requestResend(emailNormalized: string, requestId: string): Promise<void> {
    await runSecurityTransaction(this.pool, async (client) => {
      const account = (
        await client.query('SELECT id FROM users WHERE email_normalized=$1 FOR UPDATE', [
          emailNormalized,
        ])
      ).rows[0];
      if (!account) return;
      const current = (
        await client.query(
          'SELECT email_normalized,disabled_at,email_verified_at FROM users WHERE id=$1',
          [account.id],
        )
      ).rows[0];
      if (
        !current ||
        current.email_normalized !== emailNormalized ||
        current.disabled_at ||
        current.email_verified_at
      )
        return;
      // Database time is authoritative. Future-dated events conservatively deny.
      // Initial signup participates in cooldown; only resends consume the daily cap.
      const policy = (
        await client.query(
          `WITH policy_time AS (SELECT clock_timestamp() AS now)
        SELECT NOT EXISTS(SELECT 1 FROM verification_events,policy_time
          WHERE user_id=$1 AND created_at > policy_time.now-interval '1 minute') AS cooled,
        (SELECT count(*) FROM verification_events,policy_time
          WHERE user_id=$1 AND reason='resend' AND created_at > policy_time.now-interval '24 hours') < 5 AS under_cap`,
          [account.id],
        )
      ).rows[0];
      if (!policy.cooled || !policy.under_cap) return;
      await client.query(
        `INSERT INTO verification_events(user_id,reason,request_id,created_at)
        VALUES($1,'resend',$2,clock_timestamp())`,
        [account.id, requestId],
      );
    });
  }

  async consume(token: string, requestId: string): Promise<boolean> {
    const digest = verificationTokenDigest(token);
    if (!digest) return false;
    return runSecurityTransaction(this.pool, async (client, db) => {
      // Serialize on the account before consuming any of its tokens. Concurrent
      // tokens cannot both generate a verification transition or audit event.
      const user = (
        await client.query(
          `SELECT u.id,u.disabled_at,u.email_verified_at,t.event_id
        FROM users u JOIN verification_events e ON e.user_id=u.id JOIN email_verification_tokens t ON t.event_id=e.id
        WHERE t.digest=$1 FOR UPDATE OF u`,
          [digest],
        )
      ).rows[0];
      if (!user || user.disabled_at || user.email_verified_at) return false;
      const consumed = await client.query(
        `UPDATE email_verification_tokens SET consumed_at=clock_timestamp()
        WHERE event_id=$1 AND consumed_at IS NULL AND expires_at > clock_timestamp() RETURNING event_id`,
        [user.event_id],
      );
      if (consumed.rowCount !== 1) return false;
      await db
        .update(users)
        .set({ emailVerifiedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
        .where(eq(users.id, user.id));
      await db
        .insert(accountSecurityEvents)
        .values({ userId: user.id, requestId, eventType: 'identity.email_verified' });
      return true;
    });
  }
}
