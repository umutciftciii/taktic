'use client';

import { useState, useTransition, type FormEvent } from 'react';
import { contactVerification, formatDateTime } from '@taktic/shared';
import { TURNSTILE_ACTIONS, type TurnstileWebConfig } from '../../../lib/turnstile';
import { TurnstileSlot, useTurnstile } from '../../request-fields/turnstile';
import {
  sendAccountEmailVerificationAction,
  sendAccountPhoneCodeAction,
  verifyAccountPhoneCodeAction,
} from './account-contact-actions';

export const ACCOUNT_CONTACT_ANCHOR = 'hesap-iletisimi';

/**
 * The provider's own account contact — the address and number on the
 * *account* (User.email / User.phone), which are not the business contact the
 * profile form edits — and whether each has been proven
 * (AUTH-PROVIDER-CONTACT-001).
 *
 * Two independent rows, each with a badge read from the account's own column
 * and nothing else. An unproven channel offers its one action; a proven one
 * shows when it was proven and offers nothing, because there is nothing left
 * to prove. A channel the account has no value for offers nothing either: no
 * flow on this screen can add one, and a button that led nowhere would be
 * worse than no button.
 *
 * A client component for the same reason the request's verification card is
 * one: the send that costs an SMS asks the Turnstile widget for a token
 * first. The token goes to the server action as an argument and from there
 * into one header — never into the URL, the page, or storage.
 */
