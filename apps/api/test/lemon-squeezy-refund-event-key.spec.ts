import { describe, expect, it } from 'vitest';
import { readLemonSqueezyEvent } from '../src/modules/payments/lemon-squeezy.webhook';
import { lemonOrderPayload } from './lemon-squeezy-fixtures';

/**
 * CMP-006 PR-B — the idempotency key of a refund notice is the order *and its
 * refund state*; every other event keeps the order-only key it always had.
 */
function keyOf(payload: unknown) {
  return readLemonSqueezyEvent(Buffer.from(JSON.stringify(payload), 'utf8'))!.eventKey;
}

describe('webhook event keys', () => {
  it('order_created keeps its order-only key', () => {
    expect(keyOf(lemonOrderPayload({ orderId: 'order-7' }))).toBe('order_created:orders:order-7');
  });

  it('the same refund state keys the same way; a new state is a new key; nothing is written out', () => {
    const base = { eventName: 'order_refunded', orderId: 'order-7' } as const;
    const full = keyOf(lemonOrderPayload(base));
    expect(keyOf(lemonOrderPayload(base))).toBe(full);
    expect(full).toMatch(/^order_refunded:orders:order-7:[0-9a-f]{32}$/);
    expect(full).not.toContain('49902');
    expect(full).not.toContain('TRY');

    const variants = [
      { refunded: false, status: 'partial_refund', refundedAmount: 10000 },
      { refunded: false, status: 'partial_refund', refundedAmount: 20000 },
      { currency: 'USD' },
      { status: 'partial_refund' },
      { refunded: null },
      { refundedAmount: null },
    ];
    const keys = new Set([full, ...variants.map((variant) => keyOf(lemonOrderPayload({ ...base, ...variant })))]);
    expect(keys.size).toBe(variants.length + 1);
  });

  it('a subscription refund keeps its order-only key', () => {
    expect(keyOf(lemonOrderPayload({ eventName: 'subscription_payment_refunded', orderId: 'sub-1' }))).toBe(
      'subscription_payment_refunded:orders:sub-1',
    );
  });
});
