import { pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    email: varchar('email', { length: 254 }).notNull(),

    emailNormalized: varchar('email_normalized', {
      length: 254,
    }).notNull(),

    emailVerifiedAt: timestamp('email_verified_at', {
      withTimezone: true,
      precision: 3,
      mode: 'date',
    }),

    disabledAt: timestamp('disabled_at', {
      withTimezone: true,
      precision: 3,
      mode: 'date',
    }),

    createdAt: timestamp('created_at', {
      withTimezone: true,
      precision: 3,
      mode: 'date',
    })
      .defaultNow()
      .notNull(),

    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      precision: 3,
      mode: 'date',
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [uniqueIndex('users_email_normalized_unique').on(table.emailNormalized)],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
