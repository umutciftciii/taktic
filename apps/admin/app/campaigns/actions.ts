'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  ApiError,
  apiFetch,
  type CampaignDetailResponse,
  type CampaignStatus,
  type CampaignRuleError,
  type CampaignValidationResponse,
} from '../../lib/api';
import { rethrowNextControlFlow } from '../../lib/next-control-flow';
import type { CampaignFormState } from './form-state';
import type { CampaignLifecycleState } from './lifecycle-state';
import { hasConfirmationProof } from '../../lib/confirmation-proof-server';
import { CONFIRMATION_PROOF_REFUSAL_MESSAGE, type ConfirmationProofKey } from '../../lib/confirmation-proof-keys';
import { campaignVersionProofKey } from './lifecycle-proof';

/**
 * The builder's two verbs: check, and save.
 *
 * Both post the definition the form assembled (as one JSON field the operator
 * never sees or edits) and both hand it to the API, which is the only judge
 * of it. "Check" calls the validate-only route and writes nothing; "save"
 * creates the campaign or adds a version, and redirects to the detail on
 * success. On refusal the API's field-level errors come back as the action's
 * state, so the form can put each sentence beside the input it names.
 *
 * Nothing about who is doing this travels in the payload; the API takes the
 * operator from the session.
 */

type ParsedSubmission =
  | { ok: true; intent: 'validate' | 'save'; key: string; name: string; campaignId: string | null; definition: unknown }
  | { ok: false; message: string };

function readString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function parseSubmission(formData: FormData): ParsedSubmission {
  const intent = readString(formData, 'intent');
  if (intent !== 'validate' && intent !== 'save') {
    return { ok: false, message: 'Bilinmeyen işlem.' };
  }
  const raw = readString(formData, 'definition');
  let definition: unknown;
  try {
    definition = JSON.parse(raw);
  } catch {
    return { ok: false, message: 'Form verisi okunamadı; sayfayı yenileyip tekrar deneyin.' };
  }
  const campaignId = readString(formData, 'campaignId').trim() || null;
  return {
    ok: true,
    intent,
    key: readString(formData, 'key').trim(),
    name: readString(formData, 'name').trim(),
    campaignId,
    definition,
  };
}

export async function campaignFormAction(
  _previous: CampaignFormState,
  formData: FormData,
): Promise<CampaignFormState> {
  const parsed = parseSubmission(formData);
  if (!parsed.ok) {
    return { status: 'error', errors: [], summary: null, message: parsed.message };
  }

  if (parsed.intent === 'validate') {
    return validateOnly(parsed.definition);
  }

  // Client-side only the two identity fields, and only on creation: they are
  // not part of the rule language and the API refuses them separately.
  if (parsed.campaignId === null) {
    if (parsed.key === '') {
      return { status: 'error', errors: [], summary: null, message: 'Kampanya anahtarı zorunludur.' };
    }
    if (parsed.name === '') {
      return { status: 'error', errors: [], summary: null, message: 'Kampanya adı zorunludur.' };
    }
  }

  let target: string | null = null;
  let failure: CampaignFormState | null = null;
  try {
    if (parsed.campaignId === null) {
      const created = await apiFetch<CampaignDetailResponse>('/admin/campaigns', {
        method: 'POST',
        body: JSON.stringify({ key: parsed.key, name: parsed.name, definition: parsed.definition }),
      });
      target = `/campaigns/${created.campaign.id}?ok=created`;
    } else {
      const revised = await apiFetch<CampaignDetailResponse>(
        `/admin/campaigns/${encodeURIComponent(parsed.campaignId)}/versions`,
        { method: 'POST', body: JSON.stringify({ definition: parsed.definition }) },
      );
      target = `/campaigns/${revised.campaign.id}?ok=revised&v=${revised.currentVersion?.versionNumber ?? ''}`;
    }
  } catch (error) {
    rethrowNextControlFlow(error);
    failure = failureState(error);
  }

  if (failure) {
    return failure;
  }

  revalidatePath('/campaigns');
  if (parsed.campaignId) revalidatePath(`/campaigns/${parsed.campaignId}`);
  redirect(target!);
}

async function validateOnly(definition: unknown): Promise<CampaignFormState> {
  try {
    const result = await apiFetch<CampaignValidationResponse>('/admin/campaigns/validate', {
      method: 'POST',
      body: JSON.stringify({ definition }),
    });
    return result.valid
      ? { status: 'valid', errors: [], summary: result.summary, message: null }
      : { status: 'invalid', errors: result.errors, summary: null, message: null };
  } catch (error) {
    rethrowNextControlFlow(error);
    return failureState(error);
  }
}

