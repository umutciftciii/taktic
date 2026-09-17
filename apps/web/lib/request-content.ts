/**
 * The customer's own request, read back to them: what they wrote into the
 * form, in words, and nothing they did not.
 *
 * A row exists for a value and only for a value. An empty field has no row —
 * not a dash, not "belirtilmedi" — because the block answers "what did I
 * send?", and an invented placeholder would be an answer the customer never
 * gave. The answers arrive from the API already in words (`displayValue`), so
 * no option key is ever printed. The contact details are deliberately not
 * here: the block is about the job, and the phone has its own card.
 */

import type { CustomerServiceRequestDetail } from './api';
import { formatDateRange, formatPrice, urgencyLabel as sharedUrgencyLabel } from './formatters';

export type RequestContentRow = {
  /** Stable, for `data-testid="request-content-<key>"`. */
  key: string;
  label: string;
  value: string;
  /** Long free text keeps its line breaks. */
  multiline?: boolean;
};

export const REQUEST_CONTENT_TITLE = 'Talep içeriği';

/** The block's slice of the detail; every field optional, as an older answer may be. */
export type RequestContentView = Pick<CustomerServiceRequestDetail, 'city' | 'district'> &
  Partial<
    Pick<
      CustomerServiceRequestDetail,
      | 'description'
      | 'neighborhood'
      | 'addressNote'
      | 'budgetMin'
      | 'budgetMax'
      | 'preferredDate'
      | 'preferredDateEnd'
      | 'urgency'
      | 'answers'
    >
  >;

export function requestContentRows(request: RequestContentView): RequestContentRow[] {
  const rows: RequestContentRow[] = [];

  const description = text(request.description);
  if (description) {
    rows.push({ key: 'description', label: 'Açıklama', value: description, multiline: true });
  }

  for (const answer of request.answers ?? []) {
    const value = text(answer.displayValue);
    if (value) {
      rows.push({
        key: `answer-${answer.questionKey}`,
        label: answer.questionLabel,
        value,
        multiline: answer.questionType === 'TEXTAREA',
      });
    }
  }

  rows.push({
    key: 'location',
    label: 'Konum',
    value: [request.city, request.district, text(request.neighborhood)]
      .filter((part): part is string => Boolean(part))
      .join(', '),
  });

  const addressNote = text(request.addressNote);
  if (addressNote) {
    rows.push({ key: 'address-note', label: 'Adres notu', value: addressNote, multiline: true });
  }

  if (request.preferredDate) {
    rows.push({
      key: 'preferred-date',
      label: 'Tercih edilen tarih',
      value: formatDateRange(request.preferredDate, request.preferredDateEnd ?? null),
    });
  }

  const budget = budgetText(request.budgetMin ?? null, request.budgetMax ?? null);
  if (budget) {
    rows.push({ key: 'budget', label: 'Bütçe', value: budget });
  }

  // A code the shared table does not know is a gap in that table, not a
  // word to show the customer — the row is left out rather than guessed.
  const urgency = sharedUrgencyLabel(request.urgency ?? null);
  if (urgency && urgency !== '-') {
    rows.push({ key: 'urgency', label: 'Aciliyet', value: urgency });
  }

  return rows;
}

function text(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Minor units in; one end, both ends or nothing. */
function budgetText(min: number | null, max: number | null): string | null {
  if (min !== null && max !== null) return `${formatPrice(min)} - ${formatPrice(max)}`;
  if (min !== null) return `${formatPrice(min)}+`;
  if (max !== null) return `≤ ${formatPrice(max)}`;
  return null;
}
