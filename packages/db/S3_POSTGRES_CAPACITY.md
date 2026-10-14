# S3 PostgreSQL critical-section capacity

Development implementation; independent security review and production activation
remain gated. Signup defaults to disabled. No new migration, dependency or privilege
grant is required by this slice.

## Contract and ordering

Use exactly four exclusive transaction-level advisory slots in the reserved two-int32
namespace `0x41555448` (ASCII AUTH), slots 0..3. Neither key comes from request input or
configuration. One bounded nonblocking pass tries each slot sequentially and stops at
its first success. Exhaustion aborts with controlled backpressure; there is no hidden
retry, sleeping waiter or background work. Malformed server replies fail closed.

The gate requires the actual active S1 owner transaction object. A pool/autocommit
adapter, copied facade, ended or cancelled worker cannot own a capacity slot. Each
transaction may attempt the gate once. This prevents both false autocommit ownership
and reentrant acquisition being mistaken for an additional capacity grant.

Phase B T1 reservation/reconciliation and claim-policy execution/recovery acquire a
slot before any claim lock, unique-index wait or ledger/domain write. Order remains:
slot -> one claim -> user unique index -> credential -> audit -> accepted result.
Startup read-only namespace attestation needs no claim lock or slot. Existing Phase A
repository primitives remain caller-owned and are not standalone Phase B writers;
activation must forbid old/unkeyed writers and mixed protocol versions.

PostgreSQL owns slot release at transaction end. Local socket disposal never proves
remote rollback, server completion or lock release; server timeouts and a later
conforming synchronization barrier remain required. The same namespace used by an
unrelated application can reduce availability, so reserve it in the deployment's
advisory-key inventory. A collision fails closed; it cannot enlarge capacity. The
bigint advisory key space and neighboring two-int32 namespaces are distinct.

## Tested scope and residual capacity risk

The gate bounds participating SQL critical sections in the same PostgreSQL database
on the authoritative primary. It does not bound all SQL, total connections, API fleet
size or fleet-wide Argon2 memory. A copied database, split-brain primary or an old writer
is outside that bound. No Redis lease or returned slot number is a fencing token.

Local/Redis admission and existing rate limits remain intact. Local admission must
stay occupied until actual native hashing/work/transport settles. Redis lease expiry
can admit a replacement while a stale process hashes. A hard fleet-wide hashing cap
requires a separately approved fixed worker pool or fenced database execution-lease
protocol with crash recovery; worker/policy/operational trade-offs remain a production
capacity decision. Advisory SQL slots are not presented as that mechanism.

The isolated suite covers exhaustion/progress, T1 and recovery backpressure with no
writes, slot-before-claim waiting, active-statement local closure, exact disposable
backend termination, cancelled delayed workers, namespace collisions, restricted
builtin execution, pool saturation and late disposal, and real Redis lease expiry.
Four independent loopback HTTP **test API processes** execute the production owner and
gate through distinct restricted-role sessions; normal release and an owned process
crash prove cross-process capacity and server-confirmed recovery. These are explicit
capacity harness routes, not public signup endpoints or a substitute for S5 HTTP E2E.
Credentials reach child processes through private stdin, never arguments/logs.
Every process, server, client and database/role fixture has cleanup ownership, including
startup failure. Unexpected idle-pool errors fail sanitized cleanup. Required JSON
checks reject any skipped/missing capacity assertion.

## Operations and rollback

No live deployment/grant change was performed. Before activation, verify all writers
use the same primary/database/protocol/namespace and the restricted role has the
standard builtin EXECUTE privilege. Do not add broad grants automatically. Observe
allowlisted overload/owner/cleanup counters without keys, digests or raw errors.
Backpressure maps to controlled retryable failure in the later HTTP slice.

Rollback disables signup, stops admission and drains or explicitly contains all
owners. Do not switch live traffic to an ungated writer, unlock another session,
remove retained ledgers, or interpret pool shutdown as remote rollback proof.

Primary references: [transaction advisory lock semantics](https://www.postgresql.org/docs/17/explicit-locking.html#ADVISORY-LOCKS),
[nonblocking lock functions and key spaces](https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS).
