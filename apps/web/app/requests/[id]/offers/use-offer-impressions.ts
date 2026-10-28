'use client';

import { useEffect, useRef, type RefObject } from 'react';
import {
  OFFER_IMPRESSIONS_MAX,
  OFFER_IMPRESSION_DWELL_MS,
  OFFER_IMPRESSION_FLUSH_MS,
  OFFER_IMPRESSION_RETRY_DELAYS_MS,
  OFFER_IMPRESSION_THRESHOLDS,
  isVisibleEnough,
  type OfferImpressionSurface,
} from './offer-impressions';

/** The attribute that marks a block whose visibility counts for an offer. */
export const OFFER_IMPRESSION_ATTRIBUTE = 'data-impression-offer-id';

/**
 * OFFER-VIEW-001: reports the offers this screen actually showed.
 *
 * Every element under `container` carrying {@link OFFER_IMPRESSION_ATTRIBUTE}
 * for one of `trackableIds` is watched. It counts once it has been visible
 * enough ({@link isVisibleEnough}) for {@link OFFER_IMPRESSION_DWELL_MS}
 * without a break, while the tab is in the foreground: opening the page shows
 * nothing below the fold, a fast scroll shows nothing, a background tab shows
 * nothing. Counted ids are gathered and sent together.
 *
 * Fails toward "not shown": no IntersectionObserver, a report the API refuses,
 * three failed attempts — the offer simply stays unviewed, which is what it
 * was before this screen reported anything. Nothing here is shown to the
 * customer and nothing waits on it.
 *
 * `surface` changes with the list/compare toggle; what was reported from one
 * view is not reported again from the other. A gathered batch outlives the
 * view that gathered it: switching views, or following a card's link to its
 * detail, does not cancel the pending send.
 */
export function useOfferImpressions(
  requestId: string,
  surface: OfferImpressionSurface,
  trackableIds: readonly string[],
  container: RefObject<HTMLElement | null>,
) {
  // Ids reported, or on their way — across both views and every re-render.
  const reported = useRef(new Set<string>());
  const queue = useRef(new Map<string, OfferImpressionSurface>());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trackableKey = trackableIds.join(',');

  useEffect(() => {
    const send = (offerIds: string[], from: OfferImpressionSurface, attempt: number, keepalive = false) => {
      fetch(`/api/requests/${encodeURIComponent(requestId)}/offer-impressions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ offerIds, surface: from }),
        credentials: 'same-origin',
        cache: 'no-store',
        keepalive,
      })
        .then((response) => {
          if (response.ok || (response.status >= 400 && response.status < 500)) {
            // Recorded, or refused for good (signed out, not this customer's
            // request): either way, asking again would not change the answer.
            return;
          }
          retry(offerIds, from, attempt);
        })
        .catch(() => retry(offerIds, from, attempt));
    };

    const retry = (offerIds: string[], from: OfferImpressionSurface, attempt: number) => {
      const delay = OFFER_IMPRESSION_RETRY_DELAYS_MS[attempt - 1];
      if (delay === undefined) {
        // Given up. Forgotten, so a later mount of the screen may try again.
        for (const offerId of offerIds) {
          reported.current.delete(offerId);
        }
        return;
      }
      setTimeout(() => send(offerIds, from, attempt + 1), delay);
    };

    const flush = (keepalive = false) => {
      if (flushTimer.current) {
        clearTimeout(flushTimer.current);
        flushTimer.current = null;
      }
      const bySurface = new Map<OfferImpressionSurface, string[]>();
      for (const [offerId, from] of queue.current) {
        bySurface.set(from, [...(bySurface.get(from) ?? []), offerId]);
      }
      queue.current.clear();
      for (const [from, offerIds] of bySurface) {
        for (let start = 0; start < offerIds.length; start += OFFER_IMPRESSIONS_MAX) {
          send(offerIds.slice(start, start + OFFER_IMPRESSIONS_MAX), from, 1, keepalive);
        }
      }
    };

    const enqueue = (offerId: string) => {
      if (reported.current.has(offerId)) {
        return;
      }
      reported.current.add(offerId);
      queue.current.set(offerId, surface);
      flushTimer.current ??= setTimeout(() => flush(), OFFER_IMPRESSION_FLUSH_MS);
    };

    // Leaving the page sends what is gathered rather than dropping it; a
    // keepalive fetch, so the session cookie and the JSON contract travel as
    // they always do.
    const onPageHide = () => flush(true);
    window.addEventListener('pagehide', onPageHide);

    const root = container.current;
    const trackable = new Set(trackableKey ? trackableKey.split(',') : []);
    if (!root || trackable.size === 0 || typeof IntersectionObserver === 'undefined') {
      return () => window.removeEventListener('pagehide', onPageHide);
    }

    const visible = new Set<Element>();
    const timers = new Map<Element, ReturnType<typeof setTimeout>>();
    const stopTimer = (element: Element) => {
      const timer = timers.get(element);
      if (timer) {
        clearTimeout(timer);
        timers.delete(element);
      }
    };
    const startTimer = (element: Element) => {
      if (timers.has(element) || document.visibilityState !== 'visible') {
        return;
      }
      timers.set(
        element,
        setTimeout(() => {
          timers.delete(element);
          const offerId = element.getAttribute(OFFER_IMPRESSION_ATTRIBUTE);
          observer.unobserve(element);
          visible.delete(element);
          if (offerId) {
            enqueue(offerId);
          }
        }, OFFER_IMPRESSION_DWELL_MS),
      );
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (isVisibleEnough(entry)) {
            visible.add(entry.target);
            startTimer(entry.target);
          } else {
            // Any break restarts the second from zero.
            visible.delete(entry.target);
            stopTimer(entry.target);
          }
        }
      },
      { threshold: OFFER_IMPRESSION_THRESHOLDS },
    );

    for (const element of root.querySelectorAll(`[${OFFER_IMPRESSION_ATTRIBUTE}]`)) {
      const offerId = element.getAttribute(OFFER_IMPRESSION_ATTRIBUTE);
      if (offerId && trackable.has(offerId) && !reported.current.has(offerId)) {
        observer.observe(element);
      }
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        for (const element of visible) {
          startTimer(element);
        }
      } else {
        for (const element of [...timers.keys()]) {
          stopTimer(element);
        }
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      observer.disconnect();
      for (const element of [...timers.keys()]) {
        stopTimer(element);
      }
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [requestId, surface, trackableKey, container]);
}
