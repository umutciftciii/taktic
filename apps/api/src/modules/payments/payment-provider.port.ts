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

export abstract class PaymentProviderPort {
  abstract readonly kind: PaymentProviderKind;

  abstract createCheckoutSession(request: CheckoutSessionRequest): Promise<CheckoutSession>;
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
