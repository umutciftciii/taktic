import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  apiFetch,
  fetchOrNotFound,
  formatPrice,
  getCurrentUser,
  SHOWCASE_CARD_KIND_LABELS,
  type ProviderProfile,
  type ShowcaseCard,
  type ShowcasePublicationList,
} from '../../../../lib/api';
import { ProviderShell } from '../../provider-shell';
import { readCreditBalance } from '../../provider-data';
import { showcaseStage, showcaseStageBadgeClass } from './showcase-stage';

type ShowcaseListPageProps = {
  params: Promise<{ id: string }>;
};

/**
 * The provider's vitrin cards.
 *
 * ## One state and one action per card
 *
 * The list used to be a five-column table of card, kind, price, status and
 * updated-at, with a sentence underneath each row about which version numbers
 * were where. Every column was true and the row as a whole answered nothing: a
 * provider looking at it could not tell whether their card was on the air,
 * whether anybody was waiting on them, or what to press.
 *
 * So each row now says one thing about where the card stands and offers the one
 * next step — "İncelemeye gönder", "Vitrine çıkar", "Ödemeye devam et",
 * "Yayında · 12 Ekim 2026". The resolution happens on the server, once, in
 * `ShowcasePublicationService`, because the four sources it used to be
 * assembled from could — and did — disagree.
 *
 * ## What is deliberately not on this screen
 *
 * Placement ids, version numbers, review-status enums, the terms-acceptance
 * ledger. None of them is something a provider acts on, and every one of them
 * is something that turns into a support conversation the moment it is visible.
 */
export default async function ShowcaseListPage({ params }: ShowcaseListPageProps) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?redirectTo=/providers/${id}/vitrin`);
  }

  const [provider, cards, creditBalance, publication] = await Promise.all([
    fetchOrNotFound(() => apiFetch<ProviderProfile>(`/providers/${id}`)),
    fetchOrNotFound(() => apiFetch<ShowcaseCard[]>(`/providers/${id}/showcase/cards`)),
    readCreditBalance(id),
    // A failure here leaves every card reading as a draft with its own screen
    // one click away, rather than breaking the list. The card screen carries the
    // authoritative answer either way.
    apiFetch<ShowcasePublicationList>(`/providers/${id}/showcase/publication`).catch(() => null),
  ]);

  const stateByCard = new Map(
    (publication?.cards ?? []).map((entry) => [entry.cardId, entry] as const),
  );

  return (
    <ProviderShell
      user={user}
      providerId={id}
      businessName={provider.businessName}
      active="showcase"
      creditBalance={creditBalance}
      status={provider.status}
      hasShowcaseHistory={publication?.hasPublicationHistory ?? false}
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
          Vitrin kartınız, hizmet bölgelerinizin içinde kalan bir hizmeti ana sayfada herkese
          gösterir. Karttan gelen talepler yalnız size iletilir ve bu talepler için teklif
          kredisi harcanmaz.
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
        <div className="showcase-stage-list" data-testid="showcase-card-list">
          {cards.map((card) => {
            const shown = card.liveVersion ?? card.draftVersion;
            const price = shown?.listedServicePriceAmount;
            const cardHref = `/providers/${id}/vitrin/${card.id}`;
            const entry = stateByCard.get(card.id);
            const stage = showcaseStage(entry, cardHref, id);

            return (
              <article className="showcase-stage-card" key={card.id}>
                <div className="showcase-stage-head">
                  <span className="kicker">
                    {SHOWCASE_CARD_KIND_LABELS[card.kind]} · {card.category.name}
                  </span>
                  <h2 className="showcase-stage-title">
                    <Link href={cardHref}>{shown?.title ?? 'Adsız kart'}</Link>
                  </h2>
                  {typeof price === 'number' ? (
                    <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                      Hizmet bedeli: {formatPrice(price, shown?.listedServiceCurrency ?? 'TRY')}
                    </p>
                  ) : null}
                </div>

                <div>
                  <span className={showcaseStageBadgeClass(entry)}>{stage.label}</span>
                  {stage.detail ? (
                    <p className="showcase-stage-state muted" style={{ marginTop: 8 }}>
                      {stage.detail}
                    </p>
                  ) : null}
                  {/*
                    The one situation a single state genuinely cannot express:
                    a card that is on the air while its replacement is with an
                    operator. Said as a sentence rather than as a second badge.
                  */}
                  {entry?.hasPendingRevision ? (
                    <p className="muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
                      Yaptığınız değişiklik incelemede. Yayındaki metin şimdilik aynı kalıyor.
                    </p>
                  ) : null}
                  {entry?.state === 'LIVE' && entry.areaLabels.length > 0 ? (
                    <p className="muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
                      Hizmet bölgesi: {entry.areaLabels.join(' · ')}
                    </p>
                  ) : null}
                </div>

                <div className="showcase-stage-foot">
                  {stage.action ? (
                    <Link className="pdash-btn pdash-btn-primary" href={stage.action.href}>
                      {stage.action.label}
                    </Link>
                  ) : null}
                  <Link className="pdash-btn pdash-btn-ghost" href={cardHref}>
                    Kartı aç
                  </Link>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </ProviderShell>
  );
}
