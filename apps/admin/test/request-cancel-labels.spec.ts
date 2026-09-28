import { describe, expect, it } from 'vitest';
import { adminPermissionLabel, notificationTemplateLabel, WINNER_REFUND_DECISION_LABELS } from '../lib/api';

/** PR #118: the two cancel permissions and the cancellation notices read as sentences in the admin. */
describe('request cancellation labels', () => {
  it('names both cancel permissions under Talepler, the exception explicitly', () => {
    expect(adminPermissionLabel('REQUESTS_CANCEL')).toEqual({
      area: 'Talepler',
      action: 'iptal (eşleşmiş talep dahil; kredi iadeleriyle)',
    });
    const withhold = adminPermissionLabel('REQUESTS_CANCEL_WITHOUT_REFUND');
    expect(withhold.area).toBe('Talepler');
    expect(withhold.action).toContain('iade etmeden');
    expect(withhold.action).toContain('gerekçe zorunlu');
  });

  it('labels the three cancellation notices', () => {
    for (const template of ['request-cancelled-customer', 'request-cancelled-winner', 'request-cancelled-offer']) {
      expect(notificationTemplateLabel(template)).toMatch(/^Talep iptal edildi/);
    }
  });

  it('has a sentence for every winner refund decision', () => {
    expect(Object.keys(WINNER_REFUND_DECISION_LABELS).sort()).toEqual(
      ['NOTHING_TO_REFUND', 'NOT_MATCHED', 'REFUNDED', 'WITHHELD'].sort(),
    );
  });
});
