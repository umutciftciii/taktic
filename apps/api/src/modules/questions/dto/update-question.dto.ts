import {
  ServiceRequestQuestionSystemField,
  ServiceRequestQuestionType,
} from '@prisma/client';
import {
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

export class UpdateQuestionDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/)
  key?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
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


  /**
   * Binds the question to a request column instead of an answer row. NULL — the
   * default — is an ordinary question. See question-system-fields.ts.
   */
  @IsOptional()
  @IsEnum(ServiceRequestQuestionSystemField)
  systemField?: ServiceRequestQuestionSystemField | null;

  /** Marks this as the routing question of a ROUTER category. */
  @IsOptional()
  @IsBoolean()
  isRouter?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
