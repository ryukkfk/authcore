import { timingSafeEqual } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import type { DatabaseClient } from '../client.js';
import {
  signupIdempotencyClaims as claims,
  signupIdempotencyResults as results,
  type SignupIdempotencyClaim,
  type SignupIdempotencyResult,
} from '../schema/index.js';

type RepositoryDatabase = Pick<DatabaseClient['db'], 'insert' | 'select'>;
export type SignupClaimBinding = Pick<
  SignupIdempotencyClaim,
  'keyVersion' | 'hmacKeyVersion' | 'keyDigest' | 'payloadVersion' | 'payloadDigest'
>;
export type SignupClaimKey = Pick<
  SignupClaimBinding,
  'keyVersion' | 'hmacKeyVersion' | 'keyDigest'
>;

export class SignupIdempotencyConflictError extends Error {
  readonly code = 'SIGNUP_IDEMPOTENCY_CONFLICT';
  constructor() {
    super('Signup idempotency payload conflict');
    this.name = 'SignupIdempotencyConflictError';
  }
}

export class SignupIdempotencyExpiryError extends Error {
  readonly code = 'SIGNUP_IDEMPOTENCY_INVALID_EXPIRY';
  constructor() {
    super('A new signup idempotency claim requires a finite future expiry');
    this.name = 'SignupIdempotencyExpiryError';
  }
}

function keyWhere(key: SignupClaimKey) {
  return and(
    eq(claims.keyVersion, key.keyVersion),
    eq(claims.hmacKeyVersion, key.hmacKeyVersion),
    eq(claims.keyDigest, key.keyDigest),
  );
}

function assertBinding(claim: SignupIdempotencyClaim, binding: SignupClaimBinding) {
  const actual = Buffer.from(claim.payloadDigest, 'utf8');
  const expected = Buffer.from(binding.payloadDigest, 'utf8');
  if (
    claim.payloadVersion !== binding.payloadVersion ||
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  )
    throw new SignupIdempotencyConflictError();
}

export class SignupIdempotencyClaimRepository {
  constructor(private readonly db: RepositoryDatabase) {}

  /** Use an autocommit connection (or commit the caller's reservation transaction)
   * before doing signup work. READ COMMITTED required for the post-conflict read.
   * Existing claims NEVER rebind or renew, including after expiresAt. */
  async reserve(
    binding: SignupClaimBinding,
    expiresAt: Date,
  ): Promise<{
    claim: SignupIdempotencyClaim;
    reserved: boolean;
  }> {
    const retained = await this.findByKey(binding);
    if (retained) {
      assertBinding(retained, binding);
      return { claim: retained, reserved: false };
    }
    const expiryTime = expiresAt instanceof Date ? expiresAt.getTime() : NaN;
    if (!Number.isFinite(expiryTime)) {
      // A concurrent reservation may have committed after the first lookup.
      // An uncommitted claim remains invisible: fail closed, never invent a TTL.
      const concurrent = await this.findByKey(binding);
      if (concurrent) {
        assertBinding(concurrent, binding);
        return { claim: concurrent, reserved: false };
      }
      throw new SignupIdempotencyExpiryError();
    }
    let inserted: SignupIdempotencyClaim | undefined;
    try {
      [inserted] = await this.db
        .insert(claims)
        .values({
          keyVersion: binding.keyVersion,
          hmacKeyVersion: binding.hmacKeyVersion,
          keyDigest: binding.keyDigest,
          payloadVersion: binding.payloadVersion,
          payloadDigest: binding.payloadDigest,
          expiresAt: new Date(expiryTime),
        })
        .onConflictDoNothing({
          target: [claims.keyVersion, claims.hmacKeyVersion, claims.keyDigest],
        })
        .returning();
    } catch (error) {
      // PostgreSQL's existing CHECK compares expiry with its own default created_at
      // (transaction time, at column precision). No application-clock veto or extra
      // clock query: finite inputs are decided atomically by that constraint.
      // Do not relabel other constraints/infrastructure
      // failures. A caller-owned failed PostgreSQL transaction still needs rollback.
      const failure = error instanceof Error && 'cause' in error ? error.cause : error;
      if (
        typeof failure === 'object' &&
        failure !== null &&
        'code' in failure &&
        failure.code === '23514' &&
        'constraint' in failure &&
        failure.constraint === 'signup_idempotency_claims_expiry_check'
      )
        throw new SignupIdempotencyExpiryError();
      throw error;
    }
    if (inserted) return { claim: inserted, reserved: true };
    // Separate statement gets a new snapshot after ON CONFLICT waits for a writer.
    const existing = await this.findByKey(binding);
    if (!existing) throw new Error('Signup idempotency claim unavailable');
    assertBinding(existing, binding);
    return { claim: existing, reserved: false };
  }

  async findByKey(key: SignupClaimKey): Promise<SignupIdempotencyClaim | null> {
    const [claim] = await this.db.select().from(claims).where(keyWhere(key)).limit(1);
    return claim ?? null;
  }

  /** Pass the caller-owned signup transaction, never the pool. The lock lasts
   * only until that transaction ends; this method does not own COMMIT/recovery. */
  static async lockByKey(tx: Pick<DatabaseClient['db'], 'select'>, binding: SignupClaimBinding) {
    const [claim] = await tx.select().from(claims).where(keyWhere(binding)).limit(1).for('update');
    if (!claim) return null;
    assertBinding(claim, binding);
    return claim;
  }
}

export class SignupIdempotencyResultRepository {
  constructor(private readonly db: RepositoryDatabase) {}

  /** Borrow the same transaction as user/credential/audit writes, after locking
   * its claim. No upsert: a duplicate result must fail the whole transaction. */
  async recordAccepted(claimId: string): Promise<SignupIdempotencyResult> {
    const [result] = await this.db
      .insert(results)
      .values({
        claimId,
        resultVersion: 1,
        statusCode: 202,
        responseBody: { status: 'accepted' },
      })
      .returning();
    if (!result) throw new Error('Signup idempotency result insert returned no row');
    return result;
  }

  async findByClaimId(claimId: string): Promise<SignupIdempotencyResult | null> {
    const [result] = await this.db
      .select()
      .from(results)
      .where(eq(results.claimId, claimId))
      .limit(1);
    return result ?? null;
  }
}
