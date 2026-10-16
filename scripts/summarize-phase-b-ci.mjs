import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const reports = [
  ...['config', 'crypto', 'db'].map((name) => `packages/${name}/workspace-results.json`),
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
const identities = new Map();
const steps = [];
for (const report of reports) {
  let data;
  try {
    data = JSON.parse(await readFile(report, 'utf8'));
  } catch {
    // Preserve an explicitly incomplete artifact on early CI failure, without
    // copying raw exception, row or request data into the evidence artifact.
    steps.push({ report, passed: 0, skipped: 0, failed: 0, success: false, unavailable: true });
    continue;
  }
  let passed = 0,
    skipped = 0,
    failed = 0;
  for (const file of data.testResults) {
    const filename = file.name.replaceAll('\\', '/').replace(/^.*\/(apps|packages)\//, '$1/');
    assert(
      /^(?:apps|packages)\/[A-Za-z0-9_./-]+\.test\.ts$/.test(filename) && !filename.includes('..'),
      'Unsafe suite identifier',
    );
    for (const test of file.assertionResults) {
      assert(
        typeof test.fullName === 'string' && test.fullName.length > 0,
        'Assertion identity missing',
      );
      const id = createHash('sha256')
        .update(filename + ':' + test.fullName)
        .digest('hex');
      let identity = identities.get(id);
      if (!identity)
        identities.set(id, (identity = { suite: filename, statuses: new Set(), executions: [] }));
      const statuses = identity.statuses;
      statuses.add(test.status);
      identity.executions.push({
        report,
        category: report.endsWith('/workspace-results.json')
          ? 'workspace'
          : report.split('/').at(-1).replace('-results.json', ''),
        status:
          test.status === 'passed'
            ? 'PASS'
            : ['pending', 'skipped', 'todo'].includes(test.status)
              ? 'SKIP'
              : 'FAIL',
      });
      if (test.status === 'passed') passed++;
      else if (test.status === 'pending' || test.status === 'skipped' || test.status === 'todo')
        skipped++;
      else failed++;
    }
  }
  steps.push({ report, passed, skipped, failed, success: data.success });
}
const uniquePassed = [...identities.values()].filter(({ statuses }) =>
  statuses.has('passed'),
).length;
const uncovered = [...identities.values()].filter(({ statuses }) => !statuses.has('passed')).length;
const failures = steps.reduce((total, step) => total + step.failed, 0);
const event = process.env.GITHUB_EVENT_PATH
  ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'))
  : {};
const evidence = {
  head: event.pull_request?.head.sha ?? process.env.GITHUB_SHA,
  testedSha: process.env.GITHUB_SHA,
  base: event.pull_request?.base.sha,
  headRef: process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME,
  runId: process.env.GITHUB_RUN_ID,
  uniqueTests: identities.size,
  uniquePassed,
  failures,
  uncovered,
  steps,
};
await writeFile('phase-b-validation-summary.json', JSON.stringify(evidence, null, 2) + '\n');
// Assertion names can contain parameterized inputs. Publish only opaque stable
// identities and allowlisted repository-relative suite paths, never raw names/errors.
await writeFile(
  'phase-b-test-identities.json',
  JSON.stringify(
    {
      head: evidence.head,
      testedSha: evidence.testedSha,
      base: evidence.base,
      runId: evidence.runId,
      assertions: [...identities.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, value]) => ({
          id,
          suite: value.suite,
          status: value.executions.some((run) => run.status === 'FAIL')
            ? 'FAIL'
            : value.statuses.has('passed')
              ? 'PASS'
              : 'SKIP',
          guarded: value.executions.some((run) => run.status === 'SKIP'),
          reconciled: value.statuses.has('passed'),
          executions: value.executions,
        })),
    },
    null,
    2,
  ) + '\n',
);
console.info(JSON.stringify(evidence));
assert(
  steps.every((step) => step.success),
  'One or more suites failed',
);
assert.equal(failures, 0);
assert.equal(uncovered, 0, 'Every guarded/skipped case must pass in its dedicated real step');
assert.equal(uniquePassed, identities.size);
assert(
  uniquePassed >= 683,
  'Required Phase B remediation coverage inventory unexpectedly decreased',
);
