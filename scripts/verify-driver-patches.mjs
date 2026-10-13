import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(resolve(root, 'packages/db/package.json'));
const pg = require.resolve('pg');
const fromPg = createRequire(pg);
const pool = fromPg.resolve('pg-pool');
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const provenance = JSON.parse(readFileSync(resolve(root, 'patches/provenance.json'), 'utf8'));
for (const [name, entry] of [
  ['pg', pg],
  ['pg-pool', pool],
]) {
  const folder = name === 'pg' ? resolve(dirname(entry), '..') : dirname(entry);
  const expected = provenance[name];
  assert.equal(
    JSON.parse(readFileSync(resolve(folder, 'package.json'), 'utf8')).version,
    expected.version,
  );
  assert.equal(digest(resolve(root, expected.patch)), expected.patchSha256, `${name} patch drift`);
  assert.equal(
    digest(resolve(folder, expected.source)),
    expected.installedSha256,
    `${name} installed-source drift`,
  );
  assert.equal(digest(resolve(folder, 'LICENSE')), expected.licenseSha256, `${name} license drift`);
}
assert.equal(typeof new (require('pg').Client)().terminate, 'function');
assert.equal(
  JSON.parse(readFileSync(resolve(root, 'packages/db/package.json'), 'utf8')).dependencies.pg,
  '8.23.1',
);
console.info('A1_PATCH_INTEGRITY versions=2 patches=2 sources=2 licenses=2 PASS');
