import { describe, expect, it } from 'vitest';
import {
  SEO_INDEX_THRESHOLDS,
  isCategoryIndexable,
  isProviderIndexable,
  isShowcaseCardIndexable,
  isShowcaseShelfIndexable,
  meaningfulLength,
  normalizedMeaningfulText,
} from '../src/modules/seo/seo-index-eligibility';

/**
 * SEO-003: the one rule that decides whether a public page may be indexed.
 *
 * Every surface's `seoIndexable`, and the sitemap's membership, come from the
 * functions under test here. The numbers are starting thresholds
 * (SEO-002 §4.1); what is fixed is the shape of the rule: missing, malformed,
 * padded or unrecognised input is never eligible.
 */

const T = SEO_INDEX_THRESHOLDS;

/** `n` meaningful Turkish letters, in words, with no padding tricks. */
function turkishText(n: number): string {
  const word = 'şğüçöı';
  const words: string[] = [];
  let count = 0;
  while (count < n) {
    const take = Math.min(word.length, n - count);
    words.push(word.slice(0, take));
    count += take;
  }
  return words.join(' ');
}

describe('meaningfulLength — letters and digits only, after markup and invisibles are gone', () => {
  it('counts Turkish letters and digits, not punctuation or whitespace', () => {
    expect(meaningfulLength('Şğüçöı İ 123')).toBe(10);
    expect(meaningfulLength('..., --- !!! ???')).toBe(0);
    expect(meaningfulLength('a  b\u0009\u000ac')).toBe(3);
  });

  it('strips tags, script and style bodies, and decodes entities to one character each', () => {
    expect(meaningfulLength('<p>ab</p><script>var x = "xxxxxxxxxx";</script><style>.a{b:c}</style>')).toBe(2);
    expect(meaningfulLength('a&amp;b &lt;c&gt; &#x41;')).toBe(4);
    expect(meaningfulLength('<img alt="uzun uzun uzun uzun">')).toBe(0);
  });

  it('ignores invisible and control characters', () => {
    expect(meaningfulLength('a\u200bb\u200c\u200d\u2060\ufeffc\u00ad\u0000\u001f\u2028')).toBe(3);
  });

  it('is zero for anything that is not a string', () => {
    expect(meaningfulLength(null)).toBe(0);
    expect(meaningfulLength(undefined)).toBe(0);
    expect(meaningfulLength(42)).toBe(0);
    expect(meaningfulLength(['abc'])).toBe(0);
    expect(meaningfulLength({ toString: () => 'abc' })).toBe(0);
  });
});

describe('normalizedMeaningfulText — the string two summaries are compared by', () => {
  it('folds case, whitespace, punctuation and markup so a disguised copy is equal', () => {
    expect(normalizedMeaningfulText('Klima <b>Bakımı</b>,  ve   filtre!')).toBe(
      normalizedMeaningfulText('klima bakımı ve filtre'),
    );
    expect(normalizedMeaningfulText('Klima bakımı')).not.toBe(normalizedMeaningfulText('Klima montajı'));
  });
});

