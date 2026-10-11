import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AdminPermission, UserRole } from '@prisma/client';
import { AdminAccessGuard } from '../auth/admin-access.guard';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequiresPermission } from '../auth/permissions.decorator';
import { ProviderAccessGuard } from '../auth/provider-access.guard';
import { RolesGuard } from '../auth/roles.guard';
import { AdminServiceIncidentsService } from './admin-service-incidents.service';
import {
  AdjudicateIncidentDto,
  CorrectIncidentDto,
  ListProviderIncidentsDto,
  ListProviderReliabilityDto,
  ListServiceIncidentsDto,
  RespondToIncidentDto,
  ResolveReliabilityReviewDto,
} from './dto/incident-dtos';
import { ProviderIncidentsService } from './provider-incidents.service';
import { ProviderReliabilityService } from './provider-reliability.service';

/**
 * REL-002 Faz 4 — the failed provider's side of an incident: read it (masked,
 * no customer detail) and answer it once. The owning provider only: a
 * SUPER_ADMIN passes `ProviderAccessGuard` elsewhere, but the response is the
 * provider's statement, so `@Roles(PROVIDER)` keeps staff out.
 */
@Controller('providers/:providerId/incidents')
@UseGuards(AuthGuard, RolesGuard, ProviderAccessGuard)
@Roles(UserRole.PROVIDER)
export class ProviderIncidentsController {
  constructor(@Inject(ProviderIncidentsService) private readonly incidents: ProviderIncidentsService) {}

  @Get()
  list(@Param('providerId') providerId: string, @Query() query: ListProviderIncidentsDto) {
    return this.incidents.list(providerId, query.state ?? 'all');
  }

  @Get(':incidentId')
  get(@Param('providerId') providerId: string, @Param('incidentId') incidentId: string) {
    return this.incidents.get(providerId, incidentId);
  }

  @Post(':incidentId/response')
  @HttpCode(HttpStatus.OK)
  respond(
    @Param('providerId') providerId: string,
    @Param('incidentId') incidentId: string,
    @Body() dto: RespondToIncidentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.incidents.respond(providerId, incidentId, user, dto.responseText);
  }
}

/** REL-002 Faz 4 — the operators' incident queue, detail and decisions. */
@Controller('admin/service-incidents')
@UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
export class AdminServiceIncidentsController {
  constructor(@Inject(AdminServiceIncidentsService) private readonly incidents: AdminServiceIncidentsService) {}

  @Get()
  @RequiresPermission(AdminPermission.SERVICE_INCIDENTS_READ)
  list(@Query() query: ListServiceIncidentsDto) {
    return this.incidents.list(query);
  }

  @Get(':id')
  @RequiresPermission(AdminPermission.SERVICE_INCIDENTS_READ)
  get(@Param('id') id: string) {
    return this.incidents.get(id);
  }

  @Post(':id/adjudications')
  @HttpCode(HttpStatus.CREATED)
  @RequiresPermission(AdminPermission.SERVICE_INCIDENTS_ADJUDICATE)
  adjudicate(@Param('id') id: string, @Body() dto: AdjudicateIncidentDto, @CurrentUser() user: AuthUser) {
    return this.incidents.adjudicate(id, user, dto);
  }

  /** SUPER_ADMIN only: the permission is reserved and the service checks the role as well. */
  @Post(':id/corrections')
  @HttpCode(HttpStatus.CREATED)
  @RequiresPermission(AdminPermission.SERVICE_INCIDENTS_CORRECT)
  correct(@Param('id') id: string, @Body() dto: CorrectIncidentDto, @CurrentUser() user: AuthUser) {
    return this.incidents.correct(id, user, dto);
  }
}

/** REL-002 Faz 4 — provider reliability: the queue, one provider, and the review workflow. */
@Controller('admin')
@UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
export class AdminProviderReliabilityController {
  constructor(@Inject(ProviderReliabilityService) private readonly reliability: ProviderReliabilityService) {}

  @Get('provider-reliability')
  @RequiresPermission(AdminPermission.PROVIDER_RELIABILITY_READ)
  queue(@Query() query: ListProviderReliabilityDto) {
    return this.reliability.queue(query);
  }

  @Get('providers/:providerId/reliability')
  @RequiresPermission(AdminPermission.PROVIDER_RELIABILITY_READ)
  forProvider(@Param('providerId') providerId: string) {
    return this.reliability.forProvider(providerId);
  }

  @Post('provider-reliability-reviews/:id/acknowledge')
  @HttpCode(HttpStatus.OK)
  @RequiresPermission(AdminPermission.PROVIDER_RELIABILITY_MANAGE)
  acknowledge(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.reliability.acknowledge(id, user);
  }

  @Post('provider-reliability-reviews/:id/resolve')
  @HttpCode(HttpStatus.OK)
  @RequiresPermission(AdminPermission.PROVIDER_RELIABILITY_MANAGE)
  resolve(@Param('id') id: string, @Body() dto: ResolveReliabilityReviewDto, @CurrentUser() user: AuthUser) {
    return this.reliability.resolve(id, user, dto.note);
  }
}
