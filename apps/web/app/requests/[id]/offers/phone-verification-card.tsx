'use client';

import { useState, useTransition, type FormEvent } from 'react';
import { TURNSTILE_ACTIONS, type TurnstileWebConfig } from '../../../../lib/turnstile';
import { TurnstileSlot, useTurnstile } from '../../../request-fields/turnstile';
import {
  PHONE_VERIFICATION_ANCHOR,
  phoneVerificationCardCopy,
  VERIFY_PHONE_TITLE,
} from '../../../../lib/request-lifecycle';
import { sendPhoneCodeAction, verifyPhoneCodeAction } from './actions';

/**
 * Two moods, one card. `required` is the API's own word
 * (`awaitingPhoneVerification`) that the request goes nowhere without this
 * proof: the card then leads with the heading the receipt used and says what
 * the proof leads to. Otherwise — the gate off — verifying changes nothing
 * about how the request is handled, so the card informs and invites but never
 * blocks. Neither mood claims that the request *is* verified.
 *
 * A client component because the send — the half that costs an SMS — asks the
 * Turnstile widget for a token before it calls the action. The verify half is
 * the plain form it always was: it spends nothing and carries no token.
 */
export function PhoneVerificationCard({
  requestId,
  maskedPhone,
  required,
  autoPublishEnabled,
  state,
  turnstile: config,
}: {
  requestId: string;
  /** Already masked by the page; the full number never reaches this component. */
  maskedPhone: string;
  /** The request waits for this proof and nothing else. */
  required: boolean;
  /** What the proof leads to; read by the page, fail-closed. */
  autoPublishEnabled: boolean;
  state: string | null;
  turnstile: TurnstileWebConfig;
}) {
  const turnstile = useTurnstile(config);
  const [sending, startSending] = useTransition();
  /** The widget's own refusal, before any call was made. */
  const [challengeFailed, setChallengeFailed] = useState(false);

  function onSend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending) return;
    setChallengeFailed(false);
    startSending(async () => {
      let token: string | null;
      try {
        token = await turnstile.acquire(TURNSTILE_ACTIONS.phoneCodeSend);
      } catch {
        setChallengeFailed(true);
        return;
      }
      // The action redirects with the outcome in the query string; a token
      // that the API refuses comes back the same way (`challenge-failed`).
      await sendPhoneCodeAction(requestId, token);
    });
  }

  return (
    <div
      className="cdash-verify-card"
      id={PHONE_VERIFICATION_ANCHOR}
      data-testid="phone-verification-card"
      data-required={required ? 'true' : 'false'}
      style={{ marginTop: 24 }}
    >
      <span className="cdash-summary-label">Telefon Doğrulama</span>
      {required ? <h3 className="cdash-verify-title">{VERIFY_PHONE_TITLE}</h3> : null}
      <p className="cdash-summary-body">
        {phoneVerificationCardCopy({ required, maskedPhone, autoPublishEnabled })}
      </p>

      {state ? (
        <p className="cdash-summary-body" data-testid="phone-verification-message">
          {verificationMessage(state)}
        </p>
      ) : null}
      {challengeFailed ? (
        <p className="cdash-summary-body cdash-notice-error" role="alert" data-testid="phone-verification-message">
          {verificationMessage('challenge-failed')}
        </p>
      ) : null}

      {/*
        One row of three controls — send, the code, verify — sharing one
        height, one type size and one baseline (`.otp-row`, REQ-UX-012). The
        row folds at a phone width: the send button takes a line of its own
        and the code keeps its button beside it, so nothing is ever clipped
        or pushed past the edge. Two forms because they are two actions.
      */}
      <div className="otp-row" data-testid="phone-verification-controls">
        <form className="otp-send" onSubmit={onSend}>
          <button
            className="cdash-btn cdash-btn-secondary otp-control"
            type="submit"
            disabled={sending || turnstile.status === 'unconfigured'}
            aria-busy={sending || undefined}
          >
            Doğrulama kodu gönder
          </button>
        </form>

        <form action={verifyPhoneCodeAction} className="otp-verify">
          <input type="hidden" name="requestId" value={requestId} />
          <label className="cdash-visually-hidden" htmlFor="phone-code">
            Doğrulama kodu
          </label>
          <input
            id="phone-code"
            className="otp-control otp-code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            pattern="\d{6}"
            placeholder="6 haneli kod"
            aria-invalid={state === 'invalid' ? true : undefined}
            required
          />
          <button className="cdash-btn cdash-btn-primary otp-control" type="submit">
            Doğrula
          </button>
        </form>
      </div>

      <TurnstileSlot turnstile={turnstile} />
    </div>
  );
}

function verificationMessage(state: string): string {
  switch (state) {
    case 'ok':
      return 'İşlem tamamlandı. Kod gönderildiyse birkaç dakika içinde ulaşır.';
    case 'invalid':
      return 'Kod geçersiz veya süresi dolmuş. Yeni bir kod isteyebilirsiniz.';
    case 'rate-limited':
      return 'Çok fazla kod istendi. Lütfen bir süre sonra tekrar deneyin.';
    case 'already-verified':
      return 'Bu talebin telefonu zaten doğrulanmış.';
    case 'challenge-failed':
      return 'Güvenlik doğrulaması başarısız oldu. Lütfen tekrar deneyin.';
    case 'challenge-unavailable':
      return 'Güvenlik doğrulaması şu anda yapılamıyor. Lütfen birkaç saniye sonra tekrar deneyin.';
    default:
      return 'İşlem şu anda tamamlanamadı. Lütfen daha sonra tekrar deneyin.';
  }
}
