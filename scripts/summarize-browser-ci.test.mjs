import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeBrowserReport } from './summarize-browser-ci.mjs';

function fixture() {
  return {
    errors: [],
    stats: { expected: 2, unexpected: 0, flaky: 0, skipped: 0 },
    suites: [
      {
        specs: ['full flow', 'mobile keyboard'].map((title) => ({
          file: 'authentication.pw.ts',
          title,
          ok: true,
          tests: [
            {
              expectedStatus: 'passed',
              status: 'expected',
              projectName: '',
              results: [{ status: 'passed' }],
            },
          ],
        })),
      },
    ],
  };
}
test('browser evidence publishes only two unique opaque passed identities', () => {
  const result = summarizeBrowserReport(fixture());
  assert.equal(result.uniqueBrowserTests, 2);
  assert.equal(result.identities.length, 2);
  assert(result.identities.every((id) => /^[0-9a-f]{64}$/.test(id)));
  assert(!JSON.stringify(result).includes('full flow'));
});
test('browser evidence rejects failed skipped retried and duplicate assertions', () => {
  const modifications = [
    (value) => {
      value.stats.skipped = 1;
    },
    (value) => {
      value.suites[0].specs[0].tests[0].results[0].status = 'failed';
    },
    (value) => {
      value.suites[0].specs[0].tests[0].expectedStatus = 'failed';
    },
    (value) => {
      value.suites[0].specs[0].tests[0].results.push({ status: 'passed' });
    },
    (value) => {
      value.suites[0].specs[1].title = value.suites[0].specs[0].title;
    },
  ];
  for (const change of modifications) {
    const data = fixture();
    change(data);
    assert.throws(() => summarizeBrowserReport(data));
  }
});
test('browser evidence rejects external suite paths and runner infrastructure errors', () => {
  const external = fixture();
  external.suites[0].specs[0].file = '/private/other.test.ts';
  assert.throws(() => summarizeBrowserReport(external));
  const infrastructure = fixture();
  infrastructure.errors.push({ message: 'private sentinel' });
  assert.throws(() => summarizeBrowserReport(infrastructure));
});
