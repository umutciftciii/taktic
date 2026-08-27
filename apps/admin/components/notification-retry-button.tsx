'use client';

import { useFormStatus } from 'react-dom';
import { retryNotificationAction } from '../app/notifications/actions';

/**
 * The "Yeniden gönder" control.
 *
 * Rendered only where the API says the row is retryable, and it carries no
 * decision of its own: the id is the entire payload, and the API re-checks
 * eligibility before it does anything.
 *
 * The double-submit guard is here rather than in the action because it has to
 * be visible. `useFormStatus` disables the button for the whole life of the
 * submission, so a second click cannot reach the server while the first is in
 * flight; the server's own conditional update is what makes a second click
 * from another tab or another operator harmless.
 */
export function NotificationRetryButton({
  id,
  returnTo,
  size = 'sm',
}: {
  id: string;
  returnTo: string;
  size?: 'sm' | 'md';
}) {
  return (
    <form action={retryNotificationAction} style={{ display: 'inline' }}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <RetrySubmit size={size} />
    </form>
  );
}

function RetrySubmit({ size }: { size: 'sm' | 'md' }) {
  const { pending } = useFormStatus();

  return (
    <button
      className={size === 'sm' ? 'btn btn-secondary btn-sm' : 'btn btn-primary'}
      type="submit"
      disabled={pending}
      aria-disabled={pending}
      data-testid="notification-retry-button"
    >
      {pending ? 'Gönderiliyor…' : 'Yeniden gönder'}
    </button>
  );
}
