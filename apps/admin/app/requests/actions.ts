'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ApiError, apiFetch, ServiceRequest, ServiceRequestStatus } from '../../lib/api';

export async function updateRequestStatusAction(formData: FormData) {
  const id = readFormString(formData, 'id');
  const status = readFormString(formData, 'status') as ServiceRequestStatus;

  try {
    await apiFetch<ServiceRequest>(`/service-requests/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({
        status,
        moderationNote: readOptionalFormString(formData, 'moderationNote'),
        rejectionReason: readOptionalFormString(formData, 'rejectionReason'),
      }),
    });
  } catch (error) {
    // Refusing to approve a request whose phone is not verified is a rule the
    // moderator has to act on, not a crash. It lands back on the request with
    // an explanation instead of the generic error boundary — the request was
    // not modified. Only this one code is handled; anything else still
    // surfaces as an error.
    if (conflictCode(error) === 'PHONE_NOT_VERIFIED') {
      redirect(`/requests/${id}?statusError=phoneNotVerified`);
    }

    throw error;
  }

  revalidatePath('/requests');
  revalidatePath(`/requests/${id}`);
}

/** The machine-readable code from a 409, when the API sent one. */
function conflictCode(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 409) {
    return null;
  }

  try {
    const parsed = JSON.parse(error.body) as { code?: unknown };
    return typeof parsed.code === 'string' ? parsed.code : null;
  } catch {
    return null;
  }
}

/**
 * Lifecycle operations live on their own endpoints rather than on the moderation
 * status route: they enforce transitions the moderation dropdown does not (only
 * a MATCHED request can be completed, a finished request cannot move again) and
 * they stamp the matching timestamps.
 */
export async function completeRequestAction(formData: FormData) {
  const id = readFormString(formData, 'id');

  await apiFetch<ServiceRequest>(`/service-requests/${id}/complete`, { method: 'POST' });

  revalidatePath('/requests');
  revalidatePath(`/requests/${id}`);
}

export async function cancelRequestAction(formData: FormData) {
  const id = readFormString(formData, 'id');

  await apiFetch<ServiceRequest>(`/service-requests/${id}/cancel`, { method: 'POST' });

  revalidatePath('/requests');
  revalidatePath(`/requests/${id}`);
}

/**
 * The one decision about a request's open reports: either the request is fine
 * and the reports are dismissed, or the reports are upheld and the request is
 * taken down. The API does the rest in one transaction — closing every open
 * report, rejecting the request, refunding the credits — so this action only
 * carries the decision and lands the operator back on the request with a
 * reason when the API refuses it.
 *
 * `removalReason` travels only with a removal. It is the sentence the customer
 * is told, so a dismissal has no business carrying one.
 */
export async function resolveReportsAction(formData: FormData) {
  const id = readFormString(formData, 'id');
  const resolution = readFormString(formData, 'resolution');

  try {
    await apiFetch<ServiceRequest>(`/service-requests/${id}/reports/resolve`, {
      method: 'POST',
      body: JSON.stringify({
        resolution,
        resolutionNote: readOptionalFormString(formData, 'resolutionNote'),
        removalReason:
          resolution === 'REQUEST_REMOVED'
            ? readOptionalFormString(formData, 'removalReason')
            : undefined,
      }),
    });
  } catch (error) {
    const code = conflictCode(error);
    if (code === 'REQUEST_NOT_REMOVABLE') {
      redirect(`/requests/${id}?reportError=notRemovable`);
    }
    if (code === 'NO_OPEN_REPORTS') {
      redirect(`/requests/${id}?reportError=noOpen`);
    }

    throw error;
  }

  revalidatePath('/requests/reports');
  revalidatePath(`/requests/${id}`);
  revalidatePath('/requests');
}

/**
 * Puts a request back after a report removed it. Only a REJECTED request with
 * a removal behind it qualifies, and the same phone rule that guards approval
 * guards this — the request goes back to APPROVED, so an unverified number is
 * refused the same way and with the same message.
 */
export async function reopenRequestAction(formData: FormData) {
  const id = readFormString(formData, 'id');

  try {
    await apiFetch<ServiceRequest>(`/service-requests/${id}/reopen`, {
      method: 'POST',
      body: JSON.stringify({
        moderationNote: readOptionalFormString(formData, 'moderationNote'),
      }),
    });
  } catch (error) {
    const code = conflictCode(error);
    if (code === 'PHONE_NOT_VERIFIED') {
      redirect(`/requests/${id}?statusError=phoneNotVerified`);
    }
    if (code === 'REQUEST_NOT_REOPENABLE') {
      redirect(`/requests/${id}?reportError=notReopenable`);
    }

    throw error;
  }

  revalidatePath('/requests/reports');
  revalidatePath(`/requests/${id}`);
  revalidatePath('/requests');
}

export async function recalculateRequestQualityAction(formData: FormData) {
  const id = readFormString(formData, 'id');

  await apiFetch<ServiceRequest>(`/service-requests/${id}/recalculate-quality`, {
    method: 'POST',
  });

  revalidatePath('/requests');
  revalidatePath(`/requests/${id}`);
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function readOptionalFormString(formData: FormData, key: string) {
  const value = readFormString(formData, key).trim();
  return value ? value : null;
}
