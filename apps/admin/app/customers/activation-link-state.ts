/**
 * What the activation-link form shows after a press. It lives in its own
 * module because a `'use server'` file may export only async functions.
 */
export type ActivationLinkState =
  | { kind: 'idle' }
  | { kind: 'issued'; activationUrl: string; expiresAt: string }
  | { kind: 'error'; message: string };

export const ACTIVATION_LINK_IDLE: ActivationLinkState = { kind: 'idle' };
