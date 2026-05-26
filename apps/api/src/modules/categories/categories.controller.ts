import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryStatusDto } from './dto/update-category-status.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

@Controller('categories')
export class CategoriesController {
  constructor(@Inject(CategoriesService) private readonly categoriesService: CategoriesService) {}

  @Get()
  listCategories(@Query('includeInactive') includeInactive?: string) {
    return this.categoriesService.listCategories(includeInactive === 'true');
  }

  @Get(':slug')
  getCategoryBySlug(@Param('slug') slug: string) {
    return this.categoriesService.getCategoryBySlug(slug);
  }

  @Post()
  createCategory(@Body() dto: CreateCategoryDto) {
    return this.categoriesService.createCategory(dto);
  }

  @Patch(':id')
  updateCategory(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.categoriesService.updateCategory(id, dto);
  }

  @Patch(':id/status')
  updateCategoryStatus(@Param('id') id: string, @Body() dto: UpdateCategoryStatusDto) {
    return this.categoriesService.updateCategoryStatus(id, dto.isActive);
  }
}
