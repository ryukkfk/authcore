# Browser authentication development candidate

This slice covers password login and opaque browser sessions for AUTH-002 and
SESSION-001 through SESSION-006. It depends on the unmerged Phase B remediation,
verification outbox/worker and verification HTTP stack. It does not complete V1,
MFA, recovery, organization authorization or production activation.

## Admission and persistence

Login uses the existing Argon2id verifier. Unknown accounts use a process-local
dummy Argon2id hash. Wrong passwords, missing accounts, unverified accounts and
disabled accounts return the same 401 response. There is no claim of constant
end-to-end timing. Redis bounds attempts before database/native password work.

A login obtains a password snapshot, verifies it outside the transaction, then
locks the account and rereads password/status in a fresh READ COMMITTED statement.
Changed credentials, disabled/unverified users and cancelled admission fail.
Every successful session and mandatory audit insertion commit atomically.

Session credentials are 32 random bytes, canonical unpadded base64url. Only a
purpose-separated SHA-256 digest is persisted. Cookies are emitted after an
exact PostgreSQL COMMIT acknowledgement. An uncertain acknowledgement is a
generic 503, never an automatic replay. This can leave an unreachable committed
session; expiry and the ten-session cap bound admission, and account revocation
can invalidate it. This does not reproduce or alter signup accepted-proof recovery.

Sessions have a database-enforced 12-hour absolute and 30-minute idle admission
policy. Account state is checked on every authenticated request. Profile reads
refresh last_seen_at. Session-list reads do not refresh it. A login revokes the
same account's previous supplied credential, and retains at most ten nonrevoked
credentials, revoking older ones with an audit record. Expired rows can occupy
that cap until a subsequent login; no expired credential becomes valid again.

Account locks serialize session admission and revocation. A fresh database read
after the lock prevents a waiter from trusting a session revoked while waiting.
Revocation uses both the authenticated user and target session ID. Logout-all and
logout-others require an active session. Current logout is idempotent and clears
the cookie even when the proof is absent or expired. Already-admitted operations
are not retroactively cancelled by a subsequent logout. Future password reset,
account policy changes and MFA operations must share the account locking policy.

## HTTP contract

All responses use Cache-Control: no-store and a generated UUID request ID.
Errors use the existing sanitized error envelope.

| Method | Path under /api/v1    | Authentication              | Input                       | Success               | Rate category / audit                                               |
| ------ | --------------------- | --------------------------- | --------------------------- | --------------------- | ------------------------------------------------------------------- |
| POST   | /auth/login           | Public password proof       | Exact email/password object | 200 safe user, cookie | login / login_succeeded or login_failed, optional rotation/eviction |
| GET    | /auth/me              | Active session              | No query                    | 200 safe user         | read / no mutation audit                                            |
| GET    | /auth/sessions        | Active session              | No query                    | 200 safe device list  | read / no mutation audit                                            |
| POST   | /auth/logout          | Optional current session    | Empty object                | 204, clear cookie     | session / logout when revoked                                       |
| POST   | /auth/logout-all      | Active session              | Empty object                | 204, clear cookie     | session / sessions_revoked                                          |
| POST   | /auth/logout-others   | Active session              | Empty object                | 204                   | session / sessions_revoked                                          |
| POST   | /auth/sessions/revoke | Active same-account session | Exact sessionId UUID object | 204                   | session / session_revoked                                           |

Expected errors: 400 invalid body/query/header budget; 401 generic credentials,
missing/expired/revoked proof or unauthorized device; 403 rejected origin/CSRF;
405 method; 413 body limit; 415 representation; 429 rate limit; 503 unavailable
database, Redis, native capacity, cancellation or uncertain transaction outcome.
Session IDs and coarse browser-family labels are safe device metadata, not
authentication proof. No raw user-agent, IP or credential is stored in these
tables. This endpoint set does not grant organization permissions.

Write requests require JSON, exact WEB_ORIGIN and X-AuthCore-Request: browser.
This deliberately forces cross-origin preflight; SameSite alone is insufficient.
Foreign Origin and Sec-Fetch-Site: cross-site are denied on reads too. Native
clients must deliberately provide the same write contract. CORS remains restricted
to the configured web origin. Bodies are bounded to 4 KiB with strict UTF-8, no
compression, a five-second upload bound and no query credentials.

