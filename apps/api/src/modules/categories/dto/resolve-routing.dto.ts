import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

/**
 * One step of a routed flow: "on question X the customer chose option Y".
 *
 * Note what is *not* here — a category. The client says which option was
 * clicked; the API alone turns that into a category, by looking the option up
 * in the stored router rules. A client that wanted to land a request on a
 * category of its choosing has nothing to send.
 */
export class RouterSelectionDto {
  @IsString()
  @IsNotEmpty()
  questionKey!: string;

  @IsString()
  @IsNotEmpty()
  optionKey!: string;
}

export class ResolveRoutingDto {
  @IsString()
  @IsNotEmpty()
  entryCategorySlug!: string;

  /**
   * Empty is legitimate and is how the first step is asked for: "I am at this
   * router, what should I ask?". The cap is a cheap bound on a payload the
   * router walk would refuse anyway a few steps later.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => RouterSelectionDto)
  selections?: RouterSelectionDto[];
}
