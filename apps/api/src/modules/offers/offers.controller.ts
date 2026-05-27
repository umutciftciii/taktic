import { Body, Controller, Get, Inject, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { RefundOfferCreditDto } from './dto/refund-offer-credit.dto';
import { UpdateOfferStatusDto } from './dto/update-offer-status.dto';
import { OffersService } from './offers.service';

@Controller('offers')
export class OffersController {
  constructor(@Inject(OffersService) private readonly offersService: OffersService) {}

  @Get()
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  listOffers(
    @Query('status') status?: string,
    @Query('providerId') providerId?: string,
    @Query('requestId') requestId?: string,
  ) {
    return this.offersService.listOffers({ status, providerId, requestId });
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
