import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  apiFetch,
  fetchOrNotFound,
  formatDateTime,
  formatPrice,
  getCurrentUser,
  SHOWCASE_CARD_KIND_LABELS,
  type ProviderProfile,
  type ShowcaseCard,
  type ShowcaseCardVersion,
  type ShowcasePackage,
  type ShowcaseCardPriceTerms,
  type ShowcasePriceTerms,
  type ShowcasePublicationList,
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
import { editableVersion, lastRejection } from '../showcase-ui';
import { showcaseStage, showcaseStageBadgeClass } from '../showcase-stage';
import { PublishPanel } from '../publish-panel';
import { EditShowcaseCardForm } from './edit-card-form';
import { archiveShowcaseCardAction, unarchiveShowcaseCardAction } from '../actions';

type ShowcaseCardPageProps = {
  params: Promise<{ id: string; cardId: string }>;
  searchParams: Promise<{
    error?: string;
    saved?: string;
    submitted?: string;
    withdrawn?: string;
    archived?: string;
    unarchived?: string;
    priceTermsAccepted?: string;
  }>;
};

/** What the eligibility dry run answers. See the call site for why it exists. */
type ShowcaseEligibility = {
  eligible: boolean;
  code: string | null;
  message: string | null;
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
  const { error, saved, submitted, withdrawn, archived, unarchived, priceTermsAccepted } =
    await searchParams;
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?redirectTo=/providers/${id}/vitrin/${cardId}`);
  }

  const [
    provider,
    card,
    creditBalance,
    provinces,
    priceTerms,
    cardPriceTerms,
    publication,
    eligibility,
  ] = await Promise.all([
      fetchOrNotFound(() => apiFetch<ProviderProfile>(`/providers/${id}`)),
      fetchOrNotFound(() => apiFetch<ShowcaseCard>(`/providers/${id}/showcase/cards/${cardId}`)),
      readCreditBalance(id),
      apiFetch<ProvinceWithDistricts[]>('/locations/provinces'),
      // The exact sentence the API records an acceptance of. Fetched rather than
      // written into this page, so the text a provider agrees to and the text the
      // acceptance names are one string and not two expected to match.
      apiFetch<ShowcasePriceTerms>(`/providers/${id}/showcase/cards/price-terms`),
      /*
       * The same terms asked about *this* card: is there an acceptance on file
       * for the version in force?
       *
       * A second call rather than a field on the one above, because the two
       * answer different questions — that one is what the review submission
       * requires, this one is what the next purchase requires — and folding them
       * together would make a change to either silently a change to both.
       *
       * A failure to answer is treated as "no opinion" rather than as a broken
       * page: the panel then falls back to the eligibility check's own refusal,
       * which carries the same code.
       */
      apiFetch<ShowcaseCardPriceTerms>(
        `/providers/${id}/showcase/cards/${cardId}/price-terms`,
      ).catch(() => null),
      /*
       * Where this card stands, resolved once on the server.
       *
       * This is what the screen used to work out for itself out of the card's
       * status, the pair of versions, the placement list and the eligibility
       * dry run — four reads that could disagree, and did. See
       * `ShowcasePublicationService`.
       */
      apiFetch<ShowcasePublicationList>(`/providers/${id}/showcase/publication`).catch(
        () => null,
      ),
      /*
       * The dry run behind the buy button.
       *
       * Asked of the API rather than worked out here, because "can this card be
       * published" is a question about the provider's approval, the card's
       * review state, the category's status and the coverage — and a screen
       * guessing at it would be a screen offering a button the checkout then
       * refuses. A failure to answer is treated as "not eligible, no reason
       * given" rather than as a broken page.
       */
      apiFetch<ShowcaseEligibility>(
        `/providers/${id}/showcase/placements/eligibility?cardId=${encodeURIComponent(cardId)}`,
      ).catch(() => null),
    ]);

  const cardPublication =
    publication?.cards.find((entry) => entry.cardId === cardId) ?? null;
  const stage = showcaseStage(
    cardPublication ?? undefined,
    `/providers/${id}/vitrin/${cardId}`,
    id,
  );
  const onAir =
    cardPublication?.state === 'LIVE' ||
    cardPublication?.state === 'ACTIVATING' ||
    cardPublication?.state === 'PAUSED';

  const packages = onAir
    ? []
    : await apiFetch<{ packages: ShowcasePackage[] }>(
        `/providers/${id}/showcase/packages?cardKind=${card.kind}`,
      )
        .then((body) => body.packages)
        .catch(() => []);

  /*
   * An outstanding acceptance is not a refusal any more — it is a checkbox on
   * the package the provider is about to buy. So the panel is opened for it,
   * and the eligibility check's other refusals (a closed category, a coverage
   * gap, an unapproved business) still close it.
   */
  const canPublish =
    (eligibility?.eligible ?? false) ||
    eligibility?.code === 'SHOWCASE_PRICE_TERMS_REACCEPT_REQUIRED';

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
      hasShowcaseHistory={publication?.hasPublicationHistory ?? false}
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
        {/*
          One state and one sentence, from the same resolution the card list
          reads. The screen used to carry a status badge, a review badge and a
          sentence naming two version numbers — three vocabularies for one card,
          two of them the schema's.
        */}
        <span className={showcaseStageBadgeClass(cardPublication ?? undefined)}>
          {stage.label}
        </span>
        {stage.detail ? <p className="pdash-page-sub">{stage.detail}</p> : null}
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
          Kart incelemeye gönderildi. Sonuçlanana kadar bu metin değiştirilemez.
        </div>
      ) : null}
      {withdrawn ? (
        <div className="pdash-notice" role="status">
          İnceleme talebi geri çekildi. Sürüm yeniden taslak; düzenleyip tekrar
          gönderebilirsiniz.
        </div>
      ) : null}
      {archived ? (
        <div className="pdash-notice" role="status">
          Kart arşivlendi ve yayından kaldırıldı. Satın aldığınız vitrin süresi işlemeye devam
          ediyor.
        </div>
      ) : null}
      {unarchived ? (
        <div className="pdash-notice" role="status">
          Kart arşivden çıkarıldı. Vitrin süresinden kalan varsa yayın yeniden başladı.
        </div>
      ) : null}
      {priceTermsAccepted ? (
        <div className="pdash-notice" role="status">
          Hizmet bedeli sorumluluk metnini onayladınız. Kartınızın içeriği ve inceleme durumu
          değişmedi.
        </div>
      ) : null}

      <PublishPanel
        providerId={id}
        cardId={cardId}
        publication={cardPublication}
        canPublish={canPublish}
        publishBlockedReason={eligibility?.message ?? null}
        packages={packages}
        priceTerms={cardPriceTerms}
      />

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
            Kartınız yönetimde ve sonuçlanana kadar düzenlenemez. Bir düzeltme yapmanız
            gerekiyorsa incelemeyi geri çekebilirsiniz: metniniz yeniden taslağa döner ve tekrar
            göndermek için şartları yeniden onaylamanız gerekir.
            {card.liveVersion
              ? ' Müşteriye gösterilen metin bundan etkilenmez.'
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
          heading="Müşteriye gösterilen metin"
          version={card.liveVersion}
          note="Yeni bir metin onaylanana kadar bu metin değişmez."
        />
      ) : null}

      {draft && draft.id !== card.liveVersion?.id ? (
        <VersionSummary
          heading={underReview ? 'İncelemedeki metniniz' : 'Kaydettiğiniz metin'}
          version={draft}
          note={
            underReview
              ? 'Bu metin yönetimde. Sonuçlanana kadar düzenlenemez.'
              : 'Bu metin henüz kimseye gösterilmiyor. İncelemeye göndermeden yayına alınamaz.'
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
              onayı gerektirir; kaydettiğinizde metniniz yeniden taslağa döner. Yalnızca bölge
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

      {/*
        Retiring the card, and the sentence that has to be read before it.

        The cost is stated plainly and up front, because it is the part a
        provider would otherwise discover afterwards: archiving takes the card
        off the air and the paid days go on being spent. That is deliberate —
        a run that could be frozen and resumed at will would be a voucher rather
        than a dated placement — but it is only fair if it is said first.

        There is no delete, here or anywhere. The versions are the record of
        what was claimed and what an operator approved.
      */}
      {card.status === 'ARCHIVED' ? (
        <form action={unarchiveShowcaseCardAction} className="pdash-detail-card pdash-form">
          <input type="hidden" name="providerId" value={id} />
          <input type="hidden" name="cardId" value={cardId} />

          <header className="pdash-section-head">
            <h2 className="pdash-section-title">Kart arşivde</h2>
          </header>
          <p className="pdash-form-hint">
            Bu kart arşivde ve yayında değil. Geri getirdiğinizde, satın aldığınız vitrin
            süresinden kalan varsa yayın kaldığı yerden devam eder.
          </p>

          <div className="pdash-form-foot">
            <button className="pdash-btn pdash-btn-secondary" type="submit">
              Arşivden çıkar
            </button>
          </div>
        </form>
      ) : card.status !== 'SUSPENDED' ? (
        <form action={archiveShowcaseCardAction} className="pdash-detail-card pdash-form">
          <input type="hidden" name="providerId" value={id} />
          <input type="hidden" name="cardId" value={cardId} />

          <header className="pdash-section-head">
            <h2 className="pdash-section-title">Kartı arşivle</h2>
          </header>
          <p className="pdash-form-hint">
            Arşivlenen kart yayından kalkar ve yeni talep almaz. Kartın geçmişi silinmez;
            istediğinizde geri getirebilirsiniz.
            {onAir
              ? ' Satın aldığınız vitrin süresi arşivdeyken de işlemeye devam eder — arşivde geçen günler süreye eklenmez.'
              : ''}
          </p>

          <div className="pdash-form-foot">
            <button className="pdash-btn pdash-btn-secondary" type="submit">
              Kartı arşivle
            </button>
          </div>
        </form>
      ) : null}
    </ProviderShell>
  );
}

/**
 * One version of the card's text, read-only.
 *
 * Everything an operator will judge is shown here, including the areas: a
 * provider should be able to see the claim they made without opening the form
 * that would change it.
 *
 * The version *number* is gone, and so is the review-status badge beside it. A
 * card carries at most two texts at a time — the one customers see and the one
 * the provider is proposing — and the headings say which is which. "Sürüm 4" is
 * a fact about the audit trail, which is an operator's concern; a provider
 * reading it can only wonder what happened to the other three.
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
        <h2 className="pdash-section-title">{heading}</h2>
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
      </dl>
    </section>
  );
}
