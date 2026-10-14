import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  integer,
  index,
  jsonb,
  pgTable,
  smallint,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const signupIdempotencyClaims = pgTable(
  'signup_idempotency_claims',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    keyVersion: integer('key_version').notNull(),
    hmacKeyVersion: integer('hmac_key_version').notNull(),
    keyDigest: varchar('key_digest', { length: 64 }).notNull(),
    payloadVersion: integer('payload_version').notNull(),
    payloadDigest: varchar('payload_digest', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3, mode: 'date' })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      precision: 3,
      mode: 'date',
    }).notNull(),
    // PostgreSQL row locking needs UPDATE on at least one column. This inert
    // column is the ONLY UPDATE grant; CHECK prevents any change of its value.
    lockAnchor: boolean('lock_anchor').default(false).notNull(),
  },
  (table) => [
    index('signup_claims_hmac_version_idx').on(table.hmacKeyVersion),
    unique('signup_idempotency_claims_key_unique').on(
      table.keyVersion,
      table.hmacKeyVersion,
      table.keyDigest,
    ),
    check(
      'signup_idempotency_claims_versions_check',
      sql`${table.keyVersion} = 1 AND ${table.payloadVersion} = 1 AND ${table.hmacKeyVersion} > 0`,
    ),
    check(
      'signup_idempotency_claims_digests_check',
      sql`${table.keyDigest} ~ '^[0-9a-f]{64}$' AND ${table.payloadDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'signup_idempotency_claims_expiry_check',
      sql`isfinite(${table.createdAt}) AND isfinite(${table.expiresAt}) AND ${table.expiresAt} > ${table.createdAt}`,
    ),
    check('signup_idempotency_claims_lock_anchor_check', sql`${table.lockAnchor} = false`),
  ],
);

export const signupIdempotencyResults = pgTable(
  'signup_idempotency_results',
  {
    claimId: uuid('claim_id').primaryKey(),
    resultVersion: integer('result_version').notNull(),
    statusCode: smallint('status_code').notNull(),
    responseBody: jsonb('response_body').$type<{ status: 'accepted' }>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: 'signup_idempotency_results_claim_fk',
      columns: [table.claimId],
      foreignColumns: [signupIdempotencyClaims.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check(
      'signup_idempotency_results_response_check',
      sql`${table.resultVersion} = 1 AND ${table.statusCode} = 202 AND ${table.responseBody} = '{"status":"accepted"}'::jsonb`,
    ),
    check('signup_idempotency_results_created_at_check', sql`isfinite(${table.createdAt})`),
  ],
);

export type SignupIdempotencyClaim = typeof signupIdempotencyClaims.$inferSelect;
export type SignupIdempotencyResult = typeof signupIdempotencyResults.$inferSelect;
