import { Body, Controller, Get, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AdminPermission, UserRole } from '@prisma/client';
import { AdminAccessGuard } from '../auth/admin-access.guard';
import { AuthGuard, OptionalAuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequiresPermission } from '../auth/permissions.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CustomerOfferActionDto } from '../offers/dto/customer-offer-action.dto';
import { getDraftTokenFromRequest } from '../request-drafts/request-draft.cookie';
import { CreateServiceRequestDto } from './dto/create-service-request.dto';
import { UpdateServiceRequestStatusDto } from './dto/update-service-request-status.dto';
import { ServiceRequestThrottlerGuard } from './service-request.throttler';
import { ServiceRequestsService } from './service-requests.service';
import { TurnstileAction } from '../turnstile/turnstile.decorators';
import { TurnstileGuard } from '../turnstile/turnstile.guard';
import { TURNSTILE_ACTIONS } from '../turnstile/turnstile.constants';
import { OffersService } from '../offers/offers.service';

@Controller('service-requests')
export class ServiceRequestsController {
  constructor(
    @Inject(ServiceRequestsService) private readonly serviceRequestsService: ServiceRequestsService,
    @Inject(OffersService) private readonly offersService: OffersService,
  ) {}

  @Post()
  // Throttle first (a tokenless flood spends its address's budget, not a
  // siteverify call each), then the Turnstile gate, then the optional session.
  @UseGuards(ServiceRequestThrottlerGuard, TurnstileGuard, OptionalAuthGuard)
  @TurnstileAction(TURNSTILE_ACTIONS.serviceRequestCreate)
  createServiceRequest(
    @Body() dto: CreateServiceRequestDto,
    @CurrentUser() user: AuthUser | null,
    @Req() req: { headers?: Record<string, string | string[] | undefined> },
  ) {
    return this.serviceRequestsService.createServiceRequest(dto, user, {
      draftToken: getDraftTokenFromRequest(req),
    });
  }

  @Get()
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.REQUESTS_READ)
  listServiceRequests() {
    return this.serviceRequestsService.listServiceRequests();
  }

  @Get('my')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.CUSTOMER)
  listMyServiceRequests(@CurrentUser() user: AuthUser) {
    return this.serviceRequestsService.listCustomerServiceRequests(user.id);
  }

  /**
   * The owning customer's single-request read. Declared before `:id` so the
   * literal `my/` segment wins; the admin route below never sees it.
   */
  @Get('my/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.CUSTOMER)
  getMyServiceRequest(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.serviceRequestsService.getCustomerServiceRequest(user.id, id);
  }

  @Get(':id')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.REQUESTS_READ)
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
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.REQUESTS_STATUS)
  updateServiceRequestStatus(
    @Param('id') id: string,
    @Body() dto: UpdateServiceRequestStatusDto,
    @CurrentUser() user: AuthUser,
  ) {
    // The operator is the actor on any credit a refusal gives back — the
    // ledger row names who removed the request, not "the system".
    return this.serviceRequestsService.updateServiceRequestStatus(id, dto, user);
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
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.REQUESTS_QUALITY_RECALC)
  recalculateQuality(@Param('id') id: string) {
    return this.serviceRequestsService.recalculateQuality(id);
  }
}
