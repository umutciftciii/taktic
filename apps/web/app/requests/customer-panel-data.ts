import { cache } from 'react';
import { apiFetch, type CustomerServiceRequest, type RequestOfferPreview } from '../../lib/api';

/**
 * The customer panel's own data, loaded once per render wherever it is needed.
 *
 * The sidebar counters used to be a prop, and only the requests screen passed
 * them: opening the profile, the password screen or an offer rendered the same
 * sidebar with the counters simply gone, as if the customer had no requests.
 * They are not per-screen state — they describe the account — so they are
 * loaded from one place instead of being threaded through every page.
 *
 * `cache` is what keeps that from costing a second round trip: the shell and
 * the requests screen ask for the same list during one render and get the same
 * promise.
 */
export const loadCustomerRequests = cache(async (): Promise<CustomerServiceRequest[]> => {
  return apiFetch<CustomerServiceRequest[]>('/service-requests/my');
});

export type CustomerPanelCounts = {
  requests: number;
  offers: number;
  matches: number;
};

/**
 * The three sidebar numbers, or null when the list could not be read.
 *
 * Null is not zero and is not rendered as one: a sidebar that shows "0 talep"
 * because the API was unreachable is telling the customer something untrue.
 * Zero itself is a real answer and stays on screen.
 *
 * The definitions are the ones the requests screen already used, unchanged:
 * every request the customer has; every offer they can still act on (the API's
 * own count, which excludes withdrawn offers); and the requests that reached a
 * match.
 */
export async function loadCustomerPanelCounts(): Promise<CustomerPanelCounts | null> {
  try {
    const requests = await loadCustomerRequests();

    return {
      requests: requests.length,
      offers: requests.reduce((total, request) => total + request.offersCount, 0),
      matches: requests.filter((request) => request.status === 'MATCHED').length,
    };
  } catch {
    return null;
  }
}

export type CustomerOfferListEntry = {
  offer: RequestOfferPreview;
  request: CustomerServiceRequest;
};

/**
 * Every offer the customer can still act on, newest first, with the request it
 * was made on.
 *
 * Built from the two endpoints that already exist — the customer's requests and
 * one request's offers — because that is where the data is; nothing new was
 * added to the API for this screen. Only requests the API already reports as
 * carrying offers are asked about, and a request whose offers cannot be read is
 * skipped rather than failing the page: a single unreadable request must not
 * hide every other offer.
 */
export async function loadCustomerOffers(
  requests: CustomerServiceRequest[],
): Promise<CustomerOfferListEntry[]> {
  const withOffers = requests.filter((request) => request.offersCount > 0);

  const perRequest = await Promise.all(
    withOffers.map(async (request) => {
      try {
        const offers = await apiFetch<RequestOfferPreview[]>(
          `/service-requests/${request.id}/offers`,
        );
        // Withdrawn offers are not choices, and the sidebar count leaves them
        // out for the same reason. The per-request screen still shows them,
        // separately, as history.
        return offers
          .filter((offer) => offer.status !== 'WITHDRAWN')
          .map((offer) => ({ offer, request }));
      } catch {
        return [];
      }
    }),
  );

  return perRequest
    .flat()
    .sort((a, b) => Date.parse(b.offer.submittedAt) - Date.parse(a.offer.submittedAt));
}

export type CustomerMatchEntry = {
  request: CustomerServiceRequest;
  /**
   * The offer the customer accepted, when it can be read. Null rather than
   * absent: a match whose offers could not be loaded is still a match, and the
   * row falls back to the request it belongs to.
   */
  acceptedOffer: RequestOfferPreview | null;
};

/**
 * The customer's matches: their requests that reached MATCHED, with the offer
 * each of them accepted.
 *
 * MATCHED and nothing else, because that is what the product already counts as
 * a match — it is the state the sidebar counter is built from, and the state
 * that opens the matched-contact reveal. Widening it here (to COMPLETED, say)
 * would put a number in the sidebar and a different number under it, and would
 * be a new product rule rather than a screen for an existing one.
 */
export async function loadCustomerMatches(
  requests: CustomerServiceRequest[],
): Promise<CustomerMatchEntry[]> {
  const matched = requests.filter((request) => request.status === 'MATCHED');

  return Promise.all(
    matched.map(async (request) => {
      try {
        const offers = await apiFetch<RequestOfferPreview[]>(
          `/service-requests/${request.id}/offers`,
        );
        return {
          request,
          acceptedOffer: offers.find((offer) => offer.status === 'ACCEPTED') ?? null,
        };
      } catch {
        return { request, acceptedOffer: null };
      }
    }),
  );
}
