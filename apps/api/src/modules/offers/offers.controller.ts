import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { RefundOfferCreditDto } from './dto/refund-offer-credit.dto';
import { UpdateOfferStatusDto } from './dto/update-offer-status.dto';
import { OffersService } from './offers.service';

@Controller('offers')
export class OffersController {
  constructor(@Inject(OffersService) private readonly offersService: OffersService) {}

  @Get()
  listOffers(
    @Query('status') status?: string,
    @Query('providerId') providerId?: string,
    @Query('requestId') requestId?: string,
  ) {
    return this.offersService.listOffers({ status, providerId, requestId });
  }

  @Get(':id')
  getOffer(@Param('id') id: string) {
    return this.offersService.getOffer(id);
  }

  @Patch(':id/status')
  updateOfferStatus(@Param('id') id: string, @Body() dto: UpdateOfferStatusDto) {
    return this.offersService.updateOfferStatus(id, dto.status);
  }

  @Post(':id/refund-credit')
  refundOfferCredit(@Param('id') id: string, @Body() dto: RefundOfferCreditDto) {
    return this.offersService.refundOfferCredit(id, dto);
  }
}
