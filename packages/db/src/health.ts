import { sql } from 'drizzle-orm';

import type { DatabaseClient } from './client.js';

export async function checkDatabaseConnection(client: DatabaseClient): Promise<void> {
  await client.db.execute(sql`select 1`);
}
