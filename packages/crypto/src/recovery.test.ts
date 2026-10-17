import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sessionCredentialDigest } from './session.js';
import {
  openDeliveryPayload,
  sealDeliveryPayload,
  verificationTokenDigest,
} from './verification.js';
import {
  createRecoveryCredential,
  recoveryCredentialDigest,
  openRecoveryDeliveryPayload,
  sealRecoveryDeliveryPayload,
  recoveryPasswordBinding,
  recoveryEmailBinding,
} from './recovery.js';

describe('Password recovery proof and durable delivery isolation', () => {
  const event = randomUUID(),
    key = { id: 'recovery-test-v1', key: randomBytes(32) };
  it('invalidates version bindings on credential or canonical email changes without timestamp dependence', () => {
    const hash = 'public synthetic PHC version A',
      email = 'fixture@example.invalid';
    expect(recoveryPasswordBinding(hash)).toMatch(/^[a-f0-9]{64}$/);
    expect(recoveryEmailBinding(email)).toMatch(/^[a-f0-9]{64}$/);
    expect(recoveryPasswordBinding(hash)).not.toBe(recoveryPasswordBinding(hash + ' changed'));
    expect(recoveryEmailBinding(email)).not.toBe(recoveryEmailBinding('other@example.invalid'));
    expect(recoveryPasswordBinding(email)).not.toBe(recoveryEmailBinding(email));
    expect(() => recoveryPasswordBinding('')).toThrow();
    expect(() => recoveryEmailBinding('x'.repeat(1025))).toThrow();
  });
  it('uses canonical random opaque proof with a digest isolated from session and email proof', () => {
    const proofs = Array.from({ length: 32 }, () => createRecoveryCredential());
    expect(new Set(proofs).size).toBe(32);
    for (const proof of proofs) {
      expect(proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const digest = recoveryCredentialDigest(proof);
      expect(digest).toMatch(/^[a-f0-9]{64}$/);
      expect(digest).not.toBe(sessionCredentialDigest(proof));
      expect(digest).not.toBe(verificationTokenDigest(proof));
    }
  });
  it('rejects malformed noncanonical padded and oversized credentials before lookup', () => {
    const canonical = Buffer.alloc(32).toString('base64url');
    for (const input of [
      undefined,
      null,
      1,
      {},
      '',
      canonical + '=',
      canonical.slice(0, -1) + 'B',
      'x'.repeat(44),
      '\uff41'.repeat(43),
    ])
      expect(recoveryCredentialDigest(input)).toBeUndefined();
  });
  it('cannot open ciphertext through the other mail purpose using the same base key and event', () => {
    const proof = createRecoveryCredential();
    const recovery = sealRecoveryDeliveryPayload(proof, event, key);
    expect(openRecoveryDeliveryPayload(recovery, event, [key]) === proof).toBe(true);
    expect(() => openDeliveryPayload(recovery, event, [key])).toThrow();
    const verification = sealDeliveryPayload(proof, event, key);
    expect(openDeliveryPayload(verification, event, [key]) === proof).toBe(true);
    expect(() => openRecoveryDeliveryPayload(verification, event, [key])).toThrow();
    expect(JSON.stringify(recovery).includes(proof)).toBe(false);
  });
  it('binds event identity and rejects ciphertext/tag tampering', () => {
    const envelope = sealRecoveryDeliveryPayload('public synthetic delivery fixture', event, key);
    expect(() => openRecoveryDeliveryPayload(envelope, randomUUID(), [key])).toThrow();
    expect(() =>
      openRecoveryDeliveryPayload({ ...envelope, tag: 'A'.repeat(22) }, event, [key]),
    ).toThrow();
    expect(() =>
      openRecoveryDeliveryPayload({ ...envelope, ciphertext: 'A' }, event, [key]),
    ).toThrow();
  });
  it('reads an explicitly retained key and rejects missing duplicate or incorrect keys', () => {
    const envelope = sealRecoveryDeliveryPayload('public synthetic delivery fixture', event, key);
    const current = { id: 'recovery-test-v2', key: randomBytes(32) };
    expect(openRecoveryDeliveryPayload(envelope, event, [current, key])).toBe(
      'public synthetic delivery fixture',
    );
    for (const keys of [[current], [key, key], [{ id: key.id, key: randomBytes(32) }]])
      expect(() => openRecoveryDeliveryPayload(envelope, event, keys)).toThrow();
  });
  it('retains bounded standard authenticated encryption and rejects malformed key material', () => {
    expect(() => sealRecoveryDeliveryPayload('x'.repeat(2049), event, key)).toThrow();
    expect(() =>
      sealRecoveryDeliveryPayload('public fixture', event, { id: key.id, key: randomBytes(31) }),
    ).toThrow();
  });
});
