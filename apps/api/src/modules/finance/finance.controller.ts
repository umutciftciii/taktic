import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { AdminPermission } from '@prisma/client';
import { AdminAccessGuard } from '../auth/admin-access.guard';
import { AuthGuard } from '../auth/auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequiresPermission } from '../auth/permissions.decorator';
import { FinanceAnalyticsDto } from './dto/finance-analytics.dto';
import { ListCreditLedgerDto } from './dto/list-credit-ledger.dto';
import { ListProviderFinanceDto } from './dto/list-provider-finance.dto';
import { FinanceService } from './finance.service';

@Controller('finance')
export class FinanceController {
  constructor(@Inject(FinanceService) private readonly financeService: FinanceService) {}

  @Get('summary')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.FINANCE_READ)
  summary() {
    return this.financeService.summary();
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
  creditLedger(@Query() query: ListCreditLedgerDto) {
    return this.financeService.listCreditLedger(query);
  }

  @Get('providers')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.FINANCE_READ)
  providerFinance(@Query() query: ListProviderFinanceDto) {
    return this.financeService.listProviderFinance(query);
  }
}
