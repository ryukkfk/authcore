import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { runSecurityTransaction } from './security-transaction.js';

describe('Security transaction acknowledgement and ownership', () => {
  it('returns business output only for an exact COMMIT tag and disposes ownership', async () => {
    const dispose = vi.fn(async () => ({ removed: true, transportSettled: true }));
    const query = vi.fn(async (text: string) => ({
      command: text === 'COMMIT' ? 'COMMIT' : 'SET',
      rows: [],
    }));
    const pool = { connect: async () => ({ query, dispose }) } as unknown as Pool;
    expect(await runSecurityTransaction(pool, async () => 'confirmed')).toBe('confirmed');
    expect(dispose).toHaveBeenCalledOnce();
  });
  it('never returns callback success when COMMIT returns ROLLBACK or loses its acknowledgement', async () => {
    for (const mode of ['rollback', 'unknown']) {
      const dispose = vi.fn(async () => ({ removed: true, transportSettled: true }));
      const pool = {
        connect: async () => ({
          dispose,
          query: async (text: string) => {
            if (text === 'COMMIT' && mode === 'unknown')
              throw new Error('Synthetic transport loss');
            return { command: text === 'COMMIT' ? 'ROLLBACK' : 'SET', rows: [] };
          },
        }),
      } as unknown as Pool;
      await expect(runSecurityTransaction(pool, async () => 'unconfirmed')).rejects.toThrow();
      expect(dispose).toHaveBeenCalledOnce();
    }
  });
  it('disposes an aborted transaction without submitting COMMIT or retrying work', async () => {
    const query = vi.fn(async () => ({ command: 'SET', rows: [] }));
    const dispose = vi.fn(async () => ({ removed: true, transportSettled: true }));
    const pool = { connect: async () => ({ query, dispose }) } as unknown as Pool;
    const work = vi.fn(async () => {
      throw new Error('Synthetic business failure');
    });
    await expect(runSecurityTransaction(pool, work)).rejects.toThrow('Synthetic business failure');
    expect(work).toHaveBeenCalledOnce();
    expect(query.mock.calls.flat()).not.toContain('COMMIT');
    expect(dispose).toHaveBeenCalledOnce();
  });
});
