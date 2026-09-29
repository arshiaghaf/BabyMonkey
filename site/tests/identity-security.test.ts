import { describe, expect, it } from 'vitest';

import {
  appendExpiredCookie,
  appendSessionCookies,
  ceremonyFlowCookieName,
  createOpaqueToken,
  readFlowCookie,
  readOpaqueCookie,
  requestCsrfMatches,
  sessionCookieName,
  sessionCsrfCookieName,
} from '@/server/identity/cookies';
import {
  hasExactKeys,
  hasExactMutationEnvelope,
  readBoundedJsonObject,
} from '@/server/identity/request';
import {
  parseTrustedIdentity,
} from '@/server/identity/runtime';

const config = {
  rpId: 'localhost',
  origin: 'http://localhost:4173',
  localAutomatedHarness: true,
};

describe('identity request and cookie boundaries', () => {
  it('requires owner-pinned exact RP identity and rejects absent or inconsistent values', () => {
    expect(() => parseTrustedIdentity({})).toThrow();
    expect(() => parseTrustedIdentity({ rpId: 'app.example.com', origin: 'https://other.example.com' })).toThrow();
    expect(() => parseTrustedIdentity({ rpId: 'app.example.com', origin: 'http://app.example.com' })).toThrow();
    expect(parseTrustedIdentity({ rpId: 'app.owner.org', origin: 'https://app.owner.org' })).toEqual({
      rpId: 'app.owner.org', origin: 'https://app.owner.org', localAutomatedHarness: false,
    });
  });
  it('emits the exact opaque session cookie contract with a separate bound CSRF cookie', async () => {
    const session = await createOpaqueToken();
    const csrf = await createOpaqueToken();
    const headers = new Headers();
    appendSessionCookies(headers, session.raw, csrf.raw);
    const cookies = headers.getSetCookie();
    expect(cookies).toContain(
      `${sessionCookieName}=${session.raw}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000; Priority=High`,
    );
    expect(cookies).toContain(
      `${sessionCsrfCookieName}=${csrf.raw}; Path=/; Secure; SameSite=Lax; Max-Age=2592000; Priority=High`,
    );
    expect(cookies.join(';')).not.toContain('Domain=');
    expect(cookies.join(';')).not.toContain('Partitioned');

    appendExpiredCookie(headers, sessionCookieName);
    expect(headers.getSetCookie().at(-1)).toContain('Max-Age=0');
  });

  it('fails closed on duplicate, malformed, or mismatched opaque flow state', async () => {
    const flow = await createOpaqueToken();
    const csrf = await createOpaqueToken();
    const request = new Request('http://localhost:4173/api/identity/options', {
      method: 'POST',
      headers: {
        cookie: `${ceremonyFlowCookieName}=${flow.raw}.${csrf.raw}`,
        'x-bm-csrf': csrf.raw,
      },
    });
    expect(readFlowCookie(request, ceremonyFlowCookieName)).toEqual({
      flowIdentifier: flow.raw,
      csrfToken: csrf.raw,
    });
    expect(requestCsrfMatches(request, csrf.raw)).toBe(true);

    const duplicate = new Request(request.url, {
      headers: {
        cookie: `${sessionCookieName}=${flow.raw}; ${sessionCookieName}=${flow.raw}`,
      },
    });
    expect(readOpaqueCookie(duplicate, sessionCookieName)).toBeNull();
  });

  it('requires exact method, origin, JSON media type, bounded body, and exact fields', async () => {
    const valid = new Request('http://localhost:4173/api/identity/options', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: config.origin,
      },
      body: JSON.stringify({ action: 'continue' }),
    });
    expect(hasExactMutationEnvelope(valid, config)).toBe(true);
    const body = await readBoundedJsonObject(valid, 128);
    expect(body && hasExactKeys(body, ['action'])).toBe(true);

    const wrongOrigin = new Request(valid.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:9999',
      },
      body: '{}',
    });
    expect(hasExactMutationEnvelope(wrongOrigin, config)).toBe(false);

    const oversized = new Request(valid.url, {
      method: 'POST',
      headers: { 'content-length': '1024' },
      body: '{}',
    });
    await expect(readBoundedJsonObject(oversized, 128)).resolves.toBeNull();
  });
});
