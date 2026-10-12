# S0 PostgreSQL COMMIT Outcome Characterization

S0 is test only. Baseline: `a0bd2d7ff6499e393a3dabb46617f6292f23c84e`.
Design reviewed: PR #11 at `c860496cebc7919f1ad7fb56705db6e15cf57eb7`.
No D01â€“D13 approval is inferred. No S1â€“S6 behavior is implemented.
`SIGNUP_ENABLED=false`; public signup and production readiness remain unapproved.

## Evidence boundary

The owner explicitly authorized the existing disposable PostgreSQL 17 GitHub
Actions service for this S0 verification. Local and production database execution
remain prohibited. Historical CI #25 at `1eb79a50bf55b1d8f1691de7399a3605048d37f3`
passed ordinary integration checks but skipped all nine S0 cases because the
explicit S0 approval flag was absent. It is not real S0 evidence.
The dedicated CI verification step now enables only its focused S0 invocation;
CI [#26](https://github.com/ryukkfk/authcore/actions/runs/38221444767) at
`31f7387d52d8465cea3d3c9577be6dd40ab9c5f5` executed **9/9 real S0 cases, zero
skips**, with the result check `S0_REAL_VERIFICATION total=9 passed=9 skipped=0`.
The complete Verify job logs were inspected, including all nine scenario traces,
settings, before/after inventories and existing regression suites.
Synthetic unit tests characterize the actual owner function; synthetic TCP peers
exercise the proxy. Neither establishes a PostgreSQL transaction's durable outcome.
Skipped integration cases are not passes. Historical PR #11 CI is baseline evidence only.

Observed server: PostgreSQL **17.11**, `fsync=on`, `synchronous_commit=on`, primary
mode. Before/after inventories matched exactly: four databases, sixteen roles,
four anchor schemas and zero owned sessions. The UUID-owned database was removed
without FORCE. Full CI passed lint, build, typecheck, 233 workspace tests, 99
ordinary PostgreSQL tests, 28 Redis integration tests and nine HTTP E2E tests.
The ordinary PostgreSQL invocation's nine S0 skips are separate from the dedicated
invocation's nine passes. No runtime code, migrations, grants or dependencies changed.

| Scenario                               | Real PostgreSQL status | Available deterministic evidence / remaining oracle                                                                                                                                                                                        |
| -------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S0-01 committed COMMIT, lost ACK       | PASS                   | Complete server `CommandComplete(COMMIT)` observed, entire ACK withheld by proxy, owner rejected; newly opened independent connection observed committed marker. Pool total/idle counts both zero.                                         |
| S0-02 definite abort                   | PASS                   | Real server `22012 ERROR`, acknowledged `ROLLBACK`, independent marker absent.                                                                                                                                                             |
| S0-03 COMMIT returns ROLLBACK          | PASS / KNOWN GAP       | Real aborted transaction returned `ROLLBACK` from COMMIT; current owner returned false success while independent marker was absent. Unsafe behavior remains unfixed.                                                                       |
| S0-04 post-COMMIT release failure      | PASS / KNOWN GAP       | Actual acknowledged `COMMIT`, then synthetic release-boundary exception; caller rejected despite independent committed marker. Real pool retained one checkout, explicitly evicted by fixture.                                             |
| S0-05 independent reservation ACK loss | PASS                   | Complete real COMMIT ACK withheld; new connection matched claim identity, binding and expiry. No rebinding/renewal; conflicting payload rejected; later rollback preserved independent reservation. Manual repository building block only. |
| S0-06 fresh read / lock ordering       | PASS (3 cases)         | `pg_blocking_pids` barrier verified real row-lock waits. Writer COMMIT -> fresh accepted result; writer ROLLBACK -> absent result; same-statement JOIN missed committed result that a separate statement saw.                              |
| S0-07 teardown / ownership             | PASS                   | Real ROLLBACK tag, failed checkout evicted, original backend absent in `pg_stat_activity`, next checkout had a different PID. Acquisition/COMMIT deadline gaps remain unit/synthetic evidence only.                                        |

`KNOWN GAP` characterization assertions intentionally pass when unsafe current behavior is
observed. They do not endorse it. Desired S1 behavior is described separately;
there are no suppressed failures or silently passing future-behavior regressions.

## Introduced files and narrow configuration

- `src/signup-commit-outcomes.test.ts`: owner outcome/cleanup/deadline characterizations,
  explicit URL guard and fragmented/coalesced protocol parser tests.
- `src/s0-commit-proxy.test.ts`: synthetic TCP ACK-forward/drop tests, including socket cleanup.
- `src/s0-commit-proxy.test-support.ts`: test-only local protocol proxy, bounded watchdog,
  event trace and target guard. No new dependency.
- `src/signup-commit-outcomes.integration.test.ts`: seven scenario groups (nine cases)
  against one UUID-owned disposable database, using unmodified Phase A migrations/repositories.
- `tsconfig.build.json`: exclude `src/**/*.test-support.ts` from production build.
  This is essential because helpers live beside tests under the existing TypeScript root.
  No runtime source, schema, migration, permission SQL or service configuration changes.

## Fault methodology and ordering

The proxy listens only on loopback with a random port, forwards protocol v3 startup
and all typed frames, and supports plaintext test transport only (`ssl: false`).
It recognizes only the exact simple-query `COMMIT`, which is what the existing owner
submits. It does not rewrite SQL or emulate a PostgreSQL server. It buffers a full
backend frame before forwarding, so fragmentation/coalescing cannot leak part of the
target ACK. Upon the complete server `CommandComplete(COMMIT)` it withholds the entire
frame plus any following `ReadyForQuery`, destroys both owned sockets and records
the command tag. Authentication frames, SQL payloads, passwords and claim digests
are never logged. This is an isolated test transport; no application TLS is weakened.

Required S0-01 event sequence:

1. Marker INSERT completes in the owner transaction.
2. Proxy forwards COMMIT to PostgreSQL.
3. Proxy receives complete server `CommandComplete`, raw tag `COMMIT`.
4. ACK is withheld; both transports are destroyed.
5. Owner query rejects and failed checkout is evicted.
6. A new direct independent connection opens and observes the committed marker.

Event traces contain monotonically ordered sequence numbers and monotonic elapsed
nanoseconds. The commit's internal WAL instant is not directly instrumented; the
server command completion and independent witness bound the relevant processing.
Socket destruction alone proves neither commit nor rollback. `fsync=on`,
`synchronous_commit=on`, primary mode and server version are recorded/asserted by
the real fixture; no crash/power-loss/failover durability experiment is claimed.

S0-02 records actual SQLSTATE/severity and ROLLBACK tag, then an independent missing
marker. S0-03 deliberately catches a server statement error inside `work`, submits
COMMIT against that aborted transaction, records its actual resolved tag and asserts
the current owner returns false success while its writes are absent. S0-04 injects
a synchronous exception at the real checked-out client's release boundary **after**
an actual acknowledged COMMIT, verifies independent visibility and records pool state.
The release exception is synthetic; the COMMIT and witness must be real. The fixture
then explicitly evicts its retained checkout so the experiment cannot leak it.

S0-05 manually begins and independently commits a Phase A claim reservation. The
proxy drops that transaction's ACK. A newly opened authoritative connection must
read the same claim ID, binding and expiry. A later `reserve` cannot renew expiry;
conflicting payload fails, and a separate later transaction rollback cannot remove
the retained claim. This demonstrates a future T1 building block only.

## Concurrency proof boundary

S0-06 uses explicit READ COMMITTED sessions and `pg_blocking_pids` as the lock-wait
barrier. An unlocked result is first observed missing while the original writer
still owns the claim lock; the writer can subsequently commit. The contender waits,
the writer commits or rolls back, the contender acquires the unchanged claim lock,
then a **separate statement** reads the result with a fresh snapshot. A negative
LEFT JOIN fixture checks a same-statement pre-wait snapshot can miss a result that
the later separate statement sees. Polling has monotonic deadlines and yields to
the event loop; it uses no timing-sensitive sleep as a synchronization oracle.

A matching committed result proves accepted persistence on that authoritative
primary. Lock acquisition plus a separate missing read establishes execution
eligibility only while the unchanged claim lock remains held and only if all writers
obey that protocol. It does not identify an earlier attempt's historical outcome.
A missing unlocked result, closed socket, expired Redis lease or lost ACK cannot
prove rollback. This harness implements no replay/recovery/HTTP orchestration.

## Ownership and cleanup boundaries

The current owner awaits `pool.connect()` without its own acquisition deadline.
A delayed client can still start work. A stalled COMMIT has no function-owned
deadline; query/socket/server behavior must settle it. Unit fake timers preserve
these observations without hanging. Failure checkout is held through teardown and
released with `true`; the one-second teardown timer destroys the actual transport.
Late end completion must not produce a second release. Existing owner tests cover
primary SQLSTATE precedence, rollback failure, failed-client eviction and real
pg-pool lifecycle using a synthetic client. Those are not real PostgreSQL evidence.

The real fixture captures database/role/schema and owned-session inventories before
and after, creates only `s0_outcomes_<uuid>` in the approved ephemeral CI cluster,
applies existing migrations only there, and creates one owned marker table. It
creates no roles, alters no runtime grants, deletes no shared rows and never uses
DROP FORCE. It awaits owned proxy/socket/client/pool closure and server-session
absence before dropping its exact owned database and comparing inventories. Setup,
queries, lock barriers and transport cleanup have bounded watchdogs/server timeouts.
The harness watchdog is not a runtime outcome classifier or an ownership guarantee.
If closure cannot settle, the test fails and must report retained resource names;
never erase an error or terminate an unrelated backend to obtain green results.

## Authorized CI execution

Only the existing GitHub-hosted ephemeral CI service is approved for this task.
The workflow retains its existing `TEST_DATABASE_URL`; no application credentials,
repository secrets, new services or fallback connections are introduced. The S0
step alone sets `S0_POSTGRES_APPROVED=true` and `SIGNUP_ENABLED=false`, requires a
GitHub-hosted Actions runner and a nonempty dedicated URL, and refuses a supplied
`DATABASE_URL`. The existing URL guard, durability settings and PostgreSQL 17 major
version assertion run before the cases. Invalid prerequisites fail the step.

The command uses the existing `@authcore/db test:integration` package script and
checked-in integration configuration, filtered to the S0 file. Verbose evidence
and a JSON reporter are enabled. An independent result check requires exactly
nine passed assertions; a missing, skipped, pending or failed case fails CI.
Ordinary PostgreSQL integration, Redis, HTTP E2E, lint, build, typecheck and unit
coverage are preserved. S0 skips in the ordinary invocation are expected because
that invocation does not receive approval; only the dedicated invocation counts.

The cleanup guard closes owned transports, checks owned backend absence, drops
only the exact UUID database created by this invocation without FORCE, and compares
before/after database, role, schema and owned-session inventories. S0-07 additionally
checks the evicted backend's absence through `pg_stat_activity` before acquiring a
different backend. No unrelated session is terminated.

Archive revision, run URL, settings, event traces, command tags, inventories and
cleanup results privately, with connection strings and credentials redacted.
No local PostgreSQL execution or Device Guard change is needed or authorized.

## S1 readiness and outstanding design corrections

S1 needs separate implementation approval and D06 approval. S0 findings support
the necessity of typed phase/outcome classification, strict `COMMIT` versus `ROLLBACK`
tag checking, a proven-success latch, frozen primary error precedence, bounded
acquisition/transaction ownership, late-client disposal and failed-client eviction.
They do not validate a proposed S1 implementation. Real ACK-loss, MVCC and backend
cleanup characterization is now verified in CI #26. S0 satisfies its test-only
characterization acceptance criteria; this does not mean the transaction owner is
safe or authorize S1. No additional production-owner defect beyond the documented
gaps was discovered. S1 remains blocked on D06 correction/approval and separate
implementation authorization. The real fixtures do not validate owner acquisition
or stalled-COMMIT deadlines, crash/power-loss/failover durability, or future HTTP recovery.

- **P1 / D04:** timestamp-only expiry is not permanently monotonic under backward
  database-clock movement. Resolve policy/design before S2; no expiry policy is added here.
- **P2 / proven-success latch:** recovery must prioritize already-proven accepted
  state even if its COMMIT/ROLLBACK/end/release cleanup fails. The reviewed T3 catch
  path can still return 503 before honoring that proof. Correct the design and later
  S1/S4 implementation; S0 does not fix it.
- **P2 / scope:** Phase B HTTP replay and T1/T2/T3 orchestration do not exist. These
  owner/repository/transport tests must never be reported as future HTTP behavior passing.
- D01â€“D13 remain pending owner decisions. PR #11 stays open and Draft, unmodified.

Unknown COMMIT cannot be made definite by cleanup or a new ROLLBACK. Independent
positive state can prove success; lock/fresh lookup provides protocol synchronization,
not universal historical rollback classification or protection against lost primary
lineage. These limitations remain after any future S1 owner change.

Protocol/snapshot references: [PostgreSQL message formats](https://www.postgresql.org/docs/17/protocol-message-formats.html),
[READ COMMITTED](https://www.postgresql.org/docs/17/transaction-iso.html),
[node-postgres transactions](https://node-postgres.com/features/transactions).
