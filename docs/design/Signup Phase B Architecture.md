# Signup Phase B Architecture

> Design proposal for human review, 2026-10-12. Baseline:
> `a0bd2d7ff6499e393a3dabb46617f6292f23c84e` (merged documentation PR #10).
> No Phase B behavior is implemented or approved by this document.
> `SIGNUP_ENABLED=false`; AUTH-001 remains incomplete; production readiness is not established.

## Evidence and scope

The integrated baseline contains Phase A primitives, not HTTP idempotency. Historical
[CI #22](https://github.com/ryukkfk/authcore/actions/runs/38207585792) and
[post-merge CI #23](https://github.com/ryukkfk/authcore/actions/runs/38207873631)
passed 350 distinct tests: workspace 214, PostgreSQL 99, Redis 28, HTTP E2E 9.
CI #22 targets PR #10 head `c99699b8003ed069caac0ddb6f1eea5fb3ec6fc7`;
CI #23 targets the baseline merge above. Both job logs were inspected for those totals.
Those results do not verify Phase B
or constitute independent human security approval. Earlier evidence remains in the
[Integration Checkpoint](../Integration%20Checkpoint.md).

| Verified implementation | Evidence | Consequence |
| --- | --- | --- |
| `/api/v1/auth/signup` returns 202 and exactly `{"status":"accepted"}`; controller swallows only `EmailAlreadyInUseError` | [controller](../../apps/api/src/identity/auth.controller.ts) | Preserve generic success; move duplicate handling inside the future ledger transaction |
| DTO trims email, validates email and password length, rejects unknown fields through global pipes | [DTO](../../apps/api/src/identity/dto/signup.dto.ts), [bootstrap](../../apps/api/src/main.ts) | Validate before HMAC; preserve exact password string |
| Argon2 precedes transaction; user, credential and mandatory audit share one transaction | [service](../../apps/api/src/identity/signup.service.ts) | Keep hashing outside the account transaction; add result atomically |
| Targeted email conflict uses `ON CONFLICT DO NOTHING`, then throws a JavaScript domain error | [user repository](../../packages/db/src/repositories/user.repository.ts) | Catching this precise error inside the transaction leaves SQL usable |
| Transaction owner owns one checked-out client and teardown, but exposes no COMMIT classification and may throw on release after acknowledged COMMIT | [transaction owner](../../packages/db/src/signup-transaction.ts) | A success latch and explicit outcome state are prerequisites |
| Claims have unique versioned HMAC identity, immutable payload binding and expiry; results have claim PK, RESTRICT FK and exact accepted response CHECK | [schema](../../packages/db/src/schema/signup-idempotency.ts), [migration 0003](../../packages/db/drizzle/0003_signup_idempotency.sql) | Claim retention is essential; no mutable status/epoch exists |
| Reservation and locking are caller-owned primitives, not service orchestration | [ledger repository](../../packages/db/src/repositories/signup-idempotency.repository.ts) | Reservation must commit separately; `lockByKey` requires a transaction |
| Redis admission has four local/distributed slots, 30-second leases, 10-second renewals; `assertSignupLease` is a no-op without its async-local context | [admission](../../apps/api/src/identity/signup-admission.ts) | A lease can expire before a PostgreSQL transaction ends; future internal writers must not bypass the admission contract |
| Lock/statement/transaction/idle timeouts are 1/5/15/3 seconds; teardown is 1 second | [transaction owner](../../packages/db/src/signup-transaction.ts) | Timeouts reduce exposure, but do not prove COMMIT outcome |
| Restricted runtime has SELECT/INSERT on five tables and only column UPDATE on `lock_anchor=false` | [permission SQL](../../packages/db/permissions/signup-runtime-role.sql) | Keep all grants, CHECKs and protected history unchanged |

Additional inspected boundaries: [credential repository](../../packages/db/src/repositories/password-credential.repository.ts),
[audit repository](../../packages/db/src/repositories/security-audit-event.repository.ts),
[Redis transport](../../apps/api/src/redis/redis.service.ts),
[rate limiter](../../apps/api/src/identity/signup-rate-limiter.ts),
[exception filter](../../apps/api/src/common/filters/global-exception.filter.ts),
[database pool](../../packages/db/src/client.ts), and [password hashing](../../packages/crypto/src/password.ts).
The pool is max 10 per process, with a 5-second connection timeout. Argon2id uses
64 MiB memory, time cost 3, parallelism 1. These settings are not throughput measurements.

## Recommended protocol (proposed)

Use one authoritative PostgreSQL primary lineage, retained immutable claims, a
separately committed reservation T1, and a serialized account/result transaction T2.
Use Redis for rate limiting and admission; PostgreSQL determines whether domain work
can execute. No claim deletion, automatic expiry renewal or HMAC rotation is included.

The participating tables remain exactly `users`, `password_credentials`,
`security_audit_events`, `signup_idempotency_claims`, `signup_idempotency_results`.
No schema change is recommended for this first protocol. Owners/superusers can alter
history, and allowed runtime INSERT can fabricate new rows after credential compromise.
This protocol assumes trusted application writers and does not make storage tamper-evident.
Live use of restricted credentials has not been established.

1. Apply transport limits, disabled guard, rate limiting, header validation, admission
   and DTO validation in the order defined by the [HTTP Contract](Signup%20Phase%20B%20HTTP%20Contract.md).
   Compute frozen v1 HMAC binding using one explicitly injected, fleet-consistent secret/version.
2. T1: acquire a connection, explicitly select READ COMMITTED, install bounded timeouts,
   acquire one proposed PostgreSQL capacity slot, then call the existing `reserve` with
   an explicit finite future expiry computed from database current time plus the approved
   execution window. The existing application-clock validation and database CHECK remain;
   disagreement fails closed. Inspect an existing immutable result as a positive
   replay hint. Commit T1 **before hashing or any account writes**. Reservation is not success.
3. A committed accepted result permits replay without Argon2 or account lookup. If T1
   acknowledgement is lost, do not begin account work until a fresh bounded lookup
   establishes the retained matching claim; otherwise return 503. A miss proves nothing.
4. If no result is known and the claim appears active, hash the validated password
   outside T2, holding local/Redis admission. An expired hint skips hashing but still
   requires the authoritative T2 lock/result check. Hints never authorize writes.
5. T2: acquire one PostgreSQL slot, lock the same claim using `lockByKey`, verify its ID
   and immutable binding, then read results in a **separate statement after the lock**.
   A missing/replaced claim is an integrity/unavailability condition (503), not permission
   to reserve a substitute inside T2. A result returns the constrained 202 response.
6. If no result, compare `expires_at` with database `clock_timestamp()` after waiting.
   Expired means 409 without writes. Active means eligibility to begin this attempt;
   assert admission/cancellation immediately before domain mutations. The policy is
   an execution-start cutoff, not a wall-clock COMMIT deadline. An already authorized
   attempt may finish after expiry. This policy needs approval (D04).
7. Try user INSERT. A new user requires exactly one credential and mandatory
   `identity.user_created` audit INSERT. Catch **only** `DuplicateUserEmailError`
   inside T2: do not modify credentials or add a user-created audit for an existing
   account, including a legacy account without that audit. In either accepted path,
   append the fixed immutable result using `recordAccepted` before COMMIT.
8. COMMIT T2 using the proposed outcome-aware owner. Only acknowledged COMMIT or an
   authoritative committed result permits 202. Unknown outcome uses bounded recovery;
   no hidden recursive account retry. Response delivery is separate from database success.

Two different keys for the same normalized email may legitimately create two accepted
ledger results but only one user, one credential and one creation audit. A replay must
never rehash, replace credentials, recreate audit events, or query account existence once
its result is known. A racing hint miss can still cause unnecessary hashing before T2;
the lock/result check prevents repeated domain writes, not all repeated CPU work.
The target guarantee is at most one committed accepted outcome per retained binding;
aborted SQL attempts may repeat and HTTP delivery is not exactly-once.

```mermaid
sequenceDiagram
    participant C as Client
    participant A as API
    participant R as Redis
    participant P as PostgreSQL
    C->>A: Validated keyed signup
    A->>R: Rate and admission
    A->>P: T1 reserve retained binding
    P-->>A: T1 COMMIT acknowledged
    alt Immutable result already present
        A-->>C: 202 accepted
    else Result not known
        A->>A: Argon2 outside T2 if active hint
        A->>P: T2 slot then claim FOR UPDATE
        A->>P: Separate fresh result SELECT
        alt Result absent and execution eligible
            A->>P: User or duplicate path plus result
            A->>P: COMMIT
            alt COMMIT acknowledged
                A-->>C: 202 accepted
            else Outcome unknown
                A->>P: T3 lock then fresh result lookup
                A-->>C: Proven 202 or controlled 503 or expired 409
            end
        else Replay or expired claim
            A-->>C: 202 replay or 409 unavailable
        end
    end
    A->>R: Release after actual work settlement
```

## Synchronization and capacity boundary

Recommended lock order is **one transaction-level capacity slot -> one claim row ->
user unique index -> credential -> audit -> result**. No transaction handles two claims.
The proposed fixed four advisory slots use `pg_try_advisory_xact_lock(namespace, slot)`
with internal constants, never a client-controlled namespace. All T1/T2/T3 lock-capable
transactions participate; try slots nonblocking and release unsuccessful transactions.
At most one successful slot is held. Transaction end releases the slot on the server.
This needs restricted-role verification and approval; it is not implemented.

These slots bound participating PostgreSQL critical sections, **not fleet-wide Argon2
memory, total connections, or all SQL**. Redis expiry can admit another process while
an old process is hashing. Local admission still bounds each process until work settles.
If a hard fleet-wide hashing cap is required, a separately designed bounded worker
pool or database-backed execution lease is required; deployment remains blocked on
that policy. Do not call advisory slots a complete distributed memory cap.

## Assumptions, alternatives and limits

| Architecture | Correctness/recovery | Cost and compatibility | Recommendation |
| --- | --- | --- | --- |
| Claim row serialization, Redis capacity only | Per-key writes can be safe; global capacity can overshoot | No schema/grant changes; weakest overload boundary | Viable only with explicitly accepted capacity risk |
| Claim row plus transaction advisory slots | Same per-key proof; server-held bound on PG critical sections | No new table/migration; extra SQL and contention; builtin privileges must be verified | Preferred D05 |
| Mutable ownership/epoch or sixth capacity table | Can support additional fencing if every write validates it | New migration, permissions and protocol; conflicts with the present five-table boundary | Defer, not a shortcut |
| Redis lock as sole execution authority | Stale holder may still commit; unknown outcomes unresolved | Fast but fails required safety properties | Reject |
| Two-phase commit across PostgreSQL and Redis | Redis is not a PostgreSQL prepared-transaction participant | Operationally complex; no atomic bridge exists here | Reject |

READ COMMITTED must be explicit, not inferred from an uninspected server default.
The code currently issues plain `BEGIN`. Correctness assumes no owner cleanup/rebinding,
all writers using the protocol, one stable HMAC namespace, and no acknowledged-data loss
or split brain. Require an approved durability profile (`synchronous_commit=on`, fsync
and primary/failover guarantees) before operational adoption; live settings were not read.
During uncertain failover lineage, stop new writes and return 503 rather than treating a
stale replica miss as recovery evidence. No recovery reads from replicas.

See [Recovery and Fencing](Signup%20Phase%20B%20Recovery%20and%20Fencing.md),
[Decision Register](Signup%20Phase%20B%20Decision%20Register.md),
[Failure Matrix](Signup%20Phase%20B%20Failure%20Matrix.md), and
[Implementation Slices](Signup%20Phase%20B%20Implementation%20Slices.md).
