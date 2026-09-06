import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import {
  apiFetch,
  ProviderEnrollmentCategory,
  fetchOrNotFound,
  getCurrentUser,
  ProviderProfile,
} from '../../../../lib/api';
import type { ProvinceWithDistricts } from '../../../../lib/locations';
import { CityDistrictFields } from '../../city-district-fields';
import { ServiceAreaFields } from '../../service-area-fields';
import { updateProviderAction } from '../../actions';
import { ProviderShell } from '../../provider-shell';
import { readCreditBalance } from '../../provider-data';

type ProviderEditPageProps = {
  params: Promise<{ id: string }>;
};

export default async function ProviderEditPage({ params }: ProviderEditPageProps) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?redirectTo=/providers/${id}/edit`);
  }

  const [provider, categories, creditBalance, provinces] = await Promise.all([
    fetchOrNotFound(() => apiFetch<ProviderProfile>(`/providers/${id}`)),
    // The same enrollment catalogue the application form uses, so a provider
    // edits their scope within exactly the vocabulary they applied in.
    apiFetch<ProviderEnrollmentCategory[]>('/categories/provider-enrollment'),
    readCreditBalance(id),
    // The same canonical list the application form offers and the API validates
    // against, so an existing profile is edited within the same vocabulary.
    apiFetch<ProvinceWithDistricts[]>('/locations/provinces'),
  ]);

  // Editing needs the private projection (phone, e-mail, tax fields). A viewer
  // who only gets the public shape is not the owner and must not see this form.
  if (provider.visibility === 'public') {
    notFound();
  }
  // Only a claimed application carries a vouched-for address, and only that
  // address is frozen — see ensureContactEmailStable on the API side.
  const emailLocked = Boolean(provider.claimedAt);
  // Both lists, because this form replaces the whole selection. A draft the
  // provider signed up for lives in `upcomingServiceCategories` — leaving it
  // unticked here would drop it on the next save without anybody asking for it.
  const selectedCategoryIds = new Set([
    ...provider.serviceCategories.map((item) => item.category.id),
    ...(provider.upcomingServiceCategories ?? []).map((item) => item.category.id),
  ]);
  // Every stored area, in the order the API returns them, so the form opens on
  // exactly the coverage the profile has — and saving without touching this
  // section stores it back unchanged. Before multiple areas the screen showed
  // the first row only, which meant a provider with three areas silently lost
  // two of them on any profile save.
  const currentAreas = provider.serviceAreas.map((area) => ({
    city: area.city,
    district: area.district,
    neighborhood: area.neighborhood,
  }));

  return (
    <ProviderShell
      user={user}
      providerId={provider.id}
      businessName={provider.businessName}
      active="profile"
      creditBalance={creditBalance}
      status={provider.status}
    >
      <nav className="pdash-crumbs" aria-label="Breadcrumb">
        <Link href="/providers/me">Panelim</Link>
        <span aria-hidden="true">/</span>
        <Link href={`/providers/${provider.id}`}>İşletme profili</Link>
        <span aria-hidden="true">/</span>
        <span>Düzenle</span>
      </nav>

      <header className="pdash-page-head">
        <span className="kicker">İşletme profili</span>
        <h1 className="pdash-page-title">Profili düzenle</h1>
        <p className="pdash-page-sub">İşletme bilgilerinizi ve hizmet kapsamınızı güncelleyin.</p>
      </header>

      <form action={updateProviderAction} className="pdash-detail-card pdash-form">
        <input type="hidden" name="id" value={provider.id} />

        <section className="pdash-form-section">
          <h2>İşletme Bilgileri</h2>
          <div className="pdash-form-grid">
            <label className="pdash-form-row">
              <span>İşletme adı *</span>
              <input name="businessName" required defaultValue={provider.businessName} />
            </label>
            <label className="pdash-form-row">
              <span>Yetkili kişi *</span>
              <input name="contactName" required defaultValue={provider.contactName} />
            </label>
          </div>
          <label className="pdash-form-row">
            <span>Açıklama</span>
            <textarea name="description" defaultValue={provider.description ?? ''} />
          </label>
        </section>

        <section className="pdash-form-section">
          <h2>İletişim</h2>
          <div className="pdash-form-grid">
            <label className="pdash-form-row">
              <span>Telefon *</span>
              <input name="phone" required defaultValue={provider.phone} />
            </label>
            <label className="pdash-form-row">
              <span>E-posta</span>
              {/*
                Locked only for a claimed application, mirroring the API rule:
                that address is the one whose mailbox proved ownership. A profile
                created by an already-signed-in provider was never claimed and
                stays editable, including going from no address to one.

                Read-only rather than disabled, because a disabled field submits
                nothing and an absent address reads as a request to clear it.
              */}
              <input
                name="email"
                type="email"
                defaultValue={provider.email ?? ''}
                readOnly={emailLocked}
              />
              {emailLocked ? (
                <span className="muted" style={{ fontSize: 12 }}>
                  Başvuruyu sahiplenirken doğrulanan e-posta adresi değiştirilemez.
                </span>
              ) : null}
            </label>
          </div>
        </section>

        <section className="pdash-form-section">
          <h2>Merkez Adres</h2>
          <div className="pdash-form-grid">
            <CityDistrictFields
              provinces={provinces}
              cityName="city"
              districtName="district"
              defaultCity={provider.city}
              defaultDistrict={provider.district}
              labels={{ city: 'İl *', district: 'İlçe *' }}
            />
          </div>
          <label className="pdash-form-row">
            <span>Adres notu</span>
            <textarea name="addressNote" defaultValue={provider.addressNote ?? ''} />
          </label>
        </section>

        <section className="pdash-form-section">
          <h2>Hizmet Kategorileri</h2>
          <div className="provider-apply-categories">
            {categories.map((category) => (
              <label className="check-chip" key={category.id}>
                <input
                  name="categoryIds"
                  type="checkbox"
                  value={category.id}
                  defaultChecked={selectedCategoryIds.has(category.id)}
                />
                <span>{category.name}</span>
                {category.availability === 'UPCOMING' ? (
                  <span className="check-chip-note">Yakında açılacak</span>
                ) : null}
              </label>
            ))}
          </div>
        </section>

        <section className="pdash-form-section">
          <h2>Hizmet Bölgeleri</h2>
          <p className="pdash-form-hint">
            Talepler yalnızca buradaki bölgelerle eşleşir. Merkez adresiniz bir bölge sayılmaz —
            çalıştığınız her yeri ayrıca ekleyin.
          </p>
          {/* Optional district and neighbourhood, for the reason given on the
              application form: leaving a level out is how a provider says "the
              whole province" or "the whole district". */}
          <ServiceAreaFields provinces={provinces} defaultAreas={currentAreas} />
        </section>

        <div className="pdash-form-foot">
          <Link className="pdash-btn pdash-btn-secondary" href={`/providers/${provider.id}`}>
            Vazgeç
          </Link>
          <button className="pdash-btn pdash-btn-primary" type="submit">
            Profili Kaydet
          </button>
        </div>
      </form>
    </ProviderShell>
  );
}
