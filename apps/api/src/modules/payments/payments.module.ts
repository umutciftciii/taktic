import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { CreditsModule } from '../credits/credits.module';
import { PackagePurchasesModule } from '../package-purchases/package-purchases.module';
import { LemonSqueezyCheckoutAdapter } from './lemon-squeezy.adapter';
import { LemonSqueezyWebhookController } from './lemon-squeezy-webhook.controller';
import { MockPaymentAdapter } from './mock-payment.adapter';
import { PaymentProviderPort } from './payment-provider.port';
import { resolvePaymentProviderKind } from './payment-provider.config';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PaymentsWebhookService } from './payments-webhook.service';

/**
 * Which adapter is bound is decided by PAYMENT_PROVIDER, through the same
 * allow-list every boot check reads (see payment-provider.config.ts). The mock
 * adapter stays the default: a developer who configures nothing gets the
 * in-app, clearly-labelled checkout this repository has always had, and only an
 * explicit PAYMENT_PROVIDER=lemon-squeezy-test sends anybody to a hosted page.
 *
 * The choice is made in a factory — at application init — rather than at module
 * import time. Both adapters are cheap to construct and neither reads a
 * credential until a checkout is actually opened, and resolving late is what
 * lets the integration suite boot one application per side of the switch
 * instead of asserting on a value frozen when the file was first imported.
 *
 * Nothing else about the graph changes in either branch — the credit ledger,
 * the Serializable transaction and the audit rows are the production ones
 * throughout.
 */
@Module({
  imports: [PrismaModule, AuthModule, CreditsModule, PackagePurchasesModule],
  controllers: [PaymentsController, LemonSqueezyWebhookController],
  providers: [
    MockPaymentAdapter,
    LemonSqueezyCheckoutAdapter,
    {
      provide: PaymentProviderPort,
      useFactory: (mock: MockPaymentAdapter, lemonSqueezy: LemonSqueezyCheckoutAdapter) =>
        resolvePaymentProviderKind() === 'lemon-squeezy-test' ? lemonSqueezy : mock,
      inject: [MockPaymentAdapter, LemonSqueezyCheckoutAdapter],
    },
    PaymentsService,
    PaymentsWebhookService,
  ],
  exports: [PaymentsService, PaymentsWebhookService],
})
export class PaymentsModule {}
