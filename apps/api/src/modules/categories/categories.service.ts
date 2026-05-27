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

  listCategories(includeInactive: boolean, options?: { q?: string; limit?: number }) {
    const q = options?.q?.trim();
    const limit =
      options?.limit !== undefined && Number.isFinite(options.limit) && options.limit > 0
        ? Math.min(Math.floor(options.limit), 100)
        : undefined;

    const where: Prisma.ServiceCategoryWhereInput = {
      ...(includeInactive ? {} : { isActive: true }),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { slug: { contains: q.toLowerCase(), mode: 'insensitive' } },
              { description: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    return this.prisma.serviceCategory.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      take: limit,
      include: {
        _count: {
          select: { questions: true },
        },
      },
    });
  }

  async getCategoryBySlug(slug: string, includeInactive: boolean) {
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

    if (!includeInactive && !category.isActive) {
      throw new NotFoundException('Category not found');
    }

    return category;
  }

  async createCategory(dto: CreateCategoryDto) {
    try {
      return await this.prisma.serviceCategory.create({
        data: {
          name: normalizeRequiredString(dto.name, 'Category name'),
          slug: normalizeSlug(dto.slug),
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
          ...(dto.name !== undefined ? { name: normalizeRequiredString(dto.name, 'Category name') } : {}),
          ...(dto.slug !== undefined ? { slug: normalizeSlug(dto.slug) } : {}),
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

function normalizeRequiredString(value: string, fieldName: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new BadRequestException(`${fieldName} cannot be empty`);
  }

  return trimmed;
}

function normalizeSlug(value: string) {
  const slug = normalizeRequiredString(value, 'Category slug');

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new BadRequestException('Category slug must be lowercase and URL-safe');
  }

  return slug;
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
