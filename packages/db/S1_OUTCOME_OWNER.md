# S1 outcome-aware transaction ownership

Development implementation under validation. Signup remains disabled by default;
AUTH-001, production activation and independent security review remain open.
The mission authorization adopts corrected D06 for development. Historical S0 and
the blocked S1 evidence remain available at their original commits.

## Driver prerequisite

A1 at `f969f2a559ec0be9e961e12d524f6a990e6c4177` passed
[exact-head CI](https://github.com/ryukkfk/authcore/actions/runs/38350192559).
Its public checkout-scoped disposal contract replaces application access to private
connection streams. This branch merges that history normally; it does not alter the
historical protected S1 checkout. The upstream package pins and patch hashes remain
unchanged. No schema, privilege or secret change belongs to S1.

## Outcomes and evidence

`runOwnedSignupTransaction` uses explicit READ COMMITTED and transaction-local
synchronous_commit=on, and returns an internal evidence envelope. Phase, outcome,
cleanup health and service-owned business proof remain distinct. COMMIT dispatch
sets COMMIT_UNKNOWN before calling the driver. Only the exact single-command COMMIT
tag establishes COMMIT_ACK. ROLLBACK establishes COMMIT_ROLLBACK and never exposes
the callback value. An unrecognized or ambiguous response stays COMMIT_UNKNOWN.
No later cleanup rollback is sent to reinterpret an unknown COMMIT.

Before COMMIT, an exact acknowledged ROLLBACK may advance NOT_SUBMITTED to
ABORT_CONFIRMED. Socket closure, elapsed time and generic SQLSTATE text do not.
The first operation failure is frozen before cleanup, preserving an already observed
PostgreSQL fatal SQLSTATE over later generic symptoms. Raw errors and diagnostics
are internal only. A maximum of 32 diagnostic objects is retained per owner.

COMMIT_ACK survives cleanup errors. A transaction ACK is not by itself signup
acceptance: S4 must validate atomic result insertion or a fresh authoritative immutable
result. `AcceptedProofLatch` provides a monotonic holder; it does not validate a proof
or turn arbitrary callback values into acceptance.

The evidence getters can reflect a late correlated command completion and late
disposal receipt. `value` is accessible only with COMMIT_ACK. Late completion does
not launch retries. Services must latch validated business proof outside catch/finally.

## Ownership and deadlines

An explicit per-pool registry caps active plus unresolved owners at pool max. It owns
queued acquisitions from submission until failure or late checkout disposal. A timed
out or cancelled waiter cannot BEGIN or start work. A retained registry entry consumes
owner capacity even after local transport removal, until all observed operations settle.

Normal targets are acquisition 1s, BEGIN/setup 1s, transaction 15s from BEGIN ACK,
and one aggregate cleanup 1s. Recovery uses acquisition 1s and a 3s transaction clock
starting before BEGIN, including setup. Server profiles remain lock/statement/idle/
transaction 1s/5s/3s/15s normally and 500ms/1s/1s/3s for recovery.

Timers revoke callback SQL capability and initiate actual driver disposal. They never
fabricate settlement. If cleanup remains unresolved after its target, health stays
QUARANTINED_WITH_OWNER; settlement and the registry expose continued ownership.
Callbacks may retain non-SQL work: the compatibility API waits for both `workSettlement` and owner `settlement`
before returning so existing admission cannot release while work or local transport
ownership continues. Detailed service callers may inspect a bounded outcome envelope,
but must retain admission until both settle; responding does not release ownership. Event-loop
stalls, native work and unresolved transport setup preclude whole-request hard bounds.

The Drizzle adapter serializes and observes submitted queries. It exposes only execute,
insert and select, rejects transaction control and multiple statements, and rejects all
later submissions after work ownership ends. The conservative scanner accepts SELECT,
INSERT and SET LOCAL; quoted values remain parameters. Dollar-quoted SQL and backslash
escapes in raw SQL are deliberately unsupported. This is a trusted internal repository
boundary, not a general SQL sandbox or a replacement for database privileges.

Failed owners dispose once; they never retry release. Only successful healthy owners
return the client to idle. The application shutdown hook revokes new owner admission,
stops current owners, awaits registry settlement, then ends the pool. A stalled owner
keeps shutdown unresolved; process containment is an operational decision, not a clean
shutdown receipt.

## Validation and rollout

The two inherited false-success/release-mask tests were RED against the original owner
after integrating A1. Inherited fixture assertions now use the public disposal contract
and preserve failure precedence, actual synthetic closure and no-double-release checks.
New deterministic schedules cover outcomes, acquisition, shutdown, stalled COMMIT,
quarantined cleanup, stale adapters and proof retention. Required PostgreSQL tests
include exact tags and independent committed-marker witnesses, actual cancelled pool
waiters, and a proxy that withholds COMMIT ACK while keeping transport open.

The server lifetime SQLSTATE regression starts a disposable connection with a stricter
1s timeout and proves that owner setup preserves it, observing 25P04 before the 15s
owner target. PostgreSQL 17 does not reschedule an active positive transaction timeout
when its setting changes to another positive value. Therefore the owner captures the
original session setting, installs its cap before BEGIN, and restores the original
after a healthy ACK or confirmed rollback. A stricter inherited cap is preserved.
Restoration is cleanup; its failure cannot erase COMMIT_ACK. A real test covers a
30s inherited setting clamped to 15s and restored before healthy reuse. It does not assert which equal-deadline mechanism wins. The proxy recovery
case separately measures the real 3s owner deadline with a committed server witness.

Exact-head CI and the remaining adversarial tests must pass before S1 acceptance.
Keep the PR Draft pending independent security review. Rollback keeps signup disabled,
stops admission, owns or contains unsettled work, and restarts on an approved artifact.
Never hot-swap active owners, retry unknown domain writes, or delete retained evidence.
