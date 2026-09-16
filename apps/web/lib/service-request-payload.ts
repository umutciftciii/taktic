import type { QuestionType } from './api';
import { parseLiraToMinor } from './lira-input';
import { decodeRouterSelections } from './request-flow';

/**
 * A posted request form, turned into the body `POST /service-requests` takes.
 *
 * ## Why one function and not two
 *
 * Two forms post a request: the marketplace form on a category page, and the
 * form on a vitrin card, which posts the same body plus one field the card
 * asks (`urgencyBucket`). The card's form used to build its own body by hand,
 * and the first time the two drifted apart the lead was the one with the bug:
 * a free-text district the DTO's location check refused, in a body the
 * marketplace form could never have produced. Reading both through this
 * function is what keeps the field names, the optional/required split and the
 * enum values one fact rather than two.
 *
 * ## What it does not decide
 *
 * Nothing here is authority. The API re-validates every field — the location
 * triple as a relation, the answers against the stored questions, the contact
 * fields against who is signed in — so this only has to post what the form
 * held, in the shape the DTO reads.
 */
export type ServiceRequestPayload = {
  categorySlug: string;
  routerSelections: { questionKey: string; optionKey: string }[];
  useAlternateContact: boolean;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  city: string;
  district: string;
  neighborhood: string | null;
  addressNote: string | null;
  budgetMin: number | null;
  budgetMax: number | null;
  /** `YYYY-MM-DD`, both ends or neither — the API refuses a half range. */
  preferredDate: string | null;
  preferredDateEnd: string | null;
  urgency: string | null;
  description: string | null;
  contactDisclosureAccepted: boolean;
  contactDisclosureVersion: string | null;
  answers: { questionKey: string; value: unknown }[];
};

type QuestionMeta = {
  key: string;
  type: QuestionType;
};

export function buildServiceRequestPayload(formData: FormData): ServiceRequestPayload {
  const questionMeta = parseQuestionMeta(readFormString(formData, 'questionMeta'));

  return {
    categorySlug: readFormString(formData, 'categorySlug'),
    // The steps that led here, replayed for the API to re-walk. Empty for an
    // ordinary service, which is what every request was before routing.
    routerSelections: decodeRouterSelections(readOptionalFormString(formData, 'routerSelections')),
    // Ticked only by a signed-in customer who wants somebody else contacted.
    // Absent — a guest's form, or the default path — it is false, and the API
    // then decides for itself where the contact comes from.
    useAlternateContact: formData.get('useAlternateContact') === 'true',
    ...contactFields(formData),
    city: readFormString(formData, 'city'),
    district: readFormString(formData, 'district'),
    neighborhood: readOptionalFormString(formData, 'neighborhood'),
    addressNote: readOptionalFormString(formData, 'addressNote'),
    // The budget fields post what the customer sees — Turkish lira, grouped
    // and with a comma before the kuruş ("5.000,00"). parseLiraToMinor is the
    // one place that text becomes a number: the minor-unit integer (kuruş for
    // TRY) the API's DTO has always taken, or null for an empty field, so the
    // optional semantics and the wire format are both unchanged.
    budgetMin: parseLiraToMinor(readFormString(formData, 'budgetMin')),
    budgetMax: parseLiraToMinor(readFormString(formData, 'budgetMax')),
    // The two date inputs' own values, `YYYY-MM-DD`, posted as the strings
    // they are: no Date is constructed here, so no zone can move the day.
    preferredDate: readOptionalFormString(formData, 'preferredDate'),
    preferredDateEnd: readOptionalFormString(formData, 'preferredDateEnd'),
    // The timing select's own value (TODAY / THIS_WEEK / FLEXIBLE), or null
    // when the customer left it on "Seçiniz".
    urgency: readOptionalFormString(formData, 'urgency'),
    description: readOptionalFormString(formData, 'description'),
    // Rendered only while contact sharing is on. With the feature off the
    // form carries neither field and the API ignores both, so request
    // creation behaves exactly as it did before.
    contactDisclosureAccepted: formData.get('contactDisclosureAccepted') === 'true',
    contactDisclosureVersion: readOptionalFormString(formData, 'contactDisclosureVersion'),
    answers: questionMeta.map((question) => ({
      questionKey: question.key,
      value: readAnswerValue(formData, question),
    })),
  };
}

/**
 * The three contact fields, but only when the form actually asked for them.
 *
 * A guest's form and an alternate contact both render them, and they are
 * forwarded exactly as they always were — including empty, so the API's own
 * "must not be empty" rule still produces the error it always did. A signed-in
 * customer on the default path renders none of them: the keys are then left out
 * of the payload entirely, because the API is going to read the account instead
 * and a field sent here would only be something for it to ignore.
 */
function contactFields(formData: FormData) {
  if (!formData.has('customerName')) {
    return {};
  }

  return {
    customerName: readFormString(formData, 'customerName'),
    customerPhone: readFormString(formData, 'customerPhone'),
    customerEmail: readFormString(formData, 'customerEmail'),
  };
}

function parseQuestionMeta(value: string): QuestionMeta[] {
  if (!value) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter(isQuestionMeta);
}

function isQuestionMeta(value: unknown): value is QuestionMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.key === 'string' && typeof record.type === 'string';
}

function readAnswerValue(formData: FormData, question: QuestionMeta) {
  const key = `answer_${question.key}`;

  switch (question.type) {
    case 'MULTI_SELECT':
      return formData
        .getAll(key)
        .filter((value): value is string => typeof value === 'string' && value !== '');
    case 'NUMBER':
      return readOptionalFormNumber(formData, key);
    case 'BOOLEAN':
      return formData.get(key) === 'true';
    default:
      return readFormString(formData, key);
  }
}

export function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

export function readOptionalFormString(formData: FormData, key: string) {
  const value = readFormString(formData, key).trim();
  return value ? value : null;
}

function readOptionalFormNumber(formData: FormData, key: string) {
  const value = readFormString(formData, key).trim();
  if (!value) {
    return null;
  }

  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}
