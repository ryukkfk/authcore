import { createHash, randomBytes } from 'node:crypto';

export const createSessionCredential = () => randomBytes(32).toString('base64url');
export function sessionCredentialDigest(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(value) ||
    Buffer.from(value, 'base64url').toString('base64url') !== value
  )
    return undefined;
  return createHash('sha256')
    .update('authcore.browser.session.v1\0')
    .update(value, 'ascii')
    .digest('hex');
}
