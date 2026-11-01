import type { OpsAlertEmailRouting } from '@prisma/client';
import type { AppEnvironment } from '../../common/app-environment';

/**
 * OBS-ALERT-002 — the last critical recipient / last active channel guard.
 *
 * Pure decision; the service gathers the facts under the recipient lock.
 *
 *  - An operation that leaves at least one ACTIVE critical recipient, or does
 *    not take one away, is always allowed.
 *  - Taking away the last one in production (or an undeclared environment,
 *    which the codebase treats as the strictest answer) under MANAGED routing
 *    with no Telegram channel would leave no channel at all: BLOCKED, and no
 *    confirmation overrides it. (Under ENV_LEGACY managed recipients take no
 *    part in routing, so that block does not apply.)
 *  - Any other way of taking away the last one needs an explicit confirmation.
 */
export type RecipientRemovalDecision = 'ALLOW' | 'CONFIRM_REQUIRED' | 'BLOCKED';

export type RecipientRemovalInput = {
  environment: AppEnvironment | null;
  telegramConfigured: boolean;
  routing: OpsAlertEmailRouting;
  /** ACTIVE ∧ critical recipients left after the operation. */
  liveCriticalAfter: number;
  /** The operation removes an ACTIVE ∧ critical recipient from that set. */
  touchesCritical: boolean;
  confirmed: boolean;
};

export function decideRecipientRemoval(input: RecipientRemovalInput): RecipientRemovalDecision {
  if (input.liveCriticalAfter >= 1 || !input.touchesCritical) return 'ALLOW';
  if (input.routing === 'MANAGED' && (input.environment === 'production' || input.environment === null) && !input.telegramConfigured) return 'BLOCKED';
  return input.confirmed ? 'ALLOW' : 'CONFIRM_REQUIRED';
}
