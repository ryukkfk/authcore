import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

import { defineConfig } from 'drizzle-kit';

loadEnvFile(resolve(process.cwd(), '../../.env'));

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/**/*.ts',
  out: './drizzle',
  dbCredentials: {
    url: databaseUrl,
  },
  strict: true,
  verbose: true,
});
