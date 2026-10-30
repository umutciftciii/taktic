import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_REFUSAL_MESSAGES,
  TURNSTILE_ACTIONS,
  TURNSTILE_FORM_FIELD,
  credentialRefusalOf,
  isCredentialRefusal,
  readTurnstileFormToken,
  type TurnstileWebConfig,
} from '../lib/turnstile';
import { TurnstileForm } from '../app/request-fields/turnstile-form';
import turnstile from '../../../packages/shared/turnstile.json';

/**
 * SEC-AUTH-ABUSE-001 on the web: the credential forms keep their fixed,
 * deploy-proof POST targets and gain one hidden field the route handler moves
 * into the API's header. The refusal vocabulary those handlers hand back is
 * about the check, never about the account.
 */

function render(mode: 'test' | 'cloudflare' | 'unconfigured') {
  const config: TurnstileWebConfig = mode === 'cloudflare' ? { mode, siteKey: 'site-key' } : { mode };
  return renderToStaticMarkup(
    createElement(TurnstileForm, {
      turnstile: config,
      turnstileAction: TURNSTILE_ACTIONS.login,
      action: '/login/submit',
      testId: 'login-form',
      children: createElement('button', { type: 'submit' }, 'Giriş Yap'),
    }),
  );
}

describe('TurnstileForm', () => {
  it('posts natively to its fixed URL with an empty token field the submit fills', () => {
    const markup = render('test');
    expect(markup).toMatch(/<form[^>]*action="\/login\/submit"[^>]*method="post"/);
    expect(markup).toContain(`name="${TURNSTILE_FORM_FIELD}"`);
    expect(markup).toMatch(new RegExp(`<input type="hidden" name="${TURNSTILE_FORM_FIELD}" value=""`));
    expect(markup).toContain('data-turnstile-action="login"');
    expect(markup).toContain('data-testid="turnstile-slot"');
  });

  it('says the check cannot run on a stack with no site key, instead of posting without one', () => {
    expect(render('unconfigured')).toContain('data-testid="turnstile-unconfigured"');
  });

  it('never renders a token or the site key into the page as text', () => {
    expect(render('cloudflare')).not.toContain('site-key');
  });
});

describe('the credential actions are part of the one shared contract', () => {
  it('names an action per credential route, the same strings the API reads', () => {
    expect(TURNSTILE_ACTIONS.login).toBe(turnstile.actions.login);
    expect(TURNSTILE_ACTIONS.register).toBe('register');
    expect(TURNSTILE_ACTIONS.passwordReset).toBe('password-reset');
    expect(TURNSTILE_ACTIONS.emailVerificationResend).toBe('email-verification-resend');
    // Cloudflare accepts up to 32 characters of [A-Za-z0-9_-] as an action.
    for (const action of Object.values(TURNSTILE_ACTIONS)) {
      expect(action).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    }
  });
});

describe('readTurnstileFormToken', () => {
  it('reads the field trimmed, and nothing for a blank or absent one', () => {
    const data = new FormData();
    expect(readTurnstileFormToken(data)).toBeNull();
    data.set(TURNSTILE_FORM_FIELD, '   ');
    expect(readTurnstileFormToken(data)).toBeNull();
    data.set(TURNSTILE_FORM_FIELD, ' tok ');
    expect(readTurnstileFormToken(data)).toBe('tok');
  });
});

describe('credentialRefusalOf', () => {
  const answer = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it.each([
    [429, { code: 'AUTH_TEMPORARILY_LOCKED' }, 'locked'],
    [429, {}, 'locked'],
    [403, { code: 'TURNSTILE_REQUIRED' }, 'verification'],
    [403, { code: 'TURNSTILE_FAILED' }, 'verification'],
    [503, { code: 'TURNSTILE_UNAVAILABLE' }, 'verification-unavailable'],
    [403, { message: 'User is inactive' }, null],
    [401, { code: 'INVALID_CREDENTIALS' }, null],
    [409, { code: 'CUSTOMER_IDENTITY_CONFLICT' }, null],
    [503, { message: 'down' }, null],
  ])('%i %j → %s', async (status, body, expected) => {
    expect(await credentialRefusalOf(answer(status, body))).toBe(expected);
  });

  it('every refusal has a sentence, and none of them mentions an account', () => {
    for (const message of Object.values(CREDENTIAL_REFUSAL_MESSAGES)) {
      expect(message).not.toMatch(/kayıtlı değil|bulunamadı|hesap yok|mevcut değil/i);
    }
    expect(isCredentialRefusal('locked')).toBe(true);
    expect(isCredentialRefusal('1')).toBe(false);
  });
});
