import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export const CAMPAIGN_LIST_DEFAULT_LIMIT = 25;
export const CAMPAIGN_LIST_MAX_LIMIT = 50;

function toInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export class ListCampaignsDto {
  @IsOptional()
  @Transform(({ value }) => toInt(value))
  @IsInt()
  @Min(1)
  @Max(CAMPAIGN_LIST_MAX_LIMIT)
  limit?: number;

  /** The `id` of the last row of the previous page. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  cursor?: string;
}
