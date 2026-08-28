import { cookies } from 'next/headers';
import { apiUrl } from '../api-base';

/**
 * Marks a thread read, from the server, as part of rendering it.
 *
 * The thread screen also marks it read from the browser — that is what clears
 * the badge when a message arrives while the conversation is already open. But
 * relying on the browser alone made "opening a thread" depend on the client
 * component having hydrated: somebody who opened a conversation, read it and
 * navigated away quickly kept the unread badge, and a browser with scripting
 * off never cleared it at all. Opening the page *is* reading it, so the server
 * says so too.
 *
 * Failures are swallowed on purpose. The worst outcome is a badge that stays up
 * until the next visit, and turning that into an error screen would replace a
 * cosmetic problem with a broken conversation. Authorization is unaffected: the
 * API refuses this for anybody who is not a party to the thread, exactly as it
 * refuses the read that produced the page.
 */
export async function markThreadRead(threadId: string): Promise<void> {
  const cookieHeader = (await cookies()).toString();
  if (!cookieHeader || !threadId) {
    return;
  }

  try {
    await fetch(`${apiUrl}/messages/threads/${encodeURIComponent(threadId)}/read`, {
      method: 'POST',
      headers: { cookie: cookieHeader },
      cache: 'no-store',
    });
  } catch {
    // See above.
  }
}
