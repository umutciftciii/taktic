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
  SHOWCASE_VERSION_REVIEW_LABELS,
  type ProviderProfile,
  type ShowcaseCard,
  type ShowcaseCardVersion,
  type ShowcasePriceTerms,
} from '../../../../../lib/api';
import type { ProvinceWithDistricts } from '../../../../../lib/locations';
import { ProviderShell } from '../../../provider-shell';
import { readCreditBalance } from '../../../provider-data';
import { ServiceAreaFields } from '../../../service-area-fields';
import {
  submitShowcaseCardAction,
  updateShowcaseCardAction,
  withdrawShowcaseSubmissionAction,
} from '../actions';
import { SHOWCASE_ERROR_MESSAGES } from '../showcase-errors';
import {
  editableVersion,
  lastRejection,
  showcaseCardSituation,
  showcaseReviewBadgeClass,
  showcaseStatusBadgeClass,
} from '../showcase-ui';
import { EditShowcaseCardForm } from './edit-card-form';

type ShowcaseCardPageProps = {
  params: Promise<{ id: string; cardId: string }>;
  searchParams: Promise<{
    error?: string;
    saved?: string;
    submitted?: string;
    withdrawn?: string;
  }>;
};

/**
 * One vitrin card: what is live, what is being written, and what an operator
 * said about either.
 *
 * The page is built around the pair of versions rather than a single current
 * one, because the pair is the product: a provider editing an approved card
 * needs to see, at the same time, the text customers would be shown and the text
 * they are proposing. Collapsing the two would hide exactly the moment where the
 * approval rule matters.
 *
 * The edit form is hidden while a version is with an operator. That is not a
 * cosmetic lock: a submitted version is frozen so that the review row names the
 * text somebody actually read, and the API refuses the write regardless of what
 * this screen renders.
 */
