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
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthGuard, OptionalAuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { ProviderAccessGuard } from '../auth/provider-access.guard';
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

  @Post('credit-packages')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  createCreditPackage(@Body() dto: CreateCreditPackageDto) {
    return this.creditsService.createCreditPackage(dto);
  }

  @Patch('credit-packages/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  updateCreditPackage(@Param('id') id: string, @Body() dto: UpdateCreditPackageDto) {
    return this.creditsService.updateCreditPackage(id, dto);
  }

  @Patch('credit-packages/:id/status')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  updateCreditPackageStatus(@Param('id') id: string, @Body() dto: UpdateCreditPackageStatusDto) {
    return this.creditsService.updateCreditPackageStatus(id, dto.isActive);
  }

  @Get('providers/:providerId/credits')
  @UseGuards(AuthGuard, ProviderAccessGuard)
  getProviderCredits(@Param('providerId') providerId: string) {
    return this.creditsService.getProviderCredits(providerId);
  }

  @Get('providers/:providerId/credits/transactions')
  @UseGuards(AuthGuard, ProviderAccessGuard)
  listProviderCreditTransactions(@Param('providerId') providerId: string) {
    return this.creditsService.listProviderCreditTransactions(providerId);
  }

  @Post('providers/:providerId/credits/grant')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  grantCredits(@Param('providerId') providerId: string, @Body() dto: ManualCreditTransactionDto) {
    return this.creditsService.grantCredits(providerId, dto);
  }

  @Post('providers/:providerId/credits/deduct')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  deductCredits(@Param('providerId') providerId: string, @Body() dto: ManualCreditTransactionDto) {
    return this.creditsService.deductCredits(providerId, dto);
  }
}
