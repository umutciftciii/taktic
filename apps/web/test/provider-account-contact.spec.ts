import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

/**
 * The provider's "Hesap iletişimi" card (AUTH-PROVIDER-CONTACT-001): two
 * badges read from the account's own two columns, an action only where a
 * proof is missing and can be collected, and no trace of a Turnstile token in
 * the markup. Rendered as the server renders it; the server actions and the
 * widget hook are stood in for because neither runs in a static render.
 */

vi.mock('../app/providers/[id]/account-contact-actions', () => ({
  sendAccountEmailVerificationAction: async () => undefined,
  sendAccountPhoneCodeAction: async () => undefined,
  verifyAccountPhoneCodeAction: async () => undefined,
}));

/** What the stood-in widget hook reports; `unconfigured` is the closed stack. */
let turnstileStatus: 'ready' | 'unconfigured' = 'ready';

vi.mock('../app/request-fields/turnstile', () => ({
  useTurnstile: () => ({ status: turnstileStatus, acquire: async () => 'turnstile-test:never-rendered' }),
  TurnstileSlot: () => null,
}));

import { AccountContactCard } from '../app/providers/[id]/account-contact-card';

type CardProps = Parameters<typeof AccountContactCard>[0];

const BASE: CardProps = {
  providerId: 'cmfproviderproviderprovid',
  email: 'veren@example.test',
  phone: '+905553334455',
  emailVerifiedAt: null,
  phoneVerifiedAt: null,
  emailState: null,
  phoneState: null,
  turnstile: { mode: 'test' },
};

function render(overrides: Partial<CardProps> = {}) {
  return renderToStaticMarkup(createElement(AccountContactCard, { ...BASE, ...overrides }));
}

function badge(markup: string, channel: 'email' | 'phone') {
  const match = markup.match(
    new RegExp(`<span class="tag ([^"]+)" data-testid="account-${channel}-verification" data-verified="(true|false)"[^>]*>([^<]+)</span>`),
  );
  if (!match) throw new Error(`no ${channel} badge`);
  return { className: match[1]!, verified: match[2] === 'true', label: match[3]! };
}

describe('AccountContactCard', () => {
  it('shows both channels unverified with their actions when neither column is set', () => {
    const markup = render();

    expect(badge(markup, 'email')).toEqual({ className: 'tag-neutral cdash-verify-badge', verified: false, label: 'Doğrulanmadı' });
    expect(badge(markup, 'phone')).toEqual({ className: 'tag-neutral cdash-verify-badge', verified: false, label: 'Doğrulanmadı' });
    expect(markup).toContain('data-testid="account-email-send"');
    expect(markup).toContain('data-testid="account-phone-send"');
    expect(markup).toContain('data-testid="account-phone-verify"');
    expect(markup).toContain('veren@example.test');
    expect(markup).toContain('+905553334455');
    expect(markup).not.toContain('tarihinde doğrulandı');
  });

  it('shows the moment of each proof and no action once a column is set', () => {
    const markup = render({
      emailVerifiedAt: '2026-09-19T09:30:00.000Z',
      phoneVerifiedAt: '2026-09-19T10:15:00.000Z',
    });

    expect(badge(markup, 'email')).toMatchObject({ className: 'tag-ink cdash-verify-badge', verified: true, label: 'Doğrulandı' });
    expect(badge(markup, 'phone')).toMatchObject({ className: 'tag-ink cdash-verify-badge', verified: true, label: 'Doğrulandı' });
    expect(markup).toContain('data-testid="account-email-verified-at"');
    expect(markup).toContain('data-testid="account-phone-verified-at"');
    expect(markup).toMatch(/19 Eyl 2026 \d{2}:\d{2} tarihinde doğrulandı/);
    expect(markup).not.toContain('account-email-send');
    expect(markup).not.toContain('account-phone-send');
    expect(markup).not.toContain('account-phone-verify');
    expect(markup).not.toContain('otp-row');
  });

  it('keeps the two channels independent', () => {
    const markup = render({ emailVerifiedAt: '2026-09-19T09:30:00.000Z' });
    expect(badge(markup, 'email').verified).toBe(true);
    expect(badge(markup, 'phone').verified).toBe(false);
    expect(markup).not.toContain('account-email-send');
    expect(markup).toContain('account-phone-send');
  });

  it('offers nothing for a channel the account has no value for', () => {
    const markup = render({ phone: null });
    expect(badge(markup, 'phone').verified).toBe(false);
    expect(markup).toContain('data-testid="account-phone-missing"');
    expect(markup).not.toContain('account-phone-send');
    expect(markup).not.toContain('otp-row');
  });

  it('words each outcome from the query string, and only that', () => {
    expect(render({ emailState: 'sent' })).toContain('Doğrulama bağlantısı e-posta adresinize gönderildi');
    expect(render({ phoneState: 'sent' })).toContain('Kod gönderildi');
    expect(render({ phoneState: 'invalid' })).toContain('Kod geçersiz veya süresi dolmuş');
    expect(render({ phoneState: 'rate-limited' })).toContain('Çok fazla kod istendi');
    expect(render({ phoneState: 'challenge-failed' })).toContain('Güvenlik doğrulaması başarısız');
    expect(render({ phoneState: 'challenge-unavailable' })).toContain('şu anda yapılamıyor');
    expect(render({ phoneState: 'something-else' })).toContain('İşlem şu anda tamamlanamadı');
  });

  it('never puts a Turnstile token in the markup', () => {
    const markup = render({ phoneState: 'sent' });
    expect(markup).not.toContain('turnstile-test:');
    expect(markup).not.toContain('x-turnstile-token');
  });

  it('disables the send — and only the send — when the widget cannot run', () => {
    turnstileStatus = 'unconfigured';
    try {
      const markup = render({ turnstile: { mode: 'unconfigured' } });
      const button = (testId: string) => markup.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? '';
      expect(button('account-phone-send')).toContain('disabled=""');
      // The e-mail send and the code verify spend no SMS and carry no token.
      expect(button('account-email-send')).not.toContain('disabled');
      expect(button('account-phone-verify')).not.toContain('disabled');
    } finally {
      turnstileStatus = 'ready';
    }
  });
});
