import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
async function files(folder) {
  return (
    await Promise.all(
      (await readdir(folder, { withFileTypes: true })).map((entry) => {
        const path = resolve(folder, entry.name);
        return entry.isDirectory() ? files(path) : [path];
      }),
    )
  ).flat();
}
const { parseEnvironment } = await import('../packages/config/dist/index.js');
assert.equal(
  parseEnvironment({
    DATABASE_URL: 'postgresql://localhost/authcore_test',
    REDIS_URL: 'redis://localhost:6380',
    WEB_ORIGIN: 'http://localhost:3000',
  }).SIGNUP_ENABLED,
  false,
);
let inspected = 0;
for (const area of ['apps/api', 'packages/db', 'packages/crypto']) {
  for (const path of await files(resolve(root, area, 'dist'))) {
    if (!path.endsWith('.js')) continue;
    const name = relative(root, path).replaceAll('\\', '/');
    assert(!/test-support|\.test\.|\.spec\./.test(name), `Test fixture emitted: ${name}`);
    const source = await readFile(path, 'utf8');
    assert(!/test-support|signup-phase-a/.test(source), `Historical writer imported: ${name}`);
    assert(
      !/\bpool\.(?:_clients|_idle|_pendingQueue|_remove)\b/.test(source),
      `Private pool access: ${name}`,
    );
    // Narrow source/artifact secret check, not a claim of complete secret discovery.
    assert(
      !/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}\b/.test(
        source,
      ),
      `Credential pattern: ${name}`,
    );
    inspected++;
  }
}
console.info(
  `S6_ARTIFACT defaultDisabled=true productionFiles=${inspected} historicalWriter=false privatePoolAccess=false credentialPatterns=0 PASS`,
);
