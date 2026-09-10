import { formatDateTime, type ShowcaseLeadStatus, type ShowcaseProviderLead } from '../../../../lib/api';

/**
 * How a direct lead reads on the business's own screen.
 *
 * The one judgement in here is what "son yanıt" says once the deadline has
 * gone: it becomes the moment the promise was broken rather than a countdown,
 * because a negative countdown is a number nobody can act on and the useful
 * fact is when it happened.
 */

export function showcaseLeadBadgeClass(status: ShowcaseLeadStatus): string {
  switch (status) {
    case 'OPEN':
      return 'pdash-badge pdash-badge-info';
    case 'ANSWERED':
      return 'pdash-badge pdash-badge-success';
    case 'BREACHED':
      return 'pdash-badge pdash-badge-warn';
    case 'RELEASED':
      return 'pdash-badge pdash-badge-danger';
    default:
      return 'pdash-badge pdash-badge-muted';
  }
}

/**
 * The deadline, or what became of it.
 *
 * A lead that was answered says so rather than showing a deadline that no
 * longer means anything; a breached one says when the window closed. Only an
 * open lead shows a time to work towards.
 */
export function leadDeadlineLabel(lead: ShowcaseProviderLead): string {
  if (lead.status === 'ANSWERED' && lead.respondedAt) {
    return `Yanıtlandı · ${formatDateTime(lead.respondedAt)}`;
  }

  if (lead.breachedAt) {
    return `Süre doldu · ${formatDateTime(lead.breachedAt)}`;
  }

  if (lead.status === 'OPEN') {
    return formatDateTime(lead.slaDueAt);
  }

  return '—';
}

/**
 * Whether the business can still act on this lead.
 *
 * A breached lead is deliberately still answerable: the customer has been asked
 * what they want to do and has not necessarily decided, and a business that
 * turned up late should be able to turn up. What it cannot do is answer one the
 * customer has closed or released — the first is over, and the second is an
 * ordinary marketplace request now, offered on from the ordinary screen at the
 * ordinary price.
 */
export function leadIsAnswerable(lead: ShowcaseProviderLead): boolean {
  return lead.status === 'OPEN' || lead.status === 'BREACHED';
}
