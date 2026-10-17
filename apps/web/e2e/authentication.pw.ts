import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile, open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import process from 'node:process';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const config = JSON.parse(await readFile(resolve(root, '.local-demo/public.json'), 'utf8'));
const password = '\u{1f510}\ufe0f'.repeat(128);
const exec = promisify(execFile);
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  await expect
    .poll(
      async () => {
        try {
          const responses = await Promise.all(
            [
              config.webOrigin,
              config.apiOrigin + '/api/v1/health/ready',
              config.mailboxOrigin + '/readyz',
            ].map((url) => fetch(url, { signal: AbortSignal.timeout(1500) })),
          );
          await Promise.all(responses.map((response) => response.body?.cancel()));
          return responses.every((response) => response.status === 200);
        } catch {
          return false;
        }
      },
      { timeout: 120000, intervals: [500, 1000] },
    )
    .toBe(true);
});
async function fillProof(page: Page, value: string) {
  try {
    await page.getByLabel('Password', { exact: true }).fill(value);
  } catch {
    throw new Error('Password field interaction failed (credential omitted).');
  }
}
async function signIn(page: Page, email: string, valid = true) {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await page.getByLabel('Email address').fill(email);
  await fillProof(page, valid ? password : 'Wrong public isolated fixture password');
  const reply = page.waitForResponse((response) => response.url().endsWith('/api/v1/auth/login'));
  await page.getByRole('button', { name: 'Sign in', exact: false }).click();
  return (await reply).status();
}
async function restartOwnedDemo() {
  try {
    await exec(process.execPath, ['scripts/local-demo.mjs', 'stop'], {
      cwd: root,
      windowsHide: true,
    });
  } catch {
    throw new Error('Owned demo graceful shutdown failed; no arbitrary PID was stopped.');
  }
  const log = await open(
    resolve(root, '.local-demo/logs/browser-restart-' + Date.now() + '.log'),
    'ax',
    0o600,
  );
  try {
    const supervisor = spawn(process.execPath, ['scripts/local-demo.mjs', 'start'], {
      cwd: root,
      windowsHide: true,
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
    });
    supervisor.unref();
  } finally {
    await log.close();
  }
  await expect
    .poll(
      async () => {
        try {
          const responses = await Promise.all(
            [
              config.apiOrigin + '/api/v1/health/ready',
              config.webOrigin,
              config.mailboxOrigin + '/readyz',
            ].map((url) => fetch(url, { signal: AbortSignal.timeout(1000) })),
          );
          await Promise.all(responses.map((response) => response.body?.cancel()));
          return responses.every((response) => response.status === 200) ? 200 : 0;
        } catch {
          return 0;
        }
      },
      { timeout: 90000, intervals: [300, 500, 1000] },
    )
    .toBe(200);
}
test.afterAll(async () => {
  // The browser workflow restarts only its named disposable demo. Stop that
  // supervisor gracefully before Playwright retires its worker process tree.
  try {
    await readFile(resolve(root, '.local-demo/processes.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    await exec(process.execPath, ['scripts/local-demo.mjs', 'stop'], {
      cwd: root,
      windowsHide: true,
    });
  } catch {
    throw new Error('Browser workflow could not gracefully stop its disposable demo supervisor.');
  }
});
test('secure signup mailbox verification login dashboard revocation logout and restart persistence', async ({
  page,
  context,
  browser,
}) => {
  const email = 'browser-' + randomUUID() + '@example.invalid';
  const cspDiagnostics: string[] = [];
  let pageErrors = 0,
    cspErrors = 0;
  page.on('pageerror', () => pageErrors++);
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      /content security policy|violates.*directive/i.test(message.text())
    ) {
      cspErrors++;
      cspDiagnostics.push(
        message
          .text()
          .replace(/(?:https?|wss?):\/\/[^\s'"<>]+/g, (value) => {
            try {
              const url = new URL(value);
              return url.origin + url.pathname;
            } catch {
              return '[URL omitted]';
            }
          })
          .replace(/[A-Za-z0-9_-]{43,}/g, '[opaque value omitted]'),
      );
    }
  });
  await page.goto('/register');
  await expect(page.getByRole('heading', { name: 'Create account', exact: true })).toBeVisible();
  await page.getByLabel('Email address').fill(email);
  await fillProof(page, password);
  const signup = page.waitForResponse((response) => response.url().endsWith('/api/v1/auth/signup'));
  await page.getByRole('button', { name: 'Create account', exact: false }).click();
  expect((await signup).status()).toBe(202);
  await expect(page.getByRole('status')).toContainText('If this address is eligible');

  // A real password is insufficient until the durable mailbox proof is consumed.
  expect(await signIn(page, email)).toBe(401);
  await expect(page.getByRole('alert')).toContainText('Sign-in was not accepted');
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();

  let messageId: string | undefined;
  await expect
    .poll(
      async () => {
        const response = await fetch(
          config.mailboxOrigin + '/api/v1/search?query=' + encodeURIComponent('to:' + email),
          {
            signal: AbortSignal.timeout(3000),
          },
        );
        const result = await response.json();
        messageId = result.messages?.[0]?.ID;
        return typeof messageId === 'string';
      },
      { timeout: 20000, intervals: [300, 500, 1000] },
    )
    .toBe(true);
  // Inspect the actual capture UI in an isolated context with no AuthCore cookies.
  const mailboxContext = await browser.newContext();
  const mailbox = await mailboxContext.newPage();
  await mailbox.goto(config.mailboxOrigin);
  await expect
    .poll(async () =>
      (await mailbox.locator('body').innerText()).includes(
        '[LOCAL DEMO ONLY] Verify your AuthCore email',
      ),
    )
    .toBe(true);
  await mailboxContext.close();
  const delivery = await fetch(config.mailboxOrigin + '/api/v1/message/' + messageId, {
    signal: AbortSignal.timeout(3000),
  });
  const message = await delivery.json();
  const match = /http:\/\/127\.0\.0\.1:\d+\/verify#token=[A-Za-z0-9_-]{43}/.exec(
    message.Text ?? '',
  );
  if (!match || !match[0].startsWith(config.webOrigin + '/verify#token='))
    throw new Error('Captured message did not contain the expected local verification proof.');
  // No traces/videos/screenshot-on-failure or raw proof values in assertions.
  try {
    await page.goto(match[0]);
  } catch {
    throw new Error('Verification navigation failed (proof omitted).');
  }
  await expect(page.getByRole('button', { name: 'Verify email', exact: true })).toBeVisible();
  expect(new URL(page.url()).hash === '').toBe(true);
  await page.getByRole('button', { name: 'Verify email', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Email confirmed.' })).toBeVisible();

  expect(await signIn(page, email, false)).toBe(401);
  await expect(page.getByRole('alert')).toContainText('Sign-in was not accepted');
  expect(await signIn(page, email)).toBe(200);
  await expect(page.getByRole('heading', { name: 'Your account, at a glance.' })).toBeVisible();
  await expect(page.getByRole('definition').filter({ hasText: email })).toBeVisible();
  await expect(page.getByText('This session', { exact: true })).toBeVisible();
  const cookies = await context.cookies(config.webOrigin + '/api/v1/auth/me');
  const session = cookies.find((cookie) => cookie.name === 'authcore_session');
  if (!session) throw new Error('Expected the server-issued browser session.');
  expect(session.httpOnly).toBe(true);
  expect(session.sameSite).toBe('Lax');
  expect(session.path).toBe('/api/v1/auth');
  expect(
    (await context.cookies(config.mailboxOrigin + '/api/v1/messages')).some(
      (cookie) => cookie.name === 'authcore_session',
    ),
  ).toBe(false);
  expect(await page.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0)).toBe(
    true,
  );
  expect(await page.evaluate(() => document.cookie.includes('authcore_session'))).toBe(false);
  await page.screenshot({
    path: resolve(root, '.local-demo/browser-dashboard.png'),
    fullPage: true,
  });

  // Ordinary stop/start preserves database, Redis, mailbox and browser session.
  await restartOwnedDemo();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your account, at a glance.' })).toBeVisible();
  await expect(page.getByRole('definition').filter({ hasText: email })).toBeVisible();
  const retained = await fetch(config.mailboxOrigin + '/api/v1/message/' + messageId, {
    signal: AbortSignal.timeout(3000),
  });
  expect(retained.status).toBe(200);
  await retained.body?.cancel();

  const otherContext = await browser.newContext({ baseURL: config.webOrigin });
  const other = await otherContext.newPage();
  expect(await signIn(other, email)).toBe(200);
  await expect(other.getByRole('heading', { name: 'Your account, at a glance.' })).toBeVisible();
  await page.goto('/security');
  await expect(page.getByRole('button', { name: 'Revoke access', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Revoke access', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Revoke access', exact: true })).toHaveCount(0);
  await other.reload();
  await expect(other.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
  await otherContext.close();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  expect(
    (await context.cookies(config.webOrigin + '/api/v1/auth/me')).some(
      (cookie) => cookie.name === 'authcore_session',
    ),
  ).toBe(false);
  let replayStatus: number;
  try {
    const replay = await fetch(config.apiOrigin + '/api/v1/auth/me', {
      headers: { cookie: 'authcore_session=' + session.value },
      signal: AbortSignal.timeout(3000),
      redirect: 'error',
    });
    replayStatus = replay.status;
    await replay.body?.cancel();
  } catch {
    throw new Error('Logout replay request failed at transport (credential omitted).');
  }
  expect(replayStatus).toBe(401);
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
  expect(pageErrors).toBe(0);
  await writeFile(
    resolve(root, '.local-demo/browser-csp-diagnostics.json'),
    JSON.stringify(cspDiagnostics, null, 2),
  );
  expect(cspErrors).toBe(0);
});

test('mobile public forms and keyboard skip navigation remain accessible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByLabel('Email address')).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  await page.goto('/verify');
  await expect(page.getByRole('alert')).toContainText('verification link is missing');
});
