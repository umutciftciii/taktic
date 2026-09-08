import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  apiFetch,
  fetchOrNotFound,
  getCurrentUser,
  type ProviderProfile,
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
 * A new vitrin card.
 *
 * The category list offered here is the provider's own — the categories they are
 * actually enrolled in — rather than the whole catalogue. A card advertising a
 * service the business has not signed up for is not a card an operator would
 * approve, and offering it would be inviting a rejection the form could have
 * prevented. (The API does not enforce that link; see the phase-one notes.)
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

  const [provider, creditBalance, provinces] = await Promise.all([
    fetchOrNotFound(() => apiFetch<ProviderProfile>(`/providers/${id}`)),
    readCreditBalance(id),
    apiFetch<ProvinceWithDistricts[]>('/locations/provinces'),
  ]);

  // The private projection carries the provider's own categories and areas. A
  // viewer who only gets the public shape is not the owner and has no business
  // on this form.
  if (provider.visibility === 'public') {
    redirect(`/providers/${id}/vitrin`);
  }

  const categories = provider.serviceCategories.map((entry) => entry.category);

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
        <Link href={`/providers/${id}/vitrin`}>Vitrin kartlarım</Link>
        <span aria-hidden="true">/</span>
        <span>Yeni kart</span>
      </nav>

      <header className="pdash-page-head">
        <span className="kicker">Vitrin</span>
        <h1 className="pdash-page-title">Yeni vitrin kartı</h1>
        <p className="pdash-page-sub">
          Kartı önce taslak olarak kaydedersiniz. İncelemeye göndermeden hiçbir şey yayına
          hazır sayılmaz.
        </p>
      </header>

      {error ? (
        <div className="pdash-notice pdash-notice-error" role="alert">
          {SHOWCASE_ERROR_MESSAGES[error] ?? SHOWCASE_ERROR_MESSAGES.SHOWCASE_SAVE_FAILED}
        </div>
      ) : null}

      {categories.length === 0 ? (
        <div className="pdash-detail-card">
          <p className="muted">
            Vitrin kartı açmak için önce işletme profilinizde en az bir hizmet kategorisi
            seçmelisiniz.
          </p>
          <div className="pdash-form-foot">
            <Link className="pdash-btn pdash-btn-primary" href={`/providers/${id}/edit`}>
              İşletme profilini düzenle
            </Link>
          </div>
        </div>
      ) : (
        <form action={createShowcaseCardAction} className="pdash-detail-card pdash-form">
          <input type="hidden" name="providerId" value={id} />

          <section className="pdash-form-section">
            <h2>Hizmet kategorisi</h2>
            <p className="pdash-form-hint">
              Kategori kart oluşturulduktan sonra değiştirilemez. Farklı bir kategori için yeni
              kart açın.
            </p>
            <label className="pdash-form-row">
              <span>Kategori *</span>
              <select name="categoryId" required defaultValue="">
                <option value="" disabled>
                  Seçiniz
                </option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </label>
          </section>

          <NewShowcaseCardForm />

          <section className="pdash-form-section">
            <h2>Kartın bölgeleri</h2>
            <p className="pdash-form-hint">
              Kart yalnızca işletme profilinizdeki hizmet bölgelerinin içinde kalan yerleri
              hedefleyebilir. Bölge eklemek yönetim onayı gerektirir; daraltmak gerektirmez.
            </p>
            <ServiceAreaFields provinces={provinces} />
          </section>

          <div className="pdash-form-foot">
            <Link className="pdash-btn pdash-btn-secondary" href={`/providers/${id}/vitrin`}>
              Vazgeç
            </Link>
            <button className="pdash-btn pdash-btn-primary" type="submit">
              Taslağı kaydet
            </button>
          </div>
        </form>
      )}
    </ProviderShell>
  );
}
