import { Transform } from 'class-transformer';
import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

export const ELIGIBILITY_REASON_MIN_LENGTH = 10;
export const ELIGIBILITY_REASON_MAX_LENGTH = 1000;

/**
 * A person's decision on a held event (CMP-006 PR-C). The reason is required
 * and is the audit: 10–1000 characters, the same bounds the database CHECK
 * holds. It is free text — the form asks the operator not to paste a
 * registration number or an address into it.
 */
export class EligibilityDecisionDto {
  @IsIn(['ELIGIBLE', 'INELIGIBLE'])
  decision!: 'ELIGIBLE' | 'INELIGIBLE';

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(ELIGIBILITY_REASON_MIN_LENGTH, { message: 'Gerekçe en az 10 karakter olmalı.' })
  @MaxLength(ELIGIBILITY_REASON_MAX_LENGTH)
  reason!: string;
}
