import { Injectable, type OnApplicationShutdown } from '@nestjs/common';

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

  constructor() {
    const environment = parseEnvironment(process.env);

    this.client = createDatabaseClient({
      connectionString: environment.DATABASE_URL,
    });
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
