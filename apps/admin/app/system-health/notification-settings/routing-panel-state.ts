import type { RoutingPreview } from '../../../lib/ops-alert-recipients';

/**
 * What the routing panel's server actions answer (OBS-ALERT-002 PR-B, task
 * B4), kept out of `actions.ts` because a `'use server'` file may export only
 * async functions.
 *
 * A cutover or revert form is one state: `preview` holds the API's preview
 * exactly as it came — the numbers the table prints and the token the apply
 * sends are the same object, so what the operator approves is what was
 * previewed. A refused apply drops the preview (`error`): the operator
 * previews again rather than approving numbers that may have moved.
 */
export type RoutingSwitchState =
  | { kind: 'idle' }
  | { kind: 'preview'; preview: RoutingPreview; at: number }
  | { kind: 'error'; message: string; code: string | null; at: number };

export const ROUTING_SWITCH_IDLE: RoutingSwitchState = { kind: 'idle' };

/** Import, rewrap and rehash: a refusal, or what a key operation did. */
export type RoutingOpState =
  | { kind: 'idle' }
  | { kind: 'error'; message: string; code: string | null; at: number }
  | { kind: 'done'; message: string; at: number };

export const ROUTING_OP_IDLE: RoutingOpState = { kind: 'idle' };

/** COUNTS_CHANGED at apply time (the brief's wording, word for word). */
export const ROUTING_COUNTS_CHANGED_TEXT = 'Önizlemeden bu yana sayılar değişti; yeniden önizleyin.';

/** The pending deliveries a switch cancels, over every status. */
export function routingCancelTotal(preview: Pick<RoutingPreview, 'counts'>): number {
  return preview.counts.PENDING.cancel + preview.counts.FAILED.cancel + preview.counts.SENDING.cancel;
}
