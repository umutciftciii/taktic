import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  formatDateTime,
  getCurrentUser,
  loadSupportTickets,
  supportTicketStatusBadgeClass,
  supportTicketStatusLabel,
  type SupportTicketSummary,
} from '../../lib/api';
import { IconArrowRight, IconPlus } from '../landing-icons';
import { CustomerShell } from '../requests/customer-shell';

type SupportPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * The customer's own support tickets.
 *
 * Who may be here is settled before anything is read: support is a customer
 * surface, so a provider or an anonymous visitor is sent to sign in rather than
 * shown an empty list they would read as "you have no tickets".
 *
 * Nothing on this page filters. The API returns exactly the tickets whose owner
 * column names the caller, so "only mine" is a property of the query rather
 * than of this page remembering to check.
 */
export default async function SupportPage({ searchParams }: SupportPageProps) {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login?redirectTo=/destek');
  }
  if (user.role !== 'CUSTOMER') {
    redirect('/');
  }

  const [tickets, params] = await Promise.all([loadSupportTickets(), searchParams]);
  const created = readParam(params, 'created') === '1';

  return (
    <CustomerShell user={user} active="support">
      {/*
        Everything this feature renders lives inside one region, so the
        end-to-end suite can hold the whole customer support surface to the
        "no placeholders" rule without also picking up the panel's own topbar.
      */}
      <div className="cdash-support" data-testid="support-screen">
        <header className="cdash-page-head">
          <span className="kicker">Destek</span>
          <h1 className="cdash-page-title">Destek taleplerim</h1>
          <p className="cdash-page-sub">
            Platformla ilgili bir sorunuz veya sorununuz olduğunda buradan destek talebi
            açabilirsiniz. Ekibimizin yanıtları aynı ekranda görünür.
          </p>
        </header>

        {/*
        Ordinary page content rather than a toast, and announced without
        stealing focus: somebody who submitted the form and looked away should
        still find out that their ticket was opened.
      */}
        {created ? (
          <div className="notice" role="status" data-testid="support-created-notice">
            <span>Destek talebiniz oluşturuldu. Ekibimiz en kısa sürede dönüş yapacak.</span>
          </div>
        ) : null}

        <div className="inline-actions" style={{ marginBottom: 16 }}>
          <Link
            className="cdash-btn cdash-btn-primary"
            href="/destek/yeni"
            data-testid="support-new-cta"
          >
            <IconPlus size={14} />
            <span>Yeni destek talebi</span>
          </Link>
        </div>

        {tickets === null ? (
          <div
            className="cdash-notice cdash-notice-error"
            role="alert"
            data-testid="support-list-error"
          >
            Destek talepleriniz şu anda yüklenemedi. Lütfen sayfayı yenileyin.
          </div>
        ) : tickets.length === 0 ? (
          <div className="cdash-empty" data-testid="support-list-empty">
            <h3>Henüz destek talebiniz yok</h3>
            <p>
              Bir sorunuz olduğunda yeni bir destek talebi açın; yazışmanın tamamı bu ekranda kalır.
            </p>
            <Link className="cdash-btn cdash-btn-secondary" href="/destek/yeni">
              Yeni destek talebi
            </Link>
          </div>
        ) : (
          <ul className="msg-thread-list" data-testid="support-list">
            {tickets.map((ticket) => (
              <li key={ticket.id}>
                <SupportTicketRow ticket={ticket} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </CustomerShell>
  );
}

function SupportTicketRow({ ticket }: { ticket: SupportTicketSummary }) {
  return (
    <Link
      className="msg-thread-row"
      href={`/destek/${ticket.id}`}
      data-testid="support-ticket-row"
      data-status={ticket.status}
    >
      <span className="msg-thread-main">
        <span className="msg-thread-name" data-testid="support-ticket-subject">
          {ticket.subject}
        </span>
        <span className="msg-thread-context">
          Oluşturulma: {formatDateTime(ticket.createdAt)} · Son hareket:{' '}
          {formatDateTime(ticket.lastActivityAt)}
        </span>
      </span>
      <span className="msg-thread-meta">
        <span
          className={supportTicketStatusBadgeClass(ticket.status)}
          data-testid="support-ticket-status"
        >
          {supportTicketStatusLabel(ticket.status)}
        </span>
        <IconArrowRight size={14} />
      </span>
    </Link>
  );
}

function readParam(params: Record<string, string | string[] | undefined>, key: string): string {
  const value = params[key];
  return typeof value === 'string' ? value : '';
}
