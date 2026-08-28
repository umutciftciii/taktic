import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  getCurrentUser,
  resolveMessageThread,
  THREAD_UNAVAILABLE_MESSAGES,
} from '../../../../lib/api';
import { IconArrowLeft } from '../../../landing-icons';
import { MessagingFrame } from '../../panel-frame';

type RequestThreadPageProps = {
  params: Promise<{ requestId: string }>;
};

/**
 * "Mesaj gönder", from a screen that knows the job but not the conversation.
 *
 * The match is what every CTA has in hand — a request id — and a thread is
 * opened lazily the first time somebody asks for one, so this page is the
 * translation between the two. It never renders a conversation itself: on
 * success it redirects to the thread, and what stays here is only the
 * explanation for a match that cannot carry one.
 *
 * Being a page rather than a button matters for the failures. A CTA that
 * silently did nothing, or dropped somebody on a 404, would leave a matched
 * customer with no idea whether messaging exists; here each refusal has a
 * sentence, and the ones that must stay silent — a caller who is not a party —
 * become the shared 404 that reveals nothing.
 */
export default async function RequestThreadPage({ params }: RequestThreadPageProps) {
  const { requestId } = await params;

  const user = await getCurrentUser();
  if (!user || (user.role !== 'CUSTOMER' && user.role !== 'PROVIDER')) {
    redirect(`/login?redirectTo=/mesajlar/talep/${requestId}`);
  }

  const result = await resolveMessageThread(requestId);

  if (result.state === 'ready') {
    redirect(`/mesajlar/${result.thread.id}`);
  }

  // Not a party to this match. The same answer as a request that does not
  // exist, deliberately: distinguishing them would confirm that a match
  // happened to somebody with no business knowing it.
  if (result.state === 'hidden') {
    notFound();
  }

  return (
    <MessagingFrame user={user}>
      <Link className="cdash-page-back" href="/mesajlar">
        <IconArrowLeft size={14} />
        <span>Mesajlara dön</span>
      </Link>

      <header className="cdash-page-head">
        <span className="kicker">Mesaj</span>
        <h1 className="cdash-page-title">Mesajlaşma açılamadı</h1>
      </header>

      <div
        className="cdash-notice cdash-notice-error"
        role="alert"
        data-testid="thread-unavailable"
      >
        {result.state === 'unavailable'
          ? THREAD_UNAVAILABLE_MESSAGES[result.reason]
          : 'Mesajlaşma şu anda açılamadı. Lütfen tekrar deneyin; sorun sürerse destek ekibiyle iletişime geçin.'}
      </div>
    </MessagingFrame>
  );
}
