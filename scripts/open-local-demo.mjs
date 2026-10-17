import process from 'node:process';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { URL } from 'node:url';
import console from 'node:console';

const config = JSON.parse(
  await readFile(new URL('../.local-demo/public.json', import.meta.url), 'utf8'),
);
const url = new URL(config.webOrigin);
if (
  config.localDemo !== true ||
  url.protocol !== 'http:' ||
  url.hostname !== '127.0.0.1' ||
  url.origin !== config.webOrigin
)
  throw new Error('Explicit loopback demo configuration required');
const browser = await chromium.launch({
  headless: false,
  ...(process.platform === 'win32' ? { channel: 'msedge' } : {}),
});
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(config.webOrigin);
console.log('Opened AuthCore in an isolated browser profile: ' + config.webOrigin);
console.log(
  'Close the browser window to end this preview. No personal browser profile was opened.',
);
browser.on('disconnected', () => {
  process.exitCode = 0;
});
