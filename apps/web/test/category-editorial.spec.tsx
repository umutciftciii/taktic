import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CategoryEditorial } from '../app/categories/[slug]/category-editorial';
import type { Category } from '../lib/api';
import {
  categoryPageDescription,
  categoryPageTitle,
  editorialSections,
  paragraphs,
} from '../lib/category-editorial';
import { publicPageMetadata } from '../lib/seo-metadata';

/**
 * SEO-004 — what a category page prints from its SEO content: the title and
 * description fallbacks, the editorial blocks as h2 sections, nothing for an
 * empty block, plain text only, and no FAQ JSON-LD.
 */

const base: Category = {
  id: 'c1',
  name: 'Kombi Servisi',
  slug: 'kombi-servisi',
  description: 'Kombi bakımı ve arıza onarımı.',
  sortOrder: 0,
};

describe('title and description', () => {
  it('uses the SEO title as the whole title, else the name with the site name', () => {
    expect(categoryPageTitle({ ...base, seoTitle: 'Kombi Servisi — Teklif Al' })).toEqual({ absolute: 'Kombi Servisi — Teklif Al' });
    expect(categoryPageTitle({ ...base, seoTitle: '   ' })).toBe('Kombi Servisi');
    expect(categoryPageTitle(base)).toBe('Kombi Servisi');
  });

  it('uses the SEO description, then the description, then the fixed sentence', () => {
    expect(categoryPageDescription({ ...base, seoDescription: 'Onaylı servislerden teklif.' })).toBe('Onaylı servislerden teklif.');
    expect(categoryPageDescription(base)).toBe('Kombi bakımı ve arıza onarımı.');
    expect(categoryPageDescription({ ...base, description: null })).toBe(
      'Kombi Servisi için talep oluşturun; bölgenizdeki onaylı hizmet verenlerden teklif alın.',
    );
    // A description carrying contact details is skipped, not printed.
    expect(categoryPageDescription({ ...base, seoDescription: 'Bizi 0555 123 45 67 numarasından arayın.' })).toBe(
      'Kombi bakımı ve arıza onarımı.',
    );
  });

  it('reaches the page metadata as written', () => {
    const metadata = publicPageMetadata(
      {
        route: '/categories/:slug',
        params: { slug: base.slug },
        title: categoryPageTitle({ ...base, seoTitle: 'Özel Başlık' }),
        description: categoryPageDescription(base),
        searchParams: {},
        indexEligible: true,
      },
      { indexable: true, origin: 'https://taktick.example' },
    );
    expect(metadata.title).toBe('Özel Başlık');
    expect(metadata.alternates?.canonical).toBe('https://taktick.example/categories/kombi-servisi');
  });
});

describe('editorial sections', () => {
  it('splits paragraphs on blank lines only', () => {
    expect(paragraphs('Bir.\nİki.\n\n  Üç.  \n\n\n')).toEqual(['Bir.\nİki.', 'Üç.']);
    expect(paragraphs(null)).toEqual([]);
  });

  it('renders each written block as an h2 section and leaves out an empty one', () => {
    expect(editorialSections(base)).toEqual([]);
    const sections = editorialSections({
      ...base,
      editorialDecisionGuide: 'Rehber.',
      editorialPriceFactors: '   ',
      editorialFaq: [{ question: 'Ne kadar?', answer: 'Değişir.' }],
    });
    expect(sections.map((section) => section.key)).toEqual(['decisionGuide', 'faq']);

    const html = renderToStaticMarkup(
      <CategoryEditorial
        category={{
          ...base,
          editorialDecisionGuide: 'Önce <b>yetki</b> belgesine bakın.',
          editorialPriceFactors: null,
          editorialFaq: [{ question: 'Ne kadar sürer?', answer: 'Bir saat.' }],
        }}
      />,
    );
    expect(html.match(/<h2>/g)).toHaveLength(2);
    expect(html).toContain('<h2>Nasıl seçilir?</h2>');
    expect(html).not.toContain('Fiyatı neler etkiler?');
    // Plain text: markup from the database is escaped, never rendered.
    expect(html).toContain('&lt;b&gt;yetki&lt;/b&gt;');
    expect(html).not.toContain('FAQPage');
    expect(renderToStaticMarkup(<CategoryEditorial category={base} />)).toBe('');
  });
});
