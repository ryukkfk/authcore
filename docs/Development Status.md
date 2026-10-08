# AuthCore Development Status

Last updated: 2026-10-08 (Asia/Rangoon)

Branch at the latest implementation checkpoint: `feat/signup-foundation`.
Transactional signup foundation checkpoint `45cf26a` is committed and pushed.
The signup HTTP boundary is implemented and locally verified; endpoint edits remain uncommitted.

## Current milestone

**Phase 2 — Identity and Password Credentials: signup HTTP boundary implemented.**

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
- Public `POST /api/v1/auth/signup` calls `SignupService` through `SignupDto`. Email is
  trimmed and validated as an email string with a maximum length of 254 characters.
- Passwords must be strings of 12–128 characters; exact whitespace is retained. Validation
  runs before hashing, with no implicit type conversion and unexpected fields rejected.
- Success and duplicate email both return HTTP 202 with only `{"status":"accepted"}`.
  Invalid inputs/unexpected fields return 400; unexpected failures reach the global filter
  and return a safe 500 `INTERNAL_SERVER_ERROR` without sensitive internal details.
- Coverage adds 3 controller unit tests and 7 HTTP integration tests. The HTTP suite uses
  a mocked signup service; the 4 separate signup PostgreSQL tests cover persistence.

Implementation details: [[Identity Foundation]].

## Latest verification checkpoint — 2026-10-08

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

The foundation checkpoint recorded 73 pre-existing whole-repository formatting findings.
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
  [[Security Requirements#SR-003 — Password Input Limits]]. The 7 HTTP tests cover a short
  password but do not explicitly test the 128-character maximum or overlong rejection;
  do not infer that all CRYPTO-001 acceptance criteria are verified.
- The current identity schema stores email on `users`; a separate `user_emails` table from
  the original roadmap is not implemented.
- Local checks passed; remote CI status remains unverified. Production deployment is not ready.

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
