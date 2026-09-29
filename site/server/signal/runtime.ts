import 'server-only';

import { getCloudflareContext } from '@opennextjs/cloudflare';

import {
  unavailableDeliveryBoundary,
  type FixedDeliveryBoundary,
} from './delivery-boundary';
import { createMTLSDeliveryBoundary } from './mtls-delivery-boundary';

interface SignalCloudflareEnv {
  BABYMONKEY_RELAY_MTLS?: Fetcher;
  BABYMONKEY_RELAY_ORIGIN?: string;
}

const readEnvironment = (): SignalCloudflareEnv | null => {
  try {
    return getCloudflareContext().env as unknown as SignalCloudflareEnv;
  } catch {
    return null;
  }
};

export function getFixedDeliveryBoundary(): FixedDeliveryBoundary {
  if (process.env.NODE_ENV === 'development' && process.env.BABYMONKEY_LOCAL_DEMO === '1') {
    const outcome = process.env.BABYMONKEY_FAKE_DELIVERY;
    if (outcome === 'confirmed' || outcome === 'definitive-failure' || outcome === 'ambiguous') {
      return { async deliver() { return outcome; } };
    }
    return unavailableDeliveryBoundary;
  }
  const environment = readEnvironment();
  if (!environment) return unavailableDeliveryBoundary;
  const binding = environment.BABYMONKEY_RELAY_MTLS;
  const origin = environment.BABYMONKEY_RELAY_ORIGIN;
  if (!binding || typeof origin !== 'string') return unavailableDeliveryBoundary;
  return createMTLSDeliveryBoundary(binding, origin) ?? unavailableDeliveryBoundary;
}
