import Link from 'next/link';
import { apiFetch, formatPrice, type ShowcaseFeed } from '../lib/api';
import type { ProvinceWithDistricts } from '../lib/locations';

/**
 * The vitrin shelf on the home page.
 *
 * ## Why it asks for a location instead of showing a national list
 *
 * A placement is bought for particular districts, and a business that cannot
 * reach the visitor is not an advertisement — it is noise for the visitor and a
 * waste of what the provider paid for. The API refuses a feed request with no
 * location for exactly that reason, so this block asks first and shows nothing
 * until it has an answer.
 *
 * The location lives in the URL rather than in a cookie or in component state,
 * which is what makes the whole block a server component: no client bundle, and
 * a shelf somebody can bookmark or send to a friend.
 *
 * ## What the ordering means, and why nothing here decides it
 *
 * The API returns the cards in the order they are meant to be read: one round
 * of every provider's best card, then a round of second cards, and so on, so
 * one business cannot fill the screen however many cards it has bought. This
 * component renders them in the order it received them and sorts nothing — a
 * screen that re-sorted would undo the only thing keeping the shelf balanced.
 *
 * ## The price rule
 *
 * A SERVICE card carries a fixed price and a PROMOTION card carries none — and
 * the API leaves the key out entirely rather than sending null, so there is
 * nothing here to mistake for "free". The price shown is the **provider's own**
 * price to their customer; TakTick does not collect it, and what the provider
 * paid for the placement never appears on this page at all.
 */
export async function ShowcaseShelf({
  city,
  district,
  provinces,
}: {
  city: string | null;
  district: string | null;
  provinces: ProvinceWithDistricts[];
}) {
  const feed = city ? await loadFeed(city, district) : null;
  const selectedProvince = provinces.find((province) => province.name === city) ?? null;

  return (
    <section className="lp-section lp-section-white" id="vitrin">
      <div className="lp-container">
        <header className="lp-section-head">
          <span className="kicker">Vitrin</span>
          <h2 className="lp-section-title">Bölgenizdeki hizmet verenler</h2>
          <p className="lp-section-sub">
            Bu işletmeler hizmetlerini ve yanıt sürelerini önden açıkladı. Karttan doğrudan
            talep gönderdiğinizde talebiniz yalnız o işletmeye iletilir.
          </p>
        </header>

        {/*
          A plain GET form, so choosing a place is a navigation. No JavaScript,
          the result is linkable, and the page stays a server component.
        */}
        <form className="showcase-shelf-picker" method="get" action="/#vitrin">
          <label>
            <span>İl</span>
            <select name="vitrinIl" defaultValue={city ?? ''}>
              <option value="">İl seçin</option>
              {provinces.map((province) => (
                <option key={province.code} value={province.name}>
                  {province.name}
                </option>
              ))}
            </select>
          </label>

          {/*
            The district list is only offered once a province is chosen, because
            there is nothing to list before that. A visitor who names only a
            province still gets a shelf — the API answers a province-wide
            prefix scan — so this field is genuinely optional.
          */}
          {selectedProvince ? (
            <label>
              <span>İlçe</span>
              <select name="vitrinIlce" defaultValue={district ?? ''}>
                <option value="">Tüm ilçeler</option>
                {selectedProvince.districts.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <button className="btn btn-primary" type="submit">
            Göster
          </button>
        </form>

        {!city ? (
          <p className="muted" data-testid="showcase-shelf-empty">
            Size hizmet verebilecek işletmeleri gösterebilmemiz için önce bölgenizi seçin.
          </p>
        ) : !feed ? (
          <p className="muted" data-testid="showcase-shelf-empty">
            Bu bölge için vitrin listesi şu anda yüklenemedi.
          </p>
        ) : feed.cards.length === 0 ? (
          <p className="muted" data-testid="showcase-shelf-empty">
            {feed.location.label} için şu anda vitrinde işletme yok.
          </p>
        ) : (
          <div className="showcase-shelf-grid" data-testid="showcase-shelf">
            {feed.cards.map((card) => (
              <article className="showcase-shelf-card" key={card.cardId}>
                <span className="kicker">{card.category.name}</span>
                <h3>
                  <Link href={`/vitrin/${card.cardId}`}>{card.title}</Link>
                </h3>
                <p className="showcase-shelf-provider">{card.provider.businessName}</p>
                <p className="showcase-shelf-summary">{card.summary}</p>

                {/*
                  Present only on a SERVICE card. The key is absent on a
                  promotion card rather than null, so this cannot render a
                  price nobody claimed.
                */}
                {typeof card.listedServicePriceAmount === 'number' ? (
                  <p className="showcase-shelf-price">
                    {formatPrice(card.listedServicePriceAmount, card.listedServiceCurrency ?? 'TRY')}
                    <span className="muted"> · sabit hizmet bedeli</span>
                  </p>
                ) : null}

                <p className="muted showcase-shelf-sla">
                  Acil: {card.responseSlaUrgentHours} saat · Normal:{' '}
                  {card.responseSlaNormalHours} saat içinde dönüş
                </p>
                <p className="muted showcase-shelf-area">{card.areaLabel}</p>

                <Link className="btn btn-secondary" href={`/vitrin/${card.cardId}`}>
                  Kartı gör ve talep gönder
                </Link>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * A shelf that cannot be loaded is an empty shelf, not a broken page.
 *
 * The home page has to render for a visitor whether or not this block can
 * answer, and a location the API refuses — a district that does not exist in
 * the shipped list — is a bad query string rather than an error worth showing.
 */
async function loadFeed(city: string, district: string | null): Promise<ShowcaseFeed | null> {
  const params = new URLSearchParams({ city });
  if (district) {
    params.set('district', district);
  }

  try {
    return await apiFetch<ShowcaseFeed>(`/showcase/feed?${params.toString()}`);
  } catch {
    return null;
  }
}
