import 'server-only';

import {
  constantTimeEqual,
  decodeBase64url,
  encodeBase64url,
  randomBytes,
  sha256Hex,
} from './crypto';

export const sessionCookieName = '__Host-bm-session';
export const sessionCsrfCookieName = '__Host-bm-csrf';
export const enrollmentCookieName = '__Host-bm-enrollment';
export const ceremonyFlowCookieName = '__Host-bm-flow';
export const invitationBootstrapCookieName = '__Host-bm-bootstrap';
export const csrfHeaderName = 'x-bm-csrf';

export const sessionLifetimeSeconds = 2_592_000;
export const sessionLifetimeMs = sessionLifetimeSeconds * 1000;
export const enrollmentLifetimeSeconds = 15 * 60;
export const ceremonyFlowLifetimeSeconds = 10 * 60;
export const invitationBootstrapLifetimeSeconds = 5 * 60;

const cookieValuePattern = /^[A-Za-z0-9_-]{43}$/;

const appendCookie = (
  headers: Headers,
  name: string,
  value: string,
  options: { httpOnly: boolean; maxAge: number; sameSite: 'Lax' | 'Strict' },
) => {
  const attributes = [
    `${name}=${value}`,
    'Path=/',
    'Secure',
    ...(options.httpOnly ? ['HttpOnly'] : []),
    `SameSite=${options.sameSite}`,
    `Max-Age=${options.maxAge}`,
    'Priority=High',
  ];
  headers.append('Set-Cookie', attributes.join('; '));
};

export function appendSessionCookies(
  headers: Headers,
  sessionIdentifier: string,
  csrfToken: string,
) {
  appendCookie(headers, sessionCookieName, sessionIdentifier, {
    httpOnly: true,
    maxAge: sessionLifetimeSeconds,
    sameSite: 'Lax',
  });
  appendCookie(headers, sessionCsrfCookieName, csrfToken, {
    httpOnly: false,
    maxAge: sessionLifetimeSeconds,
    sameSite: 'Lax',
  });
}

export function appendEnrollmentCookie(headers: Headers, value: string) {
  appendCookie(headers, enrollmentCookieName, value, {
    httpOnly: true,
    maxAge: enrollmentLifetimeSeconds,
    sameSite: 'Strict',
  });
}

export function appendFlowCookie(
  headers: Headers,
  name: typeof ceremonyFlowCookieName | typeof invitationBootstrapCookieName,
  flowIdentifier: string,
  csrfToken: string,
) {
  const maxAge = name === ceremonyFlowCookieName
    ? ceremonyFlowLifetimeSeconds
    : invitationBootstrapLifetimeSeconds;
  appendCookie(headers, name, `${flowIdentifier}.${csrfToken}`, {
    httpOnly: true,
    maxAge,
    sameSite: 'Strict',
  });
}

export function appendExpiredCookie(
  headers: Headers,
  name:
    | typeof sessionCookieName
    | typeof sessionCsrfCookieName
    | typeof enrollmentCookieName
    | typeof ceremonyFlowCookieName
    | typeof invitationBootstrapCookieName,
) {
  appendCookie(headers, name, '', {
    httpOnly: name !== sessionCsrfCookieName,
    maxAge: 0,
    sameSite: name === sessionCookieName || name === sessionCsrfCookieName
      ? 'Lax'
      : 'Strict',
  });
}

export function readUniqueCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  const matches: string[] = [];
  for (const entry of header.split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0) continue;
    if (entry.slice(0, separator).trim() !== name) continue;
    matches.push(entry.slice(separator + 1).trim());
  }
  return matches.length === 1 ? matches[0] : null;
}

export function readOpaqueCookie(request: Request, name: string): string | null {
  const value = readUniqueCookie(request, name);
  return value && cookieValuePattern.test(value) && decodeBase64url(value)?.length === 32
    ? value
    : null;
}

export interface FlowCookie {
  flowIdentifier: string;
  csrfToken: string;
}

export function readFlowCookie(request: Request, name: string): FlowCookie | null {
  const value = readUniqueCookie(request, name);
  if (!value) return null;
  const parts = value.split('.');
  if (
    parts.length !== 2
    || !cookieValuePattern.test(parts[0])
    || !cookieValuePattern.test(parts[1])
    || decodeBase64url(parts[0])?.length !== 32
    || decodeBase64url(parts[1])?.length !== 32
  ) {
    return null;
  }
  return { flowIdentifier: parts[0], csrfToken: parts[1] };
}

export function requestCsrfMatches(request: Request, expectedToken: string): boolean {
  const submitted = request.headers.get(csrfHeaderName);
  if (
    !submitted
    || submitted.includes(',')
    || !cookieValuePattern.test(submitted)
  ) {
    return false;
  }
  const expected = decodeBase64url(expectedToken);
  const actual = decodeBase64url(submitted);
  return Boolean(expected && actual && constantTimeEqual(expected, actual));
}

export async function createOpaqueToken() {
  const raw = encodeBase64url(randomBytes(32));
  return { raw, hash: await sha256Hex(raw) };
}

export async function hashOpaqueCookie(
  request: Request,
  name: string,
): Promise<string | null> {
  const raw = readOpaqueCookie(request, name);
  return raw ? sha256Hex(raw) : null;
}
