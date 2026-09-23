import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signature verification and payload reading for Lemon Squeezy webhooks.
 *
 * The order of the two halves of this file is the whole security story. Nothing
 * in a webhook request is data until {@link verifyLemonSqueezySignature} has
 * said so: the raw bytes are not parsed, not logged and not looked at, because
 * the endpoint is public and anybody can reach it. Only a request that carries
 * a correct HMAC over exactly those bytes is handed to {@link readLemonSqueezyEvent}.
 *
 * Nothing here throws with a payload, a header or a secret in the message.
 */

/** The header Lemon Squeezy signs its deliveries with. */
export const LEMON_SQUEEZY_SIGNATURE_HEADER = 'x-signature';

/**
 * The events this integration acts on.
 *
 * `order_created` with a settled status is the only event that may load
 * credits: the packages are one-off purchases, so there is no subscription
 * lifecycle to follow. Everything outside these lists is recorded and ignored.
 */
export const LEMON_SQUEEZY_PAYMENT_EVENTS: ReadonlySet<string> = new Set(['order_created']);

/**
 * Refund and chargeback events.
 *
 * They deliberately move nothing. Reversing a credit load automatically would
 * mean deducting credits a provider may already have spent on offers that were
 * sent, seen and answered — so these events raise a flag for a human and stop
 * there.
 */
export const LEMON_SQUEEZY_REVERSAL_EVENTS: ReadonlySet<string> = new Set([
  'order_refunded',
  'subscription_payment_refunded',
]);

/** The `attributes.status` values that mean the money actually settled. */
export const LEMON_SQUEEZY_SETTLED_ORDER_STATUSES: ReadonlySet<string> = new Set(['paid']);

/**
 * The narrow projection of a delivery that business rules are allowed to see.
 *
 * Everything the payload carries about the buyer — name, e-mail address,
 * billing country, card details — is dropped here and never reaches the
 * service, the database or a log line.
 */
export type LemonSqueezyEvent = {
  eventName: string;
  /**
   * The provider's own opaque identity for this event object, used as the
   * idempotency key. Derived from the event name and the object it refers to,
   * so a redelivery of the same notice keys the same way — and, for
   * `order_refunded` only, from the order's refund state as well (see
   * orderRefundedEventKey), so a later refund of the same order is a new event.
   */
  eventKey: string;
  testMode: boolean;
  objectType: string;
  objectId: string;
  storeId: string | null;
  variantId: string | null;
  orderStatus: string | null;
  /**
   * What the buyer was charged for the credit package, in minor units:
   * the order line item's price times its quantity.
   *
   * Deliberately not `attributes.total`. Lemon Squeezy normalises every order
   * through USD for its own accounting and derives the order's `total` and
   * `subtotal` from that rounded USD figure, so a store in any other currency
   * reports a total a minor unit or two away from the price the checkout was
   * opened with — 99900 kuruş comes back as 99904. The line item keeps the
   * exact `custom_price` this application sent, which is the number worth
   * checking: it is the one this application chose.
   */
  chargedMinor: number | null;
  currency: string | null;
  /**
   * CMP-006 PR-B. The order's own `total` in the order currency, minor units —
   * Lemon Squeezy's figure, which may drift a minor unit or two from the line
   * item after its USD normalisation (see chargedMinor). Never compared with
   * the purchase's price: it is stored at settlement as the provider's own
   * statement of what the order cost, and a refund is later measured against
   * exactly that stored value.
   */
  orderTotalMinor: number | null;
  /**
   * `attributes.refunded`: true only when the order has been fully refunded.
   * Null when absent or not a boolean — never inferred.
   */
  refunded: boolean | null;
  /** `attributes.refunded_amount` in the order currency, minor units. */
  refundedAmountMinor: number | null;
  /** This application's own correlation token, echoed back in custom data. */
  reference: string | null;
};

/**
 * Constant-time comparison of the delivery's HMAC against one computed over the
 * exact bytes that were received.
 *
 * The raw buffer matters: re-serialising a parsed body would change whitespace
 * and key order and make every genuine delivery look forged.
 */
