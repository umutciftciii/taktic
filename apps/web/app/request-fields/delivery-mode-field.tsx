'use client';

import {
  REQUEST_DELIVERY_MODE_LABELS,
  fixedDeliveryMode,
  type CategoryDeliveryModel,
  type RequestDeliveryMode,
} from '@taktic/shared';

type DeliveryModeFieldProps = {
  /** The category's model, as the page read it; absent (an older API) is ON_SITE. */
  model: CategoryDeliveryModel | null | undefined;
  /** The HYBRID choice, controlled — the location block below reads it. */
  value: RequestDeliveryMode | null;
  onChange: (value: RequestDeliveryMode) => void;
  /** The API's refusal of the last submission for this field, when there was one. */
  error?: string | null;
  /** A stable prefix for ids, so two forms on one page cannot collide. */
  idPrefix?: string;
};

const OPTION_HINTS: Record<RequestDeliveryMode, string> = {
  ON_SITE: 'Hizmet veren adresinize gelir; bölgenize hizmet verenler talebinizi görür.',
  REMOTE: 'Hizmet uzaktan verilir; bölgeniz eşleşmeyi sınırlamaz.',
};

/**
 * MATCH-001 — how the job is delivered, asked only where the customer decides.
 *
 * A HYBRID category renders a required pair of radios named `deliveryMode`;
 * nothing is pre-ticked, because which way the work happens is the customer's
 * call, and the API refuses a HYBRID request without one. An ON_SITE or
 * REMOTE category renders no control at all — the API derives the mode from
 * the category — and a REMOTE one (or a HYBRID one answered REMOTE) says in
 * one line what that means for the place fields below.
 */
export function DeliveryModeField({ model, value, onChange, error, idPrefix = 'delivery-mode' }: DeliveryModeFieldProps) {
  const fixed = fixedDeliveryMode(model);
  const effective = fixed ?? value;
  const errorId = `${idPrefix}-error`;
  const noteId = `${idPrefix}-note`;

  return (
    <>
      {fixed === null ? (
        <fieldset
          className="delivery-mode-field"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          data-testid="delivery-mode-field"
        >
          <legend>Hizmet şekli *</legend>
          {(['ON_SITE', 'REMOTE'] as const).map((mode) => (
            <label key={mode} className="delivery-mode-option">
              <input
                type="radio"
                name="deliveryMode"
                value={mode}
                required
                checked={value === mode}
                onChange={() => onChange(mode)}
                aria-describedby={`${idPrefix}-${mode}-hint`}
                data-testid={`delivery-mode-${mode.toLowerCase()}`}
              />
              <span>
                <strong>{REQUEST_DELIVERY_MODE_LABELS[mode]}</strong>
                <span id={`${idPrefix}-${mode}-hint`} className="help-text">
                  {OPTION_HINTS[mode]}
                </span>
              </span>
            </label>
          ))}
          {error ? (
            <span id={errorId} className="field-error" role="alert">
              {error}
            </span>
          ) : null}
        </fieldset>
      ) : null}
      {effective === 'REMOTE' ? (
        <p id={noteId} className="delivery-mode-note" data-testid="delivery-mode-remote-note">
          <span className="badge badge-muted">Uzaktan hizmet</span>{' '}
          Bu hizmet uzaktan verilir. Aşağıdaki il ve ilçe yalnız talebinizin bağlamı olarak
          paylaşılır; hangi hizmet verenlerin talebinizi göreceğini sınırlamaz.
        </p>
      ) : null}
    </>
  );
}
