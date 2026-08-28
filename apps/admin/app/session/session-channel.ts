/**
 * The one-line conversation open tabs of this application have with each other.
 *
 * It carries a single word — "the session is over" — and nothing else. No user
 * id, no session id, no token, no timestamp. A BroadcastChannel is readable by
 * any script on this origin, so the only safe thing to put on it is a fact the
 * tab could work out for itself a moment later anyway.
 *
 * It is an accelerator, never the mechanism. Every tab independently polls the
 * server, which is the authority; this only removes the gap between "somebody
 * signed out in another tab" and the next poll noticing. A browser without
 * BroadcastChannel loses the immediacy and nothing else.
 */

export const SESSION_CHANNEL_NAME = 'taktic-admin-session';

export type SessionChannelMessage = { type: 'ended' };

function openChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') {
    return null;
  }

  try {
    return new BroadcastChannel(SESSION_CHANNEL_NAME);
  } catch {
    return null;
  }
}

/**
 * Set by the tab that made the announcement.
 *
 * A BroadcastChannel does not deliver to the object that posted, but it does
 * deliver to every *other* channel object — including one in the same tab. So
 * the tab that just clicked "çıkış yap" would hear its own announcement and
 * redirect itself to the timed-out login screen instead of following its own
 * logout. This flag is how the announcing tab excuses itself.
 */
let announcedHere = false;

/** Tells every other tab on this origin that the session has ended. */
export function announceSessionEnded(): void {
  announcedHere = true;

  const channel = openChannel();
  if (!channel) {
    return;
  }

  try {
    channel.postMessage({ type: 'ended' } satisfies SessionChannelMessage);
  } finally {
    channel.close();
  }
}

/** Subscribes to the announcement. Returns the unsubscribe. */
export function onSessionEnded(handler: () => void): () => void {
  const channel = openChannel();
  if (!channel) {
    return () => {};
  }

  const listener = (event: MessageEvent) => {
    if (announcedHere) {
      return;
    }

    if ((event.data as SessionChannelMessage | undefined)?.type === 'ended') {
      handler();
    }
  };

  channel.addEventListener('message', listener);

  return () => {
    channel.removeEventListener('message', listener);
    channel.close();
  };
}
