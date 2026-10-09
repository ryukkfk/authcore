import { defineConfig } from 'vitest/config';

if (process.env.TEST_REDIS_URL !== 'redis://127.0.0.1:6380') {
  throw new Error('Set TEST_REDIS_URL=redis://127.0.0.1:6380 for the isolated test container');
}

export default defineConfig({
  test: {
    include: ['src/**/*.redis.integration.test.ts'],
    fileParallelism: false,
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
