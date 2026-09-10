import Link from 'next/link';
import {
  formatDate,
  formatPrice,
  type ShowcaseCardPriceTerms,
  type ShowcaseCardPublication,
  type ShowcasePackage,
} from '../../../../lib/api';
import { startShowcaseCheckoutAction } from './actions';

/**
 * Putting one card on the vitrin, and seeing what it is doing once it is there.
 *
 * ## The flow, in the order the provider actually walks it
 *
 * Pick a package → see what it costs and how long it runs → agree to the price
 * responsibility → pay. One screen, one form per package row, one button.
 *
 * ## What this replaced
 *
 * The panel used to have three mutually exclusive modes, chosen by an
 * eligibility dry run's refusal *code*. One of those modes replaced the whole
 * package table with a notice reading "Hizmet bedeli sorumluluk metni
 * güncellendi" — and it fired for **every freshly approved card**, because a
 * card records its submission-time acceptance on the version while the sale
 * reads a separate ledger. So the commonest moment in the feature — an operator
 * approves a card, the provider comes to buy — showed a provider a notice about
 * terms changing, and no packages, and no way to pay.
 *
 * The acceptance is still a real and separately recorded act. It simply happens
 * where it belongs: on the line above the button it unblocks, after the price
 * and the duration the provider is agreeing about, as a required checkbox in
 * the same submission. See `startShowcaseCheckoutAction`.
 *
 * ## Why the two prices are never next to each other
 *
 * `ShowcaseCardVersion.listedServicePriceAmount` is what the business charges
 * its customer, and TakTick neither collects it nor is a party to it.
 * `ShowcasePackage.priceAmount` is what TakTick charges the business for the
 * listing. They are different money, and this panel renders only the second —
 * the first belongs to the card's content, several sections up the page. A
 * screen that put them in one table would be inviting somebody to add them up.
 *
 * ## Why the clock rule is stated before the button, not after
 *
 * A provider deciding whether to archive a card needs to know it costs them the
 * days, and finding that out afterwards is finding out too late.
 */
