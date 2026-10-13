import { randomUUID } from 'node:crypto';
import { Client, Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approvedTestUrl, bounded } from './s0-commit-proxy.test-support.js';

type Receipt = {
  removed: true;
  transportSettled: true;
  diagnostics: readonly { event: string; error: unknown }[];
};
type Owned = PoolClient & { dispose(): Promise<Receipt> };
const approved =
  process.env.A1_POSTGRES_APPROVED === 'true'
    ? approvedTestUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL)
    : undefined;
if (
  approved &&
  (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted')
)
  throw new Error('A1 requires disposable GitHub-hosted PostgreSQL');

describe.skipIf(!approved)('A1 real PostgreSQL ownership and transport receipts', () => {
  const name = 'a1_' + randomUUID().replaceAll('-', '');
  let admin: Pool;
  let config: {
    connectionString: string;
    application_name: string;
    connectionTimeoutMillis: number;
    ssl: false;
  };
  let before: Awaited<ReturnType<typeof inventory>>;
  let created = false;
  const pools = new Set<Pool>();
  const checkouts = new Set<Owned>();
  const witnesses = new Set<Client>();
  const inventory = async () => ({
    databases: (await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows,
    roles: (await admin.query('SELECT rolname FROM pg_roles ORDER BY rolname')).rows,
    schemas: (await admin.query('SELECT nspname FROM pg_namespace ORDER BY nspname')).rows,
    sessions: (
      await admin.query(
        'SELECT pid, datname FROM pg_stat_activity WHERE application_name = $1 ORDER BY pid',
        [name],
      )
    ).rows,
  });
  async function checkout() {
    const pool = new Pool({ ...config, max: 1, idleTimeoutMillis: 0 });
    pools.add(pool);
    const client = (await pool.connect()) as Owned;
    checkouts.add(client);
    client.on('error', () => {
      /* Pending query errors are independently observed. */
    });
    return { pool, client };
  }
  async function witness() {
    const value = new Client(config);
    witnesses.add(value);
    await value.connect();
    return value;
  }
  async function absent(observer: Client, pid: number) {
    const deadline = performance.now() + 3000;
    while (performance.now() < deadline) {
      if (
        (await observer.query('SELECT pid FROM pg_stat_activity WHERE pid=$1', [pid])).rowCount ===
        0
      )
        return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error('A1 old backend still present');
  }
  beforeAll(async () => {
    if (!approved) throw new Error('A1 missing approval');
    admin = new Pool({
      connectionString: approved.toString(),
      ssl: false,
      application_name: name + '_inventory',
    });
    expect((await admin.query('SELECT current_database() AS name')).rows[0].name).toBe(
      'authcore_test',
    );
    before = await inventory();
    console.info(JSON.stringify({ scope: 'A1', stage: 'before', inventory: before }));
    await admin.query('CREATE DATABASE "' + name + '"');
    created = true;
    const target = new URL(approved);
    target.pathname = '/' + name;
    config = {
      connectionString: target.toString(),
      ssl: false,
      application_name: name,
      connectionTimeoutMillis: 2000,
    };
    const setup = await witness();
    await setup.query('CREATE TABLE a1_markers (id uuid PRIMARY KEY)');
    const settings = (
      await setup.query(
        "SELECT current_setting('server_version') AS version, current_setting('fsync') AS fsync, current_setting('synchronous_commit') AS synchronous_commit, pg_is_in_recovery() AS recovery",
      )
    ).rows[0];
    expect(settings.version).toMatch(/^17\./);
    expect(settings).toMatchObject({ fsync: 'on', synchronous_commit: 'on', recovery: false });
    console.info(JSON.stringify({ scope: 'A1', settings }));
  });
  afterAll(async () => {
    try {
      for (const client of checkouts) await bounded(client.dispose(), 'A1 disposal');
      for (const pool of pools) await bounded(pool.end(), 'A1 pool end');
      for (const client of witnesses) await bounded(client.end(), 'A1 witness end');
      if (created) {
        expect((await inventory()).sessions).toEqual([]);
        await admin.query('DROP DATABASE "' + name + '"');
      }
      const after = await inventory();
      console.info(JSON.stringify({ scope: 'A1', stage: 'after', inventory: after }));
      expect(after).toEqual(before);
    } finally {
      await admin?.end();
    }
  });
  it.each(['release', 'remove'] as const)(
    '%s observer failure retains exact COMMIT proof, evicts and progresses',
    async (event) => {
      const { pool, client } = await checkout();
      const observer = await witness();
      const marker = randomUUID();
      const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await client.query('BEGIN');
      await client.query('INSERT INTO a1_markers VALUES ($1)', [marker]);
      const tag = (await client.query('COMMIT')).command;
      expect(tag).toBe('COMMIT');
      expect(
        (await observer.query('SELECT id FROM a1_markers WHERE id=$1', [marker])).rowCount,
      ).toBe(1);
      const fault = new Error('A1 controlled lifecycle fault');
      pool.once(event, () => {
        throw fault;
      });
      const waiting = pool.connect().then((value) => {
        checkouts.add(value as Owned);
        return value as Owned;
      });
      if (event === 'release') expect(() => client.release(true)).toThrow(fault);
      const first = client.dispose();
      expect(client.dispose()).toBe(first);
      const receipt = await bounded(first, 'A1 receipt');
      expect(receipt).toMatchObject({ removed: true, transportSettled: true });
      expect(receipt.diagnostics).toContainEqual({ event, error: fault });
      await absent(observer, pid);
      const next = await bounded(waiting, 'A1 waiter');
      expect((await next.query('SELECT pg_backend_pid() AS pid')).rows[0].pid).not.toBe(pid);
      await next.dispose();
      console.info(
        JSON.stringify({
          scope: 'A1',
          scenario: event,
          commitTag: tag,
          independentMarker: true,
          backendAbsent: true,
          waiterProgress: true,
          total: pool.totalCount,
          closing: (pool as Pool & { closingCount: number }).closingCount,
        }),
      );
    },
  );
  it('disposal settles an in-flight query rejection before shutdown; no SQL success is invented', async () => {
    const { pool, client } = await checkout();
    const observer = await witness();
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    let querySettled = false;
    const query = client.query('SELECT pg_sleep(30)').then(
      () => 'unexpected-success',
      () => {
        querySettled = true;
        return 'rejected';
      },
    );
    const receipt = await bounded(client.dispose(), 'A1 active query disposal');
    expect(receipt.transportSettled).toBe(true);
    expect(querySettled).toBe(true);
    expect(await query).toBe('rejected');
    await absent(observer, pid);
    expect(pool.totalCount).toBe(0);
  });
});
