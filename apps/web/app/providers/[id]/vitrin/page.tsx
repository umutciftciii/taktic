import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  apiFetch,
  fetchOrNotFound,
  formatDateTime,
  formatPrice,
  getCurrentUser,
  SHOWCASE_CARD_KIND_LABELS,
  SHOWCASE_CARD_STATUS_LABELS,
  type ProviderProfile,
  type ShowcaseCard,
} from '../../../../lib/api';
import { ProviderShell } from '../../provider-shell';
import { readCreditBalance } from '../../provider-data';
import { showcaseCardSituation, showcaseStatusBadgeClass } from './showcase-ui';

type ShowcaseListPageProps = {
  params: Promise<{ id: string }>;
};

/**
 * The provider's vitrin cards.
 *
 * The list answers one question per row — where does this card stand — and hands
 * the provider to the card itself to do anything about it. Every row carries the
 * pair of versions rather than a single "current" one, because "onaylı, yeni
 * sürüm incelemede" is the state a provider most needs to be able to see and the
 * one a single status cannot express.
 *
 * Nothing on this screen says a card is visible to customers, because in this
 * phase none is: an approved card is a reviewed text, and the surface that would
 * render it does not exist yet. The wording is "yayına hazır" throughout.
 */
export default async function ShowcaseListPage({ params }: ShowcaseListPageProps) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?redirectTo=/providers/${id}/vitrin`);
  }

  const [provider, cards, creditBalance] = await Promise.all([
    fetchOrNotFound(() => apiFetch<ProviderProfile>(`/providers/${id}`)),
    fetchOrNotFound(() => apiFetch<ShowcaseCard[]>(`/providers/${id}/showcase/cards`)),
    readCreditBalance(id),
  ]);

  return (
    <ProviderShell
      user={user}
      providerId={id}
      businessName={provider.businessName}
      active="showcase"
      creditBalance={creditBalance}
      status={provider.status}
    >
      <nav className="pdash-crumbs" aria-label="Breadcrumb">
        <Link href="/providers/me">Panelim</Link>
        <span aria-hidden="true">/</span>
        <span>Vitrin kartlarım</span>
      </nav>

      <header className="pdash-page-head">
        <span className="kicker">Vitrin</span>
        <h1 className="pdash-page-title">Vitrin kartlarım</h1>
        <p className="pdash-page-sub">
          Her kart, hizmet bölgelerinizin içinde kalan bir tanıtımdır. İlk yayın ve her içerik
          değişikliği yönetim onayından geçer; yalnızca bölge daraltma onaysız uygulanır.
        </p>
      </header>

      <div className="pdash-form-foot" style={{ justifyContent: 'flex-start' }}>
        <Link className="pdash-btn pdash-btn-primary" href={`/providers/${id}/vitrin/yeni`}>
          Yeni vitrin kartı
        </Link>
      </div>

      {cards.length === 0 ? (
        <div className="pdash-detail-card">
          <p className="muted">
            Henüz vitrin kartınız yok. Yeni bir kart açıp incelemeye gönderdiğinizde durumu bu
            listede görürsünüz.
          </p>
        </div>
      ) : (
        /*
          A table inside `.pdash-table-card > .pdash-table-scroll`, which is the
          pattern that keeps five columns from widening the document itself on a
          320px phone: the scroll belongs to the box, not to the page.
        */
        <div className="pdash-table-card">
          <div className="pdash-table-scroll">
            <table className="pdash-table">
              <thead>
                <tr>
                  <th>Kart</th>
                  <th>Tür</th>
                  <th>Hizmet bedeli</th>
                  <th>Durum</th>
                  <th>Güncelleme</th>
                </tr>
              </thead>
              <tbody>
                {cards.map((card) => {
                  const shown = card.liveVersion ?? card.draftVersion;
                  const price = shown?.listedServicePriceAmount;
                  return (
                    <tr key={card.id}>
                      <td>
                        <Link href={`/providers/${id}/vitrin/${card.id}`}>
                          {shown?.title ?? 'Adsız kart'}
                        </Link>
                        <div className="muted" style={{ fontSize: 12 }}>
                          {card.category.name}
                        </div>
                        <div className="muted" style={{ fontSize: 12 }}>
                          {showcaseCardSituation(card)}
                        </div>
                      </td>
                      <td>{SHOWCASE_CARD_KIND_LABELS[card.kind]}</td>
                      <td>
                        {typeof price === 'number'
                          ? formatPrice(price, shown?.listedServiceCurrency ?? 'TRY')
                          : '—'}
                      </td>
                      <td>
                        <span className={showcaseStatusBadgeClass(card.status)}>
                          {SHOWCASE_CARD_STATUS_LABELS[card.status]}
                        </span>
                      </td>
                      <td>{formatDateTime(card.updatedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </ProviderShell>
  );
}
