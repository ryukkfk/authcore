# Identity foundation repository

Last updated: 2026-10-12 (Asia/Rangoon)

The reviewed implementation baseline is `d51559cfb3ec614d158ae4dd3b3f63baaefa234b`
(PR #9). Transactional audit (PR #7), restricted-runtime permission provisioning
(PR #8), and Phase A signup idempotency ledger foundations (PR #9) are merged.
[CI #21](https://github.com/ryukkfk/authcore/actions/runs/38075918583)
succeeded for that revision; see [Development Status](Development%20Status.md) for counts and historical
PR evidence. Earlier foundation/Draft PR #4 and PR #8 candidate checkpoints are
historical. The HTTP signup boundary stays disabled by default
(`SIGNUP_ENABLED=false`); AUTH-001 remains in progress.

The runtime permission artifact was tested with genuinely restricted logins and
now covers five signup tables including the Phase A ledger. It has **not** been
shown to be adopted by any live application role. No independent human security
approval or tamper-evidence guarantee is claimed. Phase A does not implement
HTTP idempotency or uncertain COMMIT result recovery. See
[runtime permissions](../packages/db/SIGNUP_RUNTIME_PERMISSIONS.md) and
[Runtime Permissions Checkpoint](Runtime%20Permissions%20Checkpoint.md) (dated historical snapshot).

The first durable signup audit slice is described in
[Signup transactional security audit](../apps/api/SIGNUP_TRANSACTIONAL_AUDIT.md),
including retention, rollback guarantees and isolated verification commands.

The historical October 10 user-run local checkpoint records 168 workspace tests
passed, 0 failed and 0 skipped; signup PostgreSQL 17/17, DB repository 25/25,
dedicated Redis 28/28 and combined E2E 7/7 passed. Workspace lint, typecheck and
build passed. These are user-reported local results, not candidate PR CI results
or independent reviewer reruns. Current CI is recorded separately above. The
linked audit note records the local checkpoint;
the focused signup PostgreSQL rerun must not be counted again in workspace totals.

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
opening a transaction. It constructs user, credential and security-audit repositories
with the same transaction, inserts all three rows, and returns only the user after
commit. Credential or audit insert failure rolls back all related writes.
`DuplicateUserEmailError` maps to
the existing `EmailAlreadyInUseError`; unrelated failures propagate.

`PasswordCredentialRepository.create({ userId, passwordHash })` persists only those
fields and returns database defaults. `findByUserId` returns a credential or null.
The repository accepts an encoded hash, never a plaintext-password field. It neither
opens transactions nor closes pools. The existing primary key and foreign key enforce
one credential per user and cascading deletion. No additional migration is required.

Passwords retain their exact whitespace when hashed. Neither input nor errors are
logged by signup. After commit, a structured `identity.user_created` log event contains
only the user ID. This remains an operational log; the same transaction's
`security_audit_events` row is the durable audit source of truth.

The permissions candidate proves append-only access for a provisioned runtime
principal in isolated tests. Existing live credentials have not been switched;
SQL roles with broader privileges can still update/delete audit rows. Audit retention and account
deletion policy are not finalized. Redis lease/COMMIT fencing and uncertain
COMMIT reconciliation remain unresolved. Public signup remains disabled
(`SIGNUP_ENABLED=false`); this is development-only work.

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
from the historical foundation's 4 PostgreSQL signup integration tests (the current
suite has 17). The hardening regression cases additionally test 12/128-character acceptance,
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
The test administrator needs `CREATEDB`; the new permissions and combined E2E
suites also need `CREATEROLE` for disposable test logins. Whole-database isolation is necessary
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

## Next work — registration features and operational security

Runtime permission provisioning merged in [PR #8](https://github.com/ryukkfk/authcore/pull/8)
and was extended for the ledger by [PR #9](https://github.com/ryukkfk/authcore/pull/9).
The exact historical PR #8 candidate head and its
[CI #17](https://github.com/ryukkfk/authcore/actions/runs/38047352812)
remain recorded in [Runtime Permissions Checkpoint](Runtime%20Permissions%20Checkpoint.md) and [Development Status](Development%20Status.md).
Independent human security review and separately authorized live runtime-role
adoption remain outstanding. [Roadmap#AUTH-001 — Registration](Roadmap.md#auth-001--registration) remains in
progress: registration policy, verification-event creation/delivery, and
timing-resistant account-enumeration protection remain pending. HTTP
Idempotency-Key enforcement, uncertain COMMIT reconciliation, retention policy,
transactional outbox delivery and operational readiness remain separate work.
Production deployment is not ready.
API-004 remains [Roadmap#API-004 — Global Error Handling](Roadmap.md#api-004--global-error-handling); signup work belongs to AUTH-001.

## Historical verification — 2026-10-08

The historical pre-hardening checkpoint recorded API 33/33 and DB integration 14/14.
The October 8 hardening working tree passed build, typecheck, lint, 78 workspace tests
(config 24, crypto 5, DB unit 5, API 44) and 14 separate DB integration tests: 92
distinct tests, no skips. API 44 includes the 4 PostgreSQL signup tests. See
[Development Status](Development%20Status.md) for execution evidence and [Security Defaults](Security%20Defaults.md) for remaining
runtime checks. These historical local results do not describe the current test
totals or update remote PR CI; no push was performed at that checkpoint.
