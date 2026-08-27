import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  formatDateTime,
  formatPrice,
  getCurrentUser,
  statusLabel,
} from '../../../lib/api';
import { IconArrowRight, IconPlus } from '../../landing-icons';
import { CustomerShell } from '../customer-shell';
import { loadCustomerOffers, loadCustomerRequests } from '../customer-panel-data';

/**
 * Every offer the customer has received, across all of their requests.
 *
 * The sidebar's "Teklifler" entry pointed at /requests/my — the same href as
 * "Taleplerim" — so on the requests screen it navigated to the page already
 * open. Nothing moved, and in Safari nothing at all happened. This is the
 * screen it should have led to: the same offers the counter counts, read
 * through the endpoints that already served them per request.
 */
export default async function CustomerOffersPage() {
  const user = await getCurrentUser();
  if (!user || user.role !== 'CUSTOMER') {
    redirect('/login?redirectTo=/requests/offers');
  }

  const requests = await loadCustomerRequests();
  const entries = await loadCustomerOffers(requests);

  return (
    <CustomerShell user={user} active="offers">
      <header className="cdash-page-head">
        <div className="panel-head-row">
          <div>
            <span className="kicker">Genel bakış</span>
            <h1 className="cdash-page-title">Teklifler</h1>
            <p className="cdash-page-sub">
              Tüm taleplerinize gelen teklifleri buradan görebilirsiniz.
            </p>
          </div>
          <Link className="cdash-btn cdash-btn-primary" href="/categories">
            <IconPlus size={14} />
            Yeni Talep
          </Link>
        </div>
      </header>

      {entries.length === 0 ? (
        <div className="cdash-empty">
          <h3>Henüz teklif yok</h3>
          <p>
            Talepleriniz hizmet verenlere ulaştığında gelen teklifler burada listelenir.
          </p>
          <Link className="cdash-btn cdash-btn-secondary" href="/requests/my">
            Taleplerime git
          </Link>
        </div>
      ) : (
        <ul className="cdash-history" data-testid="customer-offer-list">
          {entries.map(({ offer, request }) => (
            <li className="cdash-history-item" key={offer.id}>
              <span className="tag tag-neutral">{statusLabel(offer.status)}</span>
              <span className="cdash-history-name">{offer.provider.businessName}</span>
              <span className="cdash-history-time">
                {request.category.name} ·{' '}
                {request.requestNumber ?? `#${request.id.slice(-6).toUpperCase()}`} ·{' '}
                {formatDateTime(offer.submittedAt)}
              </span>
              <strong>{formatPrice(offer.priceAmount, offer.currency)}</strong>
              <Link
                className="cdash-btn cdash-btn-secondary"
                href={`/requests/${request.id}/offers/${offer.id}`}
              >
                Teklifi gör
                <IconArrowRight size={14} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </CustomerShell>
  );
}
