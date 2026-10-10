# Signup transactional security audit

This slice adds durable PostgreSQL auditing to `SignupService` only. Signup stays
disabled by default (`SIGNUP_ENABLED=false`). AUTH-001 remains incomplete and
AUTH-002 — Login stays in the roadmap. This slice does not change admission slots
or add idempotency, COMMIT reconciliation, an external outbox worker or production
enablement.

## Migration and data policy

`packages/db/drizzle/0002_security_audit_events.sql` is additive. It creates an
empty table and its constraints; it does not backfill historical creation events
or change existing users/credentials. Drizzle's journal and new snapshot record
the same schema. Previous migrations and snapshots remain unchanged.

Each row has a generated UUID primary key, fixed `event_type`
(`identity.user_created`), non-null `user_id`, database-generated transaction
timestamp `occurred_at` (`timestamptz(3)`), and JSONB `payload` equal to `{}`.
PostgreSQL CHECK constraints enforce the fixed event type and empty payload even
for direct SQL writers. This event needs no metadata: no email, password, hash,
request body, idempotency key or secret is accepted in the payload. New event
types/payload formats require an explicit schema migration and security review.

`UNIQUE(event_type, user_id)` prevents two creation events for the same user,
including concurrent inserts. The writer does not ignore conflicts or upsert.
The user foreign key uses `ON DELETE RESTRICT ON UPDATE NO ACTION`. Deleting a
user cannot cascade into deleting audit history, and orphan subjects are rejected.

Audit retention and account deletion policy are not finalized. Retention is
indefinite in this development slice: there is no automatic purge or audit
update/delete application API. Users with audit history must be retained (existing
`disabled_at` supports disabling an account). A future hard-delete/retention
workflow needs an explicit policy and reviewed implementation; deleting audit
rows simply to bypass the foreign key is not an account-deletion workflow.
Disposable test databases explicitly clear audit rows before users, then are
dropped. This cleanup is confined to test-owned databases.

Database-enforced append-only protection is not implemented. This is durable
transactional storage, not tamper-evident storage or a new database privilege
model. A SQL role with the required privileges can modify or
delete rows. PostgreSQL persistence/backup configuration continues to govern
durability; no infrastructure or role privileges are changed here.

## Transaction behavior

Hashing still happens before checkout. `runSignupTransaction` supplies one
connection/transaction to user, credential and audit repositories, in that order.
The existing transaction-local timeouts are configured before any write. Signup
lease checks run between writes and after audit insertion, before COMMIT.

A successful transaction commits all three writes. A user, credential, audit or
lease failure before COMMIT causes rollback of the transaction; audit insertion
is mandatory and its errors propagate. The existing failure cleanup, connection
eviction, fatal SQLSTATE precedence and Redis release/settlement rules are unchanged.
An unacknowledged COMMIT still has an unknown client-visible outcome: PostgreSQL
commits all three or none, but this slice does not determine which happened or
retry COMMIT.

Redis lease/COMMIT fencing remains unresolved: lease loss after the final
assertion can still race COMMIT. Uncertain COMMIT reconciliation and idempotency
also remain unresolved. Atomicity of the three database writes does not resolve
the client's uncertainty or provide a distributed execution fence.

Normalized-email uniqueness still decides duplicate signup atomically. The
duplicate path stops at user insertion and never writes/replaces a credential or
creates an audit event, including for legacy accounts that have no creation audit.
When enabled in an isolated test application, success and duplicate still return
the same HTTP 202 `{"status":"accepted"}`. Unexpected errors retain the existing
sanitized HTTP response. Equal HTTP responses do not provide timing resistance.

The existing post-commit `identity.user_created` operational log is preserved.
`security_audit_events` is the durable source of truth; operational logs are
neither proof of transaction durability nor required for the event to exist.

## Verification

### Current user-run local checkpoint — 2026-10-10 (Asia/Rangoon)

Branch: `feat/signup-transactional-audit`. Base: `main` at
`3c75b430562faef1922b9428069c42925566bb12`.
The user reported the following local results before the P3 documentation and
formatting cleanup. They are not CI results or independent reviewer reruns.

