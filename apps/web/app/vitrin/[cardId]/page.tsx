import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiFetch, formatPrice, type ShowcaseFeedCard } from '../../../lib/api';
import type { ProvinceWithDistricts } from '../../../lib/locations';
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
  SHOWCASE_LEAD_FAILED: 'Talebiniz gönderilemedi. Bilgileri kontrol edip tekrar deneyin.',
};

/**
 * One vitrin card, and the form that writes to the business behind it.
 *
 * ## Why an unavailable card is a 404
 *
 * A card whose run has ended, one an operator pulled, and one that never
 * existed all answer identically. A card is a business's price list, and a
 * distinguishable "this exists but is not published" would let anybody walk the
 * id space and read what competitors are about to advertise, and for how much.
 * The API makes that decision; this page only renders what it is given.
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
 *
 * ## Why the telephone number is proved first
 *
 * This is the one path to a business's inbox with no operator in between. See
 * `actions.ts`.
 */
export default async function ShowcaseCardPublicPage({ params, searchParams }: CardPageProps) {
  const { cardId } = await params;
  const query = (await searchParams) ?? {};
  const step = readParam(query.step) ?? 'phone';
  const phone = readParam(query.phone) ?? '';
  const error = readParam(query.error);
  const sent = readParam(query.sent) === '1';

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

  return (
    <main className="lp-section">
      <div className="lp-container showcase-public">
        <nav className="pdash-crumbs" aria-label="Breadcrumb">
          <Link href="/">Ana sayfa</Link>
          <span aria-hidden="true">/</span>
          <span>{card.title}</span>
        </nav>

        <header className="lp-section-head">
          <span className="kicker">
            {card.category.name} · {card.areaLabel}
          </span>
          <h1 className="lp-section-title">{card.title}</h1>
          <p className="lp-section-sub">{card.provider.businessName}</p>
        </header>

        <section className="showcase-public-body">
          <p>{card.summary}</p>

          {typeof card.listedServicePriceAmount === 'number' ? (
            <p className="showcase-shelf-price" data-testid="showcase-card-price">
              {formatPrice(card.listedServicePriceAmount, card.listedServiceCurrency ?? 'TRY')}
              <span className="muted"> · sabit hizmet bedeli</span>
            </p>
          ) : null}

          <div className="showcase-public-scopes">
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
          </div>

          <p className="muted">
            Bu işletme, hizmet bedelini ve kapsamını kendisi belirler ve müşterisinden kendisi
            tahsil eder. TakTick bu bedele taraf değildir.
          </p>
        </section>

        {sent ? (
          <div className="notice" role="status" data-testid="showcase-lead-sent">
            Talebiniz {card.provider.businessName} işletmesine iletildi. Yanıt gelmezse size
            e-posta ile yazacağız ve talebinizi diğer hizmet verenlere açmak isteyip
            istemediğinizi soracağız.
          </div>
        ) : (
          <section className="showcase-public-cta" data-testid="showcase-lead-cta">
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
              <LeadForm card={card} cardId={cardId} phone={phone} provinces={provinces} />
            ) : step === 'code' ? (
              <form action={confirmShowcaseLeadVerificationAction} className="pdash-form">
                <input type="hidden" name="cardId" value={cardId} />
                <input type="hidden" name="phone" value={phone} />

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
                  <Link className="pdash-btn pdash-btn-ghost" href={`/vitrin/${cardId}?step=phone`}>
                    Numarayı değiştir
                  </Link>
                  <button className="pdash-btn pdash-btn-primary" type="submit">
                    Doğrula
                  </button>
                </div>
              </form>
            ) : (
              <form action={startShowcaseLeadVerificationAction} className="pdash-form">
                <input type="hidden" name="cardId" value={cardId} />
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
            )}
          </section>
        )}
      </div>
    </main>
  );
}

/**
 * The lead form.
 *
 * The urgency choice comes first and is required with no default, because it is
 * the one field that sets a promise: a pre-ticked option would be the page
 * choosing a deadline on the customer's behalf, and "Acil" pre-ticked would be
 * the page choosing the strictest one on the business's behalf.
 */
function LeadForm({
  card,
  cardId,
  phone,
  provinces,
}: {
  card: ShowcaseFeedCard;
  cardId: string;
  phone: string;
  provinces: ProvinceWithDistricts[];
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

      <div className="pdash-form-grid">
        <label className="pdash-form-row">
          <span>İl *</span>
          <select name="city" required defaultValue="">
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
          <input name="district" required placeholder="Örn. Kadıköy" />
        </label>
        <label className="pdash-form-row">
          <span>Mahalle</span>
          <input name="neighborhood" placeholder="İsteğe bağlı" />
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
