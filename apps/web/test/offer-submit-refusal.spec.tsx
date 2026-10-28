import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import {
  OFFER_SUBMIT_REFUSAL_MESSAGES,
  OfferSubmitRefusalNotice,
  describeOfferSubmitRefusal,
  readOfferSubmitRefusal,
} from '../app/providers/offer-submit-refusal';

/**
 * RELEASE-GAP-001 G-07 / UAT B-07: a refused offer submit is a sentence on the
 * provider's screen, never the error boundary — and a real failure still is.
 */

const apiFetch = vi.fn();

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, apiFetch: (...args: unknown[]) => apiFetch(...args) };
});

class Redirected extends Error {
  constructor(readonly url: string) {
    super(`redirect ${url}`);
  }
}

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Redirected(url);
  },
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const refusal = (status: number, body: Record<string, unknown> | string = {}) =>
  new ApiError(status, typeof body === 'string' ? body : JSON.stringify({ statusCode: status, ...body }));

describe('describeOfferSubmitRefusal', () => {
  it('sends a request the provider can no longer see to the list', () => {
    expect(describeOfferSubmitRefusal(refusal(404, { message: 'Request not found' }))).toEqual({
      refusal: 'requestUnavailable',
      on: 'list',
    });
    expect(describeOfferSubmitRefusal(refusal(409, { code: 'OFFER_ROUND_CLOSED' }))).toEqual({
      refusal: 'roundClosed',
      on: 'list',
    });
    expect(describeOfferSubmitRefusal(refusal(409, { code: 'PROVIDER_EXCLUDED' }))).toEqual({
      refusal: 'requestUnavailable',
      on: 'list',
    });
  });

  it('keeps the rest on the form', () => {
    expect(describeOfferSubmitRefusal(refusal(409, { code: 'OFFER_ALREADY_SUBMITTED' }))).toEqual({
      refusal: 'alreadySubmitted',
      on: 'form',
    });
    expect(describeOfferSubmitRefusal(refusal(402, { message: 'Insufficient credit' }))).toEqual({
      refusal: 'insufficientCredit',
      on: 'form',
    });
    expect(describeOfferSubmitRefusal(refusal(400, { message: ['priceAmount must not be less than 100'] }))).toEqual({
      refusal: 'invalid',
      on: 'form',
    });
    // A conflict this form has no sentence of its own for, and one whose body
    // is not even JSON: still a sentence, not a crash.
    expect(describeOfferSubmitRefusal(refusal(409, { code: 'SOMETHING_NEW' }))).toEqual({
      refusal: 'conflict',
      on: 'form',
    });
    expect(describeOfferSubmitRefusal(refusal(409, '<html>'))).toEqual({ refusal: 'conflict', on: 'form' });
  });

  it('leaves real failures to the error boundary', () => {
    for (const status of [401, 403, 429, 500, 502, 503]) {
      expect(describeOfferSubmitRefusal(refusal(status)), String(status)).toBeNull();
    }
    expect(describeOfferSubmitRefusal(new Error('fetch failed'))).toBeNull();
    expect(describeOfferSubmitRefusal(null)).toBeNull();
  });
});

describe('OfferSubmitRefusalNotice', () => {
  it('says first that nothing was sent or spent, then why — in an alert', () => {
    for (const [code, message] of Object.entries(OFFER_SUBMIT_REFUSAL_MESSAGES)) {
      const html = renderToStaticMarkup(<OfferSubmitRefusalNotice code={code} />);
      expect(html, code).toContain('role="alert"');
      expect(html, code).toContain('<strong>Teklif gönderilmedi, kredi düşülmedi.</strong>');
      expect(html, code).toContain(message.replace(/'/g, '&#x27;'));
      expect(html, code).toContain(`data-refusal="${code}"`);
    }
  });

  it('renders nothing for a flag it does not own, an inherited key or nothing at all', () => {
    for (const code of [undefined, '', 'costChanged', 'priceUnset', 'OFFER_START_IN_PAST', 'constructor', 'toString']) {
      expect(renderToStaticMarkup(<OfferSubmitRefusalNotice code={code} />), String(code)).toBe('');
      expect(readOfferSubmitRefusal(code)).toBeNull();
    }
  });
});

describe('createOfferAction', () => {
  let createOfferAction: (formData: FormData) => Promise<void>;

  beforeEach(async () => {
    apiFetch.mockReset();
    ({ createOfferAction } = await import('../app/providers/[id]/requests/[requestId]/actions'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function form() {
    const data = new FormData();
    data.set('providerId', 'prov-1');
    data.set('requestId', 'req-1');
    data.set('priceAmount', '4.500,00');
    data.set('expectedCreditCost', '2');
    data.set('currency', 'TRY');
    // A schedule the form's own check accepts: starting in a couple of days.
    data.set('estimatedStartDate', daysFromNow(2));
    data.set('estimatedCompletionDate', daysFromNow(4));
    data.set('message', 'Merhaba');
    return data;
  }

  async function landing(error: unknown): Promise<string> {
    apiFetch.mockRejectedValueOnce(error);
    try {
      await createOfferAction(form());
    } catch (thrown) {
      if (thrown instanceof Redirected) return thrown.url;
      throw thrown;
    }
    throw new Error('the action neither redirected nor threw');
  }

  it.each([
    [refusal(404), '/providers/prov-1/requests?offerError=requestUnavailable'],
    [refusal(409, { code: 'OFFER_ROUND_CLOSED' }), '/providers/prov-1/requests?offerError=roundClosed'],
    [refusal(409, { code: 'OFFER_ALREADY_SUBMITTED' }), '/providers/prov-1/requests/req-1?offerError=alreadySubmitted'],
    [refusal(402), '/providers/prov-1/requests/req-1?offerError=insufficientCredit'],
    [refusal(400), '/providers/prov-1/requests/req-1?offerError=invalid'],
    [refusal(409), '/providers/prov-1/requests/req-1?offerError=conflict'],
  ])('lands %s on a sentence', async (error, url) => {
    expect(await landing(error)).toBe(url);
  });

  it('keeps the pricing refusals it already had', async () => {
    expect(await landing(refusal(409, { code: 'CATEGORY_INACTIVE' }))).toBe(
      '/providers/prov-1/requests/req-1?offerError=categoryInactive',
    );
    expect(await landing(refusal(409, { code: 'CREDIT_COST_CHANGED', expectedCreditCost: 2, actualCreditCost: 3 }))).toBe(
      '/providers/prov-1/requests/req-1?offerError=costChanged&shownCost=2&currentCost=3',
    );
  });

  it('still throws a server failure to the error boundary', async () => {
    const failure = refusal(500);
    apiFetch.mockRejectedValueOnce(failure);
    await expect(createOfferAction(form())).rejects.toBe(failure);
  });
});

describe('the list page', () => {
  it('reads the flag and never forwards it to the API as a filter', () => {
    const source = readFileSync(resolve(__dirname, '..', 'app/providers/[id]/requests/page.tsx'), 'utf8');
    expect(source).toMatch(/const \{ minQualityScore: retiredMinQualityScore, offerError, \.\.\.filters \}/);
    expect(source).toContain('<OfferSubmitRefusalNotice code={offerError} />');
  });
});
