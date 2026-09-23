import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  apiFetch,
  fetchOrNotFound,
  formatDateTime,
  getCurrentUser,
  supportTicketStatusBadgeClass,
  supportTicketStatusChangeLabel,
  supportTicketStatusLabel,
  formatPrice,
  type ProviderPackageRefundRequest,
  type SupportTicketDetail,
  type SupportTicketTimelineEntry,
} from '../../../lib/api';
import {
  PACKAGE_REFUND_SUBMITTED_NOTICE,
  packageRefundStatusBadgeClass,
  packageRefundTimelineText,
} from '../../../lib/package-refund';
import { withdrawPackageRefundAction } from '../actions';
import { IconArrowLeft } from '../../landing-icons';
import { PanelShell } from '../../panel-shell';
import { ReplyForm } from '../reply-form';

type SupportTicketPageProps = {
  params: Promise<{ ticketId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * One support ticket, and everything that has happened to it.
 *
 * The whole screen is served from a single API call that already refused
 * anybody who is not this ticket's owner — including somebody on the other side
 * of the marketplace, whose own desk this ticket is not on — so this page never
 * has to decide who may read it. `fetchOrNotFound` turns that refusal into the
 * shared 404, which says the same thing to a hizmet veren who guessed a hizmet
 * alan's id as to somebody whose ticket really is gone: nothing.
 *
 * That is why the role check below is only about being signed in as one of the
 * two marketplace roles. Deciding here which tickets belong to whom would be a
 * second answer to a question the API has already answered, and a second answer
 * is the one that eventually disagrees.
 */
export default async function SupportTicketPage({ params, searchParams }: SupportTicketPageProps) {
  const { ticketId } = await params;

  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?redirectTo=/destek/${ticketId}`);
  }
  if (user.role !== 'CUSTOMER' && user.role !== 'PROVIDER') {
    redirect('/');
  }

  const [ticket, query] = await Promise.all([
    fetchOrNotFound(() => apiFetch<SupportTicketDetail>(`/support/tickets/${ticketId}`)),
    searchParams,
  ]);

  const justSent = readParam(query, 'sent') === '1';
  const createdParam = readParam(query, 'created');
  const justCreated = createdParam === '1';
  const justCreatedRefund = createdParam === 'refund';
  const refundParam = readParam(query, 'refund');

  return (
    <PanelShell user={user} active="support">
      <div className="cdash-support" data-testid="support-screen">
        <Link className="cdash-page-back" href="/destek">
          <IconArrowLeft size={14} />
          <span>Destek taleplerine dön</span>
        </Link>

        <header className="cdash-page-head">
          <span className="kicker">Destek talebi</span>
          <h1 className="cdash-page-title" data-testid="support-ticket-title">
            {ticket.subject}
          </h1>
          <p className="cdash-page-sub">
            <span
              className={supportTicketStatusBadgeClass(ticket.status)}
              data-testid="support-detail-status"
            >
              {supportTicketStatusLabel(ticket.status)}
            </span>{' '}
            · Oluşturulma: {formatDateTime(ticket.createdAt)} · Son hareket:{' '}
            {formatDateTime(ticket.lastActivityAt)}
          </p>
        </header>

        {justCreatedRefund ? (
          <div className="notice" role="status" data-testid="refund-created-notice">
            <span>{PACKAGE_REFUND_SUBMITTED_NOTICE}</span>
          </div>
        ) : refundParam === 'withdrawn' ? (
          <div className="notice" role="status" data-testid="refund-withdrawn-notice">
            <span>İade talebiniz geri çekildi.</span>
          </div>
        ) : refundParam === 'withdraw-failed' ? (
          <div className="notice cdash-notice-error" data-testid="refund-withdraw-failed-notice">
            <span>İade talebi geri çekilemedi; talep incelemede ilerlemiş olabilir.</span>
          </div>
        ) : justCreated ? (
          <div className="notice" role="status" data-testid="support-created-notice">
            <span>Destek talebiniz oluşturuldu. Ekibimiz en kısa sürede dönüş yapacak.</span>
          </div>
        ) : justSent ? (
          <div className="notice" role="status" data-testid="support-sent-notice">
            <span>Mesajınız gönderildi.</span>
          </div>
        ) : null}

        {ticket.packageRefundRequest ? (
          <RefundCard ticketId={ticket.id} refund={ticket.packageRefundRequest} />
        ) : null}

        <div className="msg-thread">
          <ol className="msg-list" data-testid="support-timeline">
            {ticket.timeline.map((entry) => (
              <TimelineEntry key={`${entry.kind}-${entry.id}`} entry={entry} />
            ))}
          </ol>

          {ticket.canReply ? (
            <ReplyForm ticketId={ticket.id} />
          ) : (
            <div className="cdash-notice" role="status" data-testid="support-closed-notice">
              Bu destek talebi{' '}
              <strong>{supportTicketStatusLabel(ticket.status).toLocaleLowerCase('tr-TR')}</strong>{' '}
              durumunda olduğu için yeni mesaj eklenemiyor. Konu devam ediyorsa{' '}
              <Link href="/destek/yeni">yeni bir destek talebi</Link> açabilirsiniz.
            </div>
          )}
        </div>
      </div>
    </PanelShell>
  );
}

/**
 * One entry on the permanent timeline.
 *
 * A status change is drawn as its own kind of row rather than as a message, so
 * "the platform did this" can never be mistaken for "somebody said this" — and
 * both stay in one chronological list, which is how the ticket actually
 * happened.
 */
function TimelineEntry({ entry }: { entry: SupportTicketTimelineEntry }) {
  if (entry.kind === 'PACKAGE_REFUND_EVENT') {
    return (
      <li className="msg-event" data-testid="support-refund-event" data-to-status={entry.toStatus}>
        <span className="msg-event-text">{packageRefundTimelineText(entry.statusLabel)}</span>
        <time className="msg-item-time" dateTime={entry.createdAt}>
          {formatDateTime(entry.createdAt)}
        </time>
      </li>
    );
  }

  if (entry.kind === 'STATUS_CHANGE') {
    return (
      <li
        className="msg-event"
        data-testid="support-timeline-event"
        data-to-status={entry.toStatus}
      >
        <span className="msg-event-text">{supportTicketStatusChangeLabel(entry.toStatus)}</span>
        <time className="msg-item-time" dateTime={entry.createdAt}>
          {formatDateTime(entry.createdAt)}
        </time>
      </li>
    );
  }

  return (
    <li
      className={entry.mine ? 'msg-item is-mine' : 'msg-item'}
      data-testid="support-timeline-message"
      data-author={entry.authorRole}
    >
      <span className="msg-item-author">{entry.mine ? 'Siz' : 'Destek ekibi'}</span>
      {/*
        Rendered as a text child. React escapes it, and nothing here ever asks a
        browser to parse a ticket body as markup — which is why a body
        containing a script tag is shown as the characters somebody typed.
      */}
      <p className="msg-item-body">{entry.body}</p>
      <time className="msg-item-time" dateTime={entry.createdAt}>
        {formatDateTime(entry.createdAt)}
      </time>
    </li>
  );
}

/**
 * CMP-006 PR-B. The refund request this ticket carries: what it is about and
 * where it stands. The withdraw button appears only while the API says the
 * request can still be withdrawn (before any approval).
 */
function RefundCard({ ticketId, refund }: { ticketId: string; refund: ProviderPackageRefundRequest }) {
  return (
    <section className="cdash-detail-card" aria-labelledby="refund-card-heading" data-testid="refund-card">
      <h2 id="refund-card-heading">Paket ve kredi iadesi talebi</h2>
      <p>
        <span
          className={packageRefundStatusBadgeClass(refund.status)}
          data-testid="refund-status"
          data-status={refund.status}
        >
          {refund.statusLabel}
        </span>
      </p>
      <dl className="cdash-meta-list">
        <dt>Paket</dt>
        <dd>{refund.purchase.packageName}</dd>
        {refund.purchase.purchaseNumber ? (
          <>
            <dt>Satın alma no</dt>
            <dd>{refund.purchase.purchaseNumber}</dd>
          </>
        ) : null}
        <dt>Tutar</dt>
        <dd>{formatPrice(refund.purchase.priceAmount, refund.purchase.currency)}</dd>
        {refund.purchase.paidAt ? (
          <>
            <dt>Ödeme tarihi</dt>
            <dd>{formatDateTime(refund.purchase.paidAt)}</dd>
          </>
        ) : null}
      </dl>
      <p className="help-text">
        Ödeme iadesi onaylanırsa ödeme sağlayıcısı üzerinden işlenir. Kararı bu talep üzerinden size bildiririz.
      </p>
      {refund.canWithdraw ? (
        <form action={withdrawPackageRefundAction}>
          <input type="hidden" name="ticketId" value={ticketId} />
          <button className="cdash-btn cdash-btn-secondary" type="submit" data-testid="refund-withdraw">
            İade talebini geri çek
          </button>
        </form>
      ) : null}
    </section>
  );
}

function readParam(params: Record<string, string | string[] | undefined>, key: string): string {
  const value = params[key];
  return typeof value === 'string' ? value : '';
}
