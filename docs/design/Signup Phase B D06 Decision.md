# Signup Phase B D06 Decision Record

> Pending owner decision, 2026-10-12. Documentation proposal only.
> Baseline: `a0bd2d7ff6499e393a3dabb46617f6292f23c84e`.
> No S1-S6 implementation or schema/grant change is authorized.
> `SIGNUP_ENABLED=false`; no production-readiness or activation approval.

## Decision requested

**Recommended, not approved:** adopt the typed evidence model, monotonic business-proof
latch, error precedence, ownership rules and acceptance criteria below for S1.
Approve the budgets as test targets, not as guarantees already established by S0.
D01 still owns the public response contract; D06 specifies internal evidence and
precedence. S1 remains limited to owner/types and owner/admission security tests.
T1/T2/T3 and HTTP integration are later slices, not current implementations.

Evidence: [S0 inventory and classification](Signup%20Phase%20B%20Test%20Plan.md#s0-verified-evidence),
[PR #12](https://github.com/ryukkfk/authcore/pull/12) at
`822062fea79fad3e5a8547dc9f7b40b999f7cb71`,
[CI #28](https://github.com/ryukkfk/authcore/actions/runs/38232288230).
Nine real cases passed with zero skips. Passing KNOWN GAP assertions exposed
defects; they did not establish correct owner behavior.

## Typed evidence contract

Keep three independent axes; names below are proposed types, not exported APIs.

1. Transaction phase: ACQUIRING, ACQUIRED, BEGINNING, WORK, COMMIT_DISPATCH,
   TERMINAL, DISPOSING. One owner controls all operations on one checkout.
2. Transaction outcome: one of the discriminated records below. Every record carries
   transaction identity/phase and structured evidence provenance internally.
3. Cleanup health: CLEAN, EVICTED, or QUARANTINED_WITH_OWNER, with fixed reason codes.
   Cleanup health never rewrites transaction evidence or accepted business proof.

| Transaction outcome | Required evidence and meaning |
| --- | --- |
| NOT_SUBMITTED | Owner never attempted COMMIT dispatch. This is knowledge of local submission, not server-confirmed abort or backend lock release |
| ABORT_CONFIRMED | Correlated server-confirmed abort of this transaction, such as acknowledged pre-COMMIT ROLLBACK or a separately tested phase/command-specific abort response. Preserve SQLSTATE/tag evidence |
| COMMIT_UNKNOWN | Set conservatively immediately before invoking COMMIT dispatch; retain on timeout, socket loss, ambiguous response, or unrecognized tag. Driver rejection does not establish non-commit |
| COMMIT_ACK | Exact single-command `COMMIT` result.command verified for this owned transaction. Promise resolution without tag validation is insufficient |
| COMMIT_ROLLBACK | COMMIT query returned exact `ROLLBACK` tag. This transaction aborted; never expose the callback's value as committed work |
| Other/unrecognized command completion | Protocol/invariant error; preserve COMMIT_UNKNOWN and evict. Never accept arbitrary resolved commands |

NOT_SUBMITTED can advance to ABORT_CONFIRMED with proper server evidence.
COMMIT_UNKNOWN can advance to COMMIT_ACK, COMMIT_ROLLBACK or a proven correlated
abort; a later unrelated/no-op ROLLBACK cannot classify an earlier unknown COMMIT.
COMMIT_ACK/COMMIT_ROLLBACK are terminal for that transaction. Query ordering and
the owning adapter must establish correlation; SQLSTATE text alone is insufficient.
Callback code must not issue transaction-control commands independently of the owner.

A separate BusinessProof is NONE or ACCEPTED with one or both of these provenance
records, scoped to the matching retained claim and approved authoritative lineage:

- T2_ATOMIC_COMMIT: exact COMMIT_ACK for a T2 that inserted the constrained accepted
  result in the same transaction as required domain/audit writes, or valid duplicate
  handling. Generic callback success, an INSERT result, and T1 reservation COMMIT
  are not signup acceptance.
- IMMUTABLE_RESULT: a fully completed fresh authoritative result SELECT, validated
  against the retained claim ID, frozen binding, result version, exact status/body
  and trusted primary lineage. It must be outside the reader's own uncommitted
  result writes. T3 locks then uses a separate READ COMMITTED statement.

T1 COMMIT_ACK establishes reservation only. A proven retained claim after T1 ACK loss
still does not imply signup accepted. Immutable-result proof may establish acceptance
while the original transaction's outcome remains unknown; do not rewrite its history.
The latch belongs to the request/outcome envelope, outside transaction callbacks,
catch/finally blocks and cleanup helpers. Only NONE -> ACCEPTED is allowed. Cleanup,
Redis failure, disconnect or later rollback cannot clear or downgrade it. Proof cannot
be fabricated from an unvalidated result or an uncertain replica/lineage.
This guarantee assumes the asserted trusted lineage/history remains valid; acknowledged
data loss or forged rows is an assumption breach requiring operator containment.

## Response and error precedence

Apply this order after attempting bounded owned disposal; retain diagnostics separately.

1. Valid ACCEPTED proof wins over operation, recovery, cancellation and cleanup errors:
   exact generic 202 if the client is still connected. If disconnected, preserve the
   proof/outcome; delivery failure is not transaction failure. Never retry domain work.
2. Without proof, an integrity/binding/lineage prerequisite failure forbids execution.
   Claim missing/replaced or uncertain lineage -> controlled 503; permission/invariant
   defect -> safe 500 under the HTTP contract. No replacement claim or grant relaxation.
3. A synchronized policy-authorized expiry rejection maps to 409 only under the selected
   [D04 policy](Signup%20Phase%20B%20D04%20Decision.md). A timestamp observation is not
   durable terminal proof. Failed T3 cleanup without accepted proof yields 503.
4. ABORT_CONFIRMED / COMMIT_ROLLBACK / NOT_SUBMITTED without business proof never
   returns callback success. Transient/timeout/cancellation -> controlled 503; an
   unexpected non-transient work defect -> safe 500. COMMIT_ROLLBACK without a known
   transient cause is an invariant failure (500), not a blanket transient retry.
5. COMMIT_UNKNOWN permits at most one bounded no-domain-write recovery attempt.
   No positive proof -> 503 with proposed Retry-After: 1; same binding on client retry.
   A missing result, closed socket or Redis TTL never converts unknown into abort.

Freeze the primary operation failure before cleanup. Preserve the first relevant
correlated PostgreSQL fatal SQLSTATE over a later generic socket symptom, otherwise
the exact operation/setup/cancellation error; preserve phase and timestamps. Do not
let rollback/end/release replace it. Later server evidence may refine outcome, while
a valid business proof may supersede the error for response selection. Keep primary
and cleanup diagnostics in separate fields; never serialize raw errors/SQL to clients.
A cleanup-only error with no proof cannot invent success or erase uncertainty.

## Ownership, cancellation and eviction contract

- Acquisition belongs to the owner from the moment it is queued. Race completion with
  cancellation/deadline through an adapter that removes the waiter or owns eventual
  delivery. A bare Promise.race that abandons pool.connect is forbidden.
- If cancellation/deadline wins, a later checkout must never BEGIN or call work. Its
  dedicated disposal continuation destroys/evicts it once. Retain an explicit local
  ownership record until the acquisition is cancelled conclusively or late disposal
  settles. This is resource cleanup, never a detached business retry.
- Register transport/error listeners before BEGIN; one checkout, serialized commands,
  no query on a released client. A client with an in-flight query cannot return idle.
- Before COMMIT dispatch, cancellation stops new writes and attempts bounded rollback.
  Once dispatch may have occurred, cancellation/CancelRequest is not rollback proof.
  Classify/recover conservatively; never resend COMMIT or launch recursive account work.
- Every query rejection is observed. Stop/cancel actual transport and await local
  query/close settlement, not only the caller's wait. A timer or end() invocation
  alone is not evidence of server rollback or pool removal.
- Evict any failed, fatal, unknown, cancelled or protocol-invalid checkout. Return a
  healthy client only after exact terminal evidence, no pending work, and healthy
  transport. Handle release throwing before or after pool removal without double
  release; an isolated cleanup exception must not strand a live checkout as S0-04 did.
- If disposal cannot complete within target, disable further writes on that transport,
  quarantine it under an explicit process-local cleanup owner, retain the appropriate
  local capacity reservation, and mark health degraded. Do not report cleanup CLEAN
  or silently free capacity. No new worker/service or background domain retry is proposed.
  Owner implementation must show disposal progress and bounded retention behavior;
  if it cannot, S1 acceptance fails rather than asserting settlement.
- Local closure prevents future client commands; server completion/lock release needs
  server evidence or a later conforming lock barrier. Admission is held through actual
  work/local transport settlement, including native hash work; no false fleet-wide cap.
- Shutdown drains/retains ownership of late acquisitions and disposal callbacks; no
  unhandled rejection, untracked socket, duplicate release or post-response work start.

## Budget reconciliation and recommended targets

Current source: [pool](../../packages/db/src/client.ts),
[owner constants and timeout installer](../../packages/db/src/signup-transaction.ts).
S0-07 real evidence covers ordinary failure eviction, not every deadline schedule.

| Boundary | Existing implementation | Proposed target / evidence needed |
| --- | --- | --- |
| Acquisition | Pool connectionTimeoutMillis=5000; owner awaits pool.connect without its own cancellation/deadline contract | S1 owner target 1s, explicit waiter/late-checkout ownership; test queue saturation and slow connect. Do not claim pool timeout alone solves cancellation |
| T1/T2 lock | SIGNUP_LOCK_TIMEOUT_MS=1000 | Preserve 1s; lock timeout is per acquisition, not whole transaction; enclosing transaction deadline required |
| T1/T2 statement | SIGNUP_STATEMENT_TIMEOUT_MS=5000 | Preserve 5s server target; add owner/transport deadline for missing ACK. A server-completed statement can still have a lost response |
| T1/T2 transaction | SIGNUP_TRANSACTION_TIMEOUT_MS=15000 | Preserve 15s from successful BEGIN, including work/COMMIT owner deadline; setup and BEGIN also bounded; server timer is a backstop |
| T1/T2 idle | SIGNUP_IDLE_TRANSACTION_TIMEOUT_MS=3000 | Preserve 3s; not active-query or COMMIT-response protection |
| Teardown | SIGNUP_TEARDOWN_TIMEOUT_MS=1000 | One aggregate 1s cleanup target covering rollback, end/close and eviction; avoid sequential 1s rollback plus another 1s termination being called one second |
| T3 recovery | No implemented T3 | Separate 1s acquire + 3s whole transaction (1s statement, 1s idle, lock target 500ms) + 1s aggregate disposal: nominal 5s; remaining request budget must allow it |

Prefer T3 lock 500ms below its 1s statement target: equal 1s lock/statement timers
cannot reliably distinguish which fires first. T3 uses a separate timeout profile;
do not globally reduce existing 5s/15s owner constants or bypass other callers.
T3 owns its 3s clock from before BEGIN dispatch, including BEGIN and timeout setup; no unbudgeted setup phase is added. Nested statements/lock waits consume remaining transaction budget, not fresh budgets.
The nominal T1/T2 ceiling is 1s acquire + up to 1s bounded BEGIN/setup + 15s transaction
+ 1s disposal; actual design of setup timing must fit this envelope, not restart it.
S1 must validate exact timer start points against the driver and PostgreSQL 17.

No hard whole-request wall-clock bound is proven: native Argon2, event-loop/OS stalls,
driver queue cancellation, network/server partitions, multiple T1/T2/T3 phases and
shutdown can exceed response targets. Monotonic process elapsed time is for local
deadlines, not durable claim expiry. PostgreSQL timeouts are server-side; they cannot
prove delivery of the ACK. No timeout can turn a potentially sent COMMIT into abort.
These budgets are recommendations needing owner acceptance and real/synthetic tests,
not measurements from S0.

## S1 acceptance and remaining risks

S1 is ready for coding only after explicit D06 and slice authorization. Required:
- Change the future owner tests from S0-03 false-success expectations to exact
  COMMIT_ROLLBACK/abort expectations; callback value must not escape as success.
- Change S0-04 future owner tests to preserve committed work/proof despite injected
  release failure, with retained-checkout disposal verified. Test release-before-
  removal, release-after-removal and subsequent cleanup failures separately.
- Preserve historical PR #12 characterization unchanged as evidence. New S1 tests
  should fail against the old owner for the two real defects; passing historical
  KNOWN GAP tests is not an S1 correctness gate.
- Repeat real committed-but-ACK-lost witness, definite abort, exact tag and backend
  eviction tests; verify no pending command is reused. Preserve SQLSTATE precedence.
- Add cancellation/late-checkout, queued acquisition, stalled COMMIT, deadline-vs-ACK,
  delayed end and shutdown schedules. Synthetic timers establish scheduling contracts;
  real pool/backend tests establish transport and ownership effects.
- Add owner-level immutable proof injection tests across catch/finally/rollback/end/
  release/Redis/disconnect faults. Full T3 repository/service/HTTP proof-latch tests
  belong to S4/S5; do not claim they exist at S1.
- Run normal regression gates at the future implementation head, with no weakened
  assertions/security controls or silently skipped required real cases.

Residual risks: authoritative-lineage loss, compromised INSERT-capable writer,
unvalidated secret namespace, event-loop stalls, cleanup quarantine exhaustion,
unproven restricted-role advisory builtin availability and global Argon2 overshoot.
These remain D03/D05/D08/D11/D12/D13/operational decisions. D06 approval alone does
not approve them or D04, enable signup, authorize migrations/grants, or merge a PR.

Primary references:
[PostgreSQL command tags](https://www.postgresql.org/docs/17/protocol-message-formats.html),
[message/cancellation flow](https://www.postgresql.org/docs/17/protocol-flow.html),
[timeout behavior](https://www.postgresql.org/docs/17/runtime-config-client.html),
[node-postgres pool ownership](https://node-postgres.com/apis/pool).
