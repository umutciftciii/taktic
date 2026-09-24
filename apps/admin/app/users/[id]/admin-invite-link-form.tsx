'use client';

import { useActionState } from 'react';
import { createAdminInviteLinkAction } from '../actions';
import { INVITE_LINK_IDLE } from '../invite-link-state';
import { InviteLinkError, InviteLinkPanel } from '../invite-link-panel';

/**
 * Mints a new password-set link for a staff account that has none yet.
 *
 * The link comes back in this form's action state and is shown once (see
 * invite-link-state). It works without JavaScript too: `useActionState`
 * forms submit normally and React renders the returned state on the server.
 */
export function AdminInviteLinkForm({ userId }: { userId: string }) {
  const [state, submit, pending] = useActionState(createAdminInviteLinkAction, INVITE_LINK_IDLE);

  return (
    <>
      <form action={submit}>
        <input type="hidden" name="userId" value={userId} />
        <button type="submit" className="btn btn-primary btn-sm" disabled={pending}>
          Davet linki oluştur
        </button>
      </form>
      {state.kind === 'error' ? <InviteLinkError message={state.message} /> : null}
      {state.kind === 'issued' ? (
        <InviteLinkPanel
          inviteUrl={state.inviteUrl}
          expiresAt={state.expiresAt}
          intro="Davet bağlantısı oluşturuldu. Bu bağlantı 72 saat geçerlidir."
        />
      ) : null}
    </>
  );
}
