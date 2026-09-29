import type { PurchaseTerms } from '../../../../lib/api';

/**
 * CMP-006 PR-A. The full text of the purchase terms, shown once above the
 * packages it applies to — the text itself, not a link to it.
 *
 * A set still awaiting legal review is labelled TASLAK in so many words: it
 * is not an approved contract and the screen must not let it pass for one.
 * (The API serves such a set only on a local stack or in tests; staging and
 * production refuse to open the gate without an approved one.)
 *
 * PR-B.1: the TEST set (`PURCHASE_TERMS_GATE=test`, local / tests / staging
 * only) is labelled "Test ortamı — üretim sözleşmesi değildir" instead — it
 * is not even a draft of the contract, only a text to exercise the flow.
 */
export function PurchaseTermsDocuments({
  terms,
}: {
  terms: Extract<PurchaseTerms, { required: true }>;
}) {
  const test = terms.testMode === true;
  const draft = !test && terms.legalReviewStatus !== 'APPROVED';

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
      {test ? (
        <p className="pdash-notice pdash-notice-warn" data-testid="purchase-terms-test-banner">
          <span>
            <strong>Test ortamı — üretim sözleşmesi değildir.</strong> Bu metinler yalnızca satın alma
            ve iade akışlarını denemek içindir; verdiğiniz onay test kaydı olarak saklanır.
          </span>
        </p>
      ) : null}
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
/**
 * API-HARDENING-001: the API refuses a credit package whose credits would take
 * the balance past the ledger's upper bound (`CREDIT_BALANCE_LIMIT_EXCEEDED`),
 * before a payment page opens and again at settlement. Nothing is charged or
 * loaded when it does.
 */
export const CREDIT_BALANCE_LIMIT_MESSAGE =
  'Bu paketin kredileri bakiyenizin üst sınırını aşacağı için satın alma başlatılmadı; ödeme alınmadı ve kredi yüklenmedi. Bakiyenizin bir kısmını kullandıktan sonra yeniden deneyebilirsiniz.';

/** The same bound, met at the mock settlement: the purchase exists and stays PENDING. */
export const CREDIT_BALANCE_LIMIT_SETTLEMENT_MESSAGE =
  'Ödeme tamamlanmadı: bu paketin kredileri bakiyenizin üst sınırını aşacaktı. Ödeme alınmadı ve kredi yüklenmedi; satın alma beklemede kalır ve bakiyenizin bir kısmını kullandıktan sonra yeniden deneyebilirsiniz.';

export const PURCHASE_TERMS_ERROR_MESSAGES: Record<string, string> = {
  'onay-gerekli': 'Ödemeye geçmek için satın alma koşullarını onaylamanız gerekiyor.',
  guncellendi:
    'Satın alma koşulları güncellendi. Lütfen güncel metni okuyup yeniden onaylayın.',
};
