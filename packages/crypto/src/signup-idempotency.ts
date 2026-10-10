import { createHmac, createSecretKey } from 'node:crypto';

export interface SignupIdempotencyBinding {
  keyVersion: 1;
  payloadVersion: 1;
  hmacKeyVersion: number;
  keyDigest: string;
  payloadDigest: string;
}

/** Explicitly injected dedicated secret; no environment reads or fallback keys. */
export function createSignupIdempotencyHasher(configuration: {
  hmacKeyVersion: number;
  secret: Uint8Array;
}) {
  if (
    !configuration ||
    !Number.isInteger(configuration.hmacKeyVersion) ||
    configuration.hmacKeyVersion < 1 ||
    configuration.hmacKeyVersion > 2_147_483_647 ||
    !(configuration.secret instanceof Uint8Array) ||
    configuration.secret.byteLength !== 32
  ) {
    throw new Error('Invalid signup idempotency HMAC configuration');
  }
  // KeyObject copies the input; neither key bytes nor payloads are returned.
  const secret = createSecretKey(configuration.secret);
  const hmacKeyVersion = configuration.hmacKeyVersion;
  const digest = (tuple: readonly unknown[]) =>
    createHmac('sha256', secret).update(JSON.stringify(tuple), 'utf8').digest('hex');

  return Object.freeze({
    /** Caller validates the signup DTO first. v1 also bounds all hashed input. */
    bind(rawKey: string, input: { email: string; password: string }): SignupIdempotencyBinding {
      if (
        typeof rawKey !== 'string' ||
        rawKey.length < 16 ||
        rawKey.length > 128 ||
        /[^A-Za-z0-9_-]/.test(rawKey) ||
        !input ||
        typeof input.email !== 'string' ||
        input.email.trim().length < 1 ||
        input.email.length > 1_024 ||
        typeof input.password !== 'string' ||
        input.password.length < 1 ||
        input.password.length > 1_024
      ) {
        throw new Error('Invalid signup idempotency input');
      }
      const email = input.email.trim();
      return Object.freeze({
        keyVersion: 1,
        payloadVersion: 1,
        hmacKeyVersion,
        keyDigest: digest(['authcore.signup.key', 1, rawKey]),
        // Include both stored and normalized email: case can affect stored data.
        // Password is not trimmed, case-folded, or Unicode-normalized.
        payloadDigest: digest([
          'authcore.signup.payload',
          1,
          email,
          email.toLowerCase(),
          input.password,
        ]),
      });
    },
  });
}
