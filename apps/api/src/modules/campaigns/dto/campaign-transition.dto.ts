import { CampaignStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export const CAMPAIGN_TRANSITION_REASON_MIN_LENGTH = 3;
export const CAMPAIGN_TRANSITION_REASON_MAX_LENGTH = 500;

/**
 * Pause, resume and end each take a reason (CMP-001 §3.3, "gerekçe zorunlu")
 * that goes into the audit row's summary. Short operator text, bounded; it
 * is the operator's note about the campaign, never a payload or a secret.
 */
export class CampaignTransitionDto {
  @IsString()
  @MinLength(CAMPAIGN_TRANSITION_REASON_MIN_LENGTH, { message: 'reason en az 3 karakter olmalı' })
  @MaxLength(CAMPAIGN_TRANSITION_REASON_MAX_LENGTH)
  reason!: string;
}

/**
 * The body of `POST /admin/campaigns/:id/versions/:n/activate`
 * (ADMIN-DESTRUCTIVE-CONFIRMATION-001 Paket A).
 *
 * - `reason`: on a PAUSED campaign the activation is also a resumption, so it
 *   takes the same reason a plain resume does — whichever route turns a
 *   PAUSED campaign back on, a reason is written. On a DRAFT or an ACTIVE
 *   campaign it is optional and, when given, recorded with the activation.
 * - `expectedStatus`: the status the operator confirmed against. When given
 *   and the campaign is no longer in it, nothing is written (409
 *   CAMPAIGN_STATUS_CHANGED) — a "switch to v3" confirmed on an ACTIVE
 *   campaign must not quietly become a resumption.
 */
export class CampaignActivateDto {
  @IsOptional()
  @IsString()
  @MaxLength(CAMPAIGN_TRANSITION_REASON_MAX_LENGTH)
  reason?: string;

  @IsOptional()
  @IsEnum(CampaignStatus)
  expectedStatus?: CampaignStatus;
}
