import type { Pool } from 'pg';
import { recoveryEmailBinding, recoveryPasswordBinding } from '@authcore/crypto';
import { runSecurityTransaction } from '../security-transaction.js';

export class PasswordRecoveryRepository {
  constructor(private readonly pool: Pool) {}

  /** Public request never returns account/eligibility state. Persist both the
   * immutable security intent and its pending job before acknowledging success.
   * Account creation, password mutation and session creation are not performed.
   */
  async request(normalizedEmail: string, requestId: string): Promise<void> {
    await runSecurityTransaction(this.pool, async (client) => {
      const locked = (
        await client.query('SELECT id FROM users WHERE email_normalized=$1 FOR UPDATE', [
          normalizedEmail,
        ])
      ).rows[0];
      if (!locked) return;
      const user = (
        await client.query(
          `SELECT u.email_normalized,u.email_verified_at,u.disabled_at,p.password_hash
        FROM users u LEFT JOIN password_credentials p ON p.user_id=u.id WHERE u.id=$1`,
          [locked.id],
        )
      ).rows[0];
      if (
        !user ||
        user.email_normalized !== normalizedEmail ||
        !user.email_verified_at ||
        user.disabled_at ||
        typeof user.password_hash !== 'string' ||
        !user.password_hash.length ||
        user.password_hash.length > 1024
      )
        return;
      const policy = (
        await client.query(
          `WITH policy_time AS (SELECT clock_timestamp() AS now)
        SELECT NOT EXISTS(SELECT 1 FROM password_recovery_requests,policy_time
          WHERE user_id=$1 AND created_at > policy_time.now-interval '1 minute') AS cooled,
        (SELECT count(*) FROM password_recovery_requests,policy_time
          WHERE user_id=$1 AND created_at > policy_time.now-interval '24 hours') < 5 AS under_cap`,
          [locked.id],
        )
      ).rows[0];
      if (!policy.cooled || !policy.under_cap) return;
      const event = (
        await client.query(
          `INSERT INTO password_recovery_requests
        (user_id,credential_binding,email_binding,request_id,created_at,expires_at)
        VALUES($1,$2,$3,$4,clock_timestamp(),clock_timestamp()+interval '15 minutes') RETURNING id`,
          [
            locked.id,
            recoveryPasswordBinding(user.password_hash),
            recoveryEmailBinding(user.email_normalized),
            requestId,
          ],
        )
      ).rows[0];
      if (!event) throw new Error('RECOVERY_INTENT_MISSING');
      await client.query('INSERT INTO password_recovery_deliveries(event_id) VALUES($1)', [
        event.id,
      ]);
    });
  }
}
