import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout } from 'node:timers/promises';
const require = createRequire(new URL('../packages/db/package.json', import.meta.url));
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
assert.equal(process.env.DATABASE_URL, undefined);
const target = new URL(process.env.TEST_DATABASE_URL);
assert(['postgres:', 'postgresql:'].includes(target.protocol));
assert(['localhost', '127.0.0.1'].includes(target.hostname));
assert(['', '5432'].includes(target.port));
assert.equal(target.pathname, '/authcore_test');
assert.equal(target.username, 'authcore_test');
assert.equal(target.password, 'authcore_test'); // Public disposable CI fixture only.
assert.equal(target.search + target.hash, '');
const client = new (require('pg').Client)({ connectionString: target.toString() });
try {
  await client.connect();
  // CI service is disposable. Prevent PostgreSQL failure container logs from
  // printing SQL or row DETAIL containing credential/test payloads. Client
  // SQLSTATE/constraint diagnostics and transactional security audit stay intact.
  const expected = {
    log_error_verbosity: 'terse',
    log_min_error_statement: 'panic',
    log_parameter_max_length_on_error: '0',
    log_statement: 'none',
  };
  for (const [name, value] of Object.entries(expected))
    await client.query(`ALTER SYSTEM SET ${name} = '${value}'`);
  await client.query('SELECT pg_reload_conf()');
  let settings;
  for (let attempt = 0; attempt < 20; attempt++) {
    settings = Object.fromEntries(
      (
        await client.query('SELECT name, setting FROM pg_settings WHERE name = ANY($1::text[])', [
          Object.keys(expected),
        ])
      ).rows.map((row) => [row.name, row.setting]),
    );
    if (
      JSON.stringify(settings) === JSON.stringify(expected) ||
      Object.entries(expected).every(([key, value]) => settings[key] === value)
    )
      break;
    await setTimeout(50);
  }
  assert.deepEqual(settings, expected);
  await client.query(
    'CREATE TEMP TABLE authcore_log_privacy_probe(n int CONSTRAINT authcore_log_privacy_unique UNIQUE)',
  );
  await client.query('INSERT INTO authcore_log_privacy_probe VALUES(1)');
  await assert.rejects(
    client.query('INSERT INTO authcore_log_privacy_probe VALUES(1)'),
    (error) => error.code === '23505' && error.constraint === 'authcore_log_privacy_unique',
  );
  console.info('S6_CI_LOG_PRIVACY settings=4 clientSqlstate=23505 constraintPreserved=true PASS');
} finally {
  await client.end();
}
