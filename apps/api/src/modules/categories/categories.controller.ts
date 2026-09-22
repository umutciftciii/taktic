import {
  BadRequestException,
  Body,
  Controller,
  Delete,
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
import { AdminPermission } from '@prisma/client';
import { AdminAccessGuard } from '../auth/admin-access.guard';
import { AuthGuard } from '../auth/auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequiresPermission } from '../auth/permissions.decorator';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { ResolveRoutingDto } from './dto/resolve-routing.dto';
import {
  resolveRequestedStatus,
  UpdateCategoryStatusDto,
} from './dto/update-category-status.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

/**
 * The public catalogue, plus the writes an operator performs on it.
 *
 * What is **not** here is the point: no route on this controller returns a
 * DRAFT or INACTIVE category, to anybody, with any query string. That view
 * lives on `AdminCategoriesController` behind `CATALOG_READ`, which is a
 * different path rather than a wider mode of these ones.
 */
@Controller('categories')
export class CategoriesController {
  constructor(@Inject(CategoriesService) private readonly categoriesService: CategoriesService) {}

  /**
   * The public catalogue, and only ever the public catalogue.
   *
   * Unauthenticated: this is what a visitor sees, and it must stay reachable
   * without a session. It used to take `?includeInactive=true` and widen into
   * the operator's view for a caller who passed a check — which meant the
   * boundary between the announced catalogue and the unannounced one was a
   * query parameter. It is now `GET /admin/categories`, behind `CATALOG_READ`,
   * and this route has **no parameter that widens it**: there is nothing to
   * spoof, because there is nothing to pass.
   */
  @Get()
  listCategories(@Query('q') q?: string, @Query('limit') limit?: string) {
    return this.categoriesService.listCategories({
      includeInactive: false,
      isSuperAdmin: false,
      q,
      limit: limit ? Number(limit) : undefined,
    });
  }

  /**
   * Resolves a routed flow, over the public catalogue.
   *
   * Unauthenticated, and deliberately narrow: a router target that is not
   * released is not reachable from here for anybody, operator included. It used
   * to widen for a signed-in operator so they could walk a DRAFT flow, which
   * made this a second door onto the unreleased catalogue — and one nobody
   * would think to look at when asking "what leaks a draft". An operator who
   * needs to check the wiring reads it through `GET /admin/categories/:slug`,
   * which carries the router targets and asks for `CATALOG_READ`.
   *
   * It is a POST because the selections are a structured body, not because it
   * writes — nothing here changes a row.
   */
  @Post('routing/resolve')
  async resolveRouting(@Body() dto: ResolveRoutingDto) {
    const resolution = await this.categoriesService.resolveRouting(dto, false);

    // Deliberately narrow: slugs, kind and the next question — never ids, never
    // the target's status. What a client needs to render the next step and
    // nothing it could use to enumerate unreleased categories.
    return {
      entryCategorySlug: resolution.entryCategory.slug,
      categorySlug: resolution.category.slug,
      categoryName: resolution.category.name,
      kind: resolution.category.kind,
      pendingRouterQuestionKey: resolution.pendingRouterQuestionKey,
      isFinal: resolution.pendingRouterQuestionKey === null,
    };
  }

  /**
   * The services a business may sign itself up for.
   *
   * Unauthenticated on purpose: the application form is reachable without an
   * account, and this is the list it renders. See
   * CategoriesService.listProviderEnrollmentCategories for what that discloses
   * and why the projection is as narrow as it is.
   *
   * Declared above `:slug` because Nest matches routes in declaration order,
   * and `:slug` would otherwise swallow this path.
   */
  @Get('provider-enrollment')
  listProviderEnrollmentCategories() {
    return this.categoriesService.listProviderEnrollmentCategories();
  }

  /** The public view of one category. Same rule as the listing above. */
  @Get(':slug')
  getCategoryBySlug(@Param('slug') slug: string) {
    return this.categoriesService.getCategoryBySlug(slug, {
      includeInactive: false,
      isSuperAdmin: false,
    });
  }

  @Post()
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.CATEGORIES_WRITE)
  createCategory(@Body() dto: CreateCategoryDto) {
    return this.categoriesService.createCategory(dto);
  }

  @Patch(':id')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.CATEGORIES_WRITE)
  updateCategory(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.categoriesService.updateCategory(id, dto);
  }

  @Patch(':id/status')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.CATEGORIES_STATUS)
  updateCategoryStatus(@Param('id') id: string, @Body() dto: UpdateCategoryStatusDto) {
    const status = resolveRequestedStatus(dto);

    if (status === undefined) {
      throw new BadRequestException('status veya isActive alanlarından biri gereklidir');
    }

    return this.categoriesService.updateCategoryStatus(id, status);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.CATEGORIES_DELETE)
  deleteCategory(@Param('id') id: string) {
    return this.categoriesService.deleteCategory(id);
  }

}
