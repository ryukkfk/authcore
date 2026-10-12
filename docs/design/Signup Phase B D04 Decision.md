# Signup Phase B D04 Decision Record

> Pending owner decision, 2026-10-12. Documentation proposal only.
> Baseline: `a0bd2d7ff6499e393a3dabb46617f6292f23c84e`.
> No S1-S6 implementation or schema/grant change is authorized.
> `SIGNUP_ENABLED=false`; no production-readiness or activation approval.

## Decision requested and finding

**Pending: the owner must select the expiry semantics and implementation path.**
Recommended when permanent terminal rejection is required: option A, durable
append-only terminalization under the same claim lock, with a separately approved
schema/permission design. This review implements nothing and changes no grants.
D04 blocks S2/expiry integration; it does not prevent separately authorized S1
owner work that has no expiry policy implementation.

The original timestamp-only proposal implied Expired -> Expired forever. That claim
is false under backward database-clock movement. Example: immutable expires_at=12:00;
a locked fresh no-result request reads clock_timestamp()=12:01 and returns 409;
after clock correction to 11:59, another request can satisfy now < expires_at and
become eligible. Binding/expiry bytes never changed. Holding the row lock serializes
the reads but does not remember the previous expired observation. This P1 finding
is a design counterexample, not a backward-clock experiment executed by S0.

