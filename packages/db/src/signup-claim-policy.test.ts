import { describe, expect, it } from 'vitest';
import { inspectSignupClaim, readSignupDatabaseClock } from './signup-claim-policy.js';
import type { SignupTransaction } from './signup-transaction.js';
import type { SignupClaimBinding } from './repositories/signup-idempotency.repository.js';
describe('S2 fail-closed policy mode', () => {
  it('rejects an invalid JavaScript mode before any SQL or possible terminal write', async () => {
    const tx = new Proxy({} as SignupTransaction, {
      get() {
        throw new Error('unexpected SQL');
      },
    });
    await expect(
      inspectSignupClaim(tx, {} as SignupClaimBinding, 'invalid' as 'execution'),
    ).rejects.toMatchObject({ code: 'SIGNUP_CLAIM_MODE_INVALID' });
  });
});

describe('S2 explicit PostgreSQL clock decoding', () => {
  const transaction = (value: unknown) =>
    ({ execute: async () => ({ rows: [{ observed_ms: value }] }) }) as unknown as SignupTransaction;
  it('decodes finite integer epoch milliseconds without a client clock or timezone conversion', async () => {
    expect((await readSignupDatabaseClock(transaction(1700000000123))).getTime()).toBe(
      1700000000123,
    );
  });
  it.each([undefined, '1700000000123', NaN, Infinity, 1.5, 9007199254740992, 8640000000000001])(
    'rejects invalid or non-finite server clock %s',
    async (value) => {
      await expect(readSignupDatabaseClock(transaction(value))).rejects.toMatchObject({
        code: 'SIGNUP_CLOCK_UNAVAILABLE',
      });
    },
  );
});
