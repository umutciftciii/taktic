'use client';

import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import {
  CREDENTIAL_REFUSAL_MESSAGES,
  TURNSTILE_FORM_FIELD,
  type TurnstileAction,
  type TurnstileWebConfig,
} from '../../lib/turnstile';
import { TurnstileSlot, useTurnstile } from './turnstile';

/**
 * A plain HTML form that carries a Turnstile token (SEC-AUTH-ABUSE-001).
 *
 * The sign-in, registration and password-reset forms post to fixed route
 * handlers so a form left open across a deploy still works (@taktic/shared's
 * form-post). This keeps that: the form still posts natively, to the same
 * URL. All it adds is one step in front — on submit the browser's own
 * validation has already passed, a fresh token is asked for the one action
 * this form performs, written into a hidden field, and the form is submitted
 * for real. The route handler moves the field into the header the API reads.
 *
 * One challenge per submission and nothing kept: every submit is a new token,
 * because the API refuses a token it has seen. In "interaction-only"
 * appearance a real person normally sees nothing at all; the widget draws in
 * the slot only when Cloudflare needs them, so there is no CAPTCHA loop to
 * walk through on an ordinary sign-in. If no token could be produced the form
 * says so and stays as it was — nothing is posted without one.
 */
export function TurnstileForm({
  turnstile: config,
  turnstileAction,
  action,
  style,
  children,
  testId,
}: {
  turnstile: TurnstileWebConfig;
  turnstileAction: TurnstileAction;
  action: string;
  style?: CSSProperties;
  children: ReactNode;
  testId?: string;
}) {
  const turnstile = useTurnstile(config);
  const tokenRef = useRef<HTMLInputElement | null>(null);
  const submittingRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [challengeFailed, setChallengeFailed] = useState(false);

  // Coming back to this page through the browser's back button restores it
  // from the page cache exactly as it was left — mid-submit. The spent token
  // goes, and the form is usable again.
  useEffect(() => {
    function onPageShow(event: PageTransitionEvent) {
      if (!event.persisted) return;
      submittingRef.current = false;
      setBusy(false);
      if (tokenRef.current) tokenRef.current.value = '';
    }
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    setChallengeFailed(false);
    const form = event.currentTarget;
    try {
      const token = await turnstile.acquire(turnstileAction);
      if (tokenRef.current) tokenRef.current.value = token ?? '';
    } catch {
      submittingRef.current = false;
      setBusy(false);
      setChallengeFailed(true);
      return;
    }
    // `submit()` skips this handler and posts the form as it stands, hidden
    // token included. The page navigates away; nothing here runs after it.
    form.submit();
  }

  return (
    <form
      action={action}
      method="post"
      style={style}
      onSubmit={onSubmit}
      aria-busy={busy || undefined}
      data-testid={testId}
      data-turnstile-action={turnstileAction}
    >
      <input ref={tokenRef} type="hidden" name={TURNSTILE_FORM_FIELD} defaultValue="" />
      {children}
      {challengeFailed ? (
        <div className="auth-screen-error" role="alert" data-testid="turnstile-challenge-failed">
          {CREDENTIAL_REFUSAL_MESSAGES.verification}
        </div>
      ) : null}
      <TurnstileSlot turnstile={turnstile} />
    </form>
  );
}
