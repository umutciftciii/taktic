import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ActivityLog } from '../components/activity-log';
import { AuditTimeline, describeAuditEntry, formatAuditValue } from '../components/audit-timeline';
import { DetailFormFooter, LockedField } from '../components/detail-form-footer';
import { inviteActivity } from '../app/categories/[slug]/category-activity';
import {
  QuestionSetSection,
  ReleaseChecklistSection,
  describeQuestionCondition,
  type QuestionActions,
} from '../app/categories/[slug]/category-sections';
import { packageSummarySentence, perCreditMinor } from '../app/credit-packages/credit-package-cells';
import { showcasePackageSalesFacts, showcasePackageSalesQuery } from '../app/showcase/packages/showcase-package-sales';
import type {
  AdminAuditEntry,
  AdminAuditPage,
  AdminOfferPackage,
  Category,
  PackagePurchaseSummary,
  ProviderInvite,
  Question,
} from '../lib/api';
import { formatMinorAsTurkishLira } from '@taktic/shared';

/**
 * ADMIN-DESIGN-001 Faz 3F.1 — the three catalogue detail screens as tabbed
 * pages. Pinned here: "Neler oldu" draws the catalogue audit as recorded
 * (ADMIN-ACTION-AUDIT-001) and the invitation instants with their operators;
 * the question table says when a question is asked in the option's own
 * words; the vitrin package reads its sales without inventing an entitlement
 * state; and every route and section gate is where it was.
 */

const html = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);
const noop = () => undefined;
const QUESTION_ACTIONS: QuestionActions = { update: noop, replaceConditions: noop, updateStatus: noop, create: noop };

function category(overrides: Partial<Category> = {}): Category {
  return {
    id: 'cat-1',
    parentId: null,
    parent: null,
    kind: 'LEAF',
    status: 'DRAFT',
    name: 'Kombi servisi',
    slug: 'kombi-servisi',
    description: null,
    imageUrl: null,
    coverImageUrl: null,
    iconKey: null,
    isActive: false,
    sortOrder: 10,
    offerCreditCost: 3,
    providerEnrollmentOpen: false,
    unlimitedPackageEligible: false,
    supplyStatus: 'EMPTY',
    createdAt: '2026-07-09T12:30:00.000Z',
    updatedAt: '2026-09-12T07:20:00.000Z',
    _count: { questions: 2, children: 0, providers: 0, providerInvites: 1 },
    ...overrides,
  } as Category;
}

function question(overrides: Partial<Question> = {}): Question {
  return {
    id: 'q-1',
    categoryId: 'cat-1',
    key: 'tur',
    label: 'Ne tür bir hizmet?',
    helpText: null,
    type: 'SELECT',
    isRequired: true,
    isActive: true,
    isRouter: false,
    systemField: null,
    sortOrder: 10,
    options: [
      { key: 'bakim', label: 'Bakım' },
      { key: 'ariza', label: 'Arıza' },
    ],
    conditions: [],
    routerRules: [],
    createdAt: '2026-08-28T06:41:00.000Z',
    updatedAt: '2026-08-28T06:41:00.000Z',
    ...overrides,
  } as Question;
}

function invite(overrides: Partial<ProviderInvite> = {}): ProviderInvite {
  return {
    id: 'inv-1',
    state: 'ACTIVE',
    createdAt: '2026-09-27T08:40:00.000Z',
    expiresAt: '2026-10-11T08:40:00.000Z',
    usedAt: null,
    revokedAt: null,
    createdBy: { id: 'u-1', name: 'Seda Kaya' },
    revokedBy: null,
    ...overrides,
  };
}

function auditEntry(overrides: Partial<AdminAuditEntry> = {}): AdminAuditEntry {
  return {
    id: 'a-1',
    domain: 'CATEGORY',
    action: 'UPDATED',
    actor: { id: 'u-1', name: 'Seda Kaya' },
    target: { type: 'CATEGORY', id: 'cat-1' },
    changes: [{ field: 'name', from: 'Kombi', to: 'Kombi servisi' }],
    reason: null,
    createdAt: '2026-10-01T09:00:00.000Z',
    ...overrides,
  };
}

