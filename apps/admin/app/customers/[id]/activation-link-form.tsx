'use client';

import { formatDateTime } from '@taktic/shared';
import { useActionState, useState } from 'react';
import { ConfirmDialog } from '../../../components/confirm-dialog';
import { createCustomerActivationLinkAction } from '../actions';
import { ACTIVATION_LINK_IDLE } from '../activation-link-state';

/**
 * Issues a password-set link and shows it to the operator once.
 *
 * The link is a live credential: whoever opens it can set the account's
 * password for the next 72 hours. It used to come back as a query parameter
 * (`?activationUrl=…`), which left it in the browser history, in any access
 * log in between, and in the `Referer` of the next page opened. Here it lives
 * only in this component's action state. It is shown in the response to the
 * button press and is gone after a navigation or a refresh.
 *
 * "Bağlantıyı kopyala" writes that same string to the operator's clipboard and
 * nowhere else — no request, no URL, no log. Issuing again replaces the link:
 * the API marks every unused earlier link as used, so "Yeni bağlantı oluştur"
 * asks first (ADMIN-DESTRUCTIVE-CONFIRMATION-001, Faz 2) and posts
 * `replaces=1`, which makes the action demand the dialog's proof. The first
 * link goes straight through.
 *
 * It still works without JavaScript: `useActionState` forms submit normally
 * and React renders the returned state on the server.
 */
export function ActivationLinkForm({ customerId }: { customerId: string }) {
  const [state, submit, pending] = useActionState(
    createCustomerActivationLinkAction,
    ACTIVATION_LINK_IDLE,
  );
  const [copied, setCopied] = useState<string | null>(null);
  const issued = state.kind === 'issued';
  // A refused or failed reissue keeps the reissue button: the link handed out
  // before may still be live, and the next press would void it too.
  const reissue = issued || (state.kind === 'error' && state.reissue === true);

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
    } catch {
      setCopied(null);
    }
  }

  return (
    <div className="activation-link">
      {state.kind === 'error' ? (
        <div className="notice notice-error" role="alert" data-testid="customer-activation-error">
          {state.message}
        </div>
      ) : null}

      {issued ? (
        <div className="activation-link-block" data-testid="customer-activation-block">
          <p className="activation-link-title">Oluşturulan bağlantı · 72 saat geçerli</p>
          <code className="activation-link-url" data-testid="customer-activation-url">
            {state.activationUrl}
          </code>
          <p className="activation-link-meta">
            Son geçerlilik: {formatDateTime(state.expiresAt)} · bu ekrandan ayrılınca bir daha
            gösterilmez
          </p>
        </div>
      ) : null}

      <div className="detail-form-actions">
        {issued ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => copy(state.activationUrl)}
            data-testid="customer-activation-copy"
          >
            {copied === state.activationUrl ? 'Kopyalandı' : 'Bağlantıyı kopyala'}
          </button>
        ) : null}
        <form action={submit}>
          <input type="hidden" name="customerId" value={customerId} />
          {reissue ? (
            <>
              <input type="hidden" name="replaces" value="1" />
              <ConfirmDialog
                proof="customer.activation-link-reissue"
                triggerLabel="Yeni bağlantı oluştur"
                triggerClassName="btn btn-link btn-sm"
                title="Yeni bağlantı oluşturulsun mu?"
                consequence={ACTIVATION_LINK_REISSUE_CONSEQUENCE}
                confirmLabel="Evet, yeni bağlantı oluştur"
                tone="primary"
                disabled={pending}
                testId="customer-activation-issue"
              />
            </>
          ) : (
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={pending}
              data-testid="customer-activation-issue"
            >
              Şifre belirleme bağlantısı oluştur
            </button>
          )}
        </form>
      </div>
      {reissue ? (
        <p className="detail-muted-note">Yeni bağlantı oluşturmak bu bağlantıyı geçersiz kılar.</p>
      ) : null}
    </div>
  );
}

/** What `POST /customers/:id/activation-link` does to the link already handed out. */
export const ACTIVATION_LINK_REISSUE_CONSEQUENCE = (
  <>
    <p>
      Daha önce oluşturulan ve henüz kullanılmamış şifre belirleme bağlantısı hemen geçersiz olur. Müşteriye
      onu ilettiyseniz o bağlantıyla artık şifre belirleyemez; yeni bağlantıyı yeniden paylaşmanız gerekir.
    </p>
    <p>Yeni bağlantı 72 saat geçerlidir ve yalnız bu ekranda bir kez gösterilir. Müşteriye otomatik mesaj gitmez.</p>
  </>
);
