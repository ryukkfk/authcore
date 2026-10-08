# AuthCore Development Status

Last updated: 2026-10-08 (Asia/Rangoon)

Branch at the latest implementation checkpoint: `feat/signup-foundation`.
Signup foundation is implemented and locally verified; changes are awaiting review and commit.

## Current milestone

**Phase 2 — Identity and Password Credentials: transactional signup foundation.**

The next implementation step is the signup HTTP boundary under [[Roadmap#AUTH-001 — Registration]].
The registration flow is still incomplete until its HTTP validation, response/error contract,
registration policy, rate limits, and verification-event behavior are implemented and tested.

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
- `IdentityModule` provides and exports `SignupService`; Nest DI behavior is covered by a regression test.

Implementation details: [[Identity Foundation]].

## Latest verification checkpoint — 2026-10-08

These are results from the completed implementation run, not a fresh test run performed
while updating these notes.

| Check                                         | Result                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------- |
| `pnpm build`                                  | Passed across all nine workspace apps/packages                            |
| `pnpm typecheck`                              | Passed across all nine workspace apps/packages                            |
| `pnpm lint`                                   | Passed across all nine workspace apps/packages                            |
| `pnpm test`                                   | 42 passed: config 9, crypto 5, db unit 5, API 23                          |
| `pnpm --filter @authcore/db test:integration` | 14 PostgreSQL tests passed                                                |
| API tests included above                      | 8 signup unit + 4 signup PostgreSQL integration tests; 23 API tests total |
| Targeted formatting and `git diff --check`    | Passed                                                                    |

**56 distinct tests passed.** PostgreSQL tests were enabled and ran against isolated
randomly named databases. The API test total is already included in the workspace count.

The sandbox required a stable ignored temporary directory for the final test run.
The initial API temporary-file loading errors were resolved before the successful rerun.
Whole-repository formatting still reported 73 pre-existing files; broad formatting cleanup
was outside the signup implementation scope. The required workspace lint check passed.

## Remaining work and boundaries

- Add the signup controller and validated request/response DTOs. Enforce explicit password
  input limits before invoking Argon2id, as required by [[Security Requirements#SR-003 — Password Input Limits]].
- Define the public duplicate-email/error contract, endpoint authentication requirement,
  registration policy, and rate-limit category; test HTTP success and failure responses.
- Define and implement verification-event behavior before considering full registration complete.
- The post-commit `identity.user_created` log is an audit signal. Durable audit storage and
  transactional outbox delivery remain future work.
- Password hashing/verification primitives are present; password input-limit enforcement
  is still pending at the HTTP boundary. Do not mark all CRYPTO-001 acceptance criteria complete.
- The current identity schema stores email on `users`; a separate `user_emails` table from
  the original roadmap is not implemented.
- Local checks passed; remote CI status and production readiness are not established by this checkpoint.

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
