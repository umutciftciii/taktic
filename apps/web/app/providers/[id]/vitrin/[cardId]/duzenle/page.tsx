import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  apiFetch,
  fetchOrNotFound,
  getCurrentUser,
  SHOWCASE_CARD_KIND_LABELS,
  type ProviderProfile,
  type ShowcaseCard,
  type ShowcasePublicationList,
} from '../../../../../../lib/api';
import type { ProvinceWithDistricts } from '../../../../../../lib/locations';
import { ProviderShell } from '../../../../provider-shell';
import { readCreditBalance } from '../../../../provider-data';
import { ServiceAreaFields } from '../../../../service-area-fields';
import { updateShowcaseCardAction } from '../../actions';
import { SHOWCASE_ERROR_MESSAGES } from '../../showcase-errors';
import { editableVersion } from '../../showcase-ui';
import { EditShowcaseCardForm } from '../edit-card-form';

type EditShowcaseCardPageProps = {
  params: Promise<{ id: string; cardId: string }>;
  searchParams: Promise<{ error?: string }>;
};

/**
 * The card's edit screen: the same four groups as the create form, opened on
 * the text being written.
 *
 * A card under review, archived or suspended has nothing to edit here, and is
 * sent back to its own screen rather than shown a form the API would refuse.
 * A live card can be edited, and the one sentence at the top says what that
 * means: the change goes back through review, and what customers see does not
 * move until it is approved.
 */
export default async function EditShowcaseCardPage({ params, searchParams }: EditShowcaseCardPageProps) {
  const { id, cardId } = await params;
  const { error } = await searchParams;
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?redirectTo=/providers/${id}/vitrin/${cardId}/duzenle`);
  }

  const [provider, card, creditBalance, provinces, publication] = await Promise.all([
    fetchOrNotFound(() => apiFetch<ProviderProfile>(`/providers/${id}`)),
    fetchOrNotFound(() => apiFetch<ShowcaseCard>(`/providers/${id}/showcase/cards/${cardId}`)),
    readCreditBalance(id),
    apiFetch<ProvinceWithDistricts[]>('/locations/provinces'),
    apiFetch<ShowcasePublicationList>(`/providers/${id}/showcase/publication`).catch(() => null),
  ]);

  const cardHref = `/providers/${id}/vitrin/${cardId}`;
  if (provider.visibility === 'public') {
    redirect(`/providers/${id}/vitrin`);
  }

  const underReview = card.draftVersion?.reviewStatus === 'PENDING';
  const version = editableVersion(card);
  if (underReview || card.status === 'ARCHIVED' || card.status === 'SUSPENDED' || !version) {
    redirect(cardHref);
  }

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
        <Link href={`/providers/${id}/vitrin`}>Vitrin kartlarım</Link>
        <span aria-hidden="true">/</span>
        <Link href={cardHref}>{version.title}</Link>
        <span aria-hidden="true">/</span>
        <span>Düzenle</span>
      </nav>

      <header className="pdash-page-head">
        <span className="kicker">
          {SHOWCASE_CARD_KIND_LABELS[card.kind]} · {card.category.name}
        </span>
        <h1 className="pdash-page-title">Kartı düzenle</h1>
      </header>

      {error ? (
        <div className="pdash-notice pdash-notice-error" role="alert">
          {SHOWCASE_ERROR_MESSAGES[error] ?? SHOWCASE_ERROR_MESSAGES.SHOWCASE_SAVE_FAILED}
        </div>
      ) : null}
      {card.liveVersion ? (
        <div className="pdash-notice" role="status" data-testid="showcase-edit-live-notice">
          Değişiklikler yeniden incelemeye girer; yayındaki metin onaya kadar aynı kalır.
        </div>
      ) : null}

      <form action={updateShowcaseCardAction} className="vitrin-form" data-testid="showcase-edit-form">
        <input type="hidden" name="providerId" value={id} />
        <input type="hidden" name="cardId" value={cardId} />

        <EditShowcaseCardForm card={card} version={version} />

        <section className="vitrin-form-group" aria-labelledby="vitrin-grup-bolge">
          <div className="vitrin-form-group-head">
            <h2 id="vitrin-grup-bolge">Hizmet bölgeleri</h2>
            <p>Kart yalnızca işletme profilinizdeki hizmet bölgelerinin içinde kalan yerleri hedefleyebilir.</p>
          </div>
          <ServiceAreaFields
            provinces={provinces}
            defaultAreas={version.areas.map((area) => ({
              city: area.city,
              district: area.district,
              neighborhood: area.neighborhood,
            }))}
          />
        </section>

        <div className="vitrin-form-foot">
          <Link className="pdash-btn pdash-btn-ghost" href={cardHref}>
            Vazgeç
          </Link>
          <button className="pdash-btn pdash-btn-primary" type="submit" data-testid="showcase-edit-submit">
            Kaydet
          </button>
        </div>
      </form>
    </ProviderShell>
  );
}
