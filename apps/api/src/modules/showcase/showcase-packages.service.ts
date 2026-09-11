import { ConflictException, HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ShowcaseCardKind } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateShowcasePackageDto,
  UpdateShowcasePackageDto,
} from './dto/showcase-package.dto';
import { SHOWCASE_PACKAGE_SLUG_PREFIX } from './showcase.constants';
import { showcasePackageSlugInvalid } from './showcase.errors';

/**
 * The vitrin catalogue: what an operator sells and what a provider may buy.
 *
 * ## Why this is a separate catalogue from `OfferCreditPackage`
 *
 * Not because the two are unlike as products — both are "a provider pays and
 * gets something for a while" — but because of what reads them. `OfferPackageType`
 * is on the offer hot path: `entitlement-resolver.service.ts` switches on it to
 * decide what pays for an offer, and `assertPackageIsPurchasable`,
 * `grantEntitlementForPurchase` and `isPeriodPackageType` all branch on it too.
 * A vitrin package is never an offering right, so every one of those switches
 * would need a "not this one" arm — and a single missed arm is a vitrin
 * purchase quietly handing out offer capacity.
 *
 * The money rail stays shared. See `PackagePurchase`.
 *
 * ## What changing a package does, and does not do
 *
 * Price, duration, area cap and card-kind restriction may all be edited and
 * affect only **later** purchases. Every purchase snapshots what it was sold
 * under, and every placement snapshots it again, so nothing already paid for
 * reads this table back. That is the same contract `OfferCreditPackage` and
 * `ProviderPackageEntitlement` already hold.
 *
 * The slug is the exception: it cannot be edited at all. It is the key into the
 * payment provider's variant map, so renaming one detaches every future
 * checkout from the variant it was mapped to — and the failure surfaces as a
 * customer who paid and got a `VARIANT_MISMATCH`. Retiring a package and
 * creating its replacement is the shape that keeps the old rows readable.
 */
@Injectable()
export class ShowcasePackagesService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * The catalogue as a provider sees it, narrowed to what they could actually
   * buy right now.
   *
   * `cardKind` is optional and filters to packages sold for that kind — the
   * buying screen passes the kind of the card the provider is standing on, so
   * they are not offered a package the checkout would then refuse.
   */
  async listForProvider(cardKind?: ShowcaseCardKind) {
    const packages = await this.prisma.showcasePackage.findMany({
      where: {
        isActive: true,
        ...(cardKind ? { OR: [{ allowedCardKind: null }, { allowedCardKind: cardKind }] } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: providerPackageSelect,
    });

    return { packages };
  }

  /**
   * The operator's list, including retired packages.
   *
   * Inactive rows are shown rather than hidden: a package with live placements
   * behind it is something an operator has to be able to find, and "it
   * disappeared from the screen when I unticked it" is how a catalogue loses
   * its own history.
   */
  async listForAdmin() {
    const packages = await this.prisma.showcasePackage.findMany({
      orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      select: adminPackageSelect,
    });

    return { packages };
  }

  async getForAdmin(id: string) {
    const pkg = await this.prisma.showcasePackage.findUnique({
      where: { id },
      select: adminPackageSelect,
    });

    if (!pkg) {
      throw showcasePackageNotFoundForAdmin();
    }

    return pkg;
  }

  async create(dto: CreateShowcasePackageDto) {
    const slug = dto.slug.trim();

    // The DTO's pattern already covers this; checked again because the pattern
    // is one regex away from being loosened, and the sentence a person reads
    // should explain *why* the prefix exists rather than restate the regex.
    if (!slug.startsWith(SHOWCASE_PACKAGE_SLUG_PREFIX)) {
      throw showcasePackageSlugInvalid();
    }

    try {
      return await this.prisma.showcasePackage.create({
        data: {
          name: dto.name.trim(),
          slug,
          priceAmount: dto.priceAmount,
          durationDays: dto.durationDays,
          allowedCardKind: dto.allowedCardKind ?? null,
          maxAreas: dto.maxAreas ?? null,
          description: normalizeOptional(dto.description),
          isActive: dto.isActive ?? true,
          sortOrder: dto.sortOrder ?? 0,
          activationWindowDays: dto.activationWindowDays ?? 90,
        },
        select: adminPackageSelect,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({
          statusCode: HttpStatus.CONFLICT,
          error: 'Conflict',
          code: 'SHOWCASE_PACKAGE_SLUG_TAKEN',
          message: 'Bu kısa ad başka bir vitrin paketinde kullanılıyor.',
        });
      }

      throw error;
    }
  }

  /**
   * An edit, which never touches the slug and never reaches a purchase.
   *
   * Only the fields actually present in the body are written. A `PATCH` that
   * omits `maxAreas` leaves it as it was; a `PATCH` that sends `null` clears
   * it — the two are genuinely different requests and the projection has to
   * keep them apart, which is why `undefined` is filtered out rather than
   * coalesced.
   */
  async update(id: string, dto: UpdateShowcasePackageDto) {
    await this.getForAdmin(id);

    return this.prisma.showcasePackage.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.priceAmount !== undefined ? { priceAmount: dto.priceAmount } : {}),
        ...(dto.durationDays !== undefined ? { durationDays: dto.durationDays } : {}),
        ...(dto.allowedCardKind !== undefined ? { allowedCardKind: dto.allowedCardKind } : {}),
        ...(dto.maxAreas !== undefined ? { maxAreas: dto.maxAreas } : {}),
        ...(dto.description !== undefined
          ? { description: normalizeOptional(dto.description) }
          : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        ...(dto.activationWindowDays !== undefined
          ? { activationWindowDays: dto.activationWindowDays }
          : {}),
      },
      select: adminPackageSelect,
    });
  }
}

/**
 * What a provider is shown about a package.
 *
 * `requiresAdminApproval` travels because the buying screen has to be able to
 * say "this one is reviewed before it goes live" the day a package sets it. It
 * ships false everywhere today.
 */
const providerPackageSelect = {
  id: true,
  name: true,
  slug: true,
  priceAmount: true,
  currency: true,
  durationDays: true,
  allowedCardKind: true,
  maxAreas: true,
  requiresAdminApproval: true,
  description: true,
  sortOrder: true,
  activationWindowDays: true,
} satisfies Prisma.ShowcasePackageSelect;

const adminPackageSelect = {
  ...providerPackageSelect,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ShowcasePackageSelect;

export type ShowcasePackageProjection = Prisma.ShowcasePackageGetPayload<{
  select: typeof providerPackageSelect;
}>;

function showcasePackageNotFoundForAdmin() {
  return new NotFoundException({
    statusCode: HttpStatus.NOT_FOUND,
    error: 'Not Found',
    code: 'SHOWCASE_PACKAGE_NOT_FOUND',
    message: 'Vitrin paketi bulunamadı.',
  });
}

function normalizeOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
