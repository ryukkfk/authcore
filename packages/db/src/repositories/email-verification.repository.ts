import { eq, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { verificationTokenDigest } from '@authcore/crypto';
import { runSecurityTransaction } from '../security-transaction.js';
import { users } from '../schema/users.js';
import { accountSecurityEvents } from '../schema/email-delivery.js';

export class EmailVerificationRepository {
  constructor(private readonly pool: Pool) {}

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