function auditPage(items: AdminAuditEntry[], overrides: Partial<AdminAuditPage> = {}): AdminAuditPage {
  return { items, total: items.length, page: 1, pageSize: 20, hasNextPage: false, ...overrides };
}

describe('Neler oldu: the recorded audit, drawn as recorded (ADMIN-ACTION-AUDIT-001)', () => {
  it('draws each field diff old → new, in the API order, with the operator', () => {
    const out = html(
      <AuditTimeline
        page={auditPage([
          auditEntry({ id: 'a-2', action: 'STATUS_CHANGED', changes: [{ field: 'status', from: 'DRAFT', to: 'ACTIVE' }] }),
          auditEntry({
            id: 'a-1',
            action: 'CREATED',
            createdAt: '2026-09-01T09:00:00.000Z',
            changes: [{ field: 'parent', from: null, to: { id: 'g-1', name: 'Isıtma' } }],
          }),
        ])}
        testId="log"
      />,
    );
    expect(out.indexOf('Durumu değişti')).toBeLessThan(out.indexOf('Oluşturuldu'));
    expect(out).toContain('Taslak');
    expect(out).toContain('Yayında');
    expect(out).toContain('Üst kategori:');
    expect(out).toContain('Isıtma');
    expect(out).toContain('Seda Kaya');
    expect(out).not.toContain('geçmişi tutulmuyor');
  });

  it('says "Bilinmiyor" for no actor and falls back to the id for a nameless one — never a made-up name', () => {
    const out = html(
      <AuditTimeline
        page={auditPage([
          auditEntry({ id: 'a-1', actor: null }),
          auditEntry({ id: 'a-2', actor: { id: 'u-gone', name: null } }),
        ])}
      />,
    );
    expect(out).toContain('Bilinmiyor');
    expect(out).toContain('Hesap #u-gone');
  });

  it('shows the empty state and pages on its own parameter', () => {
    expect(html(<AuditTimeline page={auditPage([])} empty="Henüz yok." />)).toContain('Henüz yok.');
    const paged = html(
      <AuditTimeline
        page={auditPage([auditEntry()], { total: 45, page: 2, hasNextPage: true })}
        pager={{ path: '/categories/kombi', params: { tab: 'gecmis' }, pageParam: 'gecmisSayfa' }}
      />,
    );
    expect(paged).toContain('href="/categories/kombi?tab=gecmis"');
    expect(paged).toContain('href="/categories/kombi?tab=gecmis&amp;gecmisSayfa=3"');
  });

  it('formats values by field: money, on/off, references and empty', () => {
    expect(formatAuditValue('CREDIT_PACKAGE', 'isActive', false)).toBe('Pasif');
    expect(formatAuditValue('CATEGORY', 'unlimitedPackageEligible', true)).toBe('Evet');
    expect(formatAuditValue('CREDIT_PACKAGE', 'scopeCategories', [])).toBe('—');
    expect(formatAuditValue('CREDIT_PACKAGE', 'scopeCategories', [{ id: 'k', name: 'Klima' }])).toBe('Klima');
    expect(formatAuditValue('PROVIDER', 'status', 'PENDING_REVIEW')).toBe('İnceleme bekliyor');
    expect(formatAuditValue('CATEGORY', 'status', 'INACTIVE')).toBe('Kapalı');
    expect(formatAuditValue('SHOWCASE_PACKAGE', 'priceAmount', 49_900)).toMatch(/499/);
    expect(formatAuditValue('COMPANY_SETTINGS', 'postalAddress', null)).toBe('—');
  });

  it('a role edit says which fields changed and that their old values are not recorded', () => {
    const { note } = describeAuditEntry(
      auditEntry({ domain: 'ADMIN_ROLE', action: 'ROLE_UPDATED', changes: [], payload: { key: 'r', changed: ['name'], isActive: true } }),
    );
    const out = html(<>{note}</>);
    expect(out).toContain('Değişen alan: ad');
    expect(out).toContain('eski değer kaydedilmez');
  });

  it('a provider transition carries its rejection reason and its note, not a fake diff of the note', () => {
    const { title, note } = describeAuditEntry(
      auditEntry({
        domain: 'PROVIDER',
        action: 'STATUS_CHANGED',
        changes: [{ field: 'status', from: 'APPROVED', to: 'REJECTED' }],
        reason: 'Belge eksik',
        note: 'Arandı',
      }),
    );
    expect(title).toBe('Durum: Onaylandı → Reddedildi');
    const out = html(<>{note}</>);
    expect(out).toContain('Ret gerekçesi: Belge eksik');
    expect(out).toContain('Moderasyon notu: Arandı');
  });
});

