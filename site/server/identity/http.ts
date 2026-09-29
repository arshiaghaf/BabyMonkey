import 'server-only';

import { decodeBase64url, sha256Hex } from './crypto';

export function readSubmittedChallenge(response: unknown): Promise<string | null> {
  if (!response || typeof response !== 'object') return Promise.resolve(null);
  const clientDataJSON = (response as {
    response?: { clientDataJSON?: unknown };
  }).response?.clientDataJSON;
  if (typeof clientDataJSON !== 'string' || clientDataJSON.length > 4096) {
    return Promise.resolve(null);
  }
  const bytes = decodeBase64url(clientDataJSON);
  if (!bytes || bytes.byteLength > 3072) return Promise.resolve(null);
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return Promise.resolve(null);
    }
    const challenge = (parsed as { challenge?: unknown }).challenge;
    if (
      typeof challenge !== 'string'
      || challenge.length !== 43
      || decodeBase64url(challenge)?.byteLength !== 32
    ) {
      return Promise.resolve(null);
    }
    return sha256Hex(challenge);
  } catch {
    return Promise.resolve(null);
  }
}
