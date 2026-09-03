import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { RolesGuard } from '../auth/roles.guard';
import { ListOffersQueryDto } from './dto/list-offers-query.dto';
import { RefundOfferCreditDto } from './dto/refund-offer-credit.dto';
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

  /**
   * The operations refund: an administrator returning one offer's credit by
   * hand, for a case the automatic unviewed-offer rule cannot see.
   *
   * SUPER_ADMIN only, and the caller is required rather than optional — the
   * audit row this writes has a NOT NULL operator column, and a refund nobody
   * signed is the thing that column exists to prevent. The guards above already
   * make a null user unreachable; the check restates it so the invariant is
   * enforced where it is relied upon.
   */
  @Post(':id/refund-credit')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  refundOfferCredit(
    @Param('id') id: string,
    @Body() dto: RefundOfferCreditDto,
    @CurrentUser() user: AuthUser | null,
  ) {
    if (!user) {
      throw new ForbiddenException('Manual refund requires an authenticated administrator');
    }

    return this.offersService.refundOfferCredit(id, dto, user);
  }
}