Development cookies: authcore_session, HttpOnly, SameSite=Lax, Path=/api/v1/auth. The narrower development path avoids attaching the session cookie to the local test mailbox's /api/v1 endpoints on another port. Cookie scope does not isolate ports; local services remain trusted development infrastructure.
Production cookies: __Host-authcore_session, HttpOnly, Secure, SameSite=Lax,
Path=/, no Domain. Production WEB_ORIGIN must be HTTPS. Tokens are never returned
in JSON or stored in localStorage. These controls do not substitute for CSP/XSS
hardening, deployment proxy review or production TLS validation.

## Configuration and privilege boundary

Authentication fails closed unless explicitly configured:

- AUTH_DATABASE_URL: separately provisioned authcore_auth_runtime_* login.
- AUTH_RATE_HMAC_KEY: independent 32-byte secret as 64 lowercase hexadecimal.
- WEB_ORIGIN: exact trusted browser origin.
- REDIS_URL: existing bounded Redis service configuration.

No fallback secret, role creation or database privilege change occurs at startup.
Provision the dedicated role after additive migration0007 with
[provision-auth-runtime.psql](../packages/db/permissions/provision-auth-runtime.psql)
and [auth-runtime-role.sql](../packages/db/permissions/auth-runtime-role.sql).
The latter reconciles effective privileges including inherited PUBLIC grants and
rejects escalation capabilities. Provisioning is an explicit database-owner step;
production role adoption remains an operational gate.

The role can read selected account/password-hash columns, read/insert sessions,
update only session revocation/activity and append authentication events. It cannot
create accounts, replace passwords, verify email, read audit history, mutate/delete
audit events, delete sessions or access verification delivery material.
UPDATE(updated_at) on users exists solely for PostgreSQL FOR UPDATE capability;
the authentication application never updates users.

The separate checked security transaction owner uses the pinned public driver
dispose contract, server statement/lock/transaction bounds and a 12-second local
transport-ownership deadline. It does not change the frozen Phase B signup owner.
Pool checkout itself is bounded by the existing five-second connection timeout.

Password authentication owns at most four native Argon2 operations per API
process and awaits their actual settlement during shutdown. Signup retains its
separate four-owner limit. The combined process can therefore own eight native
operations; this is not a fleet-wide memory bound. Deployment capacity, signup
advisory-slot controls and host/container memory limits require separate review.

Redis uses atomic multidimensional fixed-minute limits: login IP10/account5/global30;
read IP200/subject200/global1000; session mutation IP20/subject20/global100.
Read/session subject is the same peer IP, not an asserted user identity. Account
and IP key material is purpose-separated HMAC, with 60-second TTL. Values are
deployment starting policies, not a credential-stuffing certification. Proxy
address trust is deliberately not enabled; reviewed trusted-proxy configuration
is required before load-balanced deployment. Rate denials currently produce no
per-attempt durable authentication event; telemetry and retention policy remain
hardening work.

## Evidence and limitations

Focused checks on the development candidate:

- Twelve real PostgreSQL session security cases, including concurrent logins,
  revocation while waiting for an account lock, audit rollback, status/expiry,
  stale password proof, cancellation and restricted-role denial.
- Seven real PostgreSQL/Redis/Argon2/HTTP cases, including login/profile/logout
  replay, generic denial, rotation/all/other-device revocation, cross-account
  device rejection, Redis account limits, expiry/status and CSRF.
- Thirteen API boundary/native-owner cases; crypto and checked-transaction tests.
- Workspace build/typecheck/lint and the sole-account-writer inventory check.

These focused tests passed locally on 2026-10-17. Full regression and exact-commit
hosted CI are recorded separately in the PR evidence; do not infer their outcome
from this document. Database fixture account creation is test-only. The runnable
demo must still exercise the sole secure signup path and captured verification
delivery before login.

No browser UI or combined signup/mail/verification/browser acceptance has been
claimed by this slice. Independent qualifying human approval remains pending.
MERGE BLOCKED — QUALIFYING HUMAN APPROVAL PENDING.
