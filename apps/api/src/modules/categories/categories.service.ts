import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

@Injectable()
export class CategoriesService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  listCategories(includeInactive: boolean) {
    return this.prisma.serviceCategory.findMany({
      where: includeInactive ? undefined : { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        _count: {
          select: { questions: true },
        },
      },
    });
  }

  async getCategoryBySlug(slug: string) {
    const category = await this.prisma.serviceCategory.findUnique({
      where: { slug },
      include: {
        questions: {
          where: { isActive: true },
          orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
        },
      },
    });

    if (!category) {
      throw new NotFoundException('Category not found');
    }

    return category;
  }

  async createCategory(dto: CreateCategoryDto) {
    try {
      return await this.prisma.serviceCategory.create({
        data: {
          name: dto.name.trim(),
          slug: dto.slug,
          description: normalizeNullableString(dto.description),
          parentId: normalizeNullableString(dto.parentId),
          isActive: dto.isActive ?? true,
          sortOrder: dto.sortOrder ?? 0,
        },
      });
    } catch (error) {
      handleCategoryWriteError(error);
    }
  }

  async updateCategory(id: string, dto: UpdateCategoryDto) {
    await this.ensureCategoryExists(id);

    try {
      return await this.prisma.serviceCategory.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.slug !== undefined ? { slug: dto.slug } : {}),
          ...(dto.description !== undefined
            ? { description: normalizeNullableString(dto.description) }
            : {}),
          ...(dto.parentId !== undefined ? { parentId: normalizeNullableString(dto.parentId) } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        },
      });
    } catch (error) {
      handleCategoryWriteError(error);
    }
  }

  async updateCategoryStatus(id: string, isActive: boolean) {
    await this.ensureCategoryExists(id);

    return this.prisma.serviceCategory.update({
      where: { id },
      data: { isActive },
    });
  }

  private async ensureCategoryExists(id: string) {
    const category = await this.prisma.serviceCategory.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!category) {
      throw new NotFoundException('Category not found');
    }
  }
}

function normalizeNullableString(value: string | null | undefined) {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function handleCategoryWriteError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      throw new ConflictException('Category slug already exists');
    }

    if (error.code === 'P2003') {
      throw new BadRequestException('Parent category does not exist');
    }
  }

  throw error;
}
