import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LocalStatePreview } from '@/components/LocalStatePreview';

describe('LocalStatePreview', () => {
  it('restores the state chooser after it is hidden', async () => {
    const user = userEvent.setup();
    render(<LocalStatePreview />);

    await user.click(screen.getByRole('button', { name: 'Hide preview controls' }));
    expect(screen.queryByTestId('local-preview-controls')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show preview controls' }));
    expect(screen.getByTestId('local-preview-controls')).toBeVisible();
    expect(screen.getByText('No notification is sent.')).toBeVisible();
  });

  it('shows a clear inert-development notice and all six states', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<LocalStatePreview />);

    expect(screen.getByText('No notification is sent.')).toBeVisible();
    expect(screen.getByText('Tap the little monkey')).toBeVisible();
    expect(screen.getAllByRole('button', { pressed: false })).toHaveLength(8);

    await user.click(screen.getByRole('button', { name: 'Confirmed' }));
    expect(screen.getByText('Your little monkey was sent.')).toBeVisible();
    expect(screen.getByText('The notification request was accepted.')).toBeVisible();
    expect(fetchSpy).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Cooldown' }));
    expect(screen.getByText('Your little monkey just set off.')).toBeVisible();
    expect(screen.getByText('Another can follow in 15 seconds.')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Ambiguous' }));
    expect(
      screen.getByText('Send a little friend after it, just to be sure.'),
    ).toBeVisible();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('previews all public authentication states without a request', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<LocalStatePreview />);

    await user.click(screen.getByRole('button', { name: 'Auth ready' }));
    expect(screen.getByText(
      'This little corner has just one person in mind.',
    )).toBeVisible();
    expect(screen.getByText('Let’s make sure it’s really you.')).toBeVisible();
    expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Auth ready' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(screen.getByText('Just a moment…')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Verify' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Auth failure' }));
    expect(screen.getByText(
      'That didn’t work. Let’s try again.',
    )).toBeVisible();
    expect(screen.getByRole('button', { name: 'Verify' })).toBeEnabled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses a second monkey tap to reveal the local result without a request', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<LocalStatePreview />);

    await user.click(screen.getByRole('button', { name: 'Ready' }));
    expect(screen.getByText('Tap the little monkey')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Ask the recipient to reach out gently' }));
    expect(screen.getByText('Sending your little monkey…')).toBeVisible();
    expect(screen.getByText('Tap the little monkey again.')).toBeVisible();
    await user.click(screen.getByRole('button', {
      name: 'Reveal whether the little monkey was sent',
    }));
    expect(screen.getByText('Your little monkey was sent.')).toBeVisible();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('opens on the monkey with no note replay action', () => {
    render(<LocalStatePreview />);
    expect(document.querySelector('[data-view="experience"]')).toHaveAttribute('data-state', 'ready');
    expect(document.querySelector('.brand-mark')?.closest('button')).toBeNull();
  });
});
