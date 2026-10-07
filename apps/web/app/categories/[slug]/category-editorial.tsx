import type { Category } from '../../../lib/api';
import { editorialSections } from '../../../lib/category-editorial';

/**
 * SEO-004 — the category's editorial blocks, below the form: "Nasıl seçilir?",
 * "Fiyatı neler etkiler?" and the questions. Plain text rendered as text (no
 * HTML from the database reaches the page), one `<h2>` per block, and nothing
 * at all for a block that has not been written.
 */
export function CategoryEditorial({ category }: { category: Category }) {
  const sections = editorialSections(category);
  if (sections.length === 0) return null;

  return (
    <div className="category-editorial" data-testid="category-editorial">
      {sections.map((section) => (
        <section key={section.key} className="category-editorial-section" data-testid={`category-editorial-${section.key}`}>
          <h2>{section.heading}</h2>
          {section.key === 'faq' ? (
            <dl className="category-editorial-faq">
              {section.items.map((item, index) => (
                <div key={index} className="category-editorial-faq-item">
                  <dt>{item.question}</dt>
                  <dd>{item.answer}</dd>
                </div>
              ))}
            </dl>
          ) : (
            section.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)
          )}
        </section>
      ))}
    </div>
  );
}
