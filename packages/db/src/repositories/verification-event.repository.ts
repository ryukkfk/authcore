import type { DatabaseClient } from '../client.js';
import { verificationEvents, type VerificationEvent } from '../schema/verification-events.js';

export class VerificationEventRepository {
  // Caller owns T2. Never create an account, token, transaction or delivery here.
  constructor(private readonly db: Pick<DatabaseClient['db'], 'insert'>) {}

  async requestInitial(userId: string): Promise<VerificationEvent> {
    const [event] = await this.db
      .insert(verificationEvents)
      .values({ userId, reason: 'signup' })
      .returning();
    if (!event) throw new Error('Mandatory verification event insert returned no row');
    return event;
  }
}
