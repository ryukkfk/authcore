import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
export function summarizeBrowserReport(report) {
  assert(
    Array.isArray(report.errors) && report.errors.length === 0,
    'Browser runner reported an infrastructure error',
  );
  assert.equal(report.stats.expected, 3);
  assert.equal(report.stats.unexpected, 0);
  assert.equal(report.stats.flaky, 0);
  assert.equal(report.stats.skipped, 0);
  const identities = new Set();
  let count = 0;
  function visit(suite) {
    for (const spec of suite.specs ?? []) {
      const filename = String(spec.file).replaceAll('\\', '/');
      assert(
        [
          'authentication.pw.ts',
          'apps/web/e2e/authentication.pw.ts',
          resolve(root, 'apps/web/e2e/authentication.pw.ts').replaceAll('\\', '/'),
        ].includes(filename),
        'Unexpected browser suite',
      );
      assert.equal(spec.ok, true);
      assert.equal(typeof spec.title, 'string');
      assert(spec.title.length > 0);
      for (const test of spec.tests) {
        assert.equal(test.expectedStatus, 'passed');
        assert.equal(test.status, 'expected');
        assert.equal(test.results.length, 1);
        assert.equal(test.results[0].status, 'passed');
        const id = createHash('sha256')
          .update(
            'apps/web/e2e/authentication.pw.ts:' + spec.title + ':' + (test.projectName ?? ''),
          )
          .digest('hex');
        assert(!identities.has(id), 'Duplicate browser assertion identity');
        identities.add(id);
        count++;
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  }
  for (const suite of report.suites) visit(suite);
  assert.equal(count, 3);
  return {
    uniqueBrowserTests: count,
    passed: count,
    failed: 0,
    skipped: 0,
    flaky: 0,
    identities: [...identities].sort(),
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const summary = summarizeBrowserReport(
    JSON.parse(await readFile(resolve(root, '.local-demo/browser-results.json'), 'utf8')),
  );
  const candidate = JSON.parse(
    await readFile(resolve(root, 'phase-b-merge-candidate.json'), 'utf8'),
  );
  const evidence = {
    head: candidate.head,
    testedSha: candidate.testedSha,
    base: candidate.base,
    runId: candidate.runId,
    ...summary,
  };
  await writeFile(
    resolve(root, 'browser-validation-summary.json'),
    JSON.stringify(evidence, null, 2) + '\n',
  );
  process.stdout.write('BROWSER_ACCEPTANCE ' + JSON.stringify(evidence) + '\n');
}
