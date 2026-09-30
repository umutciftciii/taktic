'use client';

import { formatDateTime } from '@taktic/shared';

/** The once-shown invite link, as both staff-invite forms render it. */
export function InviteLinkPanel({
  inviteUrl,
  expiresAt,
  intro,
}: {
  inviteUrl: string;
  expiresAt: string;
  intro: string;
}) {
  return (
    <div className="invite-link-panel">
      <div className="invite-link-note">{intro}</div>
      <code className="invite-link-url" data-testid="admin-invite-url">
        {inviteUrl}
      </code>
      <div className="invite-link-note">Son geçerlilik: {formatDateTime(expiresAt)}</div>
    </div>
  );
}

export function InviteLinkError({ message }: { message: string }) {
  return (
    <div className="notice notice-error invite-link-error" role="alert">
      {message}
    </div>
  );
}
