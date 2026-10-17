import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';

async function disposeCheckout(owned: {
  dispose(): Promise<{ removed: true; transportSettled: true }>;
}) {
  const receipt = await owned.dispose();
  if (receipt.removed !== true || receipt.transportSettled !== true)
    throw new Error('SECURITY_DISPOSAL_NOT_SETTLED');
}

/** Separate from the frozen signup owner. Never retries an ambiguous COMMIT.
 * All effects/cookies are returned only after an exact COMMIT acknowledgement.
 * Disposal uses the pinned driver's public checkout ownership contract.
 */
export async function runSecurityTransaction<T>(
  pool: Pool,
  work: (client: PoolClient, db: NodePgDatabase) => Promise<T>,
  options: { readonly deadlineMs?: number } = {},
): Promise<T> {
  const deadlineMs = options.deadlineMs ?? 12000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 12000)
    throw new Error('SECURITY_DEADLINE_INVALID');
  const client = await pool.connect();
  const owned = client as PoolClient & {
    dispose(): Promise<{ removed: true; transportSettled: true }>;
  };
  if (typeof owned.dispose !== 'function') {
    client.release(true);
    throw new Error('SECURITY_DRIVER_CONTRACT_REQUIRED');
  }
  let disposal: Promise<void> | undefined;
  const dispose = () => (disposal ??= disposeCheckout(owned));
  let timedOut = false,
    transportFailed = false;
  const onError = () => {
    transportFailed = true;
  };
  client.on('error', onError);
  const timer = setTimeout(() => {
    timedOut = true;
    void dispose().catch(() => {});
  }, deadlineMs);
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='3s'");
    await client.query("SET LOCAL lock_timeout='1s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout='5s'");
    await client.query("SET LOCAL transaction_timeout='10s'");
    const value = await work(client, drizzle(client));
    if (timedOut || transportFailed) throw new Error('SECURITY_TRANSACTION_UNAVAILABLE');
    const committed = await client.query('COMMIT');
    if (committed.command !== 'COMMIT') throw new Error('SECURITY_COMMIT_NOT_ACKNOWLEDGED');
    return value;
  } finally {
    // Closing the transport also aborts any uncommitted transaction. Never issue
    // another business statement after a local timeout or uncertain COMMIT.
    clearTimeout(timer);
    await dispose();
    client.removeListener('error', onError);
  }
}
