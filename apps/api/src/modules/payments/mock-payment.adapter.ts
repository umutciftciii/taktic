import { Injectable } from '@nestjs/common';
import { PaymentProviderKind } from './payment-provider.config';
import {
  CheckoutSession,
  CheckoutSessionRequest,
  PaymentProviderCapabilities,
  PaymentProviderPort,
} from './payment-provider.port';

/**
 * The shipped default: no provider at all.
 *
 * There is nothing to call and no hosted page to send anyone to, so the session
 * carries a null URL and the web app renders its own clearly-labelled mock
 * checkout form — the same screen, the same server action and the same
 * `POST …/mock-pay` endpoint this repository has always had. This adapter
 * exists so the checkout endpoint has one shape for both providers, not to
 * change what `mock` does.
 */
@Injectable()
export class MockPaymentAdapter extends PaymentProviderPort {
  readonly kind: PaymentProviderKind = 'mock';

  /**
   * Nothing is stored and nothing is charged, so there is no payment method to
   * come back to when a period ends. The renewal path is manual here, and the
   * screens say so rather than offering a switch that would do nothing.
   */
  readonly capabilities: PaymentProviderCapabilities = {
    automaticRenewal: false,
    automaticRenewalUnsupportedReason: 'NO_STORED_PAYMENT_METHOD',
  };

  async createCheckoutSession(_request: CheckoutSessionRequest): Promise<CheckoutSession> {
    return {
      provider: this.kind,
      url: null,
      providerCheckoutId: null,
      expiresAt: null,
    };
  }
}
