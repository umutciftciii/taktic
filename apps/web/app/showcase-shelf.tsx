import Link from 'next/link';
import { apiFetch, formatPrice, type ShowcaseFeed, type ShowcaseFeedCard } from '../lib/api';

/**
 * The vitrin shelf on the home page.
 *
 * ## Why it no longer asks where the visitor is
 *
 * It used to. A placement is bought for particular districts, and the earlier
 * reasoning was that a business which cannot reach the visitor is noise — so
 * the block asked for a province first and rendered nothing until it had one.
 *
 * That treated vitrin as a filtered directory, and it is not one. A business
 * buys a package, its card goes on the home page, and **everybody** sees it.
 * The honesty is not in hiding the card; it is in the card saying, unmissably,
 * which area it is good for — and in the server refusing a direct lead for an
 * address outside that area, which is where the promise is actually kept.
 *
 * The old shape cost the whole surface: every visitor who arrived without a
 * query string saw an empty box, so what a provider had paid to publish was
 * invisible to almost everyone. The province picker still exists, on the
 * separate discovery page at `/vitrin`, where narrowing is the point.
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
export async function ShowcaseShelf() {
  const feed = await loadFeed();

  return (
    <section className="lp-section lp-section-white" id="vitrin">
      <div className="lp-container">
        <header className="lp-section-head">
          <span className="kicker">Vitrin</span>
          <h2 className="lp-section-title">Öne çıkan hizmetler</h2>
          <p className="lp-section-sub">
            Bu işletmeler hizmetlerini, hizmet bölgelerini ve yanıt sürelerini önden açıkladı.
            Kartı inceleyip kendi konumunuz kapsam içindeyse doğrudan talep gönderebilirsiniz.
          </p>
        </header>

        {!feed ? (
          <p className="muted" data-testid="showcase-shelf-empty">
            Vitrin listesi şu anda yüklenemedi.
          </p>
        ) : feed.cards.length === 0 ? (
          <p className="muted" data-testid="showcase-shelf-empty">
            Şu anda vitrinde yayında olan bir hizmet yok.
          </p>
        ) : (
          <>
            <div className="showcase-shelf-grid" data-testid="showcase-shelf">
              {feed.cards.map((card) => (
                <ShowcaseShelfCard card={card} key={card.cardId} />
              ))}
            </div>

            {/*
              The narrowing surface, offered rather than imposed. A visitor who
              wants to browse by province can; nobody has to in order to see
              anything.
            */}
            <p className="showcase-shelf-more">
              <Link href="/vitrin">Bölgeye göre tüm vitrin hizmetlerini görün</Link>
            </p>
          </>
        )}
      </div>
    </section>
  );
}

/**
 * One card.
 *
 * The service area is a band of its own above the title rather than a muted
 * line under the call to action, and that placement is the whole point of this
 * revision: a visitor who never chose a location has to be able to tell, at a
 * glance and before reading anything else, whether this card is for them.
 */
export function ShowcaseShelfCard({ card }: { card: ShowcaseFeedCard }) {
  return (
    <article className="showcase-shelf-card">
      <p className="showcase-area-badge" data-testid="showcase-card-area">
        <span className="showcase-area-badge-label">Hizmet bölgesi</span>
        <span className="showcase-area-badge-value">{areaSentence(card)}</span>
      </p>

      <span className="kicker">{card.category.name}</span>
      <h3>
        <Link href={`/vitrin/${card.cardId}`}>{card.title}</Link>
      </h3>
      <p className="showcase-shelf-provider">{card.provider.businessName}</p>
      <p className="showcase-shelf-summary">{card.summary}</p>

      {/*
        Present only on a SERVICE card. The key is absent on a promotion card
        rather than null, so this cannot render a price nobody claimed.
      */}
      {typeof card.listedServicePriceAmount === 'number' ? (
        <p className="showcase-shelf-price">
          {formatPrice(card.listedServicePriceAmount, card.listedServiceCurrency ?? 'TRY')}
          <span className="muted"> · sabit hizmet bedeli</span>
        </p>
      ) : null}

      <p className="muted showcase-shelf-sla">
        Acil: {card.responseSlaUrgentHours} saat · Normal: {card.responseSlaNormalHours} saat
        içinde dönüş
      </p>

      <Link className="btn btn-secondary" href={`/vitrin/${card.cardId}`}>
        Bu hizmeti incele
      </Link>
    </article>
  );
}

/**
 * The coverage, as one sentence.
 *
 * Every label is already worded by the API — "İstanbul geneli", "Kadıköy,
 * İstanbul", "Moda, Kadıköy, İstanbul" — because how a card states its promise
 * is a product decision and two renderers of it would eventually disagree. All
 * this does is join them.
 */
export function areaSentence(card: Pick<ShowcaseFeedCard, 'areas' | 'areaLabel'>): string {
  if (card.areas.length === 0) {
    return card.areaLabel;
  }

  return card.areas.map((area) => area.label).join(' · ');
}

/**
 * A shelf that cannot be loaded is an empty shelf, not a broken page.
 *
 * The home page has to render for a visitor whether or not this block can
 * answer.
 */
async function loadFeed(): Promise<ShowcaseFeed | null> {
  try {
    return await apiFetch<ShowcaseFeed>('/showcase/feed');
  } catch {
    return null;
  }
}
