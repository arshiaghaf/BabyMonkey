import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createMTLSDeliveryBoundary,
  fixedNotificationProtocol,
  parseRelayOrigin,
} from '@/server/signal/mtls-delivery-boundary';

const fixedNow = 1_787_608_000_000;
const fixedRandom = () => Uint8Array.from({ length: 32 }, (_, index) => index);

function protocolResponse(outcome: string, init: ResponseInit = {}) {
  return new Response(`{"v":1,"outcome":"${outcome}"}`, {
    status: 200,
    headers: { 'content-type': fixedNotificationProtocol.mediaType },
    ...init,
  });
}

function boundaryFor(
  fetcher: (request: Request) => Promise<Response>,
  options: { deadlineMs?: number } = {},
) {
  const boundary = createMTLSDeliveryBoundary(
    { fetch: fetcher } as Pick<Fetcher, 'fetch'>,
    'https://relay.invalid',
    { now: () => fixedNow, random: fixedRandom, ...options },
  );
  if (!boundary) throw new Error('Expected valid synthetic boundary.');
  return boundary;
}

describe('mTLS fixed delivery boundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses only binding.fetch with the exact fixed protocol', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    const calls: Request[] = [];
    const boundary = boundaryFor(async (request) => {
      calls.push(request);
      return protocolResponse('confirmed');
    });
    await expect(boundary.deliver(new AbortController().signal)).resolves.toBe('confirmed');
    expect(globalFetch).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    const request = calls[0];
    expect(request.url).toBe('https://relay.invalid/v1/fixed-notification');
    expect(request.method).toBe('POST');
    expect(request.redirect).toBe('manual');
    expect([...request.headers.entries()]).toEqual([
      ['accept', fixedNotificationProtocol.mediaType],
      ['content-type', fixedNotificationProtocol.mediaType],
    ]);
    const body = await request.text();
    expect(body).toBe(
      '{"v":1,"issued_at":1787608000,"replay_key":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"}',
    );
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(
      fixedNotificationProtocol.maxRequestBytes,
    );
    expect(body).not.toMatch(/principal|session|generation|recipient|message|destination|signal/iu);
  });

  it.each([
    ['confirmed', 'confirmed'],
    ['definitive-failure', 'definitive-failure'],
    ['ambiguous', 'ambiguous'],
  ] as const)('accepts only the canonical %s response', async (wireOutcome, expected) => {
    const boundary = boundaryFor(async () => protocolResponse(wireOutcome));
    await expect(boundary.deliver(new AbortController().signal)).resolves.toBe(expected);
  });

  it.each([
    ['non-200', () => protocolResponse('confirmed', { status: 403 })],
    ['redirect', () => new Response(null, {
      status: 302,
      headers: { location: 'https://other.invalid/v1/fixed-notification' },
    })],
    ['missing media type', () => new Response('{"v":1,"outcome":"confirmed"}')],
    ['wrong media type', () => new Response('{"v":1,"outcome":"confirmed"}', { headers: { 'content-type': 'application/json' } })],
    ['malformed JSON', () => new Response('{', { headers: { 'content-type': fixedNotificationProtocol.mediaType } })],
    ['extra field', () => new Response('{"v":1,"outcome":"confirmed","detail":"x"}', { headers: { 'content-type': fixedNotificationProtocol.mediaType } })],
    ['duplicate field', () => new Response('{"v":1,"outcome":"confirmed","outcome":"confirmed"}', { headers: { 'content-type': fixedNotificationProtocol.mediaType } })],
    ['wrong version', () => new Response('{"v":2,"outcome":"confirmed"}', { headers: { 'content-type': fixedNotificationProtocol.mediaType } })],
    ['unknown outcome', () => protocolResponse('other')],
    ['oversized', () => new Response('x'.repeat(65), { headers: { 'content-type': fixedNotificationProtocol.mediaType } })],
    ['invalid UTF-8', () => new Response(new Uint8Array([0xff]), { headers: { 'content-type': fixedNotificationProtocol.mediaType } })],
  ] as const)('maps %s to ambiguous', async (_name, responseFactory) => {
    const boundary = boundaryFor(async () => responseFactory());
    await expect(boundary.deliver(new AbortController().signal)).resolves.toBe('ambiguous');
  });

  it('maps thrown fetch, pre-abort, caller abort, and local deadline to ambiguous', async () => {
    const thrown = boundaryFor(async () => { throw new Error('synthetic'); });
    await expect(thrown.deliver(new AbortController().signal)).resolves.toBe('ambiguous');

    const preAbortedController = new AbortController();
    preAbortedController.abort();
    const bindingFetch = vi.fn(async () => protocolResponse('confirmed'));
    await expect(boundaryFor(bindingFetch).deliver(preAbortedController.signal)).resolves.toBe('ambiguous');
    expect(bindingFetch).not.toHaveBeenCalled();

    for (const abortByCaller of [true, false]) {
      const caller = new AbortController();
      const boundary = boundaryFor((request) => new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      }), { deadlineMs: 10 });
      const delivery = boundary.deliver(caller.signal);
      if (abortByCaller) caller.abort();
      await expect(delivery).resolves.toBe('ambiguous');
    }
  });

  it('cannot confirm after its deadline even if binding fetch or body delivery ignores abort', async () => {
    const lateFetch = boundaryFor((request) => new Promise<Response>((resolve) => {
      request.signal.addEventListener('abort', () => resolve(protocolResponse('confirmed')), { once: true });
    }), { deadlineMs: 10 });
    await expect(lateFetch.deliver(new AbortController().signal)).resolves.toBe('ambiguous');

    const lateBody = boundaryFor(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode('{"v":1,"outcome":"confirmed"}'));
          controller.close();
        }, 20);
      },
    }), {
      status: 200,
      headers: { 'content-type': fixedNotificationProtocol.mediaType },
    }), { deadlineMs: 10 });
    await expect(lateBody.deliver(new AbortController().signal)).resolves.toBe('ambiguous');
  });

  it('fails closed when randomness is unavailable or malformed', async () => {
    const bindingFetch = vi.fn(async () => protocolResponse('confirmed'));
    for (const random of [
      () => new Uint8Array(31),
      () => { throw new Error('synthetic randomness failure'); },
    ]) {
      const boundary = createMTLSDeliveryBoundary(
        { fetch: bindingFetch } as Pick<Fetcher, 'fetch'>,
        'https://relay.invalid',
        { now: () => fixedNow, random },
      );
      if (!boundary) throw new Error('Expected structurally valid boundary.');
      await expect(boundary.deliver(new AbortController().signal)).resolves.toBe('ambiguous');
    }
    expect(bindingFetch).not.toHaveBeenCalled();
  });
});

describe('relay origin validation', () => {
  it('accepts only an exact bare HTTPS DNS origin', () => {
    expect(parseRelayOrigin('https://relay.invalid')).toBe('https://relay.invalid');
    expect(parseRelayOrigin('https://relay.invalid:8443')).toBe('https://relay.invalid:8443');
    for (const invalid of [
      undefined,
      '',
      ' http://relay.invalid',
      'http://relay.invalid',
      'https://relay.invalid/',
      'https://RELAY.invalid',
      'https://user@relay.invalid',
      'https://relay.invalid/path',
      'https://relay.invalid?x=1',
      'https://relay.invalid#x',
      'https://localhost:8443',
      'https://127.0.0.1:8443',
      'https://[::1]:8443',
      'https://relay.invalid:443',
    ]) {
      expect(parseRelayOrigin(invalid)).toBeNull();
    }
  });
});
