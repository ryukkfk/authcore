import { and, eq, sql } from 'drizzle-orm';
import type { Pool, PoolClient } from 'pg';
import { sessionCredentialDigest } from '@authcore/crypto';
import { runSecurityTransaction } from '../security-transaction.js';
import { authenticationEvents, browserSessions } from '../schema/browser-sessions.js';

export interface PasswordSnapshot {
  readonly id: string;
  readonly passwordHash: string;
}
export interface SessionAccount {
  readonly id: string;
  readonly email: string;
  readonly emailVerified: true;
  readonly createdAt: string;
  readonly sessionId: string;
}
const eligible = `u.disabled_at IS NULL AND u.email_verified_at IS NOT NULL AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp() AND s.last_seen_at > clock_timestamp()-interval '30 minutes'`;

export class BrowserSessionRepository {
  constructor(private readonly pool: Pool) {}
  async credentials(emailNormalized: string): Promise<PasswordSnapshot | null> {
    return runSecurityTransaction(this.pool, async (client) => {
      const row = (
        await client.query(
          'SELECT u.id,p.password_hash FROM users u JOIN password_credentials p ON p.user_id=u.id WHERE u.email_normalized=$1',
          [emailNormalized],
        )
      ).rows[0];
      return row ? { id: row.id as string, passwordHash: row.password_hash as string } : null;
    });
  }
  async completeLogin(
    snapshot: PasswordSnapshot | null,
    valid: boolean,
    credential: string,
    previousCredential: unknown,
    deviceLabel: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<SessionAccount | null> {
    const digest = sessionCredentialDigest(credential);
    if (!digest) throw new Error('SESSION_CREDENTIAL_INVALID');
    return runSecurityTransaction(this.pool, async (client, db) => {
      if (snapshot)
        await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [snapshot.id]);
      // Fresh READ COMMITTED statement after the account lock: password/status
      // changes and revocations may commit without changing the locked tuple.
      const user = snapshot
        ? (
            await client.query(
              'SELECT u.id,u.email,u.created_at,u.email_verified_at,u.disabled_at,p.password_hash FROM users u JOIN password_credentials p ON p.user_id=u.id WHERE u.id=$1',
              [snapshot.id],
            )
          ).rows[0]
        : undefined;
      if (
        !valid ||
        !user ||
        user.disabled_at ||
        !user.email_verified_at ||
        user.password_hash !== snapshot?.passwordHash ||
        signal?.aborted
      ) {
        await db
          .insert(authenticationEvents)
          .values({ userId: user?.id ?? null, eventType: 'auth.login_failed', requestId });
        return null;
      }
      const previous = sessionCredentialDigest(previousCredential);
      if (previous) {
        const rotated = await db
          .update(browserSessions)
          .set({ revokedAt: sql`clock_timestamp()` })
          .where(
            and(
              eq(browserSessions.userId, user.id),
              eq(browserSessions.tokenDigest, previous),
              sql`${browserSessions.revokedAt} IS NULL`,
            ),
          )
          .returning({ id: browserSessions.id });
        if (rotated.length)
          await db
            .insert(authenticationEvents)
            .values({
              userId: user.id,
              sessionId: rotated[0]!.id,
              eventType: 'auth.session_rotated',
              requestId,
            });
      }
      const evicted = await db
        .update(browserSessions)
        .set({ revokedAt: sql`clock_timestamp()` })
        .where(
          sql`${browserSessions.userId}=${user.id} AND ${browserSessions.revokedAt} IS NULL AND ${browserSessions.id} NOT IN (SELECT id FROM browser_sessions WHERE user_id=${user.id} AND revoked_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 9)`,
        )
        .returning({ id: browserSessions.id });
      if (evicted.length)
        await db
          .insert(authenticationEvents)
          .values({ userId: user.id, eventType: 'auth.sessions_revoked', requestId });
      const [session] = await db
        .insert(browserSessions)
        .values({
          userId: user.id,
          tokenDigest: digest,
          deviceLabel,
          expiresAt: sql`clock_timestamp()+interval '12 hours'`,
        })
        .returning({ id: browserSessions.id });
      if (!session) throw new Error('SESSION_INSERT_FAILED');
      await db
        .insert(authenticationEvents)
        .values({
          userId: user.id,
          sessionId: session.id,
          eventType: 'auth.login_succeeded',
          requestId,
        });
      return {
        id: user.id as string,
        email: user.email as string,
        emailVerified: true,
        createdAt: (user.created_at as Date).toISOString(),
        sessionId: session.id,
      };
    });
  }
  private async current(client: PoolClient, digest: string, active: boolean) {
    await client.query(
      'SELECT u.id FROM users u JOIN browser_sessions s ON s.user_id=u.id WHERE s.token_digest=$1 FOR UPDATE OF u',
      [digest],
    );
    return (
      await client.query(
        `SELECT u.id,u.email,u.created_at,s.id AS session_id FROM users u JOIN browser_sessions s ON s.user_id=u.id WHERE s.token_digest=$1 ${active ? 'AND ' + eligible : ''}`,
        [digest],
      )
    ).rows[0];
  }
  async resolve(credential: unknown): Promise<SessionAccount | null> {
    const digest = sessionCredentialDigest(credential);
    if (!digest) return null;
    return runSecurityTransaction(this.pool, async (client, db) => {
      const row = await this.current(client, digest, true);
      if (!row) return null;
      const touched = await db
        .update(browserSessions)
        .set({ lastSeenAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(browserSessions.id, row.session_id),
            sql`${browserSessions.revokedAt} IS NULL AND ${browserSessions.expiresAt}>clock_timestamp()`,
          ),
        )
        .returning({ id: browserSessions.id });
      if (!touched.length) return null;
      return {
        id: row.id as string,
        email: row.email as string,
        emailVerified: true,
        createdAt: (row.created_at as Date).toISOString(),
        sessionId: row.session_id as string,
      };
    });
  }
  async list(credential: unknown) {
    const digest = sessionCredentialDigest(credential);
    if (!digest) return null;
    return runSecurityTransaction(this.pool, async (client) => {
      const row = await this.current(client, digest, true);
      if (!row) return null;
      return (
        await client.query(
          "SELECT id,device_label,created_at,last_seen_at,expires_at FROM browser_sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp() AND last_seen_at>clock_timestamp()-interval '30 minutes' ORDER BY created_at DESC,id DESC LIMIT 10",
          [row.id],
        )
      ).rows.map((session) => ({
        id: session.id as string,
        deviceLabel: session.device_label as string,
        createdAt: (session.created_at as Date).toISOString(),
        lastSeenAt: (session.last_seen_at as Date).toISOString(),
        expiresAt: (session.expires_at as Date).toISOString(),
        current: session.id === row.session_id,
      }));
    });
  }
  async revoke(
    credential: unknown,
    requestId: string,
    target: 'current' | 'all' | 'others' | { id: string },
  ): Promise<{ authorized: boolean; currentRevoked: boolean }> {
    const digest = sessionCredentialDigest(credential);
    if (!digest) return { authorized: false, currentRevoked: false };
    return runSecurityTransaction(this.pool, async (client, db) => {
      const row = await this.current(client, digest, target !== 'current');
      if (!row) return { authorized: false, currentRevoked: false };
      const scope =
        target === 'all'
          ? sql`TRUE`
          : target === 'others'
            ? sql`${browserSessions.id}<>${row.session_id}`
            : eq(browserSessions.id, target === 'current' ? row.session_id : target.id);
      const revoked = await db
        .update(browserSessions)
        .set({ revokedAt: sql`clock_timestamp()` })
        .where(
          and(eq(browserSessions.userId, row.id), sql`${browserSessions.revokedAt} IS NULL`, scope),
        )
        .returning({ id: browserSessions.id });
      if (revoked.length)
        await db
          .insert(authenticationEvents)
          .values({
            userId: row.id,
            sessionId: target === 'current' ? row.session_id : null,
            eventType:
              target === 'current'
                ? 'auth.logout'
                : typeof target === 'object'
                  ? 'auth.session_revoked'
                  : 'auth.sessions_revoked',
            requestId,
          });
      return {
        authorized: typeof target !== 'object' || revoked.length > 0,
        currentRevoked: revoked.some((value) => value.id === row.session_id),
      };
    });
  }
}
