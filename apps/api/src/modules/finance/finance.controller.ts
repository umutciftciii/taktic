import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { ListCreditLedgerDto } from './dto/list-credit-ledger.dto';
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

  @Get('credit-ledger')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  creditLedger(@Query() query: ListCreditLedgerDto) {
    return this.financeService.listCreditLedger(query);
  }
}
