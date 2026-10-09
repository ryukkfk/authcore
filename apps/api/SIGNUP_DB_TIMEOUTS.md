# Final pre-PR verification — October 9, 2026

This section records the latest user-run local results for
`feat/signup-db-timeouts-e2e`. The user reported these successful runs; the final
read-only security review did not rerun runtime or database tests. Earlier
verification sections below are preserved as history, including the earlier
session in which TEST_DATABASE_URL was unavailable. Its live-test execution gap
is superseded by the user-reported results here, not by a new reviewer test run.

| User-run local verification   | Reported result |
| ----------------------------- | --------------- |
| Workspace typecheck           | PASS            |
| Workspace lint                | PASS            |
| Workspace build               | PASS            |
| Workspace tests               | PASS            |
| PostgreSQL signup integration | 15/15 PASS      |
| DB repository integration     | 14/14 PASS      |
| HTTP + Redis + PostgreSQL E2E | 4/4 PASS        |
| Dedicated Redis integration   | 28/28 PASS      |

## Fixes and fixture correction reviewed

- F1: the transaction helper retains an earlier unsolicited PostgreSQL fatal
  error, including SQLSTATE 25P03, when resumed work fails with a dead-connection
  error or a throwing lease assertion. Otherwise it preserves the original
  application/setup/COMMIT rejection. Error precedence is frozen before cleanup;
  secondary ROLLBACK, transport, or release errors cannot replace it.
- F2: failed transactions await pg end/transport close before eviction, with
  bounded rollback and teardown handling that destroys the actual socket when
  needed. Admission awaits transaction settlement, retaining local capacity and
  deferring ownership-safe Redis release through relevant DB work and cleanup.
  Connections are released once; healthy connections remain reusable.
- The timeout-settings integration fixture previously reused a client that a
  failed transaction had correctly evicted. It now uses a real single-connection
  pool, checks healthy reuse and baseline settings, observes settings after
  acknowledged rollback before closure, verifies rejection on the evicted
  client, and checks replacement connection settings and signup recovery. The
  assertions were not skipped or weakened.

## Review outcome and public-launch limitations

The final read-only implementation review found no new P0/P1/P2 development
merge blockers and considered F1/F2 resolved. Development-only Draft PR #6 is
ready for preparation; this is not public-launch approval or proof of a passing
remote CI run. CI is configured to run workspace checks, PostgreSQL repository
integration, dedicated Redis integration, and the combined E2E suite; the signup
PostgreSQL integration suite is included in workspace tests when its test URL is
provided. Candidate PR CI still needs to run and pass.

`SIGNUP_ENABLED=false` remains the configuration default in
`packages/config/src/env.ts`. No signup activation is part of this change; the
ephemeral E2E app uses synthetic test settings. No actual .env contents were read
or modified for this documentation update.

Remaining limitations before public launch:

- Redis leases do not atomically fence PostgreSQL commits. Lease loss after the
  final assertion and before COMMIT can still race a commit; an expired Redis
  lease cannot guarantee retention of distributed capacity.
- Local transport closure prevents further sends on that socket but does not
  prove server-side rollback. A lost COMMIT acknowledgement leaves the durable
  outcome uncertain and may omit the success audit for a committed write.
  Exactly-once behavior, reconciliation, and idempotency remain to be defined;
  no automatic COMMIT retry is introduced.
- Cleanup budgets do not bound arbitrary application work that never settles,
  password hashing, or pool checkout/setup before server limits activate.
- Additional combined E2E coverage remains for HTTP client disconnect,
  pre-write lease loss, and real Redis connection failure during DB work/cleanup.
  Real network-partition/lost-COMMIT-ack behavior and successful-commit audit
  exactly-once assertions also remain outside the verified combined coverage.
- Production least-privilege roles, capacity tuning, and cleanup after abruptly
  terminated test processes remain separate work. Test writes are confined to
  UUID-owned databases created through localhost:5432/authcore_test and UUID-owned
  Redis keys on 127.0.0.1:6380, with no development database fallback or FLUSH.

The final review independently checked the diff and all untracked deliverables,
`git diff --check main`, Prettier formatting for all 15 proposed files, and LF
line endings. Those checks passed; they are separate from the user-run runtime
results above. No staging, commit, push, PR creation, merge, or deployment is
authorized by this record.

---

# PR #6 security review fixes — 2026-10-09

