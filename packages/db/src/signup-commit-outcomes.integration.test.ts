import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool, type PoolClient, type QueryResult } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseClient } from './client.js';
import {
  SignupIdempotencyClaimRepository as Claims,
  SignupIdempotencyConflictError,
  SignupIdempotencyResultRepository as Results,
  type SignupClaimBinding,
} from './repositories/signup-idempotency.repository.js';
import { runSignupTransaction } from './signup-transaction.js';
import { approvedTestUrl, bounded, commitAckProxy, trace } from './s0-commit-proxy.test-support.js';

// Two explicit inputs. Merely running baseline CI must not authorize a new resource harness.
const enabled = process.env.S0_POSTGRES_APPROVED === 'true';
const supplied = process.env.TEST_DATABASE_URL;
const approved = enabled ? approvedTestUrl(supplied, process.env.DATABASE_URL) : undefined;
if (!approved)
  console.info(
    JSON.stringify({
      scope: 'S0-01..S0-07',
      status: 'BLOCKED',
      reason: !supplied
        ? 'dedicated TEST_DATABASE_URL unavailable'
        : 'S0_POSTGRES_APPROVED not true',
    }),
  );

describe.skipIf(!approved)('S0 real PostgreSQL characterization (no Phase B orchestration)', () => {
  const databaseName = `s0_outcomes_${randomUUID().replaceAll('-', '')}`;
  const applicationName = databaseName;
  let admin: Pool;
  let target: URL;
  let created = false;
  let before: Awaited<ReturnType<typeof inventory>>;
  const clients = new Set<Client>();
  const pools = new Set<Pool>();
  const proxies = new Set<Awaited<ReturnType<typeof commitAckProxy>>>();

  function config(url: URL) {
    return {
      connectionString: url.toString(),
      ssl: false as const,
      application_name: applicationName,
      connectionTimeoutMillis: 2_000,
      statement_timeout: 5_000,
      idle_in_transaction_session_timeout: 8_000,
    };
  }
  async function session(url = target) {
    const client = new Client(config(url));
    clients.add(client);
    client.on('error', () => {
      /* Query rejection/trace is the oracle; prevent unsolicited crash. */
    });
    await client.connect();
    return client;
  }
  function pool(url = target) {
    const value = new Pool({ ...config(url), max: 2, idleTimeoutMillis: 0 });
    pools.add(value);
    return value;
  }
  async function inventory() {
    return {
      databases: (await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows,
      roles: (await admin.query('SELECT rolname FROM pg_roles ORDER BY rolname')).rows,
      schemas: (await admin.query('SELECT nspname FROM pg_namespace ORDER BY nspname')).rows,
      sessions: (
        await admin.query(
          'SELECT pid, datname, state FROM pg_stat_activity WHERE application_name = $1 ORDER BY pid',
          [applicationName],
        )
      ).rows,
    };
  }
  const binding = (): SignupClaimBinding => ({
    keyVersion: 1,
    hmacKeyVersion: 1,
    keyDigest: randomBytes(32).toString('hex'),
    payloadVersion: 1,
    payloadDigest: randomBytes(32).toString('hex'),
  });
  async function reserve() {
    const client = await session();
    const key = binding();
    const { claim } = await new Claims(drizzle(client)).reserve(
      key,
      new Date(Date.now() + 86_400_000),
    );
    return { key, claim };
  }
  function evidence(scenario: string, log: ReturnType<typeof trace>) {
    console.info(JSON.stringify({ scenario, evidence: 'REAL_POSTGRESQL', events: log.events }));
  }
  function captureCommit(client: PoolClient, log: ReturnType<typeof trace>) {
    const original = client.query;
    client.query = function (...args: unknown[]) {
      return (Reflect.apply(original, client, args) as Promise<QueryResult>).then((result) => {
        if (args[0] === 'COMMIT' || args[0] === 'ROLLBACK')
          log.add(`owner_${args[0]}_query_resolved`, result.command);
        return result;
      });
    } as typeof client.query;
  }
  async function assertMarker(
    witness: Client,
    marker: string,
    present: boolean,
    log: ReturnType<typeof trace>,
  ) {
    const result = await witness.query('SELECT marker FROM public.s0_markers WHERE marker = $1', [
      marker,
    ]);
    expect(result.rows).toHaveLength(present ? 1 : 0);
    log.add('independent_fresh_read', present ? 'marker_present' : 'marker_absent');
  }
  async function waitForBlock(observer: Client, waiter: number, holder: number) {
    const deadline = performance.now() + 3_000;
    while (performance.now() < deadline) {
      const { rows } = await observer.query(
        'SELECT $2::integer = ANY(pg_blocking_pids($1::integer)) AS blocked',
        [waiter, holder],
      );
      if (rows[0].blocked) return;
      // Yield, never rely on a sleep duration as a concurrency barrier.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error('S0 barrier: expected backend lock wait not observed');
  }

  beforeAll(async () => {
    if (!approved) throw new Error('S0 approval gate failed');
    admin = new Pool({ ...config(approved), application_name: `${applicationName}_inventory` });
    expect((await admin.query('SELECT current_database() AS name')).rows[0].name).toBe(
      'authcore_test',
    );
    before = await inventory();
    console.info(JSON.stringify({ scope: 'S0', stage: 'before', inventory: before }));
    // No roles, shared schemas or shared tables are modified. UUID-owned database only.
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    target = new URL(approved);
    target.pathname = `/${databaseName}`;
    const setup = await session();
    const folder = new URL('../drizzle/', import.meta.url);
    for (const name of (await readdir(folder)).filter((name) => name.endsWith('.sql')).sort())
      await setup.query(await readFile(new URL(name, folder), 'utf8'));
    await setup.query('CREATE TABLE public.s0_markers (marker uuid PRIMARY KEY)');
    const settings = await setup.query(`SELECT current_database() AS database,
      current_setting('server_version') AS version, current_setting('fsync') AS fsync,
      current_setting('synchronous_commit') AS synchronous_commit,
      pg_is_in_recovery() AS recovery`);
    console.info(JSON.stringify({ scope: 'S0', settings: settings.rows }));
    expect(settings.rows[0]).toMatchObject({
      database: databaseName,
      fsync: 'on',
      synchronous_commit: 'on',
      recovery: false,
    });
    expect(settings.rows[0].version).toMatch(/^17\./);
  }, 20_000);

  async function closeOwnedTransports() {
    // Close proxies first, settling any in-flight queries before ending checked-out clients.
    for (const proxy of proxies) {
      await proxy.close();
      proxies.delete(proxy);
    }
    for (const client of clients) {
      await bounded(client.end(), 'client end');
      clients.delete(client);
    }
    for (const value of pools) {
      await bounded(value.end(), 'pool end');
      pools.delete(value);
    }
  }
  afterEach(closeOwnedTransports, 15_000);
  afterAll(async () => {
    if (!admin) return;
    try {
      await closeOwnedTransports();
      if (created) {
        const deadline = performance.now() + 5_000;
        while ((await inventory()).sessions.length && performance.now() < deadline)
          await new Promise<void>((resolve) => setImmediate(resolve));
        expect((await inventory()).sessions).toEqual([]);
        await admin.query(`DROP DATABASE "${databaseName}"`); // Exact UUID name created above only; no FORCE.
        created = false;
      }
      const after = await inventory();
      console.info(JSON.stringify({ scope: 'S0', stage: 'after', inventory: after }));
      expect(after).toEqual(before);
    } finally {
      await admin.end();
    }
  }, 20_000);

  it('S0-01 committed marker survives a real selectively withheld COMMIT ACK', async () => {
    const log = trace();
    const proxy = await commitAckProxy(target, log);
    proxies.add(proxy);
    const ownerPool = pool(proxy.url);
    const marker = randomUUID();
    proxy.arm();
    const pending = runSignupTransaction({ pool: ownerPool } as DatabaseClient, async (tx) => {
      await tx.execute(`SET LOCAL synchronous_commit = on`);
      // UUID is generated by the fixture; no user-controlled SQL interpolation.
      await tx.execute(`INSERT INTO public.s0_markers VALUES ('${marker}')`);
      log.add('marker_insert_completed');
      return marker;
    }).then(
      () => {
        throw new Error('Lost ACK unexpectedly reached owner');
      },
      (error: unknown) => {
        log.add(
          'owner_rejected_after_transport_failure',
          error instanceof Error ? error.name : typeof error,
        );
        return error;
      },
    );
    await proxy.waitForDrop();
    await bounded(pending, 'owner query settlement');
    const witness = await session();
    log.add('fresh_independent_connection_opened');
    await assertMarker(witness, marker, true, log);
    expect(log.events.map((event) => event.event)).toEqual([
      'marker_insert_completed',
      'COMMIT_forwarded_to_server',
      'server_CommandComplete_received',
      'COMMIT_ACK_withheld_transport_destroyed',
      'owner_rejected_after_transport_failure',
      'fresh_independent_connection_opened',
      'independent_fresh_read',
    ]);
    expect(ownerPool.totalCount).toBe(0);
    expect(ownerPool.idleCount).toBe(0);
    evidence('S0-01', log);
  });

  it('S0-02 server error plus acknowledged rollback definitely aborts owned writes', async () => {
    const log = trace();
    const client = await session();
    const witness = await session();
    const marker = randomUUID();
    await client.query('BEGIN');
    await client.query('INSERT INTO public.s0_markers VALUES ($1)', [marker]);
    await expect(client.query('SELECT 1 / 0')).rejects.toMatchObject({
      code: '22012',
      severity: 'ERROR',
    });
    log.add('server_ErrorResponse', '22012 ERROR');
    const rollback = await client.query('ROLLBACK');
    expect(rollback.command).toBe('ROLLBACK');
    log.add('acknowledged_command', rollback.command);
    await assertMarker(witness, marker, false, log);
    evidence('S0-02', log);
  });

  it('S0-03 S1 regression: real ROLLBACK COMMIT-tag rejects callback success', async () => {
    const log = trace();
    const ownerPool = pool();
    const client = await ownerPool.connect();
    const witness = await session();
    const marker = randomUUID();
    captureCommit(client, log);
    const database = { pool: { connect: async () => client } } as unknown as DatabaseClient;
    const pending = runSignupTransaction(database, async () => {
      await client.query('INSERT INTO public.s0_markers VALUES ($1)', [marker]);
      await expect(client.query('SELECT 1 / 0')).rejects.toMatchObject({ code: '22012' });
      log.add('swallowed_server_ErrorResponse', '22012');
      return 'current_false_success';
    });
    const observed = await pending.then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    );
    expect(log.events.find((event) => event.event === 'owner_COMMIT_query_resolved')?.detail).toBe(
      'ROLLBACK',
    );
    await assertMarker(witness, marker, false, log);
    log.add('owner_completion', observed.ok ? 'resolved_callback_value' : 'rejected');
    evidence('S0-03', log);
    expect(observed.ok).toBe(false);
  });

  it('S0-04 S1 regression: release fault preserves acknowledged durable COMMIT', async () => {
    const log = trace();
    const ownerPool = pool();
    const client = await ownerPool.connect();
    const witness = await session();
    const marker = randomUUID();
    captureCommit(client, log);
    const release = client.release.bind(client);
    const failure = new Error('S0 injected release failure');
    client.release = () => {
      log.add('injected_release_failure');
      throw failure;
    };
    try {
      const observed = await runSignupTransaction(
        { pool: { connect: async () => client } } as unknown as DatabaseClient,
        async () => {
          await client.query('INSERT INTO public.s0_markers VALUES ($1)', [marker]);
          return 'accepted';
        },
      ).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      );
      log.add(
        'owner_completion',
        observed.ok ? 'preserved_acknowledged_commit' : 'rejected_cleanup_error',
      );
      expect(
        log.events.find((event) => event.event === 'owner_COMMIT_query_resolved')?.detail,
      ).toBe('COMMIT');
      await assertMarker(witness, marker, true, log);
      expect(ownerPool.idleCount).toBe(0);
      // Throw-before-release leaves pool checkout owned; test must dispose it explicitly.
      log.add('pool_checkout_count_after_release_throw', String(ownerPool.totalCount));
      evidence('S0-04', log);
      expect(observed).toMatchObject({ ok: true, value: 'accepted' });
      expect(ownerPool.totalCount).toBe(0);
    } finally {
      client.release = release;
      release(true);
    }
  });

  it('S0-05 manual Phase A reservation survives real ACK loss independently of signup', async () => {
    const log = trace();
    const proxy = await commitAckProxy(target, log);
    proxies.add(proxy);
    const reservation = await session(proxy.url);
    const observer = await session();
    const key = binding();
    await reservation.query('BEGIN');
    await reservation.query('SET LOCAL synchronous_commit = on');
    const { claim } = await new Claims(drizzle(reservation)).reserve(
      key,
      new Date(Date.now() + 86_400_000),
    );
    expect(await new Claims(drizzle(observer)).findByKey(key)).toBeNull();
    log.add('uncommitted_claim_invisible');
    proxy.arm();
    const commit = reservation.query('COMMIT').then(
      () => {
        throw new Error('ACK loss not injected');
      },
      (error: unknown) => {
        log.add('reservation_COMMIT_rejected', error instanceof Error ? error.name : typeof error);
        return error;
      },
    );
    await proxy.waitForDrop();
    await bounded(commit, 'reservation COMMIT settlement');
    const witness = await session();
    log.add('fresh_independent_connection_opened');
    const repository = new Claims(drizzle(witness));
    expect(await repository.findByKey(key)).toEqual(claim);
    log.add('authoritative_claim_read_identity_binding_expiry_match');
    expect(await repository.reserve(key, new Date(claim.expiresAt.getTime() + 86_400_000))).toEqual(
      { reserved: false, claim },
    );
    await expect(
      repository.reserve(
        { ...key, payloadDigest: randomBytes(32).toString('hex') },
        claim.expiresAt,
      ),
    ).rejects.toBeInstanceOf(SignupIdempotencyConflictError);
    expect(await repository.findByKey(key)).toEqual(claim);
    log.add('no_rebinding_or_expiry_renewal');
    // A later signup-like transaction abort is independent of the durable reservation.
    await witness.query('BEGIN');
    await witness.query('ROLLBACK');
    expect(await repository.findByKey(key)).toEqual(claim);
    evidence('S0-05', log);
  });

  it.each(['COMMIT', 'ROLLBACK'] as const)(
    'S0-06 lock wait then separate fresh read after writer %s',
    async (outcome) => {
      const log = trace();
      const { key, claim } = await reserve();
      const writer = await session();
      const contender = await session();
      const observer = await session();
      const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const contenderPid = (await contender.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await writer.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await Claims.lockByKey(drizzle(writer), key);
      await new Results(drizzle(writer)).recordAccepted(claim.id);
      expect(await new Results(drizzle(observer)).findByClaimId(claim.id)).toBeNull();
      log.add('unlocked_missing_result_while_writer_live');
      await contender.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      expect(
        (await contender.query('SHOW transaction_isolation')).rows[0].transaction_isolation,
      ).toBe('read committed');
      const lock = Claims.lockByKey(drizzle(contender), key).then(
        (row) => ({ row }),
        (error: unknown) => ({ error }),
      );
      await waitForBlock(observer, contenderPid, writerPid);
      log.add('server_observed_contender_blocked_on_writer');
      const command = await writer.query(outcome);
      expect(command.command).toBe(outcome);
      log.add('writer_acknowledged', command.command);
      expect(await bounded(lock, 'contender lock')).toEqual({ row: claim });
      log.add('contender_claim_lock_acquired');
      const result = await new Results(drizzle(contender)).findByClaimId(claim.id);
      if (outcome === 'COMMIT')
        expect(result).toMatchObject({ claimId: claim.id, statusCode: 202 });
      else expect(result).toBeNull();
      log.add('separate_fresh_result_read', result ? 'accepted_result_present' : 'result_absent');
      await contender.query('ROLLBACK');
      evidence(`S0-06-${outcome}`, log);
    },
  );

  it('S0-06 negative same-statement join snapshot misses result committed during lock wait', async () => {
    const log = trace();
    const { claim } = await reserve();
    const writer = await session();
    const contender = await session();
    const observer = await session();
    const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const contenderPid = (await contender.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await writer.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await writer.query('SELECT id FROM public.signup_idempotency_claims WHERE id = $1 FOR UPDATE', [
      claim.id,
    ]);
    await new Results(drizzle(writer)).recordAccepted(claim.id);
    await contender.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const joined = contender
      .query(
        `SELECT c.id, r.claim_id FROM public.signup_idempotency_claims c
      LEFT JOIN public.signup_idempotency_results r ON r.claim_id = c.id WHERE c.id = $1 FOR UPDATE OF c`,
        [claim.id],
      )
      .then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
    await waitForBlock(observer, contenderPid, writerPid);
    log.add('join_statement_wait_observed');
    expect((await writer.query('COMMIT')).command).toBe('COMMIT');
    log.add('writer_COMMIT_acknowledged');
    expect(await bounded(joined, 'join lock')).toMatchObject({
      result: { rows: [{ id: claim.id, claim_id: null }] },
    });
    log.add('same_statement_result_missing');
    expect(await new Results(drizzle(contender)).findByClaimId(claim.id)).toMatchObject({
      claimId: claim.id,
    });
    log.add('separate_fresh_result_present');
    await contender.query('ROLLBACK');
    evidence('S0-06-JOIN', log);
  });

  it('S0-07 failed client is evicted and a fresh backend is used by next checkout', async () => {
    const log = trace();
    const ownerPool = pool();
    const original = await ownerPool.connect();
    const oldPid = (await original.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    captureCommit(original, log);
    log.add('original_backend_pid', String(oldPid));
    const primary = new Error('S0 deliberate work abort');
    await expect(
      runSignupTransaction(
        { pool: { connect: async () => original } } as unknown as DatabaseClient,
        async () => {
          throw primary;
        },
      ),
    ).rejects.toBe(primary);
    expect(ownerPool.totalCount).toBe(0);
    expect(ownerPool.idleCount).toBe(0);
    expect(
      log.events.find((event) => event.event === 'owner_ROLLBACK_query_resolved')?.detail,
    ).toBe('ROLLBACK');
    log.add('failed_client_evicted');
    const observer = await session();
    const deadline = performance.now() + 3_000;
    let remaining: number;
    do {
      remaining = (
        await observer.query('SELECT pid FROM pg_stat_activity WHERE pid = $1', [oldPid])
      ).rowCount!;
      if (remaining) await new Promise<void>((resolve) => setImmediate(resolve));
    } while (remaining && performance.now() < deadline);
    expect(remaining).toBe(0);
    log.add('server_confirmed_original_backend_absent');
    const next = await ownerPool.connect();
    try {
      const nextPid = (await next.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      expect(nextPid).not.toBe(oldPid);
      log.add('fresh_backend_acquired', String(nextPid));
    } finally {
      next.release();
    }
    evidence('S0-07', log);
  });
});
