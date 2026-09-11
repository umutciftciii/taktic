import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiFetch, type ShowcaseFeedCard } from '../../../lib/api';
import type { ProvinceWithDistricts } from '../../../lib/locations';
import { areaSentence } from '../../showcase-shelf';
import { faceFromFeedCard, ShowcaseCardFace } from '../../showcase-card-face';
import {
  confirmShowcaseLeadVerificationAction,
  createShowcaseLeadAction,
  startShowcaseLeadVerificationAction,
} from './actions';

type CardPageProps = {
  params: Promise<{ cardId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const LEAD_ERRORS: Record<string, string> = {
  SHOWCASE_CARD_NOT_FOUND: 'Bu kart artık yayında değil.',
  SHOWCASE_LEAD_PHONE_VERIFICATION_REQUIRED:
    'Telefon doğrulamanız tamamlanmadı ya da süresi doldu. Kodu yeniden isteyin.',
  SHOWCASE_LEAD_RATE_LIMITED: 'Çok fazla talep gönderildi. Lütfen bir süre sonra tekrar deneyin.',
  PHONE_VERIFICATION_INVALID:
    'Doğrulama kodu geçersiz veya süresi dolmuş. Yeni bir kod isteyebilirsiniz.',
  SHOWCASE_AREA_UNKNOWN: 'Seçilen il, ilçe ve mahalle birlikte geçerli bir bölge oluşturmuyor.',
  SHOWCASE_LEAD_FAILED: 'Talebiniz gönderilemedi. Bilgileri kontrol edip tekrar deneyin.',
};

/**
 * The refusal this page exists to handle well.
 *
 * The customer read a card, chose it, and then typed an address the business
 * does not serve. Nothing they did was wrong — the home page shows every live
 * card now, precisely so a visitor does not have to declare a location before
 * seeing anything — so the answer has to be a route onward rather than a red
 * box. The ordinary marketplace request reaches every matching business in
 * their district, which is what they actually wanted.
 */
const AREA_NOT_SERVED = 'SHOWCASE_LEAD_AREA_NOT_SERVED';

/**
 * One vitrin card: what it covers, and — if the customer is inside that
 * coverage — the form that writes to the business behind it.
 *
 * ## The screen is a decision before it is a form
 *
 * A visitor arrives here from a shelf they did not filter, so the first thing
 * this page owes them is the question "is this for me": the service area, the
 * scope, and the price, with a plain way to go on and a plain way to leave.
 * The form comes after that decision, not instead of it.
 *
 * ## Why an unavailable card is a 404
 *
 * A card whose run has ended, one an operator pulled, and one that never
 * existed all answer identically. A card is a business's price list, and a
 * distinguishable "this exists but is not published" would let anybody walk the
 * id space and read what competitors are about to advertise, and for how much.
 * The API makes that decision; this page only renders what it is given.
 *
 * ## Why the coverage shown here is not the coverage check
 *
 * It is an advertisement, not a gate. The customer types their real address
 * into the form below and the **server** decides whether this run serves it —
 * see `ShowcaseLeadService.createLead`. A page that pre-filtered the districts
 * would still be a page, and a page cannot stop a request.
 *
 * ## The urgency choice, and what it is not
 *
 * The two options are rendered from **this card's own** promised hours, which
 * an operator approved. The customer chooses by seeing the promise rather than
 * by picking an abstract label, and the server reads the hours from the card
 * rather than from this form — a page that could send them could give itself a
 * one-hour deadline on somebody else's business.
 *
 * It is a separate question from when the work is wanted. Both are asked,
 * because a same-day job is very often one somebody is happy to be called about
 * tomorrow, and no code table can tell those apart.
 */
export default async function ShowcaseCardPublicPage({ params, searchParams }: CardPageProps) {
  const { cardId } = await params;
  const query = (await searchParams) ?? {};
  // No step at all is the scope panel: the decision comes before the form.
  const step = readParam(query.step) ?? 'scope';
  const phone = readParam(query.phone) ?? '';
  const error = readParam(query.error);
  const sent = readParam(query.sent) === '1';

  /*
   * A location the customer already chose somewhere else — on the marketplace
   * request form, where the vitrin cards for their own category and district
   * are offered. Carried so they are not asked the same question twice.
   *
   * It prefills and nothing more. The server re-resolves and re-checks it, so a
   * hand-edited query string buys nobody a lead outside the card's coverage.
   */
  const prefill = {
    city: readParam(query.city) ?? '',
    district: readParam(query.district) ?? '',
    neighborhood: readParam(query.neighborhood) ?? '',
  };

  const card = await loadCard(cardId);
  if (!card) {
    notFound();
  }

  let provinces: ProvinceWithDistricts[] = [];
  try {
    provinces = await apiFetch<ProvinceWithDistricts[]>('/locations/provinces');
  } catch {
    provinces = [];
  }

  const coverage = areaSentence(card);
  const nextStepHref = `/vitrin/${cardId}?step=phone${locationQuery(prefill)}`;

  return (
    <main className="lp-section">
      <div className="lp-container showcase-public">
        <nav className="pdash-crumbs" aria-label="Breadcrumb">
          <Link href="/">Ana sayfa</Link>
          <span aria-hidden="true">/</span>
          <Link href="/vitrin">Vitrin</Link>
          <span aria-hidden="true">/</span>
          <span>{card.title}</span>
        </nav>

        <header className="lp-section-head">
          <span className="kicker">{card.category.name}</span>
          <h1 className="lp-section-title">{card.title}</h1>
          <p className="lp-section-sub">{card.provider.businessName}</p>
        </header>

        <div className="vitrin-public">
          <div className="showcase-public-body">
            <ShowcaseCardFace card={faceFromFeedCard(card)} testId="showcase-card-face" eager />

            <p className="showcase-coverage-note" data-testid="showcase-card-coverage-note">
              Bu hizmet yalnız {coverage} kapsamındaki işler için sunulur.
            </p>

            <div className="vitrin-summary-facts">
              <div>
                <h2>Dahil olanlar</h2>
                <ul className="showcase-list">
                  {card.scopeIncluded.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h2>Hariç olanlar</h2>
                <ul className="showcase-list">
                  {card.scopeExcluded.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h2>Yanıt taahhüdü</h2>
                <p>
                  Acil: {card.responseSlaUrgentHours} saat · Normal: {card.responseSlaNormalHours}{' '}
                  saat içinde dönüş
                </p>
              </div>
              <p className="muted">
                Bu işletme, hizmet bedelini ve kapsamını kendisi belirler ve müşterisinden kendisi
                tahsil eder. TakTick bu bedele taraf değildir.
              </p>
            </div>
          </div>

          {sent ? (
            <div className="notice" role="status" data-testid="showcase-lead-sent">
              Talebiniz {card.provider.businessName} işletmesine iletildi. Yanıt gelmezse size
              e-posta ile yazacağız ve talebinizi diğer hizmet verenlere açmak isteyip
              istemediğinizi soracağız.
            </div>
          ) : (
            <section className="showcase-public-cta" data-testid="showcase-lead-cta">
              {error === AREA_NOT_SERVED ? (
                <AreaNotServed card={card} coverage={coverage} />
              ) : (
                <>
                  <h2>Bu işletmeye talep gönderin</h2>
                  <p className="muted">
                    Talebiniz yalnız {card.provider.businessName} işletmesine iletilir. Başka hiçbir
                    hizmet verene gönderilmez.
                  </p>

                  {error ? (
                    <div className="notice cdash-notice-error" role="alert">
                      {LEAD_ERRORS[error] ?? LEAD_ERRORS.SHOWCASE_LEAD_FAILED}
                    </div>
                  ) : null}

                  {step === 'form' ? (
                    <LeadForm
                      card={card}
                      cardId={cardId}
                      phone={phone}
                      provinces={provinces}
                      prefill={prefill}
                    />
                  ) : step === 'code' ? (
                    <form
                      action={confirmShowcaseLeadVerificationAction}
                      className="pdash-form"
                    >
                      <input type="hidden" name="cardId" value={cardId} />
                      <input type="hidden" name="phone" value={phone} />
                      <LocationCarry prefill={prefill} />

                      <p className="muted">
                        {phone} numarasına bir doğrulama kodu gönderdik. Kodu girin.
                      </p>
                      <label className="pdash-form-row">
                        <span>Doğrulama kodu *</span>
                        <input
                          name="code"
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          minLength={6}
                          maxLength={6}
                          required
                        />
                      </label>
                      <div className="pdash-form-foot">
                        <Link
                          className="pdash-btn pdash-btn-ghost"
                          href={`/vitrin/${cardId}?step=phone${locationQuery(prefill)}`}
                        >
                          Numarayı değiştir
                        </Link>
                        <button className="pdash-btn pdash-btn-primary" type="submit">
                          Doğrula
                        </button>
                      </div>
                    </form>
                  ) : step === 'phone' ? (
                    <form action={startShowcaseLeadVerificationAction} className="pdash-form">
                      <input type="hidden" name="cardId" value={cardId} />
                      <LocationCarry prefill={prefill} />
                      <p className="muted">
                        Talebinizin doğrudan bir işletmeye gitmesi için önce telefon numaranızı
                        doğrulamamız gerekiyor.
                      </p>
                      <label className="pdash-form-row">
                        <span>Telefon *</span>
                        <input
                          name="phone"
                          type="tel"
                          inputMode="tel"
                          autoComplete="tel"
                          placeholder="05xx xxx xx xx"
                          defaultValue={phone}
                          required
                        />
                      </label>
                      <div className="pdash-form-foot">
                        <button className="pdash-btn pdash-btn-primary" type="submit">
                          Kod gönder
                        </button>
                      </div>
                    </form>
                  ) : (
                    /*
                     * The decision, and both ways out of it.
                     *
                     * "Vazgeç" goes back to the shelf rather than to the browser's
                     * history, because somebody who arrived from a search result
                     * has no history to go back to and would otherwise be stranded
                     * on a card they have just declined.
                     */
                    <div className="pdash-form-foot" data-testid="showcase-card-decision">
                      <Link className="pdash-btn pdash-btn-ghost" href="/vitrin">
                        Vazgeç
                      </Link>
                      <Link className="pdash-btn pdash-btn-primary" href={nextStepHref}>
                        Devam et
                      </Link>
                    </div>
                  )}
                </>
              )}
            </section>
          )}
        </div>
      </div>
    </main>
  );
}

/**
 * What the customer is told when their address falls outside the card.
 *
 * The card is not the mistake and neither is the address; the pairing is. So
 * this says exactly that, in the API's own words, and then points at the route
 * that does work — the ordinary marketplace request, which reaches every
 * matching business in their district rather than this one.
 */
function AreaNotServed({ card, coverage }: { card: ShowcaseFeedCard; coverage: string }) {
  return (
    <div data-testid="showcase-lead-area-not-served">
      <h2>Bu hizmet konumunuzu kapsamıyor</h2>
      <div className="notice cdash-notice-error" role="alert">
        Bu vitrin hizmeti seçtiğiniz konumu kapsamıyor. Genel talep oluşturmaya devam
        edebilirsiniz.
      </div>
      <p className="muted">
        {card.provider.businessName} bu kartı yalnız {coverage} için yayınladı. Talebiniz için
        bölgenizdeki tüm onaylı hizmet verenlerden teklif alabilirsiniz.
      </p>
      <div className="pdash-form-foot">
        <Link className="pdash-btn pdash-btn-ghost" href="/vitrin">
          Vitrine dön
        </Link>
        <Link
          className="pdash-btn pdash-btn-primary"
          href={`/categories/${card.category.slug}`}
          data-testid="showcase-general-request-cta"
        >
          Genel talep oluştur
        </Link>
      </div>
    </div>
  );
}

/**
 * The lead form.
 *
 * The urgency choice comes first and is required with no default, because it is
 * the one field that sets a promise: a pre-ticked option would be the page
 * choosing a deadline on the customer's behalf, and "Acil" pre-ticked would be
 * the page choosing the strictest one on the business's behalf.
 *
 * The location is asked here and **not** taken from the card. The card's areas
 * say where the business works; this asks where the job is, and those are two
 * different facts that only the customer knows the second of. Prefilling it
 * from a location the customer already chose elsewhere is a convenience, never
 * an answer — the server checks whatever arrives against the run's own shelf.
 */
function LeadForm({
  card,
  cardId,
  phone,
  provinces,
  prefill,
}: {
  card: ShowcaseFeedCard;
  cardId: string;
  phone: string;
  provinces: ProvinceWithDistricts[];
  prefill: { city: string; district: string; neighborhood: string };
}) {
  return (
    <form action={createShowcaseLeadAction} className="pdash-form" data-testid="showcase-lead-form">
      <input type="hidden" name="cardId" value={cardId} />
      <input type="hidden" name="phone" value={phone} />
      <input type="hidden" name="categorySlug" value={card.category.slug} />

      <fieldset className="pdash-form-row">
        <legend>Ne kadar sürede dönülmesini bekliyorsunuz? *</legend>
        {/*
          Rendered from this card's own approved hours, never from a constant.
          The customer chooses by seeing the promise the business made.
        */}
        <label className="showcase-consent">
          <input
            type="radio"
            name="urgencyBucket"
            value="URGENT"
            required
            data-testid="showcase-urgency-urgent"
          />
          <span>Acil — {card.responseSlaUrgentHours} saat içinde dönüş</span>
        </label>
        <label className="showcase-consent">
          <input
            type="radio"
            name="urgencyBucket"
            value="NORMAL"
            required
            data-testid="showcase-urgency-normal"
          />
          <span>Normal — {card.responseSlaNormalHours} saat içinde dönüş</span>
        </label>
      </fieldset>

      <div className="pdash-form-grid">
        <label className="pdash-form-row">
          <span>Ad soyad *</span>
          <input name="customerName" autoComplete="name" required />
        </label>
        <label className="pdash-form-row">
          <span>E-posta *</span>
          <input name="customerEmail" type="email" autoComplete="email" required />
        </label>
      </div>

      <p className="pdash-form-hint">
        İşin yapılacağı adresi girin. Bu hizmet yalnız {areaSentence(card)} kapsamındaki işler
        için sunulur; kapsam dışındaysa talebinizi genel akıştan oluşturabilirsiniz.
      </p>

      <div className="pdash-form-grid">
        <label className="pdash-form-row">
          <span>İl *</span>
          <select name="city" required defaultValue={prefill.city}>
            <option value="" disabled>
              İl seçin
            </option>
            {provinces.map((province) => (
              <option key={province.code} value={province.name}>
                {province.name}
              </option>
            ))}
          </select>
        </label>
        <label className="pdash-form-row">
          <span>İlçe *</span>
          {/*
            A free-text district rather than a dependent select, because this is
            a server-rendered form with no client bundle. The API resolves it
            against the shipped location list and refuses a triple that is not a
            real place, so a typo is a refusal rather than a bad address.
          */}
          <input
            name="district"
            required
            placeholder="Örn. Kadıköy"
            defaultValue={prefill.district}
          />
        </label>
        <label className="pdash-form-row">
          <span>Mahalle</span>
          <input
            name="neighborhood"
            placeholder="İsteğe bağlı"
            defaultValue={prefill.neighborhood}
          />
        </label>
      </div>

      <label className="pdash-form-row">
        <span>İşi ne zaman yaptırmak istiyorsunuz?</span>
        {/*
          A different question from the one at the top, and asked separately on
          purpose: how fast somebody wants to be *called back* and when they want
          the *work done* are not the same thing, and neither is derived from the
          other.
        */}
        <input name="urgency" placeholder="Örn. bu hafta içinde" />
      </label>

      <label className="pdash-form-row">
        <span>Talebiniz *</span>
        <textarea name="description" required placeholder="Ne yapılmasını istiyorsunuz?" />
      </label>

      <label className="showcase-consent">
        <input type="checkbox" name="contactDisclosureAccepted" />
        <span>
          Teklifi kabul ettiğimde iletişim bilgilerimin hizmet verenle paylaşılacağını kabul
          ediyorum.
        </span>
      </label>

      <div className="pdash-form-foot">
        <Link className="pdash-btn pdash-btn-ghost" href={`/vitrin/${cardId}`}>
          Vazgeç
        </Link>
        <button
          className="pdash-btn pdash-btn-primary"
          type="submit"
          data-testid="showcase-lead-submit"
        >
          Talebi gönder
        </button>
      </div>
    </form>
  );
}

/** Carries a location the customer already chose through the verification steps. */
function LocationCarry({
  prefill,
}: {
  prefill: { city: string; district: string; neighborhood: string };
}) {
  return (
    <>
      <input type="hidden" name="city" value={prefill.city} />
      <input type="hidden" name="district" value={prefill.district} />
      <input type="hidden" name="neighborhood" value={prefill.neighborhood} />
    </>
  );
}

function locationQuery(prefill: {
  city: string;
  district: string;
  neighborhood: string;
}): string {
  const params = new URLSearchParams();
  if (prefill.city) params.set('city', prefill.city);
  if (prefill.district) params.set('district', prefill.district);
  if (prefill.neighborhood) params.set('neighborhood', prefill.neighborhood);
  const query = params.toString();
  return query ? `&${query}` : '';
}

async function loadCard(cardId: string): Promise<ShowcaseFeedCard | null> {
  try {
    return await apiFetch<ShowcaseFeedCard>(`/showcase/cards/${cardId}`);
  } catch {
    return null;
  }
}

function readParam(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}
