import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';

export type FinanceAnalyticsGroupBy = 'day' | 'month' | 'year';

export const FINANCE_ANALYTICS_GROUP_BY_VALUES: FinanceAnalyticsGroupBy[] = [
  'day',
  'month',
  'year',
];

function trimOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export class FinanceAnalyticsDto {
  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'from must be in YYYY-MM-DD format',
  })
  from?: string;

  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'to must be in YYYY-MM-DD format',
  })
  to?: string;

  @IsOptional()
  @Transform(({ value }) => trimOrUndefined(value))
  @IsIn(FINANCE_ANALYTICS_GROUP_BY_VALUES)
  groupBy?: FinanceAnalyticsGroupBy;
}
