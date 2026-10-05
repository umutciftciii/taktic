import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { promoSpendPriorityLabel } from '../lib/formatters';

/**
 * CAMPAIGN-CREDIT-POLICY-001 — the provider is no longer told that promotion
 * credit is always spent first. Each lot says where it stands against paid
 * credit, as its own campaign version decided.
 */
describe('promotion lot spend priority', () => {
  it('labels each policy in the provider’s words', () => {
    expect(promoSpendPriorityLabel('PROMO_FIRST')).toBe('Önce kullanılır');
    expect(promoSpendPriorityLabel('PAID_FIRST')).toBe('Ücretli krediden sonra kullanılır');
  });

  it('drops the blanket “used first” sentence and labels every lot instead', () => {
    const source = readFileSync(resolve(__dirname, '../app/providers/[id]/credits/page.tsx'), 'utf8');
    expect(source).not.toContain('Promosyon kredisi teklif gönderirken önce kullanılır');
    expect(source).toContain('promoSpendPriorityLabel(lot.spendPriority)');
    expect(source).toContain('data-testid="promo-lot-priority"');
  });
});
