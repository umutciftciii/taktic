import { Inject, Injectable } from '@nestjs/common';
import { Prisma, ProviderIncidentDecision, ProviderIncidentStatus } from '@prisma/client';
import { runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import { enqueueIncidentResponseNotice, ServiceIssueOutbox } from '../notifications/service-issue-outbox.service';
import { maskContactDetailsInNote } from '../service-issues/service-issue-eligibility';
import { incidentNotFound, incidentTriggerCode, SERVICE_INCIDENT_CODES, serviceIncidentErrors } from './service-incident.errors';
import {
  normalizeIncidentText,
  PROVIDER_OUTCOME_COPY,
  PROVIDER_RESPONSE_MAX_LENGTH,
  PROVIDER_RESPONSE_MIN_LENGTH,
  responseDueAt,
} from './service-incident-policy';

/**
 * Everything the failed provider may read about an incident — an explicit
 * allowlist. Never the customer's name, phone, e-mail or address (the request
 * row's contact columns are not selected at all), never the raw note (masked),
 * never the staff rationale or who decided, and nothing about the request's
 * new round or its new provider.
 */
const PROVIDER_INCIDENT_SELECT = {
  id: true,
  incidentNumber: true,
  offerId: true,
  reason: true,
  customerNote: true,
  reportedAt: true,
  promisedStartDate: true,
  promisedEndDate: true,
  status: true,
  providerResponse: true,
  providerRespondedAt: true,
  request: { select: { requestNumber: true, city: true, district: true, category: { select: { name: true } } } },
  effectiveAdjudication: { select: { decision: true, kind: true, createdAt: true } },
} satisfies Prisma.ProviderServiceIncidentSelect;

type ProviderIncidentRow = Prisma.ProviderServiceIncidentGetPayload<{ select: typeof PROVIDER_INCIDENT_SELECT }>;

export type ProviderIncidentView = {
  id: string;
  incidentNumber: string;
  offerId: string;
  status: ProviderIncidentStatus;
  reason: ProviderIncidentRow['reason'];
  reportedAt: Date;
  responseDueAt: Date;
  /** Undecided, unanswered and past the window. A signal, not a lock: the response stays open until a decision. */
  responseOverdue: boolean;
  canRespond: boolean;
  respondedAt: Date | null;
  request: { requestNumber: string | null; categoryName: string; city: string | null; district: string | null };
  outcome: { decision: ProviderIncidentDecision; decidedAt: Date; corrected: boolean; message: string } | null;
};

export type ProviderIncidentDetailView = ProviderIncidentView & {
  /** The customer's note with every contact detail masked. */
  customerNote: string | null;
  promisedStartDate: Date | null;
  promisedEndDate: Date | null;
  providerResponse: string | null;
};

const LIST_LIMIT = 100;

@Injectable()
export class ProviderIncidentsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ServiceIssueOutbox) private readonly notices: ServiceIssueOutbox,
  ) {}

  async list(providerId: string, state: 'open' | 'closed' | 'all' = 'all'): Promise<{ items: ProviderIncidentView[] }> {
    const where: Prisma.ProviderServiceIncidentWhereInput = { providerId };
    if (state === 'open') where.effectiveAdjudicationId = null;
    if (state === 'closed') where.effectiveAdjudicationId = { not: null };
    const rows = await this.prisma.providerServiceIncident.findMany({
      where,
      select: PROVIDER_INCIDENT_SELECT,
      orderBy: [{ reportedAt: 'desc' }, { id: 'desc' }],
      take: LIST_LIMIT,
    });
    const now = new Date();
    return { items: rows.map((row) => toListView(row, now)) };
  }

  async get(providerId: string, incidentId: string): Promise<ProviderIncidentDetailView> {
    const row = await this.prisma.providerServiceIncident.findFirst({
      where: { id: incidentId, providerId },
      select: PROVIDER_INCIDENT_SELECT,
    });
    if (!row) {
      throw incidentNotFound();
    }
    return toDetailView(row, new Date());
  }

  /**
   * The provider's one response. Accepted while the incident is undecided —
   * the 72-hour window is a signal, not a lock. The same text again answers
   * 200 (a retried submit); a different text is 409. Never decides anything.
   */
  async respond(
    providerId: string,
    incidentId: string,
    user: AuthUser,
    responseText: string,
  ): Promise<ProviderIncidentDetailView & { replayed: boolean }> {
    const text = normalizeIncidentText(responseText);
    if (text === null || text.length < PROVIDER_RESPONSE_MIN_LENGTH) {
      throw serviceIncidentErrors.responseTooShort(PROVIDER_RESPONSE_MIN_LENGTH);
    }
    if (text.length > PROVIDER_RESPONSE_MAX_LENGTH) {
      throw serviceIncidentErrors.responseTooLong(PROVIDER_RESPONSE_MAX_LENGTH);
    }

    let replayed = false;
    try {
      replayed = await runSerializable(
        this.prisma,
        async (tx) => {
          const incident = await tx.providerServiceIncident.findFirst({
            where: { id: incidentId, providerId },
            select: { id: true, requestId: true, providerResponse: true, effectiveAdjudicationId: true },
          });
          if (!incident) {
            throw incidentNotFound();
          }
          if (incident.providerResponse !== null) {
            if (incident.providerResponse === text) {
              return true;
            }
            throw serviceIncidentErrors.responseAlreadySubmitted();
          }
          if (incident.effectiveAdjudicationId !== null) {
            throw serviceIncidentErrors.alreadyAdjudicated();
          }
          const now = new Date();
          const moved = await tx.providerServiceIncident.updateMany({
            where: { id: incidentId, providerId, providerResponse: null, effectiveAdjudicationId: null },
            data: {
              providerResponse: text,
              providerRespondedAt: now,
              providerRespondedById: user.id,
              status: ProviderIncidentStatus.PROVIDER_RESPONDED,
            },
          });
          if (moved.count !== 1) {
            throw serviceIncidentErrors.responseAlreadySubmitted();
          }
          await enqueueIncidentResponseNotice(tx, { incidentId, requestId: incident.requestId, providerId });
          return false;
        },
        { label: 'serviceIncidents.providerRespond' },
      );
    } catch (error) {
      const code = incidentTriggerCode(error);
      if (code === SERVICE_INCIDENT_CODES.ALREADY_ADJUDICATED) throw serviceIncidentErrors.alreadyAdjudicated();
      if (code === SERVICE_INCIDENT_CODES.RESPONSE_ALREADY_SUBMITTED) throw serviceIncidentErrors.responseAlreadySubmitted();
      throw error;
    }

    if (!replayed) {
      this.notices.deliverSoon();
    }
    return { ...(await this.get(providerId, incidentId)), replayed };
  }
}

