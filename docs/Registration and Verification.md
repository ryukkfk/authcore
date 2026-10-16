# Registration and verification policy

Development candidate, not deployment approval. AUTH-001 and VERIFY-001/002 are
incomplete until the token, worker, HTTP and browser slices are verified.

Account state uses existing columns: pending means `email_verified_at IS NULL`;
verified means a database-recorded verification timestamp; disabled means
`disabled_at IS NOT NULL`, which takes precedence. A committed signup does not
prove control of a mailbox. Restricted sessions must require verified, active
state when login is introduced.

## Durable notification intent (M1.1)

Migration 0005 adds `verification_events`. The sole reviewed signup writer appends
one initial intent in the same owned T2 as the user, password credential, mandatory
audit and accepted result. It uses the existing capacity, claim, namespace, expiry,
COMMIT proof and T3 recovery protocol. Replay and duplicate-account acceptance do
not issue another initial event. A partial unique index enforces one signup intent
per user under concurrency.

The event contains an opaque ID, user ID, fixed type, reason and database timestamp.
It contains no password, email address, raw token, token digest or provider payload.
It is a durable outbox intent, not evidence of email delivery or verification.
A future independent worker tracks claiming/delivery in separate tables; it must
not mutate this intent or create another account.

The dedicated signup principal gains SELECT/INSERT on the new table and no
UPDATE/DELETE/TRUNCATE rights. All original seven table restrictions stay intact.
The T2 prerequisite checks the additional grant before account-dependent duplicate
handling to avoid a missing-permission enumeration oracle. Apply additive migration
0005 before explicitly re-running restricted-role provisioning in a disposable
environment. API startup still never migrates or grants privileges.

Notification intent follows the account FK on deletion; this is not the audit
history. The existing mandatory audit still restricts account deletion. Retention
and legal policy are unresolved; there is no public deletion or cleanup API.

## Evidence and remaining work

Regression coverage includes mandatory-intent failure, real SQL rollback,
concurrent initial issuance, independent connection reads, FK/type constraints,
restricted-role mutation denial, actual HTTP companion-write failure, duplicate
preservation and missing-privilege behavior for fresh/existing accounts.

Next slices: CSPRNG tokens with hash-only token records and database expiry/single
use; encrypted retry payloads, worker claims/backoff/dead letters and local-only
mail capture; bounded resend; verified-account login and revocable sessions; web
and real browser validation. There is no real provider or public signup enablement.
