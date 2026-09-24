import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PurchaseTermsDocuments } from '../app/providers/[id]/package-purchases/purchase-terms-documents';

/**
 * CMP-006 PR-A / PR-B.1 — what the checkout says about the text it shows.
 *
 * A draft awaiting legal review says TASLAK; the TEST set of
 * `PURCHASE_TERMS_GATE=test` says it is a test environment and not a
 * production contract; an approved set says neither.
 */

const DOCUMENTS = [{ key: 'PAKET_IADE_POLITIKASI', title: 'Kredi Paketi İade Politikası', text: 'Metin' }];

function render(overrides: { legalReviewStatus: 'PENDING' | 'APPROVED'; testMode: boolean }) {
  return renderToStaticMarkup(
    <PurchaseTermsDocuments
      terms={{ required: true, documentKey: 'PACKAGE_PURCHASE_TERMS', version: 'v1', documents: DOCUMENTS, ...overrides }}
    />,
  );
}

describe('the purchase terms banner', () => {
  it('the TEST set: a visible test-environment warning, and not the draft label', () => {
    const markup = render({ legalReviewStatus: 'PENDING', testMode: true });
    expect(markup).toContain('data-testid="purchase-terms-test-banner"');
    expect(markup).toContain('Test ortamı — üretim sözleşmesi değildir.');
    expect(markup).not.toContain('purchase-terms-draft-banner');
  });

  it('the production draft: TASLAK, and no test warning', () => {
    const markup = render({ legalReviewStatus: 'PENDING', testMode: false });
    expect(markup).toContain('purchase-terms-draft-banner');
    expect(markup).not.toContain('purchase-terms-test-banner');
  });

  it('an approved set: neither', () => {
    const markup = render({ legalReviewStatus: 'APPROVED', testMode: false });
    expect(markup).not.toContain('purchase-terms-draft-banner');
    expect(markup).not.toContain('purchase-terms-test-banner');
  });
});
