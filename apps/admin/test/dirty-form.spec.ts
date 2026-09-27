import { describe, expect, it } from 'vitest';
import { applyEntries, isLeavingClick, snapshotEntries, type LinkClick } from '../lib/dirty-form';

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

describe('writing submitted entries back', () => {
  it('restores text, checkboxes, single and multiple selects, and repeated names in order', () => {
    const title = { name: 'title', type: 'text', value: 'eski' };
    const active = { name: 'active', type: 'checkbox', value: 'on', checked: true };
    const kind = { name: 'kind', type: 'select-one', value: 'a', options: [{ value: 'a', selected: true }, { value: 'b', selected: false }] };
    const tags = {
      name: 'tags',
      type: 'select-multiple',
      multiple: true,
      options: [
        { value: 'x', selected: false },
        { value: 'y', selected: true },
      ],
    };
    const first = { name: 'line', type: 'text', value: '' };
    const second = { name: 'line', type: 'text', value: '' };
    const radioA = { name: 'r', type: 'radio', value: 'a', checked: true };
    const radioB = { name: 'r', type: 'radio', value: 'b', checked: false };
    const submit = { name: 'intent', type: 'submit', value: 'save' };
    const action = { name: '$ACTION_ID_1', type: 'hidden', value: 'keep' };

    applyEntries(
      { elements: [title, active, kind, tags, first, second, radioA, radioB, submit, action] },
      [
        ['title', 'yeni'],
        ['kind', 'b'],
        ['tags', 'x'],
        ['line', 'bir'],
        ['line', 'iki'],
        ['r', 'b'],
      ],
    );

    expect(title.value).toBe('yeni');
    expect(active.checked).toBe(false);
    expect(kind.value).toBe('b');
    expect(tags.options.map((option) => option.selected)).toEqual([true, false]);
    expect([first.value, second.value]).toEqual(['bir', 'iki']);
    expect([radioA.checked, radioB.checked]).toEqual([false, true]);
    expect(submit.value).toBe('save');
    expect(action.value).toBe('keep');
  });
});
