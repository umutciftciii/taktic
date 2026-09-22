import { Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AdminPermission } from '@prisma/client';
import { readRequestMeta, type RequestMetaSource } from '../../common/request-meta';
import { AdminAccessGuard } from '../auth/admin-access.guard';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/auth.decorators';
import { PermissionsGuard } from '../auth/permissions.guard';
import { ProviderAccessGuard } from '../auth/provider-access.guard';
import { RequiresPermission } from '../auth/permissions.decorator';
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

  /**
   * CMP-006 PR-A. The purchase terms the checkout screen must show and have
   * accepted, or `{ required: false }` while the release gate is closed — in
   * which case no text is served at all. Never carries an acceptance, a
   * digest, a client address or a user agent.
   */
  @Get('payments/purchase-terms')
  @UseGuards(AuthGuard)
  readPurchaseTerms() {
    return this.payments.readPurchaseTerms();
  }

  /** The same, plus the names — never the values — of unfilled settings. */
  @Get('payments/config')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.PAYMENTS_CONFIG_READ)
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
    @Req() req: RequestMetaSource,
  ) {
    return this.payments.createCheckoutSession(providerId, user, dto, readRequestMeta(req));
  }
}
