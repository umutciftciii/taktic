import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describeArea } from '../../common/provider-service-area-scope';
import { PrismaService } from '../../prisma/prisma.service';
import { showcasePlacementNotFound } from './showcase.errors';

/**
 * Reading placements — for the business that bought them and for the operator
 * who oversees them.
 *
 * Split from `ShowcasePlacementService`, which writes, for the reason the
 * showcase module already splits provider from admin: every method here is a
 * projection decision, and mixing them with the lifecycle transitions would put
 * "what may this audience see" next to "what happens when a category closes"
 * where neither is easy to check.
 *
 * ## What each audience is told
 *
 * The provider sees everything about their own run: what it cost, when it ends,
 * how much time suspensions gave back, and why it is off the air if it is. It
 * is their money and their card.
 *
 * The operator sees the same plus the business behind it — and **not** the
 * payment correlation token, which no projection in this codebase carries (see
 * `packagePurchaseOmit`).
 */
@Injectable()
export class ShowcasePlacementReadService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async listForProvider(providerId: string) {
    const placements = await this.prisma.showcasePlacement.findMany({
      where: { providerId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: placementSelect,
    });

    return { placements: placements.map(toPlacement) };
  }

  async getForProvider(providerId: string, placementId: string) {
    const placement = await this.prisma.showcasePlacement.findFirst({
      // The provider id is in the `where` rather than checked afterwards: this
      // is the same 404 discipline a card gets, and for the same reason —
      // another business's run is a fact about their commercial position.
      where: { id: placementId, providerId },
      select: { ...placementSelect, suspensions: suspensionSelect },
    });

    if (!placement) {
      throw showcasePlacementNotFound();
    }

    return toPlacementDetail(placement);
  }

  async listForAdmin(filters: {
    status?: string;
    providerId?: string;
    categoryId?: string;
  }) {
    const placements = await this.prisma.showcasePlacement.findMany({
      where: {
        ...(filters.status ? { status: filters.status as never } : {}),
        ...(filters.providerId ? { providerId: filters.providerId } : {}),
        ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { ...placementSelect, provider: providerSelect },
    });

    return {
      placements: placements.map((placement) => ({
        ...toPlacement(placement),
        provider: placement.provider,
      })),
    };
  }

  async getForAdmin(placementId: string) {
    const placement = await this.prisma.showcasePlacement.findUnique({
      where: { id: placementId },
      select: {
        ...placementSelect,
        provider: providerSelect,
        suspensions: suspensionSelect,
        versionChanges: {
          orderBy: [{ createdAt: 'desc' }],
          select: {
            id: true,
            fromVersionId: true,
            toVersionId: true,
            trigger: true,
            createdAt: true,
          },
        },
      },
    });

    if (!placement) {
      throw showcasePlacementNotFound();
    }

    return {
      ...toPlacementDetail(placement),
      provider: placement.provider,
      versionChanges: placement.versionChanges,
    };
  }
}

const placementSelect = {
  id: true,
  status: true,
  cardId: true,
  pinnedVersionId: true,
  categoryId: true,
  kindSnapshot: true,
  packageNameSnapshot: true,
  priceAmountSnapshot: true,
  currencySnapshot: true,
  durationDaysSnapshot: true,
  startAt: true,
  endAt: true,
  suspendedAt: true,
  suspendReason: true,
  totalExtendedMs: true,
  cancelledAt: true,
  createdAt: true,
  category: { select: { id: true, name: true, slug: true } },
  pinnedVersion: { select: { id: true, versionNumber: true, title: true } },
  shelves: {
    orderBy: [{ city: 'asc' }, { district: 'asc' }, { neighborhood: 'asc' }],
    select: {
      id: true,
      areaKey: true,
      scope: true,
      city: true,
      district: true,
      neighborhood: true,
      active: true,
    },
  },
  _count: { select: { leads: true } },
} satisfies Prisma.ShowcasePlacementSelect;

const providerSelect = {
  select: { id: true, businessName: true, city: true, district: true, status: true },
} satisfies Prisma.ShowcasePlacementSelect['provider'];

/**
 * The suspension history, and the one column that makes it readable.
 *
 * `extendsClock` travels because without it "the card was down for three days"
 * and "the run was extended by three days" look like the same row. It is the
 * snapshot taken when the suspension opened, never a fresh reading of the
 * policy — see `showcase-placement-suspension.ts`.
 */
const suspensionSelect = {
  orderBy: [{ startedAt: 'desc' }],
  select: {
    id: true,
    reason: true,
    extendsClock: true,
    startedAt: true,
    endedAt: true,
    endAtBefore: true,
    endAtAfter: true,
    note: true,
    actor: { select: { id: true, name: true } },
  },
} satisfies Prisma.ShowcasePlacementSelect['suspensions'];

type PlacementRow = Prisma.ShowcasePlacementGetPayload<{ select: typeof placementSelect }>;

function toPlacement(placement: PlacementRow) {
  return {
    id: placement.id,
    status: placement.status,
    cardId: placement.cardId,
    kind: placement.kindSnapshot,
    category: placement.category,
    version: placement.pinnedVersion,
    packageName: placement.packageNameSnapshot,
    priceAmount: placement.priceAmountSnapshot,
    currency: placement.currencySnapshot,
    durationDays: placement.durationDaysSnapshot,
    startAt: placement.startAt,
    endAt: placement.endAt,
    suspendedAt: placement.suspendedAt,
    suspendReason: placement.suspendReason,
    // Exposed in whole days rather than milliseconds, because the number a
    // provider reads is "you got three days back" and computing that in three
    // screens is three places it can be computed differently.
    extendedDays: Math.round(placement.totalExtendedMs / (24 * 60 * 60 * 1000)),
    cancelledAt: placement.cancelledAt,
    createdAt: placement.createdAt,
    leadCount: placement._count.leads,
    areas: placement.shelves.map((shelf) => ({
      id: shelf.id,
      scope: shelf.scope,
      active: shelf.active,
      label: describeArea({
        city: shelf.city,
        district: shelf.district,
        neighborhood: shelf.neighborhood,
      }),
    })),
  };
}

function toPlacementDetail<T extends PlacementRow & { suspensions: unknown }>(placement: T) {
  return { ...toPlacement(placement), suspensions: placement.suspensions };
}
