import { IsObject, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** Operator-facing identifier: lowercase slug, stable for the campaign's life. */
export const CAMPAIGN_KEY_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const CAMPAIGN_KEY_MAX_LENGTH = 64;
export const CAMPAIGN_NAME_MAX_LENGTH = 120;

/**
 * A new draft: identity plus its first definition.
 *
 * The definition is taken as an opaque object here and judged by the rule
 * validator in the service, which is the one authority on its shape. Nothing
 * else is accepted — no status, no version number, no actor: the status is
 * DRAFT by definition, the version is 1 by definition and the actor is the
 * session.
 */
export class CreateCampaignDto {
  @IsString()
  @MinLength(1)
  @MaxLength(CAMPAIGN_KEY_MAX_LENGTH)
  @Matches(CAMPAIGN_KEY_PATTERN, { message: 'key yalnızca küçük harf, rakam ve tire içerebilir' })
  key!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(CAMPAIGN_NAME_MAX_LENGTH)
  name!: string;

  @IsObject()
  definition!: Record<string, unknown>;
}
