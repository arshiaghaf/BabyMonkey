import 'server-only';

export const protectedAssetFiles = {
  '6xP9jFbD2mQvL7aWrN4tYsHkC8eZuG1o': 'ready-monkey.png',
  'cR5uX1nK8pAeM3vHtQ7sZyD9wL2bGjFo': 'pending-monkey.png',
  'mT8qV3aLsD1yK6nWpR9cXeF4uH7zBjGo': 'confirmed-monkey.png',
  'wN2dH7pZ4rK9sMfC1xQaV6uLtG8yEjBo': 'cooldown-monkey.png',
  'aK7vQ2eFmR9xL4sUwD1nY6pHtC8zGjBo': 'definitive-failure-monkey.png',
  'zF4mL9qX2tV7cDsR1nH8wKaU6pYeGjBo': 'ambiguous-outcome-monkey.png',
  'hD9sW3nQ6kX1vLaR8tF2mYpC7uZeGjBo': 'ready-monkey-head.png',
} as const;

export type ProtectedAssetId = keyof typeof protectedAssetFiles;

const mediaUrl = (assetId: ProtectedAssetId) => `/media/${assetId}`;

export const protectedPresentation = {
  brandImageSrc: mediaUrl('hD9sW3nQ6kX1vLaR8tF2mYpC7uZeGjBo'),
  labels: {
    signOut: 'Sign out',
    primaryAction: 'Ask the recipient to reach out gently',
    revealResult: 'Reveal whether the little monkey was sent',
  },
  artworkSources: {
    ready: mediaUrl('6xP9jFbD2mQvL7aWrN4tYsHkC8eZuG1o'),
    pending: mediaUrl('cR5uX1nK8pAeM3vHtQ7sZyD9wL2bGjFo'),
    confirmed: mediaUrl('mT8qV3aLsD1yK6nWpR9cXeF4uH7zBjGo'),
    cooldown: mediaUrl('wN2dH7pZ4rK9sMfC1xQaV6uLtG8yEjBo'),
    definitiveFailure: mediaUrl('aK7vQ2eFmR9xL4sUwD1nY6pHtC8zGjBo'),
    ambiguous: mediaUrl('zF4mL9qX2tV7cDsR1nH8wKaU6pYeGjBo'),
  },
  presentations: {
    ready: {
      title: 'No words needed. Send your little monkey.',
      titleLines: ['No words needed.', 'Send your little monkey.'],
      interactionHint: 'Tap the little monkey',
      imageSrc: mediaUrl('6xP9jFbD2mQvL7aWrN4tYsHkC8eZuG1o'),
    },
    pending: {
      title: 'Sending your little monkey…',
      detail: 'Tap the little monkey again.',
      imageSrc: mediaUrl('cR5uX1nK8pAeM3vHtQ7sZyD9wL2bGjFo'),
    },
    confirmed: {
      title: 'Your little monkey was sent.',
      detail: 'The notification request was accepted.',
      imageSrc: mediaUrl('mT8qV3aLsD1yK6nWpR9cXeF4uH7zBjGo'),
    },
    cooldown: {
      title: 'Your little monkey just set off.',
      detail: 'Another can follow in 15 seconds.',
      imageSrc: mediaUrl('wN2dH7pZ4rK9sMfC1xQaV6uLtG8yEjBo'),
    },
    definitiveFailure: {
      title: 'Your little monkey needs another try.',
      detail: 'Nothing was sent yet.',
      imageSrc: mediaUrl('aK7vQ2eFmR9xL4sUwD1nY6pHtC8zGjBo'),
      recoveryLabel: 'Try again',
    },
    ambiguous: {
      title: 'Your little monkey may already be on its way.',
      detail: 'Send a little friend after it, just to be sure.',
      imageSrc: mediaUrl('zF4mL9qX2tV7cDsR1nH8wKaU6pYeGjBo'),
      recoveryLabel: 'Send a little friend',
    },
  },
} as const;

export function isProtectedAssetId(value: string): value is ProtectedAssetId {
  return Object.hasOwn(protectedAssetFiles, value);
}
