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
import { AdminPermission, UserRole } from '@prisma/client';
import { AdminAccessGuard } from '../auth/admin-access.guard';
import { AuthGuard, OptionalAuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { PermissionsGuard } from '../auth/permissions.guard';
import { ProviderAccessGuard } from '../auth/provider-access.guard';
import { RequiresPermission } from '../auth/permissions.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CreateCreditPackageDto } from './dto/create-credit-package.dto';
import { ManualCreditTransactionDto } from './dto/manual-credit-transaction.dto';
import { UpdateCreditPackageStatusDto } from './dto/update-credit-package-status.dto';
import { UpdateCreditPackageDto } from './dto/update-credit-package.dto';
import { CreditsService } from './credits.service';

@Controller()
export class CreditsController {
  constructor(@Inject(CreditsService) private readonly creditsService: CreditsService) {}

  @Get('credit-packages')
  @UseGuards(OptionalAuthGuard)
  listCreditPackages(@Query('includeInactive') includeInactive?: string, @CurrentUser() user?: AuthUser | null) {
    const shouldIncludeInactive = includeInactive === 'true';
    if (shouldIncludeInactive && user?.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Insufficient role');
    }

    return this.creditsService.listCreditPackages(shouldIncludeInactive);
  }

  /**
   * Every package of every type, for the admin package screens.
   *
   * Separate from `GET /credit-packages` rather than a flag on it, because that
   * route answers unauthenticated callers and a quota size or an unlimited
   * scope is not public information.
   */
  @Get('admin/offer-packages')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.CREDIT_PACKAGES_READ)
  listAdminPackages(@Query('includeInactive') includeInactive?: string) {
    return this.creditsService.listAllPackagesForAdmin(includeInactive !== 'false');
  }

  /**
   * The pool a CATEGORY_UNLIMITED scope may be drawn from: categories an admin
   * has explicitly marked eligible. Everything else — including every
   * regulated or high-value category nobody has considered — is absent by
   * default.
   */
  @Get('admin/offer-packages/unlimited-eligible-categories')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.CREDIT_PACKAGES_READ)
  listUnlimitedEligibleCategories() {
    return this.creditsService.listUnlimitedEligibleCategories();
  }

  @Get('admin/offer-packages/:id')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.CREDIT_PACKAGES_READ)
  getAdminPackage(@Param('id') id: string) {
    return this.creditsService.getPackageForAdmin(id);
  }

  @Post('credit-packages')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.CREDIT_PACKAGES_WRITE)
  createCreditPackage(@Body() dto: CreateCreditPackageDto) {
    return this.creditsService.createCreditPackage(dto);
  }

  @Patch('credit-packages/:id')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.CREDIT_PACKAGES_WRITE)
  updateCreditPackage(@Param('id') id: string, @Body() dto: UpdateCreditPackageDto) {
    return this.creditsService.updateCreditPackage(id, dto);
  }

  @Patch('credit-packages/:id/status')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.CREDIT_PACKAGES_STATUS)
  updateCreditPackageStatus(@Param('id') id: string, @Body() dto: UpdateCreditPackageStatusDto) {
    return this.creditsService.updateCreditPackageStatus(id, dto.isActive);
  }

  /**
   * The signed-in provider's spendable promotion (CMP-004 S4).
   *
   * A static `me` path on purpose, declared before the id-taking credits
   * routes: the provider is the session's own and the handler reads no route
   * parameter, query, header or body, so there is no id here for anyone to
   * enumerate. PROVIDER only — a super admin reads promotions through the
   * ledger, and this projection is the provider's own screen.
   */
  @Get('providers/me/credits/promo')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.PROVIDER)
  getMyPromoCredits(@CurrentUser() user: AuthUser) {
    return this.creditsService.getMyPromoCredits(user.id);
  }

  @Get('providers/:providerId/credits')
  @UseGuards(AuthGuard, ProviderAccessGuard)
  getProviderCredits(@Param('providerId') providerId: string, @CurrentUser() user: AuthUser) {
    return this.creditsService.getProviderCredits(providerId, {
      includeActor: user.role === UserRole.SUPER_ADMIN,
    });
  }

  @Get('providers/:providerId/credits/transactions')
  @UseGuards(AuthGuard, ProviderAccessGuard)
  listProviderCreditTransactions(
    @Param('providerId') providerId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.creditsService.listProviderCreditTransactions(providerId, {
      includeActor: user.role === UserRole.SUPER_ADMIN,
    });
  }

  @Post('providers/:providerId/credits/grant')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.CREDITS_GRANT)
  grantCredits(
    @Param('providerId') providerId: string,
    @Body() dto: ManualCreditTransactionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.creditsService.grantCredits(providerId, dto, user.id);
  }

  @Post('providers/:providerId/credits/deduct')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.CREDITS_DEDUCT)
  deductCredits(
    @Param('providerId') providerId: string,
    @Body() dto: ManualCreditTransactionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.creditsService.deductCredits(providerId, dto, user.id);
  }
}