S0-05 verified immutable binding/expiry and independent reservation; S0-06 verified
lock/fresh-read schedules. Neither creates durable terminal expiry. See
[S0 evidence](Signup%20Phase%20B%20Test%20Plan.md#s0-verified-evidence),
[Phase A schema](../../packages/db/src/schema/signup-idempotency.ts),
[migration](../../packages/db/drizzle/0003_signup_idempotency.sql) and
[permissions](../../packages/db/permissions/signup-runtime-role.sql).

## Semantics that must be chosen explicitly

Distinguish three statements:
1. The current clock predicate rejects a new execution start at this observation.
2. A committed terminal decision permanently forbids future execution starts for this
   retained binding, even if time moves backward.
3. Every claim irreversibly expires at a real elapsed-time deadline, even when no
   request observes it and across restart/failover/clock correction.

Timestamp-only can implement 1, not 2 or 3. Option A can implement 2 after durable
terminalization, not 3 merely from a wall-clock timestamp. Crash before the terminal
decision commits means a local observation is not yet a durable rejection.
An operationally trusted time/epoch protocol would be needed for a stronger 3.
The owner must not approve a permanent absolute deadline while selecting a weaker
mechanism. Proposed 24h duration and execution-start (not COMMIT-time) cutoff remain
separate pending policy choices.

## Viable options and compatibility

| Option | Guarantee and cost | Phase A / permission / retention impact | Recommendation |
| --- | --- | --- | --- |
| A: append-only terminal expiry decision | Once a matching EXPIRED decision commits, future new execution starts stay forbidden regardless of clock reversal. Extra durable write/read and lost-ACK reconciliation; cannot persist an uncommitted observation or prove an unobserved real-time deadline | Preserve immutable claim binding/expiry and accepted result CHECK. Requires a separately reviewed terminal table/unique FK or equivalent authorized durable state, migrations, narrow INSERT/SELECT grants and revised effective-permission tests. Retain terminal facts indefinitely; no deletion | Recommended if durable terminality is required; no approval inferred |
| B: current-clock execution-start policy | Reject when a fresh authoritative timestamp is at/after expiry. Conservative margin can reject earlier; no permanent monotonic guarantee under unbounded backward changes. Minimal SQL, lower operational cost | No schema/grant change; five-table boundary preserved. Same retained binding can become eligible again after an earlier timestamp-based 409. At-most-one accepted result still depends on row lock/result protocol | Only acceptable for bounded development if owner explicitly accepts non-monotonic expiry, client semantics and clock-fault risk |
| C: reviewed monotonic time/epoch authority | Durable shared high-water/epoch or trusted bounded-uncertainty time protocol can avoid selected reversals; semantics/failover availability must be specified. Logical event counters do not equal elapsed 24h | Persistent shared state/service or epoch retirement design, migrations/grants and rollout authority likely required. Per-process monotonic timer/cache cannot cover multiprocess restart/failover; no existing primitive here provides this | Defer unless stronger real-time requirement justifies complexity |

A mutable terminal column is another variant of A, but would require new UPDATE
privileges and state-transition checks. Prefer append-only terminal facts for review
because the Phase A claims stay immutable. Do not repurpose lock_anchor=false,
broaden UPDATE, insert a fake accepted result, change expires_at, or use audit events
as the canonical expiry store. Existing claims/results have no valid EXPIRED encoding.

A conservative skew allowance alone is not a proof of permanent expiry. A durable
high-water timestamp can itself be driven far forward by a bad clock, denying work
forever; correction/reset needs a reviewed protocol. PostgreSQL sequences, transaction
IDs, WAL positions, Redis TIME and local performance.now are not a demonstrated
durable elapsed-time oracle for this namespace.

## Option A proposed protocol, conditional on separate approval

This is a design sketch requiring a schema/grant review before implementation:
- Retain a unique append-only terminal record tied to the unchanged claim identity,
  e.g. EXPIRED, with an auditable policy version/reason. Do not prescribe DDL here.
  Runtime cannot update/delete it; owner maintenance is prohibited initially.
- Every execution writer locks the retained claim, verifies ID/binding, reads immutable
  accepted result in a separate fresh statement, then reads any terminal fact before
  considering time. Result proof replays 202 even after the nominal cutoff.
- An already-authorized writer holds the same lock continuously through accepted
  result COMMIT. A terminalizer waits for it, then checks result first. It cannot
  expire a claim concurrently with a conforming writer that may still commit.
- If no accepted result and a terminal fact exists, reject new work permanently.
  If neither exists and the fresh clock predicate is expired, a normal policy-owning
  transaction may append EXPIRED and commit with typed D06 classification.
  Return terminal 409 only after exact ACK or fresh authoritative terminal proof.
  Lost ACK/unknown terminalization -> 503 until reconciled; no false terminal claim.
- A crash/rollback before terminal commit cannot establish irreversible expiry.
  The terminal record takes effect at its durable commit, not at an earlier volatile
  clock observation. Natural deadline crossing without a persisted decision remains
  subject to the chosen time assumptions.
- T3 remains strictly no-domain/result/terminal writes. It may read terminal facts
  under the lock. A mere expired timestamp with no durable terminal proof yields
  retryable 503 under option A; a later normal request may terminalize under its
  separately approved protocol. Never add a hidden T3 maintenance mutation.
- All writers/versions must participate before activation. Accepted-result/terminal
  coexistence should be impossible for conforming writers; if observed, treat it as
  an integrity incident, stop new execution, and preserve already validated accepted
  proof under D06. Do not erase either record to make tests pass.

The sixth relation/equivalent state would change the current five-table provisioning
contract and S2/S4 scope. Approving D06 or S1 does not authorize that migration or grant
change. If owner selects A, revise the architecture ADR, restricted-role whitelist,
denial tests, terminalization auditing, F20/P08 and S2/S4 acceptance before coding it.
No new table, role, SQL migration or grant is part of this correction PR.

## Option B proposed contract, only if explicitly accepted

Keep the five existing tables/grants, no terminal state. Under the claim lock after
fresh result miss, compare clock_timestamp() with immutable expires_at; expire at
that observation. D04 rejection is repeat-evaluated and may reverse after clock
correction. A 409 is a current policy refusal, not a permanent state transition.
Clients still must not auto-change key/payload to bypass unresolved prior work.

Monitor observed clock regressions and fail closed on detected uncertainty, but do
not claim that process-local detection is complete across restarts or the fleet.
Conservative early cutoff reduces a known bounded-skew risk only under a separately
accepted bound; it does not solve arbitrary reversal. No rollback or rebinding follows
from expiry. Retained accepted results always replay, and pre-cutoff authorized work
may commit late. Unexpected hint-active/hint-expired disagreement cannot cause hash
work while holding T2 or domain writes without all prerequisites.

## Required policy acceptance and tests

Owner must explicitly choose A/B/C, the precise terminality statement, duration,
execution-start versus COMMIT-time cutoff, clock fault/uncertainty handling, client
409 semantics and compatibility cost. If stronger elapsed-time expiry is mandatory,
do not pretend option A alone meets it. D07 retention/no-cleanup and D11 lineage also
apply to any terminal proof; privacy/storage review is required for added facts.

Future P08/F20 tests must cover:
- 12:01 expired observation followed by 11:59 eligibility under B (negative limitation).
- A committed terminal record survives backward clocks/restart/concurrent writers;
  only accepted-result proof permits replay, not new domain execution.
- A pre-commit terminalizer crash/lost ACK uses D06 uncertainty/proof correctly;
  no uncommitted observation becomes a claimed permanent decision.
- A writer authorized before cutoff commits late; terminalizer waits and returns
  replay, never an incompatible terminal outcome.
- Real lock/read schedules, restricted-role denial for any proposed terminal write,
  no history mutation/expiry renewal, unchanged frozen HMAC binding and no cleanup.
- T3 reads only; timestamp miss without terminal proof under A remains 503.
Clock changes must use an isolated test clock/fixture or separately authorized
disposable infrastructure; never change machine/production clocks to manufacture proof.

Remaining operational assumptions: trusted primary lineage, every writer participating,
time fault detection and retention/privacy budgets. S0 does not prove these.
[PostgreSQL date/time semantics](https://www.postgresql.org/docs/17/functions-datetime.html)
explain transaction-start time versus current wall-clock functions; neither is a
documented permanent monotonic claim-expiry protocol.
