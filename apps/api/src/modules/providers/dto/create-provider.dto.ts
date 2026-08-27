import { Type } from 'class-transformer';
import {
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { IsKnownTurkishLocation } from '../../locations/turkish-location.validator';

export class ProviderServiceAreaDto {
  /**
   * Carries the relation check for the area. A province on its own is a valid
   * area — the matching rule reads a null district as the whole province — but
   * a district that is named has to be a district of *that* province, and a
   * neighbourhood one of that district. Matching compares these as plain text,
   * so an area at a place that does not exist is an area that matches nothing.
   */
  @IsString()
  @IsNotEmpty()
  @IsKnownTurkishLocation()
  city!: string;

  @IsOptional()
  @IsString()
  district?: string | null;

  @IsOptional()
  @IsString()
  neighborhood?: string | null;
}

export class CreateProviderDto {
  @IsString()
  @IsNotEmpty()
  businessName!: string;

  @IsString()
  @IsNotEmpty()
  contactName!: string;

  @IsString()
  @IsNotEmpty()
  phone!: string;

  @IsOptional()
  @IsString()
  email?: string | null;

  @IsOptional()
  @IsString()
  taxType?: string | null;

  @IsOptional()
  @IsString()
  taxNumber?: string | null;

  /** Same relation check as the service area above, over the business address. */
  @IsString()
  @IsNotEmpty()
  @IsKnownTurkishLocation()
  city!: string;

  @IsString()
  @IsNotEmpty()
  district!: string;

  @IsOptional()
  @IsString()
  addressNote?: string | null;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsArray()
  @IsString({ each: true })
  categoryIds!: string[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProviderServiceAreaDto)
  serviceAreas!: ProviderServiceAreaDto[];
}
