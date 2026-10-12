# Signup Phase B Threat Review

> Design proposal for human review, 2026-10-12. Baseline:
> `a0bd2d7ff6499e393a3dabb46617f6292f23c84e` (merged documentation PR #10).
> No Phase B behavior is implemented or approved by this document.
> `SIGNUP_ENABLED=false`; AUTH-001 remains incomplete; production readiness is not established.

## Trust boundaries and evidence

Internet/client -> HTTP parser/guards -> API process/secret -> Redis admission ->
PostgreSQL restricted role -> owner/maintenance/failover operator. PostgreSQL is the
source of truth; Redis contains no canonical identity or outcome. Raw passwords/keys
are transient application memory, not replay storage. HMAC digests are sensitive
correlators and must not become logs, metrics labels or trace baggage.

Verified controls come from [Phase A](../../packages/db/SIGNUP_IDEMPOTENCY.md),
[runtime permissions](../../packages/db/SIGNUP_RUNTIME_PERMISSIONS.md),
[Security Defaults](../Security%20Defaults.md), [Threat Model](../Threat%20Model.md),
[Security Requirements](../Security%20Requirements.md), and the source evidence linked
in [Architecture](Signup%20Phase%20B%20Architecture.md). The following mitigations are
proposals unless expressly marked existing. Severity estimates assume development-only
signup today and describe consequences if this protocol were activated.

| Threat / severity | Prerequisites and impact | Existing evidence / proposed mitigation | Residual risk and required verification |
| --- | --- | --- | --- |
| T01 Enumeration, High | Attacker controls email/key and observes statuses, headers or timing | Existing generic duplicate202; proposed identical replay body, no account/replay headers, keyed conflict independent of account | Timing still differs; low-entropy/shared keys expose reuse. F02-F04, F22 and statistical timing study; no resolved claim |
| T02 Password/key exposure, Critical | Logger, error serializer, tracer, crash dump or operator captures request material | Existing filter logs method/fixed event only; DTO errors omit target/value; hasher emits digests only. Proposed allowlisted outcome metrics without payload/key/digests | Heap/native memory and external instrumentation remain sensitive; redaction tests across all failures and tracing configuration review |
| T03 Runtime credential compromise, Critical | Restricted DB credential stolen; attacker can SELECT/INSERT permitted tables | Existing no broad UPDATE/DELETE/DDL or role escalation; keep five-table grants | Attacker can read hashes/digests, create users or append false audit/accepted rows. Not tamper-evident; incident containment and separate credential authority needed; F23 plus malicious INSERT characterization |
| T04 HMAC secret compromise/drift, Critical | Secret leaked, version reused with new material, or fleet inconsistent | Dedicated32-byte injection, immutable version/material mapping, independent known-answer attestation proposed | Ledger cannot recognize same raw key under another secret/version; plaintext password guesses become possible after secret+ledger leak. F18, D03; no automatic rotation |
| T05 Replay abuse, Medium | Attacker has valid/guessable key and sends repeated traffic | Proposed mandatory unpredictable keys, existing rate/admission for replays, retained immutable response without account reads | Request processing/Redis/DB costs remain; timing/memory CPU not free. F03/F05/F22 and load budgets |
| T06 Claim-table exhaustion, High | Many IPs/keys, prolonged development exposure, Redis resets | Existing30/min global and5/IP/10min only bound a functioning limiter epoch; proposed short controlled development sessions, storage high-water rejection | Indefinite retention grows; 30/min could permit43,200/day before failures/restarts, not a hard durable quota. Measure row/index/WAL bytes; D07/D08 operational capacity approval |
| T07 Stale leases/fencing failure, High | GC/event-loop pause, network delay, Redis failover/lease expiry | Existing no token resurrection; proposed claim row serialization and PG transaction slots | Stale queued COMMIT can finish; fleet hash cap still not hard. F15/F16/F26; no atomic Redis/PG guarantee |
| T08 Double execution, Critical | Concurrent requests, ambiguous COMMIT, mixed old/new writers, same-statement stale snapshot | Proposed continuous row lock, separate fresh result read, atomic domain/result write, no hidden retry | Assumes retained identity, stable secret, all-writer participation, durable primary lineage. F05/F06/F10/F28 and lock scheduling tests |
| T09 False success / outcome masking, Critical | Aborted COMMIT resolves ROLLBACK; release/cleanup hides acknowledged or recovered acceptance; fabricated result | Real S0-03 false-success and S0-04 post-ACK rejection/checkout retention confirmed. Pending D06 exact tag, external monotonic business-proof latch and independent cleanup health; corrected T3 | S0 KNOWN GAP passes prove defects, not fixes. F25/F27/P05 must correct behavior; untrusted INSERT/lineage still breaks proof |
| T10 Orphaned/unresolved claims, Medium | Crash after reservation; prolonged DB outage; stalled writer | Proposed active retries under lock, bounded no-write recovery, selected D04 refusal policy (pending owner approval) | Some users need manual policy resolution; never delete to unblock. F11/F17/F20/F24; availability traded for safety |
| T11 Unauthorized history mutation, High | Runtime role granted extra membership/column/table privileges; owner operates | Existing provisioning validates effective privileges; audit/results no UPDATE/DELETE/TRUNCATE; CHECK false lock anchor | Owner/superuser can alter data; effective grants can drift after provisioning. Re-audit in disposable tests, operational drift detection not implemented |
| T12 Role escalation, Critical | Unsafe PUBLIC functions/views/DDL or role memberships | Existing provisioning rejects unexpected effective grants, SECURITY DEFINER/write paths and memberships | Future grants/extensions can invalidate boundary; PG advisory builtin availability must be tested without weakening grants. F23/D05 |
| T13 Distributed crash/failover, Critical | Process death, partition, asynchronous promotion/data loss | S0 real ACK-loss/witness and ordinary backend eviction; proposed D06 classification/cancellation/late checkout and one no-write T3 | Acquisition/stalled-COMMIT deadline evidence is synthetic only; socket closure not rollback; acknowledged-data loss invalidates lineage. F10-F13/F17/F28; operational proof absent |
| T14 Cleanup-induced rebinding, Critical | Owner deletes claim/results or rotates namespaces then late retry arrives | Proposed no cleanup/rotation; future tombstone or permanent namespace retirement requirement | Time drain/row lock alone insufficient after resume; F21 negative fixture and D07/D09 approval |
| T15 Starvation/DoS, High | Hot key lock waiters occupy four PG slots; expensive Argon2; slow/disconnected clients | Existing local admission until settlement, pool/timeouts; proposed nonblocking PG slot acquisition and bounded recovery/backoff | Fairness not guaranteed; Redis expiry can exceed global hashing count. F09/F15/F26, slow-client/header/body tests; capacity measurements outstanding |
| T16 Account deletion/retention coupling, High | Future owner deletes accounts/audit or ledger for privacy policy | Existing audit user FK RESTRICT and claim-result FK RESTRICT; no account join for replay | Retained digests remain sensitive; privacy policy and legitimate deletion workflow not designed. D07/D09, separate review required |
| T17 Expiry re-eligibility after backward clock, High / P1 design finding | An expired no-result claim returns timestamp-based409, DB time reverses, another request becomes eligible | Counterexample in pending [D04](Signup%20Phase%20B%20D04%20Decision.md); recommend durable terminalization if permanent refusal required, or explicitly accept B non-monotonic policy | S0 did not shift clocks or prove terminal expiry. A requires separate state/grants/retention review; P08/F20 test selected semantics, crash and lost ACK; no lock_anchor repurposing |

## Evidence-class corrections

[S0 ledger](Signup%20Phase%20B%20Test%20Plan.md#s0-verified-evidence) separates real
PostgreSQL evidence, synthetic/unit schedules, confirmed defects, unimplemented
controls and operational assumptions. T3 proof-preserving catch/finally/cleanup is
a corrected proposal, not a deployed control. Cleanup quarantine/retention can
exhaust local capacity; alert separately without clearing accepted proof or silently
freeing an active reservation. No new service/worker is introduced by the proposal.

## Operational security gates

Do not expose signup to the public on the strength of this design. AUTH-001 still needs
registration policy, email ownership verification/delivery, unverified-account access
restrictions, timing-resistant enumeration analysis, approved retention/account deletion,
independent security review and operational validation. Successful baseline or future
CI is neither independent human approval nor evidence of live restricted-role adoption.

Monitor only low-cardinality reason classes (accepted, unavailable, conflict, expired,
abort, unknown, recovery-proof, permission-failure, cleanup-evicted, cleanup-quarantined) and bounded latency/capacity counters.
Do not label metrics with email, user-supplied key, digest, password/hash, credential,
connection URL or arbitrary SQL error text. Approved request/trace identifiers must not
encode those values. A security audit event remains a transactional domain requirement;
operational logs are not a substitute and must not introduce duplicate audit rows on replay.

On secret or credential compromise, disable new signup, preserve ledger/evidence and
escalate for separately authorized incident response. Do not silently rotate HMAC,
change live roles, delete claims, or treat allowed INSERT as proof of trustworthy data.
The proposed mitigations do not resolve these risks until implemented, adversarially
tested and independently reviewed.

See [Decision Register](Signup%20Phase%20B%20Decision%20Register.md) and
[Failure Matrix](Signup%20Phase%20B%20Failure%20Matrix.md).
