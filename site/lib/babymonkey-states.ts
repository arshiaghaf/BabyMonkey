export const babyMonkeyStates = [
  'ready',
  'pending',
  'confirmed',
  'cooldown',
  'definitiveFailure',
  'ambiguous',
] as const;

export type BabyMonkeyState = (typeof babyMonkeyStates)[number];

export type StatePresentation = {
  title: string;
  titleLines?: readonly string[];
  detail?: string;
  interactionHint?: string;
  imageSrc: string;
  recoveryLabel?: string;
};

const protectedArtworkPrefix = '/__preview-assets/monkey';

export const statePresentations: Record<BabyMonkeyState, StatePresentation> = {
  ready: {
    title: 'No words needed. Send your little monkey.',
    titleLines: [
      'No words needed.',
      'Send your little monkey.',
    ],
    interactionHint: 'Tap the little monkey',
    imageSrc: `${protectedArtworkPrefix}/ready-monkey.png`,
  },
  pending: {
    title: 'Sending your little monkey…',
    detail: 'Tap the little monkey again.',
    imageSrc: `${protectedArtworkPrefix}/pending-monkey.png`,
  },
  confirmed: {
    title: 'Your little monkey was sent.',
    detail: 'The notification request was accepted.',
    imageSrc: `${protectedArtworkPrefix}/confirmed-monkey.png`,
  },
  cooldown: {
    title: 'Your little monkey just set off.',
    detail: 'Another can follow in 15 seconds.',
    imageSrc: `${protectedArtworkPrefix}/cooldown-monkey.png`,
  },
  definitiveFailure: {
    title: 'Your little monkey needs another try.',
    detail: 'Nothing was sent yet.',
    imageSrc: `${protectedArtworkPrefix}/definitive-failure-monkey.png`,
    recoveryLabel: 'Try again',
  },
  ambiguous: {
    title: 'Your little monkey may already be on its way.',
    detail: 'Send a little friend after it, just to be sure.',
    imageSrc: `${protectedArtworkPrefix}/ambiguous-outcome-monkey.png`,
    recoveryLabel: 'Send a little friend',
  },
};
