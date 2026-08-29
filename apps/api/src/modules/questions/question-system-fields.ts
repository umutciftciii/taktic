import { BadRequestException } from '@nestjs/common';
import {
  ServiceRequestQuestionSystemField,
  ServiceRequestQuestionType,
} from '@prisma/client';

/**
 * A system-bound question is a label and a requirement placed on a column the
 * request already has — never a second copy of that column's value.
 *
 * The research this expansion is built on found address and budget asked as
 * ordinary form questions. Storing them that way in Taktic would give every
 * routed category its own private address next to the one provider matching
 * reads, and two addresses on one request is not a duplicate field, it is a
 * matching bug waiting to happen. So a bound question configures the built-in
 * field instead: it can rename it, explain it and make it mandatory for this
 * category, and the API refuses an answer sent for it.
 */

/**
 * The question type each binding must carry.
 *
 * Pinned rather than "anything goes" so an admin cannot bind a SELECT to the
 * address and leave a set of options nothing will ever read. The type is what
 * the admin surface renders and what a client would otherwise try to submit.
 */
const REQUIRED_TYPE: Record<ServiceRequestQuestionSystemField, ServiceRequestQuestionType> = {
  [ServiceRequestQuestionSystemField.ADDRESS]: ServiceRequestQuestionType.TEXT,
  [ServiceRequestQuestionSystemField.BUDGET]: ServiceRequestQuestionType.NUMBER,
  [ServiceRequestQuestionSystemField.DESCRIPTION]: ServiceRequestQuestionType.TEXTAREA,
  [ServiceRequestQuestionSystemField.PREFERRED_DATE]: ServiceRequestQuestionType.DATE,
};

/** The request fields each binding governs, for the message a refusal carries. */
const FIELD_LABELS: Record<ServiceRequestQuestionSystemField, string> = {
  [ServiceRequestQuestionSystemField.ADDRESS]: 'adres (il / ilçe / mahalle)',
  [ServiceRequestQuestionSystemField.BUDGET]: 'bütçe aralığı',
  [ServiceRequestQuestionSystemField.DESCRIPTION]: 'iş açıklaması',
  [ServiceRequestQuestionSystemField.PREFERRED_DATE]: 'tercih edilen tarih',
};

export function systemFieldLabel(field: ServiceRequestQuestionSystemField): string {
  return FIELD_LABELS[field];
}

/**
 * Refuses a binding whose question type could not carry it. Called on every
 * admin write, so a stored question is always one the request form can render.
 */
export function assertSystemFieldTypeMatches(
  systemField: ServiceRequestQuestionSystemField | null,
  type: ServiceRequestQuestionType,
): void {
  if (systemField === null) {
    return;
  }

  const expected = REQUIRED_TYPE[systemField];
  if (type !== expected) {
    throw new BadRequestException(
      `${systemField} bağlı bir soru ${expected} tipinde olmalı (gönderilen: ${type})`,
    );
  }
}

/** The shape of a request the bindings are checked against. */
export type SystemFieldRequestValues = {
  city: string;
  district: string;
  neighborhood: string | null;
  budgetMin: number | null;
  budgetMax: number | null;
  description: string | null;
  preferredDate: Date | null;
};

/**
 * Whether a bound field carries a value, in the sense the binding means.
 *
 * City and district are already mandatory on every request, so a required
 * ADDRESS binding is asking for the level the base form leaves optional: the
 * neighbourhood. Budget is satisfied by either end of the range — a customer
 * who states only a ceiling has stated a budget.
 */
export function hasSystemFieldValue(
  field: ServiceRequestQuestionSystemField,
  values: SystemFieldRequestValues,
): boolean {
  switch (field) {
    case ServiceRequestQuestionSystemField.ADDRESS:
      return Boolean(values.city?.trim() && values.district?.trim() && values.neighborhood?.trim());
    case ServiceRequestQuestionSystemField.BUDGET:
      return values.budgetMin !== null || values.budgetMax !== null;
    case ServiceRequestQuestionSystemField.DESCRIPTION:
      return Boolean(values.description?.trim());
    case ServiceRequestQuestionSystemField.PREFERRED_DATE:
      return values.preferredDate !== null;
  }
}
