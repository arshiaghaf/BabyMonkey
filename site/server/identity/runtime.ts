import 'server-only';
import { validProductionHostname } from '../../trusted-origin.mjs';

import { getCloudflareContext } from '@opennextjs/cloudflare';
import type { D1DatabaseLike } from '@/server/d1/types';

export interface WebAuthnRuntimeConfig {
  rpId: string;
  origin: string;
  localAutomatedHarness: boolean;
}
interface IdentityCloudflareEnv {
  DB?: D1DatabaseLike;
  BABYMONKEY_RP_ID?: string;
  BABYMONKEY_ORIGIN?: string;
  ASSETS?: Fetcher;
}
const readEnvironment = (): IdentityCloudflareEnv | null => {
  try { return getCloudflareContext().env as unknown as IdentityCloudflareEnv; }
  catch { return null; }
};
export function parseTrustedIdentity(value: { rpId?: unknown; origin?: unknown }): WebAuthnRuntimeConfig {
  if (typeof value.rpId !== 'string' || typeof value.origin !== 'string') throw new Error('Trusted identity configuration is missing.');
  const { rpId, origin } = value;
  let parsed: URL;
  try { parsed = new URL(origin); } catch { throw new Error('Trusted identity origin is invalid.'); }
  const local = process.env.NODE_ENV === 'development' && origin === 'http://localhost:3000' && rpId === 'localhost';
  if (!local && (parsed.protocol !== 'https:' || !validProductionHostname(rpId))) throw new Error('Trusted identity hostname is invalid.');
  if (parsed.hostname !== rpId || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || (!local && parsed.port) || parsed.origin !== origin) {
    throw new Error('Trusted identity origin does not match RP ID.');
  }
  return { rpId, origin, localAutomatedHarness: local };
}
export function getWebAuthnRuntimeConfig(): WebAuthnRuntimeConfig {
  const env = readEnvironment();
  return parseTrustedIdentity({ rpId: env?.BABYMONKEY_RP_ID, origin: env?.BABYMONKEY_ORIGIN });
}
export function getIdentityDatabase(): D1DatabaseLike | null { return readEnvironment()?.DB ?? null; }
export function getProtectedAssetBinding(): Fetcher | null { return readEnvironment()?.ASSETS ?? null; }
