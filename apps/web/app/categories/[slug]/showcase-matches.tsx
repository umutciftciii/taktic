'use client';

import { useEffect, useId, useState } from 'react';
import type { ShowcaseFeedCard } from '../../../lib/api';
import {
  GeneralRequestChoice,
  ProviderChoiceCard,
} from '../../request-fields/provider-choice-card';

export type HandOffFailure =
  | 'CARD_UNAVAILABLE'
  | 'IDENTITY_MISSING'
  | 'DRAFT_NOT_CONTINUABLE'
  | 'DRAFT_BUSY'
  | 'DRAFT_FAILED';

type ShowcaseMatchesProps = {
  categoryId: string;
  city: string;
  district: string;
  neighborhood: string;
  /** The card the customer has chosen, or null for the general request. */
  selected: ShowcaseFeedCard | null;
  onSelect: (card: ShowcaseFeedCard | null) => void;
  /** Whether the visitor's contact step is a guest's — decides the phone-verification note. */
  guest: boolean;
  /** The last hand-off refusal, shown here beside the cards. */
  failure: HandOffFailure | null;
  /** An earlier draft stands in this browser; the customer is asked before it is replaced. */
  draftExists: boolean;
  onReplaceDraft: () => void;
  onKeepDraft: () => void;
  busy: boolean;
};

const FAILURE_TEXT: Record<HandOffFailure, string> = {
  CARD_UNAVAILABLE:
    'Bu işletme artık bu bölge için seçilemiyor. Genel talep olarak devam edebilirsiniz.',
  IDENTITY_MISSING:
    'Seçili işletmeye geçmek için iletişim adımındaki telefon ve e-posta alanları dolu olmalı.',
  DRAFT_NOT_CONTINUABLE:
    'Bu iletişim bilgileriyle taslak kaydedilemedi. Genel talep olarak devam edebilirsiniz.',
  DRAFT_BUSY: 'Taslak şu anda kaydedilemedi. Birkaç dakika sonra tekrar deneyin.',
  DRAFT_FAILED: 'Taslak şu anda kaydedilemedi. Birkaç dakika sonra tekrar deneyin.',
};

/**
 * The businesses that could take *this* job directly, offered inside the
 * ordinary request form as a choice.
 *
 * ## What choosing one does, and what it does not
 *
 * A customer halfway through a marketplace request has just told the form two
 * facts — the category and where the work is — and those two facts decide
 * which vitrin cards apply. Showing them here is information they would
 * otherwise have to go and look for.
 *
 * Picking a card changes one form value and nothing else. The primary button
 * then reads "Seçili işletmeye devam et" and, when pressed, parks the form as a
 * draft and takes the customer to that business's own vitrin form, where the
 * request is completed under the direct-lead rules (a verified telephone
 * number, the acil/normal choice). Picking "Genel talep olarak devam et" —
 * the default — submits the ordinary request exactly as it always did. There
 * is no vitrin priority in the marketplace request, no ranking advantage in
 * the offer list, and the copy promises none.
 *
 * ## Why it fetches rather than being rendered by the server
 *
 * The category is fixed when the page loads but the place is not: the customer
 * picks it two steps in, changes it, and picks again. A server-rendered block
 * would be a block for a location nobody had chosen yet. The request goes to
 * this app's own route, the same hop the neighbourhood list takes — the form
 * is public and must not depend on the API being reachable from the visitor's
 * network.
 */
export function ShowcaseMatches({
  categoryId,
  city,
  district,
  neighborhood,
  selected,
  onSelect,
  guest,
  failure,
  draftExists,
  onReplaceDraft,
  onKeepDraft,
  busy,
}: ShowcaseMatchesProps) {
  const [cards, setCards] = useState<ShowcaseFeedCard[]>([]);
  const headingId = useId();

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

  /*
   * A chosen card that is no longer on the list — the place changed, the feed
   * changed — is no longer a choice. Dropping it here is what makes "the card
   * shown is the card the form holds" true; the server re-checks regardless.
   */
  const selectedId = selected?.cardId ?? null;
  useEffect(() => {
    if (selectedId && !cards.some((card) => card.cardId === selectedId)) {
      onSelect(null);
    }
  }, [cards, selectedId, onSelect]);

  if (cards.length === 0) {
    return null;
  }

  return (
    <section className="form-section showcase-inline" data-testid="showcase-request-matches">
      <h2 id={headingId}>Bu işi doğrudan alabileceğiniz işletmeler</h2>
      <p className="form-section-subtitle">
        Bu işletmeler bu hizmeti seçtiğiniz bölge için vitrinde yayınladı. Birini seçerseniz
        talebiniz yalnız o işletmeye gider; seçmezseniz bölgenizdeki tüm uygun hizmet verenlere
        açılır.
      </p>

      <div
        className="provider-choice-group"
        role="radiogroup"
        aria-labelledby={headingId}
        data-testid="provider-choice-group"
      >
        {cards.map((card) => (
          <ProviderChoiceCard
            key={card.cardId}
            card={card}
            selected={selected?.cardId === card.cardId}
            onSelect={onSelect}
            disabled={busy}
          />
        ))}
        <GeneralRequestChoice selected={selected === null} onSelect={() => onSelect(null)} disabled={busy} />
      </div>

      {selected ? (
        <div className="notice provider-choice-note" role="status" data-testid="provider-choice-selected-note">
          <strong>
            Talebiniz yalnız {selected.provider.businessName} işletmesine iletilir; genel pazara
            açılmaz.
          </strong>{' '}
          Devam ettiğinizde işletmenin kendi formuna geçersiniz; yazdıklarınız oraya taşınır.
          {guest ? ' Seçili işletmeye talep göndermek için telefonunuzu doğrulamanız gerekir.' : null}
        </div>
      ) : null}

      {draftExists ? (
        <div className="notice identity-notice" role="alertdialog" data-testid="provider-choice-draft-exists">
          <span>Yeni taslağa geçerseniz önceki taslak silinir. Devam edilsin mi?</span>
          <div className="inline-actions">
            <button type="button" className="btn btn-primary" onClick={onReplaceDraft} disabled={busy}>
              Evet, geç
            </button>
            <button type="button" className="btn btn-secondary" onClick={onKeepDraft} disabled={busy}>
              Vazgeç
            </button>
          </div>
        </div>
      ) : null}

      {failure ? (
        <div className="notice cdash-notice-error" role="alert" data-testid="provider-choice-error">
          {FAILURE_TEXT[failure]}
        </div>
      ) : null}
    </section>
  );
}
