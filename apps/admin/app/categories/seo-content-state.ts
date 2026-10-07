/**
 * What the category SEO content action answers (SEO-004 PR B). A save stays on
 * the tab — the form keeps what was typed — so success is state too.
 */
export type CategorySeoState =
  | { kind: 'idle' }
  | { kind: 'saved'; at: number }
  | { kind: 'error'; message: string; field: string | null; at: number };

export const CATEGORY_SEO_IDLE: CategorySeoState = { kind: 'idle' };
