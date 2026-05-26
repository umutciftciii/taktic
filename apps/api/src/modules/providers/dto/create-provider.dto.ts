import { Type } from 'class-transformer';
import {
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export class ProviderServiceAreaDto {
  @IsString()
  @IsNotEmpty()
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

  @IsString()
  @IsNotEmpty()
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
