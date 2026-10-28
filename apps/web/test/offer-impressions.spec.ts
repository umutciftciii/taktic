import { describe, expect, it } from 'vitest';
import {
  isImpressionTrackable,
  isOfferImpressionSurface,
  isVisibleEnough,
} from '../app/requests/[id]/offers/offer-impressions';

/**
 * OFFER-VIEW-001: the client half of "the screen showed this offer". The API
 * re-decides everything; these rules only keep the screen from reporting what
 * the customer never saw.
 */

function entry(overrides: Partial<Parameters<typeof isVisibleEnough>[0]> = {}) {
  return {
    isIntersecting: true,
    intersectionRatio: 1,
    intersectionRect: { width: 600, height: 300 },
    boundingClientRect: { width: 600 },
    rootBounds: { height: 800 },
    ...overrides,
  };
}

describe('isVisibleEnough', () => {
  it('counts a block at least half on screen', () => {
    expect(isVisibleEnough(entry({ intersectionRatio: 0.5 }))).toBe(true);
    expect(isVisibleEnough(entry({ intersectionRatio: 1 }))).toBe(true);
  });

  it('does not count a sliver, or a block that is not intersecting', () => {
    expect(isVisibleEnough(entry({ intersectionRatio: 0.49, intersectionRect: { width: 600, height: 100 } }))).toBe(
      false,
    );
    expect(isVisibleEnough(entry({ isIntersecting: false, intersectionRatio: 0 }))).toBe(false);
  });

  it('counts a card taller than the screen once it fills half the viewport', () => {
    const tall = { boundingClientRect: { width: 360 }, rootBounds: { height: 700 } };
    expect(
      isVisibleEnough(entry({ ...tall, intersectionRatio: 0.3, intersectionRect: { width: 360, height: 350 } })),
    ).toBe(true);
    expect(
      isVisibleEnough(entry({ ...tall, intersectionRatio: 0.2, intersectionRect: { width: 360, height: 200 } })),
    ).toBe(false);
  });

  it('does not count a comparison column scrolled mostly off to the side', () => {
    expect(
      isVisibleEnough(
        entry({
          intersectionRatio: 0.3,
          intersectionRect: { width: 60, height: 400 },
          boundingClientRect: { width: 200 },
          rootBounds: { height: 700 },
        }),
      ),
    ).toBe(false);
  });

  it('does not use the viewport rule without a root to measure against', () => {
    expect(isVisibleEnough(entry({ intersectionRatio: 0.3, rootBounds: null }))).toBe(false);
  });
});

describe('isImpressionTrackable', () => {
  it('watches an unopened live offer only', () => {
    for (const status of ['SUBMITTED', 'VIEWED', 'SHORTLISTED'] as const) {
      expect(isImpressionTrackable({ status, viewedAt: null })).toBe(true);
    }
    expect(isImpressionTrackable({ status: 'SUBMITTED', viewedAt: '2026-10-28T10:00:00Z' })).toBe(false);
    for (const status of ['ACCEPTED', 'REJECTED', 'WITHDRAWN', 'CANCELLED', 'EXPIRED'] as const) {
      expect(isImpressionTrackable({ status, viewedAt: null })).toBe(false);
    }
  });
});

describe('isOfferImpressionSurface', () => {
  it('names the two reporting screens and nothing else', () => {
    expect(isOfferImpressionSurface('LIST')).toBe(true);
    expect(isOfferImpressionSurface('COMPARE')).toBe(true);
    expect(isOfferImpressionSurface('DETAIL')).toBe(false);
    expect(isOfferImpressionSurface(undefined)).toBe(false);
  });
});
