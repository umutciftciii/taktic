'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ApiError, apiFetch, readConflict, ServiceRequest, ServiceRequestStatus } from '../../lib/api';
import { isCreditBalanceLimitError, requestModerationErrorKey, type RequestStatusErrorKey } from '../../lib/status-conflicts';
import { hasConfirmationProof } from '../../lib/confirmation-proof-server';
import { rethrowNextControlFlow } from '../../lib/next-control-flow';

export async function updateRequestStatusAction(formData: FormData) {
  const id = readFormString(formData, 'id');
  const status = readFormString(formData, 'status') as ServiceRequestStatus;

  // Rejecting (Faz 1), approving and taking a published request back into
  // review (Faz 2) are confirmed in a dialog, each with its own key; taking a
  // new request into review is not (ADMIN-DESTRUCTIVE-CONFIRMATION-001).
  if (!(await hasModerationProof(formData, id, status))) {
    redirect(statusErrorHref(id, 'confirmationRequired'));
  }

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
    // A rejection refunds live offers in the same transaction; a refund past
    // the ledger bound refuses the whole rejection (API-HARDENING-001).
    if (isCreditBalanceLimitError(error)) {
      redirect(statusErrorHref(id, 'creditBalanceLimit'));
    }

    throw error;
  }

  revalidatePath('/requests');
  revalidatePath(`/requests/${id}`);
}

/**
 * Whether a moderation submission carries the proof its move needs, spending
 * it when it does. IN_REVIEW is judged against the stored status: out of
 * APPROVED it unpublishes the request and is confirmed, out of SUBMITTED it is
 * the queue's first step and goes straight through. A request that cannot be
 * read is treated as published — the refusal is the safe answer.
 */
async function hasModerationProof(formData: FormData, id: string, status: ServiceRequestStatus): Promise<boolean> {
  switch (status) {
    case 'REJECTED':
      return hasConfirmationProof(formData, 'request.reject');
    case 'APPROVED':
      return hasConfirmationProof(formData, 'request.approve');
    case 'IN_REVIEW':
      return (await isPublished(id)) ? hasConfirmationProof(formData, 'request.unpublish') : true;
    default:
      return true;
  }
}

async function isPublished(id: string): Promise<boolean> {
  try {
    return (await apiFetch<ServiceRequest>(`/service-requests/${id}`)).status === 'APPROVED';
  } catch (error) {
    rethrowNextControlFlow(error);
    return true;
  }
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

  // COMPLETED is terminal; the dialog says so (ADMIN-DESTRUCTIVE-CONFIRMATION-001, Faz 2).
  if (!(await hasConfirmationProof(formData, 'request.complete'))) {
    redirect(statusErrorHref(id, 'confirmationRequired'));
  }

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

/**
 * The operations cancel (PR #118). `winnerRefund` is written by the cancel
 * form's own hidden field; only the exact value `withhold` goes to the
 * withhold endpoint — anything else, a missing field included, is the default
 * cancel, which gives the winner's credit back. The API holds the same line:
 * `/cancel` has no refund switch at all.
 */
export async function cancelRequestAction(formData: FormData) {
  const id = readFormString(formData, 'id');
  const expectedMatchedOfferId = readFormString(formData, 'expectedMatchedOfferId');
  const withhold = readFormString(formData, 'winnerRefund') === 'withhold';
  const withholdReason = readOptionalFormString(formData, 'withholdReason');

  if (withhold && (!withholdReason || withholdReason.length < 10)) {
    redirect(statusErrorHref(id, 'withholdReasonRequired'));
  }
  // Both cancels are confirmed in a dialog (ADMIN-DESTRUCTIVE-CONFIRMATION-001).
  if (!(await hasConfirmationProof(formData, 'request.cancel'))) {
    redirect(statusErrorHref(id, 'confirmationRequired'));
  }

  try {
    if (withhold) {
      await apiFetch<ServiceRequest>(`/service-requests/${id}/cancel/withhold-winner-refund`, {
        method: 'POST',
        body: JSON.stringify({ reason: withholdReason, expectedMatchedOfferId }),
      });
    } else {
      await apiFetch<ServiceRequest>(`/service-requests/${id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ expectedMatchedOfferId }),
      });
    }
  } catch (error) {
    const conflict = readConflict(error);
    if (conflict) {
      // The request moved after the page was drawn (a match appeared or ended),
      // or it closed. Nothing was written either way.
      redirect(statusErrorHref(id, conflict.code === 'REQUEST_CANCEL_STATE_CHANGED' ? 'cancelStateChanged' : 'notCancellable'));
    }
    if (isBadRequestCode(error, 'CANCEL_WITHHOLD_REASON_REQUIRED')) {
      redirect(statusErrorHref(id, 'withholdReasonRequired'));
    }
    if (isCreditBalanceLimitError(error)) {
      redirect(statusErrorHref(id, 'creditBalanceLimit'));
    }

    throw error;
  }

  revalidatePath('/requests');
  revalidatePath(`/requests/${id}`);
  redirect(`/requests/${id}?cancelled=1`);
}

function isBadRequestCode(error: unknown, code: string): boolean {
  if (!(error instanceof ApiError) || error.status !== 400) return false;
  try {
    return (JSON.parse(error.body) as { code?: unknown }).code === code;
  } catch {
    return false;
  }
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
  // Taking the request down (Faz 1) and dismissing the reports (Faz 2) are
  // each confirmed in a dialog with their own key: a dismissal cannot be
  // undone either (ADMIN-DESTRUCTIVE-CONFIRMATION-001).
  if (resolution === 'REQUEST_REMOVED' && !(await hasConfirmationProof(formData, 'request.report-remove'))) {
    redirect(reportErrorHref(id, 'confirmation'));
  }
  if (resolution === 'DISMISSED' && !(await hasConfirmationProof(formData, 'request.report-dismiss'))) {
    redirect(reportErrorHref(id, 'confirmation'));
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
    if (isCreditBalanceLimitError(error)) {
      redirect(statusErrorHref(id, 'creditBalanceLimit'));
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

  // Republishing is confirmed in a dialog (ADMIN-DESTRUCTIVE-CONFIRMATION-001, Faz 2).
  if (!(await hasConfirmationProof(formData, 'request.reopen'))) {
    redirect(reportErrorHref(id, 'confirmation'));
  }

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
