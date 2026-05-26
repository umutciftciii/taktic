import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { CreateCreditPackageDto } from './dto/create-credit-package.dto';
import { ManualCreditTransactionDto } from './dto/manual-credit-transaction.dto';
import { UpdateCreditPackageStatusDto } from './dto/update-credit-package-status.dto';
import { UpdateCreditPackageDto } from './dto/update-credit-package.dto';
import { CreditsService } from './credits.service';

@Controller()
export class CreditsController {
  constructor(@Inject(CreditsService) private readonly creditsService: CreditsService) {}

  @Get('credit-packages')
  listCreditPackages(@Query('includeInactive') includeInactive?: string) {
    return this.creditsService.listCreditPackages(includeInactive === 'true');
  }

  @Post('credit-packages')
  createCreditPackage(@Body() dto: CreateCreditPackageDto) {
    return this.creditsService.createCreditPackage(dto);
  }

  @Patch('credit-packages/:id')
  updateCreditPackage(@Param('id') id: string, @Body() dto: UpdateCreditPackageDto) {
    return this.creditsService.updateCreditPackage(id, dto);
  }

  @Patch('credit-packages/:id/status')
  updateCreditPackageStatus(@Param('id') id: string, @Body() dto: UpdateCreditPackageStatusDto) {
    return this.creditsService.updateCreditPackageStatus(id, dto.isActive);
  }

  @Get('providers/:providerId/credits')
  getProviderCredits(@Param('providerId') providerId: string) {
    return this.creditsService.getProviderCredits(providerId);
  }

  @Get('providers/:providerId/credits/transactions')
  listProviderCreditTransactions(@Param('providerId') providerId: string) {
    return this.creditsService.listProviderCreditTransactions(providerId);
  }

  @Post('providers/:providerId/credits/grant')
  grantCredits(@Param('providerId') providerId: string, @Body() dto: ManualCreditTransactionDto) {
    return this.creditsService.grantCredits(providerId, dto);
  }

  @Post('providers/:providerId/credits/deduct')
  deductCredits(@Param('providerId') providerId: string, @Body() dto: ManualCreditTransactionDto) {
    return this.creditsService.deductCredits(providerId, dto);
  }
}