This follow-up fixes F1/F2 without changing signup defaults, admission policy,
dependencies, migrations, containers, or environment files. All pre-existing
uncommitted files are retained. The validation reports in the older sections below
are historical; they do not validate this revised transaction helper.

## Error precedence

The helper records unsolicited PostgreSQL server errors separately from generic
socket errors. Server errors carry SQLSTATE and severity metadata; severity text
is not compared with an English literal because pg exposes localized severity.
At the operation catch boundary, an already-observed server fatal error takes
precedence over a later dead-query or lease-assertion rejection. Otherwise the
exact application, BEGIN/setup, or COMMIT rejection is preserved, including an
undefined rejection. This selection is frozen before cleanup: ROLLBACK, end,
socket, and release failures cannot displace the primary operation failure.

## Bounded transport settlement

Terminal pg `end` and transport `close` listeners are installed before BEGIN so
termination while application work is paused is remembered. The helper still
awaits the actual work callback. On failure, rollback has a 1s cleanup budget:
expiry destroys the actual socket and pg's rollback promise is still awaited.
Transport shutdown then has a separate 1s budget. It waits for end/close; if
graceful shutdown stalls, it destroys the actual transport before settling.
Only then is the connection released once with eviction. A successful connection
is released normally for reuse. Failed connections never return to the idle pool.

`SignupAdmission.run` already awaits the transaction promise, so no admission
implementation change is needed. Deterministic tests verify that all four local
slots and Redis release operations stay held during delayed cleanup, that an
error event alone does not release them, and that both normal termination and
forced socket closure permit recovery.

Local close/destruction means the API cannot send further work on that socket.
It does not prove the server transaction outcome, especially after a lost COMMIT
acknowledgement or a network partition. There is no automatic COMMIT retry or
Promise.race-only response timeout. Arbitrary application work that never settles
remains outside these cleanup budgets.

## Regression coverage and execution boundary

New DB unit regressions cover fatal SQLSTATE precedence, subsequent dead queries,
localized server metadata, original application/SQLSTATE errors, BEGIN/COMMIT
failures, delayed end, rollback/end/release failures, forced teardown, stalled
rollback, already-ended clients, and real pg-pool eviction/replacement with a
deterministic in-memory transport. New API regressions use the actual admission
and ALS path to verify idle SQLSTATE over a throwing lease assertion and capacity
retention through delayed or forced cleanup.

Two additional real PostgreSQL regressions resume after idle expiry with either
another query or the actual ALS lease assertion, then check exact 25P03, both-row
rollback, backend disappearance, and retry. TEST_DATABASE_URL is unavailable in
this fix session. These real PostgreSQL tests and combined HTTP/Redis/PostgreSQL
E2E are therefore not executed; no credentials are requested or taken from .env.
Client disconnect, pre-write lease loss, and Redis-failure combined E2E additions
remain follow-up work. The existing combined E2E suite is preserved.

Final checks performed in this fix session:

- Targeted transaction unit tests: 18 passed, 0 failed, 0 skipped.
- Targeted admission/ALS regressions: 3 passed, 0 failed, 0 skipped.
- Real Redis integration at 127.0.0.1:6380: 28 passed, 0 failed, 0 skipped.
- Workspace build, lint, and typecheck: passed.
- Final default workspace test run: 145 passed, 0 failed, 15 skipped (API 93
  passed/15 skipped; DB unit 23, config 24, crypto 5 passed). All 15 skips are
  PostgreSQL signup tests gated by the unavailable TEST_DATABASE_URL.
- An earlier workspace run failed one unchanged health startup hook at 10s:
  143 tests passed and 17 skipped, including two health tests skipped by that
  failed hook. The isolated health rerun passed 2/2; the subsequent default
  workspace rerun passed without timeout or configuration changes.
- The initial four regression cases failed against the original helper, then
  passed after the fix. Two additional generic-error-precedence regressions also
  failed before their fix. Initial lint errors were corrected before final checks.

Draft review can proceed with these deterministic results and the explicit live
PostgreSQL/E2E verification gap. Merge readiness still requires those dedicated
service runs and CI. No commit, push, PR creation, merge, or deployment occurred.

---

# AUTH-001: signup database hardening — current continuation

The first-slice notes below are historical. This continuation supersedes their
deferred transaction/idle limits, Drizzle transaction ownership, and unverified
combined E2E status. Existing local changes were preserved. No .env, container,
commit, push, merge, deployment, or permanent application migration was changed.
The actual configuration still has `SIGNUP_ENABLED=false`; the ephemeral HTTP
test app alone takes an enabled startup snapshot from synthetic test settings.

