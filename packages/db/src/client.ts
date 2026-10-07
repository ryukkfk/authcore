import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

export interface DatabaseClientOptions {
  connectionString: string;
}

export function createDatabaseClient(options: DatabaseClientOptions) {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  const db = drizzle(pool);

  return {
    db,
    pool,
  };
}

export type DatabaseClient = ReturnType<typeof createDatabaseClient>;
