import { IsString, MinLength } from 'class-validator';
import { MaxCodeUnitLength } from '../../../common/max-code-unit-length.validator';
import { SUPPORT_TICKET_MESSAGE_MAX_LENGTH } from '../support-tickets.config';

/**
 * One reply, from either side.
 *
 * The body is the entire payload. Who wrote it comes from the session and which
 * ticket it lands on comes from the path, so this DTO has no way to express
 * "post as somebody else" — the shape itself is the guarantee.
 */
export class CreateSupportTicketMessageDto {
  @IsString()
  @MinLength(1)
  @MaxCodeUnitLength(SUPPORT_TICKET_MESSAGE_MAX_LENGTH)
  body!: string;
}
