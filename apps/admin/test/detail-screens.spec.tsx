import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ActivityLog, NO_CHANGE_HISTORY_NOTE, recordLifecycleEntries } from '../components/activity-log';
import { DetailFormFooter, LockedField } from '../components/detail-form-footer';
import { categoryActivity } from '../app/categories/[slug]/category-activity';
import {
  QuestionSetSection,
  ReleaseChecklistSection,
  describeQuestionCondition,
  type QuestionActions,
} from '../app/categories/[slug]/category-sections';
import { packageSummarySentence, perCreditMinor } from '../app/credit-packages/credit-package-cells';
import { showcasePackageSales } from '../app/showcase/packages/showcase-package-sales';
import type { AdminOfferPackage, Category, PackagePurchase, ProviderInvite, Question } from '../lib/api';

/**
 * ADMIN-DESIGN-001 Faz 3F.1 — the three catalogue detail screens as tabbed
 * pages. Pinned here: "Neler oldu" is built only from instants the records
 * carry; the question table says when a question is asked in the option's own
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
    updatedAt: '2026-08-28T06:41:00.400Z',
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
    ...overrides,
  };
}

describe('Neler oldu: only the instants the records carry', () => {
  it('draws "Oluşturuldu", and "Son güncellendi" only when the row was saved later', () => {
    const same = recordLifecycleEntries({
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.500Z',
      created: 'Paket oluşturuldu',
      updated: 'Paket son güncellendi',
    });
    expect(same.map((entry) => entry.title)).toEqual(['Paket oluşturuldu']);
    const later = recordLifecycleEntries({
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
      created: 'Paket oluşturuldu',
      updated: 'Paket son güncellendi',
    });
    expect(later.map((entry) => entry.title)).toEqual(['Paket oluşturuldu', 'Paket son güncellendi']);
    // Nobody is named where nobody is recorded.
    expect(later.every((entry) => entry.actor === null)).toBe(true);
  });

  it('builds a category log from the category, its questions and its invitations', () => {
    const entries = categoryActivity({
      category: category(),
      questions: [question()],
      invites: [
        invite(),
        invite({ id: 'inv-2', state: 'USED', usedAt: '2026-09-18T11:20:00.000Z' }),
        invite({ id: 'inv-3', state: 'REVOKED', revokedAt: '2026-09-04T10:45:00.000Z', createdBy: null }),
        invite({ id: 'inv-4', state: 'EXPIRED', expiresAt: '2026-09-09T07:00:00.000Z' }),
      ],
    });
    const titles = entries.map((entry) => entry.title);
    expect(titles).toContain('Kategori oluşturuldu');
    expect(titles).toContain('Kategori son güncellendi');
    expect(titles).toContain('"Ne tür bir hizmet?" sorusu eklendi');
    // Saved in the same statement as its creation: not an edit.
    expect(titles).not.toContain('"Ne tür bir hizmet?" sorusu son güncellendi');
    expect(titles.filter((title) => title === 'Davet bağlantısı oluşturuldu')).toHaveLength(4);
    expect(titles).toContain('Davet bağlantısı kullanıldı');
    expect(titles).toContain('Davet bağlantısı iptal edildi');
    expect(titles).toContain('Davet bağlantısının süresi doldu');
    // Only the issuing is attributed, and only when the row names somebody.
    const issued = entries.filter((entry) => entry.title === 'Davet bağlantısı oluşturuldu');
    expect(issued.map((entry) => entry.actor)).toEqual(['Seda Kaya', 'Seda Kaya', null, 'Seda Kaya']);
    expect(entries.find((entry) => entry.title === 'Davet bağlantısı iptal edildi')!.actor).toBeNull();
  });

  it('leaves out what the session did not read', () => {
    const entries = categoryActivity({ category: category(), questions: null, invites: null });
    expect(entries.map((entry) => entry.title)).toEqual(['Kategori oluşturuldu', 'Kategori son güncellendi']);
  });

  it('renders newest first, says "Kayıtlı değil" for an unknown actor, and carries the footnote', () => {
    const out = html(
      <ActivityLog
        entries={[
          { key: 'a', at: '2026-01-01T00:00:00.000Z', title: 'Eski', actor: null },
          { key: 'b', at: '2026-03-01T00:00:00.000Z', title: 'Yeni', actor: 'Seda Kaya' },
        ]}
        footnote={NO_CHANGE_HISTORY_NOTE}
        testId="log"
      />,
    );
    expect(out.indexOf('Yeni')).toBeLessThan(out.indexOf('Eski'));
    expect(out).toContain('Kayıtlı değil');
    expect(out).toContain('Seda Kaya');
    expect(out).toContain('data-testid="log-footnote"');
    expect(out).toContain('geçmişi tutulmuyor');
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
  const purchase = (overrides: Partial<PackagePurchase>): PackagePurchase =>
    ({
      id: 'p',
      status: 'PAID',
      createdAt: '2026-09-01T00:00:00.000Z',
      priceAmountSnapshot: 240000,
      currencySnapshot: 'TRY',
      showcasePackage: { id: 'vp-1' },
      showcasePlacement: null,
      ...overrides,
    }) as PackagePurchase;

  it('keeps this package’s rows and counts only what the rows say', () => {
    const sales = showcasePackageSales('vp-1', [
      purchase({ id: 'a', showcasePlacement: { id: 'pl-1', status: 'ACTIVE', startAt: '', endAt: '' } }),
      purchase({ id: 'b', createdAt: '2026-09-02T00:00:00.000Z' }),
      purchase({ id: 'c', status: 'PENDING' }),
      purchase({ id: 'd', showcasePackage: { id: 'other' } as PackagePurchase['showcasePackage'] }),
      purchase({ id: 'e', showcasePackage: null }),
    ]);
    // Newest first; a tie is broken by id, newest-looking first, so the order is stable.
    expect(sales.rows.map((row) => row.id)).toEqual(['b', 'c', 'a']);
    expect(sales.paid).toBe(2);
    expect(sales.pending).toBe(1);
    expect(sales.live).toBe(1);
    expect(sales.paidWithoutRun).toBe(1);
    expect(sales.revenue).toEqual([['TRY', 480000]]);
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