export function PublishPanel({
  providerId,
  cardId,
  publication,
  publishBlockedReason,
  canPublish,
  packages,
  priceTerms,
}: {
  providerId: string;
  cardId: string;
  /** Where the card stands, as the API resolved it. */
  publication: ShowcaseCardPublication | null;
  /** Why the card cannot be published, when that is neither the terms nor a package. */
  publishBlockedReason: string | null;
  canPublish: boolean;
  packages: ShowcasePackage[];
  priceTerms: ShowcaseCardPriceTerms | null;
}) {
  const state = publication?.state ?? 'DRAFT';

  if (state === 'LIVE' || state === 'ACTIVATING' || state === 'PAUSED') {
    return <LiveRun publication={publication!} />;
  }

  if (state === 'AWAITING_PAYMENT') {
    return (
      <section className="pdash-detail-card">
        <h2 className="pdash-section-title">Vitrine çıkar</h2>
        <p className="notice" role="status">
          Ödeme sayfanız hâlâ açık. Ödemeyi tamamladığınızda kartınız vitrinde yayına girer.
        </p>
        {publication?.packageName ? (
          <p className="muted">Seçtiğiniz paket: {publication.packageName}</p>
        ) : null}
        {/*
          The hosted page when there is one, the purchase's own screen when
          there is not — the mock provider has no hosted checkout at all, and a
          panel that only knew the first would leave a provider with an unpaid
          purchase and nothing to press.
        */}
        {publication?.checkoutUrl ? (
          <div className="pdash-form-foot">
            <a className="pdash-btn pdash-btn-primary" href={publication.checkoutUrl}>
              Ödemeye devam et
            </a>
          </div>
        ) : publication?.purchaseId ? (
          <div className="pdash-form-foot">
            <Link
              className="pdash-btn pdash-btn-primary"
              href={`/providers/${providerId}/package-purchases/${publication.purchaseId}`}
            >
              Ödemeye devam et
            </Link>
          </div>
        ) : null}
      </section>
    );
  }

  /*
   * A card that has not been approved yet has nothing to publish, and this
   * panel used to render an empty box saying so on every draft. It says nothing
   * instead: the state and the next action are already on the card's header,
   * and a second, emptier copy of "you cannot do this yet" is not information.
   */
  if (!canPublish) {
    return publishBlockedReason ? (
      <section className="pdash-detail-card">
        <h2 className="pdash-section-title">Vitrine çıkar</h2>
        <p className="muted">{publishBlockedReason}</p>
      </section>
    ) : null;
  }

  return (
    <section className="pdash-detail-card" data-testid="showcase-publish-panel">
      <h2 className="pdash-section-title">Vitrine çıkar</h2>

      <p className="muted">
        Vitrin paketi, kartınızı ana sayfada ve vitrin listesinde herkese gösterir. Karttan gelen
        talepler yalnız size iletilir ve bu talepler için teklif kredisi harcanmaz.
      </p>

      {packages.length === 0 ? (
        <p className="muted">Şu anda bu kart tipi için satışta olan bir vitrin paketi yok.</p>
      ) : (
        <div className="showcase-stage-list">
          {packages.map((pkg) => (
            <form
              className="showcase-stage-card"
              key={pkg.id}
              action={startShowcaseCheckoutAction}
              data-testid="showcase-package-option"
            >
              <input type="hidden" name="providerId" value={providerId} />
              <input type="hidden" name="cardId" value={cardId} />
              <input type="hidden" name="showcasePackageId" value={pkg.id} />

              <div className="showcase-stage-head">
                <h3 className="showcase-stage-title">{pkg.name}</h3>
                {pkg.description ? <p className="muted">{pkg.description}</p> : null}
                <p className="showcase-stage-state">
                  {pkg.durationDays} gün · {formatPrice(pkg.priceAmount, pkg.currency)}
                </p>
                <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                  Bu bedel TakTick&apos;e ödenir ve kartınızda yazan hizmet bedelinden
                  bağımsızdır. Hizmet bedelini müşterinizden siz tahsil edersiniz.
                </p>
              </div>

              {/*
                The acceptance, where the flow actually reaches it: after the
                price and the duration, before the payment. Rendered from the
                API's own copy of the sentence — the same string the acceptance
                row snapshots — so what a provider reads and what the platform
                records an agreement to cannot be two texts expected to match.

                Absent entirely when an acceptance for the version in force is
                already on file: asking twice for the same consent is how a
                consent record stops meaning anything.
              */}
              {priceTerms && !priceTerms.accepted ? (
                <>
                  <input type="hidden" name="priceTermsVersion" value={priceTerms.version} />
                  <label className="showcase-consent">
                    <input type="checkbox" name="priceTermsAccepted" required />
                    <span>{priceTerms.text}</span>
                  </label>
                </>
              ) : null}

              <div className="showcase-stage-foot">
                <button className="pdash-btn pdash-btn-primary" type="submit">
                  Ödemeye geç
                </button>
              </div>
            </form>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * What the card is doing while it is on the air, in the provider's own words.
 *
 * No placement state, no package price, no version: a run is "yayında until
 * this date, in these areas, and it has brought you this many requests". The
 * money is already on the purchase record, which is where a question about it
 * belongs.
 */
function LiveRun({ publication }: { publication: ShowcaseCardPublication }) {
  return (
    <section className="pdash-detail-card" data-testid="showcase-live-panel">
      <h2 className="pdash-section-title">Vitrin yayını</h2>

      {publication.state === 'ACTIVATING' ? (
        <p className="notice" role="status">
          Ödeme doğrulanıyor. Onay ulaştığı anda kartınız vitrinde görünmeye başlayacak.
        </p>
      ) : publication.state === 'PAUSED' ? (
        <p className="notice pdash-notice-warn" role="status">
          Kartınız şu anda vitrinde görünmüyor. Sebep ortadan kalktığında yayın kaldığı yerden
          devam eder ve durduğu süre yayın sürenize eklenir.
        </p>
      ) : (
        <p className="notice" role="status" data-testid="showcase-live-until">
          Yayında{publication.endAt ? ` · ${formatDate(publication.endAt)} tarihine kadar` : ''}
        </p>
      )}

      <dl className="pdash-info-grid">
        <div className="pdash-info-row">
          <dt>Paket</dt>
          <dd>{publication.packageName ?? '—'}</dd>
        </div>
        <div className="pdash-info-row">
          <dt>Hizmet bölgesi</dt>
          <dd>{publication.areaLabels.join(' · ') || '—'}</dd>
        </div>
        <div className="pdash-info-row">
          <dt>Bu yayından gelen talep</dt>
          <dd>{publication.leadCount}</dd>
        </div>
      </dl>

      {publication.leadCount > 0 ? (
        <p className="muted">
          <Link href="/providers/me">Panelim</Link> üzerinden ya da soldaki{' '}
          <strong>Vitrin talepleri</strong> menüsünden yanıtlayabilirsiniz.
        </p>
      ) : null}
    </section>
  );
}
