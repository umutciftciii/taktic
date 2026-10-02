import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { REFUND_SCAN_MAX_PAGE_SIZE } from '../unviewed-offer-refund.service';

/**
 * `olderThanHours` used to live here and no longer does.
 *
 * The window is the product promise — set on the operations settings screen and
 * snapshotted onto each offer — and letting a caller shorten
 * it is the one way this endpoint could pay for an offer the customer still had
 * time to open. Removing the field rather than validating it means there is
 * nothing to get wrong; a client that still sends it is answered with a 400 by
 * the global whitelist pipe.
 */
export class RefundScanQueryDto {
  /**
   * API-REFUND-SCAN-PAGINATION-001: the preview is paged, and `total` counts
   * every eligible offer. `limit` is gone from this read — it was the size of
   * the only page there was, and stays only on the run below, where it is the
   * batch size.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(REFUND_SCAN_MAX_PAGE_SIZE)
  pageSize?: number;
}

export class ExecuteRefundScanDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}
