import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getCloudflareContext } = vi.hoisted(() => ({
  getCloudflareContext: vi.fn(),
}));

vi.mock('@opennextjs/cloudflare', () => ({ getCloudflareContext }));

import { unavailableDeliveryBoundary } from '@/server/signal/delivery-boundary';
import { getFixedDeliveryBoundary } from '@/server/signal/runtime';

describe('signal delivery runtime resolution', () => {
  beforeEach(() => {
    getCloudflareContext.mockReset();
  });

  it('keeps missing context, binding, origin, and invalid configuration known-unsent', async () => {
    const cases = [
      () => { throw new Error('no Cloudflare context'); },
      () => ({ env: {} }),
      () => ({ env: { BABYMONKEY_RELAY_ORIGIN: 'https://relay.invalid' } }),
      () => ({ env: { BABYMONKEY_RELAY_MTLS: { fetch: vi.fn() } } }),
      () => ({ env: {
        BABYMONKEY_RELAY_MTLS: { fetch: vi.fn() },
        BABYMONKEY_RELAY_ORIGIN: 'http://relay.invalid',
      } }),
    ];
    for (const fixture of cases) {
      getCloudflareContext.mockImplementation(fixture);
      const boundary = getFixedDeliveryBoundary();
      expect(boundary).toBe(unavailableDeliveryBoundary);
      await expect(boundary.deliver(new AbortController().signal)).resolves.toBe('definitive-failure');
    }
  });

  it('selects the mTLS boundary only when both exact activation inputs exist', async () => {
    const bindingFetch = vi.fn(async () => new Response('{"v":1,"outcome":"ambiguous"}', {
      status: 200,
      headers: { 'content-type': 'application/vnd.babymonkey.fixed-notification.v1+json' },
    }));
    getCloudflareContext.mockReturnValue({ env: {
      BABYMONKEY_RELAY_MTLS: { fetch: bindingFetch },
      BABYMONKEY_RELAY_ORIGIN: 'https://relay.invalid',
    } });
    const boundary = getFixedDeliveryBoundary();
    expect(boundary).not.toBe(unavailableDeliveryBoundary);
    await expect(boundary.deliver(new AbortController().signal)).resolves.toBe('ambiguous');
    expect(bindingFetch).toHaveBeenCalledTimes(1);
  });
});
