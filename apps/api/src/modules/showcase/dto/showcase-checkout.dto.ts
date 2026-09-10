import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * What a provider names when they buy a placement: a card of their own, and a
 * package from the catalogue.
 *
 * Nothing else is accepted, and the omissions are the design. There is no
 * price, no duration and no area list — all three are read server-side from the
 * package and the card's live version, so a body cannot decide what a placement
 * costs or how far it reaches. There is no `placementId` either: placements are
 * born from settled payments, and a client that could name one could attach a
 * payment to somebody else's run.
 */
export class CreateShowcaseCheckoutDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  showcasePackageId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  cardId!: string;
}
