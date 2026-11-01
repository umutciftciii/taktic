'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  ApiError,
  applyOpsAlertCutover,
  applyOpsAlertRevert,
  createOpsAlertRecipient,
  deleteOpsAlertRecipient,
  importOpsAlertEnvRecipient,
  pauseOpsAlertRecipient,
  previewOpsAlertCutover,
  previewOpsAlertRevert,
  rehashOpsAlertRecipients,
  replaceOpsAlertRecipientAddress,
  resumeOpsAlertRecipient,
  revealOpsAlertRecipient,
  rewrapOpsAlertRecipients,
  testOpsAlertRecipient,
  updateOpsAlertRecipient,
} from '../../../lib/api';
import { CONFIRMATION_PROOF_REFUSAL_MESSAGE, type ConfirmationProofKey } from '../../../lib/confirmation-proof-keys';
import { hasConfirmationProof, hasConfirmationProofs } from '../../../lib/confirmation-proof-server';
import { rethrowNextControlFlow } from '../../../lib/next-control-flow';
import {
  RECIPIENT_LABEL_MAX_LENGTH,
  RECIPIENT_REASON_MAX_LENGTH,
  RECIPIENT_REASON_MIN_LENGTH,
  recipientErrorText,
} from '../../../lib/ops-alert-recipients';
import { recipientStaleKey } from '../../../lib/status-conflicts';
import { LAST_CHANNEL_PROTECTED_TEXT, type RecipientActionState, type RevealOutcome } from './recipient-action-state';
import type { RecipientFormState } from './recipient-form-state';
import { ROUTING_COUNTS_CHANGED_TEXT, type RoutingOpState, type RoutingSwitchState } from './routing-panel-state';

/**
 * Bildirim Ayarları writes (OBS-ALERT-002 PR-B). Each is the API route PR-A
 * built, called once; the API decides every rule (limit, duplicate, address
 * shape, version, the last critical recipient, production's last channel).
 *
 * Adding and editing are the window's own explicit submit and ask for no
 * proof. The risky moves do, and each action verifies it **before** it calls
 * the API (`confirmation-proof.ts`): pausing, deleting, replacing an address,
 * revealing one — and, on top of the action's own proof, the last-critical
 * proof whenever a submission carries `confirmLastCritical=true`. That flag is
 * only drawn into a form after the API answered LAST_CRITICAL_CONFIRM_REQUIRED
 * (`last-critical-step.tsx`), and a hand-typed one without both proofs writes
 * nothing. Resuming and a test send are plain submits.
 *
 * The routing panel's writes (task B4) are a SUPER_ADMIN's: the API reserves
 * OPS_ALERT_ROUTING_MANAGE to the root role and the page draws the panel for
 * no one else. Importing OPS_ALERT_EMAIL is a plain submit (a recipient like
 * any other, deletable); the cutover and the revert verify their own proof and
 * send only the preview's token (and, for a revert, the operator's
 * `cancelUnmatched` tick) — never a number the client could choose; the API
 * recomputes the preview under its locks and answers COUNTS_CHANGED when it
 * moved. Rewrap and rehash each verify their own proof.
 *
 * Nothing here logs or returns an address — with one exception by design:
 * `revealRecipientAction` answers it to the dialog that asked, and nowhere
 * else (no redirect, no cookie, no revalidation, no log line).
 */

const PATH = '/system-health/notification-settings';

const PAUSE: ConfirmationProofKey = 'ops-alert-recipient.pause';
const DELETE: ConfirmationProofKey = 'ops-alert-recipient.delete';
const REPLACE: ConfirmationProofKey = 'ops-alert-recipient.replace';
const REVEAL: ConfirmationProofKey = 'ops-alert-recipient.reveal';
const LAST_CRITICAL: ConfirmationProofKey = 'ops-alert-recipient.last-critical';
const CUTOVER: ConfirmationProofKey = 'ops-alert-routing.cutover';
const REVERT: ConfirmationProofKey = 'ops-alert-routing.revert';
const REWRAP: ConfirmationProofKey = 'ops-alert-routing.rewrap';
const REHASH: ConfirmationProofKey = 'ops-alert-routing.rehash';

