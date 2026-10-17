import process from 'node:process';
import { readFile } from 'node:fs/promises';
import { defineConfig } from '@playwright/test';
import { URL } from 'node:url';

const value = JSON.parse(
  await readFile(new URL('./.local-demo/public.json', import.meta.url), 'utf8'),
);
if (value.localDemo !== true)
  throw new Error('Browser tests require the explicit disposable local demo');
for (const origin of [value.webOrigin, value.apiOrigin, value.mailboxOrigin]) {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.origin !== origin)
    throw new Error('Browser test destination rejected');
}
export default defineConfig({
  testDir: './apps/web/e2e',
  testMatch: '**/*.pw.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 240000,
  expect: { timeout: 10000 },
  reporter: 'list',
  outputDir: './.local-demo/playwright',
  use: {
    baseURL: value.webOrigin,
    browserName: 'chromium',
    ...(process.platform === 'win32' ? { channel: 'msedge' } : {}),
    headless: true,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    viewport: { width: 1365, height: 900 },
    actionTimeout: 10000,
    navigationTimeout: 15000,
  },
});
