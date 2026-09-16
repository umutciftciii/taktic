import { RequestDraftFormType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  Allow, ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString,
  MaxLength, ValidateNested,
} from 'class-validator';
import { RequestIdentityCheckDto } from '../../auth/dto/request-identity.dto';

class DraftAnswerDto {
  @IsString() @IsNotEmpty() questionKey!: string;
  @Allow() value!: unknown;
}

class DraftRouterSelectionDto {
  @IsString() @IsNotEmpty() questionKey!: string;
  @IsString() @IsNotEmpty() optionKey!: string;
}

/**
 * What a draft may hold. Contact fields are absent on purpose and the global
 * ValidationPipe's forbidNonWhitelisted refuses them if sent.
 */
export class RequestDraftPayloadDto {
  @IsOptional() @IsString() @MaxLength(100) city?: string;
  @IsOptional() @IsString() @MaxLength(100) district?: string;
  @IsOptional() @IsString() @MaxLength(100) neighborhood?: string;
  @IsOptional() @IsString() @MaxLength(2000) addressNote?: string;
  @IsOptional() @IsString() @MaxLength(32) urgency?: string;
  @IsOptional() @IsString() @MaxLength(16) urgencyBucket?: string;
  @IsOptional() @IsString() @MaxLength(32) preferredDate?: string;
  @IsOptional() @IsString() @MaxLength(32) preferredDateEnd?: string;
  @IsOptional() @IsInt() budgetMin?: number;
  @IsOptional() @IsInt() budgetMax?: number;
  @IsOptional() @IsString() @MaxLength(20_000) description?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => DraftAnswerDto)
  answers?: DraftAnswerDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => DraftRouterSelectionDto)
  routerSelections?: DraftRouterSelectionDto[];
}

export type RequestDraftPayload = RequestDraftPayloadDto;

export class CreateRequestDraftDto {
  @IsEnum(RequestDraftFormType) formType!: RequestDraftFormType;
  @IsString() @IsNotEmpty() @MaxLength(128) categorySlug!: string;
  @IsOptional() @IsString() @MaxLength(64) cardId?: string;
  @ValidateNested() @Type(() => RequestDraftPayloadDto) payload!: RequestDraftPayloadDto;
  @ValidateNested() @Type(() => RequestIdentityCheckDto) identity!: RequestIdentityCheckDto;
  @IsOptional() @IsBoolean() replace?: boolean;
}

export class CurrentRequestDraftQueryDto {
  @IsEnum(RequestDraftFormType) formType!: RequestDraftFormType;
  @IsString() @IsNotEmpty() @MaxLength(128) categorySlug!: string;
  @IsOptional() @IsString() @MaxLength(64) cardId?: string;
}
