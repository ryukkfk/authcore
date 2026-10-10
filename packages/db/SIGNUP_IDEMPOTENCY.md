# Signup idempotency foundation — Phase A

This slice is inactive persistence/crypto infrastructure. It does not change HTTP
headers, signup guards, SignupService, transaction ownership, Redis admission,
or `SIGNUP_ENABLED=false`. It does not implement COMMIT acknowledgement recovery.
No live migration, runtime permission adoption, deployment, or cleanup is included.

## Versioned canonicalization contract

`createSignupIdempotencyHasher` in `@authcore/crypto` requires an explicitly injected
dedicated 32-byte random HMAC secret and a positive PostgreSQL-integer key version.
There is no secret/environment fallback and no secret in migrations. Operators
must manage this independently of passwords, JWT/session/Redis keys and database
credentials. The key version identifies immutable secret material; never replace
material under an existing version. Secret injection into API startup is Phase B.

The v1 key is an opaque, case-sensitive string of 16–128 ASCII characters from
`A-Z a-z 0-9 _ -`. No trimming, decoding, Unicode normalization or case folding is
performed. This is a future input contract, not HTTP enforcement in this phase.
Clients must use cryptographically random keys; this syntax alone does not prove
entropy. Caller DTO/email validation remains required.

Both digests are lowercase HMAC-SHA-256 hex over UTF-8 `JSON.stringify` of these
fixed ordered tuples (no BOM or newline):

```text
key:     ["authcore.signup.key", 1, rawKey]
payload: ["authcore.signup.payload", 1, trimmedEmail, normalizedEmail, password]
```

`trimmedEmail = email.trim()` and `normalizedEmail = trimmedEmail.toLowerCase()`
match the current signup writer. Both are included because display-email case is
persisted today. Password is the exact supplied JS string; it is never trimmed
or Unicode-normalized. The helper bounds each input string to 1,024 UTF-16 code
units and rejects empty password/trimmed email. These are memory/input caps,
not a second password or email policy: the existing DTO must validate first.
In particular DTO length validation treats surrogate pairs/presentation sequences
differently from JavaScript string length; full valid Unicode passwords survive.
JSON escaping prevents delimiter ambiguities. Unrecognized input fields do not
participate. Plaintext payload/key exist transiently in memory only; the helper
returns only digests and versions and does not log. HMAC prevents an offline
password-dictionary check from a ledger-only leak; compromise of its secret
removes that protection. HMAC is not password storage; Argon2 remains unchanged.

## Durable claim and immutable result

`signup_idempotency_claims` has a random UUID identity, separate key/payload
contract versions, HMAC key version, fixed-size digest fields, database creation
time, explicit finite expiry, and an inert `lock_anchor=false` column. CHECKs
accept only key/payload contract v1, positive HMAC versions, lowercase 64-character
hex digests, finite times and expiry after creation.

The unique key is `(key_version, hmac_key_version, key_digest)`: within this
versioned namespace concurrent reservations cannot bind different payloads.
Reservation first looks up a retained claim and checks its immutable binding,
before validating a proposed new expiry or attempting INSERT. A genuinely new claim
requires a finite expiry strictly after the application clock; invalid input throws
the sanitized domain error `SignupIdempotencyExpiryError`
(`SIGNUP_IDEMPOTENCY_INVALID_EXPIRY`), without inserting or extending a lifetime.
The database expiry CHECK remains authoritative: its specific failure (including
clock disagreement or expiry elapsing before INSERT) maps to the same domain error.
Other database errors propagate. If that CHECK fails inside a caller-owned
transaction, the caller must roll back the failed PostgreSQL transaction.

For valid prospective expiry, reservation uses targeted `ON CONFLICT DO NOTHING`
followed by a **separate** READ COMMITTED lookup, so a winner committed while the
insert waited is visible even if it was invisible to the initial lookup. If the
uncommitted writer rolls back, the waiting INSERT may establish its own binding;
there was no durable earlier claim to take over.
Matching retries return the original row without updating any timestamp; a
different binding throws a fixed-message conflict without request data/cause.
Unrelated errors propagate. This does not hide failures or retry transactions.

**Phase A HMAC policy:** all writers must retain one active HMAC secret and version
throughout the active claim retention window. Changing the secret/version changes
key identity. Do not run concurrent write versions or rotate active keys without a
separately reviewed migration/reconciliation and cross-version reservation protocol.
The schema does not identify the same raw key across different secrets/versions.
This is a required Phase B architecture decision, not implemented key rotation.

