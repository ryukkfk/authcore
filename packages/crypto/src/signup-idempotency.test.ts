import { createHmac, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createSignupIdempotencyHasher } from './signup-idempotency.js';

const rawKey = 'test_request_key_0123456789';
const input = { email: ' User@Example.COM ', password: 'a long test password' };

describe('signup idempotency v1 contract', () => {
  const secret = randomBytes(32); // Ephemeral test material, never a deployed secret.
  const hasher = createSignupIdempotencyHasher({ hmacKeyVersion: 7, secret });

  it('uses the exact versioned UTF-8 JSON tuples and separated HMAC domains', () => {
    const binding = hasher.bind(rawKey, input);
    const digest = (value: unknown) =>
      createHmac('sha256', secret).update(JSON.stringify(value), 'utf8').digest('hex');
    expect(binding).toEqual({
      keyVersion: 1,
      payloadVersion: 1,
      hmacKeyVersion: 7,
      keyDigest: digest(['authcore.signup.key', 1, rawKey]),
      payloadDigest: digest([
        'authcore.signup.payload',
        1,
        'User@Example.COM',
        'user@example.com',
        input.password,
      ]),
    });
    expect(JSON.stringify(binding)).not.toContain(rawKey);
    expect(JSON.stringify(binding)).not.toContain(input.password);
    expect(JSON.stringify(binding)).not.toContain('Example');
    expect(binding.keyDigest).not.toBe(binding.payloadDigest);
  });

  it('trims email only; preserves case of stored email and exact password bytes', () => {
    const original = hasher.bind(rawKey, input);
    expect(hasher.bind(rawKey, { ...input, email: input.email.trim() })).toEqual(original);
    for (const changed of [
      { ...input, email: 'user@example.com' },
      { ...input, password: `${input.password} ` },
      { ...input, password: '\u00e9'.repeat(12) },
      { ...input, password: 'e\u0301'.repeat(12) },
    ]) {
      expect(hasher.bind(rawKey, changed).payloadDigest).not.toBe(original.payloadDigest);
    }
    expect(hasher.bind(rawKey, { ...input, password: '\u00e9'.repeat(12) }).payloadDigest).not.toBe(
      hasher.bind(rawKey, { ...input, password: 'e\u0301'.repeat(12) }).payloadDigest,
    );
  });

  it('does not bind unrelated input fields and owns its secret copy', () => {
    const key = randomBytes(32);
    const local = createSignupIdempotencyHasher({ hmacKeyVersion: 1, secret: key });
    const original = local.bind(rawKey, input);
    key.fill(0);
    expect(
      local.bind(rawKey, { ...input, ...{ passwordHash: 'irrelevant', admin: true } }),
    ).toEqual(original);
  });

  it('preserves full Unicode passwords without imposing a second DTO length policy', () => {
    for (const password of ['\u{1f512}'.repeat(128), '\u{1f512}\ufe0f'.repeat(128)]) {
      expect(hasher.bind(rawKey, { ...input, password }).payloadDigest).toBe(
        createHmac('sha256', secret)
          .update(
            JSON.stringify([
              'authcore.signup.payload',
              1,
              'User@Example.COM',
              'user@example.com',
              password,
            ]),
            'utf8',
          )
          .digest('hex'),
      );
    }
  });

  it('changes digests for a different secret and key identity for a different raw key', () => {
    const original = hasher.bind(rawKey, input);
    expect(hasher.bind(`${rawKey}x`, input).keyDigest).not.toBe(original.keyDigest);
    expect(
      createSignupIdempotencyHasher({ hmacKeyVersion: 8, secret: randomBytes(32) }).bind(
        rawKey,
        input,
      ).payloadDigest,
    ).not.toBe(original.payloadDigest);
  });

  it.each([undefined, null, '', 'secret', new Uint8Array(0), randomBytes(31)])(
    'fails closed for missing or invalid secret %#',
    (secret) => {
      expect(() =>
        createSignupIdempotencyHasher({
          hmacKeyVersion: 1,
          secret: secret as Uint8Array,
        }),
      ).toThrow('Invalid signup idempotency HMAC configuration');
    },
  );

  it.each([undefined, 0, -1, 1.5, 2 ** 31, NaN])('rejects invalid key version %#', (version) => {
    expect(() =>
      createSignupIdempotencyHasher({
        hmacKeyVersion: version as number,
        secret,
      }),
    ).toThrow('Invalid signup idempotency HMAC configuration');
  });

  it.each([
    '',
    'short',
    'x'.repeat(129),
    ` ${rawKey}`,
    `${rawKey}\n`,
    `${rawKey}\r`,
    '\u00e9'.repeat(16),
  ])('rejects noncanonical keys without echoing them %#', (value) => {
    expect(() => hasher.bind(value, input)).toThrow(/^Invalid signup idempotency input$/);
  });

  it.each([
    { ...input, email: '' },
    { ...input, email: 'x'.repeat(1_025) },
    { ...input, password: '' },
    { ...input, password: 'x'.repeat(1_025) },
  ])('rejects invalid payload boundaries %#', (value) => {
    expect(() => hasher.bind(rawKey, value)).toThrow(/^Invalid signup idempotency input$/);
  });
});
