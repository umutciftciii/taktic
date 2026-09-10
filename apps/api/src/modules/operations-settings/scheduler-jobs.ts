/**
 * The four background jobs an operator may switch on, and nothing else.
 *
 * A closed list, exported as a constant, because every layer needs the same
 * one: the settings service maps a key onto its column, the controller refuses
 * a key that is not here with a 404, and the admin screen renders one row per
 * entry. A fifth scheduler becomes manageable by being added here — not by a
 * new endpoint and not by a new table.
 *
 * The keys are stable identifiers, not labels. They appear in URLs and in the
 * audit trail, so they are never translated; the Turkish copy an operator reads
 * lives in the admin app, next to the rest of its copy.
 */
export const SCHEDULER_JOB_KEYS = [
  'entitlement-renewal',
  'unviewed-offer-refund',
  'request-expiry',
  'request-reminder',
  // The two vitrin jobs, added by being added here — no new endpoint and no new
  // table, which is exactly what this list was written to make possible.
  'showcase-lead-sla',
  'showcase-placement-expiry',
] as const;

export type SchedulerJobKey = (typeof SCHEDULER_JOB_KEYS)[number];

export function isSchedulerJobKey(value: string): value is SchedulerJobKey {
  return (SCHEDULER_JOB_KEYS as readonly string[]).includes(value);
}

/**
 * The OperationsSettings column each job is stored in.
 *
 * The column name is also what goes into OperationsSettingsChange.setting,
 * which is the convention the refund window already set: the audit trail names
 * the field, so one table covers every operations setting rather than one table
 * per kind of setting.
 */
export const SCHEDULER_JOB_SETTINGS = {
  'entitlement-renewal': 'entitlementRenewalSchedulerEnabled',
  'unviewed-offer-refund': 'unviewedOfferRefundSchedulerEnabled',
  'request-expiry': 'requestExpirySchedulerEnabled',
  'request-reminder': 'requestReminderSchedulerEnabled',
  'showcase-lead-sla': 'showcaseLeadSlaSchedulerEnabled',
  'showcase-placement-expiry': 'showcasePlacementExpirySchedulerEnabled',
} as const satisfies Record<SchedulerJobKey, string>;

export type SchedulerJobSetting = (typeof SCHEDULER_JOB_SETTINGS)[SchedulerJobKey];

/**
 * Whether flipping this job on starts something that moves money or credits.
 *
 * Read by the admin screen, which shows a plain warning sentence above the two
 * that do. It is a property of the job rather than a string, so the screen
 * cannot decide it differently from the API.
 */
export const SCHEDULER_JOB_MOVES_MONEY = {
  'entitlement-renewal': true,
  'unviewed-offer-refund': true,
  'request-expiry': false,
  'request-reminder': false,
  // Neither moves money. The SLA job breaches a lead and asks a customer a
  // question; the expiry job closes a run whose paid time is already spent, and
  // every reader already checks that window for itself. Cancelling a placement
  // is the operation that would touch money, and it is a person's decision with
  // no automatic refund behind it.
  'showcase-lead-sla': false,
  'showcase-placement-expiry': false,
} as const satisfies Record<SchedulerJobKey, boolean>;
