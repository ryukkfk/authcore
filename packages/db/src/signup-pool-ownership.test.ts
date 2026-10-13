import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Pool, type Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';

/**
 * Real installed pg-pool, synthetic transport. No PostgreSQL outcome claim.
 * This is a blocking API characterization, not a repaired-owner acceptance test.
 */
describe('S1 installed pool ownership prerequisite', () => {
  it('consumed release can strand a locally closed checkout before pool removal', async () => {
    class Transport extends EventEmitter {
      connection = { stream: new PassThrough() };
      _queryable = true;
      _ending = false;
      closed = false;
      connect(callback: () => void) {
        callback();
      }
      end(callback?: () => void): Promise<void> | void {
        this._ending = true;
        if (!this.closed) {
          this.closed = true;
          this.connection.stream.destroy();
          this.emit('end');
        }
        callback?.();
        if (!callback) return Promise.resolve();
      }
    }
    const pool = new Pool({
      Client: Transport as unknown as typeof Client,
      max: 1,
      idleTimeoutMillis: 0,
      connectionTimeoutMillis: 500,
    });
    const checkout = await pool.connect();
    const removal = vi.fn();
    pool.on('remove', removal);
    const releaseFault = new Error('test-only release listener fault before removal');
    const failRelease = () => {
      throw releaseFault;
    };
    pool.once('release', failRelease);
    let shutdownSettled = false;
    try {
      // Local transport settlement is independent of pool bookkeeping.
      await checkout.end();
      expect((checkout as unknown as Transport).closed).toBe(true);
      expect(() => checkout.release(true)).toThrow(releaseFault);
      expect(pool.totalCount).toBe(1);
      expect(pool.idleCount).toBe(0);
      expect(removal).not.toHaveBeenCalled();

      // The callback supplied by pool.connect is the SAME consumed release-once
      // callback. This deliberate API probe is not an owner retry strategy.
      expect(() => checkout.release(true)).toThrow('already been released');

      // Repeating end() cannot remove this checkout from pg-pool either.
      await checkout.end();
      expect(pool.totalCount).toBe(1);
      const shuttingDown = pool.end().then(() => {
        shutdownSettled = true;
      });
      await Promise.resolve();
      expect(shutdownSettled).toBe(false);
      expect(pool.ending).toBe(true);

      console.info(
        JSON.stringify({
          scenario: 'S1_POOL_RELEASE_CONSUMED_BEFORE_REMOVE',
          evidence: 'REAL_PG_POOL_SYNTHETIC_TRANSPORT',
          localTransportClosed: true,
          poolTotal: pool.totalCount,
          poolIdle: pool.idleCount,
          removalEvents: removal.mock.calls.length,
          shutdownSettled,
        }),
      );

      // Fixture-only rescue. The public API offered no idempotent eviction
      // receipt. Never introduce this private-member access into production.
      const fixturePool = pool as unknown as {
        _remove(client: unknown, callback: () => void): void;
        _pulseQueue(): void;
      };
      fixturePool._remove(checkout, () => fixturePool._pulseQueue());
      await shuttingDown;
      expect(shutdownSettled).toBe(true);
      expect(pool.totalCount).toBe(0);
      expect(removal).toHaveBeenCalledOnce();
    } finally {
      pool.removeListener('release', failRelease);
      await checkout.end();
      if (!pool.ended) {
        const fixturePool = pool as unknown as {
          _remove(client: unknown, callback: () => void): void;
          _pulseQueue(): void;
        };
        fixturePool._remove(checkout, () => fixturePool._pulseQueue());
        if (!pool.ending) await pool.end();
      }
    }
  });
});
