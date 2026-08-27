import Link from 'next/link';
import { redirect } from 'next/navigation';
import { formatDateTime, formatPrice, getCurrentUser } from '../../../lib/api';
import { IconArrowRight, IconPlus } from '../../landing-icons';
import { CustomerShell } from '../customer-shell';
import { loadCustomerMatches, loadCustomerRequests } from '../customer-panel-data';

/**
 * The customer's matched jobs.
 *
 * "Eşleşmelerim" in the sidebar pointed at /requests/my — the same href as
 * "Taleplerim" — which is the defect the offers entry had: on the requests
 * screen the link led to the page already open, so nothing happened at all.
 * This is the screen it should have led to.
 *
 * Everything here is read from the two endpoints that already serve it, and
 * "matched" means exactly what the sidebar counter means: a request in MATCHED.
 * No new endpoint, no query parameter, no state rule of its own.
 */
export default async function CustomerMatchesPage() {
  const user = await getCurrentUser();
  if (!user || user.role !== 'CUSTOMER') {
    redirect('/login?redirectTo=/requests/matches');
  }

  const requests = await loadCustomerRequests();
  const matches = await loadCustomerMatches(requests);

  return (
    <CustomerShell user={user} active="matches">
      <header className="cdash-page-head">
        <div className="panel-head-row">
          <div>
            <span className="kicker">Genel bakış</span>
            <h1 className="cdash-page-title">Eşleşmelerim</h1>
            <p className="cdash-page-sub">
              Teklifini kabul ettiğiniz işler burada listelenir.
            </p>
          </div>
          <Link className="cdash-btn cdash-btn-primary" href="/categories">
            <IconPlus size={14} />
            Yeni Talep
          </Link>
        </div>
      </header>

      {matches.length === 0 ? (
        <div className="cdash-empty">
          <h3>Henüz eşleşme yok</h3>
          <p>
            Bir teklifi kabul ettiğinizde talebiniz eşleşir ve hizmet verenin iletişim bilgileri
            talep ekranınızda görünür.
          </p>
          <Link className="cdash-btn cdash-btn-secondary" href="/requests/offers">
            Gelen teklifleri gör
          </Link>
        </div>
      ) : (
        <ul className="cdash-history" data-testid="customer-match-list">
          {matches.map(({ request, acceptedOffer }) => (
            <li className="cdash-history-item" key={request.id}>
              <span className="tag tag-ink">Eşleşti</span>
              <span className="cdash-history-name">
                {acceptedOffer?.provider.businessName ?? request.category.name}
              </span>
              <span className="cdash-history-time">
                {request.category.name} ·{' '}
                {request.requestNumber ?? `#${request.id.slice(-6).toUpperCase()}`} ·{' '}
                {request.city}, {request.district} · {formatDateTime(request.submittedAt)}
              </span>
              {acceptedOffer ? (
                <strong>{formatPrice(acceptedOffer.priceAmount, acceptedOffer.currency)}</strong>
              ) : null}
              {/*
                The request screen, which is where a matched request's contact
                details and its completion action already live.
              */}
              <Link className="cdash-btn cdash-btn-primary" href={`/requests/${request.id}/offers`}>
                Talebi aç
                <IconArrowRight size={14} />
              </Link>
              {acceptedOffer ? (
                <Link
                  className="cdash-btn cdash-btn-secondary"
                  href={`/requests/${request.id}/offers/${acceptedOffer.id}`}
                >
                  Kabul edilen teklif
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </CustomerShell>
  );
}
