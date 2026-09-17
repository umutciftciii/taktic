import { describe, expect, it } from 'vitest';
import { requestContentRows } from '../lib/request-content';
import type { CustomerServiceRequestDetail } from '../lib/api';

/**
 * The "what I sent" block on the customer's own request page.
 *
 * One row per value the customer actually gave, in a fixed order; no row at
 * all for a field left empty — never a dash, never "belirtilmedi", never a
 * value the customer did not type. The answers come from the API already in
 * words (`displayValue`), so an option key never reaches the screen. Nothing
 * here reads the phone, the e-mail or the contact name: the block is about
 * the job, not about who to call.
 */

function detail(overrides: Partial<CustomerServiceRequestDetail> = {}): CustomerServiceRequestDetail {
  return {
    id: 'cmfabcdefghijklmnopqrstuv',
    requestNumber: 'TR-2026-000123',
    status: 'APPROVED',
    customerName: 'Ayşe Yılmaz',
    customerPhone: '+905000000001',
    customerEmail: 'ayse@example.test',
    city: 'İstanbul',
    district: 'Kadıköy',
    neighborhood: null,
    addressNote: null,
    budgetMin: null,
    budgetMax: null,
    description: null,
    preferredDate: null,
    preferredDateEnd: null,
    urgency: null,
    qualityScore: 70,
    qualityLabel: 'GOOD' as CustomerServiceRequestDetail['qualityLabel'],
    phoneVerifiedAt: null,
    expiredAt: null,
    submittedAt: '2026-09-17T10:00:00.000Z',
    offersCount: 0,
    category: { id: 'cat', name: 'Klima', slug: 'klima' },
    showcaseLead: null,
    answers: [],
    ...overrides,
  };
}

const labelsOf = (rows: ReturnType<typeof requestContentRows>) => rows.map((row) => row.label);

describe('a fully filled request', () => {
  const rows = requestContentRows(
    detail({
      description: 'Salon kliması soğutmuyor.',
      neighborhood: 'Caferağa Mah',
      addressNote: 'Kapıcıya haber verin',
      budgetMin: 150000,
      budgetMax: 250000,
      preferredDate: '2026-10-01T00:00:00.000Z',
      preferredDateEnd: '2026-10-05T00:00:00.000Z',
      urgency: 'FLEXIBLE',
      answers: [
        { questionKey: 'klima_tipi', questionLabel: 'Klima tipi', questionType: 'SELECT', value: 'salon', displayValue: 'Salon tipi' },
        { questionKey: 'ek_hizmet', questionLabel: 'Ek hizmetler', questionType: 'MULTI_SELECT', value: ['gaz'], displayValue: 'Gaz dolumu' },
      ],
    }),
  );

  it('lists every value, the answers in the middle, in a fixed order', () => {
    expect(labelsOf(rows)).toEqual([
      'Açıklama',
      'Klima tipi',
      'Ek hizmetler',
      'Konum',
      'Adres notu',
      'Tercih edilen tarih',
      'Bütçe',
      'Aciliyet',
    ]);
  });

  it('prints each value in words', () => {
    const byLabel = new Map(rows.map((row) => [row.label, row.value]));
    expect(byLabel.get('Açıklama')).toBe('Salon kliması soğutmuyor.');
    expect(byLabel.get('Klima tipi')).toBe('Salon tipi');
    expect(byLabel.get('Ek hizmetler')).toBe('Gaz dolumu');
    expect(byLabel.get('Konum')).toBe('İstanbul, Kadıköy, Caferağa Mah');
    expect(byLabel.get('Adres notu')).toBe('Kapıcıya haber verin');
    expect(byLabel.get('Tercih edilen tarih')).toMatch(/1 Eki 2026/);
    expect(byLabel.get('Tercih edilen tarih')).toMatch(/5 Eki 2026/);
    expect(byLabel.get('Bütçe')).toBe('₺1.500,00 - ₺2.500,00');
    expect(byLabel.get('Aciliyet')).toBe('Esnek');
  });

  it('keys every row for a stable test id', () => {
    expect(rows.map((row) => row.key)).toEqual([
      'description',
      'answer-klima_tipi',
      'answer-ek_hizmet',
      'location',
      'address-note',
      'preferred-date',
      'budget',
      'urgency',
    ]);
  });

  it('carries no phone, e-mail or contact name', () => {
    const text = rows.map((row) => `${row.label} ${row.value}`).join(' ');
    expect(text).not.toContain('+905000000001');
    expect(text).not.toContain('ayse@example.test');
    expect(text).not.toContain('Ayşe Yılmaz');
  });
});

describe('an empty field', () => {
  it('has no row at all — only the location, which every request has', () => {
    expect(labelsOf(requestContentRows(detail()))).toEqual(['Konum']);
    expect(requestContentRows(detail())[0]?.value).toBe('İstanbul, Kadıköy');
  });

  it('is not filled in by whitespace', () => {
    const rows = requestContentRows(detail({ description: '   ', addressNote: '' }));
    expect(labelsOf(rows)).toEqual(['Konum']);
  });

  it('is not filled in by an answer whose display value is empty', () => {
    const rows = requestContentRows(
      detail({
        answers: [{ questionKey: 'not', questionLabel: 'Ek not', questionType: 'TEXTAREA', value: '', displayValue: '' }],
      }),
    );
    expect(labelsOf(rows)).toEqual(['Konum']);
  });

  it('reads an older answer without the columns as empty', () => {
    const legacy = detail();
    delete (legacy as Partial<CustomerServiceRequestDetail>).description;
    delete (legacy as Partial<CustomerServiceRequestDetail>).neighborhood;
    delete (legacy as Partial<CustomerServiceRequestDetail>).answers;
    expect(labelsOf(requestContentRows(legacy))).toEqual(['Konum']);
  });
});

describe('half-given values', () => {
  it('shows a budget with one end only', () => {
    expect(requestContentRows(detail({ budgetMin: 100000 })).find((row) => row.key === 'budget')?.value).toBe(
      '₺1.000,00+',
    );
    expect(requestContentRows(detail({ budgetMax: 100000 })).find((row) => row.key === 'budget')?.value).toBe(
      '≤ ₺1.000,00',
    );
  });

  it('shows a single day when the range has no end', () => {
    const value = requestContentRows(detail({ preferredDate: '2026-10-01T00:00:00.000Z' })).find(
      (row) => row.key === 'preferred-date',
    )?.value;
    expect(value).toMatch(/1 Eki 2026/);
    expect(value).not.toContain('–');
  });

  it('shows an urgency code the shared table does not know as nothing', () => {
    expect(labelsOf(requestContentRows(detail({ urgency: 'SOMEDAY' })))).toEqual(['Konum']);
  });
});
