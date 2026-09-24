/**
 * What the staff-invite forms show after a press. In its own module because a
 * `'use server'` file may export only async functions.
 *
 * The invite URL is a live credential: whoever opens it sets the account's
 * password. It is returned in the action's state and rendered once. It is not
 * put in a redirect URL, where it would stay in the browser history, in access
 * logs and in the next page's Referer.
 */
export type InviteLinkState =
  | { kind: 'idle' }
  | { kind: 'issued'; inviteUrl: string; expiresAt: string; userId: string }
  | { kind: 'error'; message: string; values?: { name: string; email: string; phone: string } };

export const INVITE_LINK_IDLE: InviteLinkState = { kind: 'idle' };
