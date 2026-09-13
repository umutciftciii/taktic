'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';

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
 * The pre-check's state machine, kept pure so the two rules that matter can be
 * tested without a browser: only the latest call's answer counts, and a
 * changed number or address throws the answer away.
 */
export function identityReducer(state: IdentityState, action: IdentityAction): IdentityState {
  switch (action.type) {
    case 'start':
      return { status: 'checking', seq: state.seq + 1, phone: action.phone, email: action.email };
    case 'result':
      return action.seq === state.seq ? { ...state, status: action.status } : state;
    case 'failure':
      return action.seq === state.seq ? { ...state, status: 'error' } : state;
    case 'fields':
      return action.phone === state.phone && action.email === state.email ? state : { ...state, status: 'idle', phone: action.phone, email: action.email };
  }
}

const API_STATUSES = new Set(['new-customer', 'login-required', 'activation-required', 'identity-conflict', 'unavailable']);

export function useIdentityCheck(input: { name: string; phone: string; email: string; enabled: boolean }) {
  const [state, dispatch] = useReducer(identityReducer, { status: 'idle', seq: 0, phone: '', email: '' });
  const controllerRef = useRef<AbortController | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
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
    seqRef.current += 1;
    const seq = seqRef.current;
    dispatch({ type: 'start', phone: input.phone, email: input.email });

    fetch('/api/auth/request-identity-check', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone, email }), signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const body = (await response.json()) as { status?: string };
        if (!body.status || !API_STATUSES.has(body.status)) throw new Error('bad body');
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
  }, [input.enabled, input.name, input.phone, input.email]);

  return { status: input.enabled ? state.status : ('ok' as const), check, retry: check, gateOpen: !input.enabled || state.status === 'ok' };
}