export default async function ShowcaseCardPage({ params, searchParams }: ShowcaseCardPageProps) {
  const { id, cardId } = await params;
  const { error, saved, submitted, withdrawn } = await searchParams;
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?redirectTo=/providers/${id}/vitrin/${cardId}`);
  }

  const [provider, card, creditBalance, provinces, priceTerms] = await Promise.all([
    fetchOrNotFound(() => apiFetch<ProviderProfile>(`/providers/${id}`)),
    fetchOrNotFound(() => apiFetch<ShowcaseCard>(`/providers/${id}/showcase/cards/${cardId}`)),
    readCreditBalance(id),
    apiFetch<ProvinceWithDistricts[]>('/locations/provinces'),
    // The exact sentence the API records an acceptance of. Fetched rather than
    // written into this page, so the text a provider agrees to and the text the
    // acceptance names are one string and not two expected to match.
    apiFetch<ShowcasePriceTerms>(`/providers/${id}/showcase/cards/price-terms`),
  ]);

  const draft = card.draftVersion;
  const underReview = draft?.reviewStatus === 'PENDING';
  const editable =
    !underReview && card.status !== 'SUSPENDED' && card.status !== 'ARCHIVED';
  const formSource = editableVersion(card);
  const rejection = lastRejection(card);

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
        <span>{formSource?.title ?? 'Kart'}</span>
      </nav>

      <header className="pdash-page-head">
        <span className="kicker">
          {SHOWCASE_CARD_KIND_LABELS[card.kind]} · {card.category.name}
        </span>
        <h1 className="pdash-page-title">{formSource?.title ?? 'Vitrin kartı'}</h1>
        <p className="pdash-page-sub">{showcaseCardSituation(card)}</p>
        <span className={showcaseStatusBadgeClass(card.status)}>
          {SHOWCASE_CARD_STATUS_LABELS[card.status]}
        </span>
      </header>

      {error ? (
        <div className="pdash-notice pdash-notice-error" role="alert">
          {SHOWCASE_ERROR_MESSAGES[error] ?? SHOWCASE_ERROR_MESSAGES.SHOWCASE_SAVE_FAILED}
        </div>
      ) : null}
      {saved ? (
        <div className="pdash-notice" role="status">
          Değişiklikler kaydedildi.
        </div>
      ) : null}
      {submitted ? (
        <div className="pdash-notice" role="status">
          Kart incelemeye gönderildi. Sonuçlanana kadar bu sürüm değiştirilemez.
        </div>
      ) : null}
      {withdrawn ? (
        <div className="pdash-notice" role="status">
          İnceleme talebi geri çekildi. Sürüm yeniden taslak; düzenleyip tekrar
          gönderebilirsiniz.
        </div>
      ) : null}

      {/*
        The way back out of the queue, offered exactly where the provider hits
        the wall: the edit form is hidden while a version is with an operator, so
        without this the screen would say "you cannot change this" and stop.
      */}
      {underReview ? (
        <form action={withdrawShowcaseSubmissionAction} className="pdash-detail-card pdash-form">
          <input type="hidden" name="providerId" value={id} />
          <input type="hidden" name="cardId" value={cardId} />

          <header className="pdash-section-head">
            <h2 className="pdash-section-title">İnceleme sürüyor</h2>
          </header>
          <p className="pdash-form-hint">
            Bu sürüm yönetimde ve sonuçlanana kadar düzenlenemez. Bir düzeltme yapmanız
            gerekiyorsa incelemeyi geri çekebilirsiniz: sürüm yeniden taslak olur, onayladığınız
            hizmet bedeli sorumluluk metni sıfırlanır ve tekrar göndermek için yeniden onay
            vermeniz gerekir.
            {card.liveVersion
              ? ' Onaylı sürümünüz bundan etkilenmez; yayına hazır kalmaya devam eder.'
              : ''}
          </p>

          <div className="pdash-form-foot">
            <button className="pdash-btn pdash-btn-secondary" type="submit">
              İncelemeyi geri çek
            </button>
          </div>
        </form>
      ) : null}

      {rejection ? (
        <div className="pdash-notice pdash-notice-warn" role="alert">
          <strong>İnceleme notu:</strong> {rejection.note}
          <div className="muted" style={{ fontSize: 12 }}>
            {formatDateTime(rejection.createdAt)}
          </div>
        </div>
      ) : null}

      {card.liveVersion ? (
        <VersionSummary
          heading="Onaylı sürüm (yayına hazır)"
          version={card.liveVersion}
          note="Müşteriye gösterilecek metin budur. Yeni bir sürüm onaylanana kadar değişmez."
        />
      ) : null}

      {draft && draft.id !== card.liveVersion?.id ? (
        <VersionSummary
          heading={underReview ? 'İncelemedeki sürüm' : 'Taslak sürüm'}
          version={draft}
          note={
            underReview
              ? 'Bu sürüm yönetimde. Sonuçlanana kadar düzenlenemez.'
              : 'Bu sürüm henüz kimseye gösterilmiyor. İncelemeye göndermeden yayına hazır sayılmaz.'
          }
        />
      ) : null}

      {editable && formSource ? (
        <>
          <form action={updateShowcaseCardAction} className="pdash-detail-card pdash-form">
            <input type="hidden" name="providerId" value={id} />
            <input type="hidden" name="cardId" value={cardId} />

            <header className="pdash-section-head">
              <h2 className="pdash-section-title">Kartı düzenle</h2>
            </header>
            <p className="pdash-form-hint">
              Başlık, özet, kapsam, fiyat, görsel, yanıt taahhüdü veya bölge eklemek yönetim
              onayı gerektirir; kaydettiğinizde yeni bir taslak sürüm oluşur. Yalnızca bölge
              çıkarmak onaysız uygulanır.
            </p>

            <EditShowcaseCardForm card={card} version={formSource} />

            <section className="pdash-form-section">
              <h2>Kartın bölgeleri</h2>
              <p className="pdash-form-hint">
                Kart yalnızca işletme profilinizdeki hizmet bölgelerinin içinde kalan yerleri
                hedefleyebilir.
              </p>
              <ServiceAreaFields
                provinces={provinces}
                defaultAreas={formSource.areas.map((area) => ({
                  city: area.city,
                  district: area.district,
                  neighborhood: area.neighborhood,
                }))}
              />
            </section>

            <div className="pdash-form-foot">
              <Link className="pdash-btn pdash-btn-secondary" href={`/providers/${id}/vitrin`}>
                Listeye dön
              </Link>
              <button className="pdash-btn pdash-btn-primary" type="submit">
                Kaydet
              </button>
            </div>
          </form>

          {draft && draft.reviewStatus === 'DRAFT' ? (
            <form action={submitShowcaseCardAction} className="pdash-detail-card pdash-form">
              <input type="hidden" name="providerId" value={id} />
              <input type="hidden" name="cardId" value={cardId} />
              <input type="hidden" name="priceTermsVersion" value={priceTerms.version} />

              <header className="pdash-section-head">
                <h2 className="pdash-section-title">İncelemeye gönder</h2>
              </header>

              <label className="showcase-consent">
                <input type="checkbox" name="priceTermsAccepted" required />
                <span>{priceTerms.text}</span>
              </label>

              <div className="pdash-form-foot">
                <button className="pdash-btn pdash-btn-primary" type="submit">
                  Onaya gönder
                </button>
              </div>
            </form>
          ) : null}
        </>
      ) : null}
    </ProviderShell>
  );
}

/**
 * One version, read-only.
 *
 * Everything an operator will judge is shown here, including the areas: a
 * provider should be able to see the claim they made without opening the form
 * that would change it.
 */
function VersionSummary({
  heading,
  version,
  note,
}: {
  heading: string;
  version: ShowcaseCardVersion;
  note: string;
}) {
  return (
    <section className="pdash-detail-card">
      <header className="pdash-section-head">
        <h2 className="pdash-section-title">
          {heading} · sürüm {version.versionNumber}
        </h2>
        <span className={showcaseReviewBadgeClass(version.reviewStatus)}>
          {SHOWCASE_VERSION_REVIEW_LABELS[version.reviewStatus]}
        </span>
      </header>
      <p className="muted" style={{ fontSize: 13 }}>
        {note}
      </p>

      <dl className="pdash-detail-grid">
        <div>
          <dt>Başlık</dt>
          <dd>{version.title}</dd>
        </div>
        <div>
          <dt>Özet</dt>
          <dd>{version.summary}</dd>
        </div>
        <div>
          <dt>Hizmet bedeli</dt>
          <dd>
            {version.listedServicePriceAmount === null ? (
              'Sabit fiyat yok (genel tanıtım)'
            ) : (
              <>
                {formatPrice(version.listedServicePriceAmount, version.listedServiceCurrency)}
                <div className="muted" style={{ fontSize: 12 }}>
                  Bu bedeli TakTick tahsil etmez.
                </div>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>Yanıt taahhüdü</dt>
          <dd>
            Acil: en geç {version.responseSlaUrgentHours} saat · Normal: en geç{' '}
            {version.responseSlaNormalHours} saat
          </dd>
        </div>
        <div>
          <dt>Dahil olanlar</dt>
          <dd>
            <ul className="showcase-list">
              {version.scopeIncluded.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </dd>
        </div>
        <div>
          <dt>Hariç olanlar</dt>
          <dd>
            <ul className="showcase-list">
              {version.scopeExcluded.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </dd>
        </div>
        <div>
          <dt>Bölgeler</dt>
          <dd>
            <ul className="showcase-list">
              {version.areas.map((area) => (
                <li key={area.areaKey}>{area.label}</li>
              ))}
            </ul>
          </dd>
        </div>
        <div>
          <dt>Sorumluluk metni onayı</dt>
          <dd>
            {version.priceTermsAcceptedAt
              ? `${version.priceTermsVersion} · ${formatDateTime(version.priceTermsAcceptedAt)}`
              : 'Henüz onaylanmadı'}
          </dd>
        </div>
      </dl>
    </section>
  );
}
