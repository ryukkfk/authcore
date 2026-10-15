import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const reports = [
  ...['config', 'crypto', 'db'].map((name) => `packages/${name}/workspace-results.json`),
  'apps/api/workspace-results.json',
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
];
const identities = new Map();
const steps = [];
for (const report of reports) {
  const data = JSON.parse(await readFile(report, 'utf8'));
  let passed = 0,
    skipped = 0,
    failed = 0;
  for (const file of data.testResults) {
    const filename = file.name.replaceAll('\\', '/').replace(/^.*\/(apps|packages)\//, '$1/');
    for (const test of file.assertionResults) {
      assert(
        typeof test.fullName === 'string' && test.fullName.length > 0,
        'Assertion identity missing',
      );
      const id = createHash('sha256')
        .update(filename + ':' + test.fullName)
        .digest('hex');
      let statuses = identities.get(id);
      if (!statuses) identities.set(id, (statuses = new Set()));
      statuses.add(test.status);
      if (test.status === 'passed') passed++;
      else if (test.status === 'pending' || test.status === 'skipped' || test.status === 'todo')
        skipped++;
      else failed++;
    }
  }
  steps.push({ report, passed, skipped, failed, success: data.success });
}
const uniquePassed = [...identities.values()].filter((statuses) => statuses.has('passed')).length;
const uncovered = [...identities.values()].filter((statuses) => !statuses.has('passed')).length;
const failures = steps.reduce((total, step) => total + step.failed, 0);
const evidence = {
  head: process.env.GITHUB_SHA,
  headRef: process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME,
  runId: process.env.GITHUB_RUN_ID,
  uniqueTests: identities.size,
  uniquePassed,
  failures,
  uncovered,
  steps,
};
await writeFile('phase-b-validation-summary.json', JSON.stringify(evidence, null, 2) + '\n');
console.info(JSON.stringify(evidence));
assert(
  steps.every((step) => step.success),
  'One or more suites failed',
);
assert.equal(failures, 0);
assert.equal(uncovered, 0, 'Every guarded/skipped case must pass in its dedicated real step');
assert.equal(uniquePassed, identities.size);
assert(uniquePassed >= 667, 'Required Phase B coverage inventory unexpectedly decreased');
