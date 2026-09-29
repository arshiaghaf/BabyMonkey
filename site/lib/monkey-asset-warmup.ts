import type { BabyMonkeyState } from '@/lib/babymonkey-states';

const criticalStates = ['ready', 'pending'] as const;
const secondaryStates = [
  'confirmed',
  'cooldown',
  'definitiveFailure',
  'ambiguous',
] as const;

type WarmupPriority = 'high' | 'low';

type WarmupResource = {
  cancelLoad: () => void;
  image: HTMLImageElement;
  loaded: Promise<boolean>;
};

export type MonkeyAssetWarmupSignals = {
  prefersReducedData?: boolean;
  saveData?: boolean;
};

export type MonkeyAssetWarmupSession = {
  completion: Promise<void>;
  dispose: () => void;
};

export type StartMonkeyAssetWarmupOptions = {
  artworkSources: Readonly<Record<BabyMonkeyState, string>>;
  createImage?: () => HTMLImageElement;
};

export function shouldSkipMonkeyAssetWarmup(
  signals: MonkeyAssetWarmupSignals = readReducedDataSignals(),
) {
  return Boolean(signals.saveData || signals.prefersReducedData);
}

function readReducedDataSignals(): MonkeyAssetWarmupSignals {
  const connection = (
    navigator as Navigator & { connection?: { saveData?: boolean } }
  ).connection;

  return {
    prefersReducedData:
      window.matchMedia?.('(prefers-reduced-data: reduce)').matches ?? false,
    saveData: connection?.saveData,
  };
}

function beginImageWarmup(
  source: string,
  priority: WarmupPriority,
  createImage: () => HTMLImageElement,
): WarmupResource {
  const image = createImage();
  let finishLoad: (loaded: boolean) => void = () => {};
  const loaded = new Promise<boolean>((resolve) => {
    finishLoad = resolve;
  });

  image.decoding = 'async';
  image.fetchPriority = priority;
  image.onload = () => finishLoad(true);
  image.onerror = () => finishLoad(false);
  image.src = source;

  return {
    cancelLoad: () => finishLoad(false),
    image,
    loaded,
  };
}

export function startMonkeyAssetWarmup({
  artworkSources,
  createImage = () => new window.Image(),
}: StartMonkeyAssetWarmupOptions): MonkeyAssetWarmupSession {
  let active = true;
  let cancelSession: () => void = () => {};
  const cancellation = new Promise<void>((resolve) => {
    cancelSession = resolve;
  });
  const resources: WarmupResource[] = [];

  const begin = (state: BabyMonkeyState, priority: WarmupPriority) => {
    const resource = beginImageWarmup(artworkSources[state], priority, createImage);
    resources.push(resource);
    return resource;
  };

  const warm = async (resource: WarmupResource) => {
    const loaded = await resource.loaded;
    if (!active || !loaded || typeof resource.image.decode !== 'function') return;

    try {
      await Promise.race([resource.image.decode(), cancellation]);
    } catch {
      // Warmup is best effort; the visible image remains the retry path.
    }
  };

  const criticalResources = criticalStates.map((state) =>
    begin(state, 'high'),
  );

  const completion = (async () => {
    for (const resource of criticalResources) {
      await warm(resource);
      if (!active) return;
    }

    for (const state of secondaryStates) {
      if (!active) return;
      await warm(begin(state, 'low'));
    }
  })();

  return {
    completion,
    dispose: () => {
      if (!active) return;

      active = false;
      cancelSession();
      for (const resource of resources) {
        resource.cancelLoad();
        resource.image.onload = null;
        resource.image.onerror = null;
        if (!resource.image.complete) {
          resource.image.removeAttribute('src');
        }
      }
      resources.length = 0;
    },
  };
}
