import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { DatabaseClient } from '@authcore/db';
import {
  createSignupReservationBoundary,
  SignupReservationUnavailable,
} from './signup-reservation.js';
import { testSignupConfiguration } from './signup-reservation.test-support.js';
const unavailable = new Proxy({} as DatabaseClient, {
  get() {
    throw new Error('unexpected database access');
  },
});
describe('S2 startup admission', () => {
  it('disabled signup does not read secret or database state', async () => {
    expect(await createSignupReservationBoundary(unavailable, { enabled: false })).toBeUndefined();
  });
  it('enabled startup rejects missing secure configuration before database access', async () => {
    await expect(
      createSignupReservationBoundary(unavailable, { enabled: true, executionWindowMs: 1000 }),
    ).rejects.toThrow('SIGNUP_HMAC_CONFIGURATION_INVALID');
  });
  it.each([undefined, 0, -1, 86400001, Infinity, 1.5])(
    'rejects invalid injected execution window %s before database access',
    async (executionWindowMs) => {
      const options = executionWindowMs === undefined ? {} : { executionWindowMs };
      await expect(
        createSignupReservationBoundary(unavailable, {
          enabled: true,
          configuration: testSignupConfiguration(),
          ...options,
        }),
      ).rejects.toBeInstanceOf(SignupReservationUnavailable);
    },
  );
});
