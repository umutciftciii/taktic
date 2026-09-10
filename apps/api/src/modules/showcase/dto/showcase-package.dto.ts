import { ShowcaseCardKind } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  SHOWCASE_PACKAGE_DESCRIPTION_MAX_LENGTH,
  SHOWCASE_PACKAGE_MAX_DURATION_DAYS,
  SHOWCASE_PACKAGE_MAX_PRICE_MINOR,
  SHOWCASE_PACKAGE_MIN_DURATION_DAYS,
  SHOWCASE_PACKAGE_NAME_MAX_LENGTH,
  SHOWCASE_PACKAGE_SLUG_MAX_LENGTH,
} from '../showcase.constants';

/**
 * A vitrin package as an operator writes it.
 *
 * The slug pattern is the interesting field. It is validated here, and again by
 * a CHECK on `ShowcasePackage`, and its mirror image is validated by a CHECK on
 * `OfferCreditPackage` — three enforcements of one rule, because the thing it
 * prevents is a *configuration* mistake rather than a data one:
 * `LEMON_SQUEEZY_VARIANT_MAP` is keyed by slug across both catalogues, so
 * without a reserved namespace one payment variant could stand for a credit
 * package and a vitrin package at once, and nothing in the database would ever
 * notice.
 *
 * There is no `creditAmount` and there never will be. A vitrin package sells
 * visibility; a package that could also carry credits would be one edit away
 * from being an offer package with a different name.
 */
export class CreateShowcasePackageDto {
  @IsString()
  @MinLength(3)
  @MaxLength(SHOWCASE_PACKAGE_NAME_MAX_LENGTH)
  name!: string;

  /** Lower-case, digits and hyphens, and it must begin with `vitrin-`. */
  @IsString()
  @MaxLength(SHOWCASE_PACKAGE_SLUG_MAX_LENGTH)
  @Matches(/^vitrin-[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message:
      'Kısa ad "vitrin-" ile başlamalı ve yalnız küçük harf, rakam ve tire içermelidir.',
  })
  slug!: string;

  /** Minor units — what TakTick charges, never what the provider charges. */
  @IsInt()
  @Min(1)
  @Max(SHOWCASE_PACKAGE_MAX_PRICE_MINOR)
  priceAmount!: number;

  @IsInt()
  @Min(SHOWCASE_PACKAGE_MIN_DURATION_DAYS)
  @Max(SHOWCASE_PACKAGE_MAX_DURATION_DAYS)
  durationDays!: number;

  /** Omitted or null means the package sells placements for either card kind. */
  @IsOptional()
  @IsEnum(ShowcaseCardKind)
  allowedCardKind?: ShowcaseCardKind | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(25)
  maxAreas?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(SHOWCASE_PACKAGE_DESCRIPTION_MAX_LENGTH)
  description?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;
}

/**
 * An edit. The slug is deliberately absent.
 *
 * A slug is the key into the payment provider's variant map, so renaming one
 * silently detaches every future checkout for that package from the variant it
 * was mapped to — and `VARIANT_MISMATCH` at settlement time is a customer who
 * paid and got nothing. Retiring a package (`isActive: false`) and creating its
 * replacement is the safe shape, and it leaves the old rows readable.
 *
 * Price and duration *may* change, and affect only later purchases: every
 * purchase snapshots both, and no placement ever reads the catalogue back.
 */
export class UpdateShowcasePackageDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(SHOWCASE_PACKAGE_NAME_MAX_LENGTH)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(SHOWCASE_PACKAGE_MAX_PRICE_MINOR)
  priceAmount?: number;

  @IsOptional()
  @IsInt()
  @Min(SHOWCASE_PACKAGE_MIN_DURATION_DAYS)
  @Max(SHOWCASE_PACKAGE_MAX_DURATION_DAYS)
  durationDays?: number;

  @IsOptional()
  @IsEnum(ShowcaseCardKind)
  allowedCardKind?: ShowcaseCardKind | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(25)
  maxAreas?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(SHOWCASE_PACKAGE_DESCRIPTION_MAX_LENGTH)
  description?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;
}
