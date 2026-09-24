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
    <div style={{ marginTop: 12 }}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
        {intro}
      </div>
      <code
        data-testid="admin-invite-url"
        style={{
          display: 'block',
          padding: 10,
          background: 'var(--surface-soft, #f3f4f6)',
          border: '1px solid var(--border, #e5e7eb)',
          borderRadius: 8,
          fontSize: 12,
          lineHeight: 1.5,
          wordBreak: 'break-all',
        }}
      >
        {inviteUrl}
      </code>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        Son geçerlilik: {formatDateTime(expiresAt)}
      </div>
    </div>
  );
}

export function InviteLinkError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      style={{
        marginTop: 12,
        padding: 10,
        borderRadius: 8,
        background: 'rgba(220, 38, 38, 0.08)',
        border: '1px solid rgba(220, 38, 38, 0.25)',
        color: 'rgb(153, 27, 27)',
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      {message}
    </div>
  );
}