## Verified PostgreSQL test isolation

Read-only verification on 2026-10-09 returned PostgreSQL 17.11, database
`authcore_test`, current schema `public`, and zero non-system tables.
All three real PostgreSQL harnesses require an explicit TEST_DATABASE_URL with
database exactly `authcore_test`, loopback host, port 5432 (or its default), and
no query options or fragment. There is no fallback to DATABASE_URL. Each harness
asserts the server-reported control database name before creating anything and
asserts the generated database name before applying SQL. Previously the repository
harness had no URL allowlist; it now rejects development/nonlocal targets too.

`authcore_test` is the control connection, not the database containing test rows:

| Harness                    | Owned database         | Schema/migration behavior                                                                                                     |
| -------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| DB repository integration  | `identity_test_<UUID>` | Drizzle migrator reads the checked-in journal/SQL; creates `drizzle.__drizzle_migrations` and application tables in `public`. |
| Signup service integration | `signup_test_<UUID>`   | Applies sorted checked-in SQL directly; application tables in `public`, no migration journal table.                           |
| HTTP E2E                   | `signup_e2e_<UUID>`    | Applies the same sorted SQL directly; no migration journal table.                                                             |

CREATE DATABASE supplies the normal `public` schema through its template. The
existing credential migration explicitly references `public.users`, which is why
isolating only search_path would be insufficient. No harness migrates `authcore`
or `authcore_test`. Each beforeEach deletes users only inside its owned database;
the existing ON DELETE CASCADE foreign key deletes password credentials. Test-only
constraints, triggers, and functions are cleaned up in finally blocks. afterAll
closes the owned pool, drops precisely its generated database, then closes the
control pool. Consequently no application tables should persist in authcore_test.
Abrupt process termination can bypass afterAll and leave a generated database;
the harness never deletes databases from another run.

## Transaction ownership and limits

Signup still hashes before checkout and checks its ALS lease around setup/writes.
All limits use transaction-local set_config(..., true), before any writes:

| PostgreSQL setting                  | Value | Effect                                                                  |
| ----------------------------------- | ----- | ----------------------------------------------------------------------- |
| lock_timeout                        | 1s    | Cancel a blocked lock acquisition.                                      |
| statement_timeout                   | 5s    | Cancel a slow individual statement.                                     |
| idle_in_transaction_session_timeout | 3s    | Terminate a session paused between statements.                          |
| transaction_timeout                 | 15s   | Terminate an overlong transaction, including repeated short statements. |

PostgreSQL 17+ is required; unsupported timeout setup fails before inserts.
The 15s total bound is longer than both statement/idle limits so each remains
effective. It is shorter than the 30s admission lease, but does not fence commits.
These are development budgets, not measured production tuning.
Reference: https://www.postgresql.org/docs/17/runtime-config-client.html

Installed Drizzle puts BEGIN outside its cleanup try/finally and can replace an
operation error with a failed ROLLBACK. `runSignupTransaction` therefore owns the
checked-out pg connection and BEGIN/COMMIT/ROLLBACK explicitly, while passing a
single connection-bound Drizzle interface to both repositories. It handles pg's
unsolicited idle-expiry error, preserves the first session-fatal reason, awaits
work/rollback settlement, and releases exactly once. Every failed transaction is
conservatively evicted, including failed BEGIN, failed cleanup, or uncertain COMMIT.
Successful connections are reused with their baseline settings restored. Evicting
ordinary failures/duplicates adds connection churn; no automatic retry is added.

Database errors retain sanitized HTTP 500 behavior. Lease loss remains sanitized
503 with Retry-After: 1. Audit success is emitted only after acknowledged commit.

## Regression and E2E evidence

PostgreSQL regressions require exact termination SQLSTATE 25P03 / 25P04, roll back
both user and credential rows, verify the old backend disappears, and successfully
retry signup. They also cover the existing 55P03 lock and 57014 statement bounds,
transaction-local settings reset, injected BEGIN/COMMIT/ROLLBACK transport failures,
and an actual deferred foreign-key COMMIT rejection. Transport fault injection is
explicitly distinguished from actual server rejection.