`signup_idempotency_results` has exactly one row per claim (claim UUID primary
key), a RESTRICT foreign key to the claim, and finite database creation time.
Its v1 response is constrained to status code `202` and exactly
`{"status":"accepted"}`. This matches current enumeration-resistant HTTP
behavior for both newly created and existing accounts; no account existence,
user ID, email, password/hash, raw key, arbitrary headers or error text is stored.
The response CHECK rejects additional JSON fields. A result append never upserts
or overwrites; duplicate results fail. Lookup does not join mutable account data.

The intended later flow is: durably reserve/commit the claim; lock that claim in
the caller-owned signup transaction; look up its result; append a result in the
same transaction as user, credential and audit writes. Repository methods do not
enforce this orchestration or open/commit transactions themselves. `lockByKey`
must receive a transaction, not an autocommit pool; rollback releases its lock.
An absent result is not proof that an ambiguous COMMIT rolled back. No service,
replay, conflict-to-HTTP mapping, lease fencing or recovery loop is wired here.

## Runtime permission design

The explicit provisioning artifact now covers five tables, after migration 0003.
It preserves SELECT/INSERT and the existing effective-privilege/ownership checks.
Only `signup_idempotency_claims.lock_anchor` gets column UPDATE, required by
PostgreSQL for SELECT FOR UPDATE. Its CHECK allows only false, so the grant permits
locking and a no-op update, without mutable claim identity, binding or lifetime.
No table UPDATE is granted. Column grant options and all unexpected column UPDATE
privileges (including PUBLIC) are rejected. Results and existing audit events get
no UPDATE, DELETE or TRUNCATE. Claim deletion/truncation is also denied.

These guarantees require provisioning and a genuine restricted runtime login;
they do not protect against an owner/superuser, make storage tamper-evident or
prove that an allowed appended result reflects truthful application work after
full runtime compromise. As with existing audit INSERT, table INSERT is needed
for Drizzle's explicit DEFAULT columns. Direct SQL can choose new UUIDs/times or
append false accepted responses. Repository input allowlists strip extra fields.
The foreign key prevents dangling results; atomic signup/result linkage remains
a caller transaction responsibility. No existing environment has been adopted.

## Expiry and retention

`expires_at` is immutable metadata, **not** permission to delete/rebind a key.
Phase A lookup returns retained claims/results even after expiry. Reservations
with the same payload reuse the original row; conflicting payloads still fail.
This includes retrying with the original, now-expired timestamp: no INSERT, renewal,
binding change or result overwrite is performed when the claim is already visible.
Returned expiry remains unchanged. A successful reservation is not authorization
for signup mutations; the future caller must enforce the approved expiration policy.

There is an explicit fail-closed visibility boundary for invalid proposed expiry:
after the initial miss, a second fresh lookup checks for a just-committed claim.
If a concurrent claim is still uncommitted (or commits after this final snapshot),
the method cannot identify it and returns the controlled expiry error, without
waiting, inserting a substitute claim, or inventing a future expiry. A later caller
retry can inspect the committed binding. If the writer rolls back, the new claim
still requires a valid future expiry. No automatic retry/recovery is implemented.
No TTL default is selected, no worker/job runs, and no automatic cleanup exists.
Operators must not delete unresolved claims to unblock requests: an in-flight or
unacknowledged transaction may still complete. Runtime cannot perform cleanup.

Phase B must decide replay/rejection after expiry, retention duration, bounded
recovery and in-flight fencing, HMAC version retirement, and separately authorized
cleanup. Results must be retained with claims until that policy safely permits
owner-managed removal; foreign-key RESTRICT prevents casual claim-first deletion.
Ledger retention has no account/email migration and no account-deletion cascade.

## Isolated verification

Offline migration tooling (no `.env` loading, no database connection):

```text
pnpm --filter @authcore/db exec drizzle-kit check --config=drizzle.schema.config.ts
pnpm --filter @authcore/db exec drizzle-kit generate --config=drizzle.schema.config.ts
```

The second command should report no schema changes after the checked-in snapshot.
Historical migrations/snapshots 0000–0002 are preserved.

`runtime-role.integration.test.ts` extends the existing UUID-owned disposable
database/login harness. It requires an explicitly supplied isolated
`TEST_DATABASE_URL` targeting localhost:5432/authcore_test, distinct from
`DATABASE_URL`. It never loads `.env` or guesses credentials. The isolated test
administrator must be able to create databases and roles; application credentials
remain restricted. Test role passwords/digest fixtures are generated per run.

