import { Controller, Get, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { RolesGuard } from '../auth/roles.guard';
import { PackageRefundRequestsService } from './package-refund-requests.service';

/**
 * CMP-006 PR-B — the provider's two refund reads/writes beside the support
 * form. Opening a request is not here: it is `POST /support/tickets` with the
 * refund topic, so the ticket and the request are born in one transaction.
 *
 * PROVIDER only. Everything is scoped to the session's own provider profile
 * and own tickets; a foreign ticket id is the same 404 as an invented one.
 */
@Controller('support/package-refund')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.PROVIDER)
export class ProviderPackageRefundController {
  constructor(
    @Inject(PackageRefundRequestsService) private readonly requests: PackageRefundRequestsService,
  ) {}

  /** What the support form may offer. `available: false` with the flow closed. */
  @Get('options')
  options(@CurrentUser() user: AuthUser) {
    return this.requests.providerOptions(user);
  }

  @Post('tickets/:ticketId/withdraw')
  @HttpCode(200)
  withdraw(@Param('ticketId') ticketId: string, @CurrentUser() user: AuthUser) {
    return this.requests.withdraw(user, ticketId);
  }
}
