import Link from 'next/link';
import { SUPPORT_TICKET_MESSAGE_MAX_LENGTH } from '@taktic/shared';
import {
  apiFetch,
  fetchOrNotFound,
  formatDateTime,
  requireAdmin,
  supportTicketRequesterRoleBadgeClass,
  supportTicketRequesterRoleLabel,
  supportTicketStatusBadgeClass,
  supportTicketStatusChangeLabel,
  supportTicketStatusLabel,
  supportTicketTransitionLabel,
  formatPrice,
  PACKAGE_REFUND_ACTOR_LABELS,
  PACKAGE_REFUND_RECOMMENDATION_LABELS,
  PACKAGE_REFUND_STATUS_LABELS,
  packageRefundStatusBadgeClass,
  type SupportTicketDetail,
  type SupportTicketTimelineEntry,
} from '../../../lib/api';
import { ConfirmDialog } from '../../../components/confirm-dialog';
import { DetailHeader } from '../../../components/detail-header';
import { KeyValueList } from '../../../components/key-value-list';
import { SectionCard } from '../../../components/section-card';
import type { SummaryItem } from '../../../components/summary-strip';
import { changeSupportTicketStatusAction, replySupportTicketAction } from '../actions';
import { openPackageRefundRequestAction } from '../../package-refunds/actions';

type AdminSupportTicketPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ sent?: string; statusSaved?: string; error?: string }>;
};

const TOPIC_LABELS: Record<SupportTicketDetail['topic'], string> = {
  GENERAL: 'Genel',
  PACKAGE_AND_CREDIT_REFUND: 'Paket ve kredi iadesi',
};

/**
 * What closing does (support-ticket.rules.ts, admin-support-tickets.service.ts):
 * CLOSED has no way out and nobody may write to it, and every status change
 * mails the requester.
 */
const CLOSE_CONSEQUENCE = (
  <>
    <p>
      Talep kalıcı olarak kapanır: ne siz ne talep sahibi yeni mesaj ekleyebilir, talep yeniden
      açılamaz. Konu sürüyorsa talep sahibi yeni bir destek talebi açar.
    </p>
    <p>Yazışma ve geçmiş silinmez. Talep sahibine durum değişikliği e-postası gider.</p>
  </>
);

/**
 * One ticket, its whole history, and the two things an operator can do to it
 * (ADMIN-DESIGN-001 Faz 3B, the detail template; the design has no screen of
 * its own for this route).
 *
 * The status controls are built from `allowedTransitions`, which the API
 * returns for the status the ticket actually holds — so a move the transition
 * table forbids has no button here at all, and the one case a button could
 * still be wrong (somebody else moved the ticket between this render and the
 * click) is refused by the API's compare-and-swap and reported above the
 * tabs. Closing is final, so it asks first.
 *
 * Every section keeps its own permission: replying and moving need
 * SUPPORT_WRITE, opening a refund request PACKAGE_REFUND_REQUEST_CREATE, and
 * the refund block is only in the answer for PACKAGE_REFUND_READ.
 */
