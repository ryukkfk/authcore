import { describe, expect, it } from 'vitest';
import { createSignupIdempotencyHasher } from './signup-idempotency.js';
import {
  createAttestedSignupHasher,
  validateSignupHmacStartup,
  sameSignupHmacMetadata,
} from './signup-attestation.js';

function fixture() {
  const secret = Uint8Array.from({ length: 32 }, (_, i) => i);
  return {
    secret,
    metadata: {
      hmacKeyVersion: 1,
      keyDigest: '8177f8ae43c29713fe6ca3145295691cab3dd75d57a06341a88c246b42e4d9f7',
      payloadDigest: '0eae9db6f7cd38f10e14fa66fbf53735203597c21bc5d3eb27dc388f9658fa55',
    },
  };
}
describe('S2 dedicated HMAC attestation', () => {
  it('disabled startup needs no secret and enabled startup fails closed without configuration', () => {
    expect(validateSignupHmacStartup(false)).toBeUndefined();
    expect(() => validateSignupHmacStartup(true)).toThrow('SIGNUP_HMAC_CONFIGURATION_INVALID');
  });
  it('attested binding preserves frozen v1 output and captures material immutably', () => {
    const config = fixture();
    const original = createSignupIdempotencyHasher({ secret: config.secret, hmacKeyVersion: 1 });
    const hasher = createAttestedSignupHasher(config);
    const input = { email: ' Unicode@Example.com ', password: ' က😀́ ' };
    const expected = original.bind('test_key_12345678', input);
    config.secret.fill(255);
    config.metadata.hmacKeyVersion = 2;
    config.metadata.keyDigest = '0'.repeat(64);
    expect(hasher.bind('test_key_12345678', input)).toEqual(expected);
    expect(Object.isFrozen(hasher.metadata)).toBe(true);
  });
  it('requires the durable anchor to reject a changed version even when HMAC material is identical', () => {
    const configuration = fixture();
    const approvedAnchor = { ...configuration.metadata };
    configuration.metadata.hmacKeyVersion = 2;
    const hasher = createAttestedSignupHasher(configuration);
    expect(sameSignupHmacMetadata(hasher.metadata, approvedAnchor)).toBe(false);
  });
  it.each(['secret', 'keyDigest', 'payloadDigest', 'malformed'])(
    'rejects configuration drift: %s',
    (kind) => {
      const config = fixture();
      if (kind === 'secret') config.secret[0] = 99;
      if (kind === 'keyDigest') config.metadata.keyDigest = '0'.repeat(64);
      if (kind === 'payloadDigest') config.metadata.payloadDigest = '0'.repeat(64);
      if (kind === 'malformed') config.metadata.keyDigest = 'invalid';
      expect(() => createAttestedSignupHasher(config)).toThrow('SIGNUP_HMAC_CONFIGURATION_INVALID');
    },
  );
});
