import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { IsKnownTurkishLocation } from '../../locations/turkish-location.validator';

/**
 * One area a card claims, as a client may state it: a province, optionally
 * narrowed to a district and then to a neighbourhood.
 *
 * There is deliberately no `scope` and no `areaKey` here. Both are derived by
 * the server from the levels below — a body that could carry either could claim
 * "İstanbul geneli" while naming Kadıköy, or claim that two different places
 * are one area.
 *
 * `IsKnownTurkishLocation` checks the triple as a *relation* against the shipped
 * location list: a district has to be a district of that province, and a
 * neighbourhood a neighbourhood of that district. "İstanbul / Çankaya" names two
 * real places and is still refused.
 */
export class ShowcaseAreaDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @IsKnownTurkishLocation()
  city!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  district?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  neighborhood?: string | null;
}
