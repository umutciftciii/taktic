import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PackageRefundOptions } from '../lib/api';
import {
  PACKAGE_REFUND_FORM_EXPLANATION,
  PACKAGE_REFUND_SUBMITTED_NOTICE,
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
      selectable: true,
      notes: ['Normal iade koşullarını sağlıyor.'],
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

  it('with the flow open, offers the topic and starts on the general one', () => {
    const markup = renderToStaticMarkup(<NewTicketForm refundOptions={OPTIONS} />);
    expect(markup).toContain('data-testid="support-topic"');
    expect(markup).toContain('Paket ve kredi iadesi');
    // The picker is behind the topic choice, so it is not rendered until chosen.
    expect(markup).not.toContain('refund-purchase-picker');
    expect(markup).toContain('support-subject-input');
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
