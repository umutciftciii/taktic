import { PaymentProviderKind } from './payment-provider.config';

/**
 * Provider-agnostic contract for opening a checkout against a pending credit
 * package purchase.
 *
 * Call sites depend on this abstract class, so swapping the adapter — the
 * in-app mock form in development, the Lemon Squeezy sandbox in a test-mode
 * deployment — never touches business code.
 *
 * What the port deliberately cannot do is settle anything. There is no
 * `capture`, no `confirm` and no "the browser came back, so it worked": the only
 * thing that may ever move a purchase to PAID is a signature-verified webhook
 * (see payments-webhook.service.ts). A checkout session is an invitation to pay
 * and nothing more.
 */
export type CheckoutSessionRequest = {
  /** This application's purchase row. Never sent to the provider as-is. */
  purchaseId: string;
  /** Opaque correlation token minted by this application for this purchase. */
  reference: string;
  /** Resolved server-side from the active credit package allow-list. */
  packageSlug: string;
  packageName: string;
  creditAmount: number;
  /** Minor units (kuruş for TRY), from the purchase's own snapshot. */
  priceAmount: number;
  currency: string;
  /** Where the provider's browser is sent afterwards. Grants nothing. */
  returnUrl: string;
};

export type CheckoutSession = {
  provider: PaymentProviderKind;
  /**
   * The hosted page to send the browser to, or `null` when the provider has no
   * hosted page and the application renders the checkout itself (the mock
   * adapter). A null URL is not an error.
   */
  url: string | null;
  /** Opaque provider-side identifier for the session, when there is one. */
  providerCheckoutId: string | null;
  expiresAt: Date | null;
};

/**
 * Why an adapter cannot charge a stored payment method, as a short code the
 * screens map onto plain wording.
 *
 * `NO_STORED_PAYMENT_METHOD` is the case both adapters in this build are in:
 * there is no card on file to charge, because nothing here ever stores one.
 * `NO_LIVE_MODE` is the second, independent reason — a sandbox integration
 * settles nothing, so a "successful" renewal through it would be a renewal
 * against money that never moved.
 */
export type AutomaticRenewalUnsupportedReason =
  | 'NO_STORED_PAYMENT_METHOD'
  | 'NO_LIVE_MODE';

/**
 * What an adapter can do beyond opening a checkout.
 *
 * Modelled as a capability the adapter declares rather than a feature flag an
 * operator sets, because it is a fact about the integration and not a
 * preference. Automatic renewal is offered to providers only where this says
 * the money can actually be taken; everywhere else the screens say so in as
 * many words and the manual renewal path is the whole of the feature.
 */
export type PaymentProviderCapabilities = {
  /**
   * Whether this adapter can charge a payment method the provider has already
   * authorised, without them being present.
   *
   * False for every adapter in this build. See `automaticRenewalUnsupportedReason`.
   */
  automaticRenewal: boolean;
  automaticRenewalUnsupportedReason: AutomaticRenewalUnsupportedReason | null;
};

export abstract class PaymentProviderPort {
  abstract readonly kind: PaymentProviderKind;

  /**
   * Declared by every adapter. There is deliberately no default: an adapter
   * added later must state what it can do rather than inherit an answer.
   */
  abstract readonly capabilities: PaymentProviderCapabilities;

  abstract createCheckoutSession(request: CheckoutSessionRequest): Promise<CheckoutSession>;

  /**
   * Charges a payment method the provider already authorised, for one renewal.
   *
   * Optional, and absent from every adapter in this build. An adapter that
   * declares `capabilities.automaticRenewal` must implement it; the renewal
   * service treats "claims the capability but has no method" as an unsupported
   * provider rather than as a silent success, so the two can never disagree in
   * the direction that would grant unpaid access.
   *
   * `idempotencyKey` is `<entitlementId>:<periodIndex>` — stable for a given
   * period, so a provider that honours idempotency keys refuses the second
   * charge itself rather than relying on this application winning a race.
   */
  chargeStoredPaymentMethod?(
    request: StoredPaymentChargeRequest,
  ): Promise<StoredPaymentChargeResult>;
}

export type StoredPaymentChargeRequest = {
  entitlementId: string;
  providerId: string;
  /** The provider's own token for the stored method. Never card data. */
  paymentMethodReference: string;
  /** Minor units, from the entitlement's own snapshot. */
  priceAmount: number;
  currency: string;
  idempotencyKey: string;
};

export type StoredPaymentChargeResult = {
  /** The payment provider's opaque transaction identifier. Never a payload. */
  providerTransactionRef: string;
};

/**
 * A renewal charge that did not go through, as one of a closed set of classes.
 *
 * No decline message, no response body, no card detail: this travels into an
 * audit row an admin reads and into a screen the provider reads.
 */
export type StoredPaymentChargeFailureCode =
  | 'PAYMENT_DECLINED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_REJECTED'
  | 'PROVIDER_TIMEOUT';

export class StoredPaymentChargeError extends Error {
  readonly failureCode: StoredPaymentChargeFailureCode;

  constructor(failureCode: StoredPaymentChargeFailureCode) {
    super(`Stored payment method could not be charged (${failureCode})`);
    this.failureCode = failureCode;
    this.name = 'StoredPaymentChargeError';
  }
}

/**
 * Carries a failure class and, when there was one, the HTTP status.
 * Deliberately nothing else: no API key, no response body, no customer detail.
 * Provider error bodies routinely echo the payload back, and this error travels
 * into a log line.
 */
export type CheckoutFailureCode =
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_REJECTED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_RESPONSE_INVALID'
  | 'PACKAGE_NOT_MAPPED';

export class CheckoutSessionError extends Error {
  readonly failureCode: CheckoutFailureCode;
  readonly status: number | null;

  constructor(failureCode: CheckoutFailureCode, status: number | null = null) {
    super(
      status === null
        ? `Checkout session could not be created (${failureCode})`
        : `Checkout session could not be created (${failureCode}, HTTP ${status})`,
    );
    this.failureCode = failureCode;
    this.status = status;
    this.name = 'CheckoutSessionError';
  }
}
