'use client';

import { useActionState } from 'react';
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
 */

export function RevokeRedemptionForm({ campaignId, redemptionId }: { campaignId: string; redemptionId: string }) {
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
      <button className="btn btn-danger btn-sm" type="submit" disabled={pending} data-testid="campaign-revoke">
        Geri al
      </button>
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
