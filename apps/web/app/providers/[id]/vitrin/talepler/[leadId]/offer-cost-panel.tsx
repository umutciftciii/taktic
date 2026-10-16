import type { OfferCostPreview } from '../../../../../../lib/api';

/**
 * CAMPAIGN-ENTITLEMENT-001 — the cost line of a direct vitrin answer, shown
 * before the button rather than after the charge.
 *
 * The figure comes from the API's own preview of the resolver, so what the
 * screen says and what the offer will spend are one decision; the form posts
 * `preview.creditCost` back and the API refuses a mismatch with a 409. Every
 * state is a sentence — never a colour alone — and the allowance count is
 * written out ("2 / 3") so a screen reader says what a sighted reader sees.
 */
export function OfferCostPanel({ preview }: { preview: OfferCostPreview | null }) {
  if (!preview) {
    return (
      <p className="pdash-form-hint" data-testid="lead-offer-cost" data-cost-kind="UNKNOWN">
        Bu teklifin maliyeti şu an hesaplanamadı. Sayfayı yenileyip tekrar deneyin.
      </p>
    );
  }

  return (
    <div
      className="pdash-notice"
      role="status"
      data-testid="lead-offer-cost"
      data-cost-kind={preview.kind}
      data-credit-cost={preview.creditCost}
    >
      <p style={{ margin: 0 }}>
        <strong>{costSentence(preview)}</strong>
      </p>
      {preview.allowance ? (
        <p style={{ margin: '4px 0 0' }} data-testid="lead-offer-allowance">
          Bu vitrin yayın döneminde ücretsiz teklif hakkınız:{' '}
          <strong>
            {preview.allowance.remaining} / {preview.allowance.quotaTotal}
          </strong>{' '}
          kaldı.
        </p>
      ) : null}
    </div>
  );
}

function costSentence(preview: OfferCostPreview): string {
  switch (preview.kind) {
    case 'SHOWCASE_ALLOWANCE':
      return `Bu teklif vitrin hakkınızdan düşecek — 0 kredi (normalde ${preview.categoryCreditCost} kredi).`;
    case 'UNLIMITED':
      return 'Bu teklif limitsiz paketinizden karşılanır; bakiyenizden kredi düşülmez.';
    case 'MONTHLY_QUOTA':
      return `Bu teklif aylık paket kotanızdan ${preview.creditCost} kredi düşer.`;
    case 'CREDITS':
      return preview.allowanceVoided
        ? `Bu yayın döneminin ücretsiz teklif hakkı iptal edildi; bu teklif ${preview.creditCost} kredi.`
        : preview.allowance && preview.allowance.remaining === 0
          ? `Bu yayın döneminin ücretsiz teklif hakları bitti; bu teklif ${preview.creditCost} kredi.`
          : `Bu teklif ${preview.creditCost} kredi.`;
    case 'INSUFFICIENT_CREDITS':
      return preview.allowanceVoided
        ? `Bu yayın döneminin ücretsiz teklif hakkı iptal edildi; bu teklif ${preview.creditCost} kredi, ancak bakiyeniz yetersiz. Teklif vermek için önce kredi yükleyin.`
        : `Bu teklif ${preview.creditCost} kredi, ancak bakiyeniz yetersiz. Teklif vermek için önce kredi yükleyin.`;
    case 'DAILY_LIMIT':
      return 'Limitsiz paketinizin bugünkü teklif sınırına ulaştınız. Yarın tekrar deneyebilirsiniz.';
  }
}