describe('invitation history: recorded instants and operators', () => {
  it('names who withdrew a link, and "Bilinmiyor" for one withdrawn before that was recorded', () => {
    const entries = inviteActivity([
      invite(),
      invite({ id: 'inv-2', state: 'USED', usedAt: '2026-09-18T11:20:00.000Z' }),
      invite({
        id: 'inv-3',
        state: 'REVOKED',
        revokedAt: '2026-09-04T10:45:00.000Z',
        revokedBy: { id: 'u-2', name: 'Ali Veli' },
      }),
      invite({ id: 'inv-5', state: 'REVOKED', revokedAt: '2026-09-02T10:45:00.000Z', createdBy: null }),
      invite({ id: 'inv-4', state: 'EXPIRED', expiresAt: '2026-09-09T07:00:00.000Z' }),
    ]);
    const titles = entries.map((entry) => entry.title);
    expect(titles.filter((title) => title === 'Davet bağlantısı oluşturuldu')).toHaveLength(5);
    expect(titles).toContain('Davet bağlantısı kullanıldı');
    expect(titles).toContain('Davet bağlantısının süresi doldu');
    const revoked = entries.filter((entry) => entry.title === 'Davet bağlantısı iptal edildi');
    expect(revoked.map((entry) => entry.actor)).toEqual(['Ali Veli', 'Bilinmiyor']);
    // The category's own create/save instants are no longer drawn from timestamps.
    expect(titles).not.toContain('Kategori son güncellendi');
  });

  it('ActivityLog renders newest first and says "Kayıtlı değil" for an unknown issuer', () => {
    const out = html(
      <ActivityLog
        entries={[
          { key: 'a', at: '2026-01-01T00:00:00.000Z', title: 'Eski', actor: null },
          { key: 'b', at: '2026-03-01T00:00:00.000Z', title: 'Yeni', actor: 'Seda Kaya' },
        ]}
        footnote="Not"
        testId="log"
      />,
    );
    expect(out.indexOf('Yeni')).toBeLessThan(out.indexOf('Eski'));
    expect(out).toContain('Kayıtlı değil');
    expect(out).toContain('data-testid="log-footnote"');
  });
});

