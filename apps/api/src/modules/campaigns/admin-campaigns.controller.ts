import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { RolesGuard } from '../auth/roles.guard';
import { CampaignsService } from './campaigns.service';
import { CampaignDefinitionDto } from './dto/campaign-definition.dto';
import { CampaignTransitionDto } from './dto/campaign-transition.dto';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { ListCampaignsDto } from './dto/list-campaigns.dto';

/**
 * Campaigns, for the super admin and nobody else (CMP-002 S1 + S2B2, CMP-003 S3).
 *
 * Thirteen routes: list, detail, create, revise, validate, the lifecycle —
 * activate a version, pause, resume, end — and, since S3, the operations
 * desk: a campaign's redemptions and candidate events (read-only pages), a
 * revoke of one redemption with a reason, and a retry that puts a parked
 * event back in the worker's queue. Note what is not here. No PATCH or
 * DELETE on a version — a version is written once. No engine switch: nothing
 * in this module writes `campaignEngineEnabled`, and while it is off the
 * activate, resume and retry routes answer 409 CAMPAIGN_ENGINE_DISABLED. No
 * grant or evaluation route: grants come only from the engine, in the
 * worker's own transactions; the retry route evaluates nothing itself. No
 * route deducts an arbitrary balance: the revoke names a redemption and goes
 * through the same `CampaignRevokeService` a payment reversal does. No
 * provider, customer or public route reads a campaign, and no route accepts
 * an actor: the actor is the session.
 *
 * AuthGuard turns an anonymous call into 401, RolesGuard turns a customer's
 * or a provider's into 403, and the `validate` route is declared before the
 * `:id` routes so the two cannot be confused.
 */
@Controller('admin/campaigns')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AdminCampaignsController {
  constructor(@Inject(CampaignsService) private readonly campaigns: CampaignsService) {}

  @Get()
  list(@Query() query: ListCampaignsDto) {
    return this.campaigns.list(query);
  }

  /** Judges a definition and writes nothing; the builder screen's live check. */
  @Post('validate')
  validate(@Body() dto: CampaignDefinitionDto) {
    return this.campaigns.validateForAdmin(dto.definition);
  }

  @Post()
  create(@Body() dto: CreateCampaignDto, @CurrentUser() user: AuthUser) {
    return this.campaigns.create(dto, requireActor(user));
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.campaigns.getForAdmin(id);
  }

  @Post(':id/versions')
  addVersion(
    @Param('id') id: string,
    @Body() dto: CampaignDefinitionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.campaigns.addVersion(id, dto.definition, requireActor(user));
  }

  /** DRAFT → ACTIVE on first use; afterwards swaps the running version. Refused while the engine is off. */
  @Post(':id/versions/:versionNumber/activate')
  activateVersion(
    @Param('id') id: string,
    @Param('versionNumber', ParseIntPipe) versionNumber: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.campaigns.activateVersion(id, versionNumber, requireActor(user));
  }

  @Post(':id/pause')
  pause(@Param('id') id: string, @Body() dto: CampaignTransitionDto, @CurrentUser() user: AuthUser) {
    return this.campaigns.pause(id, dto.reason, requireActor(user));
  }

  @Post(':id/resume')
  resume(@Param('id') id: string, @Body() dto: CampaignTransitionDto, @CurrentUser() user: AuthUser) {
    return this.campaigns.resume(id, dto.reason, requireActor(user));
  }

  @Post(':id/end')
  end(@Param('id') id: string, @Body() dto: CampaignTransitionDto, @CurrentUser() user: AuthUser) {
    return this.campaigns.end(id, dto.reason, requireActor(user));
  }

  // ───────────────────────── operations desk (CMP-003 S3) ─────────────────────────

  @Get(':id/redemptions')
  redemptions(@Param('id') id: string, @Query() query: ListCampaignsDto) {
    return this.campaigns.listRedemptions(id, query);
  }

  @Get(':id/evaluation-events')
  evaluationEvents(@Param('id') id: string, @Query() query: ListCampaignsDto) {
    return this.campaigns.listEvaluationEvents(id, query);
  }

  /** Revokes one GRANTED redemption of this campaign with a reason; the same path a payment reversal takes. */
  @Post(':id/redemptions/:redemptionId/revoke')
  revokeRedemption(
    @Param('id') id: string,
    @Param('redemptionId') redemptionId: string,
    @Body() dto: CampaignTransitionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.campaigns.revokeRedemption(id, redemptionId, dto.reason, requireActor(user));
  }

  /** Puts a parked event back in the worker's queue. Evaluates nothing here. */
  @Post(':id/evaluation-events/:eventId/retry')
  retryEvaluationEvent(@Param('id') id: string, @Param('eventId') eventId: string, @CurrentUser() user: AuthUser) {
    return this.campaigns.retryEvaluationEvent(id, eventId, requireActor(user));
  }
}

/**
 * Every audit row and every version row names its actor NOT NULL, so an
 * anonymous write is refused here rather than failing inside the transaction.
 * AuthGuard already makes this unreachable; the check stays because the audit
 * trail's value rests on it.
 */
function requireActor(user: AuthUser | null): string {
  if (!user?.id) {
    throw new ForbiddenException('Kampanya yalnızca oturum açmış bir yönetici tarafından değiştirilebilir');
  }
  return user.id;
}
