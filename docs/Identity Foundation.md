# Identity foundation repository

Last updated: 2026-10-08 (Asia/Rangoon)

Status: transactional signup foundation and signup HTTP boundary implemented and locally
verified on `feat/signup-foundation`; Draft PR #4 baseline is `b1b8a9a`.
Development hardening remains uncommitted. AUTH-001 — Registration remains in progress.
The HTTP endpoint is disabled by default; see [[Security Defaults]].
See [[Development Status]] for the verification checkpoint and remaining work.

`@authcore/db` exports `UserRepository`, `DuplicateUserEmailError`, `CreateUserInput`,
and `UserRepositoryDatabase` alongside `PasswordCredentialRepository` and its input/database types.
The existing `users_email_normalized_unique` index enforces uniqueness.

- `new UserRepository(client.db)` uses the existing database client and pool.
- `create({ email, emailNormalized })` returns the persisted user, including
  database-generated UUID and timestamps. Callers cannot set verification,
  disabled status, IDs, or timestamps through this operation.
- `findByNormalizedEmail(emailNormalized)` performs an exact, parameterized
  lookup and returns `User | null`. It includes disabled users; authentication
  policy belongs in the application layer.
- `create` throws `DuplicateUserEmailError` with code `DUPLICATE_EMAIL` when the
  normalized email already exists, including concurrent creates. Its message
  contains no email or database details. Other database errors propagate and
  must not be exposed directly in HTTP responses or logs.

The API identity layer owns validation and `normalizeEmail` (trim and lowercase).
The repository trusts that boundary and never normalizes either input. Dots and
plus tags remain significant. The HTTP contract is implemented by `AuthController`,
separately from persistence, as described below.

For an atomic application operation, use `client.db.transaction(async (tx) => …)`
and construct `new UserRepository(tx)` inside the callback. The caller controls
commit/rollback. The repository uses targeted `ON CONFLICT DO NOTHING RETURNING`
instead of a pre-insert lookup, so a handled duplicate does not abort the
transaction. Pool shutdown remains the database client's responsibility.

## Transactional signup foundation

`IdentityModule` exports `SignupService.signup({ email, password })`. This internal
application operation receives validated input from the signup HTTP boundary;
`IdentityService.createUser` remains unchanged.

The service trims/normalizes email and uses `@authcore/crypto.hashPassword` before
opening a transaction. It constructs both repositories with the same transaction,
inserts the user and its credential, and returns only the user after commit. Any
credential insert failure rolls back the user. `DuplicateUserEmailError` maps to
the existing `EmailAlreadyInUseError`; unrelated failures propagate.

`PasswordCredentialRepository.create({ userId, passwordHash })` persists only those
fields and returns database defaults. `findByUserId` returns a credential or null.
The repository accepts an encoded hash, never a plaintext-password field. It neither
opens transactions nor closes pools. The existing primary key and foreign key enforce
one credential per user and cascading deletion. No additional migration is required.

Passwords retain their exact whitespace when hashed. Neither input nor errors are
logged by signup. After commit, a structured `identity.user_created` log event contains
only the user ID. This is an audit signal, not a durable transactional audit store.

## Signup HTTP boundary

`IdentityModule` registers `AuthController`, which calls `SignupService` for explicitly enabled
`POST /api/v1/auth/signup` under the application's `api/v1` prefix. No authentication
or authorization requirement is applied to enabled registration; registration policy remains pending.
A separate SignupEnabledGuard denies disabled registration before DTO validation/service execution.

`SignupDto` trims string email input, requires a valid email string, and limits it to
254 characters. Service-level email normalization remains trim and lowercase. Passwords
must be strings of 12–128 characters; whitespace is retained exactly, with no trimming.
The global validation pipe transforms DTOs without implicit type conversion and rejects
unexpected fields before invoking the service or hashing a password.