Coverage includes concurrent identical/conflicting reservations, a held
uncommitted insert with commit/rollback outcomes, row-lock timeout/release,
protected columns and audit history, response allowlisting, uniqueness/FKs,
original-expiry replay/conflict, controlled invalid-expiry errors, database expiry
CHECK translation, the invisible expired-claim boundary, provisioning rollback, and
combined user/credential/audit/result rollback. Existing HTTP E2E stays unchanged and also
requires isolated Redis on port 6380. Missing infrastructure must be reported as
blocked/skipped, never counted as PostgreSQL verification.

## Local verification record — 2026-10-10

Branch `feat/signup-idempotency-foundation` started clean at
`d6293312a00f75318f107f1caf69ec5db8141289`. No commits, pushes, live migrations,
permission adoption, environment-file edits, Docker changes or original-checkout
changes were performed. Dependencies were installed offline into this worktree.

| Exact command                                                                           | Result                                                                                                 |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `pnpm.cmd build`                                                                        | PASS, all nine workspace apps/packages                                                                 |
| `pnpm.cmd lint`                                                                         | PASS, all nine workspace apps/packages                                                                 |
| `pnpm.cmd typecheck`                                                                    | PASS, all nine workspace apps/packages                                                                 |
| `pnpm.cmd test`                                                                         | 188 passed, 0 failed, 17 skipped (PostgreSQL service cases BLOCKED)                                    |
| `pnpm.cmd --filter @authcore/db test:integration`                                       | 0 passed, 0 failed, 91 skipped; all 91 BLOCKED by missing explicit PostgreSQL connection configuration |
| `pnpm.cmd --filter @authcore/api test:redis`                                            | 0 passed, 28 failed, 0 skipped; isolated Redis connection unavailable, including retry outside sandbox |
| `pnpm.cmd --filter @authcore/api test:e2e`                                              | BLOCKED; 1 suite fails before collection because TEST_DATABASE_URL is absent; 0 tests executed         |
| `pnpm.cmd exec drizzle-kit check --config=drizzle.schema.config.ts` (in packages/db)    | PASS, offline lineage check                                                                            |
| `pnpm.cmd exec drizzle-kit generate --config=drizzle.schema.config.ts` (in packages/db) | PASS, no schema changes remaining                                                                      |

After shortening the new FK identifier to avoid PostgreSQL's 63-byte limit,
`pnpm.cmd --filter @authcore/db build`, `typecheck`, `lint`, and `test` were
rerun and passed (35 DB unit tests, no skips). Offline generation again found no
schema changes. The 188 unique passed cases comprise config 24, crypto 33, DB 35,
and API 96. Do not double-count repeated verification runs. The 108 skipped cases
are blocked PostgreSQL tests, not passes; E2E is an additional blocked suite.

The Redis URL was explicitly set to `redis://127.0.0.1:6380` in the test process.
A separate TCP probe returned ECONNREFUSED. No attempt was made to start/change
Redis/Docker or use development Redis. No PostgreSQL credentials were guessed or
read from application `.env`. PostgreSQL constraints/permissions/concurrency and
HTTP E2E remain unverified against a live isolated server.

## P2 expiry correction verification — 2026-10-10

The correction changes only the claim repository, its domain-error exports, unit
and restricted-runtime integration tests, and this document. No schema, migration,
grant, HTTP or SignupService behavior changes are included.

The focused original-expiry regression failed against the previous INSERT-first
implementation and passed after the lookup-first correction. Final focused result:
18 passed, 0 failed, 0 skipped; these cases are included in the workspace total.

