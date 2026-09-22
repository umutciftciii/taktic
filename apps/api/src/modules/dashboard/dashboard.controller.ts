import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { AdminPermission } from '@prisma/client';
import { AdminAccessGuard } from '../auth/admin-access.guard';
import { AuthGuard } from '../auth/auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequiresPermission } from '../auth/permissions.decorator';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
export class DashboardController {
  constructor(@Inject(DashboardService) private readonly dashboardService: DashboardService) {}

  @Get('admin-summary')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.DASHBOARD_READ)
  adminSummary() {
    return this.dashboardService.adminSummary();
  }
}