describe('isCategoryIndexable', () => {
  const blocks = {
    decisionGuide: turkishText(T.categoryEditorialBlockMinChars),
    priceFactors: turkishText(T.categoryEditorialBlockMinChars),
    faq: turkishText(T.categoryEditorialBlockMinChars),
  };
  const good = {
    status: 'ACTIVE',
    kind: 'LEAF',
    description: turkishText(T.categoryDescriptionMinChars),
    editorialBlocks: blocks,
  };

  it('passes an ACTIVE leaf with a long description and all three editorial blocks', () => {
    expect(isCategoryIndexable(good)).toBe(true);
  });

  it('fails without the editorial blocks — which the model does not carry yet', () => {
    expect(isCategoryIndexable({ ...good, editorialBlocks: undefined })).toBe(false);
    expect(isCategoryIndexable({ ...good, editorialBlocks: {} })).toBe(false);
    expect(isCategoryIndexable({ ...good, editorialBlocks: { ...blocks, faq: '' } })).toBe(false);
    expect(isCategoryIndexable({ ...good, editorialBlocks: { ...blocks, faq: turkishText(T.categoryEditorialBlockMinChars - 1) } })).toBe(false);
    expect(isCategoryIndexable({ ...good, editorialBlocks: { ...blocks, extra: 'x' } })).toBe(true);
  });

  it('fails a short description, and one padded to length with markup, whitespace or punctuation', () => {
    expect(isCategoryIndexable({ ...good, description: turkishText(T.categoryDescriptionMinChars - 1) })).toBe(false);
    const short = turkishText(T.categoryDescriptionMinChars - 1);
    expect(isCategoryIndexable({ ...good, description: `${short}${' '.repeat(500)}` })).toBe(false);
    expect(isCategoryIndexable({ ...good, description: `${short}${'.'.repeat(500)}` })).toBe(false);
    expect(isCategoryIndexable({ ...good, description: `${short}<script>${'x'.repeat(500)}</script>` })).toBe(false);
    expect(isCategoryIndexable({ ...good, description: `${short}${'\u200b'.repeat(500)}` })).toBe(false);
    expect(isCategoryIndexable({ ...good, description: `<p>${short}</p><p>ş</p>` })).toBe(true);
  });

  it('fails anything but an ACTIVE leaf', () => {
    expect(isCategoryIndexable({ ...good, status: 'DRAFT' })).toBe(false);
    expect(isCategoryIndexable({ ...good, status: 'INACTIVE' })).toBe(false);
    expect(isCategoryIndexable({ ...good, kind: 'ROUTER' })).toBe(false);
    expect(isCategoryIndexable({ ...good, kind: 'GROUP' })).toBe(false);
    expect(isCategoryIndexable({ ...good, status: 'LIVE' })).toBe(false);
    expect(isCategoryIndexable({ ...good, kind: undefined })).toBe(false);
  });

  it('fails on missing or malformed input', () => {
    expect(isCategoryIndexable(null)).toBe(false);
    expect(isCategoryIndexable(undefined)).toBe(false);
    expect(isCategoryIndexable({ ...good, description: null })).toBe(false);
    expect(isCategoryIndexable({ ...good, description: 12345 })).toBe(false);
  });
});

describe('isProviderIndexable', () => {
  const good = {
    status: 'APPROVED',
    description: turkishText(T.providerDescriptionMinChars),
    city: 'İstanbul',
    district: 'Kadıköy',
    serviceCategories: [{ category: { status: 'ACTIVE', kind: 'LEAF' } }],
    serviceAreas: [{ scope: 'DISTRICT', city: 'İstanbul', district: 'Kadıköy', neighborhood: null }],
  };

  it('passes an approved business with a real description, a public category and complete areas', () => {
    expect(isProviderIndexable(good)).toBe(true);
    expect(
      isProviderIndexable({
        ...good,
        serviceAreas: [
          { scope: 'CITY', city: 'Ankara', district: null, neighborhood: null },
          { scope: 'NEIGHBORHOOD', city: 'İstanbul', district: 'Kadıköy', neighborhood: 'Caferağa Mah' },
        ],
      }),
    ).toBe(true);
  });

  it('fails every status but APPROVED', () => {
    for (const status of ['DRAFT', 'PENDING_REVIEW', 'REJECTED', 'SUSPENDED', 'approved', undefined]) {
      expect(isProviderIndexable({ ...good, status }), String(status)).toBe(false);
    }
  });

  it('fails a short, empty or padded description', () => {
    expect(isProviderIndexable({ ...good, description: null })).toBe(false);
    expect(isProviderIndexable({ ...good, description: '' })).toBe(false);
    expect(isProviderIndexable({ ...good, description: turkishText(T.providerDescriptionMinChars - 1) })).toBe(false);
    expect(
      isProviderIndexable({ ...good, description: `${turkishText(T.providerDescriptionMinChars - 1)}<b>${'!'.repeat(50)}</b>\u2029` }),
    ).toBe(false);
  });

  it('needs at least one public (ACTIVE leaf) category binding', () => {
    expect(isProviderIndexable({ ...good, serviceCategories: [] })).toBe(false);
    expect(isProviderIndexable({ ...good, serviceCategories: [{ category: { status: 'DRAFT', kind: 'LEAF' } }] })).toBe(false);
    expect(isProviderIndexable({ ...good, serviceCategories: [{ category: { status: 'ACTIVE', kind: 'ROUTER' } }] })).toBe(false);
    expect(
      isProviderIndexable({
        ...good,
        serviceCategories: [{ category: { status: 'DRAFT', kind: 'LEAF' } }, { category: { status: 'ACTIVE', kind: 'LEAF' } }],
      }),
    ).toBe(true);
    expect(isProviderIndexable({ ...good, serviceCategories: undefined })).toBe(false);
  });

  it('needs the profile place and every area row complete for its scope', () => {
    expect(isProviderIndexable({ ...good, city: '' })).toBe(false);
    expect(isProviderIndexable({ ...good, district: '  ' })).toBe(false);
    expect(isProviderIndexable({ ...good, serviceAreas: [] })).toBe(false);
    expect(isProviderIndexable({ ...good, serviceAreas: undefined })).toBe(false);
    expect(isProviderIndexable({ ...good, serviceAreas: [{ scope: 'DISTRICT', city: 'İstanbul', district: null, neighborhood: null }] })).toBe(false);
    expect(isProviderIndexable({ ...good, serviceAreas: [{ scope: 'NEIGHBORHOOD', city: 'İstanbul', district: 'Kadıköy', neighborhood: '' }] })).toBe(false);
    expect(isProviderIndexable({ ...good, serviceAreas: [{ scope: 'CITY', city: '', district: null, neighborhood: null }] })).toBe(false);
    expect(isProviderIndexable({ ...good, serviceAreas: [{ scope: 'COUNTRY', city: 'İstanbul', district: null, neighborhood: null }] })).toBe(false);
    // One incomplete row spoils the set: the page prints every row.
    expect(
      isProviderIndexable({
        ...good,
        serviceAreas: [...good.serviceAreas, { scope: 'DISTRICT', city: 'İstanbul', district: '', neighborhood: null }],
      }),
    ).toBe(false);
  });

  it('fails on missing input', () => {
    expect(isProviderIndexable(null)).toBe(false);
    expect(isProviderIndexable(undefined)).toBe(false);
  });
});

