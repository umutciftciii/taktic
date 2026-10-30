'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import {
  CREDENTIAL_REFUSAL_MESSAGES,
  TURNSTILE_CHALLENGE_FAILED,
  TURNSTILE_FORM_FIELD,
  resolveTestTurnstileToken,
  type TurnstileAction,
  type TurnstileTestOverride,
  type TurnstileWebConfig,
} from '../lib/turnstile';

/**
 * The admin panel's Turnstile adapter (SEC-AUTH-ABUSE-001) — a copy of the
 * web's apps/web/app/request-fields/turnstile.tsx, kept apart only because the
 * two Next applications cannot share a React component through @taktic/shared
 * (it carries no React). The rules it renders under are not copied: they are
 * @taktic/shared's turnstile-web.ts, read by both. Keep the two in step.
 *
 * What follows is the web adapter's own description, which holds here as is.
 *
 * The one Turnstile adapter every customer form shares.
 *
 * A form calls `acquire(action)` right before each protected call — the
 * identity pre-check, the activation link, the SMS code, the submission — and
 * hands the token it gets to the server action or proxy that carries it to
 * the API. Every call is a new challenge and a new token: the API refuses a
 * token it has seen, so there is nothing to keep, and nothing is kept. The
 * token lives in a promise for the length of one request and is never put in
 * state, in the URL, in a draft, in storage or in a sentence on screen.
 *
 * The widget is rendered in "interaction-only" appearance inside the slot the
 * form places above its action buttons: invisible while Cloudflare is
 * satisfied without the customer's help, and drawn in place — on whichever
 * step is showing — when it is not. The slot is outside the step panels for
 * exactly that reason.
 *
 * In `test` mode nothing is loaded from Cloudflare: the token is minted here
 * in the deterministic shape the API's test verifier accepts, and a browser
 * test can steer the outcome through `window.__TAKTIC_TURNSTILE_TEST__`. In
 * `off` mode `acquire` answers null and no header is sent. `unconfigured` is
 * closed: `acquire` rejects and the slot says the check cannot run.
 */

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__takticTurnstileReady';
/** Longer than any interactive challenge should take; a safety net, not a budget. */
const CHALLENGE_TIMEOUT_MS = 120_000;

type TurnstileRenderOptions = {
  sitekey: string;
  action: string;
  execution: 'execute';
  appearance: 'interaction-only';
  callback: (token: string) => void;
  'error-callback': () => void;
  'expired-callback': () => void;
  'timeout-callback': () => void;
};

type TurnstileApi = {
  render: (container: HTMLElement, options: TurnstileRenderOptions) => string;
  execute: (widgetId: string) => void;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
    __takticTurnstileReady?: () => void;
    __TAKTIC_TURNSTILE_TEST__?: TurnstileTestOverride;
  }
}

let scriptLoading: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error(TURNSTILE_CHALLENGE_FAILED));
  }
  if (window.turnstile) {
    return Promise.resolve(window.turnstile);
  }
  if (!scriptLoading) {
    scriptLoading = new Promise<TurnstileApi>((resolve, reject) => {
      window.__takticTurnstileReady = () => {
        if (window.turnstile) resolve(window.turnstile);
        else reject(new Error(TURNSTILE_CHALLENGE_FAILED));
      };
      const script = document.createElement('script');
      script.src = SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.onerror = () => {
        scriptLoading = null;
        reject(new Error(TURNSTILE_CHALLENGE_FAILED));
      };
      document.head.appendChild(script);
    });
  }
  return scriptLoading;
}

export type TurnstileStatus = 'ready' | 'challenging' | 'unconfigured';

export type TurnstileHandle = {
  /**
   * A fresh token for this operation, or null when the stack runs with the
   * check off. Rejects with an Error whose message is
   * TURNSTILE_CHALLENGE_FAILED when no token could be produced.
   */
  acquire: (action: TurnstileAction) => Promise<string | null>;
  status: TurnstileStatus;
  mode: TurnstileWebConfig['mode'];
  /** Where the widget draws. Rendered by TurnstileSlot; forms never touch it. */
  containerRef: React.RefObject<HTMLDivElement | null>;
};

