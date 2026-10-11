import { Body, Controller, HttpCode, HttpStatus, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { RolesGuard } from '../auth/roles.guard';
import { ReportServiceIssueDto } from './dto/report-service-issue.dto';
import { ServiceIssueThrottlerGuard } from './service-issue.throttler';
import { ServiceIssueService } from './service-issue.service';

/**
 * REL-002 Faz 3 — the customer's "the provider did not deliver".
 *
 * The owning customer only (a SUPER_ADMIN does not report on a customer's
 * behalf: the statement is the customer's). 404 while the operations switch
 * is off, for a request that is not theirs and for one that does not exist.
 * 200 for a new report and for a replay of the same one.
 */
@Controller('service-requests')
export class ServiceIssueController {
  constructor(@Inject(ServiceIssueService) private readonly serviceIssues: ServiceIssueService) {}

  @Post(':id/service-issue')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard, RolesGuard, ServiceIssueThrottlerGuard)
  @Roles(UserRole.CUSTOMER)
  report(@Param('id') id: string, @Body() dto: ReportServiceIssueDto, @CurrentUser() user: AuthUser) {
    return this.serviceIssues.report(id, user, dto);
  }
}
