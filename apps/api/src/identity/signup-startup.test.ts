import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignupService } from './signup.service.js';
import type { DatabaseService } from '../database/database.service.js';
import { readSignupKey } from './signup-key.guard.js';
afterEach(() => vi.unstubAllEnvs());
function environment(enabled: string) {
  vi.stubEnv('DATABASE_URL', 'postgresql://localhost/authcore_test');
  vi.stubEnv('REDIS_URL', 'redis://localhost:6380');
  vi.stubEnv('WEB_ORIGIN', 'http://localhost:3000');
  vi.stubEnv('SIGNUP_ENABLED', enabled);
}
describe('S5 startup and mandatory frozen key boundary', () => {
  it('disabled startup needs no configuration or database access and permits no internal unkeyed writer', async () => {
    environment('false');
    const getClient = vi.fn(() => {
      throw new Error('database access forbidden');
    });
    const service = new SignupService({ getClient } as unknown as DatabaseService);
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    await expect(
      service.signup(
        { email: 'user@example.com', password: 'public fixture password' },
        undefined!,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(getClient).not.toHaveBeenCalled();
  });
  it('enabled startup without explicitly injected attested material fails before database access', async () => {
    environment('true');
    const getClient = vi.fn(() => {
      throw new Error('database access forbidden');
    });
    const service = new SignupService({ getClient } as unknown as DatabaseService);
    await expect(service.onModuleInit()).rejects.toThrow('SIGNUP_HMAC_CONFIGURATION_REQUIRED');
    expect(getClient).not.toHaveBeenCalled();
  });
  it.each([
    '',
    'x'.repeat(15),
    'x'.repeat(129),
    'x'.repeat(16) + '\n',
    'x'.repeat(16) + ' ',
    '"public_fixture_key"',
    'public_fixture_key,public_fixture_key',
    'public_fixture_kéy',
  ])('rejects malformed frozen key syntax without echoing %j', (value) => {
    expect(() => readSignupKey({ rawHeaders: ['Idempotency-Key', value] })).toThrow(
      'Invalid Idempotency-Key',
    );
  });
  it.each([16, 128])(
    'accepts exactly %i ASCII key characters with original case preserved',
    (length) => {
      const key = 'A'.repeat(length);
      expect(readSignupKey({ rawHeaders: ['iDeMpOtEnCy-KeY', key] })).toBe(key);
    },
  );
  it('rejects duplicate identical values even when field-name casing differs', () => {
    expect(() =>
      readSignupKey({
        rawHeaders: [
          'Idempotency-Key',
          'public_fixture_key',
          'idempotency-key',
          'public_fixture_key',
        ],
      }),
    ).toThrow('Invalid Idempotency-Key');
  });
});
