import { Controller, Get, Inject } from '@nestjs/common';
import { OperationsSettingsService } from './operations-settings.service';
import { unviewedOfferRefundNotice } from '../offers/refund-policy';

/**
 * The refund window as a public fact, and nothing else.
 *
 * Providers are shown this promise before they sign in — on the landing page,
 * on the registration form — so the endpoint is unauthenticated. What it
 * exposes is a published commercial term: the number of hours, and the sentence
 * built from it. It carries no audit trail, no operator, and no other setting,
 * which is what keeps it separate from the admin controller rather than a
 * relaxed version of it.
 *
 * Every screen that would otherwise hard-code "48 saat" reads this instead, so
 * the sentence a provider is shown and the window their next offer is created
 * with cannot disagree.
 */
@Controller('refund-policy')
export class RefundPolicyController {
  constructor(
    @Inject(OperationsSettingsService)
    private readonly operationsSettings: OperationsSettingsService,
  ) {}

  @Get()
  async getRefundPolicy() {
    const windowHours = await this.operationsSettings.getUnviewedOfferRefundWindowHours();

    return {
      unviewedOfferRefundWindowHours: windowHours,
      unviewedOfferRefundNotice: unviewedOfferRefundNotice(windowHours),
    };
  }
}
