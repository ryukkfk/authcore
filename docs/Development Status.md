# AuthCore Development Status

Last updated: 2026-10-08 (Asia/Rangoon)

Branch at the latest implementation checkpoint: `feat/signup-foundation`.
Draft PR #4 contains the signup foundation and HTTP endpoint at baseline `b1b8a9a`.
Development security hardening is currently an uncommitted working-tree change; no push or merge was performed.
See [[Security Defaults]] for the disabled signup policy and manual runtime checks.

## Current milestone

**Phase 2 — Identity and Password Credentials: signup HTTP boundary disabled by default.**

[[Roadmap#AUTH-001 — Registration]] remains in progress. Next work is registration policy,
verification events, rate limiting and abuse controls, timing-resistant account-enumeration
protection, and durable audit. Full registration is incomplete; production deployment is not ready.

## Implemented foundation

- NestJS API bootstrap, liveness/readiness endpoints, validated environment configuration,
  global validation pipe, and safe global exception filter are present.
- PostgreSQL client, Drizzle migration workflow, `users` and `password_credentials` schemas,
  and transaction access through `DatabaseService` are present.
- `UserRepository` supports exact normalized-email lookup and atomic duplicate-email handling.
- `@authcore/crypto` provides centrally configured Argon2id hashing and password verification.
- `PasswordCredentialRepository` accepts a borrowed database/transaction and persists only
  `userId` and the encoded `passwordHash`; lookup returns a credential or null.
- `SignupService` normalizes email, hashes the exact password before opening a transaction,
  and inserts user plus credential in one transaction shared by both repositories.
- Duplicate email maps to `EmailAlreadyInUseError`; credential insertion failure rolls back
  user creation. Plaintext passwords are neither persisted nor logged.
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
  hashing/transaction spies to prove no work occurs. Four separate signup PostgreSQL
  tests cover persistence.

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
- Add signup rate limiting, its rate-limit category, and abuse controls before production use.
- Implement and test timing-resistant account-enumeration protection. Equal response status/body
  alone does not establish timing resistance.
- The post-commit `identity.user_created` log is an audit signal. Durable audit storage and
  transactional outbox delivery remain future work.
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

## Development hardening — 2026-10-08

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

Resolved Compose configuration confirms loopback-only desired mappings, but docker ps
still shows wildcard bindings on the existing containers. Applying those mappings
requires separate approval. Existing environment overrides and actual API listeners
also require private/manual verification; source defaults do not rewrite .env.