function toListView(row: ProviderIncidentRow, now: Date): ProviderIncidentView {
  const due = responseDueAt(row.reportedAt);
  const decided = row.effectiveAdjudication !== null;
  return {
    id: row.id,
    incidentNumber: row.incidentNumber,
    offerId: row.offerId,
    status: row.status,
    reason: row.reason,
    reportedAt: row.reportedAt,
    responseDueAt: due,
    responseOverdue: !decided && row.providerRespondedAt === null && now.getTime() > due.getTime(),
    canRespond: !decided && row.providerResponse === null,
    respondedAt: row.providerRespondedAt,
    request: {
      requestNumber: row.request.requestNumber,
      categoryName: row.request.category.name,
      city: row.request.city,
      district: row.request.district,
    },
    outcome: row.effectiveAdjudication
      ? {
          decision: row.effectiveAdjudication.decision,
          decidedAt: row.effectiveAdjudication.createdAt,
          corrected: row.effectiveAdjudication.kind === 'CORRECTION',
          message: PROVIDER_OUTCOME_COPY[row.effectiveAdjudication.decision],
        }
      : null,
  };
}

function toDetailView(row: ProviderIncidentRow, now: Date): ProviderIncidentDetailView {
  return {
    ...toListView(row, now),
    customerNote: maskContactDetailsInNote(row.customerNote),
    promisedStartDate: row.promisedStartDate,
    promisedEndDate: row.promisedEndDate,
    providerResponse: row.providerResponse,
  };
}
