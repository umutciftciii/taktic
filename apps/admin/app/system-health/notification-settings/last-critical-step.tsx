'use client';

import { ConfirmGate } from '../../../components/confirm-gate';
import type { ConfirmationProofKey } from '../../../lib/confirmation-proof-keys';
import { LAST_CHANNEL_PROTECTED_TEXT, LAST_CRITICAL_WARNING, type RecipientActionState } from './recipient-action-state';
import type { RecipientFormState } from './recipient-form-state';

/**
 * The second step of a change that would silence the last critical e-mail
 * recipient (OBS-ALERT-002 spec §0.10), dropped inside the form whose first
 * submit the API refused:
 *
 * - LAST_CRITICAL_CONFIRM_REQUIRED (`last-critical`): the warning, a hidden
 *   `confirmLastCritical=true`, and a separate ConfirmGate that mints the
 *   action's own proof (`leadProof`, when it has one) *and* the last-critical
 *   proof — the server action demands both for a submission that carries the
 *   flag, so the flag alone, typed by hand, writes nothing.
 * - LAST_CHANNEL_PROTECTED (`last-channel`): production's last live channel.
 *   There is nothing to confirm, so no button is offered; only what to do.
 *
 * Anything else draws nothing.
 */
export function LastCriticalStep({
  state,
  leadProof,
  confirmLabel,
  testId,
}: {
  state: RecipientActionState | RecipientFormState;
  /** The proof of the action itself (pause, delete); null for the edit form, whose save is not gated. */
  leadProof: ConfirmationProofKey | null;
  confirmLabel: string;
  testId: string;
}) {
  if (state.kind === 'last-channel') {
    return (
      <p className="notice notice-error" role="alert" data-testid={`${testId}-blocked`}>
        {LAST_CHANNEL_PROTECTED_TEXT}
      </p>
    );
  }
  if (state.kind !== 'last-critical') return null;

  const proofs: ConfirmationProofKey[] = leadProof
    ? [leadProof, 'ops-alert-recipient.last-critical']
    : ['ops-alert-recipient.last-critical'];
  return (
    <div className="cell-stack" data-testid={testId}>
      <p className="notice notice-warning" role="alert">
        {LAST_CRITICAL_WARNING}
      </p>
      <input type="hidden" name="confirmLastCritical" value="true" />
      <ConfirmGate
        triggerLabel={confirmLabel}
        triggerClassName="btn btn-destructive btn-sm"
        testId={`${testId}-confirm`}
        evaluate={() => ({
          proofs,
          title: 'Son kritik e-posta alıcısı',
          consequence: (
            <>
              <p>{LAST_CRITICAL_WARNING}</p>
              <p>Devam ederseniz kritik alarmlar e-postayla kimseye gitmez.</p>
            </>
          ),
          confirmLabel,
          tone: 'danger',
        })}
      />
    </div>
  );
}
