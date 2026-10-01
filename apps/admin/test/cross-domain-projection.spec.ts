import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DataColumn } from '../components/data-table';
import {
  customerColumnGates,
  customerDefaultSort,
  customerSortFields,
  gateColumns,
  providerColumnGates,
} from '../lib/cross-domain-projection';

/**
 * API-ADMIN-CROSS-DOMAIN-PROJECTION-RBAC-001, the screen side: the API leaves
 * another domain's block out of a response for a session that cannot read
 * that domain, so a screen must not draw a column, figure, tab or control for
 * it — an empty cell or a `0` would state what the response did not.
 */

const columns = (...keys: string[]): DataColumn[] => keys.map((key) => ({ key, label: key }));
const keys = (list: DataColumn[]) => list.map((column) => column.key);

describe('gateColumns', () => {
  it('keeps ungated columns and drops a gated one whose gate is closed', () => {
    expect(keys(gateColumns(columns('a', 'b', 'c'), { b: false, c: true }))).toEqual(['a', 'c']);
  });
});

describe('provider list figures', () => {
  const all = columns('business', 'contact', 'credit', 'offers', 'packages', 'actions');

  it('draws each figure column only with its own permission', () => {
    expect(keys(gateColumns(all, providerColumnGates({ credit: false, offers: false, packages: false })))).toEqual([
      'business',
      'contact',
      'actions',
    ]);
    expect(keys(gateColumns(all, providerColumnGates({ credit: true, offers: false, packages: true })))).toEqual([
      'business',
      'contact',
      'credit',
      'packages',
      'actions',
    ]);
  });
});

describe('customer list figures', () => {
  const all = columns('customer', 'phone', 'city', 'requests', 'offers', 'accepted', 'lastRequest', 'status');

  it('drops the request and offer columns, the sorts on them and the request default', () => {
    const none = { requests: false, offers: false };
    expect(keys(gateColumns(all, customerColumnGates(none)))).toEqual(['customer', 'phone', 'status']);
    expect(customerSortFields(none)).toEqual(['name', 'createdAt']);
    expect(customerDefaultSort(none)).toBe('createdAt');
  });

  it('opens each domain on its own', () => {
    const requests = { requests: true, offers: false };
    expect(keys(gateColumns(all, customerColumnGates(requests)))).toEqual([
      'customer',
      'phone',
      'city',
      'requests',
      'lastRequest',
      'status',
    ]);
    expect(customerSortFields(requests)).toEqual(['name', 'createdAt', 'lastRequestAt', 'requestCount']);
    expect(customerDefaultSort(requests)).toBe('lastRequestAt');

    const offers = { requests: false, offers: true };
    expect(customerSortFields(offers)).toEqual(['name', 'createdAt', 'offerCount', 'acceptedOfferCount']);
    expect(customerDefaultSort(offers)).toBe('createdAt');
  });
});

describe('detail screens draw a block only where the API sent it (source)', () => {
  const source = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

  it('provider detail: facts, tab and cards follow FINANCE_LEDGER_READ / OFFERS_READ / PACKAGE_PURCHASES_READ', () => {
    const page = source('app/providers/[id]/page.tsx');
    expect(page).toContain('const hasActivityTab = canReadOffers || canReadPackagePurchases;');
    expect(page).toMatch(/\.\.\.\(canReadCredits\s*\?\s*\[\s*\{\s*label: 'Kredi bakiyesi'/);
    expect(page).toMatch(/\.\.\.\(canReadOffers\s*\?\s*\[\s*\{\s*label: 'Açık teklif'/);
    expect(page).toMatch(/\.\.\.\(canReadPackagePurchases\s*\?\s*\[\{ label: 'Paket alımı'/);
    expect(page).toMatch(/\{canReadOffers \? \(\s*<SectionCard\s*title="Son teklifler"/);
    expect(page).toMatch(/\{canReadPackagePurchases \? \(\s*<SectionCard\s*title="Son paket alımları"/);
  });

  it('customer detail: history tabs and figures follow REQUESTS_READ / OFFERS_READ', () => {
    const page = source('app/customers/[id]/page.tsx');
    expect(page).toContain("(key !== 'talepler' || links.requests)");
    expect(page).toContain("(key !== 'teklifler' || links.offers)");
    expect(page).toContain("activeTab === 'talepler' && links.requests");
    expect(page).toContain("activeTab === 'teklifler' && links.offers");
    expect(page).not.toContain('metrics.requestCount)');
  });

  it('offer detail: contact rows only where sent, and the status rule reads the reference, not the account', () => {
    const page = source('app/offers/[id]/page.tsx');
    expect(page).toContain('isSuperAdmin || offer.request.customerId === null');
    expect(page).not.toContain('offer.request.customer === null');
    expect(page).toContain('offer.provider.contactName !== undefined');
    expect(page).toContain('offer.request.customerName !== undefined');
  });

  it('request detail: a linked account the session cannot open still reads as linked', () => {
    const page = source('app/requests/[id]/page.tsx');
    expect(page).toMatch(/\) : request\.customerId \? \(\s*<span data-testid="request-account-linked">/);
  });
});
