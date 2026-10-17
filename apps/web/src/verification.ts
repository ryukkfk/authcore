/** Consume mailbox proof before rendering or issuing any network request.
 * Fragments never reach the HTTP server. No analytics, storage or token display.
 */
export function consumeVerificationCredential(
  location: Pick<Location, 'pathname' | 'hash'>,
  history: Pick<History, 'replaceState'>,
): string | undefined {
  if (location.pathname !== '/verify') return undefined;
  const fragment = location.hash;
  history.replaceState(null, '', '/verify');
  const match = /^#token=([A-Za-z0-9_-]{43})$/.exec(fragment);
  return match?.[1];
}
