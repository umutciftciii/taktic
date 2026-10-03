import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminPermission, SchedulerRunTrigger } from '@prisma/client';
import { AdminAccessGuard } from '../auth/admin-access.guard';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/auth.decorators';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequiresPermission } from '../auth/permissions.decorator';
import { ListOffersQueryDto } from './dto/list-offers-query.dto';
import { RefundOfferCreditDto } from './dto/refund-offer-credit.dto';
import { ExecuteRefundScanDto, RefundScanQueryDto } from './dto/refund-scan.dto';
import { UpdateOfferStatusDto } from './dto/update-offer-status.dto';
import { SchedulerRunRegistry } from '../operations-settings/scheduler-run-registry.service';
import { refundRunSummary, UnviewedOfferRefundService } from './unviewed-offer-refund.service';
import { OffersService } from './offers.service';

@Controller('offers')
export class OffersController {
  constructor(
    @Inject(OffersService) private readonly offersService: OffersService,
    @Inject(UnviewedOfferRefundService)
    private readonly unviewedOfferRefund: UnviewedOfferRefundService,
    @Inject(SchedulerRunRegistry) private readonly runs: SchedulerRunRegistry,
  ) {}

  @Get()
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.OFFERS_READ)
  listOffers(@Query() query: ListOffersQueryDto, @CurrentUser() user: AuthUser) {
    return this.offersService.listOffers({
      q: query.q,
      status: query.status,
      providerId: query.providerId,
      requestId: query.requestId,
      categoryId: query.categoryId,
      categorySlug: query.categorySlug,
      city: query.city,
      submittedFrom: query.submittedFrom,
      submittedTo: query.submittedTo,
    }, user);
  }

  @Get('refund-scan')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.OFFER_REFUND_SCAN_READ)
  refundScan(@Query() query: RefundScanQueryDto) {
    return this.unviewedOfferRefund.dryRun({ page: query.page, pageSize: query.pageSize });
  }

  @Post('refund-scan/execute')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.OFFER_REFUND_EXECUTE)
  async executeRefundScan(@Body() dto: ExecuteRefundScanDto, @CurrentUser() user: AuthUser) {
    // ADMIN-BACKEND-TRUTH-002: a hand-run leaves a run record like a scheduled
    // one — the same job key, trigger MANUAL, the operator as its actor — so
    // the operations screen can say when the refund last ran by hand and
    // whether it finished. Recording never decides the run (see the registry).
    const run = await this.runs.start('unviewed-offer-refund', SchedulerRunTrigger.MANUAL, { actorId: user.id });
    try {
      // The operator is the session, never the body: each ledger row the run
      // writes names who ran it, and the scheduler's rows stay actor-less.
      const result = await this.unviewedOfferRefund.execute({ limit: dto.limit, actorId: user.id });
      await run.succeed(refundRunSummary(result));
      return result;
    } catch (error) {
      await run.fail(error);
      throw error;
    }
  }

  @Get(':id')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.OFFERS_READ)
  getOffer(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.offersService.getOffer(id, user);
  }

  /**
   * Performs one of the three offer actions on the admin's behalf.
   *
   * The caller is passed through because the service routes this onto the same
   * method the customer screen uses, which authorises against the request's
   * owner — SUPER_ADMIN included. Nothing here grants an authority the
   * service-request route did not already grant.
   */
  @Patch(':id/status')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.OFFERS_STATUS)
  updateOfferStatus(
    @Param('id') id: string,
    @Body() dto: UpdateOfferStatusDto,
    @CurrentUser() user: AuthUser | null,
  ) {
    return this.offersService.updateOfferStatus(id, dto.status, user);
  }

  /**
   * The operations refund: an administrator returning one offer's credit by
   * hand, for a case the automatic unviewed-offer rule cannot see.
   *
   * OFFER_REFUND_MANUAL, and the caller is required rather than optional — the
   * audit row this writes has a NOT NULL operator column, and a refund nobody
   * signed is the thing that column exists to prevent. The guards above already
   * make a null user unreachable; the check restates it so the invariant is
   * enforced where it is relied upon.
   */
  @Post(':id/refund-credit')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.OFFER_REFUND_MANUAL)
  refundOfferCredit(
    @Param('id') id: string,
    @Body() dto: RefundOfferCreditDto,
    @CurrentUser() user: AuthUser | null,
  ) {
    if (!user) {
      throw new ForbiddenException('Manual refund requires an authenticated administrator');
    }

    return this.offersService.refundOfferCredit(id, dto, user);
  }
}
