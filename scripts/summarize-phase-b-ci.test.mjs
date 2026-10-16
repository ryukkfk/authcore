import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('./summarize-phase-b-ci.mjs', import.meta.url));
const reports = [
  'packages/config/workspace-results.json',
  'packages/crypto/workspace-results.json',
  'packages/db/workspace-results.json',
  'apps/api/workspace-results.json',
  'apps/worker/workspace-results.json',
  'packages/db/postgres-results.json',
  'packages/db/a1-results.json',
  'packages/db/s1-pool-results.json',
  'packages/db/s0-results.json',
  'apps/api/s2-results.json',
  'apps/api/s3-results.json',
  'apps/api/s4-results.json',
  'apps/api/s6-lifecycle-results.json',
  'apps/api/redis-results.json',
  'apps/api/s5-http-results.json',
  'apps/api/pb-results.json',
];
async function fixture(run) {
  const folder = await mkdtemp(join(tmpdir(), 'authcore-evidence-'));
  const name = '/private/path/apps/api/src/identity/evidence.test.ts';
  const fullName = 'parameterized private-input sentinel ';
  const data = (status = 'passed') => ({
    success: true,
    testResults: [
      {
        name,
        assertionResults: Array.from({ length: 683 }, (_, i) => ({
          fullName: fullName + i,
          status,
        })),
      },
    ],
  });
  const save = async (report, value) => {
    await mkdir(dirname(join(folder, report)), { recursive: true });
    await writeFile(join(folder, report), JSON.stringify(value));
  };
  try {
    for (const report of reports) await save(report, data());
    const execute = () =>
      spawnSync(process.execPath, [script], {
        cwd: folder,
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_EVENT_PATH: '',
          GITHUB_SHA: 'a'.repeat(40),
          GITHUB_RUN_ID: 'fixture-run',
        },
      });
    await run({ folder, data, save, execute, fullName });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

test('sanitized identity map deduplicates repeated executions and reconciles guarded skips', () =>
  fixture(async ({ folder, data, save, execute, fullName }) => {
    await save(reports[0], data('pending'));
    assert.equal(execute().status, 0);
    const raw = await readFile(join(folder, 'phase-b-test-identities.json'), 'utf8');
    const map = JSON.parse(raw);
    const summary = JSON.parse(
      await readFile(join(folder, 'phase-b-validation-summary.json'), 'utf8'),
    );
    assert.equal(summary.uniquePassed, 683);
    assert.equal(map.assertions.length, 683);
    assert.equal(map.head, 'a'.repeat(40));
    assert.equal(map.runId, 'fixture-run');
    assert(
      map.assertions.every(
        (entry) =>
          /^[0-9a-f]{64}$/.test(entry.id) &&
          entry.status === 'PASS' &&
          entry.guarded &&
          entry.reconciled &&
          entry.executions.length === reports.length,
      ),
    );
    assert(!raw.includes('/private/path') && !raw.includes(fullName));
  }));
test('missing required report fails reconciliation and preserves incomplete summary', () =>
  fixture(async ({ folder, execute }) => {
    await rm(join(folder, reports.at(-1)));
    assert.notEqual(execute().status, 0);
    const summary = JSON.parse(
      await readFile(join(folder, 'phase-b-validation-summary.json'), 'utf8'),
    );
    assert(summary.steps.some((step) => step.unavailable));
  }));
test('a failed duplicate execution cannot hide behind an earlier pass', () =>
  fixture(async ({ data, save, execute }) => {
    const failure = data();
    failure.testResults[0].assertionResults[0].status = 'failed';
    await save(reports.at(-1), failure);
    assert.notEqual(execute().status, 0);
  }));
test('an uncovered guarded identity fails even with enough other passing tests', () =>
  fixture(async ({ data, save, execute }) => {
    const missing = data();
    missing.testResults[0].assertionResults.push({ fullName: 'uncovered', status: 'pending' });
    await save(reports.at(-1), missing);
    assert.notEqual(execute().status, 0);
  }));
test('unrecognized external suite paths are rejected before publication', () =>
  fixture(async ({ data, save, execute }) => {
    const unsafe = data();
    unsafe.testResults[0].name = '/private/user/credential.test.ts';
    await save(reports[0], unsafe);
    assert.notEqual(execute().status, 0);
  }));
