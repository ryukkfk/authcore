import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';

import { parseEnvironment } from '@authcore/config';
import {
  checkDatabaseConnection,
  createDatabaseClient,
  drainSignupTransactionOwners,
  type DatabaseClient,
} from '@authcore/db';

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly client: DatabaseClient;
  private readonly logger = new Logger(DatabaseService.name);
  private idleErrors = 0;
  private loggingFaults = 0;

  constructor() {
    const environment = parseEnvironment(process.env);

    this.client = createDatabaseClient({
      connectionString: environment.DATABASE_URL,
    });
    // pg supplies both Error and Client; neither may reach a serializer or log sink.
    // Pool removal remains driver-owned. This observer never interferes with progress.
    this.client.pool.on('error', () => {
      this.idleErrors = Math.min(Number.MAX_SAFE_INTEGER, this.idleErrors + 1);
      try {
        this.logger.warn({ event: 'database.idle_connection_error' });
      } catch {
        this.loggingFaults = Math.min(Number.MAX_SAFE_INTEGER, this.loggingFaults + 1);
      }
    });
  }

  connectionDiagnostics() {
    return Object.freeze({ idleErrors: this.idleErrors, loggingFaults: this.loggingFaults });
  }

  getClient(): DatabaseClient {
    return this.client;
  }

  async checkConnection(): Promise<void> {
    await checkDatabaseConnection(this.client);
  }

  async onApplicationShutdown(): Promise<void> {
    await drainSignupTransactionOwners(this.client);
    await this.client.pool.end();
  }
}