describe('question table: "Ne zaman sorulur" in the options’ own words', () => {
  const source = question();

  it('always, without a rule', () => {
    expect(describeQuestionCondition(source, [source])).toEqual({ when: 'Her zaman', source: null });
  });

  it('names the expected option by its label, joined by the rule’s mode', () => {
    const any = question({
      id: 'q-2',
      key: 'foto',
      conditions: [{ sourceQuestionKey: 'tur', sourceQuestionLabel: 'Ne tür bir hizmet?', expectedValues: ['ariza'] }],
    });
    expect(describeQuestionCondition(any, [source, any])).toEqual({
      when: '"Arıza" seçilirse',
      source: 'Ne tür bir hizmet?',
    });
    const all = question({
      id: 'q-3',
      conditions: [
        { sourceQuestionKey: 'tur', sourceQuestionLabel: 'Ne tür bir hizmet?', expectedValues: ['bakim', 'ariza'], matchMode: 'ALL' },
      ],
    });
    expect(describeQuestionCondition(all, [source, all]).when).toBe('"Bakım" ve "Arıza" seçilirse');
  });

  it('falls back to the key when the option is gone, rather than dropping it', () => {
    const orphan = question({
      id: 'q-4',
      conditions: [{ sourceQuestionKey: 'tur', sourceQuestionLabel: 'Ne tür bir hizmet?', expectedValues: ['silinmis'] }],
    });
    expect(describeQuestionCondition(orphan, [source, orphan]).when).toBe('"silinmis" seçilirse');
  });

  it('draws the design’s columns and keeps the inline editor', () => {
    const out = html(
      <QuestionSetSection category={category()} questions={[source]} isRouter={false} canWriteQuestions actions={QUESTION_ACTIONS} />,
    );
    for (const header of ['Sıra', 'Soru', 'Cevap tipi', 'Zorunlu', 'Ne zaman sorulur', 'Durum', 'İşlem']) {
      expect(out).toContain(`<span>${header}</span>`);
    }
    expect(out).toContain('Tek seçim');
    expect(out).toContain('2 seçenek');
    expect(out).toContain('1 soru · 1 aktif');
    expect(out).toContain('Soruyu kaydet');
    expect(out).toContain('Koşulu kaydet');
    expect(out).toContain('Yeni soru ekle');
  });
});

describe('release checklist stays a draft’s', () => {
  it('keeps every row and test id', () => {
    const out = html(<ReleaseChecklistSection category={category()} blockers={['NO_APPROVED_PROVIDER']} questionCount={2} />);
    expect(out).toContain('data-testid="draft-explainer"');
    expect(out).toContain('data-testid="release-checklist"');
    expect(out).toContain('data-testid="release-active-invites"');
    expect(out).toContain('data-testid="enrollment-note"');
    expect(out).toContain('data-testid="release-blocker-NO_APPROVED_PROVIDER"');
    expect(out).toContain('Hazır değil');
  });
});

describe('credit package summary line and per-credit price', () => {
  const base = {
    creditAmount: 150,
    quotaCredits: null,
    periodDays: null,
    dailyOfferLimit: null,
    scopeCategories: [],
    priceAmount: 240000,
  } as unknown as AdminOfferPackage;

  it('says what each type does with the package’s own figures', () => {
    expect(packageSummarySentence({ ...base, type: 'ONE_TIME_CREDITS' })).toContain('tek seferde 150 kredi');
    expect(packageSummarySentence({ ...base, type: 'MONTHLY_QUOTA', quotaCredits: 200, periodDays: 30 })).toContain(
      '30 gün geçerli 200 kredi',
    );
    const unlimited = packageSummarySentence({
      ...base,
      type: 'CATEGORY_UNLIMITED',
      dailyOfferLimit: 5,
      scopeCategories: [{ category: { id: 'c', name: 'Kombi', slug: 'kombi' } }],
    } as unknown as AdminOfferPackage);
    expect(unlimited).toContain('Kapsam: Kombi');
    expect(unlimited).toContain('günlük en fazla 5 teklif');
  });

  it('prices one credit only where a package sells credits', () => {
    expect(perCreditMinor({ ...base, type: 'ONE_TIME_CREDITS' })).toBe(1600);
    expect(perCreditMinor({ ...base, type: 'MONTHLY_QUOTA', quotaCredits: 0 })).toBeNull();
    expect(perCreditMinor({ ...base, type: 'CATEGORY_UNLIMITED' })).toBeNull();
  });
});