| Check                                  | User-reported local result      |
| -------------------------------------- | ------------------------------- |
| Workspace tests                        | 168 passed, 0 failed, 0 skipped |
| PostgreSQL signup integration          | 17/17 passed                    |
| DB repository integration              | 25/25 passed                    |
| Dedicated Redis integration            | 28/28 passed                    |
| Combined HTTP + Redis + PostgreSQL E2E | 7/7 passed                      |
| Workspace lint, typecheck and build    | PASS                            |

The signup PostgreSQL cases run within workspace tests when TEST_DATABASE_URL is
supplied; their focused rerun is not an additional set of distinct tests.
Earlier counts in related notes are historical checkpoints, not current totals.
Candidate PR CI still needs to run against the submitted revision. Public signup
remains disabled (`SIGNUP_ENABLED=false`); these results do not authorize public
launch or constitute independent human security approval.

### P3 cleanup verification — 2026-10-10

The cleanup run separately passed workspace lint and typecheck. Workspace tests
passed with 151 passed, 0 failed and 17 skipped: TEST_DATABASE_URL was deliberately
unset for this run, so the real PostgreSQL signup suite was skipped. These results
do not replace the user's earlier 168-pass, zero-skip checkpoint above. Separate
PostgreSQL repository, dedicated Redis and combined E2E suites were not rerun.

Changed-file Prettier checks passed for all 16 supported files in the final
17-file inventory; the unchanged SQL migration has no configured Prettier parser
and was checked manually. `git diff --check` and migration lineage/order checks
passed. Formatting the two current Drizzle metadata files preserved their parsed
JSON values exactly, including IDs, lineage, journal indices and timestamps.
TypeScript export declarations remained equivalent. Migration SQL and prior
snapshots were unchanged, so no database migration or behavior-changing edit was
needed. Updating `docs/Development Status.md` added the seventeenth changed file.

### Coverage and isolated verification commands

Unit regressions cover audit writer field allowlisting, missing insert results,
error propagation, service ordering and lease loss before/after the audit write.
PostgreSQL regressions cover all three committed writes, credential/audit failures,
duplicate and concurrent signup, legacy duplicates, unique constraints, payload
checks, orphan prevention and retention on attempted user deletion.
The combined E2E suite also covers lease loss after each real write, sanitized
credential/audit failure and identical success/duplicate HTTP responses.

Use the existing isolated infrastructure only. Do not run `db:migrate` as a test:
that command loads the application's `.env`. Test suites never fall back to
`DATABASE_URL`; they create/drop only their own randomly named databases after
validating local `authcore_test` on port 5432. PostgreSQL 17+ is required by the
existing transaction-timeout checks. The supplied test role needs CREATEDB.
Redis suites use only UUID test namespaces on the dedicated port 6380 and never
flush Redis. No commands below create/reconfigure containers or change `.env`.

From a normal, non-elevated PowerShell session:

```powershell
Set-Location 'C:\Users\Tin Aung Cho\authcore'
$env:SIGNUP_ENABLED = 'false'
git branch --show-current
git rev-parse main
git diff --check
pnpm.cmd lint
pnpm.cmd build
pnpm.cmd typecheck
pnpm.cmd test

# TEST_DATABASE_URL must already be supplied privately for the isolated DB.
# Never copy the application DATABASE_URL or print test credentials.
if ($env:TEST_DATABASE_URL) {
    pnpm.cmd --filter @authcore/db test:integration
    pnpm.cmd --filter @authcore/api exec vitest run src/identity/signup.service.integration.test.ts
} else {
    Write-Output 'Real PostgreSQL tests not executed: TEST_DATABASE_URL unavailable.'
}

# Run only when the existing dedicated test Redis is available on port 6380.
$previousTestRedisUrl = $env:TEST_REDIS_URL
try {
    $env:TEST_REDIS_URL = 'redis://127.0.0.1:6380'
    pnpm.cmd --filter @authcore/api test:redis
    if ($env:TEST_DATABASE_URL) {
        pnpm.cmd --filter @authcore/api test:e2e
    } else {
        Write-Output 'Combined HTTP E2E not executed: TEST_DATABASE_URL unavailable.'
    }
} finally {
    $env:TEST_REDIS_URL = $previousTestRedisUrl
}
git status --short
```

Without TEST_DATABASE_URL the workspace's signup PostgreSQL tests and separate
DB integration suite report skips. Redis and combined E2E require explicit
opt-in; they fail setup when their required variables are missing. Skips or
unexecuted suites are not evidence that real PostgreSQL/Redis behavior passed.
