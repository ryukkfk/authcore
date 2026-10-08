import {
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './users.js';

export const passwordCredentials = pgTable(
  'password_credentials',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, {
        onDelete: 'cascade',
      }),

    passwordHash: text('password_hash').notNull(),

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
);

export type PasswordCredential =
  typeof passwordCredentials.$inferSelect;

export type NewPasswordCredential =
  typeof passwordCredentials.$inferInsert;