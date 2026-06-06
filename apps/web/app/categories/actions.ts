'use server';

import { redirect } from 'next/navigation';
import { apiFetch, parseDecimalToMinor, QuestionType, ServiceRequest } from '../../lib/api';

type QuestionMeta = {
  key: string;
  type: QuestionType;
};

export async function submitServiceRequestAction(formData: FormData) {
  const categorySlug = readFormString(formData, 'categorySlug');
  const questionMeta = parseQuestionMeta(readFormString(formData, 'questionMeta'));
  const request = await apiFetch<ServiceRequest>('/service-requests', {
    method: 'POST',
    body: JSON.stringify({
      categorySlug,
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
