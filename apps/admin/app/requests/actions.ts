'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiFetch, readConflict, ServiceRequest, ServiceRequestStatus } from '../../lib/api';
import { requestModerationErrorKey, type RequestStatusErrorKey } from '../../lib/status-conflicts';

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
    // Refusing to approve a request whose phone is not verified, to reject one
    // that is already matched or closed, or to move one that has left the
    // moderation queue (PR #119/#120) is a rule the moderator has to act on,
    // not a crash. It lands back on the request with an explanation instead
    // of the generic error boundary — the request was not modified. Only the
    // coded refusals are handled; anything else still surfaces as an error.
    const key = requestModerationErrorKey(conflictCode(error));
    if (key) {
      redirect(statusErrorHref(id, key));
    }

    throw error;
  }

  revalidatePath('/requests');
  revalidatePath(`/requests/${id}`);
}

/** The machine-readable code from a 409, when the API sent one. */
function conflictCode(error: unknown): string | null {
  return readConflict(error)?.code ?? null;
}

/** Status refusals land on the "Durum yönetimi" card of the first tab. */
function statusErrorHref(id: string, statusError: RequestStatusErrorKey) {
  return `/requests/${id}?statusError=${statusError}`;
}

/**
 * Lifecycle operations live on their own endpoints rather than on the moderation
 * status route: they enforce transitions the moderation dropdown does not (only
 * a MATCHED request can be completed, a finished request cannot move again) and
 * they stamp the matching timestamps.
 */
export async function completeRequestAction(formData: FormData) {
  const id = readFormString(formData, 'id');

  try {
    await apiFetch<ServiceRequest>(`/service-requests/${id}/complete`, { method: 'POST' });
  } catch (error) {
    // The endpoint's only 409 — coded or not — is "not MATCHED any more".
    if (readConflict(error)) {
      redirect(statusErrorHref(id, 'notCompletable'));
    }

    throw error;
  }

  revalidatePath('/requests');
  revalidatePath(`/requests/${id}`);
}

export async function cancelRequestAction(formData: FormData) {
  const id = readFormString(formData, 'id');

  try {
    await apiFetch<ServiceRequest>(`/service-requests/${id}/cancel`, { method: 'POST' });
  } catch (error) {
    // The endpoint's only 409 is "already closed": COMPLETED, CANCELLED,
    // EXPIRED or REJECTED by the time the write ran. Nothing was written.
    if (readConflict(error)) {
      redirect(statusErrorHref(id, 'notCancellable'));
    }

    throw error;
  }

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
  const removalReason =
    resolution === 'REQUEST_REMOVED' ? readOptionalFormString(formData, 'removalReason') : null;

  // The API refuses a removal without a reason with a 400, which would land
  // on the generic error page. The browser's `required` normally catches this
  // first; this is the guard for a submission that bypassed it.
  if (resolution === 'REQUEST_REMOVED' && !removalReason) {
    redirect(reportErrorHref(id, 'reasonRequired'));
  }

  try {
    await apiFetch<ServiceRequest>(`/service-requests/${id}/reports/resolve`, {
      method: 'POST',
      body: JSON.stringify({
        resolution,
        resolutionNote: readOptionalFormString(formData, 'resolutionNote'),
        removalReason: removalReason ?? undefined,
      }),
    });
  } catch (error) {
    const code = conflictCode(error);
    if (code === 'REQUEST_NOT_REMOVABLE') {
      redirect(reportErrorHref(id, 'notRemovable'));
    }
    if (code === 'NO_OPEN_REPORTS') {
      redirect(reportErrorHref(id, 'noOpen'));
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
      redirect(reportErrorHref(id, 'phoneNotVerified'));
    }
    // REQUEST_STATUS_TRANSITION_NOT_ALLOWED: the request stopped being a
    // removed, unmatched REJECTED row between the check and the write — the
    // same answer as "not reopenable".
    if (code === 'REQUEST_NOT_REOPENABLE' || code === 'REQUEST_STATUS_TRANSITION_NOT_ALLOWED') {
      redirect(reportErrorHref(id, 'notReopenable'));
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

/**
 * Report decisions and the reopen live on the request's "Şikayet" tab, so a
 * refusal lands the operator back there, next to the form they just used.
 */
function reportErrorHref(id: string, reportError: string) {
  return `/requests/${id}?tab=sikayet&reportError=${reportError}`;
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function readOptionalFormString(formData: FormData, key: string) {
  const value = readFormString(formData, key).trim();
  return value ? value : null;
}
