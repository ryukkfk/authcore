import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Pool, type Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';

/**
 * Real installed pg-pool, synthetic transport. No PostgreSQL outcome claim.
 * Corrected public-driver acceptance; historical blocked characterization remains at b7e884b.
 */
describe('S1 installed pool ownership prerequisite', () => {
  it('consumed release is recovered through public disposal without private pool rescue', async () => {
    class Transport extends EventEmitter {
      connection = { stream: new PassThrough() };
      _queryable = true;
      _ending = false;
      closed = false;
      connect(callback: () => void) {
        callback();
      }
      async terminate() {
        await this.end();
        return { transportSettled: true, queriesSettled: true };
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
    const checkout = (await pool.connect()) as import('pg').PoolClient & {
      dispose(): Promise<unknown>;
    };
    const removal = vi.fn();
    pool.on('remove', removal);
    const releaseFault = new Error('test-only release listener fault before removal');
    const failRelease = () => {
      throw releaseFault;
    };
    pool.once('release', failRelease);
    try {
      // Local transport settlement is independent of pool bookkeeping.
      await checkout.end();
      expect((checkout as unknown as Transport).closed).toBe(true);
      expect(() => checkout.release(true)).toThrow(releaseFault);
      expect(pool.idleCount).toBe(0);
      expect(() => checkout.release(true)).toThrow('already been released');
      await checkout.dispose();
      expect(pool.totalCount).toBe(0);
      expect(removal).toHaveBeenCalledOnce();
      await pool.end();
      const shutdownSettled = true;
      expect(pool.ended).toBe(true);
      console.info(
        JSON.stringify({
          scenario: 'S1_POOL_RELEASE_REPAIRED',
          evidence: 'REAL_PG_POOL_SYNTHETIC_TRANSPORT',
          localTransportClosed: true,
          poolTotal: pool.totalCount,
          removalEvents: removal.mock.calls.length,
          shutdownSettled,
        }),
      );
    } finally {
      pool.removeListener('release', failRelease);
      await checkout.dispose();
      if (!pool.ending) await pool.end();
    }
  });
});
