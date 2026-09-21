import { IsString, MaxLength, MinLength } from 'class-validator';

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
