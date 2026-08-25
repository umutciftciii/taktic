import { Body, Controller, Get, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { ProviderAccessGuard } from '../auth/provider-access.guard';
import { RolesGuard } from '../auth/roles.guard';
import { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto';
import { PaymentsService } from './payments.service';

@Controller()
export class PaymentsController {
  constructor(@Inject(PaymentsService) private readonly payments: PaymentsService) {}

  /**
   * What the provider-facing screens read to label the flow honestly. Carries
   * the adapter kind and the fact that it is a test one — never a credential,
   * a store id or an endpoint.
   */
  @Get('payments/mode')
  @UseGuards(AuthGuard)
  readPaymentMode() {
    return this.payments.readPaymentMode();
  }

  /** The same, plus the names — never the values — of unfilled settings. */
  @Get('payments/config')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  readAdminPaymentConfig() {
    return this.payments.readAdminPaymentConfig();
  }

  /**
   * Opens a checkout for a credit package.
   *
   * ProviderAccessGuard establishes that the caller may act for this provider;
   * the service additionally refuses anyone who is not the provider account
   * itself. The response's checkout URL therefore only ever reaches the
   * provider it belongs to.
   */
  @Post('providers/:providerId/checkout-sessions')
  @UseGuards(AuthGuard, ProviderAccessGuard)
  createCheckoutSession(
    @Param('providerId') providerId: string,
    @Body() dto: CreateCheckoutSessionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.payments.createCheckoutSession(providerId, user, dto);
  }
}
