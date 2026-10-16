import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createSecretKey,
  randomBytes,
} from 'node:crypto';

export function createVerificationToken(): string {
  return randomBytes(32).toString('base64url');
}
export function verificationTokenDigest(token: string): string | undefined {
  if (
    typeof token !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(token) ||
    Buffer.from(token, 'base64url').toString('base64url') !== token
  )
    return undefined;
  return createHash('sha256')
    .update('authcore.email.verification.v1\0')
    .update(token, 'ascii')
    .digest('hex');
}
export interface DeliveryEncryptionKey {
  readonly id: string;
  readonly key: Uint8Array;
}
export interface DeliveryEnvelope {
  readonly version: 1;
  readonly keyId: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly tag: string;
}
function keyObject(key: DeliveryEncryptionKey) {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(key.id) || key.key.byteLength !== 32)
    throw new Error('DELIVERY_KEY_INVALID');
  return createSecretKey(key.key);
}
const aad = (keyId: string, eventId: string) =>
  Buffer.from(JSON.stringify(['authcore.email.verification', 1, keyId, eventId]));
/** Standard AES-256-GCM through Node/OpenSSL; keys are supplied separately from storage. */
export function sealDeliveryPayload(
  plaintext: string,
  eventId: string,
  key: DeliveryEncryptionKey,
): DeliveryEnvelope {
  if (Buffer.byteLength(plaintext) > 2048 || !/^[a-f0-9-]{36}$/.test(eventId))
    throw new Error('DELIVERY_PAYLOAD_INVALID');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyObject(key), nonce, { authTagLength: 16 });
  cipher.setAAD(aad(key.id, eventId));
  return Object.freeze({
    version: 1,
    keyId: key.id,
    nonce: nonce.toString('base64url'),
    ciphertext: Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString(
      'base64url',
    ),
    tag: cipher.getAuthTag().toString('base64url'),
  });
}
/** Key IDs allow reading an explicitly configured retired key during controlled rotation. */
export function openDeliveryPayload(
  envelope: DeliveryEnvelope,
  eventId: string,
  keys: readonly DeliveryEncryptionKey[],
): string {
  try {
    if (envelope.version !== 1 || !/^[a-f0-9-]{36}$/.test(eventId)) throw new Error();
    const key = keys.find((value) => value.id === envelope.keyId);
    if (!key || keys.filter((value) => value.id === envelope.keyId).length !== 1) throw new Error();
    const decode = (value: string, max: number) => {
      if (typeof value !== 'string' || value.length > max || !/^[A-Za-z0-9_-]*$/.test(value))
        throw new Error();
      const decoded = Buffer.from(value, 'base64url');
      if (decoded.toString('base64url') !== value) throw new Error();
      return decoded;
    };
    const nonce = decode(envelope.nonce, 16),
      tag = decode(envelope.tag, 22),
      ciphertext = decode(envelope.ciphertext, 2731);
    if (nonce.length !== 12 || tag.length !== 16) throw new Error();
    const cipher = createDecipheriv('aes-256-gcm', keyObject(key), nonce, { authTagLength: 16 });
    cipher.setAAD(aad(key.id, eventId));
    cipher.setAuthTag(tag);
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat([cipher.update(ciphertext), cipher.final()]),
    );
  } catch {
    throw new Error('DELIVERY_ENVELOPE_INVALID');
  }
}
