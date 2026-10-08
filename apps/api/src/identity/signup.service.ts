import { Inject, Injectable, Logger } from '@nestjs/common';

import { hashPassword } from '@authcore/crypto';
import {
  DuplicateUserEmailError,
  PasswordCredentialRepository,
  UserRepository,
  type User,
} from '@authcore/db';

import { DatabaseService } from '../database/database.service.js';
import { normalizeEmail } from './email.js';
import { EmailAlreadyInUseError } from './identity.errors.js';

export interface SignupInput {
  email: string;
  password: string;
}

@Injectable()
export class SignupService {
  private readonly logger = new Logger(SignupService.name);

  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** Internal application operation. The API boundary must validate signup input. */
  async signup(input: SignupInput): Promise<User> {
    const email = input.email.trim();
    const emailNormalized = normalizeEmail(email);
    // Do expensive hashing before borrowing a connection or taking database locks.
    const passwordHash = await hashPassword(input.password);

    let user: User;
    try {
      user = await this.database.getClient().db.transaction(async (tx) => {
        // This service owns the transaction; both repositories borrow exactly tx.
        const users = new UserRepository(tx);
        const credentials = new PasswordCredentialRepository(tx);
        const created = await users.create({ email, emailNormalized });
        await credentials.create({ userId: created.id, passwordHash });
        return created;
      });
    } catch (error: unknown) {
      if (error instanceof DuplicateUserEmailError) throw new EmailAlreadyInUseError();
      throw error;
    }

    // Emit only committed state and non-sensitive identifiers; never log input/errors.
    this.logger.log({ event: 'identity.user_created', userId: user.id });
    return user;
  }
}
