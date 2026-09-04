import { BadRequestException } from '@nestjs/common';
import {
  SUPPORT_TICKET_MESSAGE_MAX_LENGTH,
  SUPPORT_TICKET_SUBJECT_MAX_LENGTH,
} from './support-tickets.config';

/**
 * Everything a ticket stores as text, normalised the same way.
 *
 * The DTOs already bound the length, but a bound is not the rule: a body of
 * three hundred spaces passes `@MinLength(1)` and is still not a message, and a
 * subject padded with newlines is not a headline. Both are trimmed, stripped of
 * the control characters a keyboard cannot produce, and re-measured here — so
 * the stored value is exactly what a reader will see, and the length that was
 * checked is the length that was kept.
 *
 * Nothing is ever parsed as markup. A subject and a body are stored as text and
 * every surface renders them as text, so there is no representation in which a
 * ticket is anything but characters.
 */

export function normalizeSupportTicketSubject(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new BadRequestException('Konu zorunludur.');
  }

  // A subject is one line. A newline in it is not content, it is layout
  // somebody pasted, so it collapses to a space rather than being kept.
  const cleaned = collapseWhitespace(stripControlCharacters(raw));

  if (!cleaned) {
    throw new BadRequestException('Konu boş olamaz.');
  }

  if (cleaned.length > SUPPORT_TICKET_SUBJECT_MAX_LENGTH) {
    throw new BadRequestException(
      `Konu en fazla ${SUPPORT_TICKET_SUBJECT_MAX_LENGTH} karakter olabilir.`,
    );
  }

  return cleaned;
}

export function normalizeSupportTicketBody(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new BadRequestException('Mesaj zorunludur.');
  }

  const cleaned = stripControlCharacters(raw).trim();

  if (!cleaned) {
    throw new BadRequestException('Mesaj boş olamaz.');
  }

  if (cleaned.length > SUPPORT_TICKET_MESSAGE_MAX_LENGTH) {
    throw new BadRequestException(
      `Mesaj en fazla ${SUPPORT_TICKET_MESSAGE_MAX_LENGTH} karakter olabilir.`,
    );
  }

  return cleaned;
}

/**
 * Removes the characters a keyboard cannot produce but a script can.
 *
 * Newline (\n), carriage return (\r) and tab (\t) survive — a person really
 * does type those in a message. Everything else below U+0020, plus the C1 range
 * and the delete character, is dropped: none of them mean anything in a support
 * ticket, and several of them are how text gets a second life somewhere it is
 * written to a terminal, a log or a CSV.
 */
function stripControlCharacters(value: string): string {
  let result = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const isKeyboardWhitespace = code === 0x09 || code === 0x0a || code === 0x0d;
    const isControl = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    if (!isControl || isKeyboardWhitespace) {
      result += character;
    }
  }

  return result;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}
