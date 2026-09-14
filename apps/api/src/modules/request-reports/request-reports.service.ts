import { ConflictException, HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  ServiceRequestReportReason,
  ServiceRequestReportResolution,
  ServiceRequestStatus,
} from '@prisma/client';
import { runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import { TransactionalMailService } from '../notifications/transactional-mail.service';
import { ProvidersService } from '../providers/providers.service';
import { ServiceRequestsService } from '../service-requests/service-requests.service';
import { CreateRequestReportDto } from './dto/create-request-report.dto';
import { ResolveRequestReportsDto } from './dto/resolve-request-reports.dto';
import { rejectionReasonForRemoval } from './request-report-copy';
import {
  REPORT_ALREADY_EXISTS_CODE, REPORT_MAX_PER_PROVIDER_PER_DAY, REPORT_RATE_LIMITED_CODE,
} from './request-reports.constants';

const DAY_MS = 24 * 60 * 60 * 1000;

export const NO_OPEN_REPORTS_CODE = 'NO_OPEN_REPORTS';

/** How much of a request's description the queue shows on a row. */
const QUEUE_EXCERPT_LENGTH = 160;

const QUEUE_DEFAULT_LIMIT = 50;
const QUEUE_MAX_LIMIT = 100;

export type ReportQueueState = 'open' | 'resolved';

@Injectable()
export class RequestReportsService {
  private readonly logger = new Logger(RequestReportsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ProvidersService) private readonly providers: ProvidersService,
    @Inject(ServiceRequestsService) private readonly requests: ServiceRequestsService,
    @Inject(TransactionalMailService) private readonly mail: TransactionalMailService,
  ) {}

  /**
   * A provider may report exactly what they may see — the same predicate the
   * discovery screen and the offer path apply, so a report can never confirm
   * the existence of a request the caller was not shown.
   */
  async createForProvider(providerId: string, requestId: string, dto: CreateRequestReportDto) {
    await this.providers.ensureProviderCanSeeRequest(providerId, requestId);

    const since = new Date(Date.now() - DAY_MS);
    const today = await this.prisma.serviceRequestReport.count({
      where: { reporterProviderId: providerId, createdAt: { gte: since } },
    });
    if (today >= REPORT_MAX_PER_PROVIDER_PER_DAY) {
      throw new HttpException(
        { statusCode: HttpStatus.TOO_MANY_REQUESTS, error: 'Too Many Requests', code: REPORT_RATE_LIMITED_CODE, message: 'Günlük bildirim sınırına ulaştınız.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const note = dto.note?.trim() || null;
    let report: { id: string; reason: ServiceRequestReportReason; createdAt: Date };
    try {
      report = await this.prisma.serviceRequestReport.create({
        data: { requestId, reporterProviderId: providerId, reason: dto.reason, note },
        select: { id: true, reason: true, createdAt: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({
          statusCode: HttpStatus.CONFLICT, error: 'Conflict', code: REPORT_ALREADY_EXISTS_CODE,
          message: 'Bu talebi zaten bildirdiniz.',
        });
      }
      throw error;
    }

    // After the row exists: the support inbox hears about a report that is
    // really there, and a failed send cannot take the report with it.
    await this.notifySafely(() => this.mail.sendRequestReportNewForSupport(report.id), requestId);
    return report;
  }

  // ──────────────────────────────── admin ─────────────────────────────────

  /**
   * The queue, one row per request rather than one per report.
   *
   * Grouping is the point: three reports about one request are one decision,
   * and the endpoint that takes it closes all three. The page is keyed on the
   * request id and ordered by the first report in the requested state, so a
   * request stays where it entered the queue however many more reports it
   * collects. `groupBy` has no cursor of its own; the cursor row's own first
   * report time is read back and the page continues strictly after it, with
   * the request id breaking a tie on the same instant.
   */
  async listForAdmin(state: ReportQueueState, cursor: string | null, limit = QUEUE_DEFAULT_LIMIT) {
    const pageSize = Math.min(Math.max(1, Math.trunc(limit)), QUEUE_MAX_LIMIT);
    const inState: Prisma.ServiceRequestReportWhereInput =
      state === 'open' ? { resolvedAt: null } : { resolvedAt: { not: null } };

    const grouped = await this.prisma.serviceRequestReport.groupBy({
      by: ['requestId'],
      where: inState,
      _count: { _all: true },
      _min: { createdAt: true },
      having: await this.afterCursor(cursor, inState),
      orderBy: [{ _min: { createdAt: 'asc' } }, { requestId: 'asc' }],
      take: pageSize + 1,
    });

    const page = grouped.slice(0, pageSize);
    const requestIds = page.map((group) => group.requestId);
    if (requestIds.length === 0) {
      return { items: [], nextCursor: null };
    }

    const [requests, reports] = await Promise.all([
      this.prisma.serviceRequest.findMany({
        where: { id: { in: requestIds } },
        select: {
          id: true, requestNumber: true, status: true, city: true, district: true,
          description: true, submittedAt: true, category: { select: { name: true } },
        },
      }),
      // Every report of these requests, not only the ones in the requested
      // state: the last decision is a fact about the request, and a request
      // that is back in the open queue after a removal is still "reopened".
      this.prisma.serviceRequestReport.findMany({
        where: { requestId: { in: requestIds } },
        orderBy: { createdAt: 'asc' },
        select: {
          requestId: true, reason: true, resolvedAt: true, resolution: true,
          reporter: { select: { id: true, businessName: true } },
        },
      }),
    ]);
    const byRequest = new Map(requests.map((request) => [request.id, request]));

    return {
      items: page.map((group) => {
        const request = byRequest.get(group.requestId);
        if (!request) {
          // Reports restrict deletion of their request; unreachable, but a
          // silent hole in the page is worse than a loud one.
          throw new Error(`Request ${group.requestId} has reports but no row`);
        }
        const all = reports.filter((report) => report.requestId === group.requestId);
        const own = all.filter((report) =>
          state === 'open' ? report.resolvedAt === null : report.resolvedAt !== null,
        );
        const last =
          all
            .filter((report) => report.resolvedAt !== null)
            .sort((a, b) => b.resolvedAt!.getTime() - a.resolvedAt!.getTime())[0] ?? null;

        return {
          request: {
            id: request.id,
            requestNumber: request.requestNumber,
            status: request.status,
            categoryName: request.category.name,
            city: request.city,
            district: request.district,
            submittedAt: request.submittedAt,
            descriptionExcerpt: (request.description ?? '').slice(0, QUEUE_EXCERPT_LENGTH),
          },
          reportCount: group._count._all,
          reasons: [...new Set(own.map((report) => report.reason))],
          reporters: [...new Map(own.map((report) => [report.reporter.id, report.reporter])).values()],
          firstReportedAt: group._min.createdAt,
          lastResolution: last ? { resolution: last.resolution, resolvedAt: last.resolvedAt } : null,
          // Derived, never stored: a request a report took down that an
          // operator later put back. The reports keep their decision.
          reopened:
            last?.resolution === ServiceRequestReportResolution.REQUEST_REMOVED &&
            request.status !== ServiceRequestStatus.REJECTED,
        };
      }),
      nextCursor: grouped.length > pageSize ? page[page.length - 1]!.requestId : null,
    };
  }

  /**
   * The `having` clause that continues a page after the cursor request.
   *
   * An unknown cursor — a request whose reports all changed state since the
   * previous page was read — starts from the top rather than failing: the
   * operator is paging a live queue, and the row they were standing on may
   * legitimately have been decided by a colleague in the meantime.
   */
  private async afterCursor(
    cursor: string | null,
    inState: Prisma.ServiceRequestReportWhereInput,
  ): Promise<Prisma.ServiceRequestReportScalarWhereWithAggregatesInput | undefined> {
    if (!cursor) {
      return undefined;
    }
    const anchor = await this.prisma.serviceRequestReport.aggregate({
      where: { ...inState, requestId: cursor },
      _min: { createdAt: true },
    });
    const firstReportedAt = anchor._min.createdAt;
    if (!firstReportedAt) {
      return undefined;
    }
    return {
      OR: [
        { createdAt: { _min: { gt: firstReportedAt } } },
        { createdAt: { _min: { equals: firstReportedAt } }, requestId: { gt: cursor } },
      ],
    };
  }

  /** Every report of one request, open and decided, oldest first. Operator-only. */
  async listForRequest(requestId: string) {
    return this.prisma.serviceRequestReport.findMany({
      where: { requestId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, reason: true, note: true, createdAt: true, resolvedAt: true, resolution: true, resolutionNote: true,
        reporter: { select: { id: true, businessName: true } },
        resolvedBy: { select: { id: true, name: true } },
      },
    });
  }

  /**
   * The one decision about a request's reports, and everything it implies, in
   * one serializable transaction.
   *
   * Every open report closes with the same decision — a decision is about the
   * request, not about a reporter, and a row left open behind a removal would
   * be a queue entry nobody can act on. `REQUEST_REMOVED` then runs the same
   * cascade the moderation screen's "Reddet" runs (`rejectRequestInTransaction`:
   * status, vitrin lead, live offers, credits), inside the same transaction, so
   * a request that cannot be removed — MATCHED, already gone — leaves its
   * reports open and its offers untouched: the 409 is the whole outcome.
   *
   * What the customer is told is decided here too, and it is the removal
   * reason's fixed label and nothing else. The operator's note becomes the
   * request's `moderationNote`, an admin field; the reports' `resolutionNote`
   * is an admin field; the reporter is named nowhere the customer can see.
   */
  async resolve(requestId: string, dto: ResolveRequestReportsDto, adminUserId: string) {
    const now = new Date();
    const resolutionNote = dto.resolutionNote?.trim() || null;

    const outcome = await runSerializable(
      this.prisma,
      async (tx) => {
        const open = await tx.serviceRequestReport.count({ where: { requestId, resolvedAt: null } });
        if (open === 0) {
          throw new ConflictException({
            statusCode: HttpStatus.CONFLICT, error: 'Conflict', code: NO_OPEN_REPORTS_CODE,
            message: 'Bu talep için açık bildirim yok.',
          });
        }

        await tx.serviceRequestReport.updateMany({
          where: { requestId, resolvedAt: null },
          data: { resolvedAt: now, resolvedByUserId: adminUserId, resolution: dto.resolution, resolutionNote },
        });

        if (dto.resolution !== ServiceRequestReportResolution.REQUEST_REMOVED) {
          return { removed: false as const };
        }

        // The DTO makes the reason mandatory for a removal; the assertion is
        // what turns that promise into a type.
        const reason = dto.removalReason;
        if (!reason) {
          throw new ConflictException('A removal needs a reason');
        }
        await this.requests.rejectRequestInTransaction(tx, {
          requestId,
          rejectionReason: rejectionReasonForRemoval(reason),
          moderationNote: resolutionNote,
          actorUserId: adminUserId,
          now,
        });
        return { removed: true as const, reason };
      },
      { label: 'requestReports.resolve' },
    );

    if (outcome.removed) {
      await this.notifySafely(() => this.mail.sendRequestRemoved(requestId, now, outcome.reason), requestId);
    }
    return this.requests.getServiceRequest(requestId);
  }

  /**
   * Runs a notification and swallows whatever it throws — the same guard
   * `ServiceRequestsService.notify` is. Every caller is past its commit point,
   * and the mail service already records failures in NotificationLog.
   */
  private async notifySafely(run: () => Promise<unknown>, requestId: string) {
    try {
      await run();
    } catch (error) {
      this.logger.error(
        `Failed to send a notification for request ${requestId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
