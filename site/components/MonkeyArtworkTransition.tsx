'use client';

import Image from 'next/image';
import { useEffect, useState } from 'react';
import type { BabyMonkeyState } from '@/lib/babymonkey-states';
import styles from './MonkeyArtworkTransition.module.css';

const ARTWORK_TRANSITION_DURATION_MS = 200;

export type MonkeyArtworkTransitionProps = {
  artworkSources: Readonly<Record<BabyMonkeyState, string>>;
  state: BabyMonkeyState;
};

function MonkeyArtwork({
  layer,
  source,
  state,
}: {
  layer: 'current' | 'departing';
  source: string;
  state: BabyMonkeyState;
}) {
  return (
    <Image
      alt=""
      className={`monkey-artwork ${styles.layer} ${styles[layer]}`}
      data-artwork-layer={layer}
      data-artwork-state={state}
      height={1024}
      priority={layer === 'current'}
      sizes="(min-width: 768px) 320px, min(72vw, 320px)"
      src={source}
      unoptimized
      width={1024}
    />
  );
}

export function MonkeyArtworkTransition({
  artworkSources,
  state,
}: MonkeyArtworkTransitionProps) {
  const [layers, setLayers] = useState<{
    current: BabyMonkeyState;
    departing: BabyMonkeyState | null;
  }>({ current: state, departing: null });

  if (layers.current !== state) {
    setLayers({ current: state, departing: layers.current });
  }

  useEffect(() => {
    if (!layers.departing) return;

    const completionTimer = window.setTimeout(
      () => {
        setLayers((currentLayers) =>
          currentLayers.departing === layers.departing
            ? { ...currentLayers, departing: null }
            : currentLayers,
        );
      },
      ARTWORK_TRANSITION_DURATION_MS,
    );

    return () => window.clearTimeout(completionTimer);
  }, [layers.departing]);

  const isTransitioning =
    layers.departing !== null && layers.departing !== layers.current;

  return (
    <span
      className={`${styles.stack}${isTransitioning ? ` ${styles.transitioning}` : ''}`}
    >
      {layers.departing && layers.departing !== layers.current ? (
        <MonkeyArtwork
          layer="departing"
          source={artworkSources[layers.departing]}
          state={layers.departing}
        />
      ) : null}
      <MonkeyArtwork
        layer="current"
        source={artworkSources[layers.current]}
        state={layers.current}
      />
    </span>
  );
}
