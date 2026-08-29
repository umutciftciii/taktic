'use server';

import { redirect } from 'next/navigation';
import {
  apiFetch,
  parseDecimalToMinor,
  QuestionType,
  RoutingResolution,
  ServiceRequest,
} from '../../lib/api';
import { decodeRouterSelections, encodeRouterSelections } from '../../lib/request-flow';

type QuestionMeta = {
  key: string;
  type: QuestionType;
};

/**
 * One step of a routed flow.
 *
 * The browser posts the option the customer clicked; the API alone turns it
 * into a category and says where the flow stands. Nothing about the
 * destination is decided here — this action only forwards the answer and
 * navigates to whatever the API named, which may be another router.
 */
export async function resolveRouterStepAction(formData: FormData) {
  const entryCategorySlug = readFormString(formData, 'entryCategorySlug');
  const questionKey = readFormString(formData, 'routerQuestionKey');
  const optionKey = readFormString(formData, 'routerOptionKey');

  const selections = [
    ...decodeRouterSelections(readOptionalFormString(formData, 'routerSelections')),
    { questionKey, optionKey },
  ];

  const resolution = await apiFetch<RoutingResolution>('/categories/routing/resolve', {
    method: 'POST',
    body: JSON.stringify({ entryCategorySlug, selections }),
  });

  const query = new URLSearchParams({
    entry: resolution.entryCategorySlug,
    r: encodeRouterSelections(selections),
  });

  redirect(`/categories/${resolution.categorySlug}?${query.toString()}`);
}

export async function submitServiceRequestAction(formData: FormData) {
  const categorySlug = readFormString(formData, 'categorySlug');
  const questionMeta = parseQuestionMeta(readFormString(formData, 'questionMeta'));
  const request = await apiFetch<ServiceRequest>('/service-requests', {
    method: 'POST',
    body: JSON.stringify({
      categorySlug,
      // The steps that led here, replayed for the API to re-walk. Empty for an
      // ordinary service, which is what every request was before routing.
      routerSelections: decodeRouterSelections(
        readOptionalFormString(formData, 'routerSelections'),
      ),
      customerName: readFormString(formData, 'customerName'),
      customerPhone: readFormString(formData, 'customerPhone'),
      customerEmail: readFormString(formData, 'customerEmail'),
      city: readFormString(formData, 'city'),
      district: readFormString(formData, 'district'),
      neighborhood: readOptionalFormString(formData, 'neighborhood'),
      addressNote: readOptionalFormString(formData, 'addressNote'),
      // Budget inputs accept a human-readable decimal ("1500,00" or "149.90").
      // parseDecimalToMinor returns the minor-unit integer (kuruş for TRY) or null
      // when the customer left the field empty — preserving the optional semantics.
      budgetMin: parseDecimalToMinor(readFormString(formData, 'budgetMin')),
      budgetMax: parseDecimalToMinor(readFormString(formData, 'budgetMax')),
      preferredDate: readOptionalFormString(formData, 'preferredDate'),
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
    }),
  });

  redirect(`/requests/success?id=${request.id}`);
}

function parseQuestionMeta(value: string): QuestionMeta[] {
  const parsed = JSON.parse(value) as unknown;

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
      return formData.getAll(key).filter((value): value is string => typeof value === 'string' && value !== '');
    case 'NUMBER':
      return readOptionalFormNumber(formData, key);
    case 'BOOLEAN':
      return formData.get(key) === 'true';
    default:
      return readFormString(formData, key);
  }
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function readOptionalFormString(formData: FormData, key: string) {
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
