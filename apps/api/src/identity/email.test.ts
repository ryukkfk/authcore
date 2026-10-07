import { describe, expect, it } from 'vitest';

import { normalizeEmail } from './email.js';

describe('normalizeEmail', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeEmail('  user@example.com  ')).toBe('user@example.com');
  });

  it('normalizes casing', () => {
    expect(normalizeEmail('User@Example.COM')).toBe('user@example.com');
  });

  it('is idempotent', () => {
    const email = 'User@Example.COM';

    expect(normalizeEmail(normalizeEmail(email))).toBe('user@example.com');
  });

  it('preserves dots and plus tags instead of merging distinct addresses', () => {
    expect(normalizeEmail('  First.Last+Tag@Example.COM  ')).toBe('first.last+tag@example.com');
    expect(normalizeEmail('first.last@example.com')).not.toBe(
      normalizeEmail('firstlast@example.com'),
    );
    expect(normalizeEmail('user+tag@example.com')).not.toBe(normalizeEmail('user@example.com'));
  });
});
