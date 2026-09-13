import { describe, expect, it } from 'vitest';
import { draftConsumedBySubmission, draftStateFor, readDraftState } from '../lib/draft-state';

/**
 * The rule that keeps a successful submission from orphaning somebody else's
 * draft: the cookie goes only when the draft it names was opened into the
 * form that was just sent. A wrong-account session's request never consumed
 * the owner's row, and clearing the cookie would leave that row with no way
 * back to it.
 */
describe('draft state', () => {
  it('names what the page found', () => {
    expect(draftStateFor({ restored: true, wrongAccount: false })).toBe('restored');
    expect(draftStateFor({ restored: false, wrongAccount: true })).toBe('wrong-account');
    expect(draftStateFor({ restored: false, wrongAccount: false })).toBe('none');
  });

  it('reads the posted field and treats anything else as none', () => {
    const form = new FormData();
    expect(readDraftState(form)).toBe('none');
    form.set('draftState', 'wrong-account');
    expect(readDraftState(form)).toBe('wrong-account');
    form.set('draftState', 'restored');
    expect(readDraftState(form)).toBe('restored');
    form.set('draftState', 'anything');
    expect(readDraftState(form)).toBe('none');
  });

  it('clears the cookie only for a draft the submission could have used up', () => {
    expect(draftConsumedBySubmission('restored')).toBe(true);
    expect(draftConsumedBySubmission('wrong-account')).toBe(false);
    expect(draftConsumedBySubmission('none')).toBe(false);
  });
});
