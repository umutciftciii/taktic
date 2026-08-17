import { Controller, Get, Inject, Param, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { ProviderAccessGuard } from '../auth/provider-access.guard';
import { RolesGuard } from '../auth/roles.guard';
import { ContactSharingService } from './contact-sharing.service';

/**
 * Contact details live on their own routes, never inside an offer projection.
 *
 * Keeping them separate is what makes the guarantee checkable: no screen and no
 * client can pick up a phone number as a side effect of listing offers, and the
 * three routes below each carry their own role guard and ownership check.
 *
 * Read-only. There is no way to trigger, repeat or undo a reveal from here — the
 * accept transaction is the only writer.
 */
@Controller()
export class ContactSharingController {
  constructor(
    @Inject(ContactSharingService) private readonly contactSharing: ContactSharingService,
  ) {}

  /**
   * Public: whether the feature is on and, if so, which text the request form
   * must link to. Carries no personal data and no secret.
   */
  @Get('contact-sharing/disclosure')
  getDisclosure() {
    return this.contactSharing.getDisclosure();
  }

  /** The customer's view of the provider they accepted. */
  @Get('service-requests/:requestId/matched-contact')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.CUSTOMER)
  getProviderContactForCustomer(
    @Param('requestId') requestId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.contactSharing.getProviderContactForCustomer(requestId, user);
  }

  /** The chosen provider's view of the customer who accepted them. */
  @Get('providers/:providerId/offers/:offerId/matched-contact')
  @UseGuards(AuthGuard, ProviderAccessGuard)
  getCustomerContactForProvider(
    @Param('providerId') providerId: string,
    @Param('offerId') offerId: string,
  ) {
    return this.contactSharing.getCustomerContactForProvider(providerId, offerId);
  }

  /** The operator's view: the audit row, and both sides when one was revealed. */
  @Get('service-requests/:requestId/contact-reveal')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  getContactRevealForAdmin(@Param('requestId') requestId: string) {
    return this.contactSharing.getContactRevealForAdmin(requestId);
  }
}
