import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AdminPermission, PackagePurchaseStatus } from '@prisma/client';
import { readRequestMeta, type RequestMetaSource } from '../../common/request-meta';
import { WEB_SURFACE_CHANNEL } from '../../common/web-surface-channel';
import { AdminAccessGuard } from '../auth/admin-access.guard';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthUser } from '../auth/auth.types';
import { AuthGuard } from '../auth/auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { ProviderAccessGuard } from '../auth/provider-access.guard';
import { RequiresPermission } from '../auth/permissions.decorator';
import { CreatePackagePurchaseDto } from './dto/create-package-purchase.dto';
import { MockPackagePaymentDto } from './dto/mock-package-payment.dto';
import { UpdatePackagePurchaseStatusDto } from './dto/update-package-purchase-status.dto';
import { PACKAGE_PURCHASE_PAGE_MAX_SIZE, PackagePurchasesService } from './package-purchases.service';

@Controller()
export class PackagePurchasesController {
  constructor(
    @Inject(PackagePurchasesService)
    private readonly packagePurchasesService: PackagePurchasesService,
  ) {}

  @Post('providers/:providerId/package-purchases')
  @UseGuards(AuthGuard, ProviderAccessGuard)
  createProviderPurchase(
    @Param('providerId') providerId: string,
    @Body() dto: CreatePackagePurchaseDto,
    @CurrentUser() user: AuthUser,
    @Req() req: RequestMetaSource,
  ) {
    return this.packagePurchasesService.createProviderPurchase(providerId, dto, undefined, {
      user,
      meta: readRequestMeta(req),
      // CMP-006 PR-D: the route's channel — not `meta.sourceChannel`, which is
      // the client's own declaration and stays on the terms acceptance only.
      channel: WEB_SURFACE_CHANNEL,
    });
  }

  @Get('providers/:providerId/package-purchases')
  @UseGuards(AuthGuard, ProviderAccessGuard)
  listProviderPurchases(@Param('providerId') providerId: string) {
    return this.packagePurchasesService.listProviderPurchases(providerId);
  }

  @Get('providers/:providerId/package-purchases/:purchaseId')
  @UseGuards(AuthGuard, ProviderAccessGuard)
  getProviderPurchase(@Param('providerId') providerId: string, @Param('purchaseId') purchaseId: string) {
    return this.packagePurchasesService.getProviderPurchase(providerId, purchaseId);
  }

  @Post('providers/:providerId/package-purchases/:purchaseId/mock-pay')
  @UseGuards(AuthGuard, ProviderAccessGuard)
  mockPayProviderPurchase(
    @Param('providerId') providerId: string,
    @Param('purchaseId') purchaseId: string,
    @Body() dto: MockPackagePaymentDto,
  ) {
    return this.packagePurchasesService.mockPayProviderPurchase(providerId, purchaseId, dto);
  }

  /**
   * The whole filtered list, or — with `page` and/or `pageSize` — one page of
   * it with its `total` (API-SHOWCASE-PACKAGE-PURCHASES-FILTER-001).
   */
  @Get('package-purchases')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.PACKAGE_PURCHASES_READ)
  listAdminPurchases(
    @Query('status') status?: PackagePurchaseStatus,
    @Query('providerId') providerId?: string,
    @Query('packageId') packageId?: string,
    @Query('showcasePackageId') showcasePackageId?: string,
    @Query('creditHold') creditHold?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @CurrentUser() user?: AuthUser,
  ) {
    const filters = { status, providerId, packageId, showcasePackageId, creditHold };
    if (page === undefined && pageSize === undefined) {
      return this.packagePurchasesService.listAdminPurchases(filters, user ?? null);
    }
    return this.packagePurchasesService.listAdminPurchasesPage(
      filters,
      {
        page: readPageParam(page, 'page', Number.MAX_SAFE_INTEGER),
        pageSize: readPageParam(pageSize, 'pageSize', PACKAGE_PURCHASE_PAGE_MAX_SIZE),
      },
      user ?? null,
    );
  }

  /** What the same filtered list adds up to (see `summarizeAdminPurchases`). */
  @Get('package-purchases/summary')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.PACKAGE_PURCHASES_READ)
  summarizeAdminPurchases(
    @Query('status') status?: PackagePurchaseStatus,
    @Query('providerId') providerId?: string,
    @Query('packageId') packageId?: string,
    @Query('showcasePackageId') showcasePackageId?: string,
    @Query('creditHold') creditHold?: string,
  ) {
    return this.packagePurchasesService.summarizeAdminPurchases({
      status,
      providerId,
      packageId,
      showcasePackageId,
      creditHold,
    });
  }

  @Get('package-purchases/:id')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.PACKAGE_PURCHASES_READ)
  getAdminPurchase(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.packagePurchasesService.getAdminPurchase(id, user);
  }

  @Patch('package-purchases/:id/status')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.PACKAGE_PURCHASE_STATUS_WRITE)
  updateAdminPurchaseStatus(
    @Param('id') id: string,
    @Body() dto: UpdatePackagePurchaseStatusDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.packagePurchasesService.updateAdminPurchaseStatus(id, dto, user);
  }
}

/** A page parameter: absent means the default, anything but a whole number in range is a 400. */
function readPageParam(value: string | undefined, name: string, max: number): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new BadRequestException(
      max === Number.MAX_SAFE_INTEGER ? `${name} must be a positive integer` : `${name} must be an integer from 1 to ${max}`,
    );
  }
  return parsed;
}
