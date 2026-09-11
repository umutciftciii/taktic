import { NextRequest, NextResponse } from 'next/server';
import { apiFetch, type ShowcaseFeed } from '../../../../lib/api';

/**
 * The vitrin cards that match one category and one place, for the marketplace
 * request form.
 *
 * A same-origin hop rather than a browser call straight to the API, for exactly
 * the reason the neighbourhood list already takes one: the request form is
 * public and renders wherever the web app does, so it must not depend on the
 * API being reachable from the visitor's network under a build-time public URL.
 *
 * Read-only, no authentication, and it forwards only the three things the feed
 * accepts from a visitor. In particular there is no `limit` and no `cursor`
 * pass-through: this block offers a handful of businesses beside a form, and a
 * client that could page through the whole shelf from inside it would be a
 * second, unowned copy of the discovery surface.
 */
export async function GET(request: NextRequest) {
  const params = new URLSearchParams();

  const categoryId = request.nextUrl.searchParams.get('categoryId')?.trim() ?? '';
  const city = request.nextUrl.searchParams.get('city')?.trim() ?? '';
  const district = request.nextUrl.searchParams.get('district')?.trim() ?? '';

  /*
   * Both are required *here* even though the feed itself needs neither.
   *
   * The home page's shelf is a shelf; this is an answer to "who could take
   * this exact job". Without a category and a district it would be the shelf
   * again, wedged into the middle of a form — which is noise beside a question
   * the customer is halfway through answering.
   */
  if (!categoryId || !city || !district) {
    return NextResponse.json({ cards: [] });
  }

  params.set('categoryId', categoryId);
  params.set('city', city);
  params.set('district', district);

  const neighborhood = request.nextUrl.searchParams.get('neighborhood')?.trim() ?? '';
  if (neighborhood) {
    params.set('neighborhood', neighborhood);
  }

  try {
    const feed = await apiFetch<ShowcaseFeed>(`/showcase/feed?${params.toString()}`);
    return NextResponse.json({ cards: feed.cards.slice(0, 4) });
  } catch {
    // The block is an offer, not a step. An unreachable feed leaves the form
    // exactly as it was rather than blocking a request the customer can already
    // submit.
    return NextResponse.json({ cards: [] }, { status: 503 });
  }
}
