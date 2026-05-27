import { Body, Controller, Get, Inject, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryStatusDto } from './dto/update-category-status.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

@Controller('categories')
export class CategoriesController {
  constructor(@Inject(CategoriesService) private readonly categoriesService: CategoriesService) {}

  @Get()
  listCategories(
    @Query('includeInactive') includeInactive?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    return this.categoriesService.listCategories(includeInactive === 'true', {
      q,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get(':slug')
  getCategoryBySlug(@Param('slug') slug: string, @Query('includeInactive') includeInactive?: string) {
    return this.categoriesService.getCategoryBySlug(slug, includeInactive === 'true');
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
    return this.categoriesService.updateCategoryStatus(id, dto.isActive);
  }
}
