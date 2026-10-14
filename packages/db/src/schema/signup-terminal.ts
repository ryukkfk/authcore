import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  pgTable,
  smallint,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { signupIdempotencyClaims } from './signup-idempotency.js';

export const signupIdempotencyNamespace = pgTable(
  'signup_idempotency_namespace',
  {
    id: smallint('id').primaryKey().default(1),
    hmacKeyVersion: integer('hmac_key_version').notNull(),
    keyDigest: varchar('attestation_key_digest', { length: 64 }).notNull(),
    payloadDigest: varchar('attestation_payload_digest', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check('signup_namespace_singleton_check', sql`${table.id} = 1`),
    check('signup_namespace_version_check', sql`${table.hmacKeyVersion} > 0`),
    check(
      'signup_namespace_digests_check',
      sql`${table.keyDigest} ~ '^[0-9a-f]{64}$' AND ${table.payloadDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check('signup_namespace_created_check', sql`isfinite(${table.createdAt})`),
  ],
);
export const signupIdempotencyTerminalEvents = pgTable(
  'signup_idempotency_terminal_events',
  {
    claimId: uuid('claim_id').primaryKey(),
    eventType: varchar('event_type', { length: 32 }).$type<'signup.expired'>().notNull(),
    policyVersion: integer('policy_version').notNull(),
    observedAt: timestamp('observed_at', {
      withTimezone: true,
      precision: 3,
      mode: 'date',
    }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true, precision: 3, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: 'signup_terminal_events_claim_fk',
      columns: [table.claimId],
      foreignColumns: [signupIdempotencyClaims.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check(
      'signup_terminal_events_policy_check',
      sql`${table.policyVersion} = 1 AND ${table.eventType} = 'signup.expired'`,
    ),
    check(
      'signup_terminal_events_time_check',
      sql`isfinite(${table.observedAt}) AND isfinite(${table.recordedAt})`,
    ),
  ],
);
export type SignupIdempotencyNamespace = typeof signupIdempotencyNamespace.$inferSelect;
export type SignupIdempotencyTerminalEvent = typeof signupIdempotencyTerminalEvents.$inferSelect;
