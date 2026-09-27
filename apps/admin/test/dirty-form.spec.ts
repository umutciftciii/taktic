import { describe, expect, it } from 'vitest';
import { isLeavingClick, snapshotEntries, type LinkClick } from '../lib/dirty-form';

/** ADMIN-DESIGN-001 Faz 2 — StickyActionBar's "unsaved changes" rules. */
describe('dirty form snapshot', () => {
  it('is equal for the same submitted values, and differs when one changes', () => {
    const before = snapshotEntries([['name', 'A'], ['enabled', 'true']]);
    expect(snapshotEntries([['name', 'A'], ['enabled', 'true']])).toBe(before);
    expect(snapshotEntries([['name', 'B'], ['enabled', 'true']])).not.toBe(before);
  });

  it('treats typing a value and deleting it again as no change', () => {
    const before = snapshotEntries([['note', '']]);
    expect(snapshotEntries([['note', '']])).toBe(before);
  });

  it("ignores React's own server-action fields", () => {
    const before = snapshotEntries([['name', 'A']]);
    expect(snapshotEntries([['$ACTION_ID_abc', ''], ['name', 'A'], ['$ACTION_REF_1', 'x']])).toBe(before);
  });

  it('sees a checkbox turned off (its entry disappears)', () => {
    expect(snapshotEntries([['flag', 'on']])).not.toBe(snapshotEntries([]));
  });

  it('tells files apart by name and size, and an empty file input from none chosen', () => {
    const empty = { name: '', size: 0 };
    const chosen = { name: 'a.pdf', size: 10 };
    expect(snapshotEntries([['doc', empty]])).toBe(snapshotEntries([['doc', { name: '', size: 0 }]]));
    expect(snapshotEntries([['doc', chosen]])).not.toBe(snapshotEntries([['doc', empty]]));
  });
});

describe('leaving click', () => {
  const base: LinkClick = {
    href: '/campaigns',
    currentHref: 'http://admin.test/operations-settings',
    target: null,
    download: false,
    button: 0,
    modifierKey: false,
    defaultPrevented: false,
  };

  it('asks about a plain link to another page', () => {
    expect(isLeavingClick(base)).toBe(true);
    expect(isLeavingClick({ ...base, href: '/operations-settings?tab=x' })).toBe(true);
  });

  it('does not ask about a new tab, a download, a modified or non-primary click', () => {
    expect(isLeavingClick({ ...base, target: '_blank' })).toBe(false);
    expect(isLeavingClick({ ...base, download: true })).toBe(false);
    expect(isLeavingClick({ ...base, modifierKey: true })).toBe(false);
    expect(isLeavingClick({ ...base, button: 1 })).toBe(false);
    expect(isLeavingClick({ ...base, defaultPrevented: true })).toBe(false);
  });

  it('does not ask about an in-page anchor or the same URL', () => {
    expect(isLeavingClick({ ...base, href: '#kaydet' })).toBe(false);
    expect(isLeavingClick({ ...base, href: '/operations-settings' })).toBe(false);
  });

  it('does not ask about mailto: or tel: links, or a missing href', () => {
    expect(isLeavingClick({ ...base, href: 'mailto:a@b.c' })).toBe(false);
    expect(isLeavingClick({ ...base, href: 'tel:+90' })).toBe(false);
    expect(isLeavingClick({ ...base, href: null })).toBe(false);
  });

  it('treats _self as this tab', () => {
    expect(isLeavingClick({ ...base, target: '_self' })).toBe(true);
  });
});
