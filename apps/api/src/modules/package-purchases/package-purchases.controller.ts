import { Body, Controller, Get, Inject, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { PackagePurchaseStatus, UserRole } from '@prisma/client';
import { Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { ProviderAccessGuard } from '../auth/provider-access.guard';
import { RolesGuard } from '../auth/roles.guard';
import { CreatePackagePurchaseDto } from './dto/create-package-purchase.dto';
import { MockPackagePaymentDto } from './dto/mock-package-payment.dto';
import { UpdatePackagePurchaseStatusDto } from './dto/update-package-purchase-status.dto';
import { PackagePurchasesService } from './package-purchases.service';

@Controller()
export class PackagePurchasesController {
  constructor(
    @Inject(PackagePurchasesService)
    private readonly packagePurchasesService: PackagePurchasesService,
  ) {}

  @Post('providers/:providerId/package-purchases')
  @UseGuards(AuthGuard, ProviderAccessGuard)
  createProviderPurchase(@Param('providerId') providerId: string, @Body() dto: CreatePackagePurchaseDto) {
    return this.packagePurchasesService.createProviderPurchase(providerId, dto);
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

  @Get('package-purchases')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  listAdminPurchases(
    @Query('status') status?: PackagePurchaseStatus,
    @Query('providerId') providerId?: string,
    @Query('packageId') packageId?: string,
  ) {
    return this.packagePurchasesService.listAdminPurchases({ status, providerId, packageId });
  }

  @Get('package-purchases/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  getAdminPurchase(@Param('id') id: string) {
    return this.packagePurchasesService.getAdminPurchase(id);
  }

  @Patch('package-purchases/:id/status')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  updateAdminPurchaseStatus(@Param('id') id: string, @Body() dto: UpdatePackagePurchaseStatusDto) {
    return this.packagePurchasesService.updateAdminPurchaseStatus(id, dto);
  }
}
