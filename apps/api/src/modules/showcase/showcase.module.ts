import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OperationsSettingsModule } from '../operations-settings/operations-settings.module';
import { PaymentsModule } from '../payments/payments.module';
import { PhoneVerificationModule } from '../phone-verification/phone-verification.module';
import { ShowcaseLifecycleModule } from './showcase-lifecycle.module';
import { ServiceRequestsModule } from '../service-requests/service-requests.module';
import { UploadsModule } from '../uploads/uploads.module';
import { AdminShowcaseController } from './admin-showcase.controller';
import { AdminShowcasePlacementsController } from './admin-showcase-placements.controller';
import { AdminShowcasePlacementsService } from './admin-showcase-placements.service';
import { AdminShowcaseService } from './admin-showcase.service';
import { ProviderShowcaseCardsController } from './provider-showcase-cards.controller';
import { ProviderShowcaseCardsService } from './provider-showcase-cards.service';
import { ProviderShowcasePlacementsController } from './provider-showcase-placements.controller';
import { ShowcaseCheckoutService } from './showcase-checkout.service';
import { ShowcaseFallbackController } from './showcase-fallback.controller';
import { ShowcaseFeedService } from './showcase-feed.service';
import { ShowcaseLeadAdminService } from './showcase-lead-admin.service';
import { ShowcaseLeadService } from './showcase-lead.service';
import { ShowcaseLeadSlaService } from './showcase-lead-sla.service';
import { ShowcasePackagesService } from './showcase-packages.service';
import { ShowcasePriceTermsService } from './showcase-price-terms.service';
import { ShowcasePlacementExpiryService } from './showcase-placement-expiry.service';
import { ShowcasePlacementReadService } from './showcase-placement-read.service';
import { ShowcasePublicationService } from './showcase-publication.service';
import { ShowcasePublicController } from './showcase-public.controller';
import { ShowcaseSchedulerService } from './showcase-scheduler.service';
import { ShowcaseUploadsController } from './showcase-uploads.controller';

/**
 * Vitrin — the bounded context, phases one and two.
 *
 * ## The split
 *
 * Four surfaces now, still divided by authority rather than by entity: the
 * business that writes a card and buys a run, the operator who decides about
 * both, the visitor who reads the shelf, and the customer who writes to one
 * business through it. They share the schema and the projections and share
 * almost no service method, because nearly every method one of them may call is
 * one the others may not.
 *
 * ## What changed about this module's imports, and why the old comment is gone
 *
 * Phase one's version of this comment said the module deliberately imported
 * "nothing about payments, entitlements, requests, offers, credits or
 * notifications", and that a vitrin card was "a reviewed text and nothing else
 * — it costs nothing to hold, it charges nobody, it appears on no customer
 * surface and it sends no mail."
 *
 * **Every clause of that is now false, and that is what phase two is.** A card
 * is sold a placement, the placement appears on the home page, the page
 * produces leads, and the leads send mail. Leaving the old sentence in place
 * would have made the most visible piece of documentation in this module a
 * description of a product that no longer exists — which is worse than no
 * comment, because a reader would trust it.
 *
 * So the imports are now: payments (to open a checkout through the same port
 * credit packages use), phone verification (a direct lead must prove its
 * telephone number before it exists), service requests (a lead *is* a request),
 * notifications (four messages), and operations settings (two operator-gated
 * jobs).
 *
 * What is still deliberately absent: **entitlements and credits.** A vitrin
 * package is never an offering right and a vitrin purchase never loads a
 * balance. The catalogue is separate (`ShowcasePackage`), a CHECK constraint
 * refuses a vitrin purchase that carries credit, and this module has no way to
 * write a ledger row. The one place the two economies touch is a single branch
 * in the entitlement resolver — which lives on the resolver's side, reads one
 * column, and costs nothing.
 *
 * ## Why two forward references
 *
 * `ServiceRequestsModule` and this one genuinely need each other: a lead is a
 * request (this module calls out), and cancelling or refusing a request closes
 * its lead in the same transaction (that module calls back). The alternative —
 * a third module owning "requests that came from cards" — would put the lead's
 * lifecycle somewhere neither of its two halves lives. The same applies to
 * `PaymentsModule`, whose webhook settles a purchase into a placement while
 * this module's checkout opens one through its port.
 */
@Module({
  imports: [
    PrismaModule,
    AuthModule,
    UploadsModule,
    NotificationsModule,
    OperationsSettingsModule,
    PhoneVerificationModule,
    // For `PaymentProviderPort`: a vitrin checkout is opened through the same
    // adapter a credit-package checkout is, so there is one place a hosted
    // session is created and one allow-list deciding which variant may stand
    // for which product.
    //
    // Not circular, and deliberately arranged so: PaymentsModule imports
    // ShowcaseLifecycleModule rather than this one, so the settlement half of
    // vitrin is reachable from payments without payments being reachable from
    // itself.
    PaymentsModule,
    // The call-backs other contexts make into vitrin. Held apart so importing
    // them puts nobody in a cycle — see ShowcaseLifecycleModule.
    ShowcaseLifecycleModule,
    ServiceRequestsModule,
  ],
  controllers: [
    ProviderShowcaseCardsController,
    ProviderShowcasePlacementsController,
    ShowcaseUploadsController,
    ShowcasePublicController,
    ShowcaseFallbackController,
    AdminShowcaseController,
    AdminShowcasePlacementsController,
  ],
  providers: [
    ProviderShowcaseCardsService,
    AdminShowcaseService,
    AdminShowcasePlacementsService,
    ShowcasePackagesService,
    ShowcasePriceTermsService,
    ShowcasePlacementReadService,
    ShowcasePublicationService,
    ShowcaseCheckoutService,
    ShowcaseFeedService,
    ShowcaseLeadService,
    ShowcaseLeadAdminService,
    ShowcaseLeadSlaService,
    ShowcasePlacementExpiryService,
    ShowcaseSchedulerService,
  ],
  /*
   * Exported because three modules outside this one hold a fact that has to
   * change a placement or a lead in the *same transaction* as their own write:
   * the payment webhook settling a purchase, the category endpoint closing a
   * shelf, the provider endpoint suspending a business or narrowing its
   * coverage, and the request lifecycle closing a lead.
   *
   * The alternative — an event those modules emit and this one reacts to —
   * would put the two halves in different transactions, and a placement left on
   * the home page because the second half failed is exactly the state this
   * shape makes impossible.
   */
  exports: [ShowcaseLeadService, ShowcaseLeadSlaService],
})
export class ShowcaseModule {}