The separate `pnpm --filter @authcore/api test:e2e` suite uses actual loopback Nest
HTTP, Argon2id hashing, repositories, PostgreSQL, RedisService, and Redis Lua scripts.
It namespaces every Redis rate-limit/admission key under a per-test UUID hash tag
and deletes only recorded owned keys. No FLUSH or port 6379 access occurs. Only
renewal scheduling is accelerated to 25ms; lease clocks, expiry validation, SQL,
Redis replies, and HTTP sockets remain real. Test barriers pause after actual
user/credential inserts. Assertions cover ALS propagation, exact sanitized 503,
rollback before release (including pg_stat_activity), replacement-owner safety,
four local slots held through lease loss, retry, and sanitized real DB failure.
The existing real Redis suite separately exercises production-duration renewal.
CI now invokes E2E after its existing integration steps without changing services.

## Remaining boundaries

- Redis leases still provide no atomic PostgreSQL fencing: loss after the last
  assertion and before COMMIT, failover, or arbitrary pauses can race a commit.
- Lost COMMIT acknowledgement has an uncertain durable outcome. Eviction is safe
  pool hygiene, not proof of rollback or exactly-once signup.
- Server limits cannot bound hashing, checkout/setup before limits activate,
  network partitions, or application work that never settles. Admission retains
  local capacity until work settles; no Promise.race releases it early.
- A CREATEDB test role is required. Production least-privilege, crash cleanup,
  load tuning, and deployment are outside this change.

Final local validation on 2026-10-09 (no skipped tests in the successful runs):

- `pnpm build`, `pnpm lint`, `pnpm typecheck`: passed for the workspace.
- `pnpm test` with explicit dedicated test URLs: 137 passed (API 103, config 24,
  crypto 5, DB unit 5). Packages without test files used their existing
  passWithNoTests behavior. API includes 13 real PostgreSQL regressions.
- Final focused signup PostgreSQL rerun after strengthening both-row rollback
  assertions: 13/13 passed, exact SQLSTATE 25P03 / 25P04 verified.
- `pnpm --filter @authcore/db test:integration`: 14/14 passed.
- `pnpm --filter @authcore/api test:redis`: 28/28 passed.
- `pnpm --filter @authcore/api test:e2e`: 4/4 passed.
- `git diff --check`: passed. Control DB remained public with zero non-system
  tables; read-only catalog check found no generated UUID test databases left.

An initial concurrent check run exposed overwritten idle-expiry SQLSTATE (fixed
by preserving the first pg client error) and an existing health HTTP startup hook
timeout under contention. The subsequent workspace test run passed 103/103 API
tests without increasing timeout budgets. Initial lint also found an unused test
import, which was removed; the final full lint passed. Real network-partition and
lost-COMMIT-ack behavior was not reproduced; transport failure tests inject errors
at explicit boundaries. Local tests do not establish remote CI success.

---

# Historical first-slice notes (superseded above)

