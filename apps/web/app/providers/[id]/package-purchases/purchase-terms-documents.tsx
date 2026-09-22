import type { PurchaseTerms } from '../../../../lib/api';

/**
 * CMP-006 PR-A. The full text of the purchase terms, shown once above the
 * packages it applies to — the text itself, not a link to it.
 *
 * A set still awaiting legal review is labelled TASLAK in so many words: it
 * is not an approved contract and the screen must not let it pass for one.
 * (The API serves such a set only on a local stack or in tests; staging and
 * production refuse to open the gate without an approved one.)
 */
export function PurchaseTermsDocuments({
  terms,
}: {
  terms: Extract<PurchaseTerms, { required: true }>;
}) {
  const draft = terms.legalReviewStatus !== 'APPROVED';

  return (
    <section
      className="purchase-terms"
      id="satin-alma-kosullari"
      aria-label="Satın alma koşulları"
      data-testid="purchase-terms-documents"
    >
      <h2 className="pdash-section-title">
        <span>Satın alma koşulları</span>
      </h2>
      {draft ? (
        <p className="pdash-notice pdash-notice-warn" data-testid="purchase-terms-draft-banner">
          <span>
            <strong>TASLAK:</strong> Bu metinler hukuk onayı beklemektedir ve onaylanmış bir sözleşme
            değildir.
          </span>
        </p>
      ) : null}
      <p className="purchase-terms-version">Sürüm: {terms.version}</p>
      {terms.documents.map((document) => (
        <details key={document.key} className="purchase-terms-document">
          <summary>{document.title}</summary>
          <div className="purchase-terms-text">{document.text}</div>
        </details>
      ))}
    </section>
  );
}

/** What a refused checkout says, keyed by the query value the action redirects with. */
export const PURCHASE_TERMS_ERROR_MESSAGES: Record<string, string> = {
  'onay-gerekli': 'Ödemeye geçmek için satın alma koşullarını onaylamanız gerekiyor.',
  guncellendi:
    'Satın alma koşulları güncellendi. Lütfen güncel metni okuyup yeniden onaylayın.',
};
