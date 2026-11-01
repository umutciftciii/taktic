'use client';

import { useActionState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { ConfirmDialog } from '../../../components/confirm-dialog';
import { ConfirmGate } from '../../../components/confirm-gate';
import { DataTable } from '../../../components/data-table';
import {
  recipientErrorText,
  type RoutingDirection,
  type RoutingPendingStatus,
  type RoutingPreview,
  type RoutingState,
} from '../../../lib/ops-alert-recipients';
import { OPS_ALERT_DELIVERY_LABELS } from '../../../lib/system-health';
import {
  importEnvRecipientAction,
  rehashRecipientsAction,
  rewrapRecipientsAction,
  routingSwitchAction,
} from './actions';
import {
  ROUTING_OP_IDLE,
  ROUTING_SWITCH_IDLE,
  routingCancelTotal,
  type RoutingOpState,
  type RoutingSwitchState,
} from './routing-panel-state';

/**
 * Where operations-alert e-mail goes (OBS-ALERT-002 PR-B, task B4): the
 * SUPER_ADMIN's routing panel on Bildirim ayarları. The page draws it for a
 * SUPER_ADMIN only — every call here needs OPS_ALERT_ROUTING_MANAGE, which no
 * role can carry — and the API checks it again.
 *
 * In ENV_LEGACY it walks the cutover: ① import OPS_ALERT_EMAIL as a managed
 * recipient (hidden when the env address is unset; a tick when it is already
 * managed), ② send it a test e-mail from the list, ③ preview the cutover and
 * approve it. In MANAGED it offers the revert, laid out the same way. Each
 * preview is the API's, printed as it came; the approval sends that preview's
 * token behind the direction's own confirmation, and the API refuses with
 * COUNTS_CHANGED if anything moved in between. A blocker is said in words and
 * leaves no approval to click. A revert that cancels deliveries (or leaves
 * another recipient's send in flight) asks a separate, required tick.
 *
 * Rewrap and rehash appear only while a rotation is under way: several
 * encryption key ids, or several HMAC versions, among the live recipients.
 */

type RoutingPanelInput = Pick<RoutingState, 'emailRouting' | 'envAddressConfigured' | 'envAddressManaged' | 'keyIds' | 'hmacVersions'>;

export function RoutingPanel({ routing }: { routing: RoutingPanelInput }) {
  const rewrap = Object.keys(routing.keyIds).length > 1;
  const rehash = Object.keys(routing.hmacVersions).length > 1;
  return (
    <div className="ops-alert-routing" data-routing={routing.emailRouting}>
      {routing.emailRouting === 'ENV_LEGACY' ? (
        <ol className="ops-alert-routing-steps">
          {routing.envAddressConfigured ? (
            <li>
              {routing.envAddressManaged ? (
                <p data-testid="ops-alert-routing-imported">Env adresi yönetilen listede ✓</p>
              ) : (
                <ImportForm />
              )}
            </li>
          ) : null}
          <li>
            <p data-testid="ops-alert-routing-test-reminder">
              Geçişten önce yönetilen alıcılara listeden “Test gönder” ile bir deneme e-postası gönderin ve geldiğini doğrulayın.
              Geçişten sonra alarm e-postaları yalnız listedeki alıcılara gider.
            </p>
          </li>
          <li>
            {/* Keyed by mode: after a switch the page comes back in the other mode with a fresh form. */}
            <SwitchForm key="CUTOVER" direction="CUTOVER" />
          </li>
        </ol>
      ) : (
        <>
          <p>
            Alarm e-postaları yönetilen alıcılara gidiyor. Geri dönüş, bildirimleri yeniden yalnız OPS_ALERT_EMAIL adresine
            gönderir.
          </p>
          <SwitchForm key="REVERT" direction="REVERT" />
        </>
      )}
      {rewrap || rehash ? (
        <div className="cell-stack" data-testid="ops-alert-routing-keys">
          <p className="cell-muted">
            Anahtar değişimi sürüyor: alıcıların bir kısmı eski anahtarla saklanıyor. Etkin anahtar ortamda tanımlandıktan sonra
            alıcıları ona taşıyın.
          </p>
          {/* A finished run ends on the page notice (`?ok=rewrapped|rehashed`): after a
              full success this block is gone, so the result cannot live in it. */}
          {rewrap ? (
            <RotationForm action={rewrapRecipientsAction} testId="ops-alert-routing-rewrap">
              <ConfirmDialog
                triggerLabel="Şifrelemeyi yenile"
                proof="ops-alert-routing.rewrap"
                triggerClassName="btn btn-secondary btn-sm"
                title="Şifreleme anahtarını yenile"
                consequence={
                  <p>
                    Etkin olmayan anahtarla saklanan her alıcının adresi çözülüp etkin anahtarla yeniden şifrelenir. Adresler
                    değişmez; her alıcı için geçmişe bir kayıt düşer.
                  </p>
                }
                confirmLabel="Evet, yeniden şifrele"
                tone="primary"
                testId="ops-alert-routing-rewrap"
              />
            </RotationForm>
          ) : null}
          {rehash ? (
            <RotationForm action={rehashRecipientsAction} testId="ops-alert-routing-rehash">
              <ConfirmDialog
                triggerLabel="Adres özetini yenile"
                proof="ops-alert-routing.rehash"
                triggerClassName="btn btn-secondary btn-sm"
                title="Adres özetini yenile"
                consequence={
                  <p>
                    Güncel olmayan sürümle hesaplanmış her alıcının adres özeti güncel sürümle yeniden hesaplanır. Aynı adresli
                    iki alıcı çıkarsa o alıcı yenilenmez.
                  </p>
                }
                confirmLabel="Evet, yenile"
                tone="primary"
                testId="ops-alert-routing-rehash"
              />
            </RotationForm>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function OpNotice({ state, testId }: { state: RoutingOpState; testId: string }) {
  if (state.kind === 'error') {
    return (
      <p className="notice notice-error" role="alert" data-testid={`${testId}-error`} data-code={state.code ?? undefined}>
        {state.message}
      </p>
    );
  }
  return null;
}

/** A plain submit: the imported recipient is like any other, and can be deleted again. */
function ImportForm() {
  const [state, action] = useActionState(importEnvRecipientAction, ROUTING_OP_IDLE);
  return (
    <form action={action} className="cell-stack">
      <p>OPS_ALERT_EMAIL adresini, üç bildirim türü de açık bir yönetilen alıcı olarak ekleyin.</p>
      <div>
        <Submit label="OPS_ALERT_EMAIL'i içe aktar" pendingLabel="Aktarılıyor…" testId="ops-alert-routing-import" />
      </div>
      <OpNotice state={state} testId="ops-alert-routing-import" />
    </form>
  );
}

/** A key operation's form: its own confirmation (children) and, on a refusal, the sentence. */
function RotationForm({
  action,
  testId,
  children,
}: {
  action: (previous: RoutingOpState, formData: FormData) => Promise<RoutingOpState>;
  testId: string;
  children: ReactNode;
}) {
  const [state, dispatch] = useActionState(action, ROUTING_OP_IDLE);
  return (
    <form action={dispatch} className="inline-form">
      {children}
      <OpNotice state={state} testId={testId} />
    </form>
  );
}

function SwitchForm({ direction }: { direction: RoutingDirection }) {
  const [state, action] = useActionState(routingSwitchAction, ROUTING_SWITCH_IDLE);
  const id = direction === 'CUTOVER' ? 'cutover' : 'revert';
  return (
    <form action={action} className="cell-stack" data-testid={`ops-alert-routing-${id}-form`}>
      <input type="hidden" name="direction" value={direction} />
      <RoutingSwitchBody direction={direction} state={state} />
    </form>
  );
}

const STATUSES: RoutingPendingStatus[] = ['PENDING', 'FAILED', 'SENDING'];

const WORDS = {
  CUTOVER: {
    id: 'cutover',
    preview: 'Geçişi önizle',
    rebind: 'Bağlanacak (eşleşen yönetilen alıcıya)',
    told: 'Bilgilendirilmiş aktarılacak (açık alarmların gönderilmiş bildirimleri)',
    trigger: 'Yönetilen moda geç',
    title: 'Yönetilen alıcılara geç',
    consequence: 'Bundan sonra alarm e-postaları yalnız yönetilen alıcılara gider; OPS_ALERT_EMAIL adresine ayrıca gönderilmez.',
    confirm: 'Evet, yönetilen moda geç',
  },
  REVERT: {
    id: 'revert',
    preview: 'Geri dönüşü önizle',
    rebind: 'Bağlanacak (OPS_ALERT_EMAIL adresine)',
    told: 'Bilgilendirilmiş aktarılacak (gönderilmiş bildirimler)',
    trigger: 'Env moduna dön',
    title: 'OPS_ALERT_EMAIL adresine dön',
    consequence: 'Bundan sonra alarm e-postaları yeniden yalnız OPS_ALERT_EMAIL adresine gider; yönetilen alıcılara gönderilmez.',
    confirm: 'Evet, env moduna dön',
  },
} as const;

/**
 * The inside of one switch form, for its state: the preview button; a
 * refusal; or the preview — table, blockers, and (only without a blocker)
 * the token and the confirmation. Exported for the tests, which draw each
 * state as the server would.
 */
export function RoutingSwitchBody({ direction, state }: { direction: RoutingDirection; state: RoutingSwitchState }) {
  const words = WORDS[direction];
  const shown = state.kind === 'preview' ? state.preview : null;
  return (
    <>
      <div>
        {/* No validation: a required tick of a previous preview must not block asking again. */}
        <Submit
          label={shown ? 'Yeniden önizle' : words.preview}
          pendingLabel="Hesaplanıyor…"
          testId={`ops-alert-routing-${words.id}-preview`}
          name="intent"
          value="preview"
          formNoValidate
        />
      </div>
      {state.kind === 'error' ? (
        <p className="notice notice-error" role="alert" data-testid={`ops-alert-routing-${words.id}-error`} data-code={state.code ?? undefined}>
          {state.message}
        </p>
      ) : null}
      {shown ? <PreviewDetails direction={direction} preview={shown} /> : null}
    </>
  );
}

function PreviewDetails({ direction, preview }: { direction: RoutingDirection; preview: RoutingPreview }) {
  const words = WORDS[direction];
  const blocked = preview.blockers.length > 0;
  const cancelTotal = routingCancelTotal(preview);
  const askCancel = direction === 'REVERT' && preview.confirmRequired;
  // A switch never cancels a SENDING row: on a cutover this cell is the
  // unmatched in-flight rows LEGACY_ROWS_UNMATCHED holds back, shown as what
  // would be lost — not as something the approval cancels.
  const sendingLost = direction === 'CUTOVER' && preview.counts.SENDING.cancel > 0;
  return (
    <div className="cell-stack" data-testid={`ops-alert-routing-${words.id}-preview-result`}>
      <DataTable
        caption="Önizleme: durum bazında bekleyen teslimatlar"
        columns={[
          { key: 'status', label: 'Teslimat durumu' },
          { key: 'rebind', label: words.rebind, align: 'end' },
          { key: 'cancel', label: 'İptal edilecek', align: 'end' },
        ]}
        minWidth={520}
        testId={`ops-alert-routing-${words.id}-table`}
      >
        {STATUSES.map((status) => (
          <tr key={status}>
            <th scope="row">{OPS_ALERT_DELIVERY_LABELS[status]}</th>
            <td className="is-num" data-testid={`ops-alert-routing-count-${status}-rebind`}>
              {preview.counts[status].rebind}
            </td>
            <td className="is-num" data-testid={`ops-alert-routing-count-${status}-cancel`}>
              {preview.counts[status].cancel}
              {status === 'SENDING' && sendingLost ? <sup aria-hidden="true">*</sup> : null}
            </td>
          </tr>
        ))}
      </DataTable>
      {sendingLost ? (
        <p className="cell-muted" data-testid="ops-alert-routing-sending-lost-note">
          * Gönderiliyor satırındaki sayı, eşleşen etkin alıcısı olmadığı için geçiş yapılsaydı kaybolacak gönderimlerdir. Geçiş
          bunları iptal etmez; bu engel kalkmadan geçiş yapılamaz ve gönderimler iptal edilmez.
        </p>
      ) : null}
      <dl className="ops-alert-routing-figures">
        <div>
          <dt>{words.told}</dt>
          <dd data-testid="ops-alert-routing-told">{preview.told}</dd>
        </div>
        <div>
          <dt>Gönderimi süren, worker&apos;a bırakılan</dt>
          <dd data-testid="ops-alert-routing-in-flight">{preview.inFlight}</dd>
        </div>
        <div>
          <dt>Sonuçlanmayı bekleyen çakışma</dt>
          <dd data-testid="ops-alert-routing-collisions">{preview.collisions}</dd>
        </div>
      </dl>

      {blocked ? (
        <ul className="cell-stack" data-testid="ops-alert-routing-blockers">
          {preview.blockers.map((blocker) => (
            <li key={blocker} className="notice notice-error" role="alert" data-code={blocker} data-testid="ops-alert-routing-blocker">
              {recipientErrorText(blocker)}
            </li>
          ))}
        </ul>
      ) : (
        <>
          {/* The approval is bound to this preview: the API recomputes it and compares. */}
          <input type="hidden" name="token" value={preview.token} />
          {askCancel ? (
            <label className="ops-alert-switch-row" data-testid="ops-alert-routing-cancel-unmatched">
              <input type="checkbox" name="cancelUnmatched" value="true" required />
              <span>
                Eşleşmeyen {cancelTotal} teslimatı iptal et
                {preview.inFlight > 0 ? (
                  <span className="cell-muted"> Gönderimi süren teslimatların sonucu kaydedilir; yeniden denenirse iptal edilir.</span>
                ) : null}
              </span>
            </label>
          ) : null}
          <div>
            <ConfirmGate
              triggerLabel={words.trigger}
              triggerClassName={direction === 'CUTOVER' ? 'btn btn-primary' : 'btn btn-destructive'}
              name="intent"
              value="apply"
              testId={`ops-alert-routing-${words.id}-confirm`}
              evaluate={() => ({
                proofs: [direction === 'CUTOVER' ? 'ops-alert-routing.cutover' : 'ops-alert-routing.revert'],
                title: words.title,
                consequence: (
                  <>
                    <p>{words.consequence}</p>
                    {askCancel ? <p>Eşleşmeyen {cancelTotal} bekleyen teslimat iptal edilir.</p> : null}
                    <p>Önizlemedeki sayılar uygulanır; arada değiştiyse hiçbir şey yapılmaz ve yeniden önizlemeniz istenir.</p>
                  </>
                ),
                confirmLabel: words.confirm,
                tone: direction === 'CUTOVER' ? 'primary' : 'danger',
              })}
            />
          </div>
        </>
      )}
    </div>
  );
}

function Submit({
  label,
  pendingLabel,
  testId,
  name,
  value,
  formNoValidate,
}: {
  label: string;
  pendingLabel: string;
  testId: string;
  name?: string;
  value?: string;
  formNoValidate?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      className="btn btn-secondary btn-sm"
      type="submit"
      name={name}
      value={value}
      formNoValidate={formNoValidate}
      disabled={pending}
      aria-disabled={pending}
      data-testid={testId}
    >
      {pending ? pendingLabel : label}
    </button>
  );
}
