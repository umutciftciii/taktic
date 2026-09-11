import Link from 'next/link';
import { apiFetch, type ShowcaseFeed, type ShowcaseFeedCard } from '../lib/api';
import { faceFromFeedCard, ShowcaseCardFace } from './showcase-card-face';

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
            <div className="vitrin-grid" data-testid="showcase-shelf">
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
 * The face carries the area band, the title, the price and the media — the
 * exact same face a provider sees on their own screens. This wrapper adds
 * only what is specific to the shelf: the response-time line and the primary
 * call to action.
 */
export function ShowcaseShelfCard({ card }: { card: ShowcaseFeedCard }) {
  return (
    <div data-testid="showcase-shelf-card">
      <ShowcaseCardFace
        card={faceFromFeedCard(card)}
        href={`/vitrin/${card.cardId}`}
        testId="showcase-card-face"
      />
      <div className="vitrin-card-foot">
        <p className="muted">
          Acil: {card.responseSlaUrgentHours} saat · Normal: {card.responseSlaNormalHours} saat
          içinde dönüş
        </p>
        <Link className="pdash-btn pdash-btn-primary" href={`/vitrin/${card.cardId}`}>
          Bu hizmeti incele
        </Link>
      </div>
    </div>
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
