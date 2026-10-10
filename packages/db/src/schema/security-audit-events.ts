import { sql } from 'drizzle-orm';
import { check, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { users } from './users.js';

export const securityAuditEvents = pgTable(
  'security_audit_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventType: text('event_type').$type<'identity.user_created'>().notNull(),
    // Retain the subject and audit together; account deletion needs an explicit
    // retention decision. Never cascade deletion of security history.
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    occurredAt: timestamp('occurred_at', {
      withTimezone: true,
      precision: 3,
      mode: 'date',
    })
      .defaultNow()
      .notNull(),
    // This first event needs no metadata. Enforce an empty payload in PostgreSQL
    // as well as the writer, so request data and credentials cannot enter it.
    payload: jsonb('payload').$type<Record<string, never>>().default({}).notNull(),
  },
  (table) => [
    unique('security_audit_events_type_user_unique').on(table.eventType, table.userId),
    check('security_audit_events_type_check', sql`${table.eventType} = 'identity.user_created'`),
    check('security_audit_events_payload_check', sql`${table.payload} = '{}'::jsonb`),
  ],
);

export type SecurityAuditEvent = typeof securityAuditEvents.$inferSelect;
