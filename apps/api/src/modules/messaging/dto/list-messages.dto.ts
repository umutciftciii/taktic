import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { MESSAGE_PAGE_MAX_LIMIT } from '../messaging.config';

export class ListMessagesDto {
  /** Walk backwards through history from this cursor. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  before?: string;

  /** Everything written after this cursor — what an open thread polls with. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  after?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MESSAGE_PAGE_MAX_LIMIT)
  limit?: number;
}
