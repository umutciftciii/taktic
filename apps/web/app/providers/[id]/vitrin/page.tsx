import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  apiFetch,
  fetchOrNotFound,
  getCurrentUser,
  type ProviderProfile,
  type ShowcaseCard,
  type ShowcaseCardPublication,
  type ShowcasePublicationList,
} from '../../../../lib/api';
import { ShowcaseCardFace, faceFromVersion } from '../../../showcase-card-face';
import { ProviderShell } from '../../provider-shell';
import { readCreditBalance } from '../../provider-data';
import { SHOWCASE_ERROR_MESSAGES } from './showcase-errors';
import { showcaseStage } from './showcase-stage';
import { shownVersion } from './showcase-ui';
import { StageAction } from './stage-action';

type ShowcaseListPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; deleted?: string }>;
};

/** The states under which a card counts as "on the air" for the hub's grouping. */
const LIVE_STATES = new Set<ShowcaseCardPublication['state']>(['LIVE', 'ACTIVATING', 'PAUSED']);

/** The states in which the card's text cannot be touched: with an operator, or retired. */
const LOCKED_STATES = new Set<ShowcaseCardPublication['state']>(['IN_REVIEW', 'ARCHIVED', 'SUSPENDED']);

/**
 * The provider's vitrin: a shop window, not a record list.
 *
 * One number and one button at the top — how many rights are unspent and
 * what to do with them — and under it the cards exactly as a customer sees
 * them, each with a single human state and a single next step. Nothing here
 * names a version, a placement, a purchase or a review status.
 */
