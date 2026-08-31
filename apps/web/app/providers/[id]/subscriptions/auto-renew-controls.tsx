'use client';

import { useActionState } from 'react';
import {
  cancelAutoRenewAction,
  setAutoRenewAction,
  type SubscriptionActionState,
} from './actions';

const EMPTY: SubscriptionActionState = { error: null, notice: null };

/**
 * The renewal controls for one period.
 *
 * When the payment adapter cannot charge a stored payment method the switch is
 * not rendered at all — not disabled, not labelled "yakında". A control that
 * looks like it might work is the thing the product rule specifically forbids,
 * so what the provider sees instead is a sentence saying renewal is manual and
 * a link to buy the same package again.
 */
export function AutoRenewControls({
  providerId,
  entitlementId,
  autoRenewEnabled,
  autoRenewAvailable,
  cancelledAt,
}: {
  providerId: string;
  entitlementId: string;
  autoRenewEnabled: boolean;
  autoRenewAvailable: boolean;
  cancelledAt: string | null;
}) {
  const [enableState, enableAction, enablePending] = useActionState(setAutoRenewAction, EMPTY);
  const [cancelState, cancelAction, cancelPending] = useActionState(cancelAutoRenewAction, EMPTY);
  const state = enableState.error || enableState.notice ? enableState : cancelState;

  /*
   * With no adapter able to charge, an already-off period gets no switch at
   * all — a control that looks like it might work is exactly what the product
   * rule forbids. What it gets instead is the manual path, which works.
   */
  const manualOnly = !autoRenewAvailable && !autoRenewEnabled;

  return (
    <div className="pdash-form">
      {manualOnly ? (
        <>
          <span className="pkg-note" data-testid="manual-renewal-note">
            Otomatik yenileme kapalı. Dönem bittiğinde aynı paketi bu sayfadan elle
            yenileyebilirsiniz.
          </span>
          <a className="pdash-btn pdash-btn-block" href="#satin-al">
            Elle yenile
          </a>
        </>
      ) : (
        <>
          <span className="pkg-note" data-testid="auto-renew-state">
            Otomatik yenileme: <strong>{autoRenewEnabled ? 'Açık' : 'Kapalı'}</strong>
            {cancelledAt && !autoRenewEnabled
              ? ' — mevcut dönem bitiş tarihine kadar geçerli.'
              : ''}
          </span>

          {autoRenewEnabled ? (
            <form action={cancelAction}>
              <input type="hidden" name="providerId" value={providerId} />
              <input type="hidden" name="entitlementId" value={entitlementId} />
              <button className="pdash-btn pdash-btn-block" type="submit" disabled={cancelPending}>
                Yenilemeyi iptal et
              </button>
            </form>
          ) : (
            <form action={enableAction}>
              <input type="hidden" name="providerId" value={providerId} />
              <input type="hidden" name="entitlementId" value={entitlementId} />
              <input type="hidden" name="enabled" value="true" />
              <button
                className="pdash-btn pdash-btn-block"
                type="submit"
                disabled={enablePending || !autoRenewAvailable}
              >
                Otomatik yenilemeyi aç
              </button>
            </form>
          )}
        </>
      )}

      {/*
        * Rendered outside the branch above on purpose. Cancelling flips the
        * card into the manual-only shape, and a confirmation that disappeared
        * at the moment the thing it confirms happened would leave the provider
        * unsure whether the click did anything.
        */}
      {state.error ? (
        <p className="pdash-form-error" data-testid="auto-renew-error">
          {state.error}
        </p>
      ) : null}
      {state.notice ? (
        <p className="pkg-note" data-testid="auto-renew-notice">
          {state.notice}
        </p>
      ) : null}
    </div>
  );
}
