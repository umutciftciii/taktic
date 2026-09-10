import {
  formatDateTime,
  formatPrice,
  SHOWCASE_PLACEMENT_STATUS_LABELS,
  SHOWCASE_SUSPEND_REASON_LABELS,
  type ShowcaseCardPriceTerms,
  type ShowcasePackage,
  type ShowcasePlacement,
} from '../../../../lib/api';
import { acceptShowcasePriceTermsAction, startShowcaseCheckoutAction } from './actions';

/**
 * The vitrin economy on one card's own screen: what it is publishing now, or
 * what it would cost to publish it.
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
 *
 * ## Why the terms acceptance is a form here rather than a refusal
 *
 * When the price-responsibility text has moved on, the checkout refuses. A
 * panel that only reported that refusal would be a dead end — the provider
 * would read "onay gerekiyor" with nothing on the screen to onaylamak. So the
 * package table is replaced by the acceptance itself, and the copy says what
 * the refusal does *not* mean: a run already on the air is untouched by any of
 * this, and finding that out from a support ticket would be finding it out too
 * late in the other direction.
 */
export function PlacementPanel({
  providerId,
  cardId,
  canPublish,
  publishBlockedReason,
  placement,
  packages,
  priceTerms,
  publishBlockedCode,
}: {
  providerId: string;
  cardId: string;
  canPublish: boolean;
  publishBlockedReason: string | null;
  publishBlockedCode: string | null;
  placement: ShowcasePlacement | null;
  packages: ShowcasePackage[];
  priceTerms: ShowcaseCardPriceTerms | null;
}) {
  if (placement) {
    return <LivePlacement placement={placement} />;
  }

  /*
   * The acceptance form stands in for the package table when — and only when —
   * the terms are the *only* thing in the way.
   *
   * The condition is the eligibility check's own code rather than
   * `!priceTerms.accepted`, and the difference matters. A card that has not been
   * approved yet cannot be published for a reason the provider fixes elsewhere,
   * and asking them to agree to the sales terms first would be asking for
   * something that buys them nothing — while putting a second copy of the same
   * sentence on a page that is already showing it above the "İncelemeye gönder"
   * consent. The server decides which refusal is the operative one; this screen
   * renders it.
   */
  if (publishBlockedCode === 'SHOWCASE_PRICE_TERMS_REACCEPT_REQUIRED' && priceTerms) {
    return (
      <PriceTermsAcceptance providerId={providerId} cardId={cardId} priceTerms={priceTerms} />
    );
  }

  return (
    <section className="pdash-detail-card">
      <h2 className="pdash-section-title">Vitrin yayını</h2>

      {!canPublish ? (
        <p className="muted">
          {publishBlockedReason ??
            'Bu kart şu anda yayına alınamaz. Kartın onaylanmış ve yayında bir sürümü olmalı.'}
        </p>
      ) : packages.length === 0 ? (
        <p className="muted">
          Şu anda bu kart tipi için satışta olan bir vitrin paketi yok.
        </p>
      ) : (
        <>
          <p className="muted">
            Vitrin paketi, kartınızı seçtiğiniz bölgelerde arayan müşterilere gösterir. Karttan
            gelen talepler yalnız size iletilir ve bu talepler için teklif kredisi harcanmaz.
          </p>

          <div className="pdash-table-scroll">
            <table className="pdash-table">
              <thead>
                <tr>
                  <th>Paket</th>
                  <th>Süre</th>
                  <th>Yayın bedeli</th>
                  <th>Bölge sayısı</th>
                  <th aria-label="İşlem" />
                </tr>
              </thead>
              <tbody>
                {packages.map((pkg) => (
                  <tr key={pkg.id}>
                    <td>
                      {pkg.name}
                      {pkg.description ? (
                        <div className="muted" style={{ fontSize: 12 }}>
                          {pkg.description}
                        </div>
                      ) : null}
                    </td>
                    <td>{pkg.durationDays} gün</td>
                    <td>{formatPrice(pkg.priceAmount, pkg.currency)}</td>
                    <td>{pkg.maxAreas === null ? 'Tümü' : `En fazla ${pkg.maxAreas}`}</td>
                    <td>
                      <form action={startShowcaseCheckoutAction}>
                        <input type="hidden" name="providerId" value={providerId} />
                        <input type="hidden" name="cardId" value={cardId} />
                        <input type="hidden" name="showcasePackageId" value={pkg.id} />
                        <button className="pdash-btn pdash-btn-primary" type="submit">
                          Satın al
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="muted" style={{ fontSize: 12 }}>
            Yayın bedeli TakTick&apos;e ödenir ve kartınızda yazan hizmet bedelinden bağımsızdır.
            Hizmet bedelini müşterinizden siz tahsil edersiniz.
          </p>
        </>
      )}
    </section>
  );
}

/**
 * The acceptance, standing where the package table would be.
 *
 * The sentence is rendered from the API's own copy of it — the same string the
 * acceptance row snapshots — rather than written into this component, so what a
 * provider reads and what the platform records an agreement to cannot be two
 * texts expected to match.
 */
function PriceTermsAcceptance({
  providerId,
  cardId,
  priceTerms,
}: {
  providerId: string;
  cardId: string;
  priceTerms: ShowcaseCardPriceTerms;
}) {
  return (
    <section className="pdash-detail-card">
      <h2 className="pdash-section-title">Vitrin yayını</h2>

      <p className="notice" role="status">
        Hizmet bedeli sorumluluk metni güncellendi. Bu kart için yeni bir vitrin paketi almadan
        önce güncel metni onaylamanız gerekiyor.
      </p>

      <p className="muted">
        Bu onay yalnız hukuki bir kabuldür: kartınızın içeriğini değiştirmez, kartı yeniden
        incelemeye göndermez ve yayında olan bir vitrin sürenizi durdurmaz ya da kısaltmaz.
      </p>

      <form action={acceptShowcasePriceTermsAction} className="pdash-form">
        <input type="hidden" name="providerId" value={providerId} />
        <input type="hidden" name="cardId" value={cardId} />
        <input type="hidden" name="priceTermsVersion" value={priceTerms.version} />

        <label className="showcase-consent">
          <input type="checkbox" name="priceTermsAccepted" required />
          <span>{priceTerms.text}</span>
        </label>

        <div className="pdash-form-foot">
          <button className="pdash-btn pdash-btn-primary" type="submit">
            Metni onayla
          </button>
        </div>
      </form>
    </section>
  );
}

function LivePlacement({ placement }: { placement: ShowcasePlacement }) {
  const off = placement.status === 'SUSPENDED' && placement.suspendReason;

  return (
    <section className="pdash-detail-card">
      <h2 className="pdash-section-title">Vitrin yayını</h2>

      <dl className="pdash-info-grid">
        <div className="pdash-info-row">
          <dt>Durum</dt>
          <dd>{SHOWCASE_PLACEMENT_STATUS_LABELS[placement.status]}</dd>
        </div>
        <div className="pdash-info-row">
          <dt>Paket</dt>
          <dd>{placement.packageName}</dd>
        </div>
        <div className="pdash-info-row">
          <dt>Yayın bedeli</dt>
          <dd>{formatPrice(placement.priceAmount, placement.currency)}</dd>
        </div>
        <div className="pdash-info-row">
          <dt>Başlangıç</dt>
          <dd>{formatDateTime(placement.startAt)}</dd>
        </div>
        <div className="pdash-info-row">
          <dt>Bitiş</dt>
          <dd>{formatDateTime(placement.endAt)}</dd>
        </div>
        <div className="pdash-info-row">
          <dt>Yayındaki bölgeler</dt>
          <dd>{placement.areas.map((area) => area.label).join(' · ') || '—'}</dd>
        </div>
        <div className="pdash-info-row">
          <dt>Bu yayından gelen talep</dt>
          <dd>{placement.leadCount}</dd>
        </div>
        {placement.extendedDays > 0 ? (
          <div className="pdash-info-row">
            <dt>Eklenen süre</dt>
            {/*
              Only ever grows, and only for suspensions the platform caused. It
              is shown because a provider comparing their end date against the
              day they paid would otherwise find it moved with no explanation.
            */}
            <dd>{placement.extendedDays} gün</dd>
          </div>
        ) : null}
      </dl>

      {off ? (
        <p className="notice pdash-notice-warn" role="status">
          {SHOWCASE_SUSPEND_REASON_LABELS[placement.suspendReason!]}
        </p>
      ) : null}
    </section>
  );
}
