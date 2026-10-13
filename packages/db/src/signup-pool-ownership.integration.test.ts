import { randomUUID } from 'node:crypto';
import { Client, Pool, type PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
type Owned = PoolClient & { dispose(): Promise<{ removed: true; transportSettled: true }> };
import { approvedTestUrl, bounded } from './s0-commit-proxy.test-support.js';

// Same narrow CI trust boundary as S0. Never use an application DATABASE_URL.
const approved =
  process.env.S1_POSTGRES_APPROVED === 'true'
    ? approvedTestUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL)
    : undefined;
if (
  approved &&
  (process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    process.env.DATABASE_URL)
)
  throw new Error('S1 prerequisite probe requires isolated GitHub-hosted CI');
if (!approved) console.info('S1_POOL_API_PROBE_NOT_APPROVED: no PostgreSQL connection attempted');

describe.skipIf(!approved)('S1 real PostgreSQL public driver ownership regression', () => {
  it('a consumed release fault preserves COMMIT proof and public disposal completes shutdown', async () => {
    if (!approved) throw new Error('S1 probe approval missing');
    const databaseName = 's1_pool_' + randomUUID().replaceAll('-', '');
    const baseConfig = {
      ssl: false as const,
      connectionTimeoutMillis: 2_000,
      statement_timeout: 3_000,
      idle_in_transaction_session_timeout: 3_000,
    };
    const admin = new Pool({
      ...baseConfig,
      connectionString: approved.toString(),
      application_name: databaseName + '_inventory',
    });
    const inventory = async () => ({
      databases: (await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows,
      roles: (await admin.query('SELECT rolname FROM pg_roles ORDER BY rolname')).rows,
      schemas: (await admin.query('SELECT nspname FROM pg_namespace ORDER BY nspname')).rows,
      sessions: (
        await admin.query(
          'SELECT pid, datname, state FROM pg_stat_activity WHERE application_name = $1 ORDER BY pid',
          [databaseName],
        )
      ).rows,
    });
    let created = false;
    let pool: Pool | undefined;
    let checkout: Owned | undefined;
    let witness: Client | undefined;
    let ending: Promise<void> | undefined;
    let before: Awaited<ReturnType<typeof inventory>> | undefined;
    try {
      expect((await admin.query('SELECT current_database() AS name')).rows[0].name).toBe(
        'authcore_test',
      );
      before = await inventory();
      console.info(JSON.stringify({ scope: 'S1_POOL_API', stage: 'before', inventory: before }));
      await admin.query('CREATE DATABASE "' + databaseName + '"');
      created = true;
      const target = new URL(approved);
      target.pathname = '/' + databaseName;
      const config = {
        ...baseConfig,
        connectionString: target.toString(),
        application_name: databaseName,
      };
      pool = new Pool({ ...config, max: 1, idleTimeoutMillis: 0 });
      checkout = (await pool.connect()) as Owned;
      checkout.on('error', () => {
        /* Owned query rejection and fixture probes are observed. */
      });
      const settings = (
        await checkout.query(
          "SELECT current_setting('server_version') AS version, current_setting('fsync') AS fsync," +
            " current_setting('synchronous_commit') AS synchronous_commit, pg_is_in_recovery() AS recovery",
        )
      ).rows[0];
      expect(settings.version).toMatch(/^17\./);
      expect(settings).toMatchObject({ fsync: 'on', synchronous_commit: 'on', recovery: false });
      console.info(JSON.stringify({ scope: 'S1_POOL_API', settings }));
      await checkout.query('CREATE TABLE public.s1_marker (id uuid PRIMARY KEY)');
      const marker = randomUUID();
      await checkout.query('BEGIN');
      await checkout.query('INSERT INTO public.s1_marker VALUES ($1)', [marker]);
      const commit = await checkout.query('COMMIT');
      expect(commit.command).toBe('COMMIT');

      witness = new Client(config);
      witness.on('error', () => {
        /* Explicit fixture cleanup owns this connection. */
      });
      await witness.connect();
      expect(
        (await witness.query('SELECT id FROM public.s1_marker WHERE id = $1', [marker])).rowCount,
      ).toBe(1);
      const oldPid = (await checkout.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await checkout.end();
      const deadline = performance.now() + 3_000;
      let remaining: number;
      do {
        remaining = (
          await witness.query('SELECT pid FROM pg_stat_activity WHERE pid = $1', [oldPid])
        ).rowCount!;
        if (remaining) await new Promise<void>((resolve) => setImmediate(resolve));
      } while (remaining && performance.now() < deadline);
      expect(remaining).toBe(0);

      const releaseFault = new Error('S1 controlled release-event exception');
      pool.once('release', () => {
        throw releaseFault;
      });
      expect(() => checkout!.release(true)).toThrow(releaseFault);
      expect(pool.idleCount).toBe(0);
      expect(() => checkout!.release(true)).toThrow('already been released');
      const receipt = await bounded(checkout.dispose(), 'public ownership disposal');
      expect(receipt).toMatchObject({ removed: true, transportSettled: true });
      expect(pool.totalCount).toBe(0);
      ending = pool.end();
      await bounded(ending, 'pool shutdown after public disposal', 1_000);
      console.info(
        JSON.stringify({
          scenario: 'S1_POOL_API_REPAIRED',
          evidence: 'REAL_POSTGRESQL_AND_INSTALLED_PG_POOL',
          commitTag: commit.command,
          independentCommittedMarker: true,
          serverConfirmedOldBackendAbsent: true,
          poolTotal: pool.totalCount,
          poolIdle: pool.idleCount,
          publicReleaseConsumed: true,
          publicDisposalReceipt: true,
          poolShutdownCompleted: true,
        }),
      );
      expect(pool.totalCount).toBe(0);
    } finally {
      if (checkout) await bounded(checkout.dispose(), 'owned checkout disposal');
      if (pool) await bounded(ending ?? pool.end(), 'owned pool end');
      if (witness) await bounded(witness.end(), 'owned witness end');
      try {
        if (created) {
          const deadline = performance.now() + 3_000;
          while ((await inventory()).sessions.length && performance.now() < deadline)
            await new Promise<void>((resolve) => setImmediate(resolve));
          expect((await inventory()).sessions).toEqual([]);
          await admin.query('DROP DATABASE "' + databaseName + '"'); // Exact UUID-owned DB; no FORCE.
        }
        if (before) {
          const after = await inventory();
          console.info(JSON.stringify({ scope: 'S1_POOL_API', stage: 'after', inventory: after }));
          expect(after).toEqual(before);
        }
      } finally {
        await admin.end();
      }
    }
  }, 15_000);
});
