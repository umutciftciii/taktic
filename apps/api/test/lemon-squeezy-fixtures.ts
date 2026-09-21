import { createHmac } from 'node:crypto';
import request from 'supertest';
import { LEMON_SQUEEZY_SIGNATURE_HEADER } from '../src/modules/payments/lemon-squeezy.webhook';
import type { TestContext } from './harness';

/**
 * The sandbox Lemon Squeezy wiring the webhook specs share (CMP-003 S3 split
 * this out of `lemon-squeezy-webhook.spec.ts` so the refund/revoke specs post
 * the very same bytes the settlement spec does). No test reaches the network;
 * the credentials are syntactically valid placeholders that were never issued.
 */

export const LEMON_PLACEHOLDER_API_KEY = `eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.${'placeholderNotARealCredential'}`;
export const LEMON_WEBHOOK_SECRET = 'placeholder-webhook-secret-not-real';
export const LEMON_STORE_ID = '424242';
export const LEMON_VARIANT_ID = '778899';
export const LEMON_WEBHOOK_PATH = '/payments/lemon-squeezy/webhook';
export const LEMON_HOSTED_URL = 'https://taktic-sandbox.lemonsqueezy.test/checkout/abc123';

/** A buyer identity of the kind a real payload carries. Nothing may store it. */
export const LEMON_BUYER_NAME = 'Ayşe Yılmaz';
export const LEMON_BUYER_EMAIL = 'ayse.yilmaz@example.test';

export const LEMON_MANAGED_ENV_KEYS = [
  'PAYMENT_PROVIDER',
  'LEMON_SQUEEZY_API_KEY',
  'LEMON_SQUEEZY_STORE_ID',
  'LEMON_SQUEEZY_WEBHOOK_SECRET',
  'LEMON_SQUEEZY_VARIANT_MAP',
  'WEB_ORIGIN',
] as const;

export function snapshotLemonEnv(): Record<string, string | undefined> {
  return Object.fromEntries(LEMON_MANAGED_ENV_KEYS.map((key) => [key, process.env[key]]));
}

export function restoreLemonEnv(original: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

/** Points this process at the sandbox store, mapping every given slug to the one test variant. */
export function configureLemonSqueezy(packageSlugs: string | string[]) {
  const slugs = Array.isArray(packageSlugs) ? packageSlugs : [packageSlugs];
  process.env.PAYMENT_PROVIDER = 'lemon-squeezy-test';
  process.env.LEMON_SQUEEZY_API_KEY = LEMON_PLACEHOLDER_API_KEY;
  process.env.LEMON_SQUEEZY_STORE_ID = LEMON_STORE_ID;
  process.env.LEMON_SQUEEZY_WEBHOOK_SECRET = LEMON_WEBHOOK_SECRET;
  process.env.LEMON_SQUEEZY_VARIANT_MAP = slugs.map((slug) => `${slug}:${LEMON_VARIANT_ID}`).join(',');
  process.env.WEB_ORIGIN = 'https://web.example.test';
}

export type LemonOrderOverrides = {
  eventName?: string;
  orderId?: string;
  objectType?: string;
  testMode?: boolean;
  storeId?: number | string;
  status?: string;
  total?: number;
  itemPrice?: number | null;
  quantity?: number | null;
  currency?: string;
  variantId?: string;
  reference?: string | null;
};

/**
 * A delivery shaped the way Lemon Squeezy sends one, buyer details included —
 * so the assertions about what is *not* stored have something real to bite on.
 */
export function lemonOrderPayload(overrides: LemonOrderOverrides = {}) {
  return {
    meta: {
      event_name: overrides.eventName ?? 'order_created',
      test_mode: overrides.testMode ?? true,
      custom_data: overrides.reference === null ? {} : { purchase_reference: overrides.reference },
    },
    data: {
      type: overrides.objectType ?? 'orders',
      id: overrides.orderId ?? 'order-991',
      attributes: {
        store_id: overrides.storeId ?? Number(LEMON_STORE_ID),
        status: overrides.status ?? 'paid',
        total: overrides.total ?? 49902,
        currency: overrides.currency ?? 'TRY',
        user_name: LEMON_BUYER_NAME,
        user_email: LEMON_BUYER_EMAIL,
        first_order_item: {
          variant_id: Number(overrides.variantId ?? LEMON_VARIANT_ID),
          ...(overrides.itemPrice === null ? {} : { price: overrides.itemPrice ?? 49900 }),
          ...(overrides.quantity === null ? {} : { quantity: overrides.quantity ?? 1 }),
        },
      },
    },
  };
}

export function signLemonBody(body: string, secret = LEMON_WEBHOOK_SECRET) {
  return createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex');
}

export function deliverLemonWebhook(ctx: TestContext, payload: unknown, options: { signature?: string; secret?: string } = {}) {
  const body = JSON.stringify(payload);
  const signature = options.signature ?? signLemonBody(body, options.secret);
  return request(ctx.server)
    .post(LEMON_WEBHOOK_PATH)
    .set('content-type', 'application/json')
    .set(LEMON_SQUEEZY_SIGNATURE_HEADER, signature)
    .send(body);
}