describe('vitrin package sales', () => {
  const summary = (overrides: Partial<PackagePurchaseSummary> = {}): PackagePurchaseSummary => ({
    total: 4,
    byStatus: { PENDING: 1, PAID: 3, FAILED: 0, CANCELLED: 0, EXPIRED: 0, REFUNDED: 0 },
    paidRevenue: [{ currency: 'TRY', amount: 720000 }],
    activeRuns: 1,
    entitlements: { AVAILABLE: 1, RESERVED: 0, CONSUMED: 1, EXPIRED: 1 },
    asOf: '2026-10-02T00:00:00.000Z',
    ...overrides,
  });

  it('draws the API’s own totals, rights by their effective status', () => {
    const facts = showcasePackageSalesFacts(summary(), 'TRY');
    expect(facts.map((fact) => [fact.testId, fact.value])).toEqual([
      ['showcase-sales-total', '4'],
      ['showcase-sales-revenue', formatMinorAsTurkishLira(720000, 'TRY')],
      ['showcase-sales-live', '1'],
      ['showcase-sales-rights', '1'],
    ]);
    expect(facts[0]!.note).toBe('3 ödenmiş · 1 bekleyen');
    expect(facts[3]!.note).toBe('0 karta bağlı · 1 kullanıldı · 1 süresi doldu');
  });

  it('says "Çoklu para birimi" rather than adding currencies together', () => {
    const facts = showcasePackageSalesFacts(
      summary({ paidRevenue: [{ currency: 'EUR', amount: 100 }, { currency: 'TRY', amount: 200 }] }),
      'TRY',
    );
    expect(facts[1]!.value).toBe('Çoklu para birimi');
  });

  it('asks the API for one package, paged on the server', () => {
    expect(showcasePackageSalesQuery('vp-1')).toBe('showcasePackageId=vp-1');
    expect(showcasePackageSalesQuery('vp-1', 2)).toBe('showcasePackageId=vp-1&page=2&pageSize=10');
  });

  it('no longer reads the whole purchase list to filter it here', () => {
    const source = readFileSync(resolve(__dirname, '..', 'app/showcase/packages/[id]/page.tsx'), 'utf8');
    expect(source).not.toContain("apiFetch<PackagePurchase[]>('/package-purchases')");
    expect(source).toContain('/package-purchases/summary?');
  });
});

describe('form footer and locked field', () => {
  it('resets instead of navigating, and marks a value that is not sent', () => {
    const footer = html(
      <DetailFormFooter note="Not">
        <button type="submit">Kaydet</button>
      </DetailFormFooter>,
    );
    expect(footer).toContain('type="reset"');
    expect(footer).toContain('Vazgeç');
    const locked = html(<LockedField label="Tür" value="Tek seferlik kredi" />);
    expect(locked).toContain('Değiştirilemez');
    expect(locked).not.toContain('<input');
  });
});

describe('route, tab and action gates (source)', () => {
  const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

  it('the vitrin package screen reads its own route and gates every section and action', () => {
    const source = read('app/showcase/packages/[id]/page.tsx');
    expect(source).toContain("requireAdmin('SHOWCASE_PACKAGES_READ')");
    for (const gate of [
      "can('SHOWCASE_PACKAGES_WRITE')",
      "can('PACKAGE_PURCHASES_READ')",
      "can('PROVIDERS_READ_DETAIL')",
      "can('SHOWCASE_PLACEMENTS_READ')",
      "can('SHOWCASE_TERMS_ACCEPTANCES_READ')",
    ]) {
      expect(source, gate).toContain(gate);
    }
    expect(source).toContain('/admin/showcase/packages/${encodeURIComponent(id)}');
    // The slug is shown, never posted.
    expect(source).not.toMatch(/name="slug"/);
  });

  it('tabs are drawn only for what the session may read', () => {
    const categoryPage = read('app/categories/[slug]/page.tsx');
    expect(categoryPage).toMatch(/\.\.\.\(questions \? \[\{ key: 'sorular'/);
    expect(categoryPage).toMatch(/\.\.\.\(invites\s*\? \[\{ key: 'davetler'/);
    const packagePage = read('app/credit-packages/[id]/page.tsx');
    expect(packagePage).toMatch(/\.\.\.\(canReadPurchases\s*\? \[\{ key: 'satislar'/);
  });
});