export function AccountContactCard({
  providerId,
  email,
  phone,
  emailVerifiedAt,
  phoneVerifiedAt,
  emailState,
  phoneState,
  turnstile: config,
}: {
  providerId: string;
  email: string | null;
  phone: string | null;
  emailVerifiedAt: string | null;
  phoneVerifiedAt: string | null;
  /** The last e-mail action's outcome, from the query string. */
  emailState: string | null;
  /** The last phone action's outcome, from the query string. */
  phoneState: string | null;
  turnstile: TurnstileWebConfig;
}) {
  const emailProof = contactVerification(emailVerifiedAt);
  const phoneProof = contactVerification(phoneVerifiedAt);
  const turnstile = useTurnstile(config);
  const [sendingEmail, startSendingEmail] = useTransition();
  const [sendingCode, startSendingCode] = useTransition();
  const [challengeFailed, setChallengeFailed] = useState(false);

  function onSendEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sendingEmail) return;
    startSendingEmail(async () => {
      await sendAccountEmailVerificationAction(providerId);
    });
  }

  function onSendCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sendingCode) return;
    setChallengeFailed(false);
    startSendingCode(async () => {
      let token: string | null;
      try {
        token = await turnstile.acquire(TURNSTILE_ACTIONS.phoneCodeSend);
      } catch {
        setChallengeFailed(true);
        return;
      }
      await sendAccountPhoneCodeAction(providerId, token);
    });
  }

  return (
    <section
      className="pdash-detail-card pdash-contact-card"
      id={ACCOUNT_CONTACT_ANCHOR}
      aria-labelledby="account-contact-heading"
      data-testid="account-contact-card"
    >
      <h2 id="account-contact-heading">Hesap iletişimi</h2>
      <p className="pdash-card-sub pdash-contact-intro">
        Hesabınıza kayıtlı e-posta ve telefon. İşletme profilindeki iletişim bilgileri ayrıdır; burada
        hesabınızın kendi adresini ve numarasını doğrularsınız. Doğrulama teklif, profil ve başvuru
        akışlarını değiştirmez.
      </p>

      <dl className="pdash-info-grid">
        <div className="pdash-info-row pdash-contact-row" data-testid="account-contact-email">
          <dt>
            <span className="pdash-contact-label-row">
              <span>E-posta</span>
              <ContactBadge channel="email" proof={emailProof} />
            </span>
          </dt>
          <dd>
            <div className="pdash-contact-value">{email ?? '-'}</div>
            {emailProof.verified ? (
              <div className="pdash-contact-meta" data-testid="account-email-verified-at">
                {formatDateTime(emailProof.at)} tarihinde doğrulandı.
              </div>
            ) : email ? (
              <>
                {emailState ? (
                  <p
                    className={`pdash-contact-meta${emailState === 'failed' ? ' pdash-contact-error' : ''}`}
                    role={emailState === 'failed' ? 'alert' : 'status'}
                    data-testid="account-email-message"
                  >
                    {emailMessage(emailState)}
                  </p>
                ) : null}
                <form className="pdash-contact-actions" onSubmit={onSendEmail}>
                  <button
                    className="pdash-btn pdash-btn-secondary pdash-btn-sm"
                    type="submit"
                    disabled={sendingEmail}
                    aria-busy={sendingEmail || undefined}
                    data-testid="account-email-send"
                  >
                    Doğrulama bağlantısı gönder
                  </button>
                </form>
              </>
            ) : (
              <div className="pdash-contact-meta">Hesabınızda kayıtlı e-posta yok.</div>
            )}
          </dd>
        </div>

        <div className="pdash-info-row pdash-contact-row" data-testid="account-contact-phone">
          <dt>
            <span className="pdash-contact-label-row">
              <span>Telefon</span>
              <ContactBadge channel="phone" proof={phoneProof} />
            </span>
          </dt>
          <dd>
            <div className="pdash-contact-value">{phone ?? '-'}</div>
            {phoneProof.verified ? (
              <div className="pdash-contact-meta" data-testid="account-phone-verified-at">
                {formatDateTime(phoneProof.at)} tarihinde doğrulandı.
              </div>
            ) : phone ? (
              <>
                {phoneState ? (
                  <p
                    className={`pdash-contact-meta${isPhoneError(phoneState) ? ' pdash-contact-error' : ''}`}
                    role={isPhoneError(phoneState) ? 'alert' : 'status'}
                    data-testid="account-phone-message"
                  >
                    {phoneMessage(phoneState)}
                  </p>
                ) : null}
                {challengeFailed ? (
                  <p className="pdash-contact-meta pdash-contact-error" role="alert" data-testid="account-phone-message">
                    {phoneMessage('challenge-failed')}
                  </p>
                ) : null}

                {/*
                  The same one-time-code row the request screen uses
                  (REQ-UX-012): send, the code, verify — one height, one
                  baseline, folding at a phone width. Two forms because they
                  are two actions.
                */}
                <div className="otp-row" data-testid="account-phone-controls">
                  <form className="otp-send" onSubmit={onSendCode}>
                    <button
                      className="pdash-btn pdash-btn-secondary otp-control"
                      type="submit"
                      disabled={sendingCode || turnstile.status === 'unconfigured'}
                      aria-busy={sendingCode || undefined}
                      data-testid="account-phone-send"
                    >
                      Doğrulama kodu gönder
                    </button>
                  </form>

                  <form action={verifyAccountPhoneCodeAction} className="otp-verify">
                    <input type="hidden" name="providerId" value={providerId} />
                    <label className="cdash-visually-hidden" htmlFor="account-phone-code">
                      Doğrulama kodu
                    </label>
                    <input
                      id="account-phone-code"
                      className="otp-control otp-code"
                      name="code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      pattern="\d{6}"
                      placeholder="6 haneli kod"
                      aria-invalid={phoneState === 'invalid' ? true : undefined}
                      required
                    />
                    <button className="pdash-btn pdash-btn-primary otp-control" type="submit" data-testid="account-phone-verify">
                      Doğrula
                    </button>
                  </form>
                </div>

                <TurnstileSlot turnstile={turnstile} />
              </>
            ) : (
              <div className="pdash-contact-meta" data-testid="account-phone-missing">
                Hesabınızda kayıtlı telefon numarası yok.
              </div>
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}

/**
 * "Doğrulandı" in ink, "Doğrulanmadı" in neutral grey — the customer settings
 * badge, word for word and class for class, so the two panels say the same
 * thing about the same column.
 */
function ContactBadge({
  channel,
  proof,
}: {
  channel: 'email' | 'phone';
  proof: ReturnType<typeof contactVerification>;
}) {
  const subject = channel === 'email' ? 'E-posta' : 'Telefon';
  return (
    <span
      className={`tag ${proof.verified ? 'tag-ink' : 'tag-neutral'} cdash-verify-badge`}
      data-testid={`account-${channel}-verification`}
      data-verified={proof.verified ? 'true' : 'false'}
      aria-label={`${subject} ${proof.label.toLocaleLowerCase('tr-TR')}`}
    >
      {proof.label}
    </span>
  );
}

function emailMessage(state: string): string {
  switch (state) {
    case 'sent':
      return 'Doğrulama bağlantısı e-posta adresinize gönderildi. Bağlantı 7 gün geçerlidir.';
    default:
      return 'Bağlantı şu anda gönderilemedi. Lütfen daha sonra tekrar deneyin.';
  }
}

function isPhoneError(state: string): boolean {
  return state !== 'sent' && state !== 'verified';
}

function phoneMessage(state: string): string {
  switch (state) {
    case 'sent':
      return 'Kod gönderildi. Birkaç dakika içinde ulaşır; 6 haneli kodu aşağıya girin.';
    case 'verified':
      return 'Telefon numaranız doğrulandı.';
    case 'invalid':
      return 'Kod geçersiz veya süresi dolmuş. Yeni bir kod isteyebilirsiniz.';
    case 'rate-limited':
      return 'Çok fazla kod istendi. Lütfen bir süre sonra tekrar deneyin.';
    case 'already-verified':
      return 'Hesap telefonunuz zaten doğrulanmış.';
    case 'no-phone':
      return 'Hesabınızda kayıtlı telefon numarası yok.';
    case 'challenge-failed':
      return 'Güvenlik doğrulaması başarısız oldu. Lütfen tekrar deneyin.';
    case 'challenge-unavailable':
      return 'Güvenlik doğrulaması şu anda yapılamıyor. Lütfen birkaç saniye sonra tekrar deneyin.';
    default:
      return 'İşlem şu anda tamamlanamadı. Lütfen daha sonra tekrar deneyin.';
  }
}
