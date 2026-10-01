'use client';

import { useActionState } from 'react';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { campaignOperationAction } from './actions';
import { IDLE_CAMPAIGN_LIFECYCLE_STATE } from './lifecycle-state';

/**
 * The two per-row controls of the operations desk (CMP-003 S3).
 *
 * `RevokeRedemptionForm` offers a reason box and one button for a GRANTED
 * redemption; the API is the only judge — a second click on a row that is
 * already revoked comes back as its 409 sentence, and nothing else happens.
 * `RetryEventButton` is shown only where the API says a retry is possible
 * (RETRY_WAIT, or a lapsed lease) and while the engine is on; it re-queues
 * the event and evaluates nothing itself. Neither control can grant, deduct
 * an arbitrary balance, or turn the engine on.
 *
 * ADMIN-DESIGN-001 Faz 3E: "Geri al" asks first (ConfirmDialog) and says what
 * the revoke will move — the lot's unused credit, from whose balance, and
 * that the campaign may pause itself at its daily threshold. The dialog opens
 * only once the reason is valid; the form and its fields are unchanged.
 */

export function RevokeRedemptionForm({
  campaignId,
  redemptionId,
  providerName,
  grantedCredits,
  remainingCredits,
  revokeThreshold,
}: {
  campaignId: string;
  redemptionId: string;
  providerName: string;
  grantedCredits: number;
  /**
   * The lot's unused credit, what the revoke deducts; null when the row has no
   * lot or the session may not read the balance (FINANCE_LEDGER_READ) — the
   * dialog then names the deduction without a figure.
   */
  remainingCredits: number | null;
  /** The running version's revokes-per-UTC-day before the campaign pauses itself; null = no threshold. */
  revokeThreshold: number | null;
}) {
  const [state, submit, pending] = useActionState(campaignOperationAction, IDLE_CAMPAIGN_LIFECYCLE_STATE);
  return (
    <form action={submit} className="campaign-op-form" data-testid="campaign-revoke-form" data-redemption={redemptionId}>
      <input type="hidden" name="intent" value="revoke" />
      <input type="hidden" name="campaignId" value={campaignId} />
      <input type="hidden" name="targetId" value={redemptionId} />
      <input
        className="campaign-op-reason"
        name="reason"
        minLength={3}
        maxLength={500}
        required
        placeholder="Gerekçe (3–500)"
        aria-label="Geri alma gerekçesi"
        data-testid="campaign-revoke-reason"
      />
      <ConfirmDialog
        proof="campaign.redemption-revoke"
        triggerLabel="Geri al"
        triggerClassName="btn btn-destructive btn-sm"
        title="Hak ediş geri alınsın mı?"
        consequence={
          <RevokeConsequence
            providerName={providerName}
            grantedCredits={grantedCredits}
            remainingCredits={remainingCredits}
            revokeThreshold={revokeThreshold}
          />
        }
        confirmLabel="Evet, geri al"
        disabled={pending}
        testId="campaign-revoke"
      />
      {state.status === 'error' ? (
        <div className="notice notice-error campaign-op-error" role="status" data-testid="campaign-revoke-error">
          {state.message}
        </div>
      ) : null}
    </form>
  );
}

export function RetryEventButton({ campaignId, eventId }: { campaignId: string; eventId: string }) {
  const [state, submit, pending] = useActionState(campaignOperationAction, IDLE_CAMPAIGN_LIFECYCLE_STATE);
  return (
    <form action={submit} className="campaign-op-form" data-testid="campaign-retry-form" data-event={eventId}>
      <input type="hidden" name="intent" value="retry" />
      <input type="hidden" name="campaignId" value={campaignId} />
      <input type="hidden" name="targetId" value={eventId} />
      <button className="btn btn-secondary btn-sm" type="submit" disabled={pending} data-testid="campaign-retry">
        Kuyruğa al
      </button>
      {state.status === 'error' ? (
        <div className="notice notice-error campaign-op-error" role="status" data-testid="campaign-retry-error">
          {state.message}
        </div>
      ) : null}
    </form>
  );
}

/** What a revoke does, in the order the API does it (CampaignRevokeService). */
export function RevokeConsequence({
  providerName,
  grantedCredits,
  remainingCredits,
  revokeThreshold,
}: {
  providerName: string;
  grantedCredits: number;
  remainingCredits: number | null;
  revokeThreshold: number | null;
}) {
  return (
    <>
      <p>
        {remainingCredits === null ? (
          <>Bu hak edişin kullanılmamış promosyon kredisi</>
        ) : (
          <>
            Verilen {grantedCredits} promosyon kredisinden kullanılmamış <strong>{remainingCredits} kredi</strong>
          </>
        )}{' '}
        <strong>{providerName}</strong> bakiyesinden düşülür; harcanmış kısım yalnız kayda geçer, borç oluşmaz. Hak ediş
        “Geri alındı” olur ve bir daha geri alınamaz ya da verilemez.
      </p>
      <p>
        {revokeThreshold === null
          ? 'Bu sürümde günlük geri alma eşiği yok; kampanya durumu değişmez.'
          : `Bugünkü (UTC) geri alma sayısı ${revokeThreshold} eşiğini aşarsa kampanya kendini duraklatır.`}{' '}
        Gerekçe adınızla kampanyanın “Neler oldu” kaydına yazılır. Hizmet verene e-posta gönderilmez.
      </p>
    </>
  );
}