export function useTurnstile(config: TurnstileWebConfig): TurnstileHandle {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetRef = useRef<string | null>(null);
  /** Challenges run one at a time: a blur and a click that both ask get two tokens, in order. */
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const [status, setStatus] = useState<TurnstileStatus>(
    config.mode === 'unconfigured' ? 'unconfigured' : 'ready',
  );

  useEffect(() => {
    return () => {
      if (widgetRef.current && window.turnstile) {
        window.turnstile.remove(widgetRef.current);
        widgetRef.current = null;
      }
    };
  }, []);

  const runCloudflare = useCallback(
    async (siteKey: string, action: TurnstileAction): Promise<string> => {
      const api = await loadTurnstile();
      const container = containerRef.current;
      if (!container) {
        throw new Error(TURNSTILE_CHALLENGE_FAILED);
      }
      // A widget is one action and one token; the next call is a new widget.
      if (widgetRef.current) {
        api.remove(widgetRef.current);
        widgetRef.current = null;
      }
      setStatus('challenging');
      try {
        return await new Promise<string>((resolve, reject) => {
          let settled = false;
          const fail = () => {
            if (settled) return;
            settled = true;
            reject(new Error(TURNSTILE_CHALLENGE_FAILED));
          };
          const timer = setTimeout(fail, CHALLENGE_TIMEOUT_MS);
          try {
            widgetRef.current = api.render(container, {
              sitekey: siteKey,
              action,
              execution: 'execute',
              appearance: 'interaction-only',
              callback: (token) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(token);
              },
              'error-callback': () => {
                clearTimeout(timer);
                fail();
              },
              'expired-callback': () => {
                clearTimeout(timer);
                fail();
              },
              'timeout-callback': () => {
                clearTimeout(timer);
                fail();
              },
            });
            api.execute(widgetRef.current);
          } catch {
            clearTimeout(timer);
            fail();
          }
        });
      } finally {
        setStatus('ready');
      }
    },
    [],
  );

  const acquire = useCallback(
    (action: TurnstileAction): Promise<string | null> => {
      const run = async (): Promise<string | null> => {
        switch (config.mode) {
          case 'off':
            return null;
          case 'test':
            return resolveTestTurnstileToken(action, window.__TAKTIC_TURNSTILE_TEST__);
          case 'cloudflare':
            return runCloudflare(config.siteKey, action);
          case 'unconfigured':
            throw new Error(TURNSTILE_CHALLENGE_FAILED);
        }
      };
      const next = queueRef.current.then(run, run);
      queueRef.current = next.catch(() => undefined);
      return next;
    },
    [config, runCloudflare],
  );

  return { acquire, status, mode: config.mode, containerRef };
}

/**
 * The widget's place in a form. Empty until Cloudflare needs the customer,
 * and a short sentence when the check cannot run on this stack at all.
 */
export function TurnstileSlot({ turnstile }: { turnstile: TurnstileHandle }) {
  return (
    <div className="turnstile-slot" data-testid="turnstile-slot" data-turnstile-mode={turnstile.mode}>
      <div ref={turnstile.containerRef} data-testid="turnstile-container" />
      {turnstile.mode === 'test' ? (
        <span className="sr-only" data-testid="turnstile-test-widget">
          Güvenlik doğrulaması (test)
        </span>
      ) : null}
      {turnstile.status === 'unconfigured' ? (
        <p className="error-message" role="status" data-testid="turnstile-unconfigured">
          Güvenlik doğrulaması şu anda kullanılamıyor. Lütfen daha sonra tekrar deneyin.
        </p>
      ) : null}
    </div>
  );
}

/** Whether an error thrown by `acquire` (or anything else) is the widget's own refusal. */
export function isTurnstileChallengeFailure(error: unknown): boolean {
  return error instanceof Error && error.message === TURNSTILE_CHALLENGE_FAILED;
}

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
  className,
  style,
  children,
  testId,
}: {
  turnstile: TurnstileWebConfig;
  turnstileAction: TurnstileAction;
  action: string;
  className?: string;
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
      className={className}
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
        <div className="error-message" role="alert" data-testid="turnstile-challenge-failed">
          {CREDENTIAL_REFUSAL_MESSAGES.verification}
        </div>
      ) : null}
      <TurnstileSlot turnstile={turnstile} />
    </form>
  );
}
