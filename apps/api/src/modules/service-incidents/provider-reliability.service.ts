import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, ProviderReliabilityReviewStatus } from '@prisma/client';
import { runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import { SERVICE_ISSUE_REASON_LABELS } from '../service-issues/service-issue-eligibility';
import type { ListProviderReliabilityDto } from './dto/incident-dtos';
import { confirmedCountsByProvider, providerReliabilitySummary, unresolvedReview } from './incident-reliability';
import { reviewNotFound, serviceIncidentErrors } from './service-incident.errors';
import {
  normalizeIncidentText,
  RATIONALE_MAX_LENGTH,
  RATIONALE_MIN_LENGTH,
  RELIABILITY_WARNING_AT,
  reliabilityLevel,
  responseDueAt,
  windowStart,
} from './service-incident-policy';

const DEFAULT_PAGE_SIZE = 25;
const TIMELINE_LIMIT = 100;

const REVIEW_SELECT = {
  id: true,
  providerId: true,
  status: true,
  openedAt: true,
  openedBySystem: true,
  acknowledgedAt: true,
  resolvedAt: true,
  note: true,
  triggerIncident: { select: { id: true, incidentNumber: true } },
  acknowledgedBy: { select: { id: true, name: true } },
  resolvedBy: { select: { id: true, name: true } },
} satisfies Prisma.ProviderReliabilityReviewSelect;

/**
 * REL-002 Faz 4 — the staff view of provider reliability. Every level is
 * computed on read from the effective decisions in the last 90 days; a review
 * row is the staff workflow only (acknowledge, resolve with a note) and never
 * a suspension. Internal: nothing here reaches a customer or a public page.
 */
@Injectable()
export class ProviderReliabilityService {
  private readonly logger = new Logger(ProviderReliabilityService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** The provider detail page's "Güvenilirlik" card and its timelines. */
  async forProvider(providerId: string) {
    const now = new Date();
    const provider = await this.prisma.providerProfile.findUnique({
      where: { id: providerId },
      select: { id: true, businessName: true, status: true },
    });
    if (!provider) {
      throw new NotFoundException('Provider not found');
    }
    const [summary, openReview, incidents, reviews] = await Promise.all([
      providerReliabilitySummary(this.prisma, providerId, now),
      unresolvedReview(this.prisma, providerId),
      this.prisma.providerServiceIncident.findMany({
        where: { providerId },
        orderBy: [{ reportedAt: 'desc' }, { id: 'desc' }],
        take: TIMELINE_LIMIT,
        select: {
          id: true,
          incidentNumber: true,
          status: true,
          reason: true,
          reportedAt: true,
          providerRespondedAt: true,
          round: { select: { roundNumber: true } },
          request: { select: { id: true, requestNumber: true } },
          adjudications: {
            orderBy: { sequence: 'asc' },
            select: { id: true, sequence: true, kind: true, decision: true, createdAt: true },
          },
          effectiveAdjudicationId: true,
        },
      }),
      this.prisma.providerReliabilityReview.findMany({
        where: { providerId },
        orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
        select: REVIEW_SELECT,
      }),
    ]);
    const since = windowStart(now);
    return {
      provider,
      summary: { ...summary, openReview },
      incidents: incidents.map((incident) => ({
        id: incident.id,
        incidentNumber: incident.incidentNumber,
        status: incident.status,
        reason: incident.reason,
        reasonLabel: SERVICE_ISSUE_REASON_LABELS[incident.reason],
        reportedAt: incident.reportedAt,
        inWindow: incident.reportedAt >= since,
        responseDueAt: responseDueAt(incident.reportedAt),
        respondedAt: incident.providerRespondedAt,
        roundNumber: incident.round.roundNumber,
        request: incident.request,
        adjudications: incident.adjudications.map((a) => ({ ...a, effective: a.id === incident.effectiveAdjudicationId })),
      })),
      reviews,
    };
  }

  /**
   * The reliability queue: providers at WARNING or above now, and providers
   * with an unresolved review whatever their level now (a correction may have
   * lowered it; the review stays for staff). Highest count first.
   */
  async queue(query: ListProviderReliabilityDto) {
    const now = new Date();
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const counts = await confirmedCountsByProvider(this.prisma, now, { atLeast: RELIABILITY_WARNING_AT });
    const reviews = await this.prisma.providerReliabilityReview.findMany({
      where: { status: { in: [ProviderReliabilityReviewStatus.OPEN, ProviderReliabilityReviewStatus.ACKNOWLEDGED] } },
      select: REVIEW_SELECT,
    });
    const reviewByProvider = new Map(reviews.map((review) => [review.providerId, review]));

    let ids = [...new Set([...counts.keys(), ...reviewByProvider.keys()])];
    if (query.filter === 'WARNING' || query.filter === 'ADMIN_REVIEW_REQUIRED') {
      ids = ids.filter((id) => reliabilityLevel(counts.get(id) ?? 0) === query.filter);
    } else if (query.filter === 'review') {
      ids = ids.filter((id) => reviewByProvider.has(id));
    }
    ids.sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b));
    const total = ids.length;
    const pageIds = ids.slice((page - 1) * pageSize, page * pageSize);
    const providers = await this.prisma.providerProfile.findMany({
      where: { id: { in: pageIds } },
      select: { id: true, businessName: true, status: true },
    });
    const byId = new Map(providers.map((provider) => [provider.id, provider]));

    return {
      items: pageIds.map((id) => {
        const confirmed = counts.get(id) ?? 0;
        return {
          provider: byId.get(id) ?? { id, businessName: null, status: null },
          confirmed90d: confirmed,
          level: reliabilityLevel(confirmed),
          review: reviewByProvider.get(id) ?? null,
        };
      }),
      total,
      page,
      pageSize,
      hasNextPage: page * pageSize < total,
    };
  }

  async acknowledge(reviewId: string, admin: AuthUser) {
    return runSerializable(
      this.prisma,
      async (tx) => {
        const review = await tx.providerReliabilityReview.findUnique({ where: { id: reviewId }, select: { status: true } });
        if (!review) throw reviewNotFound();
        if (review.status === ProviderReliabilityReviewStatus.RESOLVED) throw serviceIncidentErrors.reviewAlreadyResolved();
        if (review.status === ProviderReliabilityReviewStatus.ACKNOWLEDGED) throw serviceIncidentErrors.reviewAlreadyAcknowledged();
        const now = new Date();
        const moved = await tx.providerReliabilityReview.updateMany({
          where: { id: reviewId, status: ProviderReliabilityReviewStatus.OPEN },
          data: {
            status: ProviderReliabilityReviewStatus.ACKNOWLEDGED,
            acknowledgedAt: now,
            acknowledgedById: admin.id,
            assignedAdminId: admin.id,
          },
        });
        if (moved.count !== 1) throw serviceIncidentErrors.reviewAlreadyAcknowledged();
        this.logger.log(`reliability review ${reviewId} acknowledged by ${admin.id}`);
        return tx.providerReliabilityReview.findUniqueOrThrow({ where: { id: reviewId }, select: REVIEW_SELECT });
      },
      { label: 'providerReliability.acknowledge' },
    );
  }

  /** Closes the review with the staff member's note. Changes nothing about the provider's account. */
  async resolve(reviewId: string, admin: AuthUser, noteInput: string) {
    const note = normalizeIncidentText(noteInput);
    if (note === null || note.length < RATIONALE_MIN_LENGTH) {
      throw serviceIncidentErrors.rationaleRequired(RATIONALE_MIN_LENGTH, 'note');
    }
    if (note.length > RATIONALE_MAX_LENGTH) {
      throw serviceIncidentErrors.rationaleTooLong(RATIONALE_MAX_LENGTH, 'note');
    }
    return runSerializable(
      this.prisma,
      async (tx) => {
        const review = await tx.providerReliabilityReview.findUnique({ where: { id: reviewId }, select: { status: true } });
        if (!review) throw reviewNotFound();
        if (review.status === ProviderReliabilityReviewStatus.RESOLVED) throw serviceIncidentErrors.reviewAlreadyResolved();
        const now = new Date();
        const moved = await tx.providerReliabilityReview.updateMany({
          where: { id: reviewId, status: review.status },
          data: { status: ProviderReliabilityReviewStatus.RESOLVED, resolvedAt: now, resolvedById: admin.id, note },
        });
        if (moved.count !== 1) throw serviceIncidentErrors.reviewAlreadyResolved();
        this.logger.log(`reliability review ${reviewId} resolved by ${admin.id}`);
        return tx.providerReliabilityReview.findUniqueOrThrow({ where: { id: reviewId }, select: REVIEW_SELECT });
      },
      { label: 'providerReliability.resolve' },
    );
  }
}
