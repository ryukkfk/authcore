import { describe, expect, it } from 'vitest';
import { createSessionCredential, sessionCredentialDigest } from './session.js';
import { verificationTokenDigest } from './verification.js';
describe('Opaque session credential boundary', () => {
  it('generates distinct canonical 256-bit credentials with purpose-separated lookups', () => {
    const values = Array.from({ length: 100 }, createSessionCredential);
    expect(new Set(values).size).toBe(100);
    for (const value of values) {
      expect(Buffer.from(value, 'base64url').byteLength).toBe(32);
      expect(sessionCredentialDigest(value)).toMatch(/^[a-f0-9]{64}$/);
      expect(sessionCredentialDigest(value) !== verificationTokenDigest(value)).toBe(true);
    }
  });
  it.each([undefined, null, {}, '', 'a'.repeat(42), 'a'.repeat(44), 'a'.repeat(42) + 'B'])(
    'rejects malformed credential %#',
    (value) => {
      expect(sessionCredentialDigest(value)).toBeUndefined();
    },
  );
});
