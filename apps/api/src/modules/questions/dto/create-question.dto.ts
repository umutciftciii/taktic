import { ServiceRequestQuestionType } from '@prisma/client';
import { IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';

export class CreateQuestionDto {
  @IsString()
  @Matches(/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/)
  key!: string;

  @IsString()
  label!: string;

  @IsOptional()
  @IsString()
  helpText?: string | null;

  @IsEnum(ServiceRequestQuestionType)
  type!: ServiceRequestQuestionType;

  @IsBoolean()
  isRequired!: boolean;

  @IsOptional()
  @IsArray()
  options?: unknown[] | null;

  @IsInt()
  @Min(0)
  sortOrder!: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
