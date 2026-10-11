import { ProviderIncidentDecision, ProviderIncidentStatus, ServiceIssueReason } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsISO8601, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

function toInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function trimOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * `POST /providers/:providerId/incidents/:incidentId/response` (REL-002 Faz 4).
 * Trimmed and whitespace-collapsed by the service, then 10..2000; the raw cap
 * here only stops an absurd body early.
 */
export class RespondToIncidentDto {
  @IsString()
  @MaxLength(8000)
  responseText!: string;
}

/** `POST /admin/service-incidents/:id/adjudications` — the initial decision. */
export class AdjudicateIncidentDto {
  @IsEnum(ProviderIncidentDecision)
  decision!: ProviderIncidentDecision;

  @IsString()
  @MaxLength(8000)
  rationale!: string;
}

/** `POST /admin/service-incidents/:id/corrections` — SUPER_ADMIN only. */
export class CorrectIncidentDto {
  @IsEnum(ProviderIncidentDecision)
  decision!: ProviderIncidentDecision;

  @IsString()
  @MaxLength(8000)
  rationale!: string;

  /** The head the SUPER_ADMIN was looking at; anything else is a 409 (optimistic concurrency). */
  @IsString()
  @MaxLength(64)
  expectedEffectiveAdjudicationId!: string;
}

/** `POST /admin/provider-reliability-reviews/:id/resolve`. */
export class ResolveReliabilityReviewDto {
  @IsString()
  @MaxLength(8000)
  note!: string;
}

export const INCIDENT_QUEUE_STATES = ['open', 'decided', 'all'] as const;
export type IncidentQueueState = (typeof INCIDENT_QUEUE_STATES)[number];

export const RELIABILITY_LEVELS = ['NORMAL', 'WARNING', 'ADMIN_REVIEW_REQUIRED'] as const;

/** `GET /admin/service-incidents`. */
export class ListServiceIncidentsDto {
  @IsOptional()
  @Transform(({ value }) => toInt(value))
  @IsInt()
  @Min(1)
  @Max(10_000)
  page?: number;

  @IsOptional()
  @Transform(({ value }) => toInt(value))
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  /** open (default: REPORTED + PROVIDER_RESPONDED), decided, all — or one exact status. */
  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsIn([...INCIDENT_QUEUE_STATES, ...Object.values(ProviderIncidentStatus)])
  status?: IncidentQueueState | ProviderIncidentStatus;

  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsEnum(ServiceIssueReason)
  reason?: ServiceIssueReason;

  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsString()
  @MaxLength(64)
  providerId?: string;

  /** reportedAt lower bound (inclusive), ISO date or date-time. */
  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsISO8601()
  from?: string;

  /** reportedAt upper bound (exclusive), ISO date or date-time. */
  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsISO8601()
  to?: string;

  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsIn(['responded', 'not_responded'])
  response?: 'responded' | 'not_responded';

  /** Undecided, unanswered and past the 72-hour window. */
  @IsOptional()
  @Transform(({ value }) => (value === 'true' || value === true ? true : value === 'false' || value === false ? false : value))
  @IsIn([true, false])
  overdue?: boolean;

  /** The provider's current reliability level. */
  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsIn(RELIABILITY_LEVELS)
  risk?: (typeof RELIABILITY_LEVELS)[number];
}

/** `GET /admin/provider-reliability`. */
export class ListProviderReliabilityDto {
  @IsOptional()
  @Transform(({ value }) => toInt(value))
  @IsInt()
  @Min(1)
  @Max(10_000)
  page?: number;

  @IsOptional()
  @Transform(({ value }) => toInt(value))
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  /** WARNING, ADMIN_REVIEW_REQUIRED, or `review` (an unresolved review, whatever the level now). */
  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsIn(['WARNING', 'ADMIN_REVIEW_REQUIRED', 'review'])
  filter?: 'WARNING' | 'ADMIN_REVIEW_REQUIRED' | 'review';
}

/** `GET /providers/:providerId/incidents`. */
export class ListProviderIncidentsDto {
  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsIn(['open', 'closed', 'all'])
  state?: 'open' | 'closed' | 'all';
}
