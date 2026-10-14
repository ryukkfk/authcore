# S4 internal signup orchestration

Development implementation of T1/T2/T3 using the audited A1 driver, S1 owner, S2
attested binding/terminal ledger and S3 fixed PostgreSQL capacity gate. Independent
security review remains pending. Public HTTP wiring is S5; this internal service
never enables signup. Default remains `SIGNUP_ENABLED=false`; AUTH-001 is incomplete.
No live database, secret, namespace seed, privilege or production activation changes.

## Request proof and actual work ownership

`IdempotentSignupService.start` requires an explicit active local/Redis admission
capability. It exposes a response promise separately from actual settlement. A
request-owned NONE -> ACCEPTED proof holder is outside every callback/catch/finally.
Only an exact T2 COMMIT ACK for atomic accepted-result writes, or a validated fresh
committed result from T1/T2/T3, may latch it. Own uncommitted results never count.
Proof is retained through rollback, release/disposal, Redis failure and cancellation.

Early proven response does not free capacity. The admission owner retains the whole
flow, native Argon2 promise and all owner work/transport settlements; renewal continues
until retained work settles or lease loss is observed. Shutdown rejects new admission,
cancels active owners and waits without inventing successful drain. An unresolved
quarantine remains explicit and bounds local capacity. Closed response contexts cannot
register/start new work. Legacy `SignupAdmission.run` still waits for both axes.

A later correlated ACK may refine business evidence while actual settlement remains
owned. A response already delivered during genuine uncertainty cannot be rewritten;
clients retry the same key/payload to obtain retained evidence. Local closure never
proves server rollback, and missing results never prove historical rollback.

## T1 and frozen validated input

The boundary prepares an immutable snapshot after DTO validation, then computes the
unchanged HMAC v1 tuple. This prevents later caller mutation from changing the password
or email used by domain writes. Startup and each stage verify the durable namespace,
retained versions and connected-primary durability assumptions. No fallback/rotation.

T1 independently reserves/commits the immutable claim. Lost ACK permits only the S2
matching retained-claim recovery. Fresh accepted result observations happen before
fallible cleanup and can short-circuit hashing. Claim proof alone is not acceptance.
Expiry is never renewed/rebound. Database-time observation is merely a hashing cost
hint; T2 independently synchronizes and decides authorization. No new hashing, domain
attempt or recovery starts after an early finalized response. Already-owned transaction
ending and cleanup remain retained until settlement. Native hashing runs outside SQL locks.

## T2 atomicity and duplicate semantics

T2 acquires capacity before the claim, verifies the known claim identity/binding/expiry,
and uses a separate fresh result read after the row-lock barrier. A committed result
latches accepted proof before transaction end/cleanup. Otherwise D04 Option A determines
eligibility/terminal refusal; a new terminal event needs exact ACK or retained proof.

An eligible new account inserts user, Argon2 credential, mandatory user-created audit
and exact immutable accepted result atomically. Only `DuplicateUserEmailError` from the
reviewed targeted ON CONFLICT path is caught. A pre-existing account receives the same
generic accepted result without replacing credentials or fabricating user-created audit.
Other SQL/application failures abort; callback return never substitutes for COMMIT proof.

An expired cost hint that becomes eligible after clock movement cannot cause hashing
inside T2 or a hidden second domain attempt. It returns controlled retryable failure;
a later explicit request must independently synchronize again. Retained terminal facts
always take precedence over timestamp eligibility; accepted result replay has priority.

## T3 and failure precedence

Unknown T2 permits at most one recovery after the original local transport is settled.
A quarantine returns retryable uncertainty while retaining actual ownership; it never
starts detached recovery. T3 uses the separate bounded profile, capacity then claim,
namespace/known-binding checks and a fresh result read. It never reserves/hashes/creates
an account or appends accepted/terminal records. The owner read-end mode rejects INSERT
before SQL and ends with a checked ROLLBACK. Its ABORT_CONFIRMED describes only T3, not
the original T2. A missing result remains uncertainty and never causes internal creation
retry. Terminal timestamp alone is insufficient for durable409.

Validated acceptance outranks later cleanup/primary errors. Without proof, identified
permission/protocol/integrity failures produce a fixed internal failure; transport,
capacity, cancellation and unresolved history produce controlled retryable failure.
Conflict/refusal is stable and contains no account-existence information. No raw SQL,
exceptions, credentials, key/digests or password hashes enter operational telemetry.
The operation exposes only allowlisted owner outcome/cleanup/phase/count evidence.

## Validation and operational limits

Required real suite covers atomicity, actual Argon2 verification, identical/conflicting
concurrency, duplicate accounts, permission rollback, T1/T2 lost ACK, server ROLLBACK tag,
release/rollback/Redis failures, accepted proof during quarantined cleanup, native-work
cancellation, expiry, namespace drift and three actual process-crash schedules. Separate
witnesses inspect retained rows and server backend absence. Test secrets are explicit
public fixtures; child configuration travels through private stdin. Crash lease cleanup
removes only UUID members created in dedicated disposable Redis logical DB15; no FLUSH.
PostgreSQL databases/roles and all processes/transports have scoped cleanup ownership.
No synthetic result substitutes for this required real step; exact-head CI is the gate.

Production still requires independent human security approval, trusted primary/failover
lineage and durability, approved HMAC injection/anchor, retention/privacy/client policy,
fleet protocol adoption/quiescence and a hashing-capacity decision. Advisory slots do
not bound fleet Argon2 memory and Redis is not a PostgreSQL fence. No whole-request hard
wall-clock guarantee is claimed under native work, OS/event-loop stalls or quarantine.
Rollback disables/drains/contains signup and retains every claim/result/event/audit;
never deploy an unkeyed/ungated writer or delete retained history to simplify rollback.
