import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PackageRefundOptions } from '../lib/api';
import {
  initialPackageRefundSelection,
  PACKAGE_REFUND_FORM_EXPLANATION,
  PACKAGE_REFUND_SUBMITTED_NOTICE,
  packageRefundRequestHref,
  packageRefundStatusBadgeClass,
  packageRefundTimelineText,
} from '../lib/package-refund';

vi.mock('../app/destek/actions', () => ({
  createSupportTicketAction: vi.fn(),
  withdrawPackageRefundAction: vi.fn(),
}));

const { NewTicketForm } = await import('../app/destek/new-ticket-form');

/**
 * CMP-006 PR-B — the provider's side of a package refund request.
 *
 * The form offers the refund topic only when the API said the flow is open;
 * otherwise it is byte-for-byte the general form, with no trace of a topic
 * the provider cannot use. And the words: the provider is told a refund, if
 * approved, goes through the payment provider — never that TakTic has
 * refunded or will refund anything.
 */

const OPTIONS: PackageRefundOptions = {
  available: true,
  testMode: false,
  purchases: [
    {
      id: 'pp-1',
      purchaseNumber: 'PKG-2026-000001',
      packageName: 'Başlangıç Paketi',
      creditAmount: 25,
      priceAmount: 49900,
      currency: 'TRY',
      paidAt: '2026-09-20T10:00:00.000Z',
      windowEndsAt: '2026-10-04T10:00:00.000Z',
      ticketSubject: 'Paket ve kredi iadesi: Başlangıç Paketi (PKG-2026-000001)',
    },
  ],
};

describe('the support form', () => {
  it('with the refund flow closed, is the general form and nothing more', () => {
    const markup = renderToStaticMarkup(<NewTicketForm refundOptions={null} />);
    expect(markup).not.toContain('support-topic');
    expect(markup).not.toContain('Paket ve kredi iadesi');
    expect(markup).toContain('support-subject-input');
  });

  it('with the flow open, offers the type choice and starts on general support', () => {
    const markup = renderToStaticMarkup(<NewTicketForm refundOptions={OPTIONS} />);
    expect(markup).toContain('data-testid="support-topic"');
    expect(markup).toContain('Talep türü');
    expect(markup).toContain('Genel destek');
    expect(markup).toContain('Paket ve kredi iadesi');
    // The picker is behind the type choice, so it is not rendered until chosen.
    expect(markup).not.toContain('refund-purchase-picker');
    expect(markup).toContain('support-subject-input');
  });

  it('from the purchase page: the refund type, the purchase chosen, the subject fixed and not a field', () => {
    const markup = renderToStaticMarkup(
      <NewTicketForm refundOptions={OPTIONS} initialRefund initialPurchaseId="pp-1" />,
    );
    expect(markup).toContain('refund-purchase-picker');
    expect(markup).toMatch(/name="packagePurchaseId" checked="" value="pp-1"/);
    expect(markup).toContain('Paket ve kredi iadesi: Başlangıç Paketi (PKG-2026-000001)');
    expect(markup).not.toContain('support-subject-input');
    expect(markup).not.toContain('name="subject"');
    // The message stays the provider's to write.
    expect(markup).toContain('support-message-input');
    expect(markup).not.toContain('refund-test-environment');
  });

  it('an id that is not on the API’s list is never pre-selected', () => {
    const markup = renderToStaticMarkup(
      <NewTicketForm refundOptions={OPTIONS} initialRefund initialPurchaseId="pp-foreign" />,
    );
    expect(markup).toContain('refund-purchase-picker');
    expect(markup).not.toMatch(/name="packagePurchaseId" checked=""/);
    expect(markup).not.toContain('pp-foreign');
  });

  it('under the test gate, says it is a test environment', () => {
    const markup = renderToStaticMarkup(
      <NewTicketForm refundOptions={{ ...OPTIONS, testMode: true }} initialRefund />,
    );
    expect(markup).toContain('data-testid="refund-test-environment"');
    expect(markup).toContain('Test ortamı — üretim sözleşmesi değildir.');
  });
});

describe('the purchase page link and the query it carries', () => {
  it('links to the support form on the refund type with the purchase', () => {
    expect(packageRefundRequestHref('pp-1')).toBe('/destek/yeni?type=PACKAGE_REFUND&purchaseId=pp-1');
    expect(packageRefundRequestHref('a&b=c')).toBe('/destek/yeni?type=PACKAGE_REFUND&purchaseId=a%26b%3Dc');
  });

  it('keeps a listed purchase, drops anything else, and ignores the query when the API offers nothing', () => {
    expect(initialPackageRefundSelection({ type: 'PACKAGE_REFUND', purchaseId: 'pp-1' }, OPTIONS)).toEqual({
      refund: true,
      purchaseId: 'pp-1',
    });
    expect(initialPackageRefundSelection({ type: 'PACKAGE_REFUND', purchaseId: 'pp-foreign' }, OPTIONS)).toEqual({
      refund: true,
      purchaseId: '',
    });
    expect(initialPackageRefundSelection({ type: 'GENERAL', purchaseId: 'pp-1' }, OPTIONS)).toEqual({
      refund: false,
      purchaseId: '',
    });
    expect(
      initialPackageRefundSelection({ type: ['PACKAGE_REFUND', 'x'], purchaseId: ['pp-1'] }, OPTIONS),
    ).toEqual({ refund: false, purchaseId: '' });
    for (const closed of [null, { available: false, purchases: [] }]) {
      expect(initialPackageRefundSelection({ type: 'PACKAGE_REFUND', purchaseId: 'pp-1' }, closed)).toEqual({
        refund: false,
        purchaseId: '',
      });
    }
  });
});

describe('the wording', () => {
  it('the submitted notice is the contract sentence, word for word', () => {
    expect(PACKAGE_REFUND_SUBMITTED_NOTICE).toBe(
      'Talep gönderildi; ödeme iadesi onaylanırsa ödeme sağlayıcısı üzerinden işlenir.',
    );
  });

  it('nothing promises that TakTic refunded or will refund', () => {
    for (const text of [PACKAGE_REFUND_SUBMITTED_NOTICE, PACKAGE_REFUND_FORM_EXPLANATION]) {
      expect(text).not.toMatch(/iade edildi|iade edilecek|iade ederiz|paranız/i);
    }
  });

  it('labels a timeline entry and colours each status', () => {
    expect(packageRefundTimelineText('İnceleniyor')).toBe('İade talebi: İnceleniyor');
    expect(packageRefundStatusBadgeClass('SETTLED')).toBe('badge badge-good');
    expect(packageRefundStatusBadgeClass('REJECTED')).toBe('badge badge-bad');
    expect(packageRefundStatusBadgeClass('WITHDRAWN')).toBe('badge badge-muted');
  });
});
