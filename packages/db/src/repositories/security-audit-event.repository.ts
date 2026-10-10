import type { DatabaseClient } from '../client.js';
import { securityAuditEvents, type SecurityAuditEvent } from '../schema/index.js';

export type SecurityAuditEventRepositoryDatabase = Pick<DatabaseClient['db'], 'insert'>;

export class SecurityAuditEventRepository {
  // Borrows the signup transaction; never opens a transaction or owns the pool.
  constructor(private readonly db: SecurityAuditEventRepositoryDatabase) {}

  async recordUserCreated(input: { userId: string }): Promise<SecurityAuditEvent> {
    const [event] = await this.db
      .insert(securityAuditEvents)
      .values({ eventType: 'identity.user_created', userId: input.userId, payload: {} })
      .returning();

    // No conflict suppression: a missing mandatory event must fail the signup.
    if (!event) throw new Error('Security audit event insert returned no row');
    return event;
  }
}
