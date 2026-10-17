import { createHash, hkdfSync } from 'node:crypto';
import { createSessionCredential, sessionCredentialDigest } from './session.js';
import {
  sealDeliveryPayload,
  openDeliveryPayload,
  type DeliveryEncryptionKey,
  type DeliveryEnvelope,
} from './verification.js';

/** The existing CSPRNG generates 32-byte opaque proof; only its purpose digest
 * belongs in recovery lookup storage. Never normalize credential bytes.
 */
export const createRecoveryCredential = createSessionCredential;
export function recoveryCredentialDigest(value: unknown): string | undefined {
  if (typeof value !== 'string' || !sessionCredentialDigest(value)) return undefined;
  return createHash('sha256')
    .update('authcore.password.recovery.v1\0')
    .update(value, 'ascii')
    .digest('hex');
}

/** Internal version bindings, never authentication proof or public response data.
 * Binding the persisted PHC makes any password replacement invalidate older
 * recovery intent even if timestamps collide. Email binding follows the existing
 * canonical email policy supplied by the identity boundary; no normalization here.
 */
export function recoveryPasswordBinding(passwordHash: string): string {
  if (typeof passwordHash !== 'string' || !passwordHash.length || passwordHash.length > 1024)
    throw new Error('RECOVERY_ACCOUNT_BINDING_INVALID');
  return createHash('sha256')
    .update(JSON.stringify(['authcore.password.recovery.credential', 1, passwordHash]))
    .digest('hex');
}
export function recoveryEmailBinding(normalizedEmail: string): string {
  if (
    typeof normalizedEmail !== 'string' ||
    !normalizedEmail.length ||
    normalizedEmail.length > 1024
  )
    throw new Error('RECOVERY_ACCOUNT_BINDING_INVALID');
  return createHash('sha256')
    .update(JSON.stringify(['authcore.password.recovery.email', 1, normalizedEmail]))
    .digest('hex');
}

function recoveryKey(base: DeliveryEncryptionKey): DeliveryEncryptionKey {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(base.id) || base.key.byteLength !== 32)
    throw new Error('RECOVERY_DELIVERY_KEY_INVALID');
  // Standard Node/OpenSSL HKDF (RFC5869), not a custom KDF. Separate the
  // recovery encryption realm without changing the existing verification AEAD,
  // its AAD, or persisted envelopes. Base keys are uniformly random, not passwords.
  // https://nodejs.org/download/release/v24.21.0/docs/api/crypto.html#cryptohkdfsyncdigest-ikm-salt-info-keylen
  return {
    id: base.id,
    key: new Uint8Array(
      hkdfSync('sha256', base.key, Buffer.alloc(0), 'authcore.password.recovery.delivery.v1', 32),
    ),
  };
}
export function sealRecoveryDeliveryPayload(
  plaintext: string,
  eventId: string,
  baseKey: DeliveryEncryptionKey,
): DeliveryEnvelope {
  return sealDeliveryPayload(plaintext, eventId, recoveryKey(baseKey));
}
export function openRecoveryDeliveryPayload(
  envelope: DeliveryEnvelope,
  eventId: string,
  baseKeys: readonly DeliveryEncryptionKey[],
): string {
  try {
    return openDeliveryPayload(envelope, eventId, baseKeys.map(recoveryKey));
  } catch {
    throw new Error('RECOVERY_DELIVERY_ENVELOPE_INVALID');
  }
}
