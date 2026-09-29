import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PublicAuthShell } from '@/components/PublicAuthShell';

describe('PublicAuthShell', () => {
  it('renders the exact ready copy and invokes only the authentication callback', async () => {
    const user = userEvent.setup();
    const onAuthenticate = vi.fn();
    render(<PublicAuthShell onAuthenticate={onAuthenticate} state="ready" />);

    expect(screen.getByRole('heading', {
      name: 'This little corner has just one person in mind.',
    })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Let’s make sure it’s really you.',
    );

    const action = screen.getByRole('button', { name: 'Verify' });
    expect(action).toBeEnabled();
    await user.click(action);
    expect(onAuthenticate).toHaveBeenCalledTimes(1);
  });

  it('remains inert and accessibly unavailable without a callback', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<PublicAuthShell state="ready" />);

    const action = screen.getByRole('button', { name: 'Verify' });
    expect(action).toBeDisabled();
    expect(action).toHaveAccessibleDescription('Continue is not available yet.');
    await user.click(action);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('announces working state politely and disables repeated activation', async () => {
    const user = userEvent.setup();
    const onAuthenticate = vi.fn();
    render(<PublicAuthShell onAuthenticate={onAuthenticate} state="working" />);

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveAttribute('aria-atomic', 'true');
    expect(status).toHaveTextContent('Just a moment…');

    const action = screen.getByRole('button', { name: 'Verify' });
    expect(action).toBeDisabled();
    expect(action).toHaveAttribute('aria-busy', 'true');
    await user.click(action);
    expect(onAuthenticate).not.toHaveBeenCalled();
  });

  it('keeps the polite live region mounted when presentation state changes', () => {
    const onAuthenticate = vi.fn();
    const { rerender } = render(
      <PublicAuthShell onAuthenticate={onAuthenticate} state="ready" />,
    );
    const status = screen.getByRole('status');

    rerender(
      <PublicAuthShell onAuthenticate={onAuthenticate} state="working" />,
    );

    expect(screen.getByRole('status')).toBe(status);
    expect(status).toHaveTextContent('Just a moment…');
  });

  it('offers the same accessible action after a recoverable failure', async () => {
    const user = userEvent.setup();
    const onAuthenticate = vi.fn();
    render(
      <PublicAuthShell
        onAuthenticate={onAuthenticate}
        state="recoverableFailure"
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent(
      'That didn’t work. Let’s try again.',
    );
    const action = screen.getByRole('button', { name: 'Verify' });
    expect(action).toBeEnabled();
    await user.click(action);
    expect(onAuthenticate).toHaveBeenCalledTimes(1);
  });

  it('uses native keyboard activation without moving focus', async () => {
    const user = userEvent.setup();
    const onAuthenticate = vi.fn();
    render(<PublicAuthShell onAuthenticate={onAuthenticate} state="ready" />);

    const action = screen.getByRole('button', { name: 'Verify' });
    await user.tab();
    expect(action).toHaveFocus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onAuthenticate).toHaveBeenCalledTimes(2);
    expect(action).toHaveFocus();
  });
});
