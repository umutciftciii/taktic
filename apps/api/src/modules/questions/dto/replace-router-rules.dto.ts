import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

/** One option of a routing question, and the category it means. */
export class RouterRuleDto {
  @IsString()
  @IsNotEmpty()
  optionKey!: string;

  /**
   * By slug rather than id, so the admin form posts something a person can read
   * back and check — and so a mistyped destination fails as "kategori
   * bulunamadı" instead of as an opaque foreign-key error.
   */
  @IsString()
  @IsNotEmpty()
  targetCategorySlug!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class ReplaceRouterRulesDto {
  /** The complete map. Empty clears it, which leaves the router unconfigured. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => RouterRuleDto)
  rules?: RouterRuleDto[];
}
