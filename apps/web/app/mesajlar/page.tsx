import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import {
  apiFetch,
  formatDateTime,
  getCurrentUser,
  type AuthUser,
  type MessageThreadListEntry,
} from '../../lib/api';
import { IconArrowRight } from '../landing-icons';
import { MessagingFrame } from './panel-frame';
import { ThreadListSkeleton } from './skeletons';

/**
 * The conversations this account is a party to.
 *
 * Who may be here is settled first, and settled before anything is streamed:
 * the sign-in check sits above the Suspense boundary below, so an anonymous
 * request is answered with the same 307 to `/login` as every other protected
 * route rather than with a skeleton that would have to take it back.
 */
export default async function MessagesPage() {
  const user = await getCurrentUser();
  if (!user || (user.role !== 'CUSTOMER' && user.role !== 'PROVIDER')) {
    redirect('/login?redirectTo=/mesajlar');
  }

  return (
    <Suspense fallback={<ThreadListSkeleton />}>
      <Inbox user={user} />
    </Suspense>
  );
}

/**
 * The list itself, read once we know whose list it is.
 *
 * Nothing here filters: the API returns exactly the threads whose customer or
 * provider column names the caller, so "only my conversations" is a property of
 * the query rather than of this page remembering to check.
 */
async function Inbox({ user }: { user: AuthUser }) {
  let threads: MessageThreadListEntry[] | null = null;
  try {
    threads = await apiFetch<MessageThreadListEntry[]>('/messages/threads');
  } catch {
    // Null, never an empty array: a list that could not be read must not look
    // like a list with nothing in it.
    threads = null;
  }

  return (
    <MessagingFrame user={user}>
      <header className="cdash-page-head">
        <span className="kicker">Mesajlar</span>
        <h1 className="cdash-page-title">Mesajlar</h1>
        <p className="cdash-page-sub">
          Eşleşmeniz tamamlanan işler için karşı tarafla buradan yazışabilirsiniz.
        </p>
      </header>

      {threads === null ? (
        <div className="cdash-notice cdash-notice-error" role="alert" data-testid="thread-list-error">
          Mesajlarınız şu anda yüklenemedi. Lütfen sayfayı yenileyin; sorun sürerse destek ekibiyle
          iletişime geçin.
        </div>
      ) : threads.length === 0 ? (
        <div className="cdash-empty" data-testid="thread-list-empty">
          <h3>Henüz mesajınız yok</h3>
          <p>
            Bir teklif kabul edildiğinde eşleşme tamamlanır ve o iş için mesajlaşma burada açılır.
          </p>
        </div>
      ) : (
        <ul className="msg-thread-list" data-testid="thread-list">
          {threads.map((thread) => (
            <li key={thread.id}>
              <Link className="msg-thread-row" href={`/mesajlar/${thread.id}`}>
                <span className="msg-thread-main">
                  <span className="msg-thread-name" data-testid="thread-counterpart">
                    {thread.counterpart.name}
                  </span>
                  <span className="msg-thread-context">
                    {thread.request.category.name} ·{' '}
                    {thread.request.requestNumber ??
                      `#${thread.request.id.slice(-6).toUpperCase()}`}{' '}
                    · {thread.request.city}, {thread.request.district}
                  </span>
                  {/*
                    A one-line trace of the last message, clipped by CSS rather
                    than cut here: truncating in JavaScript would put a
                    half-sentence in the DOM, where a screen reader would read it
                    as the whole message.
                  */}
                  <span className="msg-thread-preview">
                    {thread.lastMessage ? thread.lastMessage.body : 'Henüz mesaj yok.'}
                  </span>
                </span>
                <span className="msg-thread-meta">
                  {thread.lastMessageAt ? (
                    <span className="msg-thread-time">{formatDateTime(thread.lastMessageAt)}</span>
                  ) : null}
                  {thread.unreadCount > 0 ? (
                    <span
                      className="msg-unread-badge"
                      data-testid="thread-unread"
                      aria-label={`${thread.unreadCount} okunmamış mesaj`}
                    >
                      {thread.unreadCount}
                    </span>
                  ) : null}
                  <IconArrowRight size={14} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </MessagingFrame>
  );
}
