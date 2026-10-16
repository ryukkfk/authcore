# Email worker and verification development slice

Tickets: AUTH-001, VERIFY-001/002, NOTIFY-001/002. Development only. A delivery
worker and verification persistence primitives are implemented; HTTP/UI/demo
orchestration remains follow-on work. This is not a complete product milestone.

## Durable state and delivery

Migration0006 adds worker-owned `email_deliveries`, hash-only
`email_verification_tokens`, append-oriented `email_delivery_attempts` and
`account_security_events`. Migration0005 intent and the original signup protocol
remain unchanged. The worker independently materializes committed intents; unique
event IDs make materialization idempotent. Claims use row locks with SKIP LOCKED,
database-clock leases, random ownership IDs and a five-attempt limit. Completion
requires the current, unexpired lease. Backoff is exponential with a one-minute
ceiling. Expired final leases become durable dead letters. There is no automatic
unbounded retry, deletion or reset of attempts.

Issuance generates 32 random bytes through Node/OpenSSL. The token record stores
only a purpose-separated SHA-256 digest and a database-enforced 30-minute expiry.
Retry material is encrypted using standard AES-256-GCM, a fresh random 96-bit nonce,
a 128-bit authentication tag and event/purpose/version/key-ID associated data.
Keys are supplied independently of ciphertext. An explicitly configured key ring
can read retired key IDs; production rotation and key lifecycle require a separate
operational procedure. No signup HMAC secret is reused for email encryption.
Terminal delivery clears ciphertext; token expiry and single use remain enforced.
The local mailbox deliberately holds the captured message until its own retention
or shutdown; it must never be exposed publicly.

Delivery is at least once. A crash after mailbox acceptance but before completion
may repeat the same message and same token. The stable Message-ID is advisory,
not a claim that every provider deduplicates. Token consumption is the idempotent
security effect: concurrent consumption serializes on the user, accepts only one
unexpired token, transitions active pending state to verified and appends audit in
one transaction. Replay, disabled accounts and expired credentials fail. A failed
audit write rolls back consumption and the account transition.

Security transactions use a separate checked COMMIT/disposal boundary. They never
retry ambiguous commits or return business output without an exact COMMIT tag.
The original signup owner's lifecycle, T1/T2/T3 and accepted proof remain frozen.

## Process and privileges

The worker is an independent Node process with one in-flight delivery, a bounded
transport deadline, cancellation propagation and graceful pool shutdown. It emits
fixed structured events; raw errors, recipients, credentials and envelopes never
enter logs. Configuration is deliberately local-only and requires both
`NODE_ENV=development` and `AUTHCORE_LOCAL_DEMO=true`. Its ignored private config
contains only its own database URL, delivery key, mailbox and web origin. Full demo
setup will provision this config; it is not a working onboarding command yet.

After migrations, `permissions/provision-email-runtime.psql` provisions only
dedicated `authcore_email_worker_*` or `authcore_email_verifier_*` unprivileged
principals. The operator supplies role name and capability; passwords never belong
in command arguments. The worker can issue and deliver but cannot create accounts,
verify accounts, read password hashes or token digests, or delete audit history.
The verifier can consume tokens, update verification timestamps and append audit;
it cannot create accounts, issue credentials or read delivery ciphertext. The
signup principal retains its original eight-table policy and has no access to the
four new subsystem tables. Provisioning reconciles effective column privileges,
PUBLIC grants, role memberships/ownership and escalation surfaces. No API startup
migration/grants or production role adoption is implied.

Only the local Mailpit transport exists. It requires explicit development config,
literal loopback HTTP origins, no URL credentials and no redirects. Links carry
tokens in fragments to avoid HTTP access logs. A future web client must remove the
fragment before posting the token and must never persist it in browser storage.

## Evidence and remaining acceptance

Tests cover cryptographic boundaries/tampering, exact COMMIT acknowledgement,
real PostgreSQL restricted roles, concurrent claim and consumption, durable retry,
stale workers, dead letters, an actual child-worker crash before delivery, audit
failure rollback, provider timeout/cancellation, redaction and actual Mailpit HTTP
capture. Exact-commit CI and the private ledger record outcomes; this document is
not itself passing evidence.

Remaining: bounded resend and HTTP verification contracts/rate limits; login and
sessions; web/dashboard; deterministic demo secrets and startup; real browser E2E;
production key management, retention/privacy, delivery-provider configuration and
independent security approval. No real email provider or public signup is enabled.

References: [Node 24 cryptography](https://nodejs.org/docs/latest-v24.x/api/crypto.html),
[Mailpit API](https://mailpit.axllent.org/docs/api-v1/),
[Mailpit pinned development release](https://github.com/axllent/mailpit/releases/tag/v1.31.6).
