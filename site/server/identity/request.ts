import 'server-only';

import type { WebAuthnRuntimeConfig } from './runtime';

export const maximumIdentityJsonBytes = 32 * 1024;

export function hasExactMutationEnvelope(
  request: Request,
  config: WebAuthnRuntimeConfig,
): boolean {
  return (
    request.method === 'POST'
    && request.headers.get('origin') === config.origin
    && request.headers.get('content-type') === 'application/json'
  );
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

export async function readBoundedJsonObject(
  request: Request,
  maximumBytes = maximumIdentityJsonBytes,
): Promise<Record<string, unknown> | null> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/u.test(contentLength)) return null;
    const declaredLength = Number.parseInt(contentLength, 10);
    if (declaredLength < 1 || declaredLength > maximumBytes) return null;
  }
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  if (total === 0) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

export function noStoreHeaders(contentType: string): Headers {
  return new Headers({
    'Cache-Control': 'no-store, max-age=0',
    'Content-Type': contentType,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
}

export function noStoreJson(
  body: Record<string, unknown>,
  status = 200,
  headers = noStoreHeaders('application/json'),
) {
  return new Response(JSON.stringify(body), { status, headers });
}

export function neutralMutationFailure(status = 400) {
  return noStoreJson({ ok: false }, status);
}
