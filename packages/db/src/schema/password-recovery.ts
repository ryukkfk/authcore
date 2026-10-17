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
import { users } from './users.js';

const time = (name: string) => timestamp(name, { withTimezone: true, precision: 3, mode: 'date' });
/** Immutable request/issuance audit; contains neither address nor raw credential. */
export const passwordRecoveryRequests = pgTable(
  'password_recovery_requests',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    eventType: text('event_type').default('identity.password_recovery_requested').notNull(),
    credentialBinding: text('credential_binding').notNull(),
    emailBinding: text('email_binding').notNull(),
    requestId: uuid('request_id').notNull(),
    createdAt: time('created_at').defaultNow().notNull(),
    expiresAt: time('expires_at').notNull(),
  },
  (table) => [
    check(
      'password_recovery_requests_type_check',
      sql`${table.eventType} = 'identity.password_recovery_requested'`,
    ),
    check(
      'password_recovery_requests_credential_binding_check',
      sql`${table.credentialBinding} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'password_recovery_requests_email_binding_check',
      sql`${table.emailBinding} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'password_recovery_requests_expiry_check',
      sql`isfinite(${table.expiresAt}) AND ${table.expiresAt} > ${table.createdAt}`,
    ),
    index('password_recovery_requests_user_created_idx').on(table.userId, table.createdAt),
  ],
);
export const passwordRecoveryDeliveries = pgTable(
  'password_recovery_deliveries',
  {
    eventId: uuid('event_id')
      .primaryKey()
      .references(() => passwordRecoveryRequests.id, { onDelete: 'restrict' }),
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
      'password_recovery_deliveries_status_check',
      sql`${table.status} IN ('pending','processing','sent','dead','cancelled')`,
    ),
    check('password_recovery_deliveries_attempts_check', sql`${table.attempts} BETWEEN 0 AND 5`),
    check(
      'password_recovery_deliveries_lease_check',
      sql`(${table.status} = 'processing' AND ${table.owner} IS NOT NULL AND ${table.lockedUntil} IS NOT NULL) OR (${table.status} <> 'processing' AND ${table.owner} IS NULL AND ${table.lockedUntil} IS NULL)`,
    ),
    check(
      'password_recovery_deliveries_terminal_check',
      sql`${table.status} NOT IN ('sent','dead','cancelled') OR ${table.envelope} IS NULL`,
    ),
    index('password_recovery_deliveries_ready_idx').on(table.status, table.nextAttemptAt),
  ],
);
export const passwordRecoveryTokens = pgTable(
  'password_recovery_tokens',
  {
    eventId: uuid('event_id')
      .primaryKey()
      .references(() => passwordRecoveryRequests.id, { onDelete: 'restrict' }),
    digest: text('digest').notNull().unique(),
    createdAt: time('created_at').defaultNow().notNull(),
    expiresAt: time('expires_at').notNull(),
    consumedAt: time('consumed_at'),
  },
  (table) => [
    check('password_recovery_tokens_digest_check', sql`${table.digest} ~ '^[0-9a-f]{64}$'`),
    check(
      'password_recovery_tokens_expiry_check',
      sql`isfinite(${table.expiresAt}) AND ${table.expiresAt} > ${table.createdAt}`,
    ),
  ],
);
export const passwordRecoveryAttempts = pgTable(
  'password_recovery_attempts',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => passwordRecoveryDeliveries.eventId, { onDelete: 'restrict' }),
    attempt: integer('attempt').notNull(),
    phase: text('phase').notNull(),
    occurredAt: time('occurred_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.attempt, table.phase] }),
    check('password_recovery_attempts_number_check', sql`${table.attempt} BETWEEN 1 AND 5`),
    check(
      'password_recovery_attempts_phase_check',
      sql`${table.phase} IN ('claimed','sent','retry','dead','cancelled')`,
    ),
  ],
);
export const passwordRecoveryAudit = pgTable(
  'password_recovery_audit',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    eventId: uuid('event_id')
      .notNull()
      .references(() => passwordRecoveryRequests.id, { onDelete: 'restrict' }),
    eventType: text('event_type').default('identity.password_reset').notNull(),
    requestId: uuid('request_id').notNull(),
    occurredAt: time('occurred_at').defaultNow().notNull(),
  },
  (table) => [
    check(
      'password_recovery_audit_type_check',
      sql`${table.eventType} = 'identity.password_reset'`,
    ),
    index('password_recovery_audit_user_idx').on(table.userId, table.occurredAt),
  ],
);
