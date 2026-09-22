import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminPermission, ShowcaseLeadStatus } from '@prisma/client';
import { AdminAccessGuard } from '../auth/admin-access.guard';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/auth.decorators';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequiresPermission } from '../auth/permissions.decorator';
import {
  CreateShowcasePackageDto,
  UpdateShowcasePackageDto,
} from './dto/showcase-package.dto';
import {
  ShowcasePlacementCancelDto,
  ShowcasePlacementSuspendDto,
} from './dto/showcase-placement-admin.dto';
import { AdminShowcasePlacementsService } from './admin-showcase-placements.service';
import { ShowcaseLeadAdminService } from './showcase-lead-admin.service';
import { ShowcasePackagesService } from './showcase-packages.service';
import { ShowcasePlacementReadService } from './showcase-placement-read.service';

/**
 * The operator's side of the vitrin economy: the catalogue, the runs and the
 * leads.
 *
 * A separate prefix, separate guards and separate services from the provider's
 * routes, for the reason this module already splits the card surfaces: nothing
 * an operator may do is reachable by widening a provider endpoint.
 *
 * ## What is absent, and why
 *
 * - **No route creates a placement.** A run is born from a settled payment and
 *   from nothing else. A "grant a placement" endpoint would be free
 *   advertising with nobody's payment behind it, and it would make
 *   `ShowcasePlacement.purchaseId` a lie.
 * - **No route extends one.** Time is sold, not given. The only thing that ever
 *   moves `endAt` forward is a clock-stopping suspension being lifted, and an
 *   operator cannot type the new date — `resume()` computes it.
 * - **No route deletes one.** A run is the record of what a business paid for.
 * - **No route refunds one.** Cancelling leaves a flag for a person, exactly as
 *   a payment reversal does. Money is moved by people, not by an endpoint.
 * - **The slug cannot be edited** on a package, because it is the key into the
 *   payment provider's variant map and renaming it detaches every future
 *   checkout from the variant it was mapped to.
 */
@Controller('admin/showcase')
@UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
export class AdminShowcasePlacementsController {
  constructor(
    @Inject(ShowcasePackagesService) private readonly packages: ShowcasePackagesService,
    @Inject(ShowcasePlacementReadService)
    private readonly placements: ShowcasePlacementReadService,
    @Inject(AdminShowcasePlacementsService)
    private readonly admin: AdminShowcasePlacementsService,
    @Inject(ShowcaseLeadAdminService) private readonly leads: ShowcaseLeadAdminService,
  ) {}

  @Get('packages')
  @RequiresPermission(AdminPermission.SHOWCASE_PACKAGES_READ)
  listPackages() {
    return this.packages.listForAdmin();
  }

  @Get('packages/:packageId')
  @RequiresPermission(AdminPermission.SHOWCASE_PACKAGES_READ)
  getPackage(@Param('packageId') packageId: string) {
    return this.packages.getForAdmin(packageId);
  }

  @Post('packages')
  @RequiresPermission(AdminPermission.SHOWCASE_PACKAGES_WRITE)
  @HttpCode(HttpStatus.CREATED)
  createPackage(@Body() dto: CreateShowcasePackageDto) {
    return this.packages.create(dto);
  }

  @Patch('packages/:packageId')
  @RequiresPermission(AdminPermission.SHOWCASE_PACKAGES_WRITE)
  updatePackage(
    @Param('packageId') packageId: string,
    @Body() dto: UpdateShowcasePackageDto,
  ) {
    return this.packages.update(packageId, dto);
  }

  @Get('placements')
  @RequiresPermission(AdminPermission.SHOWCASE_PLACEMENTS_READ)
  listPlacements(
    @Query('status') status?: string,
    @Query('providerId') providerId?: string,
    @Query('categoryId') categoryId?: string,
  ) {
    return this.placements.listForAdmin({ status, providerId, categoryId });
  }

  @Get('placements/:placementId')
  @RequiresPermission(AdminPermission.SHOWCASE_PLACEMENTS_READ)
  getPlacement(@Param('placementId') placementId: string) {
    return this.placements.getForAdmin(placementId);
  }

  /**
   * Takes a run off the air. The clock stops while it is down.
   *
   * This is the platform pulling the card, so the days the provider cannot use
   * are not billed to them — see `showcase-placement-suspension.ts` for why
   * that is the opposite of what happens when the *provider* takes their own
   * card down.
   */
  @Post('placements/:placementId/suspend')
  @RequiresPermission(AdminPermission.SHOWCASE_PLACEMENTS_MODERATE)
  @HttpCode(HttpStatus.OK)
  suspendPlacement(
    @Param('placementId') placementId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: ShowcasePlacementSuspendDto,
  ) {
    return this.admin.suspend(placementId, user, dto.note ?? null);
  }

  /**
   * Lifts an operator's own hold, and pays back the time it cost.
   *
   * Only `ADMIN_ACTION`. The other five reasons lift when the condition behind
   * them goes away, and the code that changes that condition resumes the run in
   * the same transaction — an operator resuming one of those would put a card
   * back on a shelf that is still closed.
   */
  @Post('placements/:placementId/resume')
  @RequiresPermission(AdminPermission.SHOWCASE_PLACEMENTS_MODERATE)
  @HttpCode(HttpStatus.OK)
  resumePlacement(@Param('placementId') placementId: string) {
    return this.admin.resume(placementId);
  }

  /**
   * Ends a run early. **No refund happens.**
   *
   * Deliberately, and identically to how a payment reversal is handled: the row
   * carries a flag and a person decides what the money should do. Automatic
   * refunds here would mean an endpoint moving money on somebody's behalf
   * without anyone looking at what the run had already delivered.
   */
  @Post('placements/:placementId/cancel')
  @RequiresPermission(AdminPermission.SHOWCASE_PLACEMENT_CANCEL)
  @HttpCode(HttpStatus.OK)
  cancelPlacement(
    @Param('placementId') placementId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: ShowcasePlacementCancelDto,
  ) {
    return this.admin.cancel(placementId, user, dto.note ?? null);
  }

  @Get('leads')
  @RequiresPermission(AdminPermission.SHOWCASE_LEADS_READ)
  listLeads(
    @Query('status') status?: ShowcaseLeadStatus,
    @Query('providerId') providerId?: string,
  ) {
    return this.leads.list({ status, providerId });
  }

  @Get('leads/:leadId')
  @RequiresPermission(AdminPermission.SHOWCASE_LEADS_READ)
  getLead(@Param('leadId') leadId: string) {
    return this.leads.get(leadId);
  }
}
