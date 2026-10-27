'use client';

import { useEffect } from 'react';
import {
  shouldSkipMonkeyAssetWarmup,
  startMonkeyAssetWarmup,
} from '@/lib/monkey-asset-warmup';
import type { NearState } from '@/lib/near-states';

export function MonkeyAssetWarmup({
  artworkSources,
}: {
  artworkSources: Readonly<Record<NearState, string>>;
}) {
  useEffect(() => {
    if (shouldSkipMonkeyAssetWarmup()) return;

    const session = startMonkeyAssetWarmup({ artworkSources });
    return () => session.dispose();
  }, [artworkSources]);

  return null;
}