Development only. Base: `ee0a937bc61beb2a10a350f59c8c41e208205272` (PR #5).
Branch: `feat/signup-db-timeouts-e2e`. Signup remains disabled in configuration
and the existing root .env. No environment file, container, deployment, or remote
Git mutation is part of this slice.

## Implementation and boundaries

`SignupService` still hashes before borrowing a DB connection, then owns one
Drizzle transaction shared by UserRepository and PasswordCredentialRepository.
Before either insert, `setSignupTransactionTimeouts(tx)` uses PostgreSQL
`set_config(..., true)` to set transaction-local `lock_timeout=1000ms` and
`statement_timeout=5000ms`. Configuration failure aborts signup before writes.
The lease is checked before and after timeout configuration and after each insert.

PostgreSQL cancels blocked/slow statements itself. There is no Promise.race or
response-only deadline. Errors leave the transaction callback and Drizzle awaits
ROLLBACK before rejecting. SignupAdmission still awaits actual work settlement
before Redis release and local capacity recovery. Database timeout errors retain
the existing sanitized HTTP 500 behavior; lease loss remains HTTP 503 with
Retry-After: 1. Successful and duplicate signup behavior remains unchanged.

These are per-statement/per-lock bounds, NOT a total transaction or request
execution deadline. They do not bound hashing, a network partition, setup before
timeouts become active, or arbitrary application pauses. PostgreSQL 17
transaction_timeout and idle_in_transaction_session_timeout terminate the session;
adding them is deferred until real PostgreSQL tests establish safe Drizzle/pg
cleanup and pool recovery (including failures during BEGIN/COMMIT/ROLLBACK).
No pool/driver ownership rewrite is justified for this first slice.

Source: https://www.postgresql.org/docs/17/runtime-config-client.html
Installed Drizzle node-postgres session code was inspected: it awaits rollback in
its catch path and releases the borrowed connection in finally. Admission's
AsyncLocalStorage assertion and Nest/RxJS interceptor path were inspected too.

## Regression coverage

- Service tests: lease loss during timeout setup stops writes; configuration
  failure stops writes; admission release waits for simulated rollback settlement.
- Real Nest HTTP / mocked Redis and signup: renewal loss crosses the actual
  asynchronous request context, produces sanitized 503/Retry-After, then permits
  a subsequent request. This is not a combined real-DB/real-Redis E2E test.
- Opt-in real PostgreSQL tests: exclusive lock on password_credentials causes
  SQLSTATE 55P03, rolls back the already-inserted user, releases admission after
  rollback, and permits the same email on retry. A test-only pg_sleep trigger
  causes SQLSTATE 57014 and rolls back both records. A pinned connection verifies
  local timeout settings reset after commit and rollback. Admission's Redis
  commands in this PostgreSQL suite are mocked; real Redis is verified separately.

The PostgreSQL suite accepts only explicit TEST_DATABASE_URL pointing at a
loopback `*_test` database with no URL options and no fallback to DATABASE_URL.
It creates a UUID-named database, applies checked-in migrations there, and deletes
or alters only that owned database's objects. The test role needs CREATEDB and
permission to drop its own generated database. No shared application data is
mutated. Do not run against development/production credentials or databases.

Safe commands once a dedicated test URL has been supplied through the process
environment (never paste credentials into logs):

```powershell
pnpm --filter @authcore/api exec vitest run src/identity/signup.service.integration.test.ts
pnpm --filter @authcore/db test:integration
$env:TEST_REDIS_URL = 'redis://127.0.0.1:6380'
pnpm --filter @authcore/api test:redis
```

The Redis suite validates that exact URL before connecting, uses UUID test keys,
and removes only its own keys. No host port 6379, flush, or container changes.

## Verification on 2026-10-09

Live GitHub CI run 37887533307 / attempt 1 / main exact base commit above:
completed / success. Verify job 113680779402: Lint, Build, Type check, Test,
PostgreSQL integration tests, Redis integration tests all completed / success.
https://github.com/ryukkfk/authcore/actions/runs/37887533307

Local validation results are recorded below after completion. TEST_DATABASE_URL
was absent; real PostgreSQL checks are blocked, not counted as passed. Real Redis
6380 was reachable; TEST_REDIS_URL is supplied only to the test process.

## Next slice and remaining gaps

Supply a dedicated TEST_DATABASE_URL and run the new PostgreSQL suite plus the
repository suite before approving a commit. Then assess PostgreSQL 17 total
transaction/idle-session bounds with explicit connection termination/pool recovery
coverage. Combined real PostgreSQL + Redis + Nest HTTP lease-loss E2E remains
unverified. Renewable Redis leases still do not fence PostgreSQL commits through
arbitrary pauses/failover; native timeouts do not change that invariant. Timeout
values are initial development limits, not production capacity evidence.

Local results:

- `pnpm lint`: passed; final API test edits were rechecked with API lint.
- `pnpm build`: passed for the workspace.
- `pnpm typecheck`: passed for the workspace.
- `pnpm test`: passed (124 tests: config 24, crypto 5, db 5, API 90).
  Seven API PostgreSQL tests were skipped because TEST_DATABASE_URL was missing.
  Packages without tests exited successfully via the existing passWithNoTests flag.
- `TEST_REDIS_URL=redis://127.0.0.1:6380 pnpm --filter @authcore/api test:redis`:
  28 passed across two files, using the already running isolated Redis instance.
- Initial focused signup/HTTP run: 46 passed, seven PostgreSQL tests skipped;
  an additional timeout-configuration regression was subsequently added and passed
  in the final workspace run. The initial TypeScript pool-connect mock overload
  error was corrected; subsequent type checks passed.
- `git diff --check`: passed. HEAD, main and origin/main all still match the base
  merge commit; changes are local and uncommitted on the feature branch.

No real PostgreSQL execution result is claimed. No combined real PostgreSQL/Redis
HTTP E2E result is claimed. Root .env was read only to verify SIGNUP_ENABLED=false;
its other contents were not output. No commit, push, PR, merge, deploy, signup
activation, container changes, or .env edits were performed.

Final focused signup/HTTP rerun after all test edits: 47 passed, seven PostgreSQL tests skipped (two files passed, one skipped). Final API lint and typecheck passed.
