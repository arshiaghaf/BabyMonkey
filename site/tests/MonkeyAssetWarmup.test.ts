import {
  shouldSkipMonkeyAssetWarmup,
  startMonkeyAssetWarmup,
} from '@/lib/monkey-asset-warmup';
import { babyMonkeyStates, statePresentations } from '@/lib/babymonkey-states';

const artworkSources = Object.fromEntries(
  babyMonkeyStates.map((state) => [state, statePresentations[state].imageSrc]),
) as Record<(typeof babyMonkeyStates)[number], string>;

type FakeImage = {
  complete: boolean;
  decode: ReturnType<typeof vi.fn>;
  decoding: string;
  fetchPriority: string;
  onerror: ((event: Event) => void) | null;
  onload: ((event: Event) => void) | null;
  removeAttribute: ReturnType<typeof vi.fn>;
  src: string;
};

function createImageFactory({
  autoLoad = true,
  decodeFailures = new Set<string>(),
  events,
  loadFailures = new Set<string>(),
}: {
  autoLoad?: boolean;
  decodeFailures?: Set<string>;
  events: string[];
  loadFailures?: Set<string>;
}) {
  const images: FakeImage[] = [];

  const createImage = () => {
    let source = '';
    const image: FakeImage = {
      complete: false,
      decode: vi.fn(async () => {
        events.push(`decode:${source}`);
        if (decodeFailures.has(source)) throw new Error('decode failed');
      }),
      decoding: 'auto',
      fetchPriority: 'auto',
      onerror: null,
      onload: null,
      removeAttribute: vi.fn(),
      get src() {
        return source;
      },
      set src(value: string) {
        source = value;
        events.push(`start:${value}`);
        if (!autoLoad) return;

        queueMicrotask(() => {
          image.complete = true;
          if (loadFailures.has(value)) {
            image.onerror?.(new Event('error'));
          } else {
            image.onload?.(new Event('load'));
          }
        });
      },
    };
    images.push(image);
    return image as unknown as HTMLImageElement;
  };

  return { createImage, images };
}

describe('monkey asset warmup', () => {
  it('starts ready and pending together, then warms the rest serially', async () => {
    const events: string[] = [];
    const { createImage, images } = createImageFactory({ events });
    const session = startMonkeyAssetWarmup({ artworkSources, createImage });

    await session.completion;

    expect(events).toEqual([
      'start:/__preview-assets/monkey/ready-monkey.png',
      'start:/__preview-assets/monkey/pending-monkey.png',
      'decode:/__preview-assets/monkey/ready-monkey.png',
      'decode:/__preview-assets/monkey/pending-monkey.png',
      'start:/__preview-assets/monkey/confirmed-monkey.png',
      'decode:/__preview-assets/monkey/confirmed-monkey.png',
      'start:/__preview-assets/monkey/cooldown-monkey.png',
      'decode:/__preview-assets/monkey/cooldown-monkey.png',
      'start:/__preview-assets/monkey/definitive-failure-monkey.png',
      'decode:/__preview-assets/monkey/definitive-failure-monkey.png',
      'start:/__preview-assets/monkey/ambiguous-outcome-monkey.png',
      'decode:/__preview-assets/monkey/ambiguous-outcome-monkey.png',
    ]);
    expect(images.map((image) => image.fetchPriority)).toEqual([
      'high',
      'high',
      'low',
      'low',
      'low',
      'low',
    ]);
  });

  it('continues after individual load and decode failures', async () => {
    const events: string[] = [];
    const { createImage } = createImageFactory({
      decodeFailures: new Set(['/__preview-assets/monkey/cooldown-monkey.png']),
      events,
      loadFailures: new Set(['/__preview-assets/monkey/confirmed-monkey.png']),
    });
    const session = startMonkeyAssetWarmup({ artworkSources, createImage });

    await session.completion;

    expect(events).toContain('start:/__preview-assets/monkey/ambiguous-outcome-monkey.png');
    expect(events).not.toContain('decode:/__preview-assets/monkey/confirmed-monkey.png');
    expect(events).toContain('decode:/__preview-assets/monkey/cooldown-monkey.png');
  });

  it('recognizes either reduced-data signal', () => {
    expect(shouldSkipMonkeyAssetWarmup({ saveData: true })).toBe(true);
    expect(
      shouldSkipMonkeyAssetWarmup({ prefersReducedData: true }),
    ).toBe(true);
    expect(shouldSkipMonkeyAssetWarmup({})).toBe(false);
  });

  it('cancels unfinished loads and releases retained images on dispose', async () => {
    const events: string[] = [];
    const { createImage, images } = createImageFactory({
      autoLoad: false,
      events,
    });
    const session = startMonkeyAssetWarmup({ artworkSources, createImage });

    session.dispose();
    await session.completion;

    expect(images).toHaveLength(2);
    expect(images.every((image) => image.removeAttribute.mock.calls.length === 1)).toBe(
      true,
    );
  });
});