function readString(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

/** The form's switches travel as hidden "true"/"false" values (the same on every browser). */
function readSwitch(formData: FormData, name: string): boolean {
  return readString(formData, name) === 'true';
}

/** The row a write is about, and the version it was drawn with; null when either is unusable. */
function readTarget(formData: FormData): { recipientId: string; version: number } | null {
  const recipientId = readString(formData, 'recipientId');
  const version = Number(readString(formData, 'version'));
  if (!recipientId || !Number.isInteger(version) || version < 1) return null;
  return { recipientId, version };
}

/** Set only by the second, last-critical step (`last-critical-step.tsx`). */
function readConfirmLastCritical(formData: FormData): boolean {
  return readString(formData, 'confirmLastCritical') === 'true';
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

/**
 * The sentence for a refusal. A coded one is the code's text; one without a
 * code — a class-validator 400, a 403 from the permission guard — is named by
 * its status rather than "Bilinmeyen hata".
 */
function refusalText(error: unknown, code: string | null): string {
  if (code !== null) return recipientErrorText(code);
  if (error instanceof ApiError) {
    if (error.status === 400) return 'Girilen bilgiler kabul edilmedi; alanları kontrol edip yeniden deneyin.';
    if (error.status === 403) return 'Bu işlem için yetkiniz yok.';
    if (error.status === 429) return recipientErrorText('TEST_RATE_LIMITED');
  }
  return recipientErrorText(null);
}

function errorState(message: string, field: 'address' | 'reason' | null, code: string | null = null) {
  return { kind: 'error' as const, message, field, code, at: Date.now() };
}

function proofRefused() {
  return errorState(CONFIRMATION_PROOF_REFUSAL_MESSAGE, null);
}

/**
 * What a refused write of a row action becomes: a stale row goes to the page
 * notice (`status-conflicts.ts`, the window closes and the list shows the row
 * as it is now); the last-critical answer becomes the second step; the
 * last-channel answer its dead end; anything else the sentence for it.
 */
function rowRefusal(error: unknown): RecipientActionState {
  rethrowNextControlFlow(error);
  const code = readCode(error);
  const stale = recipientStaleKey(code);
  if (stale) redirect(`${PATH}?error=${stale}`);
  if (code === 'LAST_CRITICAL_CONFIRM_REQUIRED') return { kind: 'last-critical', at: Date.now() };
  if (code === 'LAST_CHANNEL_PROTECTED') return { kind: 'last-channel', at: Date.now() };
  return errorState(refusalText(error, code), code && ADDRESS_CODES.has(code) ? 'address' : null, code);
}

function done(ok: string): never {
  revalidatePath(PATH);
  revalidatePath('/system-health');
  redirect(`${PATH}?ok=${ok}`);
}

function reasonProblem(reason: string): string | null {
  if (reason.length < RECIPIENT_REASON_MIN_LENGTH) return `Gerekçe en az ${RECIPIENT_REASON_MIN_LENGTH} karakter olmalı.`;
  if (reason.length > RECIPIENT_REASON_MAX_LENGTH) return `Gerekçe en fazla ${RECIPIENT_REASON_MAX_LENGTH} karakter olabilir.`;
  return null;
}

// ---------------------------------------------------------------------------
// Add and edit (task B2; the edit's last-critical step is task B3)
// ---------------------------------------------------------------------------

function formRefusal(error: unknown): RecipientFormState {
  const code = readCode(error);
  return {
    kind: 'error',
    message: refusalText(error, code),
    field: code && ADDRESS_CODES.has(code) ? 'address' : null,
    code,
    at: Date.now(),
  };
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
    return formRefusal(error);
  }

  done('created');
}

/**
 * Saves the edit window. Turning Kritik off on the last critical recipient is
 * refused by the API with LAST_CRITICAL_CONFIRM_REQUIRED (Ruling B-3): the
 * window then shows the second step, whose resubmission carries
 * `confirmLastCritical=true` and must carry the last-critical proof with it.
 */
export async function updateRecipientAction(_previous: RecipientFormState, formData: FormData): Promise<RecipientFormState> {
  const target = readTarget(formData);
  const label = readString(formData, 'label').trim();
  if (!target) return formRefusal(null);
  const problem = labelProblem(label);
  if (problem) return invalid(problem, 'label');
  const confirmLastCritical = readConfirmLastCritical(formData);
  if (confirmLastCritical && !(await hasConfirmationProofs(formData, [LAST_CRITICAL]))) {
    return { kind: 'error', message: CONFIRMATION_PROOF_REFUSAL_MESSAGE, field: null, code: null, at: Date.now() };
  }

  try {
    await updateOpsAlertRecipient(target.recipientId, {
      version: target.version,
      label,
      notifyWarning: readSwitch(formData, 'notifyWarning'),
      notifyCritical: readSwitch(formData, 'notifyCritical'),
      notifyRecovery: readSwitch(formData, 'notifyRecovery'),
      ...(confirmLastCritical ? { confirmLastCritical: true } : {}),
    });
  } catch (error) {
    rethrowNextControlFlow(error);
    const code = readCode(error);
    // The row moved after the form was drawn: the window cannot save against
    // the new version unseen, so the list shows the current row and says so.
    const stale = recipientStaleKey(code);
    if (stale) redirect(`${PATH}?error=${stale}`);
    if (code === 'LAST_CRITICAL_CONFIRM_REQUIRED') return { kind: 'last-critical', at: Date.now() };
    if (code === 'LAST_CHANNEL_PROTECTED') return { kind: 'last-channel', at: Date.now() };
    return formRefusal(error);
  }

  done('updated');
}

// ---------------------------------------------------------------------------
// Row actions (task B3)
// ---------------------------------------------------------------------------

export async function pauseRecipientAction(_previous: RecipientActionState, formData: FormData): Promise<RecipientActionState> {
  const target = readTarget(formData);
  if (!target) return errorState(recipientErrorText(null), null);
  const confirmLastCritical = readConfirmLastCritical(formData);
  if (!(await hasConfirmationProofs(formData, confirmLastCritical ? [PAUSE, LAST_CRITICAL] : [PAUSE]))) return proofRefused();

  try {
    await pauseOpsAlertRecipient(target.recipientId, {
      version: target.version,
      ...(confirmLastCritical ? { confirmLastCritical: true } : {}),
    });
  } catch (error) {
    return rowRefusal(error);
  }
  done('paused');
}

export async function resumeRecipientAction(_previous: RecipientActionState, formData: FormData): Promise<RecipientActionState> {
  const target = readTarget(formData);
  if (!target) return errorState(recipientErrorText(null), null);
  try {
    await resumeOpsAlertRecipient(target.recipientId, { version: target.version });
  } catch (error) {
    return rowRefusal(error);
  }
  done('resumed');
}

export async function deleteRecipientAction(_previous: RecipientActionState, formData: FormData): Promise<RecipientActionState> {
  const target = readTarget(formData);
  if (!target) return errorState(recipientErrorText(null), null);
  const reason = readString(formData, 'reason').trim();
  // Before the proof: a refused reason must not use up the confirmation.
  const problem = reasonProblem(reason);
  if (problem) return errorState(problem, 'reason');
  const confirmLastCritical = readConfirmLastCritical(formData);
  if (!(await hasConfirmationProofs(formData, confirmLastCritical ? [DELETE, LAST_CRITICAL] : [DELETE]))) return proofRefused();

  try {
    await deleteOpsAlertRecipient(target.recipientId, {
      version: target.version,
      reason,
      ...(confirmLastCritical ? { confirmLastCritical: true } : {}),
    });
  } catch (error) {
    return rowRefusal(error);
  }
  done('deleted');
}

const REPLACE_LAST_CRITICAL_TEXT =
  'Bu, kritik bildirim alan son e-posta alıcısı. Adres değiştirilmedi; önce başka bir kritik alıcı ekleyin.';

/**
 * Replaces the address: the API deletes the old recipient and creates its
 * successor with the same label, switches and status (takes WRITE + DELETE).
 * The new address goes to the API once and is never part of an answer.
 */
export async function replaceRecipientAddressAction(
  _previous: RecipientActionState,
  formData: FormData,
): Promise<RecipientActionState> {
  const target = readTarget(formData);
  if (!target) return errorState(recipientErrorText(null), null);
  const address = readString(formData, 'address').trim();
  if (address.length === 0) return errorState('Yeni e-posta adresi zorunludur.', 'address');
  const reason = readString(formData, 'reason').trim();
  const problem = reasonProblem(reason);
  if (problem) return errorState(problem, 'reason');
  if (!(await hasConfirmationProof(formData, REPLACE))) return proofRefused();

  try {
    await replaceOpsAlertRecipientAddress(target.recipientId, { version: target.version, address, reason });
  } catch (error) {
    const refused = rowRefusal(error);
    // The replace window has no second step (its successor keeps status and
    // preferences): either answer is a sentence there, not a confirmation.
    if (refused.kind === 'last-critical') {
      return errorState(REPLACE_LAST_CRITICAL_TEXT, null, 'LAST_CRITICAL_CONFIRM_REQUIRED');
    }
    if (refused.kind === 'last-channel') return errorState(LAST_CHANNEL_PROTECTED_TEXT, null, 'LAST_CHANNEL_PROTECTED');
    return refused;
  }
  done('replaced');
}

/**
 * Shows one address in full (SUPER_ADMIN; the API refuses everyone else and
 * audits every reveal). The answer goes back to the dialog that asked and
 * nowhere else: no redirect (it would put state in a URL), no revalidation (the
 * dialog refreshes the list itself once it has dropped the address), no log.
 */
export async function revealRecipientAction(formData: FormData): Promise<RevealOutcome> {
  const recipientId = readString(formData, 'recipientId');
  if (!recipientId) return { kind: 'error', message: recipientErrorText(null), code: null };
  if (!(await hasConfirmationProof(formData, REVEAL))) {
    return { kind: 'error', message: CONFIRMATION_PROOF_REFUSAL_MESSAGE, code: null };
  }
  try {
    const { address } = await revealOpsAlertRecipient(recipientId);
    return { kind: 'revealed', address };
  } catch (error) {
    rethrowNextControlFlow(error);
    const code = readCode(error);
    return { kind: 'error', message: refusalText(error, code), code };
  }
}

/** One test e-mail now. A failed send is an answer (its result code), not an error; 429 is. */
export async function testRecipientAction(_previous: RecipientActionState, formData: FormData): Promise<RecipientActionState> {
  const recipientId = readString(formData, 'recipientId');
  if (!recipientId) return errorState(recipientErrorText(null), null);
  try {
    const { result } = await testOpsAlertRecipient(recipientId);
    const ok = result === 'SENT';
    revalidatePath(PATH);
    return {
      kind: 'tested',
      ok,
      result,
      message: ok ? 'Test e-postası gönderildi.' : `Test e-postası gönderilemedi: ${recipientErrorText(result)}`,
      at: Date.now(),
    };
  } catch (error) {
    rethrowNextControlFlow(error);
    const code = readCode(error);
    return errorState(refusalText(error, code), null, code);
  }
}

// ---------------------------------------------------------------------------
// Routing panel (task B4) — SUPER_ADMIN only; the API enforces it again
// ---------------------------------------------------------------------------

type RoutingRefusal = { kind: 'error'; message: string; code: string | null; at: number };

function routingError(error: unknown): RoutingRefusal {
  rethrowNextControlFlow(error);
  const code = readCode(error);
  const message = code === 'COUNTS_CHANGED' ? ROUTING_COUNTS_CHANGED_TEXT : refusalText(error, code);
  return { kind: 'error', message, code, at: Date.now() };
}

function routingRefused(message: string): RoutingRefusal {
  return { kind: 'error', message, code: null, at: Date.now() };
}

/** OPS_ALERT_EMAIL as a managed recipient (every notice kind on); the API reads the address itself. */
export async function importEnvRecipientAction(_previous: RoutingOpState, _formData: FormData): Promise<RoutingOpState> {
  try {
    await importOpsAlertEnvRecipient();
  } catch (error) {
    return routingError(error);
  }
  done('imported');
}

/** The API's token is 64 hex characters; the DTO caps it at 128. Anything else was not previewed. */
const TOKEN_MAX_LENGTH = 128;

/**
 * One cutover or revert form: `intent=preview` asks the API what the switch
 * would do and answers it as it came; `intent=apply` sends that preview's
 * token behind the direction's own proof. The token and the tick are checked
 * for shape before the proof, so a malformed submission does not spend it.
 */
export async function routingSwitchAction(_previous: RoutingSwitchState, formData: FormData): Promise<RoutingSwitchState> {
  const direction = readString(formData, 'direction');
  if (direction !== 'CUTOVER' && direction !== 'REVERT') return routingRefused(recipientErrorText(null));

  if (readString(formData, 'intent') !== 'apply') {
    try {
      const preview = direction === 'CUTOVER' ? await previewOpsAlertCutover() : await previewOpsAlertRevert();
      return { kind: 'preview', preview, at: Date.now() };
    } catch (error) {
      return routingError(error);
    }
  }

  const token = readString(formData, 'token');
  if (token.length === 0 || token.length > TOKEN_MAX_LENGTH) return routingRefused('Önce önizleyin; onay önizlemenin sayılarına bağlıdır.');
  if (!(await hasConfirmationProof(formData, direction === 'CUTOVER' ? CUTOVER : REVERT))) {
    return routingRefused(CONFIRMATION_PROOF_REFUSAL_MESSAGE);
  }

  try {
    if (direction === 'CUTOVER') {
      await applyOpsAlertCutover({ token });
    } else {
      const cancelUnmatched = readString(formData, 'cancelUnmatched') === 'true';
      await applyOpsAlertRevert(cancelUnmatched ? { token, cancelUnmatched: true } : { token });
    }
  } catch (error) {
    return routingError(error);
  }
  done(direction === 'CUTOVER' ? 'cutover' : 'reverted');
}

/**
 * A finished key operation ends on the page notice, like every other write:
 * after a full success the page has one key id (or HMAC version) again and
 * the key block that held the form is gone, so a form-local answer would never
 * be seen. Only the two counts travel in the URL — never an address or an id.
 */
function rotationDone(ok: 'rewrapped' | 'rehashed', moved: number, failed: number): never {
  revalidatePath(PATH);
  revalidatePath('/system-health');
  redirect(`${PATH}?ok=${ok}&adet=${moved}&hata=${failed}`);
}

/** Re-encrypts every live recipient not on the active key; the answer is a count, never an address. */
export async function rewrapRecipientsAction(_previous: RoutingOpState, formData: FormData): Promise<RoutingOpState> {
  if (!(await hasConfirmationProof(formData, REWRAP))) return routingRefused(CONFIRMATION_PROOF_REFUSAL_MESSAGE);
  let result: { rewrapped: number; failed: number };
  try {
    result = await rewrapOpsAlertRecipients();
  } catch (error) {
    return routingError(error);
  }
  rotationDone('rewrapped', result.rewrapped, result.failed);
}

/** Re-computes every live recipient's address digest with the current HMAC version. */
export async function rehashRecipientsAction(_previous: RoutingOpState, formData: FormData): Promise<RoutingOpState> {
  if (!(await hasConfirmationProof(formData, REHASH))) return routingRefused(CONFIRMATION_PROOF_REFUSAL_MESSAGE);
  let result: { rehashed: number; failed: number };
  try {
    result = await rehashOpsAlertRecipients();
  } catch (error) {
    return routingError(error);
  }
  rotationDone('rehashed', result.rehashed, result.failed);
}
