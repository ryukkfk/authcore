import { spawnSync } from 'node:child_process';

// Genuine local execution. Never impersonate a GitHub-hosted runner to defeat
// historical guards; dedicated guarded regressions still execute in real CI.
if (process.env.GITHUB_ACTIONS || process.env.RUNNER_ENVIRONMENT)
  throw new Error('Local harness refuses hosted-runner identity');
const env = {
  ...process.env,
  TEST_DATABASE_URL: 'postgresql://authcore_test:authcore_test@127.0.0.1:5432/authcore_test',
  TEST_REDIS_URL: 'redis://127.0.0.1:6380',
  TEST_MAILBOX_URL: 'http://127.0.0.1:8025',
  SIGNUP_ENABLED: 'false',
};
delete env.DATABASE_URL;
const commands = [
  ['pnpm', ['lint']],
  ['pnpm', ['typecheck']],
  [
    'pnpm',
    ['test', '--reporter=default', '--reporter=json', '--outputFile.json=workspace-results.json'],
  ],
  [
    'pnpm',
    [
      '--filter',
      '@authcore/db',
      'test:integration',
      '--reporter=default',
      '--reporter=json',
      '--outputFile.json=postgres-results.json',
    ],
  ],
  ['pnpm', ['--filter', '@authcore/api', 'test:redis']],
  ['pnpm', ['--filter', '@authcore/api', 'test:e2e']],
  ['node', ['scripts/verify-driver-patches.mjs']],
  ['node', ['scripts/verify-phase-b-artifact.mjs']],
  ['node', ['scripts/verify-account-writers.mjs']],
];
for (const [command, args] of commands) {
  const run = spawnSync(command, args, { env, stdio: 'inherit' });
  if (run.error || run.status !== 0) process.exit(run.status || 1);
}
console.info('LOCAL_REGRESSION PASS; hosted-only guarded cases require separate CI evidence.');
