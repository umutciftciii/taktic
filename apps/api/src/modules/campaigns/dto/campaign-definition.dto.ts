import { IsObject } from 'class-validator';

/** A definition on its own: a revision, or a validate-only request. */
export class CampaignDefinitionDto {
  @IsObject()
  definition!: Record<string, unknown>;
}
