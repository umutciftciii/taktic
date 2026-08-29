import { ServiceCategoryStatus } from '@prisma/client';
import { IsBoolean, IsEnum, IsOptional, ValidateIf } from 'class-validator';

/**
 * The status switch, in both vocabularies.
 *
 * `status` is the one with three answers and is what the admin screens send.
 * `isActive` is what every client written before the taxonomy sent, and it
 * still works: it is the same switch with DRAFT missing. Sending neither is
 * refused rather than silently doing nothing.
 */
export class UpdateCategoryStatusDto {
  @IsOptional()
  @IsEnum(ServiceCategoryStatus)
  status?: ServiceCategoryStatus;

  /**
   * @ValidateIf rather than @IsOptional: when `status` is absent this field is
   * the request, so an absent or non-boolean value has to fail validation
   * instead of being skipped.
   */
  @ValidateIf((dto: UpdateCategoryStatusDto) => dto.status === undefined)
  @IsBoolean()
  isActive?: boolean;
}

/**
 * The status a payload asks for. Kept next to the DTO because the mapping —
 * true ⇒ ACTIVE, false ⇒ INACTIVE, never DRAFT — is part of the compatibility
 * promise, not an implementation detail of one endpoint.
 */
export function resolveRequestedStatus(dto: {
  status?: ServiceCategoryStatus;
  isActive?: boolean;
}): ServiceCategoryStatus | undefined {
  if (dto.status !== undefined) {
    return dto.status;
  }

  if (dto.isActive === undefined) {
    return undefined;
  }

  return dto.isActive ? ServiceCategoryStatus.ACTIVE : ServiceCategoryStatus.INACTIVE;
}
