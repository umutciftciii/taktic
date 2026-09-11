import type { ShowcaseCard } from '../../../../lib/api';

/**
 * The two questions the card screen still asks about a card's *content*.
 *
 * Everything about where a card stands — draft, in review, ready, live, paid
 * for, expired — moved to `showcase-stage.ts`, which renders one state and one
 * next action resolved by the API. What is left here is about the pair of
 * texts a card can hold, which is a different question and the only one the
 * edit form needs answered.
 */

/**
 * The version the edit form should open on: the draft if there is one, else
 * the live one, else the refused one — a provider fixing a rejected first
 * version must not have to retype it.
 */
export function editableVersion(card: ShowcaseCard) {
  return card.draftVersion ?? card.liveVersion ?? card.rejectedVersion;
}

/** The version a screen shows when it can show only one. */
export function shownVersion(card: ShowcaseCard) {
  return card.liveVersion ?? card.draftVersion ?? card.rejectedVersion;
}

/** The most recent rejection the provider still needs to read, or null. */
export function lastRejection(card: ShowcaseCard) {
  const candidates = [card.draftVersion, card.liveVersion, card.rejectedVersion];
  for (const version of candidates) {
    if (version?.review?.decision === 'REJECTED') {
      return version.review;
    }
  }
  return null;
}
