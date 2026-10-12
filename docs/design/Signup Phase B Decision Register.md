# Signup Phase B Decision Register

> Design proposal for human review, 2026-10-12. Baseline:
> `a0bd2d7ff6499e393a3dabb46617f6292f23c84e` (merged documentation PR #10).
> No Phase B behavior is implemented or approved by this document.
> `SIGNUP_ENABLED=false`; AUTH-001 remains incomplete; production readiness is not established.

## Status and approval model

All recommendations below are **pending owner/design approval**. No API, security,
retention or operational policy becomes approved because it appears here. Human approval
of selected slices authorizes only those slices; public signup, live migrations,
credentials, deployment and production readiness require separate authority.

| ID / choice | Preferred proposal and rationale | Realistic alternatives and cost | Approval / evidence still required |
| --- | --- | --- | --- |
| D01 Header and response API | Mandatory single v1 key on enabled-development signup; safe400,409,503 mappings; exact202 preserved | Optional key retains legacy bypass and two correctness contracts; reject preferred. Replay-specific headers add correlation surface | Owner approves breaking enabled-dev contract, generic DTO errors, no-store and retry semantics; real Node/ingress duplicate tests |
| D02 Transport/resource bounds | 16KiB decoded JSON, reject compressed bodies, bounded headers/request times, existing rate/admission order plus key guard | Existing parser defaults insufficiently explicit; smaller limit may reject Unicode DTO payloads; larger limits raise memory/CPU exposure | Confirm actual ingress/parser and exact header/time budgets; body413/415 adapter mapping tests before activation |
| D03 HMAC lifecycle | One explicitly injected32-byte dedicated secret and positive immutable version across all retained claims; independent config attestation | Multi-version lookup cannot alone make cross-version reservation atomic; rotate only with new reviewed identity/reconciliation protocol | Secret-manager source, secure injection, known-answer attestation anchor and fleet rollout/quiescence design. Disabled startup needs no HMAC fallback or secret; enabled Phase B must validate it before serving signup. No live secret read in this review |
| D04 Expiry and retry | Pending [D04 record](Signup%20Phase%20B%20D04%20Decision.md): recommend durable append-only terminalization if permanent terminal refusal is required; preserve claim binding/expiry | Timestamp-only B preserves five tables but expiry refusal can reverse under backward clock movement; C needs a reviewed monotonic time/epoch authority. Durable terminalization alone does not prove an unobserved elapsed-time deadline | Owner selects semantics/A-B-C, 24h duration/start cutoff and client behavior. A requires separate schema/grant/retention review and S2/S4 rescope. No terminal state or TTL approved |
| D05 PG capacity | Four fixed transaction advisory slots, slot-before-claim lock order, explicit READ COMMITTED; no new grants/tables | Claim-only+Redis has weaker overload bound; sixth slot/epoch table needs migration/permission redesign; global hash worker pool is more complex | Restricted LOGIN builtin availability and cross-process tests; namespace collision audit; slot count and fairness acceptance. Do not grant extra privileges to force success |
| D06 Recovery and errors | Pending [D06 record](Signup%20Phase%20B%20D06%20Decision.md): typed phase/tag evidence, independent monotonic accepted-proof latch, cleanup-health separation, one no-write T3 | Raw exceptions/resolved promises hide the S0-03/04 defects; blind retry/absence-to-rollback unsafe. Proposed owner acquisition 1s; T3 1s acquire + 3s transaction (500ms lock, 1s statement/idle) + 1s aggregate disposal | Owner approves exact outcome/response precedence, ownership/cancellation rules, target budgets and residual limits; separate S1 coding authorization. Required future real regressions must correct both confirmed defects, not preserve false success |
| D07 Retention and cleanup | Retain all claims/results initially; safe cleanup eligibility empty; bounded development dataset only | Finite retention forgets identity and allows rebinding; tombstones/stable registry add storage/migration; permanent namespace retirement changes client contract | Privacy/retention/account deletion owner review, storage budget, future durable anti-rebinding protocol. No cleanup implementation in Phase B first slices |
| D08 Hash/global capacity | Preserve local4 and Redis admission, state global Argon2 cap is not hard; PG slots bound only participating SQL critical sections | Strict fleet hash limit needs server-backed execution lease or bounded worker pool, with extra connections/failure recovery/operational cost | Decide whether development accepts bounded per-process memory with global overshoot risk. Public operation blocked without capacity validation |
| D09 Future rotation/incident policy | Stop new signup on detected drift/leak; preserve ledger; separately reviewed cross-version reconciliation before retirement | Replacing material under same version or merely changing version bypasses identity; plaintext retention to rehash violates secret boundaries | Incident authority, key retirement/tombstone design and safe namespace transition; no automatic rotation/deletion |
| D10 Duplicate-email result | Catch only JS DuplicateUserEmailError inside T2; append accepted result without touching existing credential/audit | Catch outside T2 leaves no durable result; blanket SQL23505 handling masks unrelated failures; synthetic user-created audit is false | Owner approves semantics; legacy account and concurrent different-key same-email tests |
| D11 Durability/lineage | One primary; recovery never reads replicas; require approved synchronous commit/fsync/failover profile before operational use | Async failover or split brain can lose claims/results; no application lock fixes acknowledged-data loss | Operator evidence and isolated failover tests; live configuration not inspected; fail closed on uncertain lineage |
| D12 Release and rollout | No old/new writer overlap; defaultoff; deploy all-writer protocol coherently; rollback disables entry and preserves ledger | Reverting to unkeyed service while claims survive breaks replay assumptions; ledger deletion is not rollback | Inventory internal callers, deployment gate and rollback runbook; no actual deployment authorized |
| D13 Observability and timing | Fixed allowlisted reason counters, no payload/key/digest trace labels; timing study before public use | Random delays alone are not proof; detailed per-key telemetry leaks correlators | Logging/tracing inventory, redaction tests and independent timing/security review |

## Approval-ready corrections

- [D06 decision record](Signup%20Phase%20B%20D06%20Decision.md) contains the recommended
  typed model, response/error precedence, proof-latch invariants, bounded ownership,
  timeout reconciliation, security-test acceptance and residual assumptions.
- [D04 decision record](Signup%20Phase%20B%20D04%20Decision.md) is a separate unresolved
  expiry-policy choice. Permanent terminality needs durable state/protocol approval;
  timestamp-only compatibility requires explicit acceptance of non-monotonic refusal.
- [S0 evidence ledger](Signup%20Phase%20B%20Test%20Plan.md#s0-verified-evidence) records
  nine real cases / zero skips at pinned PR #12 and CI #28. S0 is characterization
  complete; the current owner still has the real ROLLBACK-tag and post-ACK release defects.
- No D01-D13 recommendation is owner-approved by this correction. D06 approval plus
  explicit S1 slice authorization is the next coding gate. D04 remains a separate
  S2/expiry blocker; D06 must not silently approve A's migration/grant changes.

## Required prerequisites versus optional later work

Required before Phase B HTTP implementation approval: D01, D03, D04, D06, D10 and an
explicit selection for D05/D08. D02/D11/D12 must be accepted and tested before any
enabled-development integration is used operationally. D07's initial no-cleanup rule
and D09's no-rotation rule are required; their future replacement protocols remain
separate work. D13 redaction is mandatory, full public timing review remains a launch gate.

No unresolved question is treated as an implemented guarantee. Advisory-slot builtin
availability, fleet secret-attestation mechanism, hard hashing capacity policy, actual
durability/failover configuration, and retention/privacy requirements are unverified
operational inputs. They are not needed to publish a draft design, but block activation.

## Compatibility ledger

Frozen: HMAC v1 tuples and string handling; claim key uniqueness including HMAC version;
immutable retained binding/expiry; result v1 exact202; current five-table grants; inert
`UPDATE(lock_anchor)` with CHECK false; no ordinary audit/result UPDATE/DELETE; defaultoff.
Proposed additions: HTTP mandatory key, explicit transaction isolation/outcomes, T1/T2/T3
orchestration, expiry enforcement, optional selected PG capacity mechanism, bounded recovery
and secure API secret injection. Option A terminal state is a conditional additional scope requiring separate approval;
no approved code/schema/permission change is present here.

Related documents: [Architecture](Signup%20Phase%20B%20Architecture.md),
[HTTP Contract](Signup%20Phase%20B%20HTTP%20Contract.md),
[Recovery and Fencing](Signup%20Phase%20B%20Recovery%20and%20Fencing.md),
[Threat Review](Signup%20Phase%20B%20Threat%20Review.md),
[Implementation Slices](Signup%20Phase%20B%20Implementation%20Slices.md).
