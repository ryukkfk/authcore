// Historical Phase A regression fixture only; excluded from production builds.
// The production SignupService uses the mandatory keyed Phase B protocol.
import { Inject, Injectable, Logger } from '@nestjs/common';

import { hashPassword } from '@authcore/crypto';
import {
  DuplicateUserEmailError,
  PasswordCredentialRepository,
  SecurityAuditEventRepository,
  setSignupTransactionTimeouts,
  runSignupTransaction,
  UserRepository,
  type User,
} from '@authcore/db';

import { DatabaseService } from '../database/database.service.js';
import { normalizeEmail } from './email.js';
import { EmailAlreadyInUseError } from './identity.errors.js';
import { assertSignupLease } from './signup-admission.js';

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
    assertSignupLease();
    const email = input.email.trim();
    const emailNormalized = normalizeEmail(email);
    // Do expensive hashing before borrowing a connection or taking database locks.
    const passwordHash = await hashPassword(input.password);
    assertSignupLease();

    let user: User;
    try {
      user = await runSignupTransaction(this.database.getClient(), async (tx) => {
        assertSignupLease();
        await setSignupTransactionTimeouts(tx);
        assertSignupLease();
        // All three writes borrow exactly this transaction/connection.
        const users = new UserRepository(tx);
        const credentials = new PasswordCredentialRepository(tx);
        const auditEvents = new SecurityAuditEventRepository(tx);
        const created = await users.create({ email, emailNormalized });
        assertSignupLease();
        await credentials.create({ userId: created.id, passwordHash });
        assertSignupLease();
        await auditEvents.recordUserCreated({ userId: created.id });
        assertSignupLease();
        return created;
      });
    } catch (error: unknown) {
      if (error instanceof DuplicateUserEmailError) throw new EmailAlreadyInUseError();
      throw error;
    }

    // Operational log only. The transaction's security_audit_events row is the
    // durable source of truth; this log is neither required nor sufficient for it.
    this.logger.log({ event: 'identity.user_created', userId: user.id });
    return user;
  }
}
