# S0 PostgreSQL COMMIT Outcome Characterization

S0 is test only. Baseline: `a0bd2d7ff6499e393a3dabb46617f6292f23c84e`.
Design reviewed: PR #11 at `c860496cebc7919f1ad7fb56705db6e15cf57eb7`.
No D01–D13 approval is inferred. No S1–S6 behavior is implemented.
`SIGNUP_ENABLED=false`; public signup and production readiness remain unapproved.

## Evidence boundary

No dedicated `TEST_DATABASE_URL` was provided or authorized for this session.
All real PostgreSQL scenarios are **BLOCKED — dedicated TEST_DATABASE_URL unavailable**.
Synthetic unit tests characterize the actual owner function; synthetic TCP peers
exercise the proxy. Neither establishes a PostgreSQL transaction's durable outcome.
Skipped integration cases are not passes. Historical PR #11 CI is baseline evidence only.

| Scenario                               | Real PostgreSQL status | Available deterministic evidence / remaining oracle                                                                                                                                                                 |
| -------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S0-01 committed COMMIT, lost ACK       | BLOCKED                | Simulated COMMIT rejection is preserved and connection evicted. Real proof requires complete server `CommandComplete(COMMIT)` withheld by proxy and a new independent connection observing the marker.              |
| S0-02 definite abort                   | BLOCKED                | Fixture requires server `22012 ERROR`, acknowledged `ROLLBACK`, then absent marker. No server SQLSTATE/tag was observed in this session.                                                                            |
| S0-03 COMMIT returns ROLLBACK          | BLOCKED                | **KNOWN GAP in owner, unit characterization:** resolved `ROLLBACK` command is accepted as work success. Real aborted-transaction fixture awaits execution.                                                          |
| S0-04 post-COMMIT release failure      | BLOCKED                | **KNOWN GAP in owner, unit characterization:** acknowledged mock COMMIT followed by release throw rejects the caller. Real witness and real pool checkout-retention assertion await execution.                      |
| S0-05 independent reservation ACK loss | BLOCKED                | Manual Phase A repository fixture exists; identity, binding, immutable expiry, conflict and later independent rollback assertions await PostgreSQL. No Phase B T1 service exists.                                   |
| S0-06 fresh read / lock ordering       | BLOCKED                | Real two-writer schedules and negative same-statement join fixture exist. No MVCC schedule was executed here.                                                                                                       |
| S0-07 teardown / ownership             | BLOCKED                | Unit tests cover deadline eviction, delayed COMMIT settlement, late acquisition and end completion; existing real-pool/synthetic-client test covers reuse/eviction. Real backend PID/reuse oracle awaits execution. |

`KNOWN GAP` unit assertions intentionally pass when unsafe current behavior is
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

## Fault methodology and ordering (not yet observed against PostgreSQL)

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
and after, creates only `s0_outcomes_<uuid>` in the approved isolated local cluster,
applies existing migrations only there, and creates one owned marker table. It
creates no roles, alters no runtime grants, deletes no shared rows and never uses
DROP FORCE. It awaits owned proxy/socket/client/pool closure and server-session
absence before dropping its exact owned database and comparing inventories. Setup,
queries, lock barriers and transport cleanup have bounded watchdogs/server timeouts.
The harness watchdog is not a runtime outcome classifier or an ownership guarantee.
If closure cannot settle, the test fails and must report retained resource names;
never erase an error or terminate an unrelated backend to obtain green results.

## Secure later execution — separate environment approval required

Do not execute these steps in an application or production environment. An operator
must separately approve/provide an isolated local PostgreSQL cluster containing the
dedicated `authcore_test` anchor, and a test-only login authorized to create/drop
disposable test databases. Do not grant these capabilities to the application role.
Creating/installing a cluster, service, container or role is outside this S0 session.

Supply the dedicated URL through a session-local secure prompt; never paste it in
Git, a PR, shell history or application `.env`. The harness accepts only `postgres:`
or `postgresql:`, `localhost`/`127.0.0.1`, port 5432, database `authcore_test`, no query
options or fragments, and refuses exact reuse of `DATABASE_URL`. No fallback exists.

```powershell
# Run only after separate isolated-environment approval. No credentials are echoed.
$s0SecureUrl = Read-Host 'Dedicated approved TEST_DATABASE_URL' -AsSecureString
$s0Pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s0SecureUrl)
try {
  $env:TEST_DATABASE_URL = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($s0Pointer)
  $env:S0_POSTGRES_APPROVED = 'true'
  $env:SIGNUP_ENABLED = 'false'
  pnpm.cmd --filter @authcore/db exec vitest run --config vitest.integration.config.ts src/signup-commit-outcomes.integration.test.ts
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($s0Pointer)
  Remove-Item Env:TEST_DATABASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:S0_POSTGRES_APPROVED -ErrorAction SilentlyContinue
  $s0SecureUrl.Dispose()
}
```

Use an otherwise clean shell with application credentials absent. This explicit
opt-in gates only the new S0 suite; existing integration suites retain their existing
guards and are not modified. Archive full stdout/stderr, commit SHA, settings,
event traces, command tags, inventories and cleanup result privately. A blocked or
skipped case must not be counted as passed. If Device Guard or prerequisites block
execution, stop and record the exact blocker; do not bypass machine policy.

## S1 readiness and outstanding design corrections

S1 needs separate implementation approval and D06 approval. S0 unit findings support
the necessity of typed phase/outcome classification, strict `COMMIT` versus `ROLLBACK`
tag checking, a proven-success latch, frozen primary error precedence, bounded
acquisition/transaction ownership, late-client disposal and failed-client eviction.
They do not validate a proposed S1 implementation. Real ACK-loss, MVCC and backend
cleanup evidence remains blocked, so S0 cannot satisfy the full S1 acceptance gate.

- **P1 / D04:** timestamp-only expiry is not permanently monotonic under backward
  database-clock movement. Resolve policy/design before S2; no expiry policy is added here.
- **P2 / proven-success latch:** recovery must prioritize already-proven accepted
  state even if its COMMIT/ROLLBACK/end/release cleanup fails. The reviewed T3 catch
  path can still return 503 before honoring that proof. Correct the design and later
  S1/S4 implementation; S0 does not fix it.
- **P2 / scope:** Phase B HTTP replay and T1/T2/T3 orchestration do not exist. These
  owner/repository/transport tests must never be reported as future HTTP behavior passing.
- D01–D13 remain pending owner decisions. PR #11 stays open and Draft, unmodified.

Unknown COMMIT cannot be made definite by cleanup or a new ROLLBACK. Independent
positive state can prove success; lock/fresh lookup provides protocol synchronization,
not universal historical rollback classification or protection against lost primary
lineage. These limitations remain after any future S1 owner change.

Protocol/snapshot references: [PostgreSQL message formats](https://www.postgresql.org/docs/17/protocol-message-formats.html),
[READ COMMITTED](https://www.postgresql.org/docs/17/transaction-iso.html),
[node-postgres transactions](https://node-postgres.com/features/transactions).
