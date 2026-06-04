import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { FinanceAnalyticsDto } from './dto/finance-analytics.dto';
import { ListCreditLedgerDto } from './dto/list-credit-ledger.dto';
import { ListProviderFinanceDto } from './dto/list-provider-finance.dto';
import { FinanceService } from './finance.service';

@Controller('finance')
export class FinanceController {
  constructor(@Inject(FinanceService) private readonly financeService: FinanceService) {}

  @Get('summary')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  summary() {
    return this.financeService.summary();
  }

  @Get('analytics')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  analytics(@Query() query: FinanceAnalyticsDto) {
    return this.financeService.analytics(query);
  }

  @Get('credit-ledger')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  creditLedger(@Query() query: ListCreditLedgerDto) {
    return this.financeService.listCreditLedger(query);
  }

  @Get('providers')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  providerFinance(@Query() query: ListProviderFinanceDto) {
    return this.financeService.listProviderFinance(query);
  }
}
