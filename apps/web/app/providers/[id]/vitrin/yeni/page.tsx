import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  apiFetch,
  fetchOrNotFound,
  getCurrentUser,
  SHOWCASE_CARD_KIND_LABELS,
  type ProviderProfile,
  type ShowcaseEligibleCategories,
  type ShowcaseEntitlementSummary,
  type ShowcasePublicationList,
} from '../../../../../lib/api';
import type { ProvinceWithDistricts } from '../../../../../lib/locations';
import { ProviderShell } from '../../../provider-shell';
import { readCreditBalance } from '../../../provider-data';
import { ServiceAreaFields } from '../../../service-area-fields';
import { createShowcaseCardAction } from '../actions';
import { NewShowcaseCardForm } from './new-card-form';
import { SHOWCASE_ERROR_MESSAGES } from '../showcase-errors';

type NewShowcaseCardPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
};

/**
 * A new vitrin card, written against a right the business already holds.
 *
 * The package comes first: a provider with nothing to publish under is sent
 * to the shop rather than shown a form whose last step would refuse them.
 * With exactly one kind of right on hand the screen states which one it will
 * use; with several it asks. Either way the card is bound on save and goes on
 * the air the moment an operator approves it, which is what the subtitle says.
 *
 * The categories on offer come from the API, per card kind: the provider's own
 * leaves that can take a request, and — for a general card — every open group
 * above them. The write endpoint re-derives the same rule and refuses anything
 * outside it, so the list is a convenience rather than the authority.
 *
 * The areas use the same picker and the same `serviceAreas` field the profile
 * form uses, so a provider adds a card's coverage in exactly the vocabulary they
 * added their business's.
 */
export default async function NewShowcaseCardPage({
  params,
  searchParams,
}: NewShowcaseCardPageProps) {
  const { id } = await params;
  const { error } = await searchParams;
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?redirectTo=/providers/${id}/vitrin/yeni`);
  }

  const [provider, categories, creditBalance, provinces, publication] = await Promise.all([
    fetchOrNotFound(() => apiFetch<ProviderProfile>(`/providers/${id}`)),
    fetchOrNotFound(() =>
      apiFetch<ShowcaseEligibleCategories>(
        `/providers/${id}/showcase/cards/eligible-categories`,
      ),
    ),
    readCreditBalance(id),
    apiFetch<ProvinceWithDistricts[]>('/locations/provinces'),
    fetchOrNotFound(() =>
      apiFetch<ShowcasePublicationList>(`/providers/${id}/showcase/publication`),
    ),
  ]);

  // The private projection carries the provider's own categories and areas. A
  // viewer who only gets the public shape is not the owner and has no business
  // on this form.
  if (provider.visibility === 'public') {
    redirect(`/providers/${id}/vitrin`);
  }

  const rights = publication.availableEntitlements;
  if (rights.length === 0) {
    redirect(`/providers/${id}/vitrin/paketler`);
  }
  // One radio per distinct package, not per right: two identical rights are
  // not a choice, and the API binds the oldest usable one itself.
  const choices = distinctPackages(rights);
  const first = choices[0] ?? rights[0]!;

  const noCategory = categories.service.length === 0 && categories.promotion.length === 0;

  return (
    <ProviderShell
      user={user}
      providerId={id}
      businessName={provider.businessName}
      active="showcase"
      creditBalance={creditBalance}
      status={provider.status}
      hasShowcaseHistory={publication.hasPublicationHistory}
    >
      <nav className="pdash-crumbs" aria-label="Breadcrumb">
        <Link href="/providers/me">Panelim</Link>
        <span aria-hidden="true">/</span>
        <Link href={`/providers/${id}/vitrin`}>Vitrin kartlarım</Link>
        <span aria-hidden="true">/</span>
        <span>Yeni kart</span>
      </nav>

      <header className="pdash-page-head">
        <span className="kicker">Vitrin</span>
        <h1 className="pdash-page-title">Vitrin kartını oluştur</h1>
        <p className="pdash-page-sub">Kart onaylanınca otomatik yayına girer.</p>
      </header>

      {error ? (
        <div className="pdash-notice pdash-notice-error" role="alert">
          {SHOWCASE_ERROR_MESSAGES[error] ?? SHOWCASE_ERROR_MESSAGES.SHOWCASE_SAVE_FAILED}
        </div>
      ) : null}

      {noCategory ? (
        <div className="pdash-detail-card">
          <p className="muted">
            Vitrin kartı açmak için önce işletme profilinizde talep alabilen en az bir hizmet
            kategorisi seçmelisiniz.
          </p>
          <div className="pdash-form-foot">
            <Link className="pdash-btn pdash-btn-primary" href={`/providers/${id}/edit`}>
              İşletme profilini düzenle
            </Link>
          </div>
        </div>
      ) : (
        <form action={createShowcaseCardAction} className="vitrin-form">
          <input type="hidden" name="providerId" value={id} />

          <div className="vitrin-form-group">
            <div className="pdash-notice" role="status" data-testid="showcase-entitlement-in-use">
              {choices.length === 1
                ? `Bu kart ${first.packageName} hakkınızla oluşturulacak · ${first.durationDays} gün yayın`
                : 'Kullanılacak hakkı seçin:'}
            </div>
            {choices.length > 1 ? (
              <div className="vitrin-choice-row" role="radiogroup" aria-label="Kullanılacak vitrin hakkı">
                {choices.map((right, index) => (
                  <label className="vitrin-choice" key={right.id}>
                    <input
                      type="radio"
                      name="entitlementId"
                      value={right.id}
                      defaultChecked={index === 0}
                      required
                    />
                    <span>
                      {right.packageName} · {right.durationDays} gün
                      {right.allowedCardKind
                        ? ` · yalnız ${SHOWCASE_CARD_KIND_LABELS[right.allowedCardKind].toLocaleLowerCase('tr-TR')}`
                        : ''}
                    </span>
                  </label>
                ))}
              </div>
            ) : null}
          </div>

          <NewShowcaseCardForm categories={categories} />

          <section className="vitrin-form-group" aria-labelledby="vitrin-grup-bolge">
            <div className="vitrin-form-group-head">
              <h2 id="vitrin-grup-bolge">Bölgeler</h2>
              <p>Kart yalnızca işletme profilinizdeki hizmet bölgelerinin içinde kalan yerleri hedefleyebilir.</p>
            </div>
            <ServiceAreaFields provinces={provinces} />
          </section>

          <div className="vitrin-form-foot">
            <Link className="pdash-btn pdash-btn-ghost" href={`/providers/${id}/vitrin`}>
              Vazgeç
            </Link>
            <button className="pdash-btn pdash-btn-primary" type="submit" data-testid="showcase-create-submit">
              Kartı oluştur
            </button>
          </div>
        </form>
      )}
    </ProviderShell>
  );
}

/** The first right of each package on hand, in the order the API listed them. */
function distinctPackages(rights: ShowcaseEntitlementSummary[]): ShowcaseEntitlementSummary[] {
  const seen = new Set<string>();
  const out: ShowcaseEntitlementSummary[] = [];
  for (const right of rights) {
    const key = `${right.packageName}|${right.durationDays}|${right.allowedCardKind ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(right);
  }
  return out;
}
