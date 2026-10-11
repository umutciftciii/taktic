'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ApiError, apiFetch } from '../../../../../lib/api';
import {
  INCIDENT_RESPONSE_MAX_LENGTH,
  INCIDENT_RESPONSE_MIN_LENGTH,
  incidentResponseErrorMessage,
} from '../../../../../lib/provider-incidents';

export type IncidentResponseFormState = {
  status: 'idle' | 'error';
  message?: string;
  responseText?: string;
};

/**
 * The provider's one statement on an incident.
 *
 * The API owns every rule — the length, that it is the first response, that no
 * decision has been made yet. A 400 comes back to the form with the text kept;
 * a 409 means the incident moved on (already answered, or decided), so the
 * page is re-read and shown read-only with a sentence saying why.
 */
export async function submitIncidentResponseAction(
  _previous: IncidentResponseFormState,
  formData: FormData,
): Promise<IncidentResponseFormState> {
  const providerId = readString(formData, 'providerId');
  const incidentId = readString(formData, 'incidentId');
  const responseText = readString(formData, 'responseText');
  const base = `/providers/${providerId}/aksakliklar`;
  const detail = `${base}/${incidentId}`;

  const trimmed = responseText.trim();
  if (trimmed.length < INCIDENT_RESPONSE_MIN_LENGTH) {
    return { status: 'error', message: incidentResponseErrorMessage('INCIDENT_RESPONSE_TOO_SHORT'), responseText };
  }
  if (trimmed.length > INCIDENT_RESPONSE_MAX_LENGTH) {
    return { status: 'error', message: incidentResponseErrorMessage('INCIDENT_RESPONSE_TOO_LONG'), responseText };
  }

  let conflict: 'responded' | 'decided' | null = null;
  try {
    await apiFetch(`/providers/${providerId}/incidents/${incidentId}/response`, {
      method: 'POST',
      body: JSON.stringify({ responseText: trimmed }),
    });
  } catch (error) {
    if (!(error instanceof ApiError)) {
      return { status: 'error', message: incidentResponseErrorMessage(null), responseText };
    }
    const code = apiErrorCode(error);
    if (error.status === 409) {
      conflict = code === 'INCIDENT_ALREADY_ADJUDICATED' ? 'decided' : 'responded';
    } else if (error.status === 404 || error.status === 403) {
      return { status: 'error', message: 'Bu bildirim bulunamadı.', responseText };
    } else if (error.status === 401) {
      redirect(`/login?redirectTo=${encodeURIComponent(detail)}`);
    } else {
      return { status: 'error', message: incidentResponseErrorMessage(code), responseText };
    }
  }

  revalidatePath(base);
  revalidatePath(detail);
  redirect(conflict ? `${detail}?conflict=${conflict}` : `${detail}?responded=1`);
}

function apiErrorCode(error: ApiError): string | null {
  try {
    const parsed = JSON.parse(error.body) as { code?: unknown };
    return typeof parsed?.code === 'string' ? parsed.code : null;
  } catch {
    return null;
  }
}

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}
