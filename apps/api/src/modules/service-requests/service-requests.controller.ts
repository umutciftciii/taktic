import { Body, Controller, Get, Inject, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthGuard, OptionalAuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { RolesGuard } from '../auth/roles.guard';
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
  @UseGuards(OptionalAuthGuard)
  createServiceRequest(@Body() dto: CreateServiceRequestDto, @CurrentUser() user: AuthUser | null) {
    return this.serviceRequestsService.createServiceRequest(dto, user);
  }

  @Get()
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  listServiceRequests() {
    return this.serviceRequestsService.listServiceRequests();
  }

  @Get('my')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.CUSTOMER)
  listMyServiceRequests(@CurrentUser() user: AuthUser) {
    return this.serviceRequestsService.listCustomerServiceRequests(user.id);
  }

  @Get(':id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  getServiceRequest(@Param('id') id: string) {
    return this.serviceRequestsService.getServiceRequest(id);
  }

  @Get(':id/offers')
  @UseGuards(OptionalAuthGuard)
  listRequestOffers(@Param('id') id: string, @CurrentUser() user: AuthUser | null) {
    return this.offersService.listRequestOffers(id, user);
  }

  @Get(':requestId/offers/:offerId')
  @UseGuards(OptionalAuthGuard)
  getRequestOffer(
    @Param('requestId') requestId: string,
    @Param('offerId') offerId: string,
    @CurrentUser() user: AuthUser | null,
  ) {
    return this.offersService.getRequestOffer(requestId, offerId, user);
  }

  @Post(':requestId/offers/:offerId/view')
  @UseGuards(OptionalAuthGuard)
  markRequestOfferViewed(
    @Param('requestId') requestId: string,
    @Param('offerId') offerId: string,
    @CurrentUser() user: AuthUser | null,
  ) {
    return this.offersService.markRequestOfferViewed(requestId, offerId, user);
  }

  @Post(':requestId/offers/:offerId/action')
  @UseGuards(OptionalAuthGuard)
  updateRequestOfferAction(
    @Param('requestId') requestId: string,
    @Param('offerId') offerId: string,
    @Body() dto: CustomerOfferActionDto,
    @CurrentUser() user: AuthUser | null,
  ) {
    return this.offersService.updateRequestOfferAction(requestId, offerId, dto, user);
  }

  @Patch(':id/status')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  updateServiceRequestStatus(@Param('id') id: string, @Body() dto: UpdateServiceRequestStatusDto) {
    return this.serviceRequestsService.updateServiceRequestStatus(id, dto);
  }

  /**
   * Lifecycle endpoints, deliberately separate from the moderation status
   * dropdown: they are open to the owning customer as well as SUPER_ADMIN, and
   * they enforce transition rules the moderation path does not.
   */
  @Post(':id/complete')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.CUSTOMER, UserRole.SUPER_ADMIN)
  completeServiceRequest(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.serviceRequestsService.completeServiceRequest(id, user);
  }

  @Post(':id/cancel')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.CUSTOMER, UserRole.SUPER_ADMIN)
  cancelServiceRequest(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.serviceRequestsService.cancelServiceRequest(id, user);
  }

  @Post(':id/recalculate-quality')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  recalculateQuality(@Param('id') id: string) {
    return this.serviceRequestsService.recalculateQuality(id);
  }
}