export default async function AdminSupportTicketPage({
  params,
  searchParams,
}: AdminSupportTicketPageProps) {
  const { can } = await requireAdmin('SUPPORT_READ');
  const canWrite = can('SUPPORT_WRITE');
  const canOpenRefund = can('PACKAGE_REFUND_REQUEST_CREATE');
  const canReadRefund = can('PACKAGE_REFUND_READ');
  const canReadCustomers = can('CUSTOMERS_READ');

  const [{ id }, query] = await Promise.all([params, searchParams]);
  const ticket = await fetchOrNotFound(() =>
    apiFetch<SupportTicketDetail>(`/admin/support/tickets/${id}`),
  );

  const messageCount = ticket.timeline.filter((entry) => entry.kind === 'MESSAGE').length;
  // The account behind the ticket. A hizmet alan's user id is their customer
  // id, so their screen is one link away. A hizmet veren's profile id is not
  // in this answer, and `/users/:id` is the staff screen (it answers 404 for
  // anyone else), so no account link is drawn for one.
  const accountHref =
    ticket.requesterRole === 'CUSTOMER' && canReadCustomers ? `/customers/${ticket.requester.id}` : null;

  const facts: SummaryItem[] = [
    {
      label: 'Durum',
      value: supportTicketStatusLabel(ticket.status),
      tone: ticket.status === 'OPEN' ? 'warning' : ticket.status === 'CLOSED' ? 'neutral' : 'success',
    },
    { label: 'Talep sahibi', value: supportTicketRequesterRoleLabel(ticket.requesterRole) },
    { label: 'Konu', value: TOPIC_LABELS[ticket.topic] ?? ticket.topic },
    { label: 'Mesaj', value: String(messageCount), note: 'Yazışmadaki mesaj sayısı' },
    { label: 'Son hareket', value: formatDateTime(ticket.lastActivityAt) },
  ];

  return (
    <main className="support-detail-page">
      <DetailHeader
        back={{ href: '/support', label: 'Destek talepleri' }}
        badges={
          <>
            {/*
              The desk sits beside the status, and before it in reading order,
              because it is the fact that decides what the answer may say: a
              hizmet veren's ticket is about teklifler and krediler, and a
              hizmet alan's is about their talep.
            */}
            <span
              className={supportTicketRequesterRoleBadgeClass(ticket.requesterRole)}
              data-testid="support-detail-requester-role"
            >
              {supportTicketRequesterRoleLabel(ticket.requesterRole)}
            </span>
            <span className={supportTicketStatusBadgeClass(ticket.status)} data-testid="support-detail-status">
              {supportTicketStatusLabel(ticket.status)}
            </span>
          </>
        }
        meta={
          <>
            <code>#{ticket.id.slice(-8)}</code> · {formatDateTime(ticket.createdAt)}&apos;de açıldı
          </>
        }
        title={ticket.subject}
        subtitle={[ticket.requester.name ?? 'İsimsiz hesap', ticket.requester.email].filter(Boolean).join(' · ')}
        actions={
          accountHref ? (
            <Link className="btn btn-secondary btn-sm" href={accountHref} data-testid="support-account-link">
              Hizmet alanı aç
            </Link>
          ) : null
        }
        facts={facts}
        factsLabel="Destek talebi özeti"
        testId="support-detail-header"
      />

      {query.error ? (
        <div className="notice notice-error detail-notice" role="alert" data-testid="support-detail-error">
          {query.error}
        </div>
      ) : query.statusSaved === '1' ? (
        <div className="notice notice-success detail-notice" role="status" data-testid="support-status-saved">
          Talep durumu güncellendi.
        </div>
      ) : query.sent === '1' ? (
        <div className="notice notice-success detail-notice" role="status" data-testid="support-reply-sent">
          Mesajınız talebe eklendi.
        </div>
      ) : null}

      <div className="detail-panel support-detail-layout">
        <div className="support-detail-main">
          <SectionCard title="Yazışma" subtitle="Mesajlar ve durum değişiklikleri, olduğu sırayla.">
            <ol className="support-timeline" data-testid="support-timeline">
              {ticket.timeline.map((entry) => (
                <TimelineEntry key={`${entry.kind}-${entry.id}`} entry={entry} />
              ))}
            </ol>
          </SectionCard>

          {canWrite ? (
            <SectionCard title="Yanıtla">
              {ticket.canReply ? (
                <form action={replySupportTicketAction} className="detail-form" data-testid="support-reply-form">
                  <input type="hidden" name="id" value={ticket.id} />
                  <label className="detail-form-field" htmlFor="support-admin-reply">
                    <span>Mesajınız</span>
                    {/*
                      The same limit the API enforces and the same one the customer's
                      composer counts against — both sides read
                      `packages/shared/limits.json`, so an operator cannot type a
                      reply the server will refuse.
                    */}
                    <textarea
                      id="support-admin-reply"
                      name="body"
                      rows={5}
                      required
                      maxLength={SUPPORT_TICKET_MESSAGE_MAX_LENGTH}
                      placeholder="Talep sahibine yazacağınız yanıt…"
                      data-testid="support-reply-input"
                    />
                  </label>
                  <div className="detail-form-actions">
                    <button className="btn btn-primary btn-sm" type="submit" data-testid="support-reply-send">
                      Yanıtı gönder
                    </button>
                  </div>
                </form>
              ) : (
                <p className="detail-muted-note" data-testid="support-reply-closed">
                  Kapatılmış bir talebe mesaj eklenemez.
                </p>
              )}
            </SectionCard>
          ) : null}
        </div>

        <div className="support-detail-side">
          {canWrite ? (
            <SectionCard title="Durum" subtitle="Yalnızca bu talebin şu anda yapabileceği geçişler gösterilir.">
              {ticket.allowedTransitions.length === 0 ? (
                <p className="detail-muted-note" data-testid="support-no-transitions">
                  Kapatılmış bir talep yeniden açılamaz. Konu devam ediyorsa talep sahibi yeni bir talep
                  açabilir.
                </p>
              ) : (
                <div className="detail-form-actions" data-testid="support-transitions">
                  {ticket.allowedTransitions.map((next) => (
                    <form key={next} action={changeSupportTicketStatusAction}>
                      <input type="hidden" name="id" value={ticket.id} />
                      <input type="hidden" name="status" value={next} />
                      {next === 'CLOSED' ? (
                        <ConfirmDialog
                          triggerLabel={supportTicketTransitionLabel(next)}
                          triggerClassName="btn btn-destructive btn-sm"
                          title="Destek talebi kapatılsın mı?"
                          consequence={CLOSE_CONSEQUENCE}
                          confirmLabel="Evet, kapat"
                          testId={`support-transition-${next}`}
                        />
                      ) : (
                        <button
                          className="btn btn-secondary btn-sm"
                          type="submit"
                          data-testid={`support-transition-${next}`}
                        >
                          {supportTicketTransitionLabel(next)}
                        </button>
                      )}
                    </form>
                  ))}
                </div>
              )}
            </SectionCard>
          ) : null}

          <SectionCard title="Talep sahibi">
            <KeyValueList
              items={[
                {
                  label: 'Rol',
                  value: supportTicketRequesterRoleLabel(ticket.requesterRole),
                  testId: 'support-detail-requester-role-row',
                },
                { label: 'Ad', value: ticket.requester.name ?? <span className="cell-muted">İsimsiz hesap</span> },
                {
                  label: 'E-posta',
                  value: ticket.requester.email ? <span className="cell-break">{ticket.requester.email}</span> : null,
                },
                {
                  label: 'Hesap',
                  value: accountHref ? <Link href={accountHref}>Hizmet alan detayını aç</Link> : null,
                },
              ]}
            />
          </SectionCard>

          {ticket.packageRefund ? (
            <SectionCard
              title="Paket ve kredi iadesi"
              subtitle={
                ticket.topic === 'PACKAGE_AND_CREDIT_REFUND'
                  ? 'Hizmet veren bu talebi iade konusuyla açtı.'
                  : 'Bu genel talebe bağlı iade isteği.'
              }
            >
              {ticket.packageRefund.request ? (
                <p className="support-refund-line" data-testid="support-refund-link">
                  <span className={packageRefundStatusBadgeClass(ticket.packageRefund.request.status)}>
                    {PACKAGE_REFUND_STATUS_LABELS[ticket.packageRefund.request.status]}
                  </span>{' '}
                  {canReadRefund ? (
                    <Link href={`/package-refunds/${ticket.packageRefund.request.id}`}>İade isteğini aç</Link>
                  ) : null}
                </p>
              ) : ticket.packageRefund.canOpen && canOpenRefund ? (
                <form
                  action={openPackageRefundRequestAction}
                  className="detail-form"
                  data-testid="support-refund-open-form"
                >
                  <input type="hidden" name="supportTicketId" value={ticket.id} />
                  <label className="detail-form-field" htmlFor="support-refund-purchase">
                    <span>Bu talep üzerinden iade isteği aç (istisna incelemesi dahil)</span>
                    <select id="support-refund-purchase" name="purchaseId" required defaultValue="">
                      <option value="" disabled>
                        Satın alma seçin
                      </option>
                      {ticket.packageRefund.candidatePurchases.map((purchase) => (
                        <option key={purchase.id} value={purchase.id}>
                          {`${purchase.packageName} · ${purchase.purchaseNumber ?? purchase.id} · ${formatPrice(
                            purchase.priceAmount,
                            purchase.currency,
                          )} · ${PACKAGE_REFUND_RECOMMENDATION_LABELS[purchase.recommendation]}`}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="detail-muted-note">
                    İstek inceleme kuyruğuna düşer; para hareketi olmaz. Onay ve ödeme iade isteği
                    ekranında ayrı adımlardır.
                  </p>
                  <div className="detail-form-actions">
                    <button className="btn btn-secondary btn-sm" type="submit" data-testid="support-refund-open">
                      İade isteği aç
                    </button>
                  </div>
                </form>
              ) : (
                <p className="detail-muted-note" data-testid="support-refund-none">
                  Bu talebe bağlı bir iade isteği yok.
                </p>
              )}
            </SectionCard>
          ) : null}
        </div>
      </div>
    </main>
  );
}

/**
 * Who wrote a message, as an operator reads it.
 *
 * A table rather than a ternary, because there are three answers now and a
 * ternary that had to guess a third would print "Hizmet alan" over a hizmet
 * veren's own words. The label is chosen by the role stored *on the message*,
 * which is the permanent record of the side it came from — never by the desk
 * the ticket is on, and never by the author's current account role.
 */
const TIMELINE_AUTHOR_LABELS: Record<'CUSTOMER' | 'ADMIN' | 'PROVIDER', string> = {
  CUSTOMER: 'Hizmet alan',
  PROVIDER: 'Hizmet veren',
  ADMIN: 'Destek ekibi',
};

/**
 * One entry on the permanent timeline.
 *
 * A status change is drawn as its own kind of row rather than as a message, so
 * "the platform recorded this" can never be mistaken for "somebody said this",
 * and an operator reading the history can tell at a glance which of their
 * colleagues' actions were answers and which were moves.
 */
function TimelineEntry({ entry }: { entry: SupportTicketTimelineEntry }) {
  if (entry.kind === 'PACKAGE_REFUND_EVENT') {
    return (
      <li className="support-timeline-event" data-testid="support-refund-event" data-to-status={entry.toStatus}>
        <span>
          İade isteği: {entry.statusLabel} — {PACKAGE_REFUND_ACTOR_LABELS[entry.actorKind]}
          {entry.actor?.name ? ` (${entry.actor.name})` : ''}
        </span>
        <time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt)}</time>
      </li>
    );
  }

  if (entry.kind === 'STATUS_CHANGE') {
    return (
      <li
        className="support-timeline-event"
        data-testid="support-timeline-event"
        data-to-status={entry.toStatus}
      >
        <span>{supportTicketStatusChangeLabel(entry.toStatus)}</span>
        <time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt)}</time>
      </li>
    );
  }

  return (
    <li
      className={
        entry.authorRole === 'ADMIN'
          ? 'support-timeline-message is-admin'
          : 'support-timeline-message'
      }
      data-testid="support-timeline-message"
      data-author={entry.authorRole}
    >
      <span className="support-timeline-author">{TIMELINE_AUTHOR_LABELS[entry.authorRole]}</span>
      {/*
        Rendered as a text child. React escapes it, and nothing here ever asks a
        browser to parse a ticket body as markup.
      */}
      <p className="support-timeline-body">{entry.body}</p>
      <time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt)}</time>
    </li>
  );
}
