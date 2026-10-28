import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OFFER_DRAFT_FIELDS, offerDraftKey } from '../app/providers/offer-form-draft';

/**
 * UAT B-04: what the provider typed survives a refused submit. The browser
 * behaviour is `e2e/tests/offer-form-values.spec.ts`; this file pins what is
 * kept and where the form mounts it.
 */
describe('the offer form draft', () => {
  it('keeps only what the provider types', () => {
    expect([...OFFER_DRAFT_FIELDS]).toEqual([
      'priceAmount',
      'currency',
      'estimatedStartDate',
      'estimatedCompletionDate',
      'message',
      'warrantyNote',
      'internalNote',
    ]);
    // The price the page displayed must be the current one after a price
    // change, and the ids come from the URL — none of them is restored.
    for (const hidden of ['expectedCreditCost', 'providerId', 'requestId']) {
      expect(OFFER_DRAFT_FIELDS as readonly string[]).not.toContain(hidden);
    }
  });

  it('is kept per provider and request', () => {
    expect(offerDraftKey('prov-1', 'req-1')).toBe('taktick:offer-draft:prov-1:req-1');
    expect(offerDraftKey('prov-1', 'req-2')).not.toBe(offerDraftKey('prov-1', 'req-1'));
  });

  it('is restored on a refusal, dropped once the offer exists, and never put in the URL', () => {
    const page = readFileSync(
      resolve(__dirname, '..', 'app/providers/[id]/requests/[requestId]/page.tsx'),
      'utf8',
    );
    expect(page).toContain('<OfferFormDraft providerId={id} requestId={requestId} restore={Boolean(offerError)} />');
    expect(page).toContain('<DiscardOfferDraft providerId={id} requestId={requestId} />');

    const draft = readFileSync(resolve(__dirname, '..', 'app/providers/offer-form-draft.tsx'), 'utf8');
    expect(draft).toContain('window.sessionStorage');
    expect(draft).not.toMatch(/localStorage|URLSearchParams|router\.(push|replace)/);
  });
});
