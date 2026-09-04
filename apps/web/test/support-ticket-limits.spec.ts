import { describe, expect, it } from 'vitest';
import {
  SUPPORT_TICKET_MESSAGE_MAX_LENGTH,
  SUPPORT_TICKET_SUBJECT_MAX_LENGTH,
} from '@taktic/shared';
import limits from '../../../packages/shared/limits.json';

/**
 * The support-ticket limits this app shows are the ones the API enforces.
 *
 * The counters under the ticket form print these numbers and both `maxLength`
 * attributes are set from them, so if the web app ever resolved a different
 * value than the API does the form would promise room the server refuses — or
 * refuse room it allows. Both sides read `packages/shared/limits.json`; this
 * asserts the web half of that, and `apps/api/test/support-tickets.spec.ts`
 * asserts the API half against the same file.
 */
describe('support ticket limits', () => {
  it('are the values carried by the shared limits file', () => {
    expect(SUPPORT_TICKET_SUBJECT_MAX_LENGTH).toBe(limits.supportTicketSubjectMaxLength);
    expect(SUPPORT_TICKET_MESSAGE_MAX_LENGTH).toBe(limits.supportTicketMessageMaxLength);
  });

  it('are 120 characters for a subject and 2000 for a message', () => {
    expect(SUPPORT_TICKET_SUBJECT_MAX_LENGTH).toBe(120);
    expect(SUPPORT_TICKET_MESSAGE_MAX_LENGTH).toBe(2000);
  });
});
