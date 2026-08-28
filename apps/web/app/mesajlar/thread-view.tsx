'use client';

import { useActionState, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MessagePage, MessageSenderRole, ThreadMessage } from '../../lib/api';
import { sendMessageAction, type SendMessageState } from './actions';

/**
 * A conversation, live enough.
 *
 * There is no socket and no server-sent stream in this version, on purpose: two
 * people arranging a job exchange a handful of messages, and a poll while the
 * thread is actually on screen carries them at a cost nobody can measure. What
 * the poll must not do is run when nobody is looking — a backgrounded tab is
 * somebody who left, and polling them is a cost with no reader.
 *
 * The composer is a plain form posting a server action, so this component is an
 * enhancement rather than a requirement: with scripting off the send still
 * works and the page re-renders with the message on it.
 */

const POLL_INTERVAL_MS = 10_000;

const MESSAGE_MAX_LENGTH = 2000;

type ThreadViewProps = {
  threadId: string;
  viewerRole: MessageSenderRole;
  counterpartName: string;
  initialMessages: ThreadMessage[];
  initialCursor: string | null;
  /** Whether the counterpart has seen everything, as the server last said. */
  counterpartHasRead: boolean;
};

export function ThreadView({
  threadId,
  viewerRole,
  counterpartName,
  initialMessages,
  initialCursor,
  counterpartHasRead,
}: ThreadViewProps) {
  const [messages, setMessages] = useState<ThreadMessage[]>(initialMessages);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [state, formAction, pending] = useActionState<SendMessageState, FormData>(
    sendMessageAction,
    { status: 'idle' },
  );

  const formRef = useRef<HTMLFormElement | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);
  const [draft, setDraft] = useState('');

  /**
   * Timestamps are rendered only after mount.
   *
   * The server runs in UTC and the reader does not, so formatting a time during
   * SSR produces markup the first client render disagrees with — a hydration
   * mismatch this application has already shipped once. The machine-readable
   * value is in `<time dateTime>` from the first byte either way.
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  /**
   * One idempotency key per composed message, regenerated only once a send has
   * succeeded. That is what makes the double-click and the retried submission
   * land as one message: both carry this value, and the server keeps the first.
   */
  const [clientToken, setClientToken] = useState(() => newToken());

  /** Everything written since the last message this tab knows about. */
  const poll = useCallback(async () => {
    const params = cursor ? `?after=${encodeURIComponent(cursor)}` : '';

    let response: Response;
    try {
      response = await fetch(`/api/messages/${encodeURIComponent(threadId)}${params}`, {
        cache: 'no-store',
      });
    } catch {
      setRefreshFailed(true);
      return;
    }

    if (!response.ok) {
      // Including 404 and 403: the conversation may have closed under the
      // viewer. Saying "could not refresh" rather than emptying the screen is
      // the honest version — what is already on the page really was said.
      setRefreshFailed(true);
      return;
    }

    setRefreshFailed(false);
    const page = (await response.json()) as MessagePage;
    if (page.messages.length === 0) {
      return;
    }

    setMessages((current) => mergeMessages(current, page.messages));
    setCursor(page.latestCursor ?? cursor);
    void markRead(threadId);
  }, [cursor, threadId]);

  // ---- polling, only while somebody is looking ----------------------------
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void poll();
      }
    }, POLL_INTERVAL_MS);

    // Returning to the tab is when its picture is most likely stale, so it
    // catches up immediately instead of waiting out the interval.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void poll();
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [poll]);

  // ---- opening the thread is reading it -----------------------------------
  useEffect(() => {
    void markRead(threadId);
  }, [threadId]);

  // ---- after a send -------------------------------------------------------
  useEffect(() => {
    if (state.status === 'sent') {
      setDraft('');
      setClientToken(newToken());
      formRef.current?.reset();
      void poll();
    }

    if (state.status === 'error' && typeof state.draft === 'string') {
      // A refused send must not also destroy what was typed. The same token is
      // kept, so pressing send again is a retry rather than a second message.
      setDraft(state.draft);
    }
    // `poll` is deliberately not a dependency: this reacts to the action's
    // result, and re-running it whenever the cursor moves would re-clear a
    // composer somebody had started typing in again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // ---- keep the newest message in view ------------------------------------
  useEffect(() => {
    const list = listRef.current;
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  }, [messages.length]);

  const remaining = MESSAGE_MAX_LENGTH - draft.length;
  const grouped = useMemo(() => messages, [messages]);

  return (
    <div className="msg-thread">
      <ol className="msg-list" ref={listRef} data-testid="message-list">
        {grouped.length === 0 ? (
          <li className="msg-empty" data-testid="message-list-empty">
            Bu konuşmada henüz mesaj yok. İlk mesajı siz yazabilirsiniz.
          </li>
        ) : (
          grouped.map((message) => {
            const mine = message.senderRole === viewerRole;
            return (
              <li
                key={message.id}
                className={mine ? 'msg-item is-mine' : 'msg-item'}
                data-testid="message-item"
                data-sender={mine ? 'self' : 'counterpart'}
              >
                <span className="msg-item-author">{mine ? 'Siz' : counterpartName}</span>
                {/*
                  Rendered as a text child. React escapes it, and nothing here
                  ever asks a browser to parse a message body as markup — which
                  is why a body containing a script tag is shown as the
                  characters somebody typed.
                */}
                <p className="msg-item-body">{message.body}</p>
                <time className="msg-item-time" dateTime={message.createdAt}>
                  {mounted ? formatTime(message.createdAt) : ''}
                </time>
              </li>
            );
          })
        )}
      </ol>

      {counterpartHasRead && grouped.length > 0 ? (
        <p className="msg-receipt" data-testid="message-read-receipt">
          Son mesajınız okundu.
        </p>
      ) : null}

      {refreshFailed ? (
        <p className="msg-refresh-warning" role="status" data-testid="message-refresh-warning">
          Yeni mesajlar şu anda alınamıyor. Ekranda görünenler geçerlidir; sayfayı yenileyebilirsiniz.
        </p>
      ) : null}

      <form className="msg-composer" action={formAction} ref={formRef}>
        <input type="hidden" name="threadId" value={threadId} />
        <input type="hidden" name="clientToken" value={clientToken} />

        <label className="cdash-visually-hidden" htmlFor="message-body">
          Mesajınız
        </label>
        <textarea
          id="message-body"
          name="body"
          className="msg-composer-input"
          data-testid="message-input"
          rows={3}
          maxLength={MESSAGE_MAX_LENGTH}
          required
          placeholder="Mesajınızı yazın…"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />

        <div className="msg-composer-footer">
          <span
            className="msg-composer-count"
            data-testid="message-remaining"
            aria-live="polite"
          >
            {remaining} karakter kaldı
          </span>
          <button
            className="cdash-btn cdash-btn-primary"
            type="submit"
            data-testid="message-send"
            disabled={pending || draft.trim().length === 0}
          >
            {pending ? 'Gönderiliyor…' : 'Gönder'}
          </button>
        </div>

        {state.status === 'error' && state.message ? (
          <p className="msg-composer-error" role="alert" data-testid="message-error">
            {state.message}
          </p>
        ) : null}
      </form>
    </div>
  );
}

/**
 * Adds only messages this tab has not seen.
 *
 * Keyed on the id rather than trusting the cursor: a poll that overlapped a
 * server action's own refresh would otherwise show the sender their message
 * twice, which reads as having sent it twice.
 */
function mergeMessages(current: ThreadMessage[], incoming: ThreadMessage[]): ThreadMessage[] {
  const seen = new Set(current.map((message) => message.id));
  const added = incoming.filter((message) => !seen.has(message.id));
  return added.length === 0 ? current : [...current, ...added];
}

async function markRead(threadId: string): Promise<void> {
  try {
    await fetch(`/api/messages/${encodeURIComponent(threadId)}`, {
      method: 'POST',
      cache: 'no-store',
    });
  } catch {
    // A read mark that did not land costs a badge that stays up. Not worth
    // interrupting a conversation over.
  }
}

/**
 * An opaque, per-message key.
 *
 * `crypto.randomUUID` where the browser has it, and a random fallback where it
 * does not — the value only has to be unlikely to repeat within one thread, and
 * it is never shown, stored or used to identify anybody.
 */
function newToken(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

/**
 * The time, rendered on the client only.
 *
 * Server-rendered as an empty string and filled in after mount, because the
 * server and the reader are in different time zones often enough that
 * formatting a timestamp during SSR is a hydration mismatch waiting to happen —
 * this application has already had one. The `<time dateTime>` attribute carries
 * the machine-readable value either way.
 */
function formatTime(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }

  return parsed.toLocaleString('tr-TR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