/** The API's structured refusal when it sent one; its sentence otherwise. */
function failureState(error: unknown): CampaignFormState {
  if (error instanceof ApiError) {
    try {
      const body = JSON.parse(error.body) as {
        code?: string;
        message?: string | string[];
        errors?: CampaignRuleError[];
      };
      if (body.code === 'CAMPAIGN_DEFINITION_INVALID' && Array.isArray(body.errors)) {
        return { status: 'invalid', errors: body.errors, summary: null, message: null };
      }
      const message = Array.isArray(body.message) ? body.message.join(' · ') : body.message;
      return { status: 'error', errors: [], summary: null, message: message || 'İşlem başarısız.' };
    } catch {
      return { status: 'error', errors: [], summary: null, message: error.body || 'İşlem başarısız.' };
    }
  }
  return { status: 'error', errors: [], summary: null, message: 'Beklenmeyen hata.' };
}

// ───────────────────────────── lifecycle (S2B2) ─────────────────────────────

const LIFECYCLE_INTENTS = new Set(['activate', 'pause', 'resume', 'end', 'close']);

/** The proof each non-activation move needs; an activation's depends on the status (`campaignVersionProofKey`). */
const LIFECYCLE_PROOF: Record<string, ConfirmationProofKey> = {
  pause: 'campaign.pause',
  resume: 'campaign.resume',
  end: 'campaign.end',
  close: 'campaign.close-draft',
};

/** The campaign's status as the API has it now, or null when it cannot be read. */
async function readCampaignStatus(campaignId: string): Promise<CampaignStatus | null> {
  try {
    const detail = await apiFetch<CampaignDetailResponse>(`/admin/campaigns/${encodeURIComponent(campaignId)}`);
    return detail?.campaign?.status ?? null;
  } catch (error) {
    rethrowNextControlFlow(error);
    return null;
  }
}

/**
 * Activate a version, pause, resume or end — each one POST to the matching
 * SUPER_ADMIN route, nothing decided here. `close` is the draft's own name
 * for the same `end` route (BUG-OPS-002): a DRAFT closed without ever
 * running, confirmed with its own sentence. A refusal comes back as the
 * action's state so the panel can show the API's sentence (and, for an
 * activation, the field-level reasons) beside the buttons; success redirects
 * to the detail with a one-word marker for the confirmation notice.
 *
 * The engine switch is not writable from any admin screen; while it is off
 * the API answers activate/resume with CAMPAIGN_ENGINE_DISABLED and that is
 * exactly what the panel shows.
 */
export async function campaignLifecycleAction(
  _previous: CampaignLifecycleState,
  formData: FormData,
): Promise<CampaignLifecycleState> {
  const intent = readString(formData, 'intent');
  const campaignId = readString(formData, 'campaignId').trim();
  if (!LIFECYCLE_INTENTS.has(intent) || campaignId === '') {
    return { status: 'error', message: 'Bilinmeyen işlem.', errors: [] };
  }
  const reason = readString(formData, 'reason').trim();
  if (intent !== 'activate' && reason.length < 3) {
    return { status: 'error', message: 'Gerekçe en az 3 karakter olmalı.', errors: [] };
  }
  // Every move here is asked in a dialog; the dialog's proof is checked before
  // anything is sent (ADMIN-DESTRUCTIVE-CONFIRMATION-001). An activation's key
  // depends on what the campaign is now — read from the API, never from the
  // form — and the API is told that status, so a move confirmed as "switch"
  // cannot land as a resumption.
  let activation: { versionNumber: number; expectedStatus: CampaignStatus } | null = null;
  if (intent === 'activate') {
    const versionNumber = Number.parseInt(readString(formData, 'versionNumber'), 10);
    if (!Number.isInteger(versionNumber) || versionNumber < 1) {
      return { status: 'error', message: 'Sürüm numarası okunamadı.', errors: [] };
    }
    const current = await readCampaignStatus(campaignId);
    if (current === null) {
      return { status: 'error', message: 'Kampanyanın güncel durumu okunamadı; hiçbir şey gönderilmedi. Sayfayı yenileyin.', errors: [] };
    }
    const key = campaignVersionProofKey(current);
    if (key === null) {
      return { status: 'error', message: 'Sona ermiş bir kampanyada sürüm etkinleştirilemez.', errors: [] };
    }
    if (current === 'PAUSED' && reason.length < 3) {
      return { status: 'error', message: 'Duraklatılmış kampanyayı devam ettirmek için gerekçe en az 3 karakter olmalı.', errors: [] };
    }
    if (!(await hasConfirmationProof(formData, key))) {
      return { status: 'error', message: CONFIRMATION_PROOF_REFUSAL_MESSAGE, errors: [] };
    }
    activation = { versionNumber, expectedStatus: current };
  } else if (!(await hasConfirmationProof(formData, LIFECYCLE_PROOF[intent]!))) {
    return { status: 'error', message: CONFIRMATION_PROOF_REFUSAL_MESSAGE, errors: [] };
  }

  let failure: CampaignLifecycleState | null = null;
  try {
    const base = `/admin/campaigns/${encodeURIComponent(campaignId)}`;
    if (activation) {
      await apiFetch(`${base}/versions/${activation.versionNumber}/activate`, {
        method: 'POST',
        body: JSON.stringify({ expectedStatus: activation.expectedStatus, ...(reason ? { reason } : {}) }),
      });
    } else {
      const verb = intent === 'close' ? 'end' : intent;
      await apiFetch(`${base}/${verb}`, { method: 'POST', body: JSON.stringify({ reason }) });
    }
  } catch (error) {
    rethrowNextControlFlow(error);
    failure = lifecycleFailure(error);
  }

  if (failure) {
    return failure;
  }

  revalidatePath('/campaigns');
  revalidatePath(`/campaigns/${campaignId}`);
  redirect(`/campaigns/${campaignId}?ok=${intent}`);
}

