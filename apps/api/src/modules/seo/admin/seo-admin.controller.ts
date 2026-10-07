import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AdminPermission } from '@prisma/client';
import { AuditPageQueryDto } from '../../../common/admin-audit';
import { AdminAccessGuard } from '../../auth/admin-access.guard';
import { CurrentUser } from '../../auth/auth.decorators';
import { AuthGuard } from '../../auth/auth.guard';
import type { AuthUser } from '../../auth/auth.types';
import { RequiresPermission } from '../../auth/permissions.decorator';
import { PermissionsGuard } from '../../auth/permissions.guard';
import {
  ApproveSuggestionDto,
  ChangeSlugDto,
  CreateRedirectDto,
  DeactivateRedirectDto,
  NonIndexablePagesQueryDto,
  NotFoundListQueryDto,
  RedirectListQueryDto,
  RejectSuggestionDto,
  SlugListQueryDto,
  SlugPreviewQueryDto,
  UpdateRedirectDto,
} from './seo-admin.dto';
import { SeoAdminService } from './seo-admin.service';

/**
 * SEO-004 — the admin SEO API. Every route is staff-only and names its one
 * permission (the route map holds them to it):
 *
 *   SEO_READ             every read
 *   SEO_CONTENT_WRITE    a category's SEO title/description and editorial blocks
 *   SEO_REDIRECTS_WRITE  manual redirects; a 404 suggestion's approval or rejection
 *   CATEGORIES_WRITE     a slug change — it is a category edit, and its 301 is
 *                        that edit's consequence, not a separate permission
 *
 * None is root-only: a SUPER_ADMIN holds them implicitly, and any role may be
 * given them.
 */
@Controller('admin/seo')
@UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
export class SeoAdminController {
  constructor(@Inject(SeoAdminService) private readonly seo: SeoAdminService) {}

  @Get('overview')
  @RequiresPermission(AdminPermission.SEO_READ)
  overview() {
    return this.seo.overview();
  }

  @Get('pages')
  @RequiresPermission(AdminPermission.SEO_READ)
  listNonIndexablePages(@Query() query: NonIndexablePagesQueryDto) {
    return this.seo.listNonIndexablePages(query);
  }

  @Get('slugs')
  @RequiresPermission(AdminPermission.SEO_READ)
  listSlugs(@Query() query: SlugListQueryDto) {
    return this.seo.listSlugs(query);
  }

  @Get('categories/:id/slug-preview')
  @RequiresPermission(AdminPermission.SEO_READ)
  previewSlugChange(@Param('id') id: string, @Query() query: SlugPreviewQueryDto) {
    return this.seo.previewSlugChange(id, query.slug);
  }

  @Post('categories/:id/slug')
  @HttpCode(HttpStatus.OK)
  @RequiresPermission(AdminPermission.CATEGORIES_WRITE)
  changeSlug(@Param('id') id: string, @Body() dto: ChangeSlugDto, @CurrentUser() user: AuthUser) {
    return this.seo.changeSlug(id, dto.slug, user);
  }

  @Get('categories/:id/content')
  @RequiresPermission(AdminPermission.SEO_READ)
  getCategoryContent(@Param('id') id: string) {
    return this.seo.getCategoryContent(id);
  }

  /** The body is validated field by field in the service (category-seo-content.ts). */
  @Patch('categories/:id/content')
  @RequiresPermission(AdminPermission.SEO_CONTENT_WRITE)
  updateCategoryContent(@Param('id') id: string, @Body() body: Record<string, unknown>, @CurrentUser() user: AuthUser) {
    return this.seo.updateCategoryContent(id, body, user);
  }

  @Get('redirects')
  @RequiresPermission(AdminPermission.SEO_READ)
  listRedirects(@Query() query: RedirectListQueryDto) {
    return this.seo.listRedirects(query);
  }

  @Get('redirects/:id')
  @RequiresPermission(AdminPermission.SEO_READ)
  getRedirect(@Param('id') id: string, @Query() query: AuditPageQueryDto, @CurrentUser() user: AuthUser) {
    return this.seo.getRedirect(id, query, user);
  }

  @Post('redirects')
  @RequiresPermission(AdminPermission.SEO_REDIRECTS_WRITE)
  createRedirect(@Body() dto: CreateRedirectDto, @CurrentUser() user: AuthUser) {
    return this.seo.createRedirect(dto, user);
  }

  @Patch('redirects/:id')
  @RequiresPermission(AdminPermission.SEO_REDIRECTS_WRITE)
  updateRedirect(@Param('id') id: string, @Body() dto: UpdateRedirectDto, @CurrentUser() user: AuthUser) {
    return this.seo.updateRedirect(id, dto, user);
  }

  @Post('redirects/:id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequiresPermission(AdminPermission.SEO_REDIRECTS_WRITE)
  deactivateRedirect(@Param('id') id: string, @Body() dto: DeactivateRedirectDto, @CurrentUser() user: AuthUser) {
    return this.seo.deactivateRedirect(id, dto, user);
  }

  @Get('not-found')
  @RequiresPermission(AdminPermission.SEO_READ)
  listSuggestions(@Query() query: NotFoundListQueryDto) {
    return this.seo.listSuggestions(query);
  }

  @Post('not-found/:id/approve')
  @HttpCode(HttpStatus.OK)
  @RequiresPermission(AdminPermission.SEO_REDIRECTS_WRITE)
  approveSuggestion(@Param('id') id: string, @Body() dto: ApproveSuggestionDto, @CurrentUser() user: AuthUser) {
    return this.seo.approveSuggestion(id, dto, user);
  }

  @Post('not-found/:id/reject')
  @HttpCode(HttpStatus.OK)
  @RequiresPermission(AdminPermission.SEO_REDIRECTS_WRITE)
  rejectSuggestion(@Param('id') id: string, @Body() dto: RejectSuggestionDto, @CurrentUser() user: AuthUser) {
    return this.seo.rejectSuggestion(id, dto, user);
  }
}