export default async function ShowcaseListPage({ params, searchParams }: ShowcaseListPageProps) {
  const { id } = await params;
  const { error, deleted } = await searchParams;
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?redirectTo=/providers/${id}/vitrin`);
  }

  const [provider, cards, creditBalance, publication] = await Promise.all([
    fetchOrNotFound(() => apiFetch<ProviderProfile>(`/providers/${id}`)),
    fetchOrNotFound(() => apiFetch<ShowcaseCard[]>(`/providers/${id}/showcase/cards`)),
    readCreditBalance(id),
    // A failure here leaves every card reading as a draft with its own screen
    // one click away, rather than breaking the hub.
    apiFetch<ShowcasePublicationList>(`/providers/${id}/showcase/publication`).catch(() => null),
  ]);

  const stateByCard = new Map(
    (publication?.cards ?? []).map((entry) => [entry.cardId, entry] as const),
  );
  const available = publication?.availableEntitlements ?? [];
  const hasAvailableRight = available.length > 0;
  // Cards the publication service dropped (discarded before ever going live) are not shown.
  const visible = cards.filter((card) => stateByCard.has(card.id) || !publication);
  const live = visible.filter((card) => LIVE_STATES.has(stateByCard.get(card.id)?.state ?? 'DRAFT'));
  const preparing = visible.filter((card) => !live.includes(card));
  const buyHref = `/providers/${id}/vitrin/paketler`;
  const createHref = `/providers/${id}/vitrin/yeni`;
  const gridProps = { stateByCard, providerId: id, hasAvailableRight };

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

      <header className="vitrin-hub-head">
        <div className="pdash-page-head" style={{ margin: 0 }}>
          <span className="kicker">Vitrin</span>
          <h1 className="pdash-page-title">Vitrinde yer alın</h1>
          <p className="pdash-page-sub">Hizmetlerinizi ana sayfada gösterin ve doğrudan talep alın.</p>
        </div>
        <div className="vitrin-counter" data-testid="showcase-entitlement-counter">
          <p className="vitrin-counter-text">
            {hasAvailableRight
              ? `${available.length} kullanılabilir vitrin hakkınız var`
              : 'Kullanılabilir vitrin hakkınız yok'}
          </p>
          {hasAvailableRight ? (
            <Link className="pdash-btn pdash-btn-primary" href={createHref} data-testid="showcase-create-card">
              Vitrin kartını oluştur
            </Link>
          ) : (
            <Link className="pdash-btn pdash-btn-primary" href={buyHref} data-testid="showcase-buy-package">
              Vitrin paketi al
            </Link>
          )}
        </div>
      </header>

      {error ? (
        <div className="pdash-notice pdash-notice-error" role="alert">
          {SHOWCASE_ERROR_MESSAGES[error] ?? SHOWCASE_ERROR_MESSAGES.SHOWCASE_SAVE_FAILED}
        </div>
      ) : null}
      {deleted ? (
        <div className="pdash-notice" role="status">
          Kart silindi ve vitrin hakkınız yeniden kullanılabilir.
        </div>
      ) : null}

      {visible.length === 0 ? (
        <div className="vitrin-empty" data-testid="showcase-empty">
          <p style={{ margin: 0, maxWidth: '52ch' }}>
            Vitrin kartınız, hizmetinizi ana sayfada herkese gösterir; karttan gelen talepler yalnız size iletilir ve
            teklif kredisi harcamaz. Başlamak için bir vitrin paketi alın.
          </p>
          {hasAvailableRight ? (
            <Link className="pdash-btn pdash-btn-primary" href={createHref}>Vitrin kartını oluştur</Link>
          ) : (
            <Link className="pdash-btn pdash-btn-primary" href={buyHref}>Vitrin paketi al</Link>
          )}
        </div>
      ) : (
        <>
          {live.length > 0 ? (
            <>
              <h2 className="vitrin-section-title">Yayında</h2>
              <CardGrid cards={live} {...gridProps} />
            </>
          ) : null}
          {preparing.length > 0 ? (
            <>
              <h2 className="vitrin-section-title">Hazırlık</h2>
              <CardGrid cards={preparing} {...gridProps} />
            </>
          ) : null}
        </>
      )}
    </ProviderShell>
  );
}

/**
 * One group of cards, each drawn exactly as a customer sees it, with its state
 * badge over the picture and its single next step underneath.
 */
function CardGrid({
  cards,
  stateByCard,
  providerId,
  hasAvailableRight,
}: {
  cards: ShowcaseCard[];
  stateByCard: Map<string, ShowcaseCardPublication>;
  providerId: string;
  hasAvailableRight: boolean;
}) {
  return (
    <div className="vitrin-grid" data-testid="showcase-card-list">
      {cards.map((card) => {
        const shown = shownVersion(card);
        const entry = stateByCard.get(card.id);
        const stage = showcaseStage(entry, { providerId, cardId: card.id, hasAvailableRight });
        const cardHref = `/providers/${providerId}/vitrin/${card.id}`;
        // No edit link on a card that cannot be edited, and none beside a
        // primary action that already opens the editor.
        const editHref = `${cardHref}/duzenle`;
        const canEdit =
          !LOCKED_STATES.has(entry?.state ?? 'DRAFT') &&
          !(stage.action?.kind === 'link' && stage.action.href === editHref);
        return (
          <div key={card.id} data-testid="showcase-card" data-state={entry?.state ?? 'DRAFT'}>
            <ShowcaseCardFace
              compact
              href={cardHref}
              badge={<span className={`vitrin-badge vitrin-badge-${stage.badge}`}>{stage.label}</span>}
              card={
                shown
                  ? faceFromVersion(card, shown)
                  : {
                      kind: card.kind,
                      categoryName: card.category.name,
                      categorySlug: card.category.slug,
                      title: 'Adsız kart',
                      summary: '',
                      imageUrl: null,
                      areaLabels: [],
                    }
              }
            />
            <div className="vitrin-card-foot">
              {stage.detail ? <p className="muted">{stage.detail}</p> : null}
              <StageAction stage={stage} providerId={providerId} cardId={card.id} />
              {canEdit ? (
                <Link className="pdash-btn pdash-btn-ghost pdash-btn-sm" href={editHref}>
                  Kartı düzenle
                </Link>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
