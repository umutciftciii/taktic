import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * CMP-004 S4 — the provider credits screen asks for its promotion through the
 * session-scoped route and nothing else.
 *
 * `GET /providers/me/credits/promo` takes no id, so the screen cannot be made
 * to ask about another provider, and the id-taking credits route carries no
 * promotion at all. This pins both facts to the source: the page fetches the
 * `me` path, and it never builds a `/credits/promo` path from a provider id.
 */
describe('provider credits page — promo endpoint', () => {
  const source = readFileSync(resolve(__dirname, '../app/providers/[id]/credits/page.tsx'), 'utf8');

  it('fetches the promotion from /providers/me/credits/promo', () => {
    expect(source).toContain("'/providers/me/credits/promo'");
  });

  it('never builds a promo path from the route id', () => {
    expect(source).not.toMatch(/\$\{id\}\/credits\/promo/);
    expect(source).not.toMatch(/credits\.promo/);
  });
});
