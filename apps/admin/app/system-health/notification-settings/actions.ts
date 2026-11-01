'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ApiError, createOpsAlertRecipient, updateOpsAlertRecipient } from '../../../lib/api';
import { rethrowNextControlFlow } from '../../../lib/next-control-flow';
import { RECIPIENT_LABEL_MAX_LENGTH, recipientErrorText } from '../../../lib/ops-alert-recipients';
import { recipientStaleKey } from '../../../lib/status-conflicts';
import type { RecipientFormState } from './recipient-form-state';

/**
 * Bildirim Ayarları writes (OBS-ALERT-002 PR-B): add a recipient and edit one.
 * Each is the API route PR-A built, called once; the API decides every rule
 * (limit, duplicate, address shape, version).
 *
 * Neither asks for a confirmation proof: adding and editing are the window's
 * own explicit submit. The risky moves (pause, delete, address replacement,
 * reveal, silencing the last critical recipient) have their own gates.
 *
 * Nothing here logs or returns the address: a refusal's text is the API code's
 * sentence, and the typed address stays in the form's own client state.
 */

const PATH = '/system-health/notification-settings';

function readString(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

/** The form's switches travel as hidden "true"/"false" values (the same on every browser). */
function readSwitch(formData: FormData, name: string): boolean {
  return readString(formData, name) === 'true';
}

function readCode(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  try {
    const parsed = JSON.parse(error.body) as { code?: unknown };
    return typeof parsed?.code === 'string' ? parsed.code : null;
  } catch {
    return null;
  }
}

const ADDRESS_CODES = new Set(['RECIPIENT_ADDRESS_INVALID', 'RECIPIENT_DUPLICATE']);

function refusal(error: unknown): RecipientFormState {
  const code = readCode(error);
  // A 400 without a code is a DTO refusal (an over-long label, a missing field).
  const message =
    code !== null
      ? recipientErrorText(code)
      : error instanceof ApiError && error.status === 400
        ? 'Girilen bilgiler kabul edilmedi; etiketi ve diğer alanları kontrol edin.'
        : recipientErrorText(null);
  return { kind: 'error', message, field: code && ADDRESS_CODES.has(code) ? 'address' : null, code, at: Date.now() };
}

function invalid(message: string, field: 'address' | 'label'): RecipientFormState {
  return { kind: 'error', message, field, code: null, at: Date.now() };
}

function labelProblem(label: string): string | null {
  if (label.length === 0) return 'Etiket zorunludur.';
  if (label.length > RECIPIENT_LABEL_MAX_LENGTH) return `Etiket en fazla ${RECIPIENT_LABEL_MAX_LENGTH} karakter olabilir.`;
  return null;
}

export async function createRecipientAction(_previous: RecipientFormState, formData: FormData): Promise<RecipientFormState> {
  const address = readString(formData, 'address').trim();
  const label = readString(formData, 'label').trim();
  if (address.length === 0) return invalid('E-posta adresi zorunludur.', 'address');
  const problem = labelProblem(label);
  if (problem) return invalid(problem, 'label');

  try {
    await createOpsAlertRecipient({
      address,
      label,
      notifyWarning: readSwitch(formData, 'notifyWarning'),
      notifyCritical: readSwitch(formData, 'notifyCritical'),
      notifyRecovery: readSwitch(formData, 'notifyRecovery'),
    });
  } catch (error) {
    rethrowNextControlFlow(error);
    return refusal(error);
  }

  revalidatePath(PATH);
  revalidatePath('/system-health');
  redirect(`${PATH}?ok=created`);
}

export async function updateRecipientAction(_previous: RecipientFormState, formData: FormData): Promise<RecipientFormState> {
  const recipientId = readString(formData, 'recipientId');
  const version = Number(readString(formData, 'version'));
  const label = readString(formData, 'label').trim();
  if (!recipientId || !Number.isInteger(version) || version < 1) return refusal(null);
  const problem = labelProblem(label);
  if (problem) return invalid(problem, 'label');

  try {
    await updateOpsAlertRecipient(recipientId, {
      version,
      label,
      notifyWarning: readSwitch(formData, 'notifyWarning'),
      notifyCritical: readSwitch(formData, 'notifyCritical'),
      notifyRecovery: readSwitch(formData, 'notifyRecovery'),
    });
  } catch (error) {
    rethrowNextControlFlow(error);
    // The row moved after the form was drawn: the window cannot save against
    // the new version unseen, so the list shows the current row and says so.
    const stale = recipientStaleKey(readCode(error));
    if (stale) redirect(`${PATH}?error=${stale}`);
    return refusal(error);
  }

  revalidatePath(PATH);
  revalidatePath('/system-health');
  redirect(`${PATH}?ok=updated`);
}
