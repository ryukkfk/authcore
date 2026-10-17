# Password recovery development

Recovery is being implemented in bounded changes against the unmerged M2
verification candidate. **The password-reset workflow is not available yet.**
RECOVERY-001/002/003 and SR-019/020 remain incomplete until delivery, HTTP,
atomic reset, session revocation and browser acceptance pass together.

## Durable request boundary

`PasswordRecoveryRepository.request(normalizedEmail, requestId)` returns no
account eligibility result. It locks the matching account first, then rereads
the canonical email, verified/enabled state and password credential. Unknown,
unverified, disabled and passwordless accounts produce no recovery intent.
No account, credential or session is created or modified by this method.

PostgreSQL enforces a one-minute issuance cooldown and five requests per rolling
24 hours under the account lock. A future-dated prior request conservatively
prevents issuance. These application queries use the database clock; Redis will
provide additional HTTP admission limits, never canonical eligibility state.

The request transaction appends an immutable correlated intent and inserts its
pending delivery before returning. A delivery insertion failure rolls back both.
Requests expire after 15 minutes. There is no process-memory-only notification
handoff and no second account creation path.

Migration `0009_password_recovery.sql` adds five relations, without modifying
the prior fourteen tables or earlier migration bytes:

| Relation                       | Purpose                                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `password_recovery_requests`   | Append-only intent with user/request IDs, credential/email version bindings and database expiry |
| `password_recovery_deliveries` | Pending/leased delivery state, bounded attempts and encrypted retry payload                     |
| `password_recovery_tokens`     | Unique token digest, database expiry and consumption state                                      |
| `password_recovery_attempts`   | Append-only attempt dispositions                                                                |
| `password_recovery_audit`      | Append-only correlated password-reset outcome                                                   |

The last three relations and delivery lifecycle constraints establish schema
boundaries; their presence does not demonstrate a working delivery/reset flow.
All recovery foreign keys restrict deletion. No runtime deletion or legal
retention duration is introduced. Owner/legal retention decisions remain open.

## Proof and version binding

Recovery proof uses the existing 32-byte cryptographically secure random opaque
credential generator. Its canonical encoding is validated before purpose-separated
SHA-256 hashing. Session, email verification and recovery lookup digests are
distinct. Raw proof must not enter lookup storage, logs, URLs sent to the API,
analytics or browser persistent storage.

Internal purpose-separated SHA-256 fingerprints bind the request to the current
PHC password hash and canonical email. They are version metadata, not public
proof. The final reset must compare fresh values while holding the account lock;
any intervening password or email change then invalidates the older intent
without relying on timestamp equality. That reset enforcement is still pending.

Encrypted retry payloads use the existing AES-256-GCM envelope with a separately
derived recovery key: standard Node/OpenSSL HKDF-SHA256, empty optional salt,
32-byte output and context `authcore.password.recovery.delivery.v1`. Input base
keys must already be uniformly random 32-byte secrets. This preserves existing
verification ciphertext/AAD and separates decrypt purposes even when the base
key and event identity coincide. Key-ID rings support explicitly retained keys;
production key storage and rotation remain operational gates. See
[Node crypto.hkdfSync](https://nodejs.org/download/release/v24.21.0/docs/api/crypto.html#cryptohkdfsyncdigest-ikm-salt-info-keylen)
and [RFC 5869](https://www.rfc-editor.org/rfc/rfc5869.html).

## Explicit database capability

`packages/db/permissions/recovery-requester-role.sql` is operator-invoked after
migration, never API startup. In an explicit transaction set
`authcore.recovery_role` to a dedicated `authcore_recovery_requester_` login with
a lowercase alphanumeric/underscore suffix of 1–32 characters, then execute the
artifact. It rejects ownership, memberships and privileged role attributes.
Do not run it against live credentials or data without separate authorization.

The requester can read the minimum account/password snapshot, take an account
row lock (`UPDATE(updated_at)` column authority), inspect prior request times,
insert request columns and insert only a delivery event ID. It cannot change
passwords, account policy, sessions, token proof or historical audit. Effective
column/table authority is reconciled, including grant options and inherited
PUBLIC grants. Unexpected external-schema, sequence, function, parameter or DDL
authority fails provisioning. It does not silently revoke unrelated PUBLIC
grants. A future worker must use its own narrower capability without PHC access.

## Evidence and remaining work

`packages/crypto/src/recovery.test.ts` checks purpose/canonical proof isolation,
version-binding changes, cross-purpose decrypt rejection, event/tamper binding,
retained key rings and payload/key bounds.
`packages/db/src/password-recovery.integration.test.ts` runs migrations and a
real restricted login against its own UUID-named disposable PostgreSQL database.
It covers concurrent requests, transactional rollback, post-lock policy changes,
cooldown/cap/clock behavior and adversarial grant provisioning. The signup-role
suite also denies access to all recovery tables.

Still required: independent delivery worker with lease/crash/retry/timeout tests;
generic strict HTTP request admission; bounded native password hashing; atomic
single-use proof consumption/password replacement/all-session revocation/audit;
forgot/reset pages; real Redis/HTTP/browser concurrency and replay tests. Password
reset must not create a session or remove MFA, and exact COMMIT acknowledgement
is required before reporting a successful mutation. The existing signup protocol,
driver ownership contract and production fail-closed defaults remain unchanged.
