import { describe, expect, it } from 'vitest';
import { inspectSignupClaim } from './signup-claim-policy.js';
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
