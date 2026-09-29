'use client';

import { useEffect } from 'react';
import {
  shouldSkipMonkeyAssetWarmup,
  startMonkeyAssetWarmup,
} from '@/lib/monkey-asset-warmup';
import type { BabyMonkeyState } from '@/lib/babymonkey-states';

export function MonkeyAssetWarmup({
  artworkSources,
}: {
  artworkSources: Readonly<Record<BabyMonkeyState, string>>;
}) {
  useEffect(() => {
    if (shouldSkipMonkeyAssetWarmup()) return;

    const session = startMonkeyAssetWarmup({ artworkSources });
    return () => session.dispose();
  }, [artworkSources]);

  return null;
}
