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
  Req,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthGuard, OptionalAuthGuard } from '../auth/auth.guard';
import {
  assertElevatedQueryAccess,
  type CredentialCarryingRequest,
} from '../auth/elevated-query';
import { RolesGuard } from '../auth/roles.guard';
import { AuthUser } from '../auth/auth.types';
import { CategoriesService, type CategoryViewOptions } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { ResolveRoutingDto } from './dto/resolve-routing.dto';
import {
  resolveRequestedStatus,
  UpdateCategoryStatusDto,
} from './dto/update-category-status.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

@Controller('categories')
export class CategoriesController {
  constructor(@Inject(CategoriesService) private readonly categoriesService: CategoriesService) {}

  /**
   * The catalogue, in one of its two views.
   *
   * Optionally authenticated rather than guarded: signed out this is the public
   * listing and has to stay reachable. `includeInactive=true` asks for the
   * operator's view instead, and {@link resolveView} is where that request is
   * granted or refused — before the service is called, on the session rather
   * than on anything the caller can write into the URL.
   */
  @Get()
  @UseGuards(OptionalAuthGuard)
  listCategories(
    @Req() request: CredentialCarryingRequest,
    @CurrentUser() user: AuthUser | null,
    @Query('includeInactive') includeInactive?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    return this.categoriesService.listCategories({
      ...this.resolveView(request, user, includeInactive),
      q,
      limit: limit ? Number(limit) : undefined,
    });
  }

  /**
   * Resolves a routed flow.
   *
   * Optionally authenticated for the same reason request creation is: a signed
   * in SUPER_ADMIN may walk a DRAFT category to check its wiring, and everybody
   * else gets the public answer. It is a POST because the selections are a
   * structured body, not because it writes — nothing here changes a row.
   */
  @Post('routing/resolve')
  @UseGuards(OptionalAuthGuard)
  async resolveRouting(@Body() dto: ResolveRoutingDto, @CurrentUser() user: AuthUser | null) {
    const resolution = await this.categoriesService.resolveRouting(
      dto,
      user?.role === UserRole.SUPER_ADMIN,
    );

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

  /** Same two views, same gate, one category. */
  @Get(':slug')
  @UseGuards(OptionalAuthGuard)
  getCategoryBySlug(
    @Param('slug') slug: string,
    @Req() request: CredentialCarryingRequest,
    @CurrentUser() user: AuthUser | null,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.categoriesService.getCategoryBySlug(
      slug,
      this.resolveView(request, user, includeInactive),
    );
  }

  @Post()
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  createCategory(@Body() dto: CreateCategoryDto) {
    return this.categoriesService.createCategory(dto);
  }

  @Patch(':id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  updateCategory(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.categoriesService.updateCategory(id, dto);
  }

  @Patch(':id/status')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  updateCategoryStatus(@Param('id') id: string, @Body() dto: UpdateCategoryStatusDto) {
    const status = resolveRequestedStatus(dto);

    if (status === undefined) {
      throw new BadRequestException('status veya isActive alanlarından biri gereklidir');
    }

    return this.categoriesService.updateCategoryStatus(id, status);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  deleteCategory(@Param('id') id: string) {
    return this.categoriesService.deleteCategory(id);
  }

  /**
   * Reads `includeInactive` and decides, once, who is allowed to mean it.
   *
   * A caller who does not ask for the wide view is never challenged — that is
   * the whole public catalogue and it must not require a session. A caller who
   * does is held to SUPER_ADMIN here, and the refusal distinguishes a credential
   * that could not be resolved (401) from one that simply is not an operator's
   * (403). See assertElevatedQueryAccess.
   */
  private resolveView(
    request: CredentialCarryingRequest,
    user: AuthUser | null,
    includeInactive: string | undefined,
  ): CategoryViewOptions {
    if (includeInactive !== 'true') {
      return { includeInactive: false, isSuperAdmin: user?.role === UserRole.SUPER_ADMIN };
    }

    assertElevatedQueryAccess(request, user);

    return { includeInactive: true, isSuperAdmin: true };
  }
}
