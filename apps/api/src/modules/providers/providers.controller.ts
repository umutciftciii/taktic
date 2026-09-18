import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthGuard, OptionalAuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { ProviderAccessGuard } from '../auth/provider-access.guard';
import { RolesGuard } from '../auth/roles.guard';
import { AddProviderServiceCategoryDto } from './dto/add-provider-service-category.dto';
import { CreateProviderDto } from './dto/create-provider.dto';
import { CreateOfferDto } from './dto/create-offer.dto';
import { UpdateProviderStatusDto } from './dto/update-provider-status.dto';
import { UpdateProviderDto } from './dto/update-provider.dto';
import { ProvidersService } from './providers.service';

@Controller('providers')
export class ProvidersController {
  constructor(@Inject(ProvidersService) private readonly providersService: ProvidersService) {}

  @Post()
  @UseGuards(OptionalAuthGuard)
  createProvider(
    @Body() dto: CreateProviderDto,
    @CurrentUser() user: AuthUser | null,
    @Req() request: any,
  ) {
    // The client address is passed through only so the claim invitation this
    // may trigger can be rate limited. It is never stored.
    return this.providersService.createProvider(dto, user, {
      ipAddress: request.ip ?? null,
      userAgent: request.headers?.['user-agent'] ?? null,
    });
  }

  @Get()
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  listProviders(
    @Query('status') status?: string,
    @Query('city') city?: string,
    @Query('categoryId') categoryId?: string,
    @Query('ownership') ownership?: string,
  ) {
    return this.providersService.listProviders({ status, city, categoryId, ownership });
  }

  @Get('me')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.PROVIDER)
  getMyProvider(@CurrentUser() user: AuthUser) {
    return this.providersService.getProviderForUser(user.id);
  }

  @Get('me/dashboard')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.PROVIDER)
  getMyProviderDashboard(@CurrentUser() user: AuthUser) {
    return this.providersService.getProviderDashboardForUser(user.id);
  }

  @Get(':providerId/requests')
  @UseGuards(AuthGuard, ProviderAccessGuard)
  listMatchingRequests(
    @Param('providerId') providerId: string,
    @Query('categoryId') categoryId?: string,
    @Query('city') city?: string,
    @Query('district') district?: string,
    @Query('minQualityScore') minQualityScore?: string,
    @Query('qualityLabel') qualityLabel?: string,
    @Query('urgency') urgency?: string,
  ) {
    return this.providersService.listMatchingRequests(providerId, {
      categoryId,
      city,
      district,
      minQualityScore,
      qualityLabel,
      urgency,
    });
  }

  @Get(':providerId/requests/:requestId')
  @UseGuards(AuthGuard, ProviderAccessGuard)
  getMatchingRequest(@Param('providerId') providerId: string, @Param('requestId') requestId: string) {
    return this.providersService.getMatchingRequest(providerId, requestId);
  }

  @Post(':providerId/requests/:requestId/offers')
  @UseGuards(AuthGuard, ProviderAccessGuard)
  createOffer(
    @Param('providerId') providerId: string,
    @Param('requestId') requestId: string,
    @Body() dto: CreateOfferDto,
  ) {
    return this.providersService.createOffer(providerId, requestId, dto);
  }

  @Get(':providerId/offers')
  @UseGuards(AuthGuard, ProviderAccessGuard)
  listProviderOffers(@Param('providerId') providerId: string) {
    return this.providersService.listProviderOffers(providerId);
  }

  @Get(':providerId/offers/:offerId')
  @UseGuards(AuthGuard, ProviderAccessGuard)
  getProviderOffer(@Param('providerId') providerId: string, @Param('offerId') offerId: string) {
    return this.providersService.getProviderOffer(providerId, offerId);
  }

  /**
   * Guarded by the same ProviderAccessGuard as every other provider-scoped
   * route, so it grants nothing this provider did not already have: a customer
   * or an unrelated provider is refused before the service runs, and the service
   * still checks the offer belongs to this provider. No admin-only branch is
   * added here — the admin keeps its own offer operations under /offers.
   */
  @Post(':providerId/offers/:offerId/withdraw')
  @UseGuards(AuthGuard, ProviderAccessGuard)
  withdrawProviderOffer(
    @Param('providerId') providerId: string,
    @Param('offerId') offerId: string,
  ) {
    return this.providersService.withdrawProviderOffer(providerId, offerId);
  }

  @Get(':providerId/admin-detail')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  getAdminProviderDetail(@Param('providerId') providerId: string) {
    return this.providersService.getAdminProviderDetail(providerId);
  }

  /**
   * The operator's view of a provider's service list, drafts included.
   *
   * SUPER_ADMIN only, and for the same reason `includeInactive` is: a DRAFT
   * category's name and slug are the unreleased catalogue, and this is the one
   * response body where a provider's bindings to one are visible at all. Every
   * other read of the same provider narrows them away.
   */
  @Get(':providerId/service-categories')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  listProviderServiceCategories(@Param('providerId') providerId: string) {
    return this.providersService.getAdminServiceCategories(providerId);
  }

  /**
   * Binds this provider to a category.
   *
   * Deliberately its own endpoint rather than a widening of `PATCH /providers/:id`:
   * that route is the profile form, it is reachable by the provider themselves,
   * and it replaces the whole list. Adding a draft to *it* would have made the
   * privilege a property of a payload field on a route a provider can call. One
   * binding, one route, one role.
   */
  @Post(':providerId/service-categories')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  addProviderServiceCategory(
    @Param('providerId') providerId: string,
    @Body() dto: AddProviderServiceCategoryDto,
  ) {
    return this.providersService.addServiceCategory(providerId, dto);
  }

  @Delete(':providerId/service-categories/:categoryId')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  removeProviderServiceCategory(
    @Param('providerId') providerId: string,
    @Param('categoryId') categoryId: string,
  ) {
    return this.providersService.removeServiceCategory(providerId, categoryId);
  }

  /**
   * Re-sends the claim invitation for an application nobody owns yet.
   *
   * SUPER_ADMIN only, and deliberately the only way to ask for another link:
   * a public "resend to this address" endpoint would answer whether an address
   * has an application behind it, which is exactly the enumeration this feature
   * must not offer. The response carries a status and an expiry — never the
   * token, the URL or the address.
   */
  @Post(':providerId/claim-invitations')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  resendClaimInvitation(
    @Param('providerId') providerId: string,
    @CurrentUser() actor: AuthUser,
    @Req() request: any,
  ) {
    return this.providersService.resendClaimInvitation(providerId, actor, {
      ipAddress: request.ip ?? null,
      userAgent: request.headers?.['user-agent'] ?? null,
    });
  }

  @Get(':id')
  @UseGuards(OptionalAuthGuard)
  getProvider(@Param('id') id: string, @CurrentUser() user: AuthUser | null) {
    return this.providersService.getProviderForViewer(id, user);
  }

  @Patch(':id')
  @UseGuards(AuthGuard)
  updateProvider(@Param('id') id: string, @Body() dto: UpdateProviderDto, @CurrentUser() user: AuthUser | null) {
    return this.providersService.updateProvider(id, dto, user);
  }

  @Patch(':id/status')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  updateProviderStatus(@Param('id') id: string, @Body() dto: UpdateProviderStatusDto) {
    return this.providersService.updateProviderStatus(id, dto);
  }
}
