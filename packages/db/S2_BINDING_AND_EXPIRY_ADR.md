# S2 secure namespace, reservation and durable expiry

Development choice authorized by the Phase B mission, with independent review and
production activation still gated. Default signup remains disabled. No production
secret, namespace row, database migration or live grant is created by this work.

## Stable HMAC namespace

Keep frozen HMAC v1 canonicalization and vectors unchanged. Require an explicitly
injected dedicated 32-byte secret and independently approved version/known-answer
metadata. Verify both public known-answer digests with constant-time comparisons;
copy secret material into the existing standard Node KeyObject implementation.
No fallback, environment guessing, logging or automatic rotation is permitted.

A process-only startup comparison cannot prevent two differently configured writers
from creating distinct namespaces in an initially empty database. Add a singleton
`signup_idempotency_namespace` anchor containing only version and public known-answer
digests. Runtime has SELECT only. Missing anchor or disagreement fails closed before
reservation or hashing. Its creation belongs to a separately authorized operator;
disposable tests seed only explicit test material. No secret bytes enter PostgreSQL.
The retained anchor is never automatically registered, updated or retired by the API.
All retained claim versions must agree with the approved anchor. Namespace drift stops
new work; no alternate-version lookup, rebinding, renewal or hidden rotation occurs.

This adds one relation beyond D04's terminal table because configuration attestation
and expiry are independent facts. Reusing claims, accepted results or terminal events
as configuration storage would obscure their immutable contracts. The restricted
model therefore grows from five to seven tables, with no broader privileges on the
original five and no namespace INSERT/UPDATE/DELETE grants to runtime.

## T1 reservation evidence

The internal boundary computes binding only after DTO validation, verifies the retained
namespace, uses an independently owned READ COMMITTED transaction, and reserves the
immutable claim with an explicitly injected development execution window. Expiry comes
from an authoritative database-clock read. Application/database clock disagreement
fails closed under the existing Phase A checks; it never substitutes a local TTL.

An exact T1 COMMIT_ACK proves reservation only. ACK loss permits one bounded separate
transaction to lock and freshly read the matching retained claim. Positive validated
claim evidence may establish reservation; a miss cannot establish reservation failure
or historical rollback. Never rebind a key or renew an existing expiry. T1 does not hash
passwords, create accounts, write accepted results or implement HTTP replay.

## D04 Option A terminal event

Add append-only `signup_idempotency_terminal_events`: one claim FK/PK, fixed
`signup.expired` event, policy version 1, finite observed/recorded timestamps. It is
both the canonical terminal decision and its mandatory immutable security event.
It has no user subject because expiry may precede account creation; it never invents
`identity.user_created`. Existing audit, claim and accepted-result schemas stay sealed.

Conforming execution writers hold the claim lock continuously, perform a separate
fresh accepted-result read first, then read the terminal event before considering
the clock. A committed accepted result permits replay after expiry. Without a result,
a retained valid terminal event permanently forbids new execution. Otherwise a fresh
expired observation may append a pending terminal event in the normal policy-owning
transaction. A 409 requires exact ACK or a subsequent authoritative terminal proof.
No uncommitted observation becomes a claimed durable refusal. T3 never inserts terminal
events; a timestamp-only miss in recovery remains controlled retryable failure.

After a terminal decision commits, backward wall-clock movement cannot reopen execution
eligibility for that binding. This does not enforce an unobserved absolute elapsed-time
deadline. An eligible writer may commit after its start cutoff while retaining the lock.
Retention is indefinite for development; no cleanup or production retention policy is
approved. The execution window is injected, not silently selected as a public contract.

Runtime INSERT-capable writers remain trusted under the Phase A threat model. A
compromised writer/owner can fabricate state; this design does not claim tamper evidence.
Result/terminal coexistence is an integrity incident: preserve validated accepted proof,
stop new execution and retain both facts. All writers must adopt the lock/read protocol
before activation; old/new writer overlap is forbidden operationally.

## Acceptance and rollback

Required isolated tests cover fixed HMAC vectors and drift; missing/mismatched anchors;
runtime namespace-write denial; terminal mutation/deletion/invalid-row denial; T1 lost
ACK and immutable expiry; terminal commit/rollback/ACK loss; clock reversal after commit;
concurrent writer/terminalizer locks; fresh result precedence; migration snapshots and
the full effective permission inventory. Clock faults use a test clock/UUID fixture;
machine clocks and live state are untouched. Evidence is recorded at the exact CI head.

Production still requires approved secret-manager injection and attestation anchor,
fleet consistency/quiescence, trusted primary lineage/durability, retention/privacy
review and independent security approval. Rollback disables signup and drains/contains
owners; retain namespace, claims, results, terminal events and audit history. Never
reverse migrations by deleting retained state or restore an unkeyed writer into service.
