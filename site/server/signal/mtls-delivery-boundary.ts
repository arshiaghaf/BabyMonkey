import 'server-only';

import type { DeliveryResult } from '@/server/d1/signal-repository';
import { encodeBase64url, randomBytes } from '@/server/identity/crypto';
import type { FixedDeliveryBoundary } from './delivery-boundary';

export const fixedNotificationProtocol = {
  version: 1,
  path: '/v1/fixed-notification',
  mediaType: 'application/vnd.babymonkey.fixed-notification.v1+json',
  maxRequestBytes: 128,
  maxResponseBytes: 64,
  deadlineMs: 7_000,
} as const;

type MTLSFetcher = Pick<Fetcher, 'fetch'>;

const relayHostnamePattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const ipv4AddressPattern = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/u;

export function parseRelayOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'https:'
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.pathname !== '/'
      || parsed.search !== ''
      || parsed.hash !== ''
      || !relayHostnamePattern.test(parsed.hostname)
      || ipv4AddressPattern.test(parsed.hostname)
      || parsed.hostname.includes(':')
      || parsed.origin !== value
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

const exactResponseBodies = new Map<string, DeliveryResult>([
  ['{"v":1,"outcome":"confirmed"}', 'confirmed'],
  ['{"v":1,"outcome":"definitive-failure"}', 'definitive-failure'],
  ['{"v":1,"outcome":"ambiguous"}', 'ambiguous'],
]);

async function readBoundedResponse(response: Response): Promise<string | null> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number.parseInt(declaredLength, 10);
    if (
      !/^(?:0|[1-9][0-9]*)$/u.test(declaredLength)
      || !Number.isSafeInteger(parsedLength)
      || parsedLength > fixedNotificationProtocol.maxResponseBytes
    ) {
      void response.body?.cancel();
      return null;
    }
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > fixedNotificationProtocol.maxResponseBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    try {
      await reader.cancel();
    } catch {
      // The transport may already have closed the stream.
    }
    return null;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A cancelled stream may retain its lock until cancellation settles.
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function createMTLSDeliveryBoundary(
  binding: MTLSFetcher,
  relayOrigin: string,
  options: {
    now?: () => number;
    random?: (length: number) => Uint8Array<ArrayBuffer>;
    deadlineMs?: number;
  } = {},
): FixedDeliveryBoundary | null {
  const origin = parseRelayOrigin(relayOrigin);
  if (!origin || typeof binding?.fetch !== 'function') return null;
  const now = options.now ?? Date.now;
  const random = options.random ?? randomBytes;
  const deadlineMs = options.deadlineMs ?? fixedNotificationProtocol.deadlineMs;
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > fixedNotificationProtocol.deadlineMs) {
    return null;
  }

  return {
    async deliver(signal) {
      if (signal.aborted) return 'ambiguous';
      let replayKey: string;
      try {
        const keyBytes = random(32);
        if (keyBytes.byteLength !== 32) return 'ambiguous';
        replayKey = encodeBase64url(keyBytes);
      } catch {
        return 'ambiguous';
      }
      const issuedAt = Math.floor(now() / 1_000);
      if (!Number.isSafeInteger(issuedAt) || issuedAt < 1_000_000_000 || issuedAt > 99_999_999_999) {
        return 'ambiguous';
      }
      const body = `{"v":1,"issued_at":${issuedAt},"replay_key":"${replayKey}"}`;
      if (new TextEncoder().encode(body).byteLength > fixedNotificationProtocol.maxRequestBytes) {
        return 'ambiguous';
      }

      const controller = new AbortController();
      const abortFromCaller = () => controller.abort();
      signal.addEventListener('abort', abortFromCaller, { once: true });
      const timeout = setTimeout(() => controller.abort(), deadlineMs);
      try {
        const request = new Request(`${origin}${fixedNotificationProtocol.path}`, {
          method: 'POST',
          redirect: 'manual',
          headers: {
            accept: fixedNotificationProtocol.mediaType,
            'content-type': fixedNotificationProtocol.mediaType,
          },
          body,
          signal: controller.signal,
        });
        const response = await binding.fetch(request);
        if (controller.signal.aborted) {
          void response.body?.cancel();
          return 'ambiguous';
        }
        if (
          response.status !== 200
          || response.headers.get('content-type') !== fixedNotificationProtocol.mediaType
        ) {
          void response.body?.cancel();
          return 'ambiguous';
        }
        const responseBody = await readBoundedResponse(response);
        if (controller.signal.aborted) return 'ambiguous';
        return responseBody === null
          ? 'ambiguous'
          : exactResponseBodies.get(responseBody) ?? 'ambiguous';
      } catch {
        return 'ambiguous';
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', abortFromCaller);
      }
    },
  };
}
