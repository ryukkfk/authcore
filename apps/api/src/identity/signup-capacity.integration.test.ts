import 'reflect-metadata';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from 'redis';
import {
  acquireSignupCapacity,
  inspectSignupClaim,
  runOwnedSignupTransaction,
  runSignupTransaction,
  SignupCapacityUnavailable,
  SIGNUP_CAPACITY_NAMESPACE as namespace,
  SIGNUP_POSTGRES_SLOTS,
  signupOwnerInventory,
} from '@authcore/db';
import { approvedTestUrl, bounded, deferred } from '@authcore/testing';
import {
  createSignupReservationBoundary,
  type SignupReservationBoundary,
} from './signup-reservation.js';
import {
  createReservationFixture,
  testSignupConfiguration,
  type ReservationFixture,
} from './signup-reservation.test-support.js';
const approved =
  process.env.S3_POSTGRES_APPROVED === 'true'
    ? approvedTestUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL)
    : undefined;
if (
  approved &&
  (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted')
)
  throw new Error('S3 requires disposable GitHub-hosted services');
const input = { email: 'capacity@example.invalid', password: 'public test password input 123' };
describe.skipIf(!approved)(
  'S3 real PostgreSQL capacity across sessions and HTTP API processes',
  () => {
    let fixture: ReservationFixture;
    let boundary: SignupReservationBoundary;
    const childProcesses = new Map<ReturnType<typeof spawn>, Promise<unknown>>();
    const bound = () => boundary.bind('s3_' + randomUUID(), input);
    const heldCount = async () =>
      Number(
        (
          await fixture.owner.pool.query(
            "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid=$1::oid AND objsubid=2 AND granted",
            [namespace],
          )
        ).rows[0].n,
      );
    async function withSlots<T>(work: () => Promise<T>) {
      const clients = [];
      try {
        for (let slot = 0; slot < SIGNUP_POSTGRES_SLOTS; slot++) {
          const client = await fixture.runtime.pool.connect();
          clients.push(client);
          await client.query('BEGIN');
          expect(
            (
              await client.query(
                'SELECT pg_catalog.pg_try_advisory_xact_lock($1::integer,$2::integer) AS acquired',
                [namespace, slot],
              )
            ).rows[0].acquired,
          ).toBe(true);
        }
        return await work();
      } finally {
        for (const client of clients) {
          try {
            await client.query('ROLLBACK');
          } finally {
            client.release();
          }
        }
      }
    }
    beforeAll(async () => {
      if (!approved) throw new Error('S3 approval missing');
      fixture = await createReservationFixture(approved);
      boundary = (await createSignupReservationBoundary(fixture.runtime, {
        enabled: true,
        configuration: testSignupConfiguration(),
        executionWindowMs: 86400000,
      }))!;
    }, 30000);
    afterEach(async () => {
      vi.restoreAllMocks();
      const unexpected = [...childProcesses.entries()];
      const cleanup = await Promise.allSettled(
        unexpected.map(async ([child, exited]) => {
          child.kill('SIGTERM');
          try {
            await bounded(exited, 'S3 startup-failure process cleanup', 5000);
          } catch (error) {
            child.kill('SIGKILL');
            await exited;
            throw error;
          } finally {
            child.stdin?.destroy();
            child.stdout?.destroy();
            child.stderr?.destroy();
            childProcesses.delete(child);
          }
        }),
      );
      expect(cleanup.every((result) => result.status === 'fulfilled')).toBe(true);
      expect(unexpected.length).toBe(0);
      if (fixture) expect(await heldCount()).toBe(0);
    });
    afterAll(async () => {
      await fixture?.close();
    }, 30000);
    it('four independent transactions exhaust the fixed gate and rollback restores progress', async () => {
      await withSlots(async () => {
        expect(await heldCount()).toBe(4);
        const before = performance.now();
        await expect(
          runSignupTransaction(fixture.runtime, acquireSignupCapacity),
        ).rejects.toBeInstanceOf(SignupCapacityUnavailable);
        const elapsed = performance.now() - before;
        expect(elapsed).toBeLessThan(1000);
        expect(await heldCount()).toBe(4);
        console.info(
          JSON.stringify({
            scenario: 'S3_EXHAUSTION',
            slots: 4,
            elapsedMs: elapsed,
            hiddenRetries: 0,
          }),
        );
      });
      expect(await runSignupTransaction(fixture.runtime, acquireSignupCapacity)).toBe(0);
    });
    it('T1 backpressure inserts no claim and never rebinds under slot exhaustion', async () => {
      const binding = await bound();
      await withSlots(async () => {
        await expect(boundary.reserve(binding)).rejects.toBeInstanceOf(SignupCapacityUnavailable);
      });
      expect(
        (
          await fixture.owner.pool.query(
            'SELECT id FROM signup_idempotency_claims WHERE key_digest=$1',
            [binding.keyDigest],
          )
        ).rowCount,
      ).toBe(0);
    });
    it('recovery backpressure cannot append terminal or accepted results', async () => {
      const binding = await bound();
      const reservation = await boundary.reserve(binding);
      const before = await fixture.writes();
      await withSlots(async () => {
        await expect(
          runSignupTransaction(fixture.runtime, (tx) =>
            inspectSignupClaim(tx, binding, 'recovery'),
          ),
        ).rejects.toBeInstanceOf(SignupCapacityUnavailable);
      });
      expect(await fixture.writes()).toEqual(before);
      expect(
        (
          await fixture.owner.pool.query('SELECT id FROM signup_idempotency_claims WHERE id=$1', [
            reservation.claim.id,
          ])
        ).rowCount,
      ).toBe(1);
    });
    it('a waiting claim locker owns its slot before the claim lock barrier', async () => {
      const binding = await bound();
      const { claim } = await boundary.reserve(binding);
      const locker = await fixture.owner.pool.connect();
      const promise = deferred<void>();
      let pending: ReturnType<typeof runOwnedSignupTransaction> | undefined;
      try {
        await locker.query('BEGIN');
        await locker.query('SELECT id FROM signup_idempotency_claims WHERE id=$1 FOR UPDATE', [
          claim.id,
        ]);
        pending = runOwnedSignupTransaction(fixture.runtime, async (tx) => {
          promise.resolve();
          return inspectSignupClaim(tx, binding, 'execution');
        });
        await promise.promise;
        await expect
          .poll(
            async () =>
              Number(
                (
                  await locker.query(
                    "SELECT count(*)::int AS n FROM pg_stat_activity a WHERE a.datname=current_database() AND a.wait_event_type='Lock' AND EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND l.locktype='advisory' AND l.classid=$1::oid AND l.objsubid=2 AND l.granted)",
                    [namespace],
                  )
                ).rows[0].n,
              ),
            { interval: 10, timeout: 700 },
          )
          .toBe(1);
        expect(await heldCount()).toBe(1);
      } finally {
        await locker.query('ROLLBACK');
        locker.release();
      }
      const result = await pending!;
      await result.workSettlement;
      await result.settlement;
      expect(result.outcome).toBe('COMMIT_ACK');
    });
    it('local transport disposal cannot manufacture server-side slot release during an active statement', async () => {
      const controller = new AbortController();
      const entered = deferred<number>();
      const pending = runOwnedSignupTransaction(
        fixture.runtime,
        async (tx) => {
          await acquireSignupCapacity(tx);
          const pid = Number((await tx.execute('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
          await tx.execute("SELECT set_config('statement_timeout','1500ms',true)");
          entered.resolve(pid);
          await tx.execute('SELECT pg_sleep(10)');
        },
        { signal: controller.signal },
      );
      const pid = await entered.promise;
      await expect
        .poll(
          async () =>
            Number(
              (
                await fixture.owner.pool.query(
                  "SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=$1 AND state='active' AND query LIKE '%pg_sleep(10)%'",
                  [pid],
                )
              ).rows[0].n,
            ),
          { interval: 10, timeout: 500 },
        )
        .toBe(1);
      controller.abort();
      const result = await pending;
      await result.workSettlement;
      await result.settlement;
      expect(result.outcome).not.toBe('COMMIT_ACK');
      expect(result.cleanup).toBe('EVICTED');
      expect(await heldCount()).toBe(1);
      await expect.poll(heldCount, { interval: 20, timeout: 2500 }).toBe(0);
      console.info(
        JSON.stringify({
          scenario: 'S3_LOCAL_CLOSE_NOT_SERVER_RELEASE',
          localCleanup: result.cleanup,
          serverTimeoutMs: 1500,
          eventualSlots: 0,
        }),
      );
    });
    it('terminating the exact disposable runtime backend releases its slot and permits a fresh owner', async () => {
      const entered = deferred<number>();
      const pending = runOwnedSignupTransaction(fixture.runtime, async (tx) => {
        await acquireSignupCapacity(tx);
        entered.resolve(Number((await tx.execute('SELECT pg_backend_pid() AS pid')).rows[0]!.pid));
        await tx.execute('SELECT pg_sleep(10)');
      });
      const pid = await entered.promise;
      expect(
        (
          await fixture.owner.pool.query(
            'SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE pid=$1 AND datname=current_database() AND usename=$2',
            [pid, fixture.runtimeUrl.username],
          )
        ).rows[0]?.terminated,
      ).toBe(true);
      const result = await pending;
      await result.workSettlement;
      await result.settlement;
      expect(result.outcome).not.toBe('COMMIT_ACK');
      await expect.poll(heldCount, { interval: 10, timeout: 1000 }).toBe(0);
      expect(await runSignupTransaction(fixture.runtime, acquireSignupCapacity)).toBe(0);
    });
    it('a cancelled delayed worker cannot acquire a slot or resume SQL later', async () => {
      const entered = deferred<void>();
      const resume = deferred<void>();
      const controller = new AbortController();
      let lateCode: unknown;
      const pending = runOwnedSignupTransaction(
        fixture.runtime,
        async (tx) => {
          entered.resolve();
          await resume.promise;
          try {
            await acquireSignupCapacity(tx);
          } catch (error) {
            lateCode = error;
            throw error;
          }
        },
        { signal: controller.signal },
      );
      await entered.promise;
      controller.abort();
      const result = await pending;
      resume.resolve();
      await result.workSettlement;
      await result.settlement;
      expect(lateCode).toMatchObject({ code: 'WORK_OWNERSHIP_REQUIRED' });
      expect(await heldCount()).toBe(0);
    });
    it('the two-int32 namespace is separate from bigint and neighboring application namespaces', async () => {
      const blocker = await fixture.runtime.pool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          'SELECT pg_advisory_xact_lock($1::bigint), pg_advisory_xact_lock($2::integer,0)',
          [(BigInt(namespace) << 32n).toString(), namespace + 1],
        );
        expect(await runSignupTransaction(fixture.runtime, acquireSignupCapacity)).toBe(0);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
    });
    it('a colliding external slot user causes conservative backpressure without increasing capacity', async () => {
      await withSlots(async () => {
        await expect(
          runSignupTransaction(fixture.database(), acquireSignupCapacity),
        ).rejects.toBeInstanceOf(SignupCapacityUnavailable);
        expect(await heldCount()).toBe(4);
      });
    });
    it('the restricted role executes the existing builtin with no new grants and holds at most one slot', async () => {
      await runSignupTransaction(fixture.runtime, async (tx) => {
        const slot = await acquireSignupCapacity(tx);
        expect(slot).toBe(0);
        await expect(acquireSignupCapacity(tx)).rejects.toMatchObject({
          code: 'SIGNUP_CAPACITY_ALREADY_ATTEMPTED',
        });
        const row = (
          await tx.execute(
            "SELECT current_user AS login, session_user AS session, has_function_privilege(current_user,'pg_catalog.pg_try_advisory_xact_lock(integer,integer)','EXECUTE') AS allowed",
          )
        ).rows[0]!;
        expect(row).toEqual({
          login: fixture.runtimeUrl.username,
          session: fixture.runtimeUrl.username,
          allowed: true,
        });
        expect(await heldCount()).toBe(1);
      });
    });
    it('saturated pool acquisition stays owned, starts no late work and disposes its late checkout', async () => {
      const held = await Promise.all(
        Array.from({ length: 10 }, () => fixture.runtime.pool.connect()),
      );
      const work = vi.fn(acquireSignupCapacity);
      let result: Awaited<ReturnType<typeof runOwnedSignupTransaction>>;
      try {
        result = await runOwnedSignupTransaction(fixture.runtime, work);
        expect(result.outcome).toBe('NOT_SUBMITTED');
        expect(result.primary?.error).toMatchObject({ code: 'ACQUIRE_DEADLINE' });
        expect(work).not.toHaveBeenCalled();
      } finally {
        for (const client of held) client.release();
      }
      await bounded(result!.workSettlement, 'S3 late callback settlement');
      await bounded(result!.settlement, 'S3 late checkout disposal');
      expect(work).not.toHaveBeenCalled();
      expect(signupOwnerInventory(fixture.runtime)).toEqual([]);
    });
    it('Redis lease expiry does not release or fence a PostgreSQL transaction slot', async () => {
      const raw = process.env.TEST_REDIS_URL;
      if (!raw) throw new Error('S3 dedicated Redis missing');
      const url = new URL(raw);
      if (
        !['localhost', '127.0.0.1'].includes(url.hostname) ||
        url.protocol !== 'redis:' ||
        url.port !== '6380' ||
        url.search ||
        url.hash ||
        !['', '/'].includes(url.pathname)
      )
        throw new Error('S3 dedicated Redis target rejected');
      const redis = createClient({
        url: raw,
        socket: { reconnectStrategy: false, connectTimeout: 1000 },
      });
      let redisFault = false;
      redis.on('error', () => {
        redisFault = true;
      });
      const lease = 'authcore:s3:{' + randomUUID() + '}:lease';
      try {
        await redis.connect();
        await runSignupTransaction(fixture.runtime, async (tx) => {
          await acquireSignupCapacity(tx);
          await redis.set(lease, 'test-owner', { PX: 50 });
          await expect.poll(() => redis.exists(lease), { interval: 10, timeout: 500 }).toBe(0);
          expect(await heldCount()).toBe(1);
        });
        expect(redisFault).toBe(false);
      } finally {
        if (redis.isReady) await redis.del(lease);
        if (redis.isOpen) redis.destroy();
      }
    });
    async function childApi() {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL('./signup-capacity-api.test-support.mjs', import.meta.url))],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      );
      const ready = deferred<{ port: number }>();
      const held = deferred<{ slot: number; pid: number; login: string }>();
      const faults: string[] = [];
      let buffer = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (data) => {
        stderr += String(data);
      });
      child.stdout.on('data', (data) => {
        buffer += String(data);
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          try {
            const event = JSON.parse(line);
            if (event.kind === 'READY') ready.resolve(event);
            else if (event.kind === 'HELD') held.resolve(event);
            else faults.push('child failure');
          } catch {
            faults.push('invalid child message');
          }
        }
      });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => child.once('close', (code, signal) => resolve({ code, signal })),
      );
      childProcesses.set(child, exited);
      child.on('error', () => faults.push('child startup error'));
      child.stdin.on('error', () => faults.push('child stdin error'));
      child.stdin.write(JSON.stringify({ url: fixture.runtimeUrl.toString() }) + '\n');
      const address = await bounded(
        Promise.race([
          ready.promise,
          exited.then(() => {
            throw new Error('S3 child exited before ready');
          }),
        ]),
        'S3 child API ready',
        10000,
      );
      const base = 'http://127.0.0.1:' + address.port;
      const controller = new AbortController();
      const response = fetch(base + '/hold', { method: 'POST', signal: controller.signal }).then(
        async (response) => ({ status: response.status, body: await response.json() }),
        () => undefined,
      );
      return {
        child,
        held,
        exited,
        controller,
        response,
        faults,
        release: () => fetch(base + '/release', { method: 'POST' }),
        async close(crashed = false) {
          if (!crashed && child.exitCode === null && child.signalCode === null)
            child.stdin.end('stop\n');
          const end = await bounded(exited, 'S3 child process exit', 5000).catch(async (error) => {
            child.kill('SIGKILL');
            await exited;
            throw error;
          });
          controller.abort();
          await response;
          expect(faults).toEqual([]);
          expect(stderr).toBe('');
          if (!crashed) expect(end.code).toBe(0);
          else expect(end.signal).toBe('SIGKILL');
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          childProcesses.delete(child);
        },
      };
    }
    it('four independent HTTP API processes share exactly four PostgreSQL slots', async () => {
      const children: Awaited<ReturnType<typeof childApi>>[] = [];
      try {
        for (let i = 0; i < 4; i++) children.push(await childApi());
        const holdings = await Promise.all(
          children.map((child) => bounded(child.held.promise, 'S3 API held')),
        );
        expect(new Set(holdings.map((value) => value.pid)).size).toBe(4);
        expect(new Set(holdings.map((value) => value.slot)).size).toBe(4);
        expect(holdings.every((value) => value.login === fixture.runtimeUrl.username)).toBe(true);
        expect(await heldCount()).toBe(4);
        await expect(
          runSignupTransaction(fixture.runtime, acquireSignupCapacity),
        ).rejects.toBeInstanceOf(SignupCapacityUnavailable);
        await children[0]!.release();
        const accepted = await children[0]!.response;
        expect(accepted?.status).toBe(202);
        expect(accepted?.body.outcome).toBe('COMMIT_ACK');
        expect(await runSignupTransaction(fixture.runtime, acquireSignupCapacity)).toBe(
          holdings[0]!.slot,
        );
        console.info(
          JSON.stringify({
            scenario: 'S3_HTTP_PROCESS_CAPACITY',
            processes: 4,
            distinctBackends: 4,
            slots: 4,
          }),
        );
      } finally {
        const cleanup = await Promise.allSettled(children.map((child) => child.close()));
        expect(cleanup.every((result) => result.status === 'fulfilled')).toBe(true);
      }
    }, 20000);
    it('crashing one API process frees capacity only after authoritative backend absence', async () => {
      const children: Awaited<ReturnType<typeof childApi>>[] = [];
      let crashed = false;
      try {
        for (let i = 0; i < 4; i++) children.push(await childApi());
        const holdings = await Promise.all(
          children.map((child) => bounded(child.held.promise, 'S3 API held before crash')),
        );
        children[0]!.child.kill('SIGKILL');
        crashed = true;
        await children[0]!.exited;
        await expect
          .poll(
            async () =>
              Number(
                (
                  await fixture.owner.pool.query(
                    'SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=$1 AND datname=current_database()',
                    [holdings[0]!.pid],
                  )
                ).rows[0].n,
              ),
            { interval: 10, timeout: 2000 },
          )
          .toBe(0);
        expect(await heldCount()).toBe(3);
        expect(await runSignupTransaction(fixture.runtime, acquireSignupCapacity)).toBe(
          holdings[0]!.slot,
        );
      } finally {
        const cleanup = await Promise.allSettled(
          children.map((child, i) => child.close(i === 0 && crashed)),
        );
        expect(cleanup.every((result) => result.status === 'fulfilled')).toBe(true);
      }
    }, 20000);
  },
);
