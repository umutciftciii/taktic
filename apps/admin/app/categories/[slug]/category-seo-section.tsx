import Link from 'next/link';
import { describeSeoReason, SEO_EDITORIAL_BLOCK_LABELS, type CategorySeoContent } from '../../../lib/seo';
import { KeyValueList } from '../../../components/key-value-list';
import { SectionCard } from '../../../components/section-card';
import { CategorySeoForm } from './category-seo-form';

/**
 * The category's "Arama motoru" tab (SEO-004 PR B): whether its public page is
 * open to search engines and, if not, the rules it fails — the API's own
 * evaluation of the stored row, with each `required`/`actual` — and the
 * content that decides it. SEO_CONTENT_WRITE gets the form; SEO_READ alone the
 * same values, read-only.
 *
 * No public preview is drawn: the public page is the preview, and a second
 * rendering here could only drift from it.
 */
export function CategorySeoSection({
  content,
  canWrite,
}: {
  content: CategorySeoContent;
  canWrite: boolean;
}) {
  const { evaluation } = content;
  const blockMin =
    evaluation.reasons.find((reason) => reason.code.startsWith('CATEGORY_EDITORIAL_BLOCK') && reason.required)?.required ??
    null;

  return (
    <>
      <SectionCard
        title="Arama motoru durumu"
        actions={
          <Link className="btn btn-link btn-sm" href="/seo/indexing?type=CATEGORY">
            Tüm kapalı kategoriler
          </Link>
        }
        className="detail-tab-card"
        testId="category-seo-status"
      >
        <div className="seo-status-line">
          {evaluation.indexable ? (
            <span className="badge badge-good" data-testid="category-seo-indexable">
              Aramaya açık
            </span>
          ) : (
            <span className="badge badge-warn" data-testid="category-seo-indexable">
              Aramaya kapalı
            </span>
          )}
          <span className="cell-muted">
            {evaluation.indexable
              ? 'Sayfa arama motorlarına gösterilir ve site haritasında yer alır (site aramaya açıkken).'
              : 'Aşağıdaki eksikler tamamlanınca sayfa kendiliğinden aramaya açılır.'}
          </span>
        </div>
        {evaluation.reasons.length > 0 ? (
          <ul className="seo-reason-list seo-reason-list-card" data-testid="category-seo-reasons">
            {evaluation.reasons.map((reason, index) => {
              const text = describeSeoReason(reason);
              return (
                <li key={`${reason.code}-${reason.block ?? ''}-${index}`} data-reason={reason.code}>
                  <span>{text.title}</span>
                  {text.detail ? <span className="cell-muted">{text.detail}</span> : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </SectionCard>

      <SectionCard
        title="Arama motoru içeriği"
        actions={<span className="section-card-meta">Adres: {content.path}</span>}
        className="detail-tab-card"
        testId="category-seo-content"
      >
        {canWrite ? (
          <CategorySeoForm
            categoryId={content.id}
            categorySlug={content.slug}
            seoTitle={content.seoTitle}
            seoDescription={content.seoDescription}
            editorialDecisionGuide={content.editorialDecisionGuide}
            editorialPriceFactors={content.editorialPriceFactors}
            editorialFaq={content.editorialFaq}
            blockMinChars={blockMin}
          />
        ) : (
          <div data-testid="category-seo-readonly">
            <KeyValueList
              items={[
                { label: 'SEO başlığı', value: content.seoTitle ?? <span className="cell-muted">Yazılmamış — kategori adı kullanılır</span> },
                {
                  label: 'SEO açıklaması',
                  value: content.seoDescription ?? <span className="cell-muted">Yazılmamış</span>,
                },
                {
                  label: SEO_EDITORIAL_BLOCK_LABELS.decisionGuide,
                  value: content.editorialDecisionGuide ? (
                    <span className="detail-prose">{content.editorialDecisionGuide}</span>
                  ) : (
                    <span className="cell-muted">Yazılmamış</span>
                  ),
                },
                {
                  label: SEO_EDITORIAL_BLOCK_LABELS.priceFactors,
                  value: content.editorialPriceFactors ? (
                    <span className="detail-prose">{content.editorialPriceFactors}</span>
                  ) : (
                    <span className="cell-muted">Yazılmamış</span>
                  ),
                },
                {
                  label: SEO_EDITORIAL_BLOCK_LABELS.faq,
                  value: content.editorialFaq?.length ? (
                    <ol className="seo-faq-readonly">
                      {content.editorialFaq.map((item, index) => (
                        <li key={index}>
                          <strong>{item.question}</strong>
                          <span>{item.answer}</span>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <span className="cell-muted">Yazılmamış</span>
                  ),
                },
              ]}
            />
            <p className="detail-muted-note">Bu içeriği değiştirmek için “SEO içeriği yazma” yetkisi gerekir.</p>
          </div>
        )}
      </SectionCard>
    </>
  );
}
