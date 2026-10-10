import { defineConfig } from 'drizzle-kit';

// Offline generation/lineage checks must not load .env or database credentials.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/**/*.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
});
