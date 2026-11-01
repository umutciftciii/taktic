'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { Toggle } from '../../../components/toggle';
import { RECIPIENT_LABEL_MAX_LENGTH } from '../../../lib/ops-alert-recipients';
import { createRecipientAction, updateRecipientAction } from './actions';
import { LastCriticalStep } from './last-critical-step';
import { RECIPIENT_FORM_IDLE, recipientFormStep } from './recipient-form-state';

/**
 * The add / edit window of one alert recipient (OBS-ALERT-002).
 *
 * - The address is typed only when adding. After that it is the recipient's
 *   identity and is shown masked and read-only: changing it is the "Adresi
 *   değiştir" action, which replaces the recipient (and says so).
 * - The three switches are the notice kinds the recipient receives. A new
 *   recipient starts with Kritik and Düzelme on and Uyarı off.
 * - Every field is controlled: React resets an uncontrolled form once its
 *   action settles, and a refusal must leave what was typed where it was. The
 *   typed address lives only in this component's state; it is never put in a
 *   URL, a cookie or storage.
 * - Every rule (limit, duplicate, address shape, the row's version) is the
 *   API's; its refusal comes back under the form.
 * - Turning Kritik off on the last critical recipient (Ruling B-3) is refused
 *   once with LAST_CRITICAL_CONFIRM_REQUIRED: the window then swaps its save
 *   button for the separate last-critical confirmation, which resubmits with
 *   `confirmLastCritical=true`. Switching Kritik back on drops that step again.
 *   On production's last live channel only the reason is shown.
 */

type Mode = { kind: 'create' } | { kind: 'edit'; recipientId: string; version: number; maskedAddress: string };

type Defaults = { label: string; notifyWarning: boolean; notifyCritical: boolean; notifyRecovery: boolean };

const CREATE_DEFAULTS: Defaults = { label: '', notifyWarning: false, notifyCritical: true, notifyRecovery: true };

const SWITCHES = [
  { name: 'notifyWarning', title: 'Uyarı', hint: 'Dikkat gerektiren ama acil olmayan sorunlar.' },
  { name: 'notifyCritical', title: 'Kritik', hint: 'Hizmetin çalışmasını etkileyen sorunlar.' },
  { name: 'notifyRecovery', title: 'Düzelme', hint: 'Bir sorunun kendiliğinden ya da elle kapandığı bildirimi.' },
] as const;

export function RecipientForm({
  mode,
  defaults = CREATE_DEFAULTS,
  cancelHref,
}: {
  mode: Mode;
  defaults?: Defaults;
  cancelHref: string;
}) {
  const [state, formAction] = useActionState(
    mode.kind === 'edit' ? updateRecipientAction : createRecipientAction,
    RECIPIENT_FORM_IDLE,
  );
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState(defaults.label);
  const [notify, setNotify] = useState({
    notifyWarning: defaults.notifyWarning,
    notifyCritical: defaults.notifyCritical,
    notifyRecovery: defaults.notifyRecovery,
  });
  const error = state.kind === 'error' ? state : null;
  // The second step is about Kritik being off; once it is back on, the save is ordinary again.
  const { step, saveHidden } = recipientFormStep(mode.kind === 'edit', notify.notifyCritical, state);
  const errorOn = (field: 'address' | 'label') => (error?.field === field ? error.message : null);

  return (
    <form action={formAction} className="seo-modal-form" data-testid="ops-alert-recipient-form">
      {mode.kind === 'edit' ? (
        <>
          <input type="hidden" name="recipientId" value={mode.recipientId} />
          <input type="hidden" name="version" value={mode.version} />
        </>
      ) : null}

      {mode.kind === 'create' ? (
        <label className="seo-field">
          <span className="seo-field-label">E-posta adresi</span>
          <input
            name="address"
            type="text"
            inputMode="email"
            required
            autoComplete="off"
            spellCheck={false}
            maxLength={254}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="ad@sirket.com"
            aria-invalid={errorOn('address') ? true : undefined}
            data-testid="ops-alert-form-address"
          />
          <span className="help-text">Kaydedildikten sonra adres şifreli saklanır; listelerde yalnız maskeli görünür.</span>
        </label>
      ) : (
        <div className="seo-field">
          <span className="seo-field-label">E-posta adresi</span>
          <div className="locked-field" data-testid="ops-alert-form-address-locked">
            <code className="locked-field-value">{mode.maskedAddress}</code>
            <span className="locked-field-tag">Değiştirilemez</span>
          </div>
        </div>
      )}

      <label className="seo-field">
        <span className="seo-field-label">Etiket</span>
        <input
          name="label"
          required
          maxLength={RECIPIENT_LABEL_MAX_LENGTH}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Örn. Nöbetçi mühendis"
          aria-invalid={errorOn('label') ? true : undefined}
          data-testid="ops-alert-form-label"
        />
        <span className="help-text">Listede ve kayıtlarda adresin yerine bu ad görünür; etikete adres yazmayın.</span>
      </label>

      <fieldset className="seo-field" data-testid="ops-alert-form-switches">
        <legend className="seo-field-label">Hangi bildirimler gönderilsin?</legend>
        {SWITCHES.map(({ name, title, hint }) => (
          <div key={name} className="ops-alert-switch-row">
            <input type="hidden" name={name} value={String(notify[name])} />
            <Toggle
              checked={notify[name]}
              label={title}
              onClick={() => setNotify((current) => ({ ...current, [name]: !current[name] }))}
              testId={`ops-alert-form-${name}`}
            />
            <span>
              <strong>{title}</strong>
              <span className="cell-muted"> {hint}</span>
            </span>
          </div>
        ))}
      </fieldset>

      {error ? (
        <div className="notice notice-error" role="alert" data-testid="ops-alert-form-error" data-code={error.code ?? undefined}>
          {error.message}
        </div>
      ) : null}

      <LastCriticalStep state={step} leadProof={null} confirmLabel="Yine de kaydet" testId="ops-alert-form-last-critical" />

      <div className="form-actions">
        {saveHidden ? null : <SubmitButton label={mode.kind === 'edit' ? 'Değişiklikleri kaydet' : 'Alıcıyı ekle'} />}
        <Link className="btn btn-secondary" href={cancelHref} scroll={false}>
          Vazgeç
        </Link>
      </div>
    </form>
  );
}

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button className="btn btn-primary" type="submit" disabled={pending} data-testid="ops-alert-form-submit">
      {pending ? 'Kaydediliyor…' : label}
    </button>
  );
}