describe('isShowcaseCardIndexable', () => {
  const good = {
    live: true,
    providerIndexable: true,
    summary: turkishText(T.showcaseSummaryMinChars),
    scopeIncluded: ['Filtre temizliği', 'Gaz basıncı kontrolü', 'Drenaj kontrolü'],
    scopeExcluded: ['Gaz dolumu'],
    summaryDuplicated: false,
  };

  it('passes a live card of an indexable business with a real summary and scope', () => {
    expect(isShowcaseCardIndexable(good)).toBe(true);
  });

  it('fails a card that is not on the air, or whose business is not indexable', () => {
    expect(isShowcaseCardIndexable({ ...good, live: false })).toBe(false);
    expect(isShowcaseCardIndexable({ ...good, providerIndexable: false })).toBe(false);
    expect(isShowcaseCardIndexable({ ...good, live: 'yes' })).toBe(false);
  });

  it('fails a short or padded summary, and a summary copied from another live card of the same business', () => {
    expect(isShowcaseCardIndexable({ ...good, summary: turkishText(T.showcaseSummaryMinChars - 1) })).toBe(false);
    expect(isShowcaseCardIndexable({ ...good, summary: `${turkishText(T.showcaseSummaryMinChars - 1)}<br/><br/>   ...` })).toBe(false);
    expect(isShowcaseCardIndexable({ ...good, summaryDuplicated: true })).toBe(false);
    expect(isShowcaseCardIndexable({ ...good, summary: null })).toBe(false);
  });

  it('needs three distinct meaningful included items and one excluded item', () => {
    expect(isShowcaseCardIndexable({ ...good, scopeIncluded: ['a', 'b'] })).toBe(false);
    expect(isShowcaseCardIndexable({ ...good, scopeIncluded: ['Keşif', 'keşif', 'KEŞİF!'] })).toBe(false);
    expect(isShowcaseCardIndexable({ ...good, scopeIncluded: ['Keşif', 'Montaj', '   ', '...'] })).toBe(false);
    expect(isShowcaseCardIndexable({ ...good, scopeIncluded: ['Keşif', 'Montaj', '<b></b>'] })).toBe(false);
    expect(isShowcaseCardIndexable({ ...good, scopeExcluded: [] })).toBe(false);
    expect(isShowcaseCardIndexable({ ...good, scopeExcluded: ['—'] })).toBe(false);
    expect(isShowcaseCardIndexable({ ...good, scopeIncluded: 'Keşif, Montaj, Bakım' })).toBe(false);
    expect(isShowcaseCardIndexable({ ...good, scopeExcluded: undefined })).toBe(false);
  });

  it('fails on missing input', () => {
    expect(isShowcaseCardIndexable(null)).toBe(false);
    expect(isShowcaseCardIndexable(undefined)).toBe(false);
  });
});

describe('isShowcaseShelfIndexable', () => {
  it('needs at least the threshold of indexable live cards', () => {
    expect(isShowcaseShelfIndexable(T.showcaseShelfMinIndexableCards)).toBe(true);
    expect(isShowcaseShelfIndexable(T.showcaseShelfMinIndexableCards - 1)).toBe(false);
    expect(isShowcaseShelfIndexable(0)).toBe(false);
    expect(isShowcaseShelfIndexable(Number.NaN)).toBe(false);
    expect(isShowcaseShelfIndexable(-1)).toBe(false);
    expect(isShowcaseShelfIndexable('5')).toBe(false);
  });
});
