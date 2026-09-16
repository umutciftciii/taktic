'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  TURNSTILE_CHALLENGE_FAILED,
  resolveTestTurnstileToken,
  type TurnstileAction,
  type TurnstileTestOverride,
  type TurnstileWebConfig,
} from '../../lib/turnstile';

/**
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
        <span className="cdash-visually-hidden" data-testid="turnstile-test-widget">
          Güvenlik doğrulaması (test)
        </span>
      ) : null}
      {turnstile.status === 'unconfigured' ? (
        <p className="help-text cdash-notice-error" role="status" data-testid="turnstile-unconfigured">
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
