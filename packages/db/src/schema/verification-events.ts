import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/** Append-only notification intent; contains no raw credential or mailbox payload.
 * A worker-owned delivery table will track effects separately from this intent.
 */
export const verificationEvents = pgTable(
  'verification_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    eventType: text('event_type').default('identity.email_verification_requested').notNull(),
    reason: text('reason').$type<'signup' | 'resend'>().default('signup').notNull(),
    // Nullable for historical/signup intent; explicit resend issuance supplies it.
    requestId: uuid('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      'verification_events_type_check',
      sql`${table.eventType} = 'identity.email_verification_requested'`,
    ),
    check('verification_events_reason_check', sql`${table.reason} IN ('signup', 'resend')`),
    uniqueIndex('verification_events_initial_user_unique')
      .on(table.userId)
      .where(sql`${table.reason} = 'signup'`),
    index('verification_events_created_idx').on(table.createdAt, table.id),
    index('verification_events_user_created_idx').on(table.userId, table.createdAt),
  ],
);

export type VerificationEvent = typeof verificationEvents.$inferSelect;
