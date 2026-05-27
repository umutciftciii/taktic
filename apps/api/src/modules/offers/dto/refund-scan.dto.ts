import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class RefundScanQueryDto {
  @IsOptional()
  mode?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  olderThanHours?: number;

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
  olderThanHours?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}
