import type { Logger } from '@nestjs/common';

/**
 * REL-002 Faz 5 — the match-round lifecycle's operational events, as one
 * greppable log line each.
 *
 * There is no metrics stack to count into, so each moment an operator would
 * want a counter for is written as `rel002_event event=<name> key=value …`:
 * `grep rel002_event | grep event=manual_round_opened | wc -l` is
 * `manual_round_open_total`, and so on. The admin panel's own counts (the
 * MATCH_REVIEW queue, the incident queue) are the standing figures.
 *
 * Ids, numbers and enum values only — never a name, a phone number, an
 * e-mail address, an address or a free-text note. `Rel002EventFields` admits
 * nothing but strings, numbers, booleans and null, and callers pass ids.
 */
export type Rel002Event =
  | 'service_issue_reported'
  | 'round_reopened_automatically'
  | 'match_review_entered'
  | 'manual_round_opened'
  | 'incident_adjudicated'
  | 'incident_correction_applied'
  | 'reliability_review_opened';

export type Rel002EventFields = Record<string, string | number | boolean | null>;

export function formatRel002Event(event: Rel002Event, fields: Rel002EventFields): string {
  const pairs = Object.entries(fields).map(([key, value]) => `${key}=${value === null ? '-' : String(value)}`);
  return ['rel002_event', `event=${event}`, ...pairs].join(' ');
}

export function logRel002Event(
  logger: Pick<Logger, 'log'>,
  event: Rel002Event,
  fields: Rel002EventFields,
): void {
  logger.log(formatRel002Event(event, fields));
}
