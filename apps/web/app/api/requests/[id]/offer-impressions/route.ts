import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import {
  OFFER_IMPRESSIONS_MAX,
  isOfferImpressionSurface,
} from '../../../../requests/[id]/offers/offer-impressions';

/**
 * OFFER-VIEW-001: the offers the customer's list or comparison screen showed.
 *
 * A proxy for the same reason the messages route is one: the session cookie is
 * HttpOnly and belongs to this origin. Every decision about what is stamped is
 * the API's — this checks the shape, refuses anything that did not come from
 * this site's own page, and forwards the cookie.
 *
 * Same-origin only. The browser says where a request came from in
 * `Sec-Fetch-Site`, and a fetch from another site cannot set it; a browser too
 * old to send it is held to a matching `Origin` instead. The JSON content type
 * is required as well, so a cross-site form cannot post here without a CORS
 * preflight this route never answers.
 */

const apiUrl =
  process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: RouteContext) {
  if (!isSameOrigin(request) || !request.headers.get('content-type')?.startsWith('application/json')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const cookieHeader = (await cookies()).toString();
  if (!cookieHeader) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const body = readBody(await request.json().catch(() => null));
  if (!body) {
    return NextResponse.json({ error: 'invalid' }, { status: 400 });
  }

  const { id } = await context.params;
  let response: Response;
  try {
    response = await fetch(`${apiUrl}/service-requests/${encodeURIComponent(id)}/offers/impressions`, {
      method: 'POST',
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    // Unreachable is a reason to try again, not a refusal.
    return NextResponse.json({ error: 'unreachable' }, { status: 503 });
  }

  if (!response.ok) {
    return NextResponse.json({ error: 'unavailable' }, { status: response.status });
  }

  return NextResponse.json(await response.json(), {
    status: 200,
    headers: { 'cache-control': 'no-store' },
  });
}

function isSameOrigin(request: NextRequest): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site) {
    return site === 'same-origin';
  }

  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  if (!origin || !host) {
    return false;
  }
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function readBody(value: unknown): { offerIds: string[]; surface: string } | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const { offerIds, surface } = value as { offerIds?: unknown; surface?: unknown };
  if (
    !Array.isArray(offerIds) ||
    offerIds.length === 0 ||
    offerIds.length > OFFER_IMPRESSIONS_MAX ||
    !offerIds.every((offerId) => typeof offerId === 'string' && offerId.length > 0 && offerId.length <= 64) ||
    !isOfferImpressionSurface(surface)
  ) {
    return null;
  }
  return { offerIds, surface };
}
