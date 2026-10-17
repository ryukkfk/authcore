# Registration and verification policy

Development policy, 2026-10-17. Implements a bounded AUTH-001/VERIFY follow-on to
the local demo. Public registration and production release remain unapproved.
No second account-creation path or change to the frozen HMAC/T1/T2/T3 semantics.

## Account states

| State      | Representation and permitted transition                                                                                                                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Absent     | No committed user. A retained signup claim is protocol evidence, not a verified account or session.                                                                                                                                 |
| Unverified | Committed user has no email_verified_at and no disabled_at. Sole T2 atomically creates account/credential/audit/initial verification intent. Only mailbox proof may establish verification; password knowledge alone cannot log in. |
| Verified   | email_verified_at exists and disabled_at is null. Password login may issue a session subject to all rate/session policies.                                                                                                          |
| Disabled   | disabled_at exists, regardless of verification timestamp. Login, session admission, verification and resend deny safely. No public API enables/disables accounts.                                                                   |

Signup acceptance/replay is generic and never establishes mailbox control.
Initial issuance remains one append-only event per account, keyed by its sole
signup transaction. Normal production entry remains disabled by default.

## Verification and resend

The independent worker issues random 32-byte proof, stores only its verifier
digest, and retains an authenticated-encrypted retry envelope until terminal
delivery disposition. Database expiry is 30 minutes after issuance. Consumption
locks the account, atomically marks a live token consumed, verifies the account
and appends audit. Invalid/expired/consumed/disabled/previously verified proof is
unavailable. Verification never creates a session.

`POST /api/v1/auth/resend-verification` accepts exactly one valid email string.
No authentication/authorization credential is required; cookie state conveys no
authority. JSON is strict UTF-8, uncompressed, at most 2 KiB, with bounded headers
and upload deadline. Query strings and other methods are rejected. Supplied
Origin must match configured WEB_ORIGIN; application/json is required. The shared
proof endpoint retains its existing 1 KiB limit.

Every valid eligible/ineligible request returns the same `202 {status:"accepted"}`
without a cookie, eligibility result, token or event ID. Errors:400 malformed,
403 foreign Origin,405 method,413 size,415 encoding/type,429 request throttling,
503 unavailable configuration/Redis/database. Responses are no-store and carry
a generated request correlation ID. Error/body equality is not a demonstrated
timing guarantee; representative enumeration timing assessment remains pending.

Redis atomically bounds requests at 10/IP/minute,3/normalized-address/minute and
100/global/minute, independently of account existence. Address/IP keys use the
configured authentication HMAC key with a distinct resend purpose; no address or
raw credential enters Redis keys. Missing key/Redis fails closed, no fallback.

PostgreSQL independently authorizes issuance after locking the same account row
used by verification, then rereading its current status. It permits an unverified,
enabled account at most one new intent per minute (including initial signup for
cooldown) and five resends per rolling database 24 hours. Cooldown/cap ineligibility
still returns generic202. Database clock is authoritative; future-dated intent
conservatively denies. No absolute monotonic elapsed-time guarantee is claimed.

Issuance appends one `verification_events` row with reason=resend and generated
request_id. That immutable row is both durable notification intent and security
audit of the request that actually caused issuance. It commits before worker
delivery. Concurrent requests serialize, so only one creates an intent within the
cooldown. The application receives no eligibility flag. Retry after an ambiguous
response does not bypass cooldown/cap; there is no replay of account creation.

Existing proofs are retained until their own expiry/consumption. An attacker who
knows an email cannot invalidate the owner's existing link by requesting resend.
Any successful proof verifies the account once; other proofs then fail safely.
The worker cancels not-yet-claimed delivery when it observes verified/disabled
state. A message already in transport may still arrive, but cannot reopen account
access or produce a second verification transition.

## Persistence and review

Migration0008 adds nullable request_id for historical/signup compatibility and
an account/time index. All old migration/snapshot bytes and all other tables are
preserved. No data deletion/backfill, live migration or new secret is performed.
The existing explicitly provisioned verifier principal gains normalized-email
read, policy event reads, and only the event INSERT columns needed by this path.
It gains no account creation, event UPDATE/DELETE, worker-envelope or password
access. Existing account-verification privileges remain unchanged. Reapply the
reviewed role provisioner explicitly in disposable setup before enabling resend.

Audit/event retention, privacy policy, production storage limits, external email
provider configuration, independent review and production timing/capacity remain
release gates. No legal retention period is invented here. See the security
matrix and local demo guide for broader incomplete V1 scope.

Verification intent is append-only for runtime principals. Its historical user
foreign key cascades on owner-level deletion; no application account-deletion
endpoint or runtime DELETE privilege exists. Any future account deletion or
retention workflow must preserve required audit evidence before it is enabled;
this increment does not claim owner-proof immutable storage or complete AUDIT scope.

## Regression coverage

Real PostgreSQL tests cover concurrent issuance, unknown/verified/disabled states,
initial cooldown, daily cap/expiry, future clock refusal, transactional failure,
post-lock account transition, original-proof validity and worker cancellation.
HTTP tests cover validation, Origin/method/UTF-8/size, HMAC-key privacy, generic
acceptance, rate/Redis/config failure and SQL-error redaction. The real browser
resend case waits for actual cooldown, observes a second captured message and
consumes its proof; it never clears Redis, moves database time or bypasses policy.
