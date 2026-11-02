/**
 * What the recipient row actions' server actions answer (OBS-ALERT-002 PR-B),
 * kept out of `actions.ts` because a `'use server'` file may export only async
 * functions.
 *
 * A finished write redirects (the list shows the result), so the state only
 * carries what has to stay on screen:
 *
 * - `error` — a refusal's sentence (never the address), the API code, and the
 *   field it is about when there is one;
 * - `last-critical` — the API answered LAST_CRITICAL_CONFIRM_REQUIRED: the form
 *   offers a second, separate confirmation and resubmits with
 *   `confirmLastCritical=true`;
 * - `last-channel` — LAST_CHANNEL_PROTECTED: a dead end, nothing to confirm;
 * - `tested` — a test send's closed result code and its sentence.
 *
 * The revealed address is not a state: `revealRecipientAction` answers it to
 * the dialog that asked, which holds it until it closes.
 */
export type RecipientActionState =
  | { kind: 'idle' }
  | { kind: 'error'; message: string; field: 'address' | 'reason' | null; code: string | null; at: number }
  | { kind: 'last-critical'; at: number }
  | { kind: 'last-channel'; at: number }
  | { kind: 'tested'; ok: boolean; result: string; message: string; at: number };

export const RECIPIENT_ACTION_IDLE: RecipientActionState = { kind: 'idle' };

/** What the reveal dialog gets back: the address, or why not. */
export type RevealOutcome = { kind: 'revealed'; address: string } | { kind: 'error'; message: string; code: string | null };

/** The second confirmation's warning (spec §0.10), word for word. */
export const LAST_CRITICAL_WARNING =
  'Bu, kritik bildirim alan son e-posta alıcısı. Telegram yapılandırılmış olsa da e-posta ile kritik bildirim gelmeyecek.';

/** Production's last live alert channel: said instead of a confirmation. */
export const LAST_CHANNEL_PROTECTED_TEXT =
  "Production'da son etkin bildirim kanalı kaldırılamaz. Önce başka bir kritik alıcı ekleyin.";

/** The answers that put a form on its second step (`last-critical-step.tsx`). */
export type SecondStep = Extract<RecipientActionState, { kind: 'last-critical' | 'last-channel' }>;

/**
 * A row form's state with its second step held apart from the last answer:
 * once the API has asked for the second confirmation, a later refusal in that
 * step (a reason too short, a proof that did not verify) shows its sentence
 * without dropping the form back to the first step and its `confirmLastCritical`.
 */
export type SteppedActionState = { state: RecipientActionState; step: SecondStep | null };

export const STEPPED_ACTION_IDLE: SteppedActionState = { state: RECIPIENT_ACTION_IDLE, step: null };

/** Wraps a row action for `useActionState`, carrying the second step across answers. */
export function withSecondStep(
  action: (previous: RecipientActionState, formData: FormData) => Promise<RecipientActionState>,
): (previous: SteppedActionState, formData: FormData) => Promise<SteppedActionState> {
  return async (previous, formData) => {
    const state = await action(previous.state, formData);
    const step = state.kind === 'last-critical' || state.kind === 'last-channel' ? state : previous.step;
    return { state, step };
  };
}
