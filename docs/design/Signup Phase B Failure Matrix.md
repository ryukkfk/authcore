# Signup Phase B Failure Matrix

> Design proposal for human review, 2026-10-12. Baseline:
> `a0bd2d7ff6499e393a3dabb46617f6292f23c84e` (merged documentation PR #10).
> No Phase B behavior is implemented or approved by this document.
> `SIGNUP_ENABLED=false`; AUTH-001 remains incomplete; production readiness is not established.

## Reading the matrix

All outcomes below are **proposed Phase B behavior**, not tests already passing.
`C` = independently committed matching claim; `R` = immutable accepted result;
`U/P/A` = new user/password credential/creation audit. `T2` holds the claim row lock
through transaction end. `fresh` means a separate READ COMMITTED result statement
after lock acquisition. No unlocked absence or TTL is rollback evidence.

`202` always means exactly `{"status":"accepted"}`. `409` is the fixed key-unavailable
body. `503` is fixed temporary-unavailability with `Retry-After: 1`; it does not assert
rollback. `500` is the fixed internal error. A disconnected client receives no response.
The [HTTP Contract](Signup%20Phase%20B%20HTTP%20Contract.md) owns exact response bodies.
Each F ID identifies a required automated scenario in the
[Test Plan](Signup%20Phase%20B%20Test%20Plan.md). Use explicit barriers, not sleep-based races.

| ID / scenario | Initial state and concurrency schedule | Expected database state | HTTP outcome and retry | Security invariant / required automated test |
| --- | --- | --- | --- | --- |
| F01 First successful signup | No claim/account; T1 commits C; T2 locks, fresh miss, active; writes U/P/A/R and receives COMMIT ACK | C plus exactly one U/P/A/R atomically visible | 202; later same-key replay | No result before complete transaction; restricted-role HTTP E2E counts all four writes |
| F02 Duplicate email | Existing account, possibly legacy without audit; T1 C; targeted user INSERT returns no row; exact JS duplicate caught inside T2 | Existing account/credential/audit unchanged; new R committed for C | 202 identical to F01; replay 202 | No credential replacement or invented creation audit; E2E legacy and normal account fixtures |
| F03 Identical replay | C/R retained; repeat exact key/payload before or after expiry | No domain/result append; no timestamps/expiry changed | 202; no further action | No Argon2 or account query after positive proof; spies plus real DB before/after snapshots |
| F04 Conflicting replay | C exists; same raw key with different frozen payload digest | C binding unchanged, no loser writes | 409; do not auto-change key | Email display-case/password changes conflict without echo; HTTP and repository tests |
| F05 Concurrent identical | A commits C, holds T2; B reserves same C and waits; A commits R | Exactly one U/P/A/R; B sees fresh R after lock, or does no writes on timeout | Both 202 if wait budget permits; otherwise B 503 then 202 retry | Post-wait visibility; two real connections, barrier before COMMIT and result SELECT |
| F06 Concurrent conflicting | A's claim insert uncommitted; B insert waits on unique identity; A commits or rolls back | If A commits, only A binding retained; if A rolls back, B may establish its own binding | Durable loser 409; transient wait 503; rollback winner may later get 409 | No durable reservation inferred before commit; test both commit and rollback schedules |
| F07 Transaction rollback | C durable; T2 fails after each U/P/A/R INSERT; authoritative rollback before any COMMIT sent | C remains; every T2 domain/result write absent | Mapped 500 or transient 503; later same-key active retry locks/checks and may execute | Atomicity and no false success; fault at each statement, real restricted role |
| F08 PostgreSQL deadlock | C exists; external participating/fixture transaction produces deadlock while T2 active | Server-selected victim T2 aborted; C retained; no partial T2 state | 503 if confirmed transient abort; unknown transport separately recovers | Phase-aware SQLSTATE 40P01 handling; controlled real deadlock, victim and survivor assertions |
| F09 Lock timeout | A holds C; B T2/T3 waits beyond its approved profile (T2 1s, proposed T3 500ms within 1s statement) | B stops/aborts without domain writes; A may still commit later | B503, same-binding backoff; never claim A rolled back | S0-06 real barriers support the schedule, not deadline guarantees; future real timeout/disposal regression required |
| F10 Lost COMMIT acknowledgement | C; server completes COMMIT; proxy withholds complete ACK; separate server-confirmed abort schedule | Committed branch U/P/A/R; confirmed aborted branch C only; original caller may remain unknown | Valid recovery R ->202; no proof ->503 except selected D04 valid refusal; never recursive domain retry | Real S0-01 verifies marker/witness building block, not full T2/T3 HTTP; P04/P05 must implement full outcome tests |
| F11 API crash before COMMIT | C durable; terminate API during T2 after writes but before COMMIT submission; backend may linger | Eventually T2 aborts if no COMMIT sent; C retained; lock held until server ends transaction | Original no response; retry 503 while locked, then may execute if active | Process death/closed socket not immediate rollback proof; separate process crash and backend observer |
| F12 API crash after COMMIT | DB commits R; kill API before response; alternatively kill during ambiguous COMMIT | R branch retained; ambiguous branch resolved only by lock/read | Original no response; retry202 on R, otherwise bounded pending | HTTP delivery independent of commit; crash barrier after authoritative commit |
| F13 Client disconnect | Disconnect before writes, during T2, or after COMMIT submission | Pre-COMMIT cancellation attempts abort; sent COMMIT may still commit R | No response; same-key retry follows ledger proof | Cancellation cannot erase committed result; E2E socket abort at each barrier |
| F14 Redis unavailable | Outage before rate/admission; or renewal error while T2 active | Before admission no new claim; observed loss before COMMIT aborts T2; already submitted COMMIT may commit | 503 before proof; acknowledged/proven accepted stays202 if connected | Fail closed without claiming atomic Redis/PG fence; real Redis interruption plus PG observer |
| F15 Redis lease expiry | A stalls past 30 seconds; B receives slot; A queued COMMIT may execute | Same-key B still serialized by C; different-key work can overlap; PG advisory capacity retained until actual server end | A proven commit202 or unknown503; B replay/pending as appropriate | TTL is not a PostgreSQL fence; multi-process delayed worker test, no false hard global hash-cap assertion |
| F16 Delayed/stale worker | A loses lease, resumes before mutation or after final check; B has same-key claim lock wait | Observed loss aborts; unchecked queued COMMIT can finish; no second same-key R | Pending503 or proven202; new attempt rechecks all gates | No Redis token resurrection; row-lock/result is execution authority; inject event-loop pause and late command |
| F17 PostgreSQL unavailable | Connection fails before T1, after C, during T2 or recovery | No writes before T1; C may remain; sent COMMIT unknown; no invented state | 503 unless accepted result already proven; bounded same-key retry | No replica-miss fallback or replacement claim; close transport and assert pool/admission settlement |
| F18 HMAC key mismatch | Missing/invalid secret or detected attestation mismatch; also simulate undetected wrong material under same/different version | Detected case no request writes; undetected wrong secret can create a distinct claim namespace | Detected503/startup not ready; undetected behavior is an unsafe configuration gap, not automatically detected409 | Negative test must expose namespace bypass; fleet attestation/pre-enable gate required, no guarantee from schema alone |
| F19 Expired claim with result | C expired, R retained; retry binding matches | Original C/R and domain rows unchanged | 202 regardless of expiry | Result-first authoritative check; test late original commit after execution-start cutoff |
| F20 Expiry without result / backward clock | C; late authorized writer may hold lock. Observe 12:01 after 12:00 expiry then clock 11:59 | Binding/expiry never mutate. A needs durable terminal fact; B may become eligible again after timestamp refusal. Prior writer may commit R | Locked503; valid R202; A terminal proof409, timestamp-only T3 miss503; B current refusal409 without permanent claim | P1 design counterexample, not S0 clock experiment. Selected D04/P08 tests crash/lost ACK/backward clocks; no terminal schema/grants approved |
| F21 Cleanup racing recovery | Owner attempts maintenance while API active; prohibited initial policy | No authorized cleanup; FK and runtime grants block ordinary deletion, but owner can violate protocol | If C missing/replaced,503 integrity unavailable; never auto-reserve inside T2/T3 | Owner is outside grant guarantees; destructive race only in disposable DB shows why tombstones/quiescence are prerequisites |
| F22 Rate exhausted | Per-IP or global window consumed; new/replay/invalid request arrives | No new claim/domain writes because rate guard precedes these | 429 plus window TTL; same key/payload after wait | Replay does not bypass rate limits; exact existing quotas and no refund after unknown Redis command |
| F23 Restricted-role denial | Revoke required audit INSERT/result INSERT/claim locking permission in disposable fixture | T2 rollback leaves C; no partial U/P/A/R; claim-lock denial writes nothing | 500; operator fixes reviewed provisioning, never grants broad UPDATE | Required writes cannot be skipped; real LOGIN role denial, verify history UPDATE/DELETE/TRUNCATE still denied |
| F24 T1 ACK lost | Claim reservation COMMIT sent; reply lost; C may exist/invisible/absent | No account work until matching durable C is proven; unique index resolves later retries | Proven C can continue within budget; otherwise503; absence is not rollback evidence | Separate reservation uncertainty; real dropped ACK and concurrent same/conflicting binding |
| F25 Release/cleanup failure after proof | T2 exact COMMIT_ACK or T3 fresh immutable-result proof, then rollback/end/release/Redis cleanup throws | Accepted state remains committed; cleanup health independently degraded; disposal still owned | Proven202 if connected; disconnect preserves outcome; no-proof cleanup failure503 | Real S0-04 exposes current rejection/retained checkout under synthetic release injection. S1/S4 must correct precedence and verify disposal, not retain known-gap expectation |
| F26 Capacity exhausted/starvation | Four participating PG slot holders; another T1/T2/T3 attempts acquisition; repeated hot-key contenders | No fifth participating PG critical section; no new writes by denied attempt | 503 with jitter; existing holders finish/abort; no indefinite queue | Server-held capacity, not hash-memory cap; cross-process advisory slots and bounded wait/fairness tests |
| F27 COMMIT returns ROLLBACK | Real statement abort caught inside work; COMMIT resolves with exact ROLLBACK tag | C only, no T2 writes; current owner false-success confirmed S0-03 | Future owner never returns callback success; known transient cause503, unexplained invariant500; only independent valid R permits202 | Real and synthetic regressions must fail old behavior and pass corrected owner; historical KNOWN GAP pass is not correctness |
| F28 Primary failover loses acknowledged data | Replica promotion/partition outside approved durability assumptions | Missing C/R does not establish previous rollback; lineage uncertain | Stop new writes,503; operator reconciliation | No cross-lineage exactly-once claim; isolated failover experiment required before operational adoption |

## S0 evidence mapping and limits

The [pinned nine-case evidence ledger](Signup%20Phase%20B%20Test%20Plan.md#s0-verified-evidence)
maps S0-01 to F10, S0-02 to F07, S0-03 to F27, S0-04 to F25,
S0-05 to F24, S0-06 to F05/recovery snapshots and S0-07 to teardown ownership.
These are real owner/repository/transport observations, not full Phase B HTTP tests.
No T3 is implemented; [D06](Signup%20Phase%20B%20D06%20Decision.md) requires proof
selection after catch/finally and independent cleanup health. [D04](Signup%20Phase%20B%20D04%20Decision.md)
is pending; the old permanent Expired self-loop was not justified by timestamps.

## Common assertions

Every scenario checks permitted HTTP body/headers, no password/raw key/digest leakage,
no result on failed account transaction, unchanged claim binding/expiry, at most one
result per retained claim, credential/audit counts, and no accidental permissions changes.
At each genuinely ambiguous point, assert absence of domain retries and a controlled
pending response. Test success/definite-abort/unknown branches separately; do not use a
missing SELECT as an oracle. F18/F21/F28 deliberately demonstrate limits of assumptions.
