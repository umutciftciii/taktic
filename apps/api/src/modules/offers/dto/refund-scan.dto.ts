import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * `olderThanHours` used to live here and no longer does.
 *
 * The window is the product promise — 48 hours — and letting a caller shorten
 * it is the one way this endpoint could pay for an offer the customer still had
 * time to open. Removing the field rather than validating it means there is
 * nothing to get wrong; a client that still sends it is answered with a 400 by
 * the global whitelist pipe.
 */
export class RefundScanQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

export class ExecuteRefundScanDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}
