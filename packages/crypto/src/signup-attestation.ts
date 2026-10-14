import { timingSafeEqual } from 'node:crypto';
import { createSignupIdempotencyHasher } from './signup-idempotency.js';

// Public known-answer input, never a credential or fallback secret.
export const SIGNUP_ATTESTATION_INPUT = Object.freeze({
  key: 'authcore_attestation_v1',
  email: 'signup-attestation@example.invalid',
  password: 'public-known-answer-input-v1',
});
export interface SignupHmacMetadata {
  readonly hmacKeyVersion: number;
  readonly keyDigest: string;
  readonly payloadDigest: string;
}
export interface SignupHmacConfiguration {
  readonly secret: Uint8Array;
  readonly metadata: SignupHmacMetadata;
}
export class SignupHmacConfigurationError extends Error {
  constructor() {
    super('SIGNUP_HMAC_CONFIGURATION_INVALID');
    this.name = 'SignupHmacConfigurationError';
  }
}
export function sameSignupHmacMetadata(a: SignupHmacMetadata, b: SignupHmacMetadata): boolean {
  const valid = (value: SignupHmacMetadata) =>
    value &&
    Number.isSafeInteger(value.hmacKeyVersion) &&
    value.hmacKeyVersion > 0 &&
    value.hmacKeyVersion <= 2147483647 &&
    typeof value.keyDigest === 'string' &&
    /^[0-9a-f]{64}$/.test(value.keyDigest) &&
    typeof value.payloadDigest === 'string' &&
    /^[0-9a-f]{64}$/.test(value.payloadDigest);
  if (!valid(a) || !valid(b)) return false;
  return (
    a.hmacKeyVersion === b.hmacKeyVersion &&
    timingSafeEqual(Buffer.from(a.keyDigest, 'hex'), Buffer.from(b.keyDigest, 'hex')) &&
    timingSafeEqual(Buffer.from(a.payloadDigest, 'hex'), Buffer.from(b.payloadDigest, 'hex'))
  );
}
/** Independent approved metadata is mandatory; the caller cannot self-attest drift. */
export function createAttestedSignupHasher(configuration: SignupHmacConfiguration) {
  try {
    const hasher = createSignupIdempotencyHasher({
      secret: configuration.secret,
      hmacKeyVersion: configuration.metadata.hmacKeyVersion,
    });
    const actual = hasher.bind(SIGNUP_ATTESTATION_INPUT.key, SIGNUP_ATTESTATION_INPUT);
    if (!sameSignupHmacMetadata(actual, configuration.metadata))
      throw new SignupHmacConfigurationError();
    const metadata = Object.freeze({
      hmacKeyVersion: actual.hmacKeyVersion,
      keyDigest: actual.keyDigest,
      payloadDigest: actual.payloadDigest,
    });
    return Object.freeze({ metadata, bind: hasher.bind });
  } catch {
    throw new SignupHmacConfigurationError();
  }
}
export function validateSignupHmacStartup(
  enabled: boolean,
  configuration?: SignupHmacConfiguration,
) {
  if (!enabled) return undefined;
  if (!configuration) throw new SignupHmacConfigurationError();
  return createAttestedSignupHasher(configuration);
}
export type AttestedSignupHasher = ReturnType<typeof createAttestedSignupHasher>;
