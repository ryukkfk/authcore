import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';
const time = (name: string) => timestamp(name, { withTimezone: true, precision: 3, mode: 'date' });
export const browserSessions = pgTable(
  'browser_sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    tokenDigest: text('token_digest').notNull().unique(),
    deviceLabel: text('device_label').notNull(),
    createdAt: time('created_at').defaultNow().notNull(),
    lastSeenAt: time('last_seen_at').defaultNow().notNull(),
    expiresAt: time('expires_at').notNull(),
    revokedAt: time('revoked_at'),
  },
  (table) => [
    check('browser_sessions_digest_check', sql`${table.tokenDigest} ~ '^[0-9a-f]{64}$'`),
    check(
      'browser_sessions_expiry_check',
      sql`isfinite(${table.expiresAt}) AND ${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      'browser_sessions_device_check',
      sql`${table.deviceLabel} IN ('Chromium','Firefox','Safari','Other')`,
    ),
    index('browser_sessions_user_idx').on(table.userId, table.createdAt),
  ],
);
export const authenticationEvents = pgTable(
  'authentication_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'restrict' }),
    sessionId: uuid('session_id').references(() => browserSessions.id, { onDelete: 'restrict' }),
    eventType: text('event_type').notNull(),
    requestId: uuid('request_id').notNull(),
    occurredAt: time('occurred_at').defaultNow().notNull(),
  },
  (table) => [
    check(
      'authentication_events_type_check',
      sql`${table.eventType} IN ('auth.login_succeeded','auth.login_failed','auth.logout','auth.session_revoked','auth.sessions_revoked','auth.session_rotated')`,
    ),
    check(
      'authentication_events_subject_check',
      sql`${table.eventType} = 'auth.login_failed' OR ${table.userId} IS NOT NULL`,
    ),
    index('authentication_events_user_idx').on(table.userId, table.occurredAt),
  ],
);
