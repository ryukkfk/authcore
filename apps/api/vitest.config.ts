import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      'src/**/*.redis.integration.test.ts',
      'src/**/*.e2e.test.ts',
    ],
  },
});
