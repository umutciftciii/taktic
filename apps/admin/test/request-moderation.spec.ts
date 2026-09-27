import { describe, expect, it } from 'vitest';
import { isInModeration, moderationMove } from '../lib/request-moderation';

/**
 * The request screen's moderation buttons (PR #118 review, finding 2): only
 * the pre-market queue — SUBMITTED, IN_REVIEW, APPROVED — offers "İncelemeye
 * al" and "Onayla". Every status of every other flow offers neither.
 */
describe('request moderation moves', () => {
  it('offers both moves inside the queue, the current one as "Mevcut"', () => {
    expect(moderationMove('SUBMITTED', 'IN_REVIEW')).toBe('available');
    expect(moderationMove('SUBMITTED', 'APPROVED')).toBe('available');
    expect(moderationMove('IN_REVIEW', 'IN_REVIEW')).toBe('current');
    expect(moderationMove('IN_REVIEW', 'APPROVED')).toBe('available');
    expect(moderationMove('APPROVED', 'IN_REVIEW')).toBe('available');
    expect(moderationMove('APPROVED', 'APPROVED')).toBe('current');
  });

  it.each(['DRAFT', 'MATCHED', 'COMPLETED', 'REJECTED', 'CANCELLED', 'EXPIRED'])(
    'offers no move out of %s',
    (status) => {
      expect(isInModeration(status)).toBe(false);
      expect(moderationMove(status, 'IN_REVIEW')).toBe('hidden');
      expect(moderationMove(status, 'APPROVED')).toBe('hidden');
    },
  );

  it('treats an unknown status as outside the queue', () => {
    expect(moderationMove('SOMETHING_NEW', 'APPROVED')).toBe('hidden');
  });
});
