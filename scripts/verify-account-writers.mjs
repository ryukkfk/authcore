import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
async function files(folder) {
  return (
    await Promise.all(
      (await readdir(folder, { withFileTypes: true })).map((entry) => {
        const path = resolve(folder, entry.name);
        if (['node_modules', 'dist', '.next', '.git'].includes(entry.name)) return [];
        return entry.isDirectory() ? files(path) : [path];
      }),
    )
  ).flat();
}
// Review changes to this inventory as security changes. Repositories remain
// trusted transaction primitives; this guard is not an arbitrary-code sandbox.
const expected = {
  inserts: [
    'packages/db/src/repositories/password-credential.repository.ts:passwordCredentials',
    'packages/db/src/repositories/security-audit-event.repository.ts:securityAuditEvents',
    'packages/db/src/repositories/signup-idempotency.repository.ts:claims',
    'packages/db/src/repositories/signup-idempotency.repository.ts:results',
    'packages/db/src/repositories/user.repository.ts:users',
    'packages/db/src/repositories/verification-event.repository.ts:verificationEvents',
    'packages/db/src/signup-claim-policy.ts:terminal',
  ],
  accountRepositories: [
    'apps/api/src/identity/identity.module.ts:UserRepository',
    'apps/api/src/identity/signup-protocol.service.ts:PasswordCredentialRepository',
    'apps/api/src/identity/signup-protocol.service.ts:SecurityAuditEventRepository',
    'apps/api/src/identity/signup-protocol.service.ts:UserRepository',
    'apps/api/src/identity/signup-protocol.service.ts:VerificationEventRepository',
  ],
  databaseEntrypoints: [
    'apps/api/src/database/database.service.ts:createDatabaseClient',
    'apps/api/src/identity/signup-protocol.service.ts:runOwnedSignupTransaction',
    'apps/api/src/identity/signup-reservation.ts:runOwnedSignupTransaction',
  ],
  databaseConsumers: [
    'apps/api/src/database/database.module.ts',
    'apps/api/src/health/health.controller.ts',
    'apps/api/src/identity/identity.module.ts',
    'apps/api/src/identity/signup.service.ts',
  ],
};
const actual = {
  inserts: [],
  accountRepositories: [],
  databaseConsumers: [],
  databaseEntrypoints: [],
};
for (const area of ['apps', 'packages', 'scripts']) {
  for (const path of await files(resolve(root, area))) {
    const name = relative(root, path).replaceAll('\\', '/');
    if (
      !/\.(?:ts|mjs|js)$/.test(name) ||
      /(?:\.test\.|\.spec\.|test-support|vitest\.|drizzle\/|drizzle.config|next.config|eslint.config)/.test(
        name,
      )
    )
      continue;
    if (name === 'scripts/verify-account-writers.mjs') continue;
    const source = ts.createSourceFile(
      name,
      await readFile(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node) => {
      if (ts.isImportDeclaration(node) && node.importClause && !node.importClause.isTypeOnly) {
        const bindings = node.importClause.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const imported of bindings.elements.filter((value) => !value.isTypeOnly)) {
            const symbol = (imported.propertyName ?? imported.name).text;
            if (symbol === 'DatabaseService') actual.databaseConsumers.push(name);
            if (
              name.startsWith('apps/') &&
              /^(?:createDatabaseClient|runSignupTransaction|runOwnedSignupTransaction|users|passwordCredentials|securityAuditEvents)$/.test(
                symbol,
              )
            ) {
              actual.databaseEntrypoints.push(name + ':' + symbol);
            }
            if (
              name.startsWith('apps/') &&
              /^(?:UserRepository|PasswordCredentialRepository|SecurityAuditEventRepository|VerificationEventRepository)$/.test(
                symbol,
              )
            ) {
              // Renamed imports must be explicitly reviewed, not silently missed.
              assert.equal(imported.name.text, symbol, `Aliased writer: ${name}`);
              actual.accountRepositories.push(name + ':' + symbol);
            }
          }
        }
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'insert'
      ) {
        actual.inserts.push(name + ':' + node.arguments[0]?.getText(source));
      }
      if (ts.isStringLiteralLike(node)) {
        assert(
          !/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:public\.)?["']?(?:users|password_credentials|security_audit_events)\b/i.test(
            node.text,
          ),
          `Direct account SQL: ${name}`,
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}
for (const category of Object.keys(expected)) {
  assert.deepEqual(
    actual[category].sort(),
    expected[category].sort(),
    `Unreviewed production ${category}`,
  );
}
console.info('ACCOUNT_WRITERS PASS ' + JSON.stringify(actual));
