import { HttpException, HttpStatus } from '@nestjs/common';
import { SupportTicketStatus } from '@prisma/client';
import {
  SUPPORT_TICKET_INVALID_TRANSITION_CODE,
  SUPPORT_TICKET_NOT_WRITABLE_CODE,
} from './support-tickets.config';

/**
 * The two refusals a caller who is entitled to the ticket can meet.
 *
 * Both are 409s carrying a machine-readable code and a Turkish sentence,
 * because both are answers to somebody looking at their own ticket: they are
 * entitled to know why the composer will not take their message, or why the
 * status will not move. Neither names anybody, and neither reveals a ticket the
 * caller could not already see — a caller who is *not* entitled gets a 404 long
 * before either of these is reached.
 */

const STATUS_LABELS: Record<SupportTicketStatus, string> = {
  [SupportTicketStatus.OPEN]: 'açık',
  [SupportTicketStatus.IN_PROGRESS]: 'işlemde',
  [SupportTicketStatus.RESOLVED]: 'çözüldü',
  [SupportTicketStatus.CLOSED]: 'kapatıldı',
};

export class SupportTicketNotWritableException extends HttpException {
  constructor(status: SupportTicketStatus) {
    super(
      {
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        code: SUPPORT_TICKET_NOT_WRITABLE_CODE,
        status,
        message: `Bu destek talebi "${STATUS_LABELS[status]}" durumunda olduğu için yeni mesaj eklenemez.`,
      },
      HttpStatus.CONFLICT,
    );
  }
}

export class SupportTicketInvalidTransitionException extends HttpException {
  constructor(from: SupportTicketStatus, to: SupportTicketStatus) {
    super(
      {
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        code: SUPPORT_TICKET_INVALID_TRANSITION_CODE,
        from,
        to,
        message: `"${STATUS_LABELS[from]}" durumundaki bir destek talebi "${STATUS_LABELS[to]}" durumuna geçirilemez.`,
      },
      HttpStatus.CONFLICT,
    );
  }
}
