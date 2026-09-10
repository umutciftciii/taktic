import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * The operator's note on a suspension.
 *
 * Optional, and it is the only field. There is deliberately no `reason` — an
 * operator's action is `ADMIN_ACTION` by definition, and a body that could name
 * a different reason could name one that does not stop the clock, which would
 * be an operator quietly billing a provider for days the platform took away.
 */
export class ShowcasePlacementSuspendDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/**
 * The note left on a cancellation.
 *
 * There is no `refund` field and no amount. Cancelling ends the run and leaves
 * a flag for a person; the money is moved by that person, through the same
 * manual path a payment reversal takes.
 */
export class ShowcasePlacementCancelDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
