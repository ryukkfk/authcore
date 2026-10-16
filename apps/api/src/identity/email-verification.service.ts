import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnApplicationShutdown,
} from '@nestjs/common';
import {
  createDatabaseClient,
  EmailVerificationRepository,
  type DatabaseClient,
} from '@authcore/db';

@Injectable()
export class EmailVerificationService implements OnApplicationShutdown {
  private database?: DatabaseClient;
  private stopped = false;
  private readonly logger = new Logger(EmailVerificationService.name);
  private loggingFaults = 0;

  async verify(token: string, requestId: string): Promise<boolean> {
    const connectionString = process.env.VERIFICATION_DATABASE_URL;
    if (!connectionString || this.stopped)
      throw new ServiceUnavailableException('Verification temporarily unavailable');
    if (!this.database) {
      const target = new URL(connectionString);
      if (
        !['postgres:', 'postgresql:'].includes(target.protocol) ||
        !target.username.startsWith('authcore_email_verifier_')
      )
        throw new ServiceUnavailableException('Verification temporarily unavailable');
      this.database = createDatabaseClient({ connectionString });
      // No raw Error/Client serialization; verification errors reach the safe filter.
      this.database.pool.on('error', () => {
        try {
          this.logger.warn({ event: 'verification.database_idle_error' });
        } catch {
          this.loggingFaults = Math.min(Number.MAX_SAFE_INTEGER, this.loggingFaults + 1);
        }
      });
    }
    return new EmailVerificationRepository(this.database.pool).consume(token, requestId);
  }
  async onApplicationShutdown() {
    this.stopped = true;
    await this.database?.pool.end();
  }
}
