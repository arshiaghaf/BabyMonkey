import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  BabyMonkeyExperience,
  type BabyMonkeyExperienceProps,
} from '@/components/BabyMonkeyExperience';
import { babyMonkeyStates, statePresentations } from '@/lib/babymonkey-states';

const artworkSources = Object.fromEntries(
  babyMonkeyStates.map((state) => [state, statePresentations[state].imageSrc]),
) as Record<(typeof babyMonkeyStates)[number], string>;
const labels = {
  primaryAction: 'Ask the recipient to reach out gently',
  revealResult: 'Reveal whether the little monkey was sent',
  signOut: 'Sign out',
};
type TestExperienceProps = Omit<
  BabyMonkeyExperienceProps,
  'artworkSources' | 'brandImageSrc' | 'labels' | 'presentation'
>;
function TestExperience(props: TestExperienceProps) {
  return (
    <BabyMonkeyExperience
      {...props}
      artworkSources={artworkSources}
      brandImageSrc="/__preview-assets/monkey/ready-monkey-head.png"
      labels={labels}
      presentation={statePresentations[props.state]}
    />
  );
}

describe('BabyMonkeyExperience', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders one named image button with a decorative child image', () => {
    render(<TestExperience onSignal={() => undefined} state="ready" />);

    const button = screen.getByRole('button', {
      name: 'Ask the recipient to reach out gently',
    });
    expect(button).toBeEnabled();
    expect(screen.getAllByRole('button', { hidden: true })).toHaveLength(2);
    expect(button.querySelector('img')).toHaveAttribute('alt', '');
    expect(screen.getByRole('heading', {
      name: 'No words needed. Send your little monkey.',
    })).toBeVisible();
    expect(
      screen.getByText('Send your little monkey.').closest('h1'),
    ).not.toBeNull();
    expect(screen.getByText('Tap the little monkey')).toBeVisible();
  });

  it('invokes the one signal callback once per deliberate activation', async () => {
    const user = userEvent.setup();
    const onSignal = vi.fn();
    render(<TestExperience onSignal={onSignal} state="ready" />);

    await user.click(screen.getByRole('button', { name: 'Ask the recipient to reach out gently' }));

    expect(onSignal).toHaveBeenCalledTimes(1);
  });

  it('keeps the header mark decorative with no replay action', () => {
    render(<TestExperience onSignal={() => undefined} state="ready" />);
    expect(document.querySelector('.brand-mark')).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  it('supports keyboard activation through the native image button', async () => {
    const user = userEvent.setup();
    const onSignal = vi.fn();
    render(<TestExperience onSignal={onSignal} state="ready" />);

    await user.tab();
    expect(screen.getByRole('button', {
      name: 'Ask the recipient to reach out gently',
    })).toHaveFocus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');

    expect(onSignal).toHaveBeenCalledTimes(2);
  });

  it.each(['pending', 'cooldown'] as const)('prevents activation while %s has no available action', async (state) => {
    const user = userEvent.setup();
    const onSignal = vi.fn();
    render(<TestExperience onSignal={onSignal} state={state} />);

    const button = screen.getByRole('button', {
      name: 'Ask the recipient to reach out gently',
    });
    expect(button).toBeDisabled();
    if (state === 'pending') {
      expect(
        screen.queryByText('Tap the little monkey again.'),
      ).not.toBeInTheDocument();
    }
    await user.click(button);
    await user.click(button);
    expect(onSignal).not.toHaveBeenCalled();
  });

  it('reveals an available pending result without invoking the signal callback', async () => {
    const user = userEvent.setup();
    const onSignal = vi.fn();
    const onRevealResult = vi.fn();
    const { rerender } = render(
      <TestExperience onSignal={onSignal} state="pending" />,
    );

    expect(
      screen.queryByText('Tap the little monkey again.'),
    ).not.toBeInTheDocument();

    rerender(
      <TestExperience
        onRevealResult={onRevealResult}
        onSignal={onSignal}
        state="pending"
      />,
    );

    const button = screen.getByRole('button', {
      name: 'Reveal whether the little monkey was sent',
    });
    expect(button).toBeEnabled();
    expect(button.querySelector('img')).toHaveAttribute('alt', '');
    const revealInstruction = screen.getByText('Tap the little monkey again.');
    expect(revealInstruction).toBeVisible();
    expect(revealInstruction).toHaveClass('pending-result-hint');
    expect(revealInstruction.closest('.state-message')).not.toBeNull();
    expect(revealInstruction.closest('.recovery-slot')).toBeNull();

    await user.click(button);

    expect(onRevealResult).toHaveBeenCalledTimes(1);
    expect(onSignal).not.toHaveBeenCalled();
  });

  it('keeps definitive and ambiguous recovery copy distinct', () => {
    const { rerender } = render(
      <TestExperience onRetry={() => undefined} state="definitiveFailure" />,
    );
    expect(screen.getByText('Nothing was sent yet.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Try again' })).toHaveClass(
      'recovery-control',
      { exact: true },
    );

    rerender(
      <TestExperience onRetryAmbiguous={() => undefined} state="ambiguous" />,
    );
    expect(
      screen.getByText('Send a little friend after it, just to be sure.'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Send a little friend' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Send a little friend' })).toHaveClass(
      'recovery-control',
      { exact: true },
    );
  });

  it.each([
    ['definitiveFailure', 'Try again'],
    ['ambiguous', 'Send a little friend'],
  ] as const)('disables %s recovery when its callback is unavailable', (state, label) => {
    render(<TestExperience state={state} />);

    expect(screen.getByRole('button', { name: label })).toBeDisabled();
  });

  it('routes recovery through the state-specific callback only', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const onRetryAmbiguous = vi.fn();
    const { rerender } = render(
      <TestExperience onRetry={onRetry} state="definitiveFailure" />,
    );

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetryAmbiguous).not.toHaveBeenCalled();

    rerender(
      <TestExperience
        onRetryAmbiguous={onRetryAmbiguous}
        state="ambiguous"
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Send a little friend' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetryAmbiguous).toHaveBeenCalledTimes(1);
  });

  it('keeps only current and departing artwork during a state crossfade', async () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <TestExperience onSignal={() => undefined} state="ready" />,
    );

    expect(document.querySelector('[data-artwork-layer="current"]')).toHaveAttribute(
      'data-artwork-state',
      'ready',
    );
    expect(document.querySelector('[data-artwork-layer="departing"]')).toBeNull();

    rerender(<TestExperience state="pending" />);

    expect(document.querySelector('[data-artwork-layer="current"]')).toHaveAttribute(
      'data-artwork-state',
      'pending',
    );
    expect(document.querySelector('[data-artwork-layer="departing"]')).toHaveAttribute(
      'data-artwork-state',
      'ready',
    );
    expect(document.querySelectorAll('.monkey-artwork')).toHaveLength(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(document.querySelector('[data-artwork-layer="departing"]')).toBeNull();
    expect(document.querySelectorAll('.monkey-artwork')).toHaveLength(1);
  });

  it('uses a polite atomic live region without moving focus', async () => {
    const user = userEvent.setup();
    const onSignal = vi.fn();
    const { rerender } = render(
      <TestExperience onSignal={onSignal} state="ready" />,
    );
    const button = screen.getByRole('button', {
      name: 'Ask the recipient to reach out gently',
    });
    await user.tab();
    expect(button).toHaveFocus();

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveAttribute('aria-atomic', 'true');

    rerender(<TestExperience onSignal={onSignal} state="pending" />);
    expect(document.body).not.toHaveFocus();
    expect(screen.getByText('Sending your little monkey…')).toBeVisible();
  });
});
