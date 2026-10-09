# Real Redis integration tests

Start from the repository root with the existing dedicated test container listening
only on 127.0.0.1:6380:

```powershell
$env:TEST_REDIS_URL = 'redis://127.0.0.1:6380'
pnpm --filter @authcore/api test:redis
```

The command fails unless TEST_REDIS_URL is exactly that URL. It rejects missing
values, the development port 6379, remote hosts, credentials, alternate databases
and URL options before connecting. It never reads REDIS_URL as a fallback.
Normal API/workspace tests exclude these explicitly opted-in tests.

GitHub CI also runs `pnpm --filter @authcore/api test:redis` after the existing
workspace and PostgreSQL checks. Its job-scoped `redis:7-alpine` service maps
`127.0.0.1:6380:6379`, checks `redis-cli ping` every five seconds (three-second
timeout, ten retries), and sets the exact `TEST_REDIS_URL` above. Container port
6379 is internal only; the test client never falls back to host port 6379. The
service is isolated from development Redis and destroyed by GitHub at job end.
See [GitHub service container documentation](https://docs.github.com/en/actions/tutorials/use-containerized-services/use-docker-service-containers).

Each test uses a fresh UUID namespace and a shared Redis Cluster hash tag for its
two counters. A test adapter rewrites only production key names before forwarding
the unchanged production Lua and arguments to a real RedisService client.
Redis command replies, connections and failures are real; none are simulated.
Tests verify the production key prefix before rewriting it. Only exact registered
test keys are deleted afterward; no scans, database flushes or container changes
are used. Counter fixtures have TTLs, limiting leftovers if a run is interrupted.

The service constructor requires the application environment, so tests temporarily
supply a dummy unused PostgreSQL URL, local web origin, disabled signup, and the
validated test Redis URL. No .env files are loaded or changed. Outage tests replace
the service URL with a temporary loopback TCP proxy forwarding exclusively to
127.0.0.1:6380 and disconnect only that proxy's sockets. The container continues
running. Concurrent tests use multiple independent service connections.

Coverage includes per-IP and global caps, mixed concurrent traffic, fixed-window
TTLs, rejected-request accounting, rounded Retry-After headers, independent expiry
and reset, real Lua command errors, lazy connection sharing, shutdown, failed
initial connections, established connection loss, fail-closed guards and recovery
with preserved counters. Expiry tests shorten only test-owned TTLs instead of
waiting ten minutes. HTTP serialization is covered separately by the existing
controller integration tests.

Admission tests use the same isolated-key adapter and dedicated instance. They
exercise twenty independent clients contending for four slots, release on success
and failure, crashed-owner reclamation, stale-owner release, rejection of expired
renewal, a real operation lasting beyond the original thirty-second lease, and
fail-closed Lua errors. Connection outage tests also check that a burst of one
hundred callers during cooldown does not create additional TCP connections. Recovery
now waits for the documented one-second connection cooldown.

Reply-stall cases selectively drop only proxy replies while forwarding commands
to the real Redis instance. They verify shared handshake timeout/recovery and
post-send timeout teardown of all pending commands. A separate real connection
observes the consumed counter before timeout, proving that the ambiguous operation
executed. Recovery preserves a count of one, rejects commands from the retired
facade, and does not replay the consume. Only a new explicit request increments
the counter again. Deterministic deadline tests in `redis-deadlines.test.ts` run
in the ordinary workspace suite using a controlled TCP/RESP peer and fake timers;
the opted-in real Redis suite uses real time and the isolated Redis 7 instance.

These tests do not establish production capacity or Redis Cluster failover behavior.
See [SIGNUP_ADMISSION.md](SIGNUP_ADMISSION.md) for lease semantics, operational work
before enablement, and the limits of renewable leases during pauses/partitions.
