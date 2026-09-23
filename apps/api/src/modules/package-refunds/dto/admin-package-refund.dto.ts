import {
  PackageRefundApprovalKind,
  PackageRefundExceptionGround,
  PackageRefundRequestStatus,
} from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { PACKAGE_REFUND_REASON_MAX, PACKAGE_REFUND_REASON_MIN } from '../package-refund-request.rules';

export const PACKAGE_REFUND_PAGE_DEFAULT_SIZE = 25;
export const PACKAGE_REFUND_PAGE_MAX_SIZE = 100;

function toInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toStatusList(value: unknown): PackageRefundRequestStatus[] | undefined {
  const raw = Array.isArray(value) ? value : [value];
  const statuses = raw
    .flatMap((entry) => (typeof entry === 'string' ? entry.split(',') : []))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return statuses.length > 0
    ? (Array.from(new Set(statuses)) as PackageRefundRequestStatus[])
    : undefined;
}

/** Trimmed here so the length rule measures what will be stored. */
function trimmed(value: unknown) {
  return typeof value === 'string' ? value.trim() : value;
}

export class ListPackageRefundRequestsDto {
  @IsOptional()
  @Transform(({ value }) => toStatusList(value))
  @ArrayNotEmpty()
  @IsEnum(PackageRefundRequestStatus, { each: true })
  status?: PackageRefundRequestStatus[];

  @IsOptional()
  @Transform(({ value }) => toInt(value))
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Transform(({ value }) => toInt(value))
  @IsInt()
  @Min(1)
  @Max(PACKAGE_REFUND_PAGE_MAX_SIZE)
  pageSize?: number;
}

/**
 * An operator opening a request on a provider's *existing* ticket. There is no
 * provider id and no owner here: both come from the ticket.
 */
export class CreatePackageRefundRequestDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  supportTicketId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  purchaseId!: string;
}

export class ApprovePackageRefundRequestDto {
  @IsEnum(PackageRefundApprovalKind)
  kind!: PackageRefundApprovalKind;

  @ValidateIf((dto: ApprovePackageRefundRequestDto) => dto.kind === PackageRefundApprovalKind.EXCEPTION)
  @IsEnum(PackageRefundExceptionGround)
  exceptionGround?: PackageRefundExceptionGround;

  @ValidateIf((dto: ApprovePackageRefundRequestDto) => dto.kind === PackageRefundApprovalKind.EXCEPTION)
  @Transform(({ value }) => trimmed(value))
  @IsString()
  @MinLength(PACKAGE_REFUND_REASON_MIN)
  @MaxLength(PACKAGE_REFUND_REASON_MAX)
  exceptionReason?: string;
}

export class PackageRefundReasonDto {
  @Transform(({ value }) => trimmed(value))
  @IsString()
  @MinLength(PACKAGE_REFUND_REASON_MIN)
  @MaxLength(PACKAGE_REFUND_REASON_MAX)
  reason!: string;
}
