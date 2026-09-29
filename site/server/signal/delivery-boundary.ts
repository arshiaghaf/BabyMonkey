import 'server-only';

import type { DeliveryResult } from '@/server/d1/signal-repository';

export interface FixedDeliveryBoundary {
  deliver(signal: AbortSignal): Promise<DeliveryResult>;
}

export const unavailableDeliveryBoundary: FixedDeliveryBoundary = {
  async deliver() {
    return 'definitive-failure';
  },
};
