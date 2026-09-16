'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';
import { turnstileHeaders } from '../../lib/turnstile';

export type IdentityStatus =
  | 'idle' | 'checking' | 'ok' | 'login-required' | 'activation-required'
  | 'identity-conflict' | 'unavailable' | 'error';

export type IdentityState = { status: IdentityStatus; seq: number; phone: string; email: string };

export type IdentityAction =
  | { type: 'start'; phone: string; email: string }
  | { type: 'result'; seq: number; status: Exclude<IdentityStatus, 'idle' | 'checking' | 'error'> }
  | { type: 'failure'; seq: number }
  | { type: 'fields'; phone: string; email: string };

/**
 * The pre-check's state machine, kept pure so the rules that matter can be
 * tested without a browser:
 *
 * - only the latest call's answer counts (`seq`);
 * - a changed number or address throws the answer away — and advances `seq`
 *   too, so a call that was in flight for the *old* pair can never land on
 *   the new one, whether or not the hook managed to abort it;
 * - an answer lands only on a check that is still running: never on `idle`,
 *   never on `error`.
 */
export function identityReducer(state: IdentityState, action: IdentityAction): IdentityState {
  switch (action.type) {
    case 'start':
      return { status: 'checking', seq: state.seq + 1, phone: action.phone, email: action.email };
    case 'result':
      return action.seq === state.seq && state.status === 'checking' ? { ...state, status: action.status } : state;
    case 'failure':
      return action.seq === state.seq && state.status === 'checking' ? { ...state, status: 'error' } : state;
    case 'fields':
      return action.phone === state.phone && action.email === state.email
        ? state
        : { status: 'idle', seq: state.seq + 1, phone: action.phone, email: action.email };
  }
}

const API_STATUSES = new Set(['new-customer', 'login-required', 'activation-required', 'identity-conflict', 'unavailable']);

export function useIdentityCheck(input: {
  name: string;
  phone: string;
  email: string;
  enabled: boolean;
  /**
   * The Turnstile token for one check, asked for right before the POST and
   * carried in its header. A widget that cannot produce one fails the check
   * the way a dropped connection does — `error`, with "Tekrar dene" — and
   * says nothing more, because the check has not been made.
   */
  acquireToken?: () => Promise<string | null>;
}) {
  const [state, dispatch] = useReducer(identityReducer, { status: 'idle', seq: 0, phone: '', email: '' });
  const controllerRef = useRef<AbortController | null>(null);
  /*
   * The number a `check()` call tags its fetch with, kept in lock-step with
   * the reducer's `seq` by counting the same two events the reducer counts —
   * a `start`, and a `fields` action that really changed the pair — against
   * the same last-seen pair (`fieldsRef` mirrors the reducer's own
   * `phone`/`email`). Counted here rather than read back from state: a
   * dispatch queued from an effect may not have rendered yet when the blur
   * that calls `check()` arrives, and a number read from state at that moment
   * would be one behind, so the answer would never match and the check
   * would hang in `checking`.
   */
  const seqRef = useRef(0);
  const fieldsRef = useRef({ phone: '', email: '' });

  useEffect(() => {
    if (fieldsRef.current.phone !== input.phone || fieldsRef.current.email !== input.email) {
      // A different pair: whatever is in flight was asked about the old one,
      // and the reducer is about to advance `seq` for the same change.
      controllerRef.current?.abort();
      controllerRef.current = null;
      fieldsRef.current = { phone: input.phone, email: input.email };
      seqRef.current += 1;
    }
    dispatch({ type: 'fields', phone: input.phone, email: input.email });
  }, [input.phone, input.email]);

  const check = useCallback(() => {
    if (!input.enabled) return;
    const phone = input.phone.trim();
    const email = input.email.trim();
    if (!input.name.trim() || phone.length < 7 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return;

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    fieldsRef.current = { phone: input.phone, email: input.email };
    seqRef.current += 1;
    const seq = seqRef.current;
    dispatch({ type: 'start', phone: input.phone, email: input.email });

    const token = input.acquireToken ? input.acquireToken() : Promise.resolve<string | null>(null);
    token
      .then((value) =>
        fetch('/api/auth/request-identity-check', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...turnstileHeaders(value) },
          body: JSON.stringify({ phone, email }),
          signal: controller.signal,
        }),
      )
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const body = (await response.json()) as { status?: string };
        if (!body.status || !API_STATUSES.has(body.status)) throw new Error('bad body');
        // Aborted while the body was being read: the pair changed under it.
        if (controller.signal.aborted) return;
        const status = body.status === 'new-customer'
          ? 'ok'
          : (body.status as 'login-required' | 'activation-required' | 'identity-conflict' | 'unavailable');
        dispatch({ type: 'result', seq, status });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        void error;
        dispatch({ type: 'failure', seq });
      });
  }, [input.enabled, input.name, input.phone, input.email, input.acquireToken]);

  return { status: input.enabled ? state.status : ('ok' as const), check, retry: check, gateOpen: !input.enabled || state.status === 'ok' };
}
