import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

import { sql } from 'drizzle-orm';

import { parseEnvironment } from '@authcore/config';

import { createDatabaseClient } from './client.js';

loadEnvFile(resolve(process.cwd(), '../../.env'));

const environment = parseEnvironment(process.env);

const database = createDatabaseClient({
  connectionString: environment.DATABASE_URL,
});

try {
  await database.db.execute(sql`select 1 as connected`);

  console.log('Database connection OK');
} finally {
  await database.pool.end();
}
