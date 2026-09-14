import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { RolesGuard } from '../auth/roles.guard';
import { ServiceRequestsService } from '../service-requests/service-requests.service';
import { ReopenRequestDto, ResolveRequestReportsDto } from './dto/resolve-request-reports.dto';
import { RequestReportsService } from './request-reports.service';

/**
 * The operator's side of request reports, mounted under `/service-requests`.
 *
 * `GET /service-requests/reports` shares its prefix with `ServiceRequestsController`,
 * whose `GET :id` would otherwise swallow the literal `reports` as an id. This
 * controller's routes are registered first — `RequestReportsModule` is imported
 * ahead of `ServiceRequestsModule` in `AppModule`, and Nest registers routes
 * in module insertion order — and request-reports-admin.spec.ts pins that
 * order down with a 200 on exactly this path. The alternative, putting the
 * literal route on `ServiceRequestsController`, would make the two modules
 * import each other.
 */
@Controller('service-requests')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AdminRequestReportsController {
  constructor(
    @Inject(RequestReportsService) private readonly reports: RequestReportsService,
    @Inject(ServiceRequestsService) private readonly requests: ServiceRequestsService,
  ) {}

  @Get('reports')
  list(
    @Query('state') state?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const parsed = Number(limit);
    return this.reports.listForAdmin(
      state === 'resolved' ? 'resolved' : 'open',
      cursor?.trim() || null,
      Number.isInteger(parsed) && parsed > 0 && parsed <= 100 ? parsed : 50,
    );
  }

  @Get(':id/reports')
  listForRequest(@Param('id') id: string) {
    return this.reports.listForRequest(id);
  }

  @Post(':id/reports/resolve')
  resolve(
    @Param('id') id: string,
    @Body() dto: ResolveRequestReportsDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.reports.resolve(id, dto, user.id);
  }

  @Post(':id/reopen')
  reopen(@Param('id') id: string, @Body() dto: ReopenRequestDto, @CurrentUser() user: AuthUser) {
    return this.requests.reopenAfterRemoval(id, dto.moderationNote?.trim() || null, user);
  }
}
