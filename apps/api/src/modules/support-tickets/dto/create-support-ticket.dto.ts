import { IsString, MinLength } from 'class-validator';
import { MaxCodeUnitLength } from '../../../common/max-code-unit-length.validator';
import {
  SUPPORT_TICKET_MESSAGE_MAX_LENGTH,
  SUPPORT_TICKET_SUBJECT_MAX_LENGTH,
} from '../support-tickets.config';

/**
 * Opening a ticket: a headline and the first thing to say about it.
 *
 * Note what is *not* here. There is no customer id, no owner, no status and no
 * author: the owner is the authenticated principal and the status is OPEN by
 * definition, so a tampered body cannot open a ticket in somebody else's name
 * or start one already resolved.
 *
 * The bounds below are a first pass, not the rule. The service trims, strips
 * control characters and re-checks both lengths, because a subject that is only
 * whitespace passes `@MinLength(1)` and is still not a subject. The maximum is
 * exact rather than doubled here, so an over-long paste is refused by the field
 * that names it rather than by a generic sentence later.
 */
export class CreateSupportTicketDto {
  @IsString()
  @MinLength(1)
  @MaxCodeUnitLength(SUPPORT_TICKET_SUBJECT_MAX_LENGTH)
  subject!: string;

  @IsString()
  @MinLength(1)
  @MaxCodeUnitLength(SUPPORT_TICKET_MESSAGE_MAX_LENGTH)
  message!: string;
}
