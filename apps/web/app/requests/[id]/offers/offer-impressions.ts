// Types only: `lib/api` reaches for next/headers and cannot be bundled here.
import type { RequestOfferPreview } from '../../../../lib/api';

/**
 * OFFER-VIEW-001: when the list or comparison screen counts as having shown
 * the customer an offer's price and content.
 *
 * The screen reports; the API decides. Whatever the client sends, the server
 * stamps only a first look at a live offer before its refund moment — these
 * rules exist so the client does not report what the customer never saw.
 */

/** The screens that report. The detail page records its own view on open. */
export type OfferImpressionSurface = 'LIST' | 'COMPARE';

export function isOfferImpressionSurface(value: unknown): value is OfferImpressionSurface {
  return value === 'LIST' || value === 'COMPARE';
}

/** The most offers one report may name — the API refuses more. */
export const OFFER_IMPRESSIONS_MAX = 50;

/** How long a card must stay on screen, uninterrupted, in the foreground tab. */
export const OFFER_IMPRESSION_DWELL_MS = 1000;

/** How long reports gather before they go out together. */
export const OFFER_IMPRESSION_FLUSH_MS = 500;

/** Waits before the second and third attempt of a report that failed. */
export const OFFER_IMPRESSION_RETRY_DELAYS_MS = [2000, 8000] as const;

/** The share of the block, or of the viewport, that must be visible. */
export const OFFER_IMPRESSION_VISIBLE_SHARE = 0.5;

const LIVE_STATUSES: ReadonlySet<string> = new Set(['SUBMITTED', 'VIEWED', 'SHORTLISTED']);

/**
 * Whether a card is worth watching at all: an offer the customer has not
 * opened yet and can still choose. A closed rival is history (A-1) — the API
 * would refuse it anyway, so the screen does not ask.
 */
export function isImpressionTrackable(offer: Pick<RequestOfferPreview, 'status' | 'viewedAt'>): boolean {
  return offer.viewedAt === null && LIVE_STATUSES.has(offer.status);
}

/**
 * Whether an observed block is visible enough to count: half of it, or — for a
 * block taller than half the screen, a long message on a phone — enough of it
 * to fill half the viewport's height across half its own width.
 */
export function isVisibleEnough(entry: {
  isIntersecting: boolean;
  intersectionRatio: number;
  intersectionRect: { width: number; height: number };
  boundingClientRect: { width: number };
  rootBounds: { height: number } | null;
}): boolean {
  if (!entry.isIntersecting) {
    return false;
  }
  if (entry.intersectionRatio >= OFFER_IMPRESSION_VISIBLE_SHARE) {
    return true;
  }
  if (!entry.rootBounds) {
    return false;
  }
  return (
    entry.intersectionRect.height >= entry.rootBounds.height * OFFER_IMPRESSION_VISIBLE_SHARE &&
    entry.intersectionRect.width >= entry.boundingClientRect.width * OFFER_IMPRESSION_VISIBLE_SHARE
  );
}

/** The observer's thresholds: fine enough that crossing either rule is seen. */
export const OFFER_IMPRESSION_THRESHOLDS = Array.from({ length: 21 }, (_, index) => index / 20);
