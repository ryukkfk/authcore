import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import type { DeliveryEnvelope } from '@authcore/crypto';
import { verificationEvents } from './verification-events.js';
import { users } from './users.js';

const time = (name: string) => timestamp(name, { withTimezone: true, precision: 3, mode: 'date' });
export const emailDeliveries = pgTable(
  'email_deliveries',
  {
    eventId: uuid('event_id')
      .primaryKey()
      .references(() => verificationEvents.id, { onDelete: 'cascade' }),
    status: text('status').default('pending').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    nextAttemptAt: time('next_attempt_at').defaultNow().notNull(),
    owner: uuid('owner'),
    lockedUntil: time('locked_until'),
    envelope: jsonb('envelope').$type<DeliveryEnvelope>(),
    updatedAt: time('updated_at').defaultNow().notNull(),
  },
  (table) => [
    check(
      'email_deliveries_status_check',
      sql`${table.status} IN ('pending','processing','sent','dead','cancelled')`,
    ),
    check('email_deliveries_attempts_check', sql`${table.attempts} BETWEEN 0 AND 5`),
    check(
      'email_deliveries_lease_check',
      sql`(${table.status} = 'processing' AND ${table.owner} IS NOT NULL AND ${table.lockedUntil} IS NOT NULL) OR (${table.status} <> 'processing' AND ${table.owner} IS NULL AND ${table.lockedUntil} IS NULL)`,
    ),
    check(
      'email_deliveries_terminal_check',
      sql`${table.status} NOT IN ('sent','dead','cancelled') OR ${table.envelope} IS NULL`,
    ),
    index('email_deliveries_ready_idx').on(table.status, table.nextAttemptAt),
  ],
);
export const emailVerificationTokens = pgTable(
  'email_verification_tokens',
  {
    eventId: uuid('event_id')
      .primaryKey()
      .references(() => verificationEvents.id, { onDelete: 'cascade' }),
    digest: text('digest').notNull().unique(),
    createdAt: time('created_at').defaultNow().notNull(),
    expiresAt: time('expires_at').notNull(),
    consumedAt: time('consumed_at'),
  },
  (table) => [
    check('email_verification_tokens_digest_check', sql`${table.digest} ~ '^[0-9a-f]{64}$'`),
    check(
      'email_verification_tokens_expiry_check',
      sql`isfinite(${table.expiresAt}) AND ${table.expiresAt} > ${table.createdAt}`,
    ),
  ],
);
export const emailDeliveryAttempts = pgTable(
  'email_delivery_attempts',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => emailDeliveries.eventId, { onDelete: 'restrict' }),
    attempt: integer('attempt').notNull(),
    phase: text('phase').notNull(),
    occurredAt: time('occurred_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.attempt, table.phase] }),
    check('email_delivery_attempts_number_check', sql`${table.attempt} BETWEEN 1 AND 5`),
    check(
      'email_delivery_attempts_phase_check',
      sql`${table.phase} IN ('claimed','sent','retry','dead','cancelled')`,
    ),
  ],
);
export const accountSecurityEvents = pgTable(
  'account_security_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    eventType: text('event_type').notNull(),
    requestId: uuid('request_id').notNull(),
    occurredAt: time('occurred_at').defaultNow().notNull(),
  },
  (table) => [
    check(
      'account_security_events_type_check',
      sql`${table.eventType} = 'identity.email_verified'`,
    ),
    index('account_security_events_user_idx').on(table.userId, table.occurredAt),
  ],
);
