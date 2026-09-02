import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  apiFetch,
  getCurrentUser,
  ProviderDashboard,
  ProviderEnrollmentCategory,
} from '../../../lib/api';
import type { ProvinceWithDistricts } from '../../../lib/locations';
import { ProviderApplicationFields } from '../provider-application-fields';
import { CategoryVisual } from '../../category-visual';
import { isProviderClaimEnabled } from '../../../lib/provider-claim';
import { IconArrowRight } from '../../landing-icons';
import { createProviderAction } from '../actions';

type ProviderRegisterPageProps = {
  searchParams: Promise<{ error?: string }>;
};

const APPROVAL_STEPS = [
  {
    title: 'Başvuru alınır',
    desc: 'İşletme bilgileri, hizmet kapsamı ve bölgen kaydedilir.',
  },
  {
    title: 'Ön inceleme',
    desc: 'Ekibimiz başvuruyu inceler; eksik bilgi varsa iletişime geçilir.',
  },
  {
    title: 'Onay ve teklif',
    desc: 'Onaydan sonra bölgene ve kategorilerine uyan talepler panelinde görünür.',
  },
];

export default async function ProviderApplyPage({ searchParams }: ProviderRegisterPageProps) {
  const [{ error }, categories, user, provinces] = await Promise.all([
    searchParams,
    // The enrollment catalogue, not the customer one. It carries the services
    // an operator has opened to applications — including ones the marketplace
    // has not released yet, which is the whole reason a repairer whose trade is
    // in the next wave can apply at all.
    apiFetch<ProviderEnrollmentCategory[]>('/categories/provider-enrollment'),
    getCurrentUser(),
    // The canonical province/district list, from the same API that validates
    // the submitted application.
    apiFetch<ProvinceWithDistricts[]>('/locations/provinces'),
  ]);

  // An account owns at most one provider profile, so a provider who already has
  // one would only hit a 409 on submit. Send them to their panel instead.
  if (user?.role === 'PROVIDER') {
    const existingProviderId = await apiFetch<ProviderDashboard>('/providers/me/dashboard')
      .then((dashboard) => dashboard.provider?.id ?? null)
      .catch(() => null);

    if (existingProviderId) {
      redirect('/providers/me');
    }
  }

  // A guest application has to be reachable while the claim flow is on: the
  // link mailed to this address is the only thing that can hand the application
  // back to whoever submitted it. A provider who is signed in already owns
  // whatever they create, so nothing about their form changes.
  const emailRequired = isProviderClaimEnabled() && user?.role !== 'PROVIDER';
  const firstCategory = categories[0] ?? null;

  return (
    <div className="provider-apply-shell">
      <section className="provider-apply-hero">
        <div className="lp-container">
          <nav className="breadcrumbs provider-apply-breadcrumbs" aria-label="Breadcrumb">
            <Link href="/">Ana sayfa</Link>
            <span aria-hidden="true">/</span>
            <span>Hizmet Veren Başvurusu</span>
          </nav>
          <span className="kicker">Hizmet veren ol</span>
          <h1 className="provider-apply-title">Hizmet Veren Başvurusu</h1>
          <p>
            İşletme bilgilerinizi paylaşın, hizmet kategorilerinizi ve bölgenizi seçin. Onay
            sonrasında eşleşen taleplere teklif vermeye başlayabilirsiniz.
          </p>
        </div>
      </section>

      <div className="provider-apply-container">
        {error === 'email' ? (
          <div className="provider-apply-notice is-warning" role="alert">
            <span className="provider-apply-notice-icon" aria-hidden="true">!</span>
            <span>Geçerli bir e-posta adresi girin; başvurunuzu bu adrese bağlayacağız.</span>
          </div>
        ) : null}

        {error === 'role-conflict' ? (
          <div className="provider-apply-notice is-warning" role="alert">
            <span className="provider-apply-notice-icon" aria-hidden="true">!</span>
            <span>
              Bu e-posta başka türde bir hesap için kullanılıyor. Başvurunuz için farklı bir
              e-posta adresi girin.
            </span>
          </div>
        ) : null}

        {!user ? (
          <div className="provider-apply-notice" role="status">
            <span className="provider-apply-notice-icon" aria-hidden="true">i</span>
            <span>
              {emailRequired ? (
                <>
                  Misafir başvuru hâlâ açık. Başvurunuzu tamamladıktan sonra e-posta adresinize bir
                  bağlantı göndereceğiz; o bağlantıyla başvurunuzu kendi hesabınıza bağlayabilirsiniz.
                  Dilerseniz önce{' '}
                  <Link href="/register/provider">hizmet veren hesabı oluşturabilirsiniz</Link>.
                </>
              ) : (
                <>
                  Misafir başvuru hâlâ açık. Başvurunuzu hesabınıza bağlamak için önce{' '}
                  <Link href="/register/provider">hizmet veren hesabı oluşturabilirsiniz</Link>.
                </>
              )}
            </span>
          </div>
        ) : null}
        {user?.role === 'PROVIDER' ? (
          <div className="provider-apply-notice" role="status">
            <span className="provider-apply-notice-icon" aria-hidden="true">i</span>
            <span>Bu başvuru hizmet veren hesabınıza bağlanacak.</span>
          </div>
        ) : null}
        {user?.role === 'CUSTOMER' ? (
          <div className="provider-apply-notice is-warning" role="status">
            <span className="provider-apply-notice-icon" aria-hidden="true">!</span>
            <span>Müşteri hesabıyla hizmet veren profili oluşturulamaz.</span>
          </div>
        ) : null}

        <div className="provider-apply-body">
          <form action={createProviderAction} className="provider-apply-form">
            <ProviderApplicationFields
              emailRequired={emailRequired}
              provinces={provinces}
              serviceScope={
                <section className="provider-apply-card">
                  <div className="provider-apply-card-head">
                    <h2 className="provider-apply-card-title">
                      <span className="provider-apply-card-num">04</span>
                      Hizmet kapsamı
                    </h2>
                    <p className="provider-apply-card-subtitle">
                      Teklif verebileceğiniz kategorileri seçin.
                    </p>
                  </div>
                  {categories.length === 0 ? (
                    <div className="state-surface">
                      <h3>Kategori listesi yüklenemedi</h3>
                      <p>Kategoriler gelmeden hizmet kapsamı seçilemiyor. Sayfayı yenileyin.</p>
                    </div>
                  ) : (
                    <div className="provider-apply-categories">
                      {categories.map((category) => (
                        <label className="check-chip" key={category.id}>
                          <input name="categoryIds" type="checkbox" value={category.id} />
                          <span>{category.name}</span>
                          {/*
                            Said on the chip rather than in a footnote: a business
                            ticking a service that cannot take a request yet has to
                            know that before they submit, not afterwards while they
                            wonder why nothing arrives.
                          */}
                          {category.availability === 'UPCOMING' ? (
                            <span className="check-chip-note">Yakında açılacak</span>
                          ) : null}
                        </label>
                      ))}
                    </div>
                  )}
                </section>
              }
            />

            <div className="provider-apply-actions">
              <button className="provider-apply-submit" type="submit">
                Başvuruyu Gönder
                <IconArrowRight />
              </button>
              <Link className="provider-apply-cancel" href="/">
                Vazgeç
              </Link>
              <span className="provider-apply-required-note">* zorunlu alanlar</span>
            </div>
          </form>

          <aside className="provider-apply-rail" aria-label="Başvuru bilgilendirmesi">
            {firstCategory ? (
              <div className="rail-media">
                <CategoryVisual
                  imageUrl={firstCategory.imageUrl}
                  slug={firstCategory.slug}
                  iconKey={firstCategory.iconKey}
                  name={firstCategory.name}
                  iconSize={48}
                  alt=""
                />
              </div>
            ) : null}

            <div className="rail-panel">
              <span className="rail-title">Onay süreci</span>
              <ol className="rail-steps">
                {APPROVAL_STEPS.map((step, index) => (
                  <li className="rail-step" key={step.title}>
                    <span className="rail-step-num">0{index + 1}</span>
                    <span>
                      <strong>{step.title}.</strong> {step.desc}
                    </span>
                  </li>
                ))}
              </ol>
            </div>

            <div className="rail-note">
              <strong>Kredi nasıl çalışır?</strong> Teklif göndermek kredi kullanır; bir teklifin
              kredi bedeli talebin kategorisine göre değişir ve her talebin detay ekranında
              yazılıdır. Görüntülenmeyen veya geçersiz taleplerde iade uygunluğu otomatik taranır.
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
