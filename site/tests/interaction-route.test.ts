import { beforeEach, describe, expect, it, vi } from 'vitest';

const { submitProtectedSignal, getFixedDeliveryBoundary, deliveryBoundary } = vi.hoisted(() => ({
  submitProtectedSignal: vi.fn(),
  getFixedDeliveryBoundary: vi.fn(),
  deliveryBoundary: { deliver: vi.fn() },
}));

vi.mock('@/server/signal/service', () => ({ submitProtectedSignal }));
vi.mock('@/server/signal/runtime', () => ({ getFixedDeliveryBoundary }));
vi.mock('@/server/identity/runtime', () => ({
  getIdentityDatabase: () => ({ synthetic: true }),
  getWebAuthnRuntimeConfig: () => ({
    rpId: 'localhost',
    origin: 'http://localhost:4173',
    localAutomatedHarness: true,
  }),
}));

import { POST } from '@/app/api/interaction/route';
import {
  createOpaqueToken,
  sessionCookieName,
  sessionCsrfCookieName,
} from '@/server/identity/cookies';

const attempt = 'A'.repeat(43);

async function requestFor(input: {
  body?: string;
  contentType?: string;
  cookie?: string;
  csrfHeader?: string;
  method?: string;
  origin?: string;
  signalVersion?: string | null;
} = {}) {
  const session = await createOpaqueToken();
  const csrf = await createOpaqueToken();
  return {
    csrf,
    request: new Request('http://localhost:4173/api/interaction', {
      method: input.method ?? 'POST',
      headers: {
        cookie: input.cookie ?? `${sessionCookieName}=${session.raw}; ${sessionCsrfCookieName}=${csrf.raw}`,
        'content-type': input.contentType ?? 'application/json',
        origin: input.origin ?? 'http://localhost:4173',
        'x-bm-csrf': input.csrfHeader ?? csrf.raw,
        ...(input.signalVersion === null
          ? {}
          : { 'x-bm-signal-version': input.signalVersion ?? 'none' }),
      },
      ...(input.method === 'GET' ? {} : { body: input.body ?? JSON.stringify({ attempt }) }),
    }),
  };
}

describe('protected interaction request boundary', () => {
  beforeEach(() => {
    submitProtectedSignal.mockReset();
    submitProtectedSignal.mockResolvedValue({
      accepted: true,
      snapshot: { available: true, state: 'definitive-failure', retryAfterMs: 0 },
      version: 'd'.repeat(64),
    });
    getFixedDeliveryBoundary.mockReset();
    getFixedDeliveryBoundary.mockReturnValue(deliveryBoundary);
  });

  it('accepts only the fixed opaque attempt and returns a narrow no-store result', async () => {
    const { request } = await requestFor();
    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('x-bm-signal-version')).toBe('d'.repeat(64));
    expect(await response.json()).toEqual({ state: 'definitive-failure', retryAfterMs: 0 });
    expect(submitProtectedSignal).toHaveBeenCalledTimes(1);
    expect(submitProtectedSignal.mock.calls[0][1]).toMatchObject({
      attempt,
      expectedVersion: null,
    });
    expect(submitProtectedSignal.mock.calls[0][1].sessionHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(submitProtectedSignal.mock.calls[0][1].csrfHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(submitProtectedSignal.mock.calls[0][2]).toBe(deliveryBoundary);
    expect(getFixedDeliveryBoundary).toHaveBeenCalledTimes(1);
  });

  it('returns the authoritative remaining lease for pending reconciliation', async () => {
    submitProtectedSignal.mockResolvedValue({
      accepted: true,
      snapshot: { available: true, state: 'pending', retryAfterMs: 4_321 },
      version: 'd'.repeat(64),
    });
    const { request } = await requestFor();
    const response = await POST(request);
    expect(await response.json()).toEqual({ state: 'pending', retryAfterMs: 4_321 });
  });

  it('returns the authoritative cooldown remainder for mounted recovery', async () => {
    submitProtectedSignal.mockResolvedValue({
      accepted: true,
      snapshot: { available: true, state: 'cooldown', retryAfterMs: 12_345 },
      version: 'd'.repeat(64),
    });
    const { request } = await requestFor();
    const response = await POST(request);
    expect(await response.json()).toEqual({ state: 'cooldown', retryAfterMs: 12_345 });
  });

  for (const [name, input] of [
    ['cross-origin request', { origin: 'http://localhost:9999' }],
    ['wrong method', { method: 'GET' }],
    ['wrong media type', { contentType: 'text/plain' }],
    ['malformed JSON', { body: '{' }],
    ['empty object', { body: '{}' }],
    ['malformed attempt', { body: '{"attempt":"short"}' }],
    ['extra identity field', { body: JSON.stringify({ attempt, identity: 'one' }) }],
    ['extra message field', { body: JSON.stringify({ attempt, message: 'chosen' }) }],
    ['extra relay field', { body: JSON.stringify({ attempt, relayUrl: 'https://invalid.example' }) }],
    ['oversized body', { body: JSON.stringify({ attempt: 'a'.repeat(512) }) }],
    ['missing signal version', { signalVersion: null }],
    ['malformed signal version', { signalVersion: 'invalid' }],
  ] as const) {
    it(`denies ${name} neutrally before service execution`, async () => {
      const { request } = await requestFor(input);
      const response = await POST(request);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ ok: false });
      expect(submitProtectedSignal).not.toHaveBeenCalled();
    });
  }

  it('denies missing, duplicate, malformed, and mismatched CSRF state', async () => {
    const valid = await requestFor();
    const cases = [
      await requestFor({ cookie: '' }),
      await requestFor({ cookie: `${sessionCsrfCookieName}=${valid.csrf.raw}; ${sessionCsrfCookieName}=${valid.csrf.raw}` }),
      await requestFor({ csrfHeader: 'malformed' }),
      await requestFor({ csrfHeader: (await createOpaqueToken()).raw }),
    ];
    for (const { request } of cases) {
      const response = await POST(request);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ ok: false });
    }
    expect(submitProtectedSignal).not.toHaveBeenCalled();
  });
});
