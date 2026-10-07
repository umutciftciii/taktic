import { ProviderServiceAreaScope, ProviderStatus, ServiceCategoryKind, ServiceCategoryStatus } from '@prisma/client';
import seoPaths from '@taktic/shared/seo-paths.json';
import siteGateCases from '@taktic/shared/seo-site-gate-cases.json';
import { describe, expect, it } from 'vitest';
import { normalizeCategorySlug } from '../src/modules/seo/category-slug';
import { parseCategorySeoContentPatch, readStoredFaq } from '../src/modules/seo/category-seo-content';
import { looksPersonal } from '../src/modules/seo/seo-not-found.recorder';
import {
  categoryIndexFacts,
  evaluateCategoryIndexability,
  evaluateProviderIndexability,
  evaluateShowcaseCardIndexability,
  evaluateShowcaseShelfIndexability,
  faqText,
  isCategoryIndexable,
  isProviderIndexable,
  isShowcaseCardIndexable,
  isShowcaseShelfIndexable,
  SEO_INDEX_REASON_CODES,
  SEO_INDEX_THRESHOLDS,
} from '../src/modules/seo/seo-index-eligibility';
import { normalizeSeoPath, seoPageRef, seoSourceRefusal } from '../src/modules/seo/seo-paths';
import { resolveSeoSiteGate } from '../src/modules/seo/seo-site-gate';

/**
 * SEO-004 — the pure halves of the SEO core: the address contract, the slug
 * rule, the reason engine, the content validation and the site gate. No
 * database; every case the web runs too comes from packages/shared.
 */

const text = (letters: number) => 'a'.repeat(letters);

describe('normalizeSeoPath — the shared address cases', () => {
  for (const testCase of seoPaths.normalizeCases) {
    const label = JSON.stringify(testCase.input).slice(0, 60);
    if ('path' in testCase) {
      it(`normalises ${label}`, () => {
        expect(normalizeSeoPath(testCase.input)).toEqual({ ok: true, path: testCase.path });
      });
    } else {
      it(`refuses ${label} as ${testCase.refusal}`, () => {
        expect(normalizeSeoPath(testCase.input)).toEqual({ ok: false, refusal: testCase.refusal });
      });
    }
  }

  it('refuses a non-string and is idempotent on its own output', () => {
    expect(normalizeSeoPath(42)).toEqual({ ok: false, refusal: 'NOT_A_STRING' });
    for (const testCase of seoPaths.normalizeCases) {
      if (!('path' in testCase)) continue;
      expect(normalizeSeoPath(testCase.path)).toEqual({ ok: true, path: testCase.path });
    }
  });
});

describe('normalizeCategorySlug — the shared slug cases', () => {
  for (const testCase of seoPaths.slugCases) {
    const label = JSON.stringify(testCase.input).slice(0, 40);
    if ('slug' in testCase) {
      it(`derives ${label} → ${testCase.slug}`, () => {
        expect(normalizeCategorySlug(testCase.input)).toEqual({ ok: true, slug: testCase.slug });
      });
    } else {
      it(`refuses ${label} as ${testCase.refusal}`, () => {
        expect(normalizeCategorySlug(testCase.input)).toEqual({ ok: false, refusal: testCase.refusal });
      });
    }
  }

  it('leaves every value the strict DTO admits unchanged unless reserved or too long', () => {
    for (const slug of ['kombi-servisi', 'a', 'klima-montaji-2', 'x1-y2-z3']) {
      expect(normalizeCategorySlug(slug)).toEqual({ ok: true, slug });
    }
  });
});

describe('seoSourceRefusal and seoPageRef', () => {
  it('refuses the root, every application route tree, the bare listings and file-like paths', () => {
    expect(seoSourceRefusal('/')).toBe('ROOT');
    for (const segment of seoPaths.reservedTopLevelSegments) {
      expect(seoSourceRefusal(`/${segment}`), segment).toBe('RESERVED_ROUTE');
      expect(seoSourceRefusal(`/${segment}/x`), segment).toBe('RESERVED_ROUTE');
    }
    for (const family of seoPaths.publicFamilies) {
      expect(seoSourceRefusal(`/${family}`)).toBe('RESERVED_ROUTE');
      expect(seoSourceRefusal(`/${family}/eski`)).toBeNull();
    }
    expect(seoSourceRefusal('/robots.txt')).toBe('STATIC_ASSET');
    expect(seoSourceRefusal('/eski/sayfa.html')).toBe('STATIC_ASSET');
    expect(seoSourceRefusal('/eski.dizin/sayfa')).toBe('STATIC_ASSET');
    expect(seoSourceRefusal('/kategori/ev-temizligi')).toBeNull();
  });

  it('names exactly the six indexable route shapes as pages', () => {
    expect(seoPageRef('/')).toEqual({ kind: 'HOME' });
    expect(seoPageRef('/categories')).toEqual({ kind: 'CATALOGUE' });
    expect(seoPageRef('/vitrin')).toEqual({ kind: 'SHELF' });
    expect(seoPageRef('/categories/x')).toEqual({ kind: 'CATEGORY', slug: 'x' });
    expect(seoPageRef('/isletme/abc')).toEqual({ kind: 'PROVIDER', id: 'abc' });
    expect(seoPageRef('/vitrin/c1')).toEqual({ kind: 'SHOWCASE_CARD', cardId: 'c1' });
    for (const path of ['/isletme', '/kategori/x', '/categories/x/y', '/login', '/account/x']) {
      expect(seoPageRef(path), path).toBeNull();
    }
  });
});

