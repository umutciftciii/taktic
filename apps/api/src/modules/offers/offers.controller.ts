import { Body, Controller, Get, Inject, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { RolesGuard } from '../auth/roles.guard';
import { ListOffersQueryDto } from './dto/list-offers-query.dto';
import { ExecuteRefundScanDto, RefundScanQueryDto } from './dto/refund-scan.dto';
import { UpdateOfferStatusDto } from './dto/update-offer-status.dto';
import { UnviewedOfferRefundService } from './unviewed-offer-refund.service';
import { OffersService } from './offers.service';

@Controller('offers')
export class OffersController {
  constructor(
    @Inject(OffersService) private readonly offersService: OffersService,
    @Inject(UnviewedOfferRefundService)
    private readonly unviewedOfferRefund: UnviewedOfferRefundService,
  ) {}

  @Get()
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  listOffers(@Query() query: ListOffersQueryDto) {
    return this.offersService.listOffers({
      q: query.q,
      status: query.status,
      providerId: query.providerId,
      requestId: query.requestId,
      categoryId: query.categoryId,
      categorySlug: query.categorySlug,
      city: query.city,
      submittedFrom: query.submittedFrom,
      submittedTo: query.submittedTo,
    });
  }

  @Get('refund-scan')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  refundScan(@Query() query: RefundScanQueryDto) {
    return this.unviewedOfferRefund.dryRun({ limit: query.limit });
  }

  @Post('refund-scan/execute')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  executeRefundScan(@Body() dto: ExecuteRefundScanDto) {
    return this.unviewedOfferRefund.execute(dto);
  }

  @Get(':id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  getOffer(@Param('id') id: string) {
    return this.offersService.getOffer(id);
  }

  /**
   * Performs one of the three offer actions on the admin's behalf.
   *
   * The caller is passed through because the service routes this onto the same
   * method the customer screen uses, which authorises against the request's
   * owner — SUPER_ADMIN included. Nothing here grants an authority the
   * service-request route did not already grant.
   */
  @Patch(':id/status')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  updateOfferStatus(
    @Param('id') id: string,
    @Body() dto: UpdateOfferStatusDto,
    @CurrentUser() user: AuthUser | null,
  ) {
    return this.offersService.updateOfferStatus(id, dto.status, user);
  }
}
