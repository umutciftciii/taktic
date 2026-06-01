import { Body, Controller, Get, Inject, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { ListOffersQueryDto } from './dto/list-offers-query.dto';
import { RefundOfferCreditDto } from './dto/refund-offer-credit.dto';
import { ExecuteRefundScanDto, RefundScanQueryDto } from './dto/refund-scan.dto';
import { UpdateOfferStatusDto } from './dto/update-offer-status.dto';
import { RefundScanService } from './refund-scan.service';
import { OffersService } from './offers.service';

@Controller('offers')
export class OffersController {
  constructor(
    @Inject(OffersService) private readonly offersService: OffersService,
    @Inject(RefundScanService) private readonly refundScanService: RefundScanService,
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
    return this.refundScanService.dryRun({
      olderThanHours: query.olderThanHours,
      limit: query.limit,
    });
  }

  @Post('refund-scan/execute')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  executeRefundScan(@Body() dto: ExecuteRefundScanDto) {
    return this.refundScanService.execute(dto);
  }

  @Get(':id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  getOffer(@Param('id') id: string) {
    return this.offersService.getOffer(id);
  }

  @Patch(':id/status')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  updateOfferStatus(@Param('id') id: string, @Body() dto: UpdateOfferStatusDto) {
    return this.offersService.updateOfferStatus(id, dto.status);
  }

  @Post(':id/refund-credit')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  refundOfferCredit(@Param('id') id: string, @Body() dto: RefundOfferCreditDto) {
    return this.offersService.refundOfferCredit(id, dto);
  }
}
