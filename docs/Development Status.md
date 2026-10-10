# AuthCore Development Status

Last updated: 2026-10-10 (Asia/Rangoon)

Current branch: `feat/signup-transactional-audit`, based on `main` at
`3c75b430562faef1922b9428069c42925566bb12`. Current user-run local evidence is
recorded below; earlier foundation, hardening and abuse-control records are historical.
Draft PR #4 recorded the signup foundation and HTTP endpoint at baseline `b1b8a9a`.
Transactional audit changes remain uncommitted; no push or merge was performed in this slice.
See [[Security Defaults]] for the disabled signup policy and manual runtime checks.

## Current milestone

**Phase 2 — Identity and Password Credentials: signup HTTP boundary disabled by default.**

[[Roadmap#AUTH-001 — Registration]] remains in progress. Signup rate limiting and
admission abuse controls are now implemented locally and disabled by default.
The first durable signup audit slice now writes user, credential and audit rows
atomically. Next work includes registration policy, verification events,
timing-resistant account-enumeration protection and the audit/COMMIT limitations below.
Full registration is incomplete; production deployment is not ready.

## Current user-run local verification — 2026-10-10

The user reported these local results before the P3 documentation and formatting
cleanup. They are not CI results or independent reviewer reruns. Earlier test
counts and inventories below describe their dated historical checkpoints.

| Check                                  | User-reported local result      |
| -------------------------------------- | ------------------------------- |
| Workspace tests                        | 168 passed, 0 failed, 0 skipped |
| PostgreSQL signup integration          | 17/17 passed                    |
| DB repository integration              | 25/25 passed                    |
| Dedicated Redis integration            | 28/28 passed                    |
| Combined HTTP + Redis + PostgreSQL E2E | 7/7 passed                      |
| Workspace lint, typecheck and build    | PASS                            |

The focused signup PostgreSQL rerun is already represented in workspace tests
when TEST_DATABASE_URL is supplied and must not be added again as distinct tests.
Candidate PR CI remains to be run against the submitted revision. Public signup
remains disabled (`SIGNUP_ENABLED=false`). No human security approval is claimed.
See [Signup transactional security audit](../apps/api/SIGNUP_TRANSACTIONAL_AUDIT.md)
for transaction guarantees, migration details and isolated verification commands.

The subsequent P3 cleanup separately passed changed-file formatting, whitespace,
migration consistency, workspace lint and typecheck checks. Its workspace test
run passed 151 tests, failed 0 and skipped the 17 PostgreSQL signup cases because
TEST_DATABASE_URL was deliberately unset. PostgreSQL repository, dedicated Redis
and combined E2E suites were not rerun during cleanup. This does not replace the
user's earlier zero-skip checkpoint. See the audit note for cleanup details.

Database-enforced append-only protection is not implemented: SQL roles with the
required privileges can update/delete audit rows. Audit retention and account
deletion policy are not finalized. Redis lease/COMMIT fencing and uncertain
COMMIT reconciliation remain unresolved. Development-only Draft PR preparation
does not authorize public signup enablement.

## Implemented foundation

- NestJS API bootstrap, liveness/readiness endpoints, validated environment configuration,
  global validation pipe, and safe global exception filter are present.
- PostgreSQL client, Drizzle migration workflow, `users`, `password_credentials` and
  `security_audit_events` schemas,
  and transaction access through `DatabaseService` are present.
- `UserRepository` supports exact normalized-email lookup and atomic duplicate-email handling.
- `@authcore/crypto` provides centrally configured Argon2id hashing and password verification.
- `PasswordCredentialRepository` accepts a borrowed database/transaction and persists only
  `userId` and the encoded `passwordHash`; lookup returns a credential or null.
- `SignupService` normalizes email, hashes the exact password before opening a transaction,
  and inserts user, credential and audit in one transaction shared by all three repositories.
- Duplicate email maps to `EmailAlreadyInUseError`; credential or audit insertion failure
  rolls back all related writes. Plaintext passwords are neither persisted nor logged.
- `IdentityModule` provides and exports `SignupService` and registers `AuthController`;
  Nest DI behavior is covered by a regression test.
- Explicitly enabled `POST /api/v1/auth/signup` calls `SignupService` through `SignupDto`. Email is
  trimmed and validated as an email string with a maximum length of 254 characters.
- Passwords must be strings of 12–128 characters; exact whitespace is retained. Validation
  runs before hashing, with no implicit type conversion and unexpected fields rejected.
- With signup enabled, success and duplicate email both return HTTP 202 with only `{"status":"accepted"}`.
  Invalid inputs/unexpected fields return 400; unexpected failures reach the global filter
  and return a safe 500 `INTERNAL_SERVER_ERROR` without sensitive internal details.
- Coverage includes 3 controller unit tests and 18 signup HTTP integration cases.
  Enabled-route cases mock signup; disabled-route cases wire the real service with
  hashing/transaction spies to prove no work occurs. The historical foundation had
  four signup PostgreSQL tests; the current suite has 17 cases.

Implementation details: [[Identity Foundation]].

## Historical implementation verification checkpoint — 2026-10-08

These are the user's recorded implementation-run results, checked against the supplied
conversation outputs. No application tests were rerun while updating these notes.

| Check                                         | Recorded result                                                                                             |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `pnpm build`                                  | Successful across all nine workspace apps/packages                                                          |
| `pnpm typecheck`                              | Successful across all nine workspace apps/packages                                                          |
| `pnpm lint`                                   | Successful across all nine workspace apps/packages                                                          |
| `pnpm test`                                   | API 33/33 and DB unit 5/5 visible in the latest workspace output                                            |
| API test breakdown                            | 3 controller unit + 7 signup HTTP + 8 signup unit + 4 signup PostgreSQL + 11 existing identity/health tests |
| `pnpm --filter @authcore/db test:integration` | 14/14 PostgreSQL integration tests passed, no skips                                                         |
| API PostgreSQL verification                   | Separate API output confirms all 33/33, including 4/4 signup PostgreSQL tests, no skips                     |

**Expected totals: 52 workspace tests and 66 distinct tests including separate DB integration.**
These totals are inferred from the earlier config 9 + crypto 5, plus the latest DB unit 5
and API 33, then DB integration 14. The latest pasted workspace output omits the config/crypto
completion summaries, so 52/66 are not independently confirmed totals for that run.
The API's 4 PostgreSQL tests are already included in 33; separate reruns are not added again.
The earlier API run with 4 skips was superseded by the recorded 33/33 run with no skips.

The historical foundation checkpoint recorded 73 pre-existing whole-repository formatting findings.
That historical result is not a fresh formatting check of the HTTP endpoint; broad cleanup
remains outside this documentation update.

## Remaining work and boundaries

- Define and implement registration policy and verification-event creation/delivery.
- Signup rate limiting and admission are locally implemented and verified; public
  enablement still requires capacity, lease/failover and operational validation.
- Implement and test timing-resistant account-enumeration protection. Equal response status/body
  alone does not establish timing resistance.
- The post-commit `identity.user_created` log is operational; transactional
  `security_audit_events` storage now exists. Database-enforced append-only protection,
  finalized retention/account deletion policy and transactional outbox delivery remain pending.
- Redis lease/COMMIT fencing and uncertain COMMIT reconciliation remain unresolved.
- Signup now enforces password input limits before hashing, as required by
  [[Security Requirements#SR-003 — Password Input Limits]]. Current HTTP regression tests cover 12/128-character acceptance, 11/129-character
  rejection and non-string input. Do not infer that all CRYPTO-001 acceptance criteria are verified.
- The current identity schema stores email on `users`; a separate `user_emails` table from
  the original roadmap is not implemented.
- Baseline PR CI run #8 succeeded at `b1b8a9a`; it does not validate the uncommitted hardening.
  Production deployment is not ready.

## Ticket naming

The conversation and implementation checkpoint called this work **API-004 — signup foundation**.
The original [[Roadmap#API-004 — Global Error Handling]] uses API-004 for a different task.
Preserve the original roadmap ID and refer to this checkpoint by its title, **transactional
signup foundation**, under AUTH-001. Do not infer that another roadmap ticket is complete
from the conversation's API-004 label.

## Related notes

- [[Project Overview]]
- [[Roadmap]]
- [[Identity Foundation]]
- [[Architecture]]
- [[Security Requirements]]
- [[Threat Model]]

## Historical development hardening — 2026-10-08

- API default/example host and Compose PostgreSQL/Redis bindings use IPv4 loopback.
- Strict SIGNUP_ENABLED defaults to false in every environment; the startup guard
  rejects the disabled route with consistent 403 before validation, hashing or writes.
- Unexpected-error logs exclude query strings, URLs, request bodies and raw exceptions.
- Regression tests cover default/false/enabled behavior, strict environment parsing,
  password boundaries/types and sensitive-query logging. Existing signup behavior
  remains covered when explicitly enabled.
- Actual .env values, running containers, named volumes and firewall rules are unchanged.
- Baseline remote CI is historical evidence only; this working tree has not been pushed.

### Verified final local checks

Executed against this hardening working tree on 2026-10-08 (Asia/Rangoon):

| Command                                     | Result                                                   |
| ------------------------------------------- | -------------------------------------------------------- |
| pnpm build                                  | Passed                                                   |
| pnpm typecheck                              | Passed                                                   |
| pnpm lint                                   | Passed                                                   |
| pnpm test                                   | Passed: config 24, crypto 5, DB unit 5, API 44; total 78 |
| pnpm --filter @authcore/db test:integration | Passed: 14 PostgreSQL tests                              |

All 92 distinct tests passed, with no skips in these suites. The API's 44 tests
include its 4 PostgreSQL signup tests. Packages with no test files are not counted.
TEST_DATABASE_URL was supplied privately for the existing local PostgreSQL container's
administrative database, never taken from the application .env. The suites created
and removed only their own random test databases. Database inventory before/after
matched. No container recreation, volume deletion, firewall change, commit, push
or merge was performed.

At this historical 2026-10-08 checkpoint, resolved Compose configuration showed
loopback-only desired mappings, while docker ps still showed wildcard bindings.
Read-only verification on 2026-10-09 confirms the current PostgreSQL, development
Redis and dedicated test Redis published ports bind only to `127.0.0.1` (5432,
6379 and 6380 respectively). No containers were changed during this verification.
Existing environment overrides and actual API listeners still require private/manual
verification; source defaults do not rewrite .env.

## Historical signup abuse-control security follow-up — 2026-10-09

Branch: `feat/signup-abuse-controls`. Both outstanding findings are addressed
locally: P1 Redis handshake/post-send reply deadlines now tear down the affected
connection and reject pending operations; P2 CI has an isolated Redis 7 service
bound to `127.0.0.1:6380`, health checks, explicit `TEST_REDIS_URL`, and the opted-in
Redis integration step. Existing PostgreSQL and workspace steps remain intact.
No fallback to development Redis and no database flush commands were introduced.

The installed Redis/client version inspected is 5.12.1. Its queue timeout is
removed at send, and transport `connectTimeout` does not cover handshake replies.
The fix uses a bounded command facade and fresh client generations, a three-second
TCP/TLS timeout plus separate three-second handshake deadline, one-second command
reply deadlines, queue cap 128 and one-second demand-driven connection cooldown.
No ambiguous consume/acquire is automatically retried. Ownership-safe release,
local admission capacity and fail-closed HTTP behavior are preserved.

### Final local verification

All commands exited 0 against the final code. PowerShell used `pnpm.cmd` because
script execution policy blocks the `.ps1` shim; no policy was changed.

| Command                                       | Result                                                       |
| --------------------------------------------- | ------------------------------------------------------------ |
| `pnpm typecheck`                              | Passed across all nine workspace apps/packages               |
| `pnpm lint`                                   | Passed across all nine workspace apps/packages               |
| `pnpm build`                                  | Passed across all nine workspace apps/packages               |
| `pnpm test`                                   | 124 passed: config 24, crypto 5, DB unit 5, API 90; no skips |
| `pnpm --filter @authcore/db test:integration` | 14 PostgreSQL tests passed; no skips                         |
| `pnpm --filter @authcore/api test:redis`      | 28 isolated real Redis tests passed; no skips                |
| `git diff --check`                            | Passed                                                       |

**166 distinct tests passed.** API's four PostgreSQL signup tests are included in
its 90 and are not counted again. Packages with no test files are not counted.
Three deterministic real-TCP/client deadline tests cover handshake stalls, sent
command stalls, peer-side teardown, pending rejection, no replay, cooldown,
recovery, stale deadlines and shutdown. The original outage-pressure unit test
remains. The two new real Redis reply-stall cases additionally prove that the Lua
consume reached Redis before its reply was lost and is never replayed on recovery.
The regression tests failed for the original handshake/post-send defects before
the fix and passed afterward.

Tests used the existing loopback-only Redis 7 test container on port 6380. Database
credentials were obtained privately from the existing PostgreSQL container and
were not printed; tests created and removed their own UUID databases. No actual
`.env`, containers, firewall, security policy or Git remote was modified.
`SIGNUP_ENABLED=false` remains the default and Redis test configuration. No commit,
push, PR creation, merge or deployment occurred.

### Files changed in this follow-up

- `.github/workflows/ci.yml`
- `apps/api/src/redis/redis.service.ts`
- `apps/api/src/redis/redis.service.test.ts`
- `apps/api/src/redis/redis-deadlines.test.ts` (new)
- `apps/api/src/redis/signup-rate-limiter.redis.integration.test.ts`
- `apps/api/REDIS_INTEGRATION_TESTS.md`
- `apps/api/SIGNUP_ADMISSION.md`
- `docs/Development Status.md` (this Obsidian vault note)

### Complete working-tree file inventory

The following 26 files include the preserved pre-existing signup abuse-control
implementation; files absent from the list above were not edited in this follow-up.
Untracked files remain untracked and must be included when a future commit is authorized.

```text
.github/workflows/ci.yml
apps/api/package.json
apps/api/REDIS_INTEGRATION_TESTS.md
apps/api/SIGNUP_ADMISSION.md
apps/api/src/identity/auth.controller.integration.test.ts
apps/api/src/identity/auth.controller.ts
apps/api/src/identity/identity.module.ts
apps/api/src/identity/signup-admission.interceptor.ts
apps/api/src/identity/signup-admission.test.ts
apps/api/src/identity/signup-admission.ts
apps/api/src/identity/signup-rate-limit.guard.test.ts
apps/api/src/identity/signup-rate-limit.guard.ts
apps/api/src/identity/signup-rate-limiter.test.ts
apps/api/src/identity/signup-rate-limiter.ts
apps/api/src/identity/signup.service.test.ts
apps/api/src/identity/signup.service.ts
apps/api/src/redis/redis-deadlines.test.ts
apps/api/src/redis/redis.module.ts
apps/api/src/redis/redis.service.test.ts
apps/api/src/redis/redis.service.ts
apps/api/src/redis/signup-admission.redis.integration.test.ts
apps/api/src/redis/signup-rate-limiter.redis.integration.test.ts
apps/api/vitest.config.ts
apps/api/vitest.redis-integration.config.ts
docs/Development Status.md
pnpm-lock.yaml
```

### Readiness and remaining risks

Ready locally for Draft PR #5 review. Merge readiness still requires a fresh
GitHub CI run and reviewer approval against the submitted revision; the workflow
has not been executed remotely. No production enablement is authorized.

Redis timeouts cannot undo an already-applied write. Ambiguous consumes can charge
an attempt; ambiguous acquires can occupy a slot until ownership-safe cleanup or
TTL. Fail-closed behavior deliberately trades availability for bounded abuse-control
failure. Renewable leases still do not fence in-flight Argon2/PostgreSQL work
through process pauses, partitions, eviction, restart or write-losing failover.
Capacity/GC-margin validation, Redis durability/no-eviction policy, bounded DB
transactions/statements, timing-resistant enumeration protection and durable audit
remain before public signup enablement. These are existing limitations, not claims
of a new hard global execution bound.

Technical details: [signup admission](../apps/api/SIGNUP_ADMISSION.md) and
[isolated Redis testing](../apps/api/REDIS_INTEGRATION_TESTS.md).
