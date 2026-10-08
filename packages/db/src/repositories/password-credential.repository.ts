import { eq } from 'drizzle-orm';

import type { DatabaseClient } from '../client.js';
import {
  passwordCredentials,
  type NewPasswordCredential,
  type PasswordCredential,
} from '../schema/index.js';

export type CreatePasswordCredentialInput = Pick<NewPasswordCredential, 'userId' | 'passwordHash'>;
// Like UserRepository, this borrows a database/transaction and never owns the pool.
export type PasswordCredentialRepositoryDatabase = Pick<DatabaseClient['db'], 'insert' | 'select'>;

export class PasswordCredentialRepository {
  constructor(private readonly db: PasswordCredentialRepositoryDatabase) {}

  /** Accepts an encoded password hash; hashing belongs to the application layer. */
  async create(input: CreatePasswordCredentialInput): Promise<PasswordCredential> {
    const [credential] = await this.db
      .insert(passwordCredentials)
      .values({ userId: input.userId, passwordHash: input.passwordHash })
      .returning();

    if (!credential) throw new Error('Password credential insert returned no row');
    return credential;
  }

  async findByUserId(userId: string): Promise<PasswordCredential | null> {
    const [credential] = await this.db
      .select()
      .from(passwordCredentials)
      .where(eq(passwordCredentials.userId, userId))
      .limit(1);

    return credential ?? null;
  }
}
