import { randomUUID } from 'node:crypto';
import type { DatabaseClient } from './client.js';

export type TransactionOutcome =
  'NOT_SUBMITTED' | 'ABORT_CONFIRMED' | 'COMMIT_UNKNOWN' | 'COMMIT_ACK' | 'COMMIT_ROLLBACK';
export type TransactionPhase =
  'ACQUIRING' | 'ACQUIRED' | 'BEGINNING' | 'WORK' | 'COMMIT_DISPATCH' | 'TERMINAL' | 'DISPOSING';
export type CleanupHealth = 'CLEAN' | 'EVICTED' | 'QUARANTINED_WITH_OWNER';

export class SignupOwnerError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'SignupOwnerError';
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export interface OwnershipRecord {
  id: string;
  phase: TransactionPhase;
  outcome: TransactionOutcome;
  cleanup: CleanupHealth;
  stop(): void;
  settled: Promise<void>;
}
interface Registry {
  closing: boolean;
  records: Set<OwnershipRecord>;
}
const registries = new WeakMap<DatabaseClient['pool'], Registry>();
function registry(database: DatabaseClient): Registry {
  let value = registries.get(database.pool);
  if (!value) {
    value = { closing: false, records: new Set() };
    registries.set(database.pool, value);
  }
  return value;
}
export function registerOwner(database: DatabaseClient, record: OwnershipRecord): () => void {
  const value = registry(database);
  const configured = database.pool.options?.max ?? 10;
  const limit = Number.isSafeInteger(configured) && configured > 0 ? configured : 10;
  if (value.closing || value.records.size >= limit)
    throw new SignupOwnerError('OWNER_CAPACITY_UNAVAILABLE');
  value.records.add(record);
  return () => {
    value.records.delete(record);
  };
}
export function signupOwnerInventory(database: DatabaseClient) {
  return Object.freeze(
    [...registry(database).records].map(({ id, phase, outcome, cleanup }) =>
      Object.freeze({ id, phase, outcome, cleanup }),
    ),
  );
}
/** No deadline manufactures successful drain. Unsettled owners remain visible. */
export async function drainSignupTransactionOwners(database: DatabaseClient): Promise<void> {
  const value = registry(database);
  value.closing = true;
  for (const record of value.records) record.stop();
  await Promise.all([...value.records].map((record) => record.settled));
}
export const newTransactionId = () => randomUUID();

/** Provenance must be validated by the service before entering this monotonic latch. */
export class AcceptedProofLatch<T> {
  #proof: T | undefined;
  accept(proof: T): void {
    if (this.#proof === undefined) this.#proof = proof;
  }
  get proof(): T | undefined {
    return this.#proof;
  }
}
