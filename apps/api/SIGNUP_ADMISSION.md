# Signup admission control

Signup remains disabled by default (`SIGNUP_ENABLED=false`). This change does not
authorize enabling it. No development environment file is modified.

HTTP order: disabled guard (403), existing per-IP/global rate-limit guard (429),
admission interceptor, DTO validation, signup service, release in `finally`.
Validation failures consume an attempt but release admission without hashing or DB
access. Success and duplicate email keep the existing indistinguishable 202 response.
Unexpected operation errors retain the existing sanitized 500 response.

Rate limits are **5 requests per IP per 10 minutes** and **30 requests globally per
minute**, shared across API instances. Each counter uses a fixed window starting
with its first accepted request; later requests do not extend that window. The
atomic check increments both counters only when both quotas allow the attempt.
Rate-limit denials (429) increment neither counter and extend neither TTL. Requests
accepted by the limiter still consume an attempt if admission, validation or later
work fails; disabled-route requests (403) never reach the limiter. A lost Redis
reply can leave an already-applied consume charged, without automatic retry.

The per-IP key uses the direct socket-peer address (`request.socket.remoteAddress`),
not `X-Forwarded-For` or other client-supplied headers. Behind a reverse proxy,
clients sharing that proxy address share its quota. Enabling Express trusted-proxy
settings alone does not change this guard; per-client proxy support requires an
explicit trusted-proxy/address policy and corresponding implementation and tests.

The admission key `authcore:{signup}:admission` is a sorted set of random UUID owner
tokens with Redis-server-time expiry scores. Atomic Lua acquisition removes expired
tokens and admits at most **four** owners across API instances. Each owner has a
**30-second lease**, renewed every **10 seconds** using a non-overlapping timer.
Renewal verifies that the same token still exists and has not expired; it cannot
resurrect an expired owner. Release removes only that owner's token. The key itself
also expires, allowing crash recovery without a cleanup worker. Deploy instances
with the same constants and key; changing the limit requires a coordinated rollout.

Admission exhaustion, Redis failure, invalid replies and detected lease loss return
503 `Signup temporarily unavailable` with `Retry-After: 1`. This is a minimum retry
hint, not a guarantee of capacity. Clients should add jitter/backoff. Existing rate
limit 429 Retry-After and rate-limiter outage responses are unchanged.

The service checks the lease before hashing, after hashing, before starting the
transaction, before credential creation and before returning from the transaction.
A lost lease stops subsequent stages; throwing inside the transaction rolls it
back. Each process also caps in-flight admission at four, including acquisition,
and retains that local slot until actual work settles. No timeout races detach
hashing or database work. Timers stop on settlement, pending renewal drains before
release, and a release failure never masks committed success or the original error.
Unknown acquire outcomes receive a best-effort ownership-safe release and otherwise
expire naturally. Already-started native hashing and DB statements are not canceled.

## Redis outage behavior

RedisService shares one lazy connection promise, disables automatic reconnect and
offline queuing and caps the command queue at 128. The installed node-redis 5.12.1
removes command timeout/abort listeners when moving a command into its reply queue;
its `connectTimeout` ends at TCP/TLS connection, before Redis handshake replies.
Neither option alone bounds a stalled Redis reply.

The service now exposes a restricted command facade with a one-second absolute
deadline covering queued and sent command replies, including `withCommandOptions`
calls. Expiry destroys the affected raw client, flushing both pending queues. A
native queue timeout also retires the connection. Timers clear on settlement;
transaction/pipeline and raw-client escape APIs are not exposed. There is no
automatic retry of consume, acquire, renew or release. A sent timeout is an unknown
outcome: Redis may already have applied the write. Admission still releases only
its unique owner token best-effort, with lease TTL as the fallback.

TCP/TLS establishment uses node-redis's three-second transport timeout. A separate
three-second absolute handshake deadline starts on its public `connect` event,
when the socket is attached and `destroy()` can close it and reject handshake
waiters. These are separate phases (up to six seconds combined), not a claim that
the whole attempt completes in three seconds. Destroying before that event can
leave a late transport socket attached after destruction in this implementation.
Shutdown during transport establishment prevents exposure of the resulting client;
the bounded attempt drains and any established connection is retired. Shutdown
during handshake or commands destroys the established socket immediately.

After connection failure/socket error/timeout the service
allows at most one new connection attempt per second per service instance, on
demand. Each attempt uses a fresh raw client; retired facades reject commands, and
late settlement/error from an old client cannot retire a recovered connection or
extend its cooldown. Shutdown forbids reopening. There is no retry loop per request. Fleet-wide
attempts still scale with API replicas; capacity planning must account for that.

## Limits and operational work before enabling signup

A renewable lease is not a strict fencing mechanism for external resources. A
process pause longer than the lease, network partition, eviction, Redis restart,
clock jump or failover that loses acknowledged writes can allow another instance
to admit work while old native hashing/DB work is still in progress. Monotonic local
deadlines, renewal failure and service checkpoints stop later stages when execution
resumes, but cannot cancel an in-flight statement or fence PostgreSQL commit. A
commit can succeed even when its response/lease is lost; retrying may encounter the
same indistinguishable duplicate-email response. Internal SignupService callers
outside HTTP retain their existing behavior and do not acquire admission implicitly.

Before public enablement, load-test Argon2 memory/CPU and DB latency to justify four
slots, validate renewal margins under GC pauses, configure Redis no-eviction and
durability/failover policy for these control keys, monitor overload/renewal-loss and
connection failure rates without logging tokens, and set bounded DB transaction and
statement timeouts. If a hard global bound through arbitrary pauses/failover is
required, add downstream fencing or a durable bounded worker execution design.
This implementation does not claim that stronger guarantee.

## Verification

Unit tests cover reply validation, outage rejection, local capacity, token
uniqueness, delayed acquire, local expiry, renewal failure, timer lifecycle and
release failure. Service tests verify no DB access after lease loss during hashing
and no credential insert after lease loss during user insertion. HTTP tests cover
concurrent overload, sanitized 503/Retry-After, release on validation/success/
duplicate/exception, and unchanged 403/429 behavior.

Deterministic socket tests synchronize on received RESP commands before advancing
fake deadline timers. They reproduce stalled handshake and post-send replies with
the installed node-redis client, check peer-side socket closure, shared rejection,
cooldown, recovery, no replay, stale-timer safety and shutdown during handshake.

Run isolated Redis tests using [REDIS_INTEGRATION_TESTS.md](REDIS_INTEGRATION_TESTS.md).
PostgreSQL integration tests remain opt-in and are separate from Redis tests.
