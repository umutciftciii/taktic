import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  apiFetch,
  fetchOrNotFound,
  getCurrentUser,
  type MessageThreadDetail,
} from '../../../lib/api';
import { IconArrowLeft } from '../../landing-icons';
import { markThreadRead } from '../mark-read';
import { MessagingFrame } from '../panel-frame';
import { ThreadView } from '../thread-view';

type ThreadPageProps = {
  params: Promise<{ threadId: string }>;
};

/**
 * One conversation.
 *
 * The whole screen is served from a single API call that already refused
 * anybody who is not one of the two parties — a stranger, a losing provider,
 * another customer — so this page never has to decide who may read it.
 * `fetchOrNotFound` turns that refusal into the shared 404, which says the same
 * thing to somebody who guessed an id as to somebody whose thread really is
 * gone: nothing.
 */
export default async function ThreadPage({ params }: ThreadPageProps) {
  const { threadId } = await params;

  const user = await getCurrentUser();
  if (!user || (user.role !== 'CUSTOMER' && user.role !== 'PROVIDER')) {
    redirect(`/login?redirectTo=/mesajlar/${threadId}`);
  }

  const thread = await fetchOrNotFound(() =>
    apiFetch<MessageThreadDetail>(`/messages/threads/${threadId}`),
  );

  // Awaited before the frame renders, so the sidebar badge the shell is about
  // to load already reflects this visit. The history above was read first, so
  // what is on screen is what was unread a moment ago — and is now read.
  await markThreadRead(thread.id);

  return (
    <MessagingFrame user={user}>
      <Link className="cdash-page-back" href="/mesajlar">
        <IconArrowLeft size={14} />
        <span>Mesajlara dön</span>
      </Link>

      <header className="cdash-page-head">
        <span className="kicker">Mesaj</span>
        <h1 className="cdash-page-title" data-testid="thread-title">
          {thread.counterpart.name}
        </h1>
        <p className="cdash-page-sub">
          {thread.request.category.name} ·{' '}
          {thread.request.requestNumber ?? `#${thread.request.id.slice(-6).toUpperCase()}`} ·{' '}
          {thread.request.city}, {thread.request.district}
        </p>
      </header>

      {/*
        Only the newest page is server-rendered. Older history is deliberately
        not loaded here: a conversation is read from the bottom, and shipping
        every message a job ever produced in the first response is the one thing
        that would make this screen slow.
      */}
      <ThreadView
        threadId={thread.id}
        viewerRole={thread.viewerRole}
        counterpartName={thread.counterpart.name}
        initialMessages={thread.messages}
        initialCursor={thread.latestCursor}
        counterpartHasRead={thread.counterpartHasRead}
      />

      {thread.hasMoreBefore ? (
        <p className="cdash-page-sub" data-testid="thread-history-note">
          Bu konuşmanın daha eski mesajları var. Şimdilik en son mesajlar gösteriliyor.
        </p>
      ) : null}

      <div className="cdash-notice">
        Bu yazışma yalnızca siz ve karşı taraf arasındadır. Ödeme ve iş takibi bu ekran üzerinden
        yapılmaz.
      </div>
    </MessagingFrame>
  );
}
