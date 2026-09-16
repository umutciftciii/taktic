'use client';

import type { ShowcaseFeedCard } from '../../lib/api';
import { RatingSummaryLine } from '../review-stars';

/** The radio's posted name. Empty string is the general marketplace request. */
export const SHOWCASE_CARD_FIELD = 'showcaseCardId';

type ProviderChoiceCardProps = {
  card: ShowcaseFeedCard;
  selected: boolean;
  onSelect: (card: ShowcaseFeedCard) => void;
  disabled?: boolean;
};

/**
 * One business the customer may address the request to, as a radio option.
 *
 * A `<label>` wrapping a visually hidden radio, so the whole card is the hit
 * area and the keyboard gets the native radio-group behaviour for free: Tab
 * lands on the checked option, the arrow keys move the choice. Nothing here
 * submits anything — the input changes the form's value and the form decides
 * what the primary button does with it.
 *
 * Deliberately five facts and no more: the business, what it does, where it
 * serves, how fast it promises to answer, and its public rating when there is
 * one to show. The description, the price and the imagery stay on the vitrin
 * page; this is a choice between businesses, not a second copy of their card.
 * A null summary renders nothing at all — not the "not enough reviews"
 * sentence — because the API already decided the rating is not public.
 */
export function ProviderChoiceCard({ card, selected, onSelect, disabled = false }: ProviderChoiceCardProps) {
  const areas = card.areas.map((area) => area.label).join(' · ') || card.areaLabel;

  return (
    <label
      className={`provider-choice${selected ? ' is-selected' : ''}`}
      data-testid="provider-choice-card"
      data-card-id={card.cardId}
      data-selected={selected ? 'true' : 'false'}
    >
      <input
        type="radio"
        className="provider-choice-input"
        name={SHOWCASE_CARD_FIELD}
        value={card.cardId}
        checked={selected}
        disabled={disabled}
        onChange={() => onSelect(card)}
        aria-describedby={`provider-choice-${card.cardId}-meta`}
      />
      <span className="provider-choice-mark" aria-hidden="true" />
      <span className="provider-choice-body">
        <span className="provider-choice-name">{card.provider.businessName}</span>
        <span className="provider-choice-meta" id={`provider-choice-${card.cardId}-meta`}>
          <span className="provider-choice-line">
            <span className="provider-choice-key">Kategori</span>
            <span>{card.category.name}</span>
          </span>
          <span className="provider-choice-line">
            <span className="provider-choice-key">Hizmet bölgesi</span>
            <span>{areas}</span>
          </span>
          <span className="provider-choice-line">
            <span className="provider-choice-key">Yanıt taahhüdü</span>
            <span>
              Acil {card.responseSlaUrgentHours} sa · Normal {card.responseSlaNormalHours} sa içinde dönüş
            </span>
          </span>
        </span>
        {card.provider.reviewSummary ? (
          <RatingSummaryLine
            summary={card.provider.reviewSummary}
            testId="provider-choice-review-summary"
            className="provider-choice-rating"
          />
        ) : null}
      </span>
    </label>
  );
}

type GeneralChoiceProps = {
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
};

/** The way out of the group: no business, the ordinary marketplace request. */
export function GeneralRequestChoice({ selected, onSelect, disabled = false }: GeneralChoiceProps) {
  return (
    <label
      className={`provider-choice provider-choice-general${selected ? ' is-selected' : ''}`}
      data-testid="provider-choice-general"
      data-selected={selected ? 'true' : 'false'}
    >
      <input
        type="radio"
        className="provider-choice-input"
        name={SHOWCASE_CARD_FIELD}
        value=""
        checked={selected}
        disabled={disabled}
        onChange={onSelect}
      />
      <span className="provider-choice-mark" aria-hidden="true" />
      <span className="provider-choice-body">
        <span className="provider-choice-name">Genel talep olarak devam et</span>
        <span className="provider-choice-meta">
          Talebiniz bölgenizdeki tüm uygun hizmet verenlere açılır.
        </span>
      </span>
    </label>
  );
}
