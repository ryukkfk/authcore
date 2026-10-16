import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
const testedSha = git('rev-parse', 'HEAD');
assert.equal(testedSha, process.env.GITHUB_SHA, 'Checkout does not match this event');
let candidate = {
  event: process.env.GITHUB_EVENT_NAME,
  action: event.action,
  testedSha,
  head: testedSha,
  runId: process.env.GITHUB_RUN_ID,
};
if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
  const pr = event.pull_request;
  const parents = git('show', '-s', '--format=%P', 'HEAD').split(' ');
  assert.deepEqual(
    parents,
    [pr.base.sha, pr.head.sha],
    'Merge candidate parents differ from the event base/head',
  );
  // Recheck live state at both ends. A rerun of an old event must fail if the
  // head or base has moved. Strict up-to-date governance still guards the later merge.
  const response = await fetch(
    `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/pulls/${pr.number}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${process.env.CI_READ_TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );
  assert.equal(response.status, 200, 'Live PR candidate could not be verified');
  const live = await response.json();
  assert.equal(live.head.sha, pr.head.sha, 'Live PR head changed; require a fresh event');
  assert.equal(live.base.sha, pr.base.sha, 'Live PR base changed; require a fresh event');
  assert.equal(live.base.ref, pr.base.ref, 'Live PR target changed; require a fresh event');
  candidate = {
    ...candidate,
    head: pr.head.sha,
    base: pr.base.sha,
    baseRef: pr.base.ref,
    pr: pr.number,
    parents,
  };
}
await writeFile('phase-b-merge-candidate.json', JSON.stringify(candidate, null, 2) + '\n');
console.info('CI_CANDIDATE ' + JSON.stringify(candidate));