| Outcome                                    | HTTP response                                                |
| ------------------------------------------ | ------------------------------------------------------------ |
| Disabled signup                            | 403 `HTTP_403` / `Signup is disabled`                        |
| Successful signup                          | 202 `{"status":"accepted"}`                                  |
| Duplicate email (`EmailAlreadyInUseError`) | Identical 202 `{"status":"accepted"}`                        |
| Invalid inputs or unexpected fields        | 400 validation error                                         |
| Unexpected failure                         | 500 with `INTERNAL_SERVER_ERROR` and `Internal server error` |

The controller returns only the generic status, never user or credential data. Unexpected
failures propagate to `GlobalExceptionFilter`, which returns a sanitized response without
raw exceptions, database details, or passwords. Equal status/body for success and duplicate
email does not establish timing-resistant account-enumeration protection.

Three controller unit tests cover success, duplicate email, and unexpected-error propagation.
The original seven HTTP integration tests cover 202 success, identical duplicate responses, invalid email,
short password, unexpected fields, email trim with exact password whitespace, and safe 500
handling. These use a real Nest HTTP server with a mocked `SignupService`; they are separate
from the 4 PostgreSQL signup integration tests. The hardening regression cases additionally test 12/128-character acceptance,
11/129-character rejection, non-string inputs, disabled-route hashing/write prevention
and sensitive-query logging. The flag is explicitly enabled in the existing HTTP suite.

## PostgreSQL integration tests

Set `TEST_DATABASE_URL` to a local/test PostgreSQL database, then run:

```powershell
pnpm --filter @authcore/db test:integration
pnpm --filter @authcore/api test
```

The suites create randomly named `identity_test_*` and `signup_test_*` databases,
apply the checked-in migrations there, and drop only those databases after testing.
The database role needs `CREATEDB` permission. Whole-database isolation is necessary
because the credential migration explicitly references `public.users`.
Existing application tables are not used.
If `TEST_DATABASE_URL` is absent, the suite is explicitly skipped; it never falls
back to `DATABASE_URL`. CI supplies a PostgreSQL 17 service and this variable, so
the repository suite runs there. A configured but unreachable database fails the
suite rather than skipping it.

Coverage includes persisted defaults, exact lookups, SQL-looking input, duplicate
conflicts and concurrency, unrelated database errors and unique constraints,
privileged-field protection, transaction rollback, and continued use of a
transaction after handling a duplicate. Production database builds exclude tests.
Credential coverage adds persisted defaults, ignored extra fields, uniqueness,
foreign keys, cascade deletion, and caller-controlled rollback. Signup coverage adds
real Argon2id verification, concurrent duplicate signup, PostgreSQL credential failure
with user rollback, hashing/commit failure, and password-free audit events.
Focused unit tests also cover missing insert results, credential read/write failures,
secret-bearing dependency errors, and Nest dependency injection without emitted
constructor type metadata (the development runner's behavior).

CI builds workspace packages before typechecking and testing because dependent
packages resolve their public entrypoints from `dist`.

## Next work — registration policy and verification events

[[Roadmap#AUTH-001 — Registration]] remains in progress. Define and implement registration
policy and verification-event creation/delivery. Signup rate limiting and its category,
abuse controls, timing-resistant account-enumeration protection, durable audit storage,
and transactional outbox delivery remain pending. Production deployment is not ready.
API-004 remains [[Roadmap#API-004 — Global Error Handling]]; signup work belongs to AUTH-001.

The historical pre-hardening checkpoint recorded API 33/33 and DB integration 14/14.
The hardening working tree now passes build, typecheck, lint, 78 workspace tests
(config 24, crypto 5, DB unit 5, API 44) and 14 separate DB integration tests: 92
distinct tests, no skips. API 44 includes the 4 PostgreSQL signup tests. See
[[Development Status]] for execution evidence and [[Security Defaults]] for remaining
runtime checks. These local results do not update remote PR CI; no push was performed.
