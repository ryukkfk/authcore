import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { parseEnvironment } from '@authcore/config';

import { createDatabaseClient } from './client.js';

loadEnvFile(resolve(process.cwd(), '../../.env'));

const environment = parseEnvironment(process.env);

const database = createDatabaseClient({
  connectionString: environment.DATABASE_URL,
});

try {
  await migrate(database.db, {
    migrationsFolder: resolve(process.cwd(), 'drizzle'),
  });

  console.log('Database migrations completed');
} finally {
  await database.pool.end();
}
