import { OfferPackageType } from '@prisma/client';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Min,
} from 'class-validator';

export class CreateCreditPackageDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  slug!: string;

  /**
   * What this package sells. Absent means ONE_TIME_CREDITS — the only thing
   * this endpoint could create before period packages existed, so every client
   * written against the old shape keeps working unchanged.
   */
  @IsOptional()
  @IsEnum(OfferPackageType)
  type?: OfferPackageType;

  /**
   * Required and positive for ONE_TIME_CREDITS; must be absent or 0 for the
   * period types, which grant an entitlement rather than a balance.
   *
   * The per-type rule lives in the service (and in a database CHECK) rather
   * than in a decorator, because a decorator cannot see `type`.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  creditAmount?: number;

  // priceAmount is stored in the currency's minor unit (e.g. kuruş for TRY).
  // Minimum 100 = 1 unit (1,00 TRY). Decimals must be converted to minor units
  // on the client/server-action side before reaching the API.
  @IsInt()
  @Min(100)
  priceAmount!: number;

  /** The credit quota one MONTHLY_QUOTA period carries. */
  @IsOptional()
  @IsInt()
  @Min(1)
  quotaCredits?: number;

  /** Offers per day a CATEGORY_UNLIMITED period allows. Absent means no cap. */
  @IsOptional()
  @IsInt()
  @Min(1)
  dailyOfferLimit?: number | null;

  /**
   * The categories a CATEGORY_UNLIMITED package covers. Every one of them must
   * already be marked eligible for unlimited packages by an admin.
   */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  scopeCategoryIds?: string[];

  @IsOptional()
  @IsString()
  currency?: string | null;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
