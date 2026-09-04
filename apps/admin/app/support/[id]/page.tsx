import Link from 'next/link';
import { SUPPORT_TICKET_MESSAGE_MAX_LENGTH } from '@taktic/shared';
import {
  apiFetch,
  fetchOrNotFound,
  formatDateTime,
  requireAdmin,
  supportTicketStatusBadgeClass,
  supportTicketStatusChangeLabel,
  supportTicketStatusLabel,
  supportTicketTransitionLabel,
  type SupportTicketDetail,
  type SupportTicketTimelineEntry,
} from '../../../lib/api';
import { PageHeader } from '../../../components/page-header';
import { SectionCard } from '../../../components/section-card';
import { changeSupportTicketStatusAction, replySupportTicketAction } from '../actions';

type AdminSupportTicketPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ sent?: string; statusSaved?: string; error?: string }>;
};

/**
 * One ticket, its whole history, and the two things an operator can do to it.
 *
 * The status controls are built from `allowedTransitions`, which the API
 * returns for the status the ticket actually holds — so a move the transition
 * table forbids has no button here at all, and the one case a button could
 * still be wrong (somebody else moved the ticket between this render and the
 * click) is refused by the API's compare-and-swap and reported above the
 * timeline.
 */
export default async function AdminSupportTicketPage({
  params,
  searchParams,
}: AdminSupportTicketPageProps) {
  await requireAdmin();

  const [{ id }, query] = await Promise.all([params, searchParams]);
  const ticket = await fetchOrNotFound(() =>
    apiFetch<SupportTicketDetail>(`/admin/support/tickets/${id}`),
  );

  return (
    <main>
      <PageHeader
        breadcrumbs={[{ label: 'Destek Talepleri', href: '/support' }, { label: ticket.subject }]}
        title={ticket.subject}
        subtitle={`Oluşturulma: ${formatDateTime(ticket.createdAt)} · Son hareket: ${formatDateTime(
          ticket.lastActivityAt,
        )}`}
        actions={
          <span
            className={supportTicketStatusBadgeClass(ticket.status)}
            data-testid="support-detail-status"
          >
            {supportTicketStatusLabel(ticket.status)}
          </span>
        }
      />

      {query.error ? (
        <div
          className="notice notice-error"
          role="alert"
          style={{ marginBottom: 12 }}
          data-testid="support-detail-error"
        >
          {query.error}
        </div>
      ) : query.statusSaved === '1' ? (
        <div
          className="notice notice-success"
          role="status"
          style={{ marginBottom: 12 }}
          data-testid="support-status-saved"
        >
          Talep durumu güncellendi.
        </div>
      ) : query.sent === '1' ? (
        <div
          className="notice notice-success"
          role="status"
          style={{ marginBottom: 12 }}
          data-testid="support-reply-sent"
        >
          Mesajınız talebe eklendi.
        </div>
      ) : null}

      <SectionCard title="Hizmet alan">
        <dl className="meta-row">
          <div>
            <dt>Ad</dt>
            <dd>{ticket.customer.name ?? <span className="cell-muted">İsimsiz hesap</span>}</dd>
          </div>
          <div>
            <dt>E-posta</dt>
            <dd>{ticket.customer.email ?? <span className="cell-muted">-</span>}</dd>
          </div>
          <div>
            <dt>Hesap</dt>
            <dd>
              <Link href={`/customers/${ticket.customer.id}`}>Hesabı görüntüle</Link>
            </dd>
          </div>
        </dl>
      </SectionCard>

      <SectionCard
        title="Durum"
        subtitle="Yalnızca bu talebin şu anda yapabileceği geçişler gösterilir."
      >
        {ticket.allowedTransitions.length === 0 ? (
          <p className="cell-muted" data-testid="support-no-transitions">
            Kapatılmış bir talep yeniden açılamaz. Konu devam ediyorsa hizmet alan yeni bir talep
            açabilir.
          </p>
        ) : (
          <div className="inline-actions" data-testid="support-transitions">
            {ticket.allowedTransitions.map((next) => (
              <form key={next} action={changeSupportTicketStatusAction}>
                <input type="hidden" name="id" value={ticket.id} />
                <input type="hidden" name="status" value={next} />
                <button
                  className="btn btn-secondary btn-sm"
                  type="submit"
                  data-testid={`support-transition-${next}`}
                >
                  {supportTicketTransitionLabel(next)}
                </button>
              </form>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard title="Yazışma" subtitle="Mesajlar ve durum değişiklikleri, olduğu sırayla.">
        <ol className="support-timeline" data-testid="support-timeline">
          {ticket.timeline.map((entry) => (
            <TimelineEntry key={`${entry.kind}-${entry.id}`} entry={entry} />
          ))}
        </ol>
      </SectionCard>

      <SectionCard title="Yanıtla">
        {ticket.canReply ? (
          <form action={replySupportTicketAction} data-testid="support-reply-form">
            <input type="hidden" name="id" value={ticket.id} />
            <label className="form-row" htmlFor="support-admin-reply">
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
                placeholder="Hizmet alana yazacağınız yanıt…"
                data-testid="support-reply-input"
              />
            </label>
            <div className="inline-actions" style={{ marginTop: 12 }}>
              <button
                className="btn btn-primary btn-sm"
                type="submit"
                data-testid="support-reply-send"
              >
                Yanıtı gönder
              </button>
            </div>
          </form>
        ) : (
          <p className="cell-muted" data-testid="support-reply-closed">
            Kapatılmış bir talebe mesaj eklenemez.
          </p>
        )}
      </SectionCard>
    </main>
  );
}

/**
 * One entry on the permanent timeline.
 *
 * A status change is drawn as its own kind of row rather than as a message, so
 * "the platform recorded this" can never be mistaken for "somebody said this",
 * and an operator reading the history can tell at a glance which of their
 * colleagues' actions were answers and which were moves.
 */
function TimelineEntry({ entry }: { entry: SupportTicketTimelineEntry }) {
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
      <span className="support-timeline-author">
        {entry.authorRole === 'ADMIN' ? 'Destek ekibi' : 'Hizmet alan'}
      </span>
      {/*
        Rendered as a text child. React escapes it, and nothing here ever asks a
        browser to parse a ticket body as markup.
      */}
      <p className="support-timeline-body">{entry.body}</p>
      <time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt)}</time>
    </li>
  );
}
