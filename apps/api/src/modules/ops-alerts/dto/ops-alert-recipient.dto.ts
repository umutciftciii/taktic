import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Length, MaxLength, Min } from 'class-validator';
import { MAX_ADDRESS_LENGTH } from '../recipient-crypto';

/**
 * OBS-ALERT-002 — request bodies of the recipient and routing endpoints.
 *
 * The global ValidationPipe runs with `whitelist` + `forbidNonWhitelisted`
 * and no implicit conversion, so an unknown field, a `"true"` for a boolean
 * and a `"1"` for a version are all 400. Labels and reasons are judged after
 * trimming. The address is only bounded here; the service normalises and
 * validates it (one place, recipient-crypto.ts), so a malformed one is still
 * a 400 — never echoed back.
 */

export const RECIPIENT_LABEL_MAX_LENGTH = 80;
export const RECIPIENT_REASON_MIN_LENGTH = 5;
export const RECIPIENT_REASON_MAX_LENGTH = 500;
/** Preview tokens are 64 hex characters; anything longer is not one. */
const ROUTING_TOKEN_MAX_LENGTH = 128;

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateOpsAlertRecipientDto {
  @IsString()
  @MaxLength(MAX_ADDRESS_LENGTH)
  address!: string;

  @Transform(trim)
  @IsString()
  @Length(1, RECIPIENT_LABEL_MAX_LENGTH)
  label!: string;

  @IsBoolean()
  notifyWarning!: boolean;

  @IsBoolean()
  notifyCritical!: boolean;

  @IsBoolean()
  notifyRecovery!: boolean;
}

/** The optimistic-lock version every change to an existing recipient carries. */
export class OpsAlertRecipientVersionDto {
  @IsInt()
  @Min(1)
  version!: number;
}

export class UpdateOpsAlertRecipientDto extends OpsAlertRecipientVersionDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, RECIPIENT_LABEL_MAX_LENGTH)
  label?: string;

  @IsOptional()
  @IsBoolean()
  notifyWarning?: boolean;

  @IsOptional()
  @IsBoolean()
  notifyCritical?: boolean;

  @IsOptional()
  @IsBoolean()
  notifyRecovery?: boolean;

  /** Acknowledges the last-critical-recipient warning (spec §0.10). */
  @IsOptional()
  @IsBoolean()
  confirmLastCritical?: boolean;
}

export class PauseOpsAlertRecipientDto extends OpsAlertRecipientVersionDto {
  @IsOptional()
  @IsBoolean()
  confirmLastCritical?: boolean;
}

export class ResumeOpsAlertRecipientDto extends OpsAlertRecipientVersionDto {}

export class DeleteOpsAlertRecipientDto extends OpsAlertRecipientVersionDto {
  @Transform(trim)
  @IsString()
  @Length(RECIPIENT_REASON_MIN_LENGTH, RECIPIENT_REASON_MAX_LENGTH)
  reason!: string;

  @IsOptional()
  @IsBoolean()
  confirmLastCritical?: boolean;
}

export class ReplaceOpsAlertRecipientAddressDto extends OpsAlertRecipientVersionDto {
  @IsString()
  @MaxLength(MAX_ADDRESS_LENGTH)
  address!: string;

  @Transform(trim)
  @IsString()
  @Length(RECIPIENT_REASON_MIN_LENGTH, RECIPIENT_REASON_MAX_LENGTH)
  reason!: string;
}

export class ApplyCutoverDto {
  @IsString()
  @MaxLength(ROUTING_TOKEN_MAX_LENGTH)
  token!: string;
}

export class ApplyRevertDto extends ApplyCutoverDto {
  /** Confirms cancelling the pending deliveries the preview counted under `cancel`. */
  @IsOptional()
  @IsBoolean()
  cancelUnmatched?: boolean;
}
