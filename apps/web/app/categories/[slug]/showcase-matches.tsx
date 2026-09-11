'use client';

import { useEffect, useState } from 'react';
import type { ShowcaseFeedCard } from '../../../lib/api';

type ShowcaseMatchesProps = {
  categoryId: string;
  city: string;
  district: string;
  neighborhood: string;
};

/**
 * The businesses that could take *this* job directly, offered inside the
 * ordinary request form.
 *
 * ## What this is, and the thing it is carefully not
 *
 * A customer halfway through a marketplace request has just told the form two
 * facts — the category and where the work is — and those two facts are exactly
 * what decides which vitrin cards apply to them. Showing them here is
 * information they would otherwise have to go and look for.
 *
 * It is **not** a preference attached to their marketplace request. Choosing a
 * card leaves this form and opens a direct lead on that card; choosing nothing
 * submits the ordinary request, unchanged, reaching every matching business the
 * way it always did. There is no vitrin priority in the marketplace request, no
 * first-hour hold, and no ranking advantage in the offer list — those would be
 * a different feature, and the copy here promises none of them.
 *
 * ## Why it fetches rather than being rendered by the server
 *
 * The category is fixed when the page loads but the place is not: the customer
 * picks it two steps in, changes it, and picks again. A server-rendered block
 * would be a block for a location nobody had chosen yet.
 *
 * The request goes to this app's own route rather than to the API directly, the
 * same hop the neighbourhood list already takes — the form is public and must
 * not depend on the API being reachable from the visitor's network.
 */
export function ShowcaseMatches({
  categoryId,
  city,
  district,
  neighborhood,
}: ShowcaseMatchesProps) {
  const [cards, setCards] = useState<ShowcaseFeedCard[]>([]);

  useEffect(() => {
    if (!categoryId || !city || !district) {
      setCards([]);
      return;
    }

    // Aborted when the place changes again before the answer arrives, so a slow
    // response for a district the customer has already moved off cannot put
    // businesses from it back on the screen.
    const controller = new AbortController();
    const params = new URLSearchParams({ categoryId, city, district });
    if (neighborhood) {
      params.set('neighborhood', neighborhood);
    }

    fetch(`/api/showcase/feed?${params.toString()}`, { signal: controller.signal })
      .then((response) =>
        response.ok ? (response.json() as Promise<{ cards: ShowcaseFeedCard[] }>) : Promise.reject(),
      )
      .then((body) => setCards(body.cards))
      .catch(() => {
        if (controller.signal.aborted) return;
        // An offer that cannot be loaded is simply not offered. The form the
        // customer is filling in is unaffected.
        setCards([]);
      });

    return () => controller.abort();
  }, [categoryId, city, district, neighborhood]);

  if (cards.length === 0) {
    return null;
  }

  return (
    <section className="form-section showcase-inline" data-testid="showcase-request-matches">
      <h2>Bu işi doğrudan alabileceğiniz işletmeler</h2>
      <p className="form-section-subtitle">
        Bu işletmeler bu hizmeti seçtiğiniz bölge için vitrinde yayınladı. Birini seçerseniz
        talebiniz yalnız o işletmeye gider. Seçmezseniz talebiniz her zamanki gibi bölgenizdeki
        tüm onaylı hizmet verenlere açılır.
      </p>

      <div className="showcase-inline-grid">
        {cards.map((card) => (
          <article className="showcase-inline-card" key={card.cardId}>
            <p className="showcase-area-badge">
              <span className="showcase-area-badge-label">Hizmet bölgesi</span>
              <span className="showcase-area-badge-value">
                {card.areas.map((area) => area.label).join(' · ') || card.areaLabel}
              </span>
            </p>

            <h4>{card.title}</h4>
            <p className="showcase-shelf-provider">{card.provider.businessName}</p>
            <p className="muted showcase-shelf-sla">
              Acil: {card.responseSlaUrgentHours} saat · Normal: {card.responseSlaNormalHours}{' '}
              saat içinde dönüş
            </p>

            {/*
              A plain link, not a button inside the form: this leaves the
              marketplace request rather than changing it, and a submit control
              nested in another form is a control that would post the wrong one.

              The place the customer already chose travels with them, so the
              card's own form does not ask the same question a third time. It
              prefills only — the server re-checks the address against the run's
              shelf before any lead exists.
            */}
            <a
              className="btn btn-secondary"
              href={`/vitrin/${card.cardId}?${new URLSearchParams({
                city,
                district,
                ...(neighborhood ? { neighborhood } : {}),
              }).toString()}`}
              data-testid="showcase-request-match-cta"
            >
              Bu işletmeden talep oluştur
            </a>
          </article>
        ))}
      </div>

      <p className="muted">
        Ya da aşağıdan <strong>genel talep oluşturmaya devam et</strong>in: talebiniz bölgenizdeki
        tüm uygun hizmet verenlere açılır.
      </p>
    </section>
  );
}
