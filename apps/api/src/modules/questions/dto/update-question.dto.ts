import { ServiceRequestQuestionType } from '@prisma/client';
import { IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';

export class UpdateQuestionDto {
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/)
  key?: string;

  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsString()
  helpText?: string | null;

  @IsOptional()
  @IsEnum(ServiceRequestQuestionType)
  type?: ServiceRequestQuestionType;

  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;

  @IsOptional()
  @IsArray()
  options?: unknown[] | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
