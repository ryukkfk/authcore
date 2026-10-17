import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountResponse, sessionResponse, request, ApiFailure } from './api.js';
import { consumeVerificationCredential } from './verification.js';

afterEach(() => vi.unstubAllGlobals());
describe('Browser credential and HTTP contract', () => {
  it('removes verification proof before returning it and rejects query-shaped or malformed fragments', () => {
    const token = 'a'.repeat(43),
      replaceState = vi.fn();
    expect(
      consumeVerificationCredential(
        { pathname: '/verify', hash: '#token=' + token },
        { replaceState },
      ),
    ).toBe(token);
    expect(replaceState).toHaveBeenCalledExactlyOnceWith(null, '', '/verify');
    for (const hash of ['#token=short', '#token=' + token + '&extra=1', '#token=%61'.repeat(43)]) {
      expect(
        consumeVerificationCredential({ pathname: '/verify', hash }, { replaceState }),
      ).toBeUndefined();
    }
  });
  it('posts JSON with cookies and a CSRF header, and keeps proof out of the request URL', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);
    await request('logout', {});
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/auth/logout');
    expect(options.credentials).toBe('include');
    expect(options.redirect).toBe('error');
    expect(options.cache).toBe('no-store');
    expect(options.headers).toEqual({
      'content-type': 'application/json',
      'x-authcore-request': 'browser',
    });
  });
  it('sanitizes server and transport failures without displaying their private response body', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response('Synthetic private database detail', { status: 503 }),
    );
    await expect(request('login', {})).rejects.toMatchObject({ status: 503 });
    try {
      await request('login', {});
    } catch (error) {
      expect(error instanceof Error && error.message.includes('Synthetic')).toBe(false);
    }
    vi.stubGlobal('fetch', async () => {
      throw new Error('Synthetic transport details');
    });
    await expect(request('me')).rejects.toBeInstanceOf(ApiFailure);
  });
  it('accepts only verified profiles and copies safe output fields', () => {
    const profile = {
      id: '11111111-1111-4111-8111-111111111111',
      email: 'fixture@example.invalid',
      emailVerified: true,
      createdAt: '2026-10-17T00:00:00.000Z',
    };
    expect(
      Object.keys(
        accountResponse({ user: { ...profile, unexpectedCredential: 'synthetic' } }),
      ).sort(),
    ).toEqual(['createdAt', 'email', 'emailVerified', 'id']);
    for (const user of [
      { ...profile, emailVerified: false },
      { ...profile, id: 'invalid' },
      { ...profile, createdAt: 'invalid' },
    ])
      expect(() => accountResponse({ user })).toThrow(ApiFailure);
  });
  it('rejects malformed or unbounded session lists rather than rendering asserted access', () => {
    expect(sessionResponse({ sessions: [] })).toEqual([]);
    expect(() => sessionResponse({ sessions: Array.from({ length: 11 }, () => ({})) })).toThrow(
      ApiFailure,
    );
    expect(() => sessionResponse({ sessions: [{ tokenDigest: 'synthetic' }] })).toThrow(ApiFailure);
  });
});