describe('the reason engine — same booleans, now with reasons', () => {
  const eligibleCategory = {
    status: ServiceCategoryStatus.ACTIVE,
    kind: ServiceCategoryKind.LEAF,
    description: text(SEO_INDEX_THRESHOLDS.categoryDescriptionMinChars),
    editorialBlocks: {
      decisionGuide: text(80),
      priceFactors: text(80),
      faq: text(80),
    },
  };

  it('names every failed category rule, with the threshold and the count', () => {
    expect(evaluateCategoryIndexability(eligibleCategory)).toEqual({ indexable: true, reasons: [] });
    const result = evaluateCategoryIndexability({
      status: ServiceCategoryStatus.ACTIVE,
      kind: ServiceCategoryKind.ROUTER,
      description: 'Kısa',
      editorialBlocks: { decisionGuide: text(10), priceFactors: null },
    });
    expect(result.indexable).toBe(false);
    expect(result.reasons).toEqual([
      { code: 'CATEGORY_NOT_LEAF' },
      { code: 'CATEGORY_DESCRIPTION_TOO_SHORT', required: 400, actual: 4 },
      { code: 'CATEGORY_EDITORIAL_BLOCK_TOO_SHORT', block: 'decisionGuide', required: 80, actual: 10 },
      { code: 'CATEGORY_EDITORIAL_BLOCK_MISSING', block: 'priceFactors', required: 80, actual: 0 },
      { code: 'CATEGORY_EDITORIAL_BLOCK_MISSING', block: 'faq', required: 80, actual: 0 },
    ]);
    expect(evaluateCategoryIndexability(null)).toEqual({ indexable: false, reasons: [{ code: 'INPUT_UNRECOGNIZED' }] });
    expect(evaluateCategoryIndexability({ ...eligibleCategory, status: 'DRAFT' }).reasons).toEqual([
      { code: 'CATEGORY_NOT_ACTIVE' },
    ]);
  });

  it('reads the FAQ block as every question and answer together, and anything else as nothing', () => {
    expect(faqText([{ question: 'Soru?', answer: 'Cevap.' }])).toBe('Soru?\nCevap.');
    expect(faqText([{ question: 'Soru?' }])).toBeNull();
    expect(faqText('soru')).toBeNull();
    expect(faqText([])).toBeNull();
    const facts = categoryIndexFacts({
      status: ServiceCategoryStatus.ACTIVE,
      kind: ServiceCategoryKind.LEAF,
      description: text(400),
      editorialDecisionGuide: text(80),
      editorialPriceFactors: text(80),
      editorialFaq: [{ question: text(40), answer: text(40) }],
    });
    expect(isCategoryIndexable(facts)).toBe(true);
    expect(
      isCategoryIndexable(
        categoryIndexFacts({
          status: ServiceCategoryStatus.ACTIVE,
          kind: ServiceCategoryKind.LEAF,
          description: text(400),
          editorialDecisionGuide: text(80),
          editorialPriceFactors: text(80),
          editorialFaq: [{ question: text(40), answer: 7 }],
        }),
      ),
    ).toBe(false);
  });

  it('names every failed business, card and shelf rule', () => {
    expect(
      evaluateProviderIndexability({
        status: ProviderStatus.APPROVED,
        description: 'x',
        city: '',
        district: 'Kadıköy',
        serviceCategories: [{ category: { status: 'DRAFT', kind: 'LEAF' } }],
        serviceAreas: [{ scope: ProviderServiceAreaScope.DISTRICT, city: 'İstanbul', district: null, neighborhood: null }],
      }).reasons.map((reason) => reason.code),
    ).toEqual([
      'PROVIDER_DESCRIPTION_TOO_SHORT',
      'PROVIDER_LOCATION_MISSING',
      'PROVIDER_NO_PUBLIC_CATEGORY',
      'PROVIDER_SERVICE_AREA_INCOMPLETE',
    ]);
    expect(
      evaluateProviderIndexability({
        status: ProviderStatus.SUSPENDED,
        description: text(300),
        city: 'İstanbul',
        district: 'Kadıköy',
        serviceCategories: [{ category: { status: 'ACTIVE', kind: 'LEAF' } }],
        serviceAreas: [],
      }).reasons.map((reason) => reason.code),
    ).toEqual(['PROVIDER_NOT_APPROVED', 'PROVIDER_NO_SERVICE_AREA']);

    expect(
      evaluateShowcaseCardIndexability({
        live: true,
        providerIndexable: false,
        summary: text(10),
        scopeIncluded: ['a', 'A', ' a '],
        scopeExcluded: [],
        summaryDuplicated: true,
      }).reasons,
    ).toEqual([
      { code: 'CARD_PROVIDER_NOT_INDEXABLE' },
      { code: 'CARD_SUMMARY_DUPLICATED' },
      { code: 'CARD_SUMMARY_TOO_SHORT', required: 200, actual: 10 },
      { code: 'CARD_SCOPE_INCLUDED_TOO_FEW', required: 3, actual: 1 },
      { code: 'CARD_SCOPE_EXCLUDED_TOO_FEW', required: 1, actual: 0 },
    ]);
    expect(evaluateShowcaseShelfIndexability(4).reasons).toEqual([
      { code: 'SHELF_TOO_FEW_INDEXABLE_CARDS', required: 5, actual: 4 },
    ]);
    expect(evaluateShowcaseShelfIndexability(5)).toEqual({ indexable: true, reasons: [] });
    expect(evaluateShowcaseShelfIndexability('5').reasons).toEqual([{ code: 'INPUT_UNRECOGNIZED' }]);
  });

  it('keeps the public booleans exactly as before: indexable ⇔ no reason, over many random inputs', () => {
    // A deterministic generator: the same inputs on every run.
    let seed = 7;
    const random = () => {
      seed = (seed * 48271) % 2147483647;
      return seed / 2147483647;
    };
    const pick = <T>(values: T[]) => values[Math.floor(random() * values.length)]!;
    const textOf = () => pick([null, undefined, 7, '', text(5), text(79), text(80), text(199), text(200), text(300), text(400), '<b>x</b>']);
    for (let index = 0; index < 400; index += 1) {
      const category = {
        status: pick(['ACTIVE', 'DRAFT', 'INACTIVE', 'X', null]),
        kind: pick(['LEAF', 'ROUTER', 'GROUP', null]),
        description: textOf(),
        editorialBlocks: pick([undefined, null, 'x', { decisionGuide: textOf(), priceFactors: textOf(), faq: textOf() }]),
      };
      const c = evaluateCategoryIndexability(category);
      expect(c.indexable).toBe(c.reasons.length === 0);
      expect(isCategoryIndexable(category)).toBe(c.indexable);

      const card = {
        live: pick([true, false, 'true']),
        providerIndexable: pick([true, false, undefined]),
        summary: textOf(),
        scopeIncluded: pick([[], ['a', 'b', 'c'], ['a', 'a', 'b'], 'x']),
        scopeExcluded: pick([[], ['x'], null]),
        summaryDuplicated: pick([true, false, undefined]),
      };
      const k = evaluateShowcaseCardIndexability(card);
      expect(k.indexable).toBe(k.reasons.length === 0);
      expect(isShowcaseCardIndexable(card)).toBe(k.indexable);

      const provider = {
        status: pick(['APPROVED', 'SUSPENDED', null]),
        description: textOf(),
        city: pick(['İstanbul', '', null]),
        district: pick(['Kadıköy', '', null]),
        serviceCategories: pick([[], [{ category: { status: 'ACTIVE', kind: 'LEAF' } }], null]),
        serviceAreas: pick([[], [{ scope: 'CITY', city: 'İstanbul', district: null, neighborhood: null }], [{ scope: 'X', city: 'a' }]]),
      };
      const p = evaluateProviderIndexability(provider);
      expect(p.indexable).toBe(p.reasons.length === 0);
      expect(isProviderIndexable(provider)).toBe(p.indexable);

      const count = pick([0, 4, 5, 6, 4.5, '5', null]);
      expect(isShowcaseShelfIndexable(count)).toBe(evaluateShowcaseShelfIndexability(count).indexable);
    }
  });

  it('uses only the declared reason codes', () => {
    const declared = new Set<string>(SEO_INDEX_REASON_CODES);
    const all = [
      evaluateCategoryIndexability({ status: 1, kind: 1, description: 1, editorialBlocks: 1 }),
      evaluateProviderIndexability({ status: 1, description: 1, city: 1, district: 1, serviceCategories: 1, serviceAreas: 1 }),
      evaluateShowcaseCardIndexability({ live: 1, providerIndexable: 1, summary: 1, scopeIncluded: 1, scopeExcluded: 1, summaryDuplicated: 1 }),
      evaluateShowcaseShelfIndexability(0),
    ];
    for (const result of all) for (const reason of result.reasons) expect(declared.has(reason.code)).toBe(true);
  });
});

