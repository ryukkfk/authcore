import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { expect, it, vi } from 'vitest';
import { approvedTestUrl } from '@authcore/testing';
import { DatabaseService } from './database.service.js';
import { createReservationFixture } from '../identity/signup-reservation.test-support.js';
const approved =
  process.env.S6_POSTGRES_APPROVED === 'true'
    ? approvedTestUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL)
    : undefined;
if (
  approved &&
  (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted')
)
  throw new Error('S6 requires disposable GitHub-hosted services');
it.skipIf(!approved)(
  'S6 real idle backend termination is sanitized, replacement progresses and shutdown actually drains',
  async () => {
    const fixture = await createReservationFixture(approved!);
    let service: DatabaseService | undefined;
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      vi.stubEnv('DATABASE_URL', fixture.runtimeUrl.toString());
      vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:6380');
      vi.stubEnv('WEB_ORIGIN', 'http://localhost:3000');
      vi.stubEnv('SIGNUP_ENABLED', 'false');
      service = new DatabaseService();
      const database = service.getClient();
      const first = (await database.pool.query('SELECT pg_backend_pid() AS pid')).rows[0]
        .pid as number;
      expect(
        (await fixture.owner.pool.query('SELECT pg_terminate_backend($1) AS stopped', [first]))
          .rows[0].stopped,
      ).toBe(true);
      await expect.poll(() => service!.connectionDiagnostics().idleErrors).toBe(1);
      expect(warn).toHaveBeenCalledExactlyOnceWith({ event: 'database.idle_connection_error' });
      const second = (await database.pool.query('SELECT pg_backend_pid() AS pid')).rows[0]
        .pid as number;
      expect(second).not.toBe(first);
      await service.onApplicationShutdown();
      service = undefined;
      expect(database.pool.totalCount).toBe(0);
      await expect
        .poll(async () =>
          Number(
            (
              await fixture.owner.pool.query(
                'SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=ANY($1::int[])',
                [[first, second]],
              )
            ).rows[0].n,
          ),
        )
        .toBe(0);
      console.info(
        JSON.stringify({
          scope: 'S6_IDLE_BACKEND',
          errors: 1,
          replacement: true,
          poolTotal: 0,
          remainingBackends: 0,
        }),
      );
    } finally {
      try {
        await service?.onApplicationShutdown();
      } finally {
        warn.mockRestore();
        vi.unstubAllEnvs();
        await fixture.close();
      }
    }
  },
  15000,
);