function lifecycleFailure(error: unknown): CampaignLifecycleState {
  if (error instanceof ApiError) {
    try {
      const body = JSON.parse(error.body) as { code?: string; message?: string | string[]; errors?: CampaignRuleError[] };
      const message = Array.isArray(body.message) ? body.message.join(' · ') : body.message;
      if (body.code === 'CAMPAIGN_ACTIVATION_REFUSED' && Array.isArray(body.errors)) {
        return { status: 'error', message: message || 'Sürüm etkinleştirilemedi.', errors: body.errors };
      }
      return { status: 'error', message: message || 'İşlem başarısız.', errors: [] };
    } catch {
      return { status: 'error', message: error.body || 'İşlem başarısız.', errors: [] };
    }
  }
  return { status: 'error', message: 'Beklenmeyen hata.', errors: [] };
}

// ───────────────────────── operations desk (CMP-003 S3) ─────────────────────────

/**
 * Revoke one redemption with a reason, or put one parked event back in the
 * worker's queue — each one POST to the matching SUPER_ADMIN route, nothing
 * decided here. The API's refusal (already revoked, not retryable, engine
 * off, …) comes back as the action's state beside the row; success reloads
 * the detail with a one-word marker for the confirmation notice.
 */
export async function campaignOperationAction(
  _previous: CampaignLifecycleState,
  formData: FormData,
): Promise<CampaignLifecycleState> {
  const intent = readString(formData, 'intent');
  const campaignId = readString(formData, 'campaignId').trim();
  const targetId = readString(formData, 'targetId').trim();
  if ((intent !== 'revoke' && intent !== 'retry') || campaignId === '' || targetId === '') {
    return { status: 'error', message: 'Bilinmeyen işlem.', errors: [] };
  }
  const reason = readString(formData, 'reason').trim();
  if (intent === 'revoke' && reason.length < 3) {
    return { status: 'error', message: 'Gerekçe en az 3 karakter olmalı.', errors: [] };
  }
  if (intent === 'revoke' && !(await hasConfirmationProof(formData, 'campaign.redemption-revoke'))) {
    return { status: 'error', message: CONFIRMATION_PROOF_REFUSAL_MESSAGE, errors: [] };
  }

  let failure: CampaignLifecycleState | null = null;
  try {
    const base = `/admin/campaigns/${encodeURIComponent(campaignId)}`;
    if (intent === 'revoke') {
      await apiFetch(`${base}/redemptions/${encodeURIComponent(targetId)}/revoke`, { method: 'POST', body: JSON.stringify({ reason }) });
    } else {
      await apiFetch(`${base}/evaluation-events/${encodeURIComponent(targetId)}/retry`, { method: 'POST', body: JSON.stringify({}) });
    }
  } catch (error) {
    rethrowNextControlFlow(error);
    failure = lifecycleFailure(error);
  }

  if (failure) {
    return failure;
  }

  revalidatePath('/campaigns');
  revalidatePath(`/campaigns/${campaignId}`);
  redirect(`/campaigns/${campaignId}?ok=${intent}`);
}
