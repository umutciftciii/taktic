import { Body, Controller, Get, Inject, Param, Patch, Post } from '@nestjs/common';
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

  @Patch(':id/status')
  updateServiceRequestStatus(@Param('id') id: string, @Body() dto: UpdateServiceRequestStatusDto) {
    return this.serviceRequestsService.updateServiceRequestStatus(id, dto);
  }

  @Post(':id/recalculate-quality')
  recalculateQuality(@Param('id') id: string) {
    return this.serviceRequestsService.recalculateQuality(id);
  }
}
