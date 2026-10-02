import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  CategoryInfoSection,
  CategoryStatusSection,
  QuestionSetSection,
  ReleaseChecklistSection,
  RouterTargetsSection,
  type QuestionActions,
} from '../app/categories/[slug]/category-sections';
import { CATEGORIES_SCREEN_INFO, TreeReadiness, treeRowContext } from '../app/categories/category-list-cells';
import { releaseBlockers } from '../app/categories/category-taxonomy';
import {
  CREDIT_PACKAGES_SCREEN_INFO,
  PackageOrderCell,
  PackageStatusForm,
  packageAllowance,
  packageTypeLabel,
} from '../app/credit-packages/credit-package-cells';
import { WholeListFooter } from '../components/pagination';
import type { Category, Question } from '../lib/api';

/**
 * ADMIN-DESIGN-001 Faz 3F — the catalogue screens. The redesign moved the
 * category editors into their own sections; what is pinned here is that each
 * control is still drawn under exactly the permission and state it was drawn
 * under before (the plan's "Faz 3F envanter"), and that the list cells say
 * what the rules say.
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
    _count: { questions: 2, children: 0, providers: 0, providerInvites: 1 },
    ...overrides,
  } as Category;
}

function question(overrides: Partial<Question> = {}): Question {
  return {
    id: 'q-1',
    categoryId: 'cat-1',
    key: 'cihaz',
    label: 'Hangi cihaz?',
    helpText: null,
    type: 'SELECT',
    isRequired: true,
    isActive: true,
    isRouter: false,
    systemField: null,
    sortOrder: 10,
    options: [
      { key: 'kombi', label: 'Kombi' },
      { key: 'klima', label: 'Klima' },
    ],
    conditions: [],
    routerRules: [],
    ...overrides,
  } as Question;
}

describe('category form: CATEGORIES_WRITE, CATEGORIES_STATUS and UPLOADS_WRITE', () => {
  const render = (flags: { canWrite: boolean; canChangeStatus: boolean; canUpload: boolean }, over: Partial<Category> = {}) =>
    html(<CategoryInfoSection category={category(over)} groups={[]} updateAction={noop} {...flags} />);

  it('without CATEGORIES_WRITE shows the values and no form', () => {
    const out = render({ canWrite: false, canChangeStatus: true, canUpload: true });
    expect(out).toContain('data-testid="category-read-only"');
    expect(out).not.toContain('<form');
    expect(out).not.toContain('Kategoriyi kaydet');
  });

  it('with WRITE but not STATUS the status select is locked and not sent', () => {
    const out = render({ canWrite: true, canChangeStatus: false, canUpload: false });
    expect(out).toContain('Kategoriyi kaydet');
    expect(out).toContain('name="statusLocked" value="1"');
    expect(out).toMatch(/<select disabled="">/);
    expect(out).not.toMatch(/<select name="status"/);
  });

  it('with WRITE and STATUS the select moves and nothing is locked', () => {
    const out = render({ canWrite: true, canChangeStatus: true, canUpload: false });
    expect(out).toMatch(/<select name="status"/);
    expect(out).not.toContain('statusLocked');
  });

  it('offers the upload button only with UPLOADS_WRITE; the URL fields always', () => {
    const without = render({ canWrite: true, canChangeStatus: true, canUpload: false });
    const withUpload = render({ canWrite: true, canChangeStatus: true, canUpload: true });
    for (const out of [without, withUpload]) {
      expect(out).toContain('name="imageUrl"');
      expect(out).toContain('name="coverImageUrl"');
    }
    expect(without).not.toContain('Dosya yükle');
    expect(withUpload).toContain('Dosya yükle');
  });

  it('keeps the enrollment switch editable on a draft service only', () => {
    const draft = render({ canWrite: true, canChangeStatus: true, canUpload: false });
    const live = render({ canWrite: true, canChangeStatus: true, canUpload: false }, { status: 'ACTIVE' });
    const group = render({ canWrite: true, canChangeStatus: true, canUpload: false }, { kind: 'GROUP' });
    const enrollment = (out: string) => out.match(/<input[^>]*data-testid="provider-enrollment-open"[^>]*>/)![0];
    expect(enrollment(draft)).not.toContain('disabled');
    expect(enrollment(live)).toContain('disabled');
    expect(enrollment(live)).toContain('checked');
    expect(enrollment(group)).toContain('disabled');
  });

  it('closes the unlimited-package switch on a closed category and the price off a service', () => {
    const closed = render({ canWrite: true, canChangeStatus: true, canUpload: false }, { status: 'INACTIVE' });
    expect(closed.match(/<input[^>]*data-testid="unlimited-package-eligible"[^>]*>/)![0]).toContain('disabled');
    const group = render({ canWrite: true, canChangeStatus: true, canUpload: false }, { kind: 'GROUP' });
    expect(group.match(/<input[^>]*name="offerCreditCost"[^>]*>/)![0]).toContain('disabled');
  });
});

describe('question set: QUESTIONS_WRITE draws the editors', () => {
  const questions = [
    question(),
    question({ id: 'q-2', key: 'marka', label: 'Marka', type: 'TEXT', sortOrder: 20, options: null }),
  ];

  it('without write, every row opens read-only and there is no create panel', () => {
    const out = html(
      <QuestionSetSection category={category()} questions={questions} isRouter={false} canWriteQuestions={false} actions={QUESTION_ACTIONS} />,
    );
    expect(out).toContain('class="question-row"');
    expect(out).toContain('Görüntüle');
    expect(out).not.toContain('<form');
    expect(out).not.toContain('question-create-panel');
  });

  it('with write, each row carries its edit form, condition editor and status button, and the create panel is drawn', () => {
    const out = html(
      <QuestionSetSection category={category()} questions={questions} isRouter={false} canWriteQuestions actions={QUESTION_ACTIONS} />,
    );
    expect(out.match(/Soruyu kaydet/g)).toHaveLength(2);
    expect(out.match(/Koşulu kaydet/g)).toHaveLength(2);
    expect(out).toContain('Pasifleştir');
    expect(out).toContain('question-create-panel');
    expect(out).toContain('Soruyu oluştur');
    // The second question may depend on the first, qualified by its key.
    expect(out).toContain('value="cihaz::kombi"');
    // No multi-select source: "tamamı" is offered disabled.
    expect(out).toMatch(/<option value="ALL" disabled="">/);
    // Outside a router the router switch is disabled and posted as false.
    expect(out).toContain('name="isRouter" value="false"');
  });

  it('offers "tamamı" once a multi-select source exists', () => {
    const out = html(
      <QuestionSetSection
        category={category()}
        questions={[question({ type: 'MULTI_SELECT' }), question({ id: 'q-2', key: 'x', label: 'X', sortOrder: 20 })]}
        isRouter={false}
        canWriteQuestions
        actions={QUESTION_ACTIONS}
      />,
    );
    expect(out).toMatch(/<option value="ALL">/);
  });
});

describe('router targets', () => {
  const targets = [category({ id: 't1', slug: 'bulasik', name: 'Bulaşık makinesi' })];
  const router = question({ isRouter: true, routerRules: [{ optionKey: 'kombi', targetCategorySlug: 'bulasik' }] as Question['routerRules'] });

  it('is a form with QUESTIONS_WRITE and a read-only map without it', () => {
    const write = html(<RouterTargetsSection categorySlug="r" routerQuestion={router} targets={targets} canWriteQuestions replaceRulesAction={noop} />);
    const read = html(<RouterTargetsSection categorySlug="r" routerQuestion={router} targets={targets} canWriteQuestions={false} replaceRulesAction={noop} />);
    expect(write).toContain('Yönlendirmeyi kaydet');
    expect(write).toContain('name="routerTargetSlug"');
    expect(read).not.toContain('<form');
    expect(read).toContain('Bulaşık makinesi');
    expect(read).toContain('— (hedef yok)');
  });

  it('without a router question says so, with the hint only for a writer', () => {
    const write = html(<RouterTargetsSection categorySlug="r" routerQuestion={undefined} targets={[]} canWriteQuestions replaceRulesAction={noop} />);
    const read = html(<RouterTargetsSection categorySlug="r" routerQuestion={undefined} targets={[]} canWriteQuestions={false} replaceRulesAction={noop} />);
    expect(write).toContain('Yönlendirme sorusu yok.');
    expect(write).toContain('SELECT tipinde');
    expect(read).not.toContain('SELECT tipinde');
  });
});

describe('release checklist and status desk', () => {
  it('lists the checklist on a draft service, with the question row only when questions are readable', () => {
    const service = category();
    const out = html(<ReleaseChecklistSection category={service} blockers={releaseBlockers(service)} questionCount={2} />);
    expect(out).toContain('data-testid="draft-explainer"');
    expect(out).toContain('data-testid="release-checklist"');
    expect(out).toContain('Soru sayısı');
    expect(out).toContain('data-testid="release-blocker-NO_APPROVED_PROVIDER"');
    expect(out).toContain('hazır sayılmaz');
    const blind = html(<ReleaseChecklistSection category={service} blockers={[]} questionCount={null} />);
    expect(blind).not.toContain('Soru sayısı');
    expect(blind).not.toContain('release-blockers');
  });

  it('draws no checklist for a group', () => {
    const group = category({ kind: 'GROUP' });
    const out = html(<ReleaseChecklistSection category={group} blockers={releaseBlockers(group)} questionCount={0} />);
    expect(out).toContain('draft-explainer');
    expect(out).not.toContain('release-checklist');
  });

  it('keeps the status form: id, slug and every status', () => {
    const out = html(<CategoryStatusSection category={category()} action={noop} />);
    expect(out).toContain('Durumu güncelle');
    expect(out).toContain('name="slug" value="kombi-servisi"');
    for (const value of ['DRAFT', 'ACTIVE', 'INACTIVE']) expect(out).toContain(`value="${value}"`);
  });
});

describe('category list cells', () => {
  it('says ready or lists every reason', () => {
    expect(html(<TreeReadiness blockers={[]} />)).toContain('Hazır');
    const out = html(<TreeReadiness blockers={['NO_PRICE', 'NO_APPROVED_PROVIDER']} explain />);
    expect(out).toContain('Hazır değil');
    expect(out).toContain('data-testid="release-blocker-NO_PRICE"');
    expect(out).toContain('data-testid="release-blocker-NO_APPROVED_PROVIDER"');
    // The tree's version gives the labels without the per-blocker test ids.
    expect(html(<TreeReadiness blockers={['NO_PRICE']} />)).not.toContain('release-blocker-NO_PRICE');
  });

  it('names the parent and counts a group’s children', () => {
    const group = category({ id: 'g', kind: 'GROUP', name: 'Isıtma', _count: { questions: 0, children: 4 } });
    const child = category({ parentId: 'g' });
    const byId = new Map([[group.id, group]]);
    expect(treeRowContext(child, byId)).toBe('Isıtma altında');
    expect(treeRowContext(group, byId)).toBe('4 alt kategori');
    expect(treeRowContext(category(), byId)).toBeNull();
  });

  it('the ⓘ does not promise what the rules do not do', () => {
    expect(CATEGORIES_SCREEN_INFO).toContain('Soru seti zorunlu değildir');
    expect(CATEGORIES_SCREEN_INFO).not.toMatch(/soruları tanımlı ve yeterli/);
  });
});

describe('credit package cells', () => {
  const pkg = { id: 'p1', name: 'Başlangıç', sortOrder: 1, isActive: true };

  it('draws ↑/↓ only with CREDIT_PACKAGES_WRITE, closed at the ends', () => {
    expect(html(<PackageOrderCell pkg={pkg} canWrite={false} isFirst isLast={false} moveAction={noop} />)).not.toContain('<button');
    const first = html(<PackageOrderCell pkg={pkg} canWrite isFirst isLast={false} moveAction={noop} />);
    expect(first.match(/<button[^>]*data-testid="package-move-up"[^>]*>/)![0]).toContain('disabled');
    expect(first.match(/<button[^>]*data-testid="package-move-down"[^>]*>/)![0]).not.toContain('disabled');
    expect(first).toContain('name="direction" value="up"');
    const last = html(<PackageOrderCell pkg={pkg} canWrite isFirst={false} isLast moveAction={noop} />);
    expect(last.match(/<button[^>]*data-testid="package-move-down"[^>]*>/)![0]).toContain('disabled');
  });

  it('flips the status the way the action reads it, and asks first in both directions', () => {
    const sold = {
      ...pkg,
      type: 'ONE_TIME_CREDITS' as const,
      priceAmount: 14990,
      currency: 'TRY',
      creditAmount: 50,
      quotaCredits: null,
      dailyOfferLimit: null,
    };
    const row = html(<PackageStatusForm pkg={sold} redirectTo="/credit-packages" action={noop} />);
    expect(row).toContain('name="isActive" value="false"');
    expect(row).toContain('name="redirectTo" value="/credit-packages"');
    expect(row).toContain('Pasifleştir');
    expect(row).toContain('data-testid="package-status-toggle-dialog"');
    expect(row).toContain('yeni satışa kapanır');
    expect(row).toContain('değişmez');
    const panel = html(<PackageStatusForm pkg={{ ...sold, isActive: false }} redirectTo="/credit-packages/p1" action={noop} variant="panel" />);
    expect(panel).toContain('Paketi aktifleştir');
    expect(panel).toContain('₺149,90');
    expect(panel).toContain('50 kredi (tek seferlik)');
    expect(panel).toContain('satışa açılır');
  });

  it('names the three types and what each sells', () => {
    expect(packageTypeLabel('ONE_TIME_CREDITS')).toBe('Tek seferlik kredi');
    expect(packageTypeLabel('MONTHLY_QUOTA')).toBe('Aylık kota');
    expect(packageTypeLabel('CATEGORY_UNLIMITED')).toBe('Kategori limitsiz');
    expect(packageAllowance({ type: 'ONE_TIME_CREDITS', creditAmount: 50, quotaCredits: null })).toBe('50');
    expect(packageAllowance({ type: 'MONTHLY_QUOTA', creditAmount: 0, quotaCredits: 200 })).toBe('200');
    expect(packageAllowance({ type: 'CATEGORY_UNLIMITED', creditAmount: 0, quotaCredits: null })).toBe('Limitsiz');
    expect(CREDIT_PACKAGES_SCREEN_INFO).toContain('30 gün');
    expect(CREDIT_PACKAGES_SCREEN_INFO).not.toContain('her ay yenilenen');
  });
});

describe('whole-list footer', () => {
  it('says "tamamı" only when nothing is filtered out', () => {
    expect(html(<WholeListFooter count={4} noun="paket" />)).toContain('4 paket, tamamı gösteriliyor');
    expect(html(<WholeListFooter count={4} total={4} noun="paket" />)).toContain('tamamı');
    expect(html(<WholeListFooter count={2} total={4} noun="paket" />)).toContain('4 paket içinden filtreye uyan 2 kayıt');
  });
});

describe('route and action gates are unchanged (source)', () => {
  const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

  it.each([
    ['app/categories/page.tsx', "requireAdmin('CATALOG_READ')", ["can('CATALOG_READ', 'CATEGORIES_WRITE')"]],
    ['app/categories/new/page.tsx', "requireAdmin('CATALOG_READ', 'CATEGORIES_WRITE')", ["can('UPLOADS_WRITE')"]],
    [
      'app/categories/[slug]/page.tsx',
      "requireAdmin('CATALOG_READ')",
      [
        "can('CATEGORIES_WRITE')",
        "can('CATEGORIES_STATUS')",
        "can('UPLOADS_WRITE')",
        "can('QUESTIONS_READ')",
        "canReadQuestions && can('QUESTIONS_WRITE')",
        "can('PROVIDER_INVITES_READ')",
        "can('PROVIDER_INVITES_ISSUE')",
        "can('PROVIDER_INVITES_REVOKE')",
      ],
    ],
    ['app/credit-packages/page.tsx', "requireAdmin('CREDIT_PACKAGES_READ')", ["can('CREDIT_PACKAGES_WRITE')", "can('CREDIT_PACKAGES_STATUS')"]],
    ['app/credit-packages/new/page.tsx', "requireAdmin('CREDIT_PACKAGES_READ', 'CREDIT_PACKAGES_WRITE')", []],
    [
      'app/credit-packages/[id]/page.tsx',
      "requireAdmin('CREDIT_PACKAGES_READ')",
      ["can('CREDIT_PACKAGES_WRITE')", "can('CREDIT_PACKAGES_STATUS')", "can('PACKAGE_PURCHASES_READ')", "can('PROVIDERS_READ_DETAIL')"],
    ],
  ])('%s', (file, route, gates) => {
    const source = read(file);
    expect(source).toContain(route);
    for (const gate of gates) expect(source, gate).toContain(gate);
    // K9: no delete surface is opened by the redesign.
    expect(source).not.toMatch(/method: 'DELETE'|CATEGORIES_DELETE'\)|QUESTIONS_DELETE'\)/);
  });
});
