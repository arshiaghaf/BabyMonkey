import { validProductionHostname as validConfiguredHostname } from './trusted-origin.mjs';

type ProductionEnvironment = {
  ASSETS?: { fetch?: unknown };
  DB?: { prepare?: unknown };
  BABYMONKEY_RP_ID?: unknown;
  BABYMONKEY_ORIGIN?: unknown;
  BABYMONKEY_RELAY_ORIGIN?: unknown;
  BABYMONKEY_RELAY_MTLS?: { fetch?: unknown };
  BABYMONKEY_LOCAL_DEMO?: unknown;
  BABYMONKEY_FAKE_DELIVERY?: unknown;
};

export function validProductionEnvironment(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const env = value as ProductionEnvironment;
  if (env.BABYMONKEY_LOCAL_DEMO !== undefined || env.BABYMONKEY_FAKE_DELIVERY !== undefined) return false;
  if (!validConfiguredHostname(env.BABYMONKEY_RP_ID)
    || env.BABYMONKEY_ORIGIN !== `https://${env.BABYMONKEY_RP_ID}`
    || typeof env.DB?.prepare !== 'function'
    || typeof env.ASSETS?.fetch !== 'function'
    || typeof env.BABYMONKEY_RELAY_MTLS?.fetch !== 'function'
    || typeof env.BABYMONKEY_RELAY_ORIGIN !== 'string') return false;
  try {
    const relay = new URL(env.BABYMONKEY_RELAY_ORIGIN);
    return relay.protocol === 'https:'
      && validConfiguredHostname(relay.hostname)
      && relay.origin === env.BABYMONKEY_RELAY_ORIGIN
      && relay.hostname !== env.BABYMONKEY_RP_ID
      && !relay.username && !relay.password && relay.pathname === '/' && !relay.search && !relay.hash && !relay.port;
  } catch { return false; }
}

