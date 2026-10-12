import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { AdminPermission } from '@prisma/client';
import { AdminAccessGuard } from '../auth/admin-access.guard';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequiresPermission } from '../auth/permissions.decorator';
import { OpenNextRoundDto } from './dto/open-next-round.dto';
import { MatchReviewService } from './match-review.service';

/**
 * REL-002 Faz 5 — MATCH_REVIEW recovery. Any request reader sees the queue;
 * opening Round 4+ needs MATCH_REVIEW_OPEN_ROUND, which only a SUPER_ADMIN
 * holds (reserved), and the service checks the role as well.
 */
@Controller('admin/service-requests')
@UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
export class AdminMatchReviewController {
  constructor(@Inject(MatchReviewService) private readonly matchReview: MatchReviewService) {}

  @Get('match-review')
  @RequiresPermission(AdminPermission.REQUESTS_READ)
  queue() {
    return this.matchReview.queue();
  }

  /** 200 for a new opening and for a replay of the same one (`replayed`). */
  @Post(':id/open-next-round')
  @HttpCode(HttpStatus.OK)
  @RequiresPermission(AdminPermission.MATCH_REVIEW_OPEN_ROUND)
  openNextRound(@Param('id') id: string, @Body() dto: OpenNextRoundDto, @CurrentUser() user: AuthUser) {
    return this.matchReview.openNextRound(id, user, dto);
  }
}
