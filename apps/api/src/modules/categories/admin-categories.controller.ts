import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import { AdminPermission } from '@prisma/client';
import { AdminAccessGuard } from '../auth/admin-access.guard';
import { AuthGuard } from '../auth/auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequiresPermission } from '../auth/permissions.decorator';
import { CategoriesService } from './categories.service';

/**
 * The operator's catalogue: every category, DRAFT and INACTIVE included.
 *
 * A separate path, a separate guard and a separate controller from the public
 * one, on purpose. The unreleased catalogue used to be the same two endpoints
 * widened by `?includeInactive=true`, which made the boundary between "what
 * anyone may see" and "what the marketplace has not announced yet" a query
 * parameter and a check somebody had to remember to run. It is now a different
 * URL that cannot be reached without `CATALOG_READ` — there is no parameter to
 * pass, so there is nothing to forget and nothing to spoof.
 *
 * Read only, and that is the second half of the decision. Writing a category,
 * moving its status and deleting it stay on `CATEGORIES_WRITE`,
 * `CATEGORIES_STATUS` and `CATEGORIES_DELETE`: a role trusted to *look* at the
 * unreleased catalogue is not thereby trusted to publish from it.
 */
@Controller('admin/categories')
@UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
export class AdminCategoriesController {
  constructor(@Inject(CategoriesService) private readonly categoriesService: CategoriesService) {}

  @Get()
  @RequiresPermission(AdminPermission.CATALOG_READ)
  listCategories(@Query('q') q?: string, @Query('limit') limit?: string) {
    return this.categoriesService.listCategories({
      includeInactive: true,
      isSuperAdmin: true,
      q,
      limit: limit ? Number(limit) : undefined,
    });
  }

  /**
   * One category by slug — the identity the public read uses, so an operator
   * following a link from the marketplace lands on the same row.
   *
   * Carries the router targets and the draft bindings the public projection
   * narrows away; that is what this route exists for.
   */
  @Get(':slug')
  @RequiresPermission(AdminPermission.CATALOG_READ)
  getCategoryBySlug(@Param('slug') slug: string) {
    return this.categoriesService.getCategoryBySlug(slug, {
      includeInactive: true,
      isSuperAdmin: true,
    });
  }
}
