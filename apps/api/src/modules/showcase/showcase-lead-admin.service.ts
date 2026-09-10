import { Inject, Injectable } from '@nestjs/common';
import { Prisma, ShowcaseLeadStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { showcaseLeadNotFound } from './showcase.errors';

/**
 * Direct leads, for the operator.
 *
 * Read-only, and that is the whole surface. An operator's power over a lead is
 * exercised through the request it belongs to — refusing the request closes the
 * lead in the same transaction — rather than through an endpoint that could
 * close a lead while leaving the request open, or release one on a customer's
 * behalf.
 *
 * That second omission is deliberate and load-bearing. Releasing a lead to the
 * market is the customer's decision and only theirs; the database refuses a
 * `releasedAt` without their RELEASE on the same row, and an admin route that
 * bypassed that would make the constraint decorative.
 *
 * ## What the projection carries
 *
 * The customer's own contact details are **not** selected, exactly as they are
 * not on the provider's inbox. The reveal path is `ContactRevealEvent`, and an
 * operator reading a queue has no more need of a telephone number than a
 * provider does.
 */
@Injectable()
export class ShowcaseLeadAdminService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(filters: { status?: ShowcaseLeadStatus; providerId?: string }) {
    const leads = await this.prisma.showcaseLead.findMany({
      where: {
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.providerId ? { providerId: filters.providerId } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 200,
      select: adminLeadSelect,
    });

    return { leads };
  }

  async get(leadId: string) {
    const lead = await this.prisma.showcaseLead.findUnique({
      where: { id: leadId },
      select: {
        ...adminLeadSelect,
        placement: {
          select: { id: true, status: true, startAt: true, endAt: true, packageNameSnapshot: true },
        },
      },
    });

    if (!lead) {
      throw showcaseLeadNotFound();
    }

    return lead;
  }
}

const adminLeadSelect = {
  id: true,
  status: true,
  urgencyBucket: true,
  slaHoursSnapshot: true,
  slaDueAt: true,
  breachedAt: true,
  fallbackAskedAt: true,
  fallbackDecision: true,
  fallbackDecidedAt: true,
  releasedAt: true,
  closedAt: true,
  closeReason: true,
  respondedAt: true,
  createdAt: true,
  kindSnapshot: true,
  listedPriceSnapshot: true,
  cardId: true,
  cardVersion: { select: { id: true, versionNumber: true, title: true } },
  provider: { select: { id: true, businessName: true, status: true } },
  request: {
    select: {
      id: true,
      requestNumber: true,
      status: true,
      qualityScore: true,
      city: true,
      district: true,
      directShowcaseProviderId: true,
      category: { select: { id: true, name: true, slug: true } },
      submittedAt: true,
    },
  },
} satisfies Prisma.ShowcaseLeadSelect;
