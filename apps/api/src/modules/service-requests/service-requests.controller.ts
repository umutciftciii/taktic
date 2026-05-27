import { Body, Controller, Get, Inject, Param, Patch, Post } from '@nestjs/common';
import { CustomerOfferActionDto } from '../offers/dto/customer-offer-action.dto';
import { CreateServiceRequestDto } from './dto/create-service-request.dto';
import { UpdateServiceRequestStatusDto } from './dto/update-service-request-status.dto';
import { ServiceRequestsService } from './service-requests.service';
import { OffersService } from '../offers/offers.service';

@Controller('service-requests')
export class ServiceRequestsController {
  constructor(
    @Inject(ServiceRequestsService) private readonly serviceRequestsService: ServiceRequestsService,
    @Inject(OffersService) private readonly offersService: OffersService,
  ) {}

  @Post()
  createServiceRequest(@Body() dto: CreateServiceRequestDto) {
    return this.serviceRequestsService.createServiceRequest(dto);
  }

  @Get()
  listServiceRequests() {
    return this.serviceRequestsService.listServiceRequests();
  }

  @Get(':id')
  getServiceRequest(@Param('id') id: string) {
    return this.serviceRequestsService.getServiceRequest(id);
  }

  @Get(':id/offers')
  listRequestOffers(@Param('id') id: string) {
    return this.offersService.listRequestOffers(id);
  }

  @Get(':requestId/offers/:offerId')
  getRequestOffer(@Param('requestId') requestId: string, @Param('offerId') offerId: string) {
    return this.offersService.getRequestOffer(requestId, offerId);
  }

  @Post(':requestId/offers/:offerId/view')
  markRequestOfferViewed(@Param('requestId') requestId: string, @Param('offerId') offerId: string) {
    return this.offersService.markRequestOfferViewed(requestId, offerId);
  }

  @Post(':requestId/offers/:offerId/action')
  updateRequestOfferAction(
    @Param('requestId') requestId: string,
    @Param('offerId') offerId: string,
    @Body() dto: CustomerOfferActionDto,
  ) {
    return this.offersService.updateRequestOfferAction(requestId, offerId, dto);
  }

  @Patch(':id/status')
  updateServiceRequestStatus(@Param('id') id: string, @Body() dto: UpdateServiceRequestStatusDto) {
    return this.serviceRequestsService.updateServiceRequestStatus(id, dto);
  }

  @Post(':id/recalculate-quality')
  recalculateQuality(@Param('id') id: string) {
    return this.serviceRequestsService.recalculateQuality(id);
  }
}
