export interface Account {
  id: string;
  email: string;
  emailVerified: true;
  createdAt: string;
}
export interface DeviceSession {
  id: string;
  deviceLabel: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
}
export class ApiFailure extends Error {
  constructor(readonly status: number) {
    super(
      status === 401
        ? 'Sign-in was not accepted. Check your credentials and email verification.'
        : status === 429
          ? 'Too many requests. Wait a minute before trying again.'
          : status === 400 || status === 409
            ? 'This request could not be accepted. Check your input or request a new link.'
            : status === 403
              ? 'This request could not be authorized. Reload the page and try again.'
              : 'AuthCore is temporarily unavailable. Please try again.',
    );
  }
}
export async function request(
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch('/api/v1/auth/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'include',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
      headers:
        body === undefined
          ? {}
          : {
              'content-type': 'application/json',
              'x-authcore-request': 'browser',
              ...extra,
            },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiFailure(503);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ApiFailure(response.status);
  }
  if (response.status === 204) return undefined;
  try {
    return await response.json();
  } catch {
    throw new ApiFailure(503);
  }
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const time = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 32 && Number.isFinite(Date.parse(value));
export function accountResponse(value: unknown): Account {
  const row = object(value) ? value.user : undefined;
  if (
    !object(row) ||
    !uuid(row.id) ||
    typeof row.email !== 'string' ||
    row.email.length > 254 ||
    row.emailVerified !== true ||
    !time(row.createdAt)
  )
    throw new ApiFailure(503);
  return { id: row.id, email: row.email, emailVerified: true, createdAt: row.createdAt };
}
export function sessionResponse(value: unknown): DeviceSession[] {
  const rows = object(value) ? value.sessions : undefined;
  if (!Array.isArray(rows) || rows.length > 10) throw new ApiFailure(503);
  return rows.map((row: unknown) => {
    if (
      !object(row) ||
      !uuid(row.id) ||
      typeof row.deviceLabel !== 'string' ||
      !['Chromium', 'Firefox', 'Safari', 'Other'].includes(row.deviceLabel) ||
      !time(row.createdAt) ||
      !time(row.lastSeenAt) ||
      !time(row.expiresAt) ||
      typeof row.current !== 'boolean'
    )
      throw new ApiFailure(503);
    return {
      id: row.id,
      deviceLabel: row.deviceLabel,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      expiresAt: row.expiresAt,
      current: row.current,
    };
  });
}
export const failureMessage = (error: unknown) =>
  error instanceof ApiFailure
    ? error.message
    : 'The request could not be completed. Please try again.';