describe('parseCategorySeoContentPatch', () => {
  it('trims, turns empty into NULL and keeps only the fields sent', () => {
    expect(parseCategorySeoContentPatch({ seoTitle: '  Kombi servisi  ', seoDescription: '   ' })).toEqual({
      seoTitle: 'Kombi servisi',
      seoDescription: null,
    });
    expect(parseCategorySeoContentPatch({ editorialDecisionGuide: 'Satır 1\r\nSatır 2' })).toEqual({
      editorialDecisionGuide: 'Satır 1\nSatır 2',
    });
    expect(parseCategorySeoContentPatch({ editorialFaq: [] })).toEqual({ editorialFaq: null });
    expect(
      parseCategorySeoContentPatch({ editorialFaq: [{ question: ' Ne kadar? ', answer: ' Değişir. ' }] }),
    ).toEqual({ editorialFaq: [{ question: 'Ne kadar?', answer: 'Değişir.' }] });
  });

  it.each([
    [{ seoTitle: 'x'.repeat(71) }, 'seoTitle'],
    [{ seoTitle: 'iki\nsatır' }, 'seoTitle'],
    [{ seoDescription: 'x'.repeat(161) }, 'seoDescription'],
    [{ seoDescription: 5 }, 'seoDescription'],
    [{ editorialPriceFactors: 'x'.repeat(6001) }, 'editorialPriceFactors'],
    [{ editorialDecisionGuide: 'görünmez\u0007karakter' }, 'editorialDecisionGuide'],
    [{ editorialFaq: 'soru' }, 'editorialFaq'],
    [{ editorialFaq: Array.from({ length: 21 }, () => ({ question: 'q', answer: 'a' })) }, 'editorialFaq'],
    [{ editorialFaq: [{ question: 'q' }] }, 'editorialFaq[0]'],
    [{ editorialFaq: [{ question: 'q', answer: 'a', extra: 1 }] }, 'editorialFaq[0]'],
    [{ editorialFaq: [{ question: '', answer: 'a' }] }, 'editorialFaq[0]'],
    [{ editorialFaq: [{ question: 'x'.repeat(201), answer: 'a' }] }, 'editorialFaq[0].question'],
    [{ unknown: 1 }, 'unknown'],
    [{}, 'body'],
    [[], 'body'],
  ])('refuses %j naming %s', (body, field) => {
    try {
      parseCategorySeoContentPatch(body);
      expect.fail('expected a refusal');
    } catch (error) {
      const response = (error as { getResponse(): { code: string; field: string } }).getResponse();
      expect(response.code).toBe('SEO_CONTENT_INVALID');
      expect(response.field).toBe(field);
    }
  });

  it('reads a stored FAQ back only in the shape it writes', () => {
    expect(readStoredFaq([{ question: 'q', answer: 'a' }])).toEqual([{ question: 'q', answer: 'a' }]);
    expect(readStoredFaq([{ question: 'q', answer: 1 }])).toBeNull();
    expect(readStoredFaq({})).toBeNull();
    expect(readStoredFaq(null)).toBeNull();
  });
});

describe('resolveSeoSiteGate — the web’s rule, the shared cases', () => {
  for (const testCase of siteGateCases.cases) {
    it(`${JSON.stringify(testCase.env)} → ${testCase.open ? 'open' : testCase.reason}`, () => {
      const gate = resolveSeoSiteGate(testCase.env as NodeJS.ProcessEnv);
      expect(gate.open).toBe(testCase.open);
      if (testCase.open) expect(gate.origin).toBe(testCase.origin);
      else expect(gate.reason).toBe(testCase.reason);
    });
  }
});

describe('looksPersonal — the 404 recorder’s PII guard', () => {
  it('drops a segment with an @ or seven digits in a row, and keeps ids and slugs', () => {
    expect(looksPersonal('/categories/ali@example.com')).toBe(true);
    expect(looksPersonal('/isletme/05551234567')).toBe(true);
    expect(looksPersonal('/vitrin/x-5551234-y')).toBe(true);
    expect(looksPersonal('/categories/kombi-servisi')).toBe(false);
    expect(looksPersonal('/isletme/cmtbj08ts000012ab34cd')).toBe(false);
    expect(looksPersonal('/vitrin/kart-123456')).toBe(false);
  });
});
