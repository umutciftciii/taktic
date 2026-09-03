import { Transform } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';
import {
  MAX_UNVIEWED_OFFER_REFUND_WINDOW_HOURS,
  MIN_UNVIEWED_OFFER_REFUND_WINDOW_HOURS,
} from '../../offers/refund-policy';

/**
 * The whole settings row, every time.
 *
 * A PUT rather than a PATCH, for the reason the company settings use one: one
 * screen edits every field, and a partial update would make "what is the window
 * now?" depend on which of several requests arrived last.
 *
 * The transform accepts the string a form sends and refuses everything a number
 * input can otherwise produce — "48 saat", "4 8", an empty box — as NaN, which
 * `@IsInt` then rejects with the message below rather than with a type error
 * nobody can act on. A fractional value is refused rather than rounded: the
 * number is printed verbatim into a sentence providers read, and there is no
 * sentence for 48.5 hours.
 */
export class SaveOperationsSettingsDto {
  @Transform(({ value }) => {
    if (typeof value === 'number') return value;
    if (typeof value !== 'string') return Number.NaN;
    const trimmed = value.trim();
    return trimmed === '' ? Number.NaN : Number(trimmed);
  })
  @IsInt({
    message: 'Kredi iade süresi tam saat olarak girilmelidir; ondalık değer kullanılamaz.',
  })
  @Min(MIN_UNVIEWED_OFFER_REFUND_WINDOW_HOURS, {
    message: `Kredi iade süresi en az ${MIN_UNVIEWED_OFFER_REFUND_WINDOW_HOURS} saat olmalıdır.`,
  })
  @Max(MAX_UNVIEWED_OFFER_REFUND_WINDOW_HOURS, {
    message: `Kredi iade süresi en fazla ${MAX_UNVIEWED_OFFER_REFUND_WINDOW_HOURS} saat olabilir.`,
  })
  unviewedOfferRefundWindowHours!: number;
}
