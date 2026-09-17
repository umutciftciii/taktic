import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RequestsBoard } from '../app/requests/my/requests-board';
import type { CustomerServiceRequest } from '../lib/api';

/**
 * The customer's own list: a request waiting for the customer's proof of
 * their number says so on its row and leads to the verification card. Nothing
 * of the sort on any other row — the signal is the API's
 * `awaitingPhoneVerification`, never inferred from the status.
 */

function row(overrides: Partial<CustomerServiceRequest> = {}): CustomerServiceRequest {
  return {
    id: 'cmfabcdefghijklmnopqrstuv',
    requestNumber: 'REQ-2026-000001',
    status: 'SUBMITTED',
    customerName: 'Ayşe',
    customerPhone: '+905000000001',
    customerEmail: 'a@example.test',
    city: 'İstanbul',
    district: 'Kadıköy',
    preferredDate: null,
    preferredDateEnd: null,
    urgency: null,
    qualityScore: 70,
    qualityLabel: 'GOOD' as CustomerServiceRequest['qualityLabel'],
    phoneVerifiedAt: null,
    expiredAt: null,
    submittedAt: '2026-09-17T10:00:00.000Z',
    offersCount: 0,
    category: { id: 'cat', name: 'Klima', slug: 'klima' },
    showcaseLead: null,
    ...overrides,
  };
}

function render(requests: CustomerServiceRequest[]) {
  return renderToStaticMarkup(<RequestsBoard requests={requests} />);
}

describe('a request waiting for the customer’s phone proof', () => {
  it('carries the badge and the way to the card', () => {
    const markup = render([row({ awaitingPhoneVerification: true })]);
    expect(markup).toContain('data-testid="request-phone-pending"');
    expect(markup).toContain('Telefon doğrulaması bekliyor');
    expect(markup).toContain('href="/requests/cmfabcdefghijklmnopqrstuv/offers#telefon-dogrulama"');
    expect(markup).toContain('Telefonu doğrula');
  });
});

describe('every other request', () => {
  it('shows neither the badge nor the link', () => {
    for (const status of ['SUBMITTED', 'APPROVED', 'MATCHED', 'COMPLETED']) {
      const markup = render([row({ status, awaitingPhoneVerification: false })]);
      expect(markup, status).not.toContain('request-phone-pending');
      expect(markup, status).not.toContain('#telefon-dogrulama');
    }
    // An older API answer without the field is not waiting on the customer.
    expect(render([row()])).not.toContain('request-phone-pending');
  });
});
