import { QuestionConditionMatchMode } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

/**
 * "Show the question this rule belongs to only when `sourceQuestionKey` was
 * answered with one of `expectedValues`."
 *
 * The source travels by key, never by id: the key is the category-scoped name
 * the admin screen shows and the request payload already uses, and refusing to
 * accept an id is also what keeps a rule from pointing at another category's
 * question — the lookup is scoped to this question's own category.
 */
export class QuestionConditionDto {
  @IsString()
  @IsNotEmpty()
  sourceQuestionKey!: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  expectedValues!: string[];

  /**
   * How the expected values are compared against the answer.
   *
   * Omitted means ANY, which is what every rule written before this field
   * existed meant — so an old client's payload keeps producing exactly the rule
   * it used to. ALL is only accepted when the source is a MULTI_SELECT
   * question; anywhere else the two modes are the same rule under two names,
   * and the endpoint says so rather than storing a distinction that is not one.
   */
  @IsOptional()
  @IsEnum(QuestionConditionMatchMode)
  matchMode?: QuestionConditionMatchMode;
}

export class ReplaceQuestionConditionsDto {
  /**
   * The complete set. Omitted or empty clears every rule, which is how a
   * question goes back to being always visible.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => QuestionConditionDto)
  conditions?: QuestionConditionDto[];
}
