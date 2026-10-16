import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { AdminPermission } from '@prisma/client';
import { AdminAccessGuard } from '../auth/admin-access.guard';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthUser } from '../auth/auth.types';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequiresPermission } from '../auth/permissions.decorator';
import { FinanceAnalyticsDto } from './dto/finance-analytics.dto';
import { ListCreditLedgerDto } from './dto/list-credit-ledger.dto';
import { ListProviderFinanceDto } from './dto/list-provider-finance.dto';
import { OfferAllowanceReportDto } from './dto/offer-allowance-report.dto';
import { FinanceService } from './finance.service';
import { OfferAllowanceReportService } from './offer-allowance-report.service';

@Controller('finance')
export class FinanceController {
  constructor(
    @Inject(FinanceService) private readonly financeService: FinanceService,
    @Inject(OfferAllowanceReportService) private readonly offerAllowanceReport: OfferAllowanceReportService,
  ) {}

  @Get('summary')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.FINANCE_READ)
  summary(@CurrentUser() user: AuthUser) {
    return this.financeService.summary(user);
  }

  @Get('analytics')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.FINANCE_READ)
  analytics(@Query() query: FinanceAnalyticsDto) {
    return this.financeService.analytics(query);
  }

  @Get('credit-ledger')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.FINANCE_LEDGER_READ)
  creditLedger(@Query() query: ListCreditLedgerDto, @CurrentUser() user: AuthUser) {
    return this.financeService.listCreditLedger(query, user);
  }

  @Get('providers')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.FINANCE_READ)
  providerFinance(@Query() query: ListProviderFinanceDto, @CurrentUser() user: AuthUser) {
    return this.financeService.listProviderFinance(query, user);
  }

  /**
   * SHOWCASE-ALLOWANCE-002: free vitrin offers — defined, used, remaining, the
   * category credit of the used ones and its indicative TL value.
   */
  @Get('offer-allowances')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.FINANCE_READ)
  offerAllowances(@Query() query: OfferAllowanceReportDto) {
    return this.offerAllowanceReport.report(query);
  }
}
