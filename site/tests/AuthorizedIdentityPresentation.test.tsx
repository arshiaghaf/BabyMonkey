import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  AuthorizedIdentityPresentation,
  type AuthorizedIdentityPresentationProps,
} from '@/components/AuthorizedIdentityPresentation';
import { babyMonkeyStates, statePresentations } from '@/lib/babymonkey-states';
import { confirmedDisplayDurationMs } from '@/lib/presentation-timing';
import { signalCooldownMs } from '@/lib/signal-timing';

const artworkSources = Object.fromEntries(
  babyMonkeyStates.map((state) => [state, statePresentations[state].imageSrc]),
) as AuthorizedIdentityPresentationProps['artworkSources'];

const baseProps = {
  artworkSources,
  brandImageSrc: '/mark.png',
  labels: {
    signOut: 'Sign out',
    primaryAction: 'Ask the recipient to reach out gently',
    revealResult: 'Reveal whether the little monkey was sent',
  },
  presentations: statePresentations,
} satisfies Omit<AuthorizedIdentityPresentationProps, 'initialInteraction'>;

describe('authorized interaction host', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
  });

  it.each([
    ['confirmed', 'Your little monkey was sent.'],
    ['definitive-failure', 'Your little monkey needs another try.'],
    ['ambiguous', 'Your little monkey may already be on its way.'],
  ] as const)('keeps %s pending until a display-only reveal', async (state, expectedCopy) => {
    const user = userEvent.setup();
    const request = vi.spyOn(globalThis, 'fetch');
    render(
      <AuthorizedIdentityPresentation
        {...baseProps}
        initialInteraction={{
          available: true,
          state,
          retryAfterMs: signalCooldownMs,
          version: 'd'.repeat(64),
        }}
      />,
    );
    expect(screen.getByText('Sending your little monkey…')).toBeVisible();
    await user.click(screen.getByRole('button', {
      name: 'Reveal whether the little monkey was sent',
    }));
    expect(screen.getByText(expectedCopy)).toBeVisible();
    expect(request).not.toHaveBeenCalled();
  });

  it('uses a distinct opaque attempt for a deliberate definitive retry', async () => {
    const user = userEvent.setup();
    vi.spyOn(document, 'cookie', 'get').mockReturnValue(
      `__Host-bm-csrf=${'a'.repeat(43)}`,
    );
    const request = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        state: 'definitive-failure', retryAfterMs: 0,
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-bm-signal-version': 'b'.repeat(64),
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        state: 'definitive-failure', retryAfterMs: 0,
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-bm-signal-version': 'c'.repeat(64),
        },
      }));
    render(
      <AuthorizedIdentityPresentation
        {...baseProps}
        initialInteraction={{ available: true, state: 'ready', version: null }}
      />,
    );
    await user.click(screen.getByRole('button', {
      name: 'Ask the recipient to reach out gently',
    }));
    expect(screen.getByText('Sending your little monkey…')).toBeVisible();
    await user.click(screen.getByRole('button', {
      name: 'Reveal whether the little monkey was sent',
    }));
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(request).toHaveBeenCalledTimes(2);
    const bodies = request.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(Object.keys(bodies[0])).toEqual(['attempt']);
    expect(bodies[0].attempt).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(bodies[1].attempt).not.toBe(bodies[0].attempt);
    expect(new Headers(request.mock.calls[0][1]?.headers).get('x-bm-signal-version'))
      .toBe('none');
    expect(new Headers(request.mock.calls[1][1]?.headers).get('x-bm-signal-version'))
      .toBe('b'.repeat(64));
  });

  it('reconciles a pending response-loss replay with the same opaque attempt', async () => {
    const user = userEvent.setup();
    vi.spyOn(document, 'cookie', 'get').mockReturnValue(
      `__Host-bm-csrf=${'a'.repeat(43)}`,
    );
    const request = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('response lost'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        state: 'pending', retryAfterMs: 1,
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-bm-signal-version': 'b'.repeat(64),
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        state: 'confirmed', retryAfterMs: signalCooldownMs,
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-bm-signal-version': 'b'.repeat(64),
        },
      }));
    render(
      <AuthorizedIdentityPresentation
        {...baseProps}
        initialInteraction={{ available: true, state: 'ready', version: null }}
      />,
    );
    await user.click(screen.getByRole('button', {
      name: 'Ask the recipient to reach out gently',
    }));

    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    const bodies = request.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(new Set(bodies.map((body) => body.attempt)).size).toBe(1);
    expect(request.mock.calls.every(([, init]) => (
      new Headers(init?.headers).get('x-bm-signal-version') === 'none'
    ))).toBe(true);
    expect(screen.getByText('Sending your little monkey…')).toBeVisible();
    expect(screen.getByRole('button', {
      name: 'Reveal whether the little monkey was sent',
    })).toBeEnabled();
    await user.click(screen.getByRole('button', {
      name: 'Reveal whether the little monkey was sent',
    }));
    expect(screen.getByText('Your little monkey was sent.')).toBeVisible();
  });

  it('holds confirmed for 20 seconds from reveal under reduced motion without another request', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const request = vi.spyOn(globalThis, 'fetch');
    render(
      <AuthorizedIdentityPresentation
        {...baseProps}
        initialInteraction={{
          available: true,
          state: 'confirmed',
          retryAfterMs: signalCooldownMs,
          version: 'd'.repeat(64),
        }}
      />,
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    fireEvent.click(screen.getByRole('button', {
      name: 'Reveal whether the little monkey was sent',
    }));
    expect(screen.getByText('Your little monkey was sent.')).toBeVisible();
    expect(screen.getByRole('button', {
      name: 'Ask the recipient to reach out gently',
    })).toBeDisabled();
    expect(request).not.toHaveBeenCalled();
    expect(signalCooldownMs).toBe(15_000);
    expect(confirmedDisplayDurationMs).toBe(20_000);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(confirmedDisplayDurationMs - 1);
    });
    expect(screen.getByText('Your little monkey was sent.')).toBeVisible();
    expect(screen.getByRole('button', {
      name: 'Ask the recipient to reach out gently',
    })).toBeDisabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByRole('heading', {
      name: 'No words needed. Send your little monkey.',
    })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Ask the recipient to reach out gently' }))
      .toBeEnabled();
    expect(request).not.toHaveBeenCalled();
  });

  it('lets a fresh ready server render bypass an unexpired UI-only hold', async () => {
    vi.useFakeTimers();
    const firstRender = render(
      <AuthorizedIdentityPresentation
        {...baseProps}
        initialInteraction={{
          available: true,
          state: 'confirmed',
          retryAfterMs: signalCooldownMs,
          version: 'd'.repeat(64),
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', {
      name: 'Reveal whether the little monkey was sent',
    }));
    await act(async () => { await vi.advanceTimersByTimeAsync(signalCooldownMs); });
    expect(screen.getByText('Your little monkey was sent.')).toBeVisible();

    firstRender.unmount();
    render(
      <AuthorizedIdentityPresentation
        {...baseProps}
        initialInteraction={{ available: true, state: 'ready', version: null }}
      />,
    );
    expect(screen.getByRole('button', { name: 'Ask the recipient to reach out gently' }))
      .toBeEnabled();
  });

  it('keeps a refreshed confirmed server snapshot behind display-only reveal', async () => {
    vi.useFakeTimers();
    render(
      <AuthorizedIdentityPresentation
        {...baseProps}
        initialInteraction={{
          available: true,
          state: 'confirmed',
          retryAfterMs: 1_000,
          version: 'd'.repeat(64),
        }}
      />,
    );
    expect(screen.getByText('Sending your little monkey…')).toBeVisible();
    expect(screen.getByRole('button', {
      name: 'Reveal whether the little monkey was sent',
    })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', {
      name: 'Reveal whether the little monkey was sent',
    }));
    expect(screen.getByText('Your little monkey was sent.')).toBeVisible();
    expect(screen.getByRole('button', {
      name: 'Ask the recipient to reach out gently',
    })).toBeDisabled();
  });

  it('returns a cooldown response to ready at the authoritative deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    vi.spyOn(document, 'cookie', 'get').mockReturnValue(
      `__Host-bm-csrf=${'a'.repeat(43)}`,
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      state: 'cooldown', retryAfterMs: 1_000,
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-bm-signal-version': 'b'.repeat(64),
      },
    }));
    render(
      <AuthorizedIdentityPresentation
        {...baseProps}
        initialInteraction={{ available: true, state: 'ready', version: null }}
      />,
    );
    fireEvent.click(screen.getByRole('button', {
      name: 'Ask the recipient to reach out gently',
    }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('Your little monkey just set off.')).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(999); });
    expect(screen.getByText('Your little monkey just set off.')).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByRole('button', { name: 'Ask the recipient to reach out gently' }))
      .toBeEnabled();
  });

  it('schedules authoritative recovery for a refreshed pending render', () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(window, 'setTimeout');
    render(
      <AuthorizedIdentityPresentation
        {...baseProps}
        initialInteraction={{
          available: true,
          state: 'pending',
          retryAfterMs: 4_321,
          version: 'd'.repeat(64),
        }}
      />,
    );
    expect(timeout).toHaveBeenCalledWith(expect.any(Function), 4_321);
  });

  it('keeps ambiguous retry disabled until the full server cooldown elapses', async () => {
    vi.useFakeTimers();
    render(
      <AuthorizedIdentityPresentation
        {...baseProps}
        initialInteraction={{
          available: true,
          state: 'ambiguous',
          retryAfterMs: signalCooldownMs,
          version: 'd'.repeat(64),
        }}
      />,
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(signalCooldownMs - 1); });
    fireEvent.click(screen.getByRole('button', {
      name: 'Reveal whether the little monkey was sent',
    }));
    expect(screen.getByRole('button', { name: 'Send a little friend' })).toBeDisabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByRole('button', { name: 'Send a little friend' })).toBeEnabled();
  });
});