| Exact command                                                                        | Correction-session result                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm.cmd test`                                                                      | Final rerun: 197 passed (config 24, crypto 33, DB 44, API 96), 0 failed tests, 17 skipped/BLOCKED PostgreSQL signup cases; exit 0. Initial run had a health HTTP beforeAll timeout; the unchanged test passed on rerun. |
| `pnpm.cmd --filter @authcore/db test:integration`                                    | 0 passed, 0 failed, 99 skipped/BLOCKED: explicit TEST_DATABASE_URL/PGPASSFILE unavailable. Includes 74 runtime-role and 25 user-repository cases. Exit 0 from skip behavior is not verification.                        |
| `pnpm.cmd --filter @authcore/api test:redis`                                         | 28 passed, 0 failed, 0 skipped; only explicit isolated Redis at 127.0.0.1:6380 used.                                                                                                                                    |
| `pnpm.cmd --filter @authcore/api test:e2e`                                           | BLOCKED at collection by absent TEST_DATABASE_URL; 1 failed setup suite, 0 cases executed, 9 source-defined cases unverified.                                                                                           |
| `pnpm.cmd build`, `pnpm.cmd lint`, `pnpm.cmd typecheck`                              | PASS, all nine workspace apps/packages.                                                                                                                                                                                 |
| `pnpm.cmd exec drizzle-kit check --config=drizzle.schema.config.ts` (packages/db)    | PASS outside the sandbox after repeated sandbox OS-account lookup errors (`uv_os_get_passwd` ENOMEM). No .env/database access.                                                                                          |
| `pnpm.cmd exec drizzle-kit generate --config=drizzle.schema.config.ts` (packages/db) | PASS outside the sandbox: no schema changes, nothing to migrate.                                                                                                                                                        |
| `pnpm.cmd format:check`                                                              | FAIL: 119 pre-existing files outside the six-file correction scope. No unrelated formatting applied.                                                                                                                    |
| `pnpm.cmd exec prettier --check` with the six correction files listed below          | PASS.                                                                                                                                                                                                                   |
| `git diff --check`                                                                   | PASS; only Git CRLF conversion warnings.                                                                                                                                                                                |

Correction files: `src/repositories/signup-idempotency.repository.ts`,
`src/repositories/signup-idempotency.repository.test.ts`, `src/repositories/index.ts`,
`src/index.ts`, `src/runtime-role.integration.test.ts`, and `SIGNUP_IDEMPOTENCY.md`
(all relative to `packages/db`). The focused command was
`pnpm.cmd --filter @authcore/db exec vitest run src/repositories/signup-idempotency.repository.test.ts`.

Distinct latest executed passes: 225 (197 workspace + 28 Redis), without counting
the focused run again. The 116 skipped cases (17 + 99) are BLOCKED, plus the E2E
setup suite. Earlier user-reported PostgreSQL/E2E successes predate this correction
and do not verify the new concurrency/expiry regressions. Run the secure PowerShell
commands below with explicit isolated PostgreSQL configuration before asserting
PostgreSQL verification or merge readiness. Every verification command used
process-local `SIGNUP_ENABLED=false`; no environment files or live roles changed.

## Secure Windows PowerShell rerun

Use only the already authorized isolated PostgreSQL 17+ instance and dedicated
Redis at port 6380. The existing permission regressions need an isolated test
administrator able to create/drop disposable databases/logins and exercise
superuser-only role-attribute/parameter-grant cases. CREATEDB/CREATEROLE alone is
not sufficient for all those tests. This administrator is **test infrastructure**,
never the application runtime login and never a production credential.

Supply that login's password through an existing protected PostgreSQL passfile
(`PGPASSFILE`), not a connection URL, shell history, source code or chat. The
passfile must cover the suite's random database names as well as `authcore_test`.
Replace only the non-secret username and existing passfile path in this example:

```powershell
Set-Location -LiteralPath 'C:\Users\Tin Aung Cho\authcore-main'
$env:SIGNUP_ENABLED = 'false'
$env:PGPASSFILE = 'C:\path\to\existing-protected-test.pgpass'
$env:TEST_DATABASE_URL = 'postgresql://TEST_ADMIN@127.0.0.1:5432/authcore_test'
$env:TEST_REDIS_URL = 'redis://127.0.0.1:6380'

pnpm.cmd test
pnpm.cmd --filter @authcore/db test:integration
pnpm.cmd --filter @authcore/api test:redis
pnpm.cmd --filter @authcore/api test:e2e
```

Do not fall back to application DATABASE_URL, REDIS_URL, `.env`, production
credentials or development Redis. These suites create/delete only their UUID-owned
test databases/roles and Redis namespaces. They do not adopt live runtime grants.
No real HMAC secret is required for Phase A tests: crypto tests generate ephemeral
32-byte keys. Managed runtime secret injection and cross-version rotation remain
Phase B decisions. The ledger is ready for source review, not a declaration that
PostgreSQL verification or COMMIT recovery is complete.

References: [PostgreSQL SELECT locking privileges](https://www.postgresql.org/docs/17/sql-select.html),
[PostgreSQL privileges](https://www.postgresql.org/docs/17/ddl-priv.html),
[Node HMAC API](https://nodejs.org/api/crypto.html#cryptocreatehmacalgorithm-key-options).
