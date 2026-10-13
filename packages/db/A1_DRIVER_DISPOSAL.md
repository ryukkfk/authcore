# A1 driver ownership correction

Development candidate. Signup stays disabled by default. This slice does not repair
the transaction owner, implement Phase B orchestration, authorize activation, or
constitute independent security approval. S0 is preserved at its original commit.

## Dependency decision and provenance

Patch the official MIT-licensed `pg@8.23.1` and `pg-pool@3.14.0` artifacts through
pnpm `patchedDependencies`. Pin pg exactly and override pg-pool exactly. No additional
runtime library is introduced. The package tarball integrity remains in pnpm-lock;
[provenance](../../patches/provenance.json) records official package source revisions,
patch/source/license SHA-256 values. CI installs with `--frozen-lockfile` and independently
checks the installed code and licenses with `scripts/verify-driver-patches.mjs`.
Changing a patch requires an explicit provenance and lockfile update and review.

The inspected [upstream pool](https://github.com/brianc/node-postgres/tree/544b1ce8152bc280e398dc1e8a66920abe6a640e/packages/pg-pool)
does not contain this disposal contract. This is a maintained local correction, not
a claim of an upstream fix or a replacement pool implementation. The rejected P1
two-guard experiment is not the source of the implementation. Mandatory bookkeeping,
transport ownership, connecting/closing capacity, notifications and receipts are
handled together. Package licenses remain intact.

## Public extension and supported boundary

Supported: Node 24, pure-JavaScript pg Client, TCP/TLS Node streams, ordinary pool
queries and non-pipelined transaction ownership. pg-native is outside this acceptance
boundary. Custom Client implementations must supply a truthful `terminate()` receipt;
an absent/invalid receipt retains owned closing capacity rather than inventing success.

Capture `client.release` and **`client.dispose` at checkout time**. Both are scoped to
that checkout. A later checkout overwrites the methods on the reused Client, as it
already does for release. Never retain a Client reference and call its new methods
after returning ownership.

- `release(errorOrDestroy?)` remains release-once. A second call throws. A synchronous
  release observer failure still throws to its caller, after mandatory eviction starts.
  A failed release never returns the connection to idle. Pool.query preserves its
  query result/primary failure and records cleanup failures separately.
- `dispose(): Promise<DisposalReceipt>` consumes unreleased ownership and forcibly
  terminates the local transport. Repeated calls to the captured disposer return the
  same Promise, including after a failed release. It never retries release.
- After an ordinary healthy release, the captured disposer rejects with an ownership
  ended error. It cannot evict a later checkout of that connection.
- A disposal receipt has `removed: true`, `transportSettled: true`, and a read-only
  diagnostics getter. It proves this client's removal and terminal local transport;
  it does **not** prove transaction rollback, remote backend absence, or business acceptance.
- `Client.terminate()` is an idempotent public source-level extension. It blocks future
  query submissions, destroys the Node stream and waits for actual close. Existing
  pg query rejection callbacks are scheduled and allowed to settle before the receipt
  `{transportSettled:true, queriesSettled:true}`. Owners must still observe their own
  query/work Promises; arbitrary application callbacks are outside a transport receipt.

No application production code uses private pool fields or stream internals in this
slice. The historical owner still has its previously documented defects and is unchanged.

## Removal, progress and shutdown

Removal registers an idempotent record before invoking any end callback. Reentrant,
synchronous, repeated and late callbacks cannot perform removal twice. Reusable clients
leave totalCount; closing clients remain in closingCount and consume max capacity.
Outstanding connection/setup owners also consume capacity even after their transport
has closed. Replacement churn cannot silently exceed max.

Graceful removal first calls end, then uses a 1s fallback target to terminate. Explicit
dispose and release-observer failure use terminate immediately. The timer is a target,
not proof of settlement. If terminal closure/receipt cannot be obtained, capacity and
shutdown stay explicitly unresolved. No timeout produces a clean receipt.

`closingCount` and `connectingCount` expose unresolved ownership separately from idle,
waiting and reusable total counts. Pool shutdown rejects queued and connecting waiters,
never delivers late work, owns late connect/onConnect completion, drains idle clients,
and resolves only when reusable/closing/setup registries are all empty. Checked-out
application owners must return or dispose their own clients. An indefinitely stalled
application hook remains visible and capacity-bounded; it is not successful shutdown.
Operational containment is stop admission, retain evidence and restart the affected
process after the reviewed shutdown budget, not free its claimed ownership in place.

Lifecycle notifications are isolated individually. All release/remove observers get an
attempt even if an earlier observer throws. Async lifecycle observers are explicitly
unsupported: they cause conservative failure/eviction at release/acquisition, and their
rejections are observed without awaiting them. They must never issue SQL or mutate driver
state. Remove/async/log faults cannot interrupt queue/shutdown accounting. Diagnostic
errors are retained in bounded (32-entry) in-memory arrays, not logged automatically.
Use fixed codes/counts for telemetry; never serialize raw diagnostics, clients or SQL.
Async failures may arrive after the receipt: the diagnostics getter returns a fresh
snapshot. `pool.diagnostics` contains bounded pool-level diagnostic failures.

## Verification and remaining review

`driver-disposal.test.ts` independently exercises successful reuse, checkout-scoped
idempotency, release/remove exceptions, simultaneous faults, async/non-Error observers,
diagnostic failures, queue pressure, pending onConnect, connection rejection/timeout,
late acquisition, close timeout, repeated callbacks, reentrancy and shutdown. These are
synthetic transport schedules and make no PostgreSQL outcome claim.

`driver-disposal.integration.test.ts` runs only in explicitly approved disposable
GitHub-hosted PostgreSQL 17 infrastructure. It verifies exact COMMIT tags, fresh
independent committed-marker proof, failed-checkout backend absence, replacement waiter
progress and in-flight query rejection. It inventories databases, roles, schemas and
owned sessions before/after and drops only its UUID-owned database without FORCE.
Required cases must run with zero skips in their dedicated CI step. Ordinary integration
invocation skips this explicitly gated suite; those skips do not count as acceptance.

Full lint/build/typecheck/unit/PostgreSQL/Redis/HTTP checks remain required at the exact
candidate head. CI results and outstanding limitations are recorded in the PR/private
ledger. This document is the contract and maintenance plan, not a declaration that all
acceptance evidence has already been obtained. Code-level review is not an independent
human security audit. S1 must separately demonstrate outcomes, deadlines, command/work
ownership, cancellation and proof precedence before adopting the driver contract.

## Maintenance and rollback

Repository maintainers own this patch provisionally; production adoption requires a
named human maintenance/review owner, supported-runtime approval and an update cadence.
Review upstream security/compatibility changes before upgrading. Rebase patches only
onto an immutable package artifact, update all source/patch/license hashes, reproduce
the clean frozen install and rerun lifecycle plus real database regressions. Retire the
local patch only after an upstream public contract satisfies the same tests. Never use
mutable Git dependencies or edit installed node_modules as a production workaround.

Rollback: keep signup disabled, stop new admission, own/drain active and late operations,
then restart on the previously approved artifact and lockfile. Do not hot-swap a pool,
retry unknown COMMITs or erase retained claim/result/audit evidence. The original artifact
is recoverable from the S0 base. No migration, grant, HMAC secret or Redis change is part
of A1. Reverting the patch cannot make the original unsafe owner safe for public signup.