export function verifyLemonSqueezySignature(
  rawBody: Buffer | undefined,
  signatureHeader: unknown,
  secret: string,
): boolean {
  if (!rawBody || rawBody.length === 0) {
    return false;
  }

  if (typeof signatureHeader !== 'string' || !/^[0-9a-fA-F]{64}$/.test(signatureHeader)) {
    return false;
  }

  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const received = Buffer.from(signatureHeader, 'hex');

  if (received.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(expected, received);
}

/**
 * Reads a verified delivery into {@link LemonSqueezyEvent}, or null when the
 * bytes are not a webhook payload at all.
 *
 * Called only after verification. It still validates everything it reads: a
 * correct signature proves where the bytes came from, not that they describe
 * anything this application knows how to act on.
 */
export function readLemonSqueezyEvent(rawBody: Buffer): LemonSqueezyEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    return null;
  }

  const meta = (payload as { meta?: unknown } | null)?.meta as
    | { event_name?: unknown; test_mode?: unknown; custom_data?: unknown }
    | undefined;
  const data = (payload as { data?: unknown } | null)?.data as
    | { type?: unknown; id?: unknown; attributes?: Record<string, unknown> }
    | undefined;

  const eventName = readOpaque(meta?.event_name);
  const objectType = readOpaque(data?.type);
  const objectId = readOpaque(data?.id);

  if (!eventName || !objectType || !objectId) {
    return null;
  }

  const attributes = data?.attributes ?? {};
  const custom = (meta?.custom_data ?? {}) as Record<string, unknown>;
  const firstItem = attributes.first_order_item as Record<string, unknown> | undefined;
  const orderStatus = readOpaque(attributes.status);
  const currency = readCurrency(attributes.currency);
  const refunded = typeof attributes.refunded === 'boolean' ? attributes.refunded : null;
  const refundedAmountMinor = readMinorAmount(attributes.refunded_amount);

  return {
    eventName,
    eventKey:
      eventName === ORDER_REFUNDED_EVENT
        ? orderRefundedEventKey(objectType, objectId, { orderStatus, refunded, refundedAmountMinor, currency })
        : `${eventName}:${objectType}:${objectId}`,
    // Anything other than a literal `true` is treated as a live delivery, which
    // this build refuses to act on.
    testMode: meta?.test_mode === true,
    objectType,
    objectId,
    storeId: readNumericId(attributes.store_id),
    variantId: readNumericId(firstItem?.variant_id),
    orderStatus,
    chargedMinor: readChargedAmount(firstItem),
    currency,
    orderTotalMinor: readMinorAmount(attributes.total),
    refunded,
    refundedAmountMinor,
    reference: readReference(custom.purchase_reference),
  };
}

const ORDER_REFUNDED_EVENT = 'order_refunded';

/**
 * CMP-006 PR-B. The idempotency key of an `order_refunded` delivery.
 *
 * Lemon Squeezy sends no per-delivery or per-event id (its requests carry
 * `X-Event-Name`, `X-Signature`, `meta.event_name` and `meta.custom_data`),
 * and it sends `order_refunded` for *every* refund of an order — a partial
 * one and, later, the one that completes it. Keying by the order alone made
 * the completing refund a "duplicate" of the partial one, so it could never
 * be reconciled.
 *
 * The key is therefore the order **and its refund state** as the signed
 * payload states it: `status`, `refunded`, the cumulative `refunded_amount`
 * and `currency`. A redelivery of the same notice carries the same state and
 * keys the same way (one event, one effect); a later refund moves the
 * cumulative amount or the full-refund flag and is a new event. No timestamp
 * is part of it: the provider does not document that a retried delivery
 * repeats `updated_at` byte for byte, and a key that changed on a retry would
 * turn one notice into two. The cumulative amount only ever grows, so two
 * genuine refunds cannot share a state.
 *
 * The state is folded into a SHA-256 digest rather than written out, so the
 * stored key carries no amount or currency — `PaymentWebhookEvent.eventKey`
 * stays an opaque identity, as its model comment requires.
 */
function orderRefundedEventKey(
  objectType: string,
  objectId: string,
  state: {
    orderStatus: string | null;
    refunded: boolean | null;
    refundedAmountMinor: number | null;
    currency: string | null;
  },
): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        state.orderStatus,
        state.refunded,
        state.refundedAmountMinor,
        state.currency,
      ]),
    )
    .digest('hex')
    .slice(0, 32);
  return `${ORDER_REFUNDED_EVENT}:${objectType}:${objectId}:${digest}`;
}

/**
 * A short, opaque token: the shape this application mints in
 * payments.service.ts. Anything else is not our reference, whoever sent it.
 */
function readReference(value: unknown): string | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) {
    return null;
  }

  return value;
}

function readOpaque(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(trimmed) ? trimmed : null;
}

/** Lemon Squeezy sends numeric ids as numbers or strings depending on field. */
function readNumericId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return String(value);
  }

  if (typeof value === 'string' && /^[0-9]{1,20}$/.test(value.trim())) {
    return value.trim();
  }

  return null;
}

/**
 * The line item's price times its quantity.
 *
 * Both halves are validated and either one being absent or malformed yields
 * null, which settles nothing. Multiplying rather than assuming a quantity of
 * one is what stops an order for two of the same package from quietly settling
 * a single-package purchase: the product simply will not equal the snapshot.
 */
function readChargedAmount(item: Record<string, unknown> | undefined): number | null {
  if (!item) {
    return null;
  }

  const price = readMinorAmount(item.price);
  const quantity = readQuantity(item.quantity);

  if (price === null || quantity === null) {
    return null;
  }

  const charged = price * quantity;
  return Number.isSafeInteger(charged) ? charged : null;
}

function readQuantity(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string' && /^[0-9]{1,6}$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return parsed > 0 ? parsed : null;
  }

  return null;
}

function readMinorAmount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }

  if (typeof value === 'string' && /^[0-9]{1,15}$/.test(value.trim())) {
    return Number(value.trim());
  }

  return null;
}

function readCurrency(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(trimmed) ? trimmed : null;
}
