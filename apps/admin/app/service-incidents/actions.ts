'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ApiError, apiFetch } from '../../lib/api';
import { hasConfirmationProof } from '../../lib/confirmation-proof-server';
import { rethrowNextControlFlow } from '../../lib/next-control-flow';
import { readApiErrorCode } from '../../lib/service-incidents';

/**
 * REL-002 Faz 4 — the operator's decision on a service incident, and the
 * super admin's correction of it.
 *
 * Both are asked first in the confirmation dialog and refused here without
 * its single-use proof. The API re-checks the permission, the role (a
 * correction is SUPER_ADMIN only), the rationale and the current head of the
 * decision chain inside its own transaction; a refusal comes back as its
 * stable `code`, which the detail page turns into a Turkish sentence. Nothing
 * here refunds credit: a decision never does.
 */

export async function adjudicateIncidentAction(formData: FormData) {
  const id = readString(formData, 'incidentId');
  await refuseWithoutProof(formData, id, 'service-incident.adjudicate');
  await submit(
    id,
    `/admin/service-incidents/${encodeURIComponent(id)}/adjudications`,
    { decision: readString(formData, 'decision'), rationale: readString(formData, 'rationale') },
    'decided',
  );
}

export async function correctIncidentAction(formData: FormData) {
  const id = readString(formData, 'incidentId');
  await refuseWithoutProof(formData, id, 'service-incident.correct');
  await submit(
    id,
    `/admin/service-incidents/${encodeURIComponent(id)}/corrections`,
    {
      decision: readString(formData, 'decision'),
      rationale: readString(formData, 'rationale'),
      expectedEffectiveAdjudicationId: readString(formData, 'expectedEffectiveAdjudicationId'),
    },
    'corrected',
  );
}

async function refuseWithoutProof(
  formData: FormData,
  id: string,
  key: 'service-incident.adjudicate' | 'service-incident.correct',
) {
  if (!id) {
    redirect('/service-incidents');
  }
  if (!(await hasConfirmationProof(formData, key))) {
    redirect(`/service-incidents/${encodeURIComponent(id)}?error=confirmation`);
  }
}

async function submit(id: string, path: string, body: Record<string, unknown>, done: string) {
  let failure: string | null = null;
  try {
    await apiFetch<unknown>(path, { method: 'POST', body: JSON.stringify(body) });
  } catch (error) {
    rethrowNextControlFlow(error);
    failure =
      error instanceof ApiError
        ? (readApiErrorCode(error.body) ?? (error.status === 404 ? 'NOT_FOUND' : 'error'))
        : 'error';
  }

  revalidatePath('/service-incidents');
  revalidatePath(`/service-incidents/${id}`);
  const params = new URLSearchParams(failure ? { error: failure } : { done });
  redirect(`/service-incidents/${encodeURIComponent(id)}?${params.toString()}`);
}

function readString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}
