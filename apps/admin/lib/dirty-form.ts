/**
 * The decisions behind `StickyActionBar`'s "unsaved changes" guard.
 *
 * A form is dirty when what it would submit now differs from what it would
 * have submitted when the page rendered. Comparing the submitted entries —
 * rather than tracking which fields were touched — means typing a value and
 * deleting it again is not a change, and a reset really does clear the state.
 *
 * Kept free of the DOM so both rules are unit-tested in node; the component
 * only feeds them `FormData` entries and click details.
 */

/**
 * React writes its own hidden inputs into a server-action form (the action id
 * and bound arguments, all named `$ACTION…`). They identify the action, not
 * anything the operator typed, so they are never part of the comparison.
 */
function isFrameworkField(name: string): boolean {
  return name.startsWith('$ACTION');
}

export type FormEntries = Array<[string, unknown]>;

/** What `form` would submit right now, in submission order. */
export function readEntries(form: HTMLFormElement): FormEntries {
  return Array.from(new FormData(form).entries());
}

type FieldLike = {
  name: string;
  type?: string;
  value?: string;
  checked?: boolean;
  multiple?: boolean;
  options?: ArrayLike<{ value: string; selected: boolean }>;
};

const NOT_A_VALUE = new Set(['submit', 'button', 'reset', 'image', 'file']);

/**
 * Writes submitted entries back into a form's fields — the inverse of
 * `readEntries` for everything a person can type or pick. Used when React has
 * reset a form whose save did not land. Files cannot be written back (a file
 * input only takes a user's choice), and React's own `$ACTION…` fields are
 * left alone.
 */
export function applyEntries(form: { elements: ArrayLike<unknown> }, entries: FormEntries): void {
  const values = new Map<string, string[]>();
  for (const [name, value] of entries) {
    if (typeof value !== 'string') continue;
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  const used = new Map<string, number>();

  for (const element of Array.from(form.elements) as FieldLike[]) {
    const name = element.name;
    if (!name || isFrameworkField(name) || NOT_A_VALUE.has(element.type ?? '')) continue;
    const list = values.get(name) ?? [];

    if (element.type === 'checkbox' || element.type === 'radio') {
      element.checked = list.includes(element.value ?? 'on');
    } else if (element.options && element.multiple) {
      for (const option of Array.from(element.options)) option.selected = list.includes(option.value);
    } else {
      const index = used.get(name) ?? 0;
      used.set(name, index + 1);
      element.value = list[index] ?? '';
    }
  }
}

/** A stable string for "what this form would submit", in submission order. */
export function snapshotEntries(entries: Iterable<[string, unknown]>): string {
  const kept: Array<[string, string]> = [];
  for (const [name, value] of entries) {
    if (isFrameworkField(name)) continue;
    if (typeof value === 'string') {
      kept.push([name, value]);
    } else if (value && typeof value === 'object' && 'name' in value && 'size' in value) {
      // A chosen file: its name and size are enough to tell it changed.
      const file = value as { name: string; size: number };
      kept.push([name, file.size > 0 ? `file:${file.name}:${file.size}` : '']);
    }
  }
  return JSON.stringify(kept);
}

export type LinkClick = {
  href: string | null;
  /** `location.href` of the page the click happened on. */
  currentHref: string;
  target: string | null;
  download: boolean;
  button: number;
  modifierKey: boolean;
  defaultPrevented: boolean;
};

/**
 * Whether a click on a link would take the operator away from this page in
 * this tab — the only clicks worth asking about. A new tab, a download, a
 * modified click, an in-page `#anchor` and a link to the same URL leave the
 * form where it is.
 */
export function isLeavingClick(click: LinkClick): boolean {
  if (click.defaultPrevented || click.button !== 0 || click.modifierKey || click.download) return false;
  if (click.target && click.target !== '_self') return false;
  if (!click.href) return false;

  let next: URL;
  let current: URL;
  try {
    current = new URL(click.currentHref);
    next = new URL(click.href, current);
  } catch {
    return false;
  }
  if (next.protocol !== 'http:' && next.protocol !== 'https:') return false;
  const samePage =
    next.origin === current.origin && next.pathname === current.pathname && next.search === current.search;
  return !samePage;
}
