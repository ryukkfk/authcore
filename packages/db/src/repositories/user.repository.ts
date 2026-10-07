import { eq } from 'drizzle-orm';

import type { DatabaseClient } from '../client.js';
import { users, type NewUser, type User } from '../schema/index.js';

export type CreateUserInput = Pick<NewUser, 'email' | 'emailNormalized'>;
// A database or a caller-owned transaction; the repository never owns the pool.
export type UserRepositoryDatabase = Pick<DatabaseClient['db'], 'insert' | 'select'>;

export class DuplicateUserEmailError extends Error {
  readonly code = 'DUPLICATE_EMAIL';

  constructor() {
    super('A user with this email already exists');
    this.name = 'DuplicateUserEmailError';
  }
}

export class UserRepository {
  constructor(private readonly db: UserRepositoryDatabase) {}

  /** The API identity layer must validate and normalize email before calling. */
  async create(input: CreateUserInput): Promise<User> {
    const [user] = await this.db
      .insert(users)
      .values({ email: input.email, emailNormalized: input.emailNormalized })
      // Target only email uniqueness. Other database failures must propagate.
      // This is atomic and leaves caller-owned transactions usable on conflict.
      .onConflictDoNothing({ target: users.emailNormalized })
      .returning();

    if (!user) throw new DuplicateUserEmailError();

    return user;
  }

  /** Exact lookup: this persistence layer deliberately does not normalize. */
  async findByNormalizedEmail(emailNormalized: string): Promise<User | null> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.emailNormalized, emailNormalized))
      .limit(1);

    return user ?? null;
  }
}
