import { Body, Controller, ForbiddenException, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AdminPermission } from '@prisma/client';
import { AdminAccessGuard } from '../../auth/admin-access.guard';
import { AuthGuard } from '../../auth/auth.guard';
import { CurrentUser } from '../../auth/auth.decorators';
import type { AuthUser } from '../../auth/auth.types';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { RequiresPermission } from '../../auth/permissions.decorator';
import { EligibilityDecisionDto } from './eligibility-decision.dto';
import { PromotionEligibilityReviewsService } from './promotion-eligibility-reviews.service';

/**
 * The promotion eligibility queue (CMP-006 PR-C). Its own prefix rather than
 * `admin/campaigns/…`, where `GET :id` would capture it, and its own
 * permission for reading as well as deciding: the snapshot is a provider's
 * risk reasons, which not everyone who reads campaigns needs to see.
 */
@Controller('admin/promotion-eligibility')
@UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
export class AdminPromotionEligibilityController {
  constructor(@Inject(PromotionEligibilityReviewsService) private readonly reviews: PromotionEligibilityReviewsService) {}

  @Get('holds')
  @RequiresPermission(AdminPermission.PROMOTION_ELIGIBILITY_REVIEW)
  list(@Query('filter') filter?: string, @Query('providerId') providerId?: string) {
    return this.reviews.list(filter === 'decided' ? 'decided' : filter === 'all' ? 'all' : 'open', providerId?.trim() || null);
  }

  @Get('holds/:eventId')
  @RequiresPermission(AdminPermission.PROMOTION_ELIGIBILITY_REVIEW)
  get(@Param('eventId') eventId: string) {
    return this.reviews.get(eventId);
  }

  @Post('holds/:eventId/decision')
  @RequiresPermission(AdminPermission.PROMOTION_ELIGIBILITY_REVIEW)
  decide(@Param('eventId') eventId: string, @Body() dto: EligibilityDecisionDto, @CurrentUser() user: AuthUser | null) {
    if (!user?.id) {
      throw new ForbiddenException('Uygunluk kararı yalnızca oturum açmış bir yönetici tarafından verilebilir');
    }
    return this.reviews.decide(eventId, dto, user.id);
  }
}
