'use server';

import { redirect } from 'next/navigation';
import { apiFetch, RoutingResolution, ServiceRequest } from '../../lib/api';
import { decodeRouterSelections, encodeRouterSelections } from '../../lib/request-flow';
import { buildServiceRequestPayload } from '../../lib/service-request-payload';

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
  // The body is built by the one function both request forms share — this one
  // and the vitrin card's — so the field names and the optional/required split
  // cannot drift between them.
  const request = await apiFetch<ServiceRequest>('/service-requests', {
    method: 'POST',
    body: JSON.stringify(buildServiceRequestPayload(formData)),
  });

  redirect(`/requests/success?id=${request.id}`);
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function readOptionalFormString(formData: FormData, key: string) {
  const value = readFormString(formData, key).trim();
  return value ? value : null;
}
