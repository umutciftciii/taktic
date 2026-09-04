import { SupportTicketStatus } from '@prisma/client';
import { IsEnum } from 'class-validator';

/**
 * The status an operator is moving a ticket to.
 *
 * `@IsEnum` only settles that the value is one of the four; whether *this*
 * ticket may go there is the transition table's question, and it is answered in
 * the service against the status the row actually holds at that moment — never
 * against a status the caller claims it is in. There is deliberately no "from"
 * field for that reason.
 */
export class UpdateSupportTicketStatusDto {
  @IsEnum(SupportTicketStatus)
  status!: SupportTicketStatus;
}
