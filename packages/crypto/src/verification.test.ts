import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createVerificationToken,
  verificationTokenDigest,
  sealDeliveryPayload,
  openDeliveryPayload,
} from './verification.js';

describe('Verification credentials and encrypted delivery payloads', () => {
  it('generates canonical 256-bit opaque credentials with distinct one-way lookups', () => {
    const values = Array.from({ length: 100 }, createVerificationToken);
    expect(new Set(values).size).toBe(100);
    expect(new Set(values.map(verificationTokenDigest)).size).toBe(100);
    for (const value of values) {
      expect(Buffer.from(value, 'base64url').byteLength).toBe(32);
      expect(verificationTokenDigest(value)).toMatch(/^[a-f0-9]{64}$/);
      expect(verificationTokenDigest(value) !== value).toBe(true);
    }
  });
  it('rejects malformed and noncanonical credentials before database lookup', () => {
    for (const value of ['', 'a'.repeat(42), 'a'.repeat(44), '/'.repeat(43), 'a'.repeat(42) + 'B'])
      expect(verificationTokenDigest(value)).toBeUndefined();
  });
  it('authenticates the payload, event binding and key version with fresh nonces', () => {
    const key = { id: 'test-v1', key: randomBytes(32) },
      id = randomUUID();
    const payload = JSON.stringify({
      recipient: 'fixture@example.invalid',
      token: createVerificationToken(),
    });
    const first = sealDeliveryPayload(payload, id, key),
      second = sealDeliveryPayload(payload, id, key);
    expect(first.nonce).not.toBe(second.nonce);
    expect(openDeliveryPayload(first, id, [key]) === payload).toBe(true);
    expect(JSON.stringify(first).includes('fixture@example.invalid')).toBe(false);
    expect(() => openDeliveryPayload(first, randomUUID(), [key])).toThrow(
      'DELIVERY_ENVELOPE_INVALID',
    );
    expect(() => openDeliveryPayload(first, id, [{ ...key, key: randomBytes(32) }])).toThrow(
      'DELIVERY_ENVELOPE_INVALID',
    );
    expect(() => openDeliveryPayload({ ...first, tag: 'A'.repeat(22) }, id, [key])).toThrow(
      'DELIVERY_ENVELOPE_INVALID',
    );
    expect(() => openDeliveryPayload({ ...first, keyId: 'missing' }, id, [key])).toThrow(
      'DELIVERY_ENVELOPE_INVALID',
    );
  });
  it('requires explicit keys and bounds encrypted inputs', () => {
    const id = randomUUID(),
      key = { id: 'test', key: randomBytes(32) };
    expect(() => sealDeliveryPayload('x'.repeat(2049), id, key)).toThrow(
      'DELIVERY_PAYLOAD_INVALID',
    );
    expect(() => sealDeliveryPayload('fixture', id, { ...key, key: randomBytes(31) })).toThrow(
      'DELIVERY_KEY_INVALID',
    );
    const envelope = sealDeliveryPayload('fixture', id, key);
    expect(() => openDeliveryPayload(envelope, id, [])).toThrow('DELIVERY_ENVELOPE_INVALID');
    expect(() => openDeliveryPayload(envelope, id, [key, key])).toThrow(
      'DELIVERY_ENVELOPE_INVALID',
    );
  });
});
