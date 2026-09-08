import { Logger } from '@nestjs/common';

/**
 * The environment flags that used to decide whether a scheduler ran.
 *
 * They decide nothing now — the answer is a persistent operations setting a
 * super admin maintains — and this exists so that a deployment which still sets
 * one is *told*, rather than left believing a job is on because the variable it
 * has always set still says "true".
 *
 * A warning rather than a boot failure, deliberately. Refusing to start would
 * take an entire API down over a stale line in a deploy config, at exactly the
 * moment an operator most needs the panel that replaces it. And the value is
 * not read for anything, so the running system is correct either way: the log
 * line is the whole point.
 *
 * The variable's value is not echoed. Only its name, which is what an operator
 * needs in order to delete it.
 */
const LEGACY_ENABLE_FLAGS = [
  'ENTITLEMENT_RENEWAL_SCHEDULER_ENABLED',
  'UNVIEWED_OFFER_REFUND_ENABLED',
  'REQUEST_EXPIRY_SCHEDULER_ENABLED',
  'REQUEST_REMINDER_SCHEDULER_ENABLED',
] as const;

export type LegacySchedulerFlag = (typeof LEGACY_ENABLE_FLAGS)[number];

export function warnIfLegacySchedulerFlagSet(logger: Logger, flag: LegacySchedulerFlag): void {
  const raw = process.env[flag]?.trim();
  if (raw === undefined || raw === '') {
    return;
  }

  logger.warn(
    `${flag} is set but no longer has any effect. Whether this job runs is now a ` +
      'persistent operations setting a super admin controls from the admin panel. ' +
      'Remove the variable from the deployment configuration.',
  );
}

export { LEGACY_ENABLE_FLAGS };
