import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * What an open thread polls, and how it says "I have read this".
 *
 * A proxy for the same reason the session route is one: the session cookie is
 * HttpOnly and belongs to this origin, and the browser should not need to reach
 * the API host at all. Every authorization decision still happens in the API —
 * this forwards the cookie and the cursor and nothing else, and a caller who is
 * not a party to the thread gets the API's own 404 back unchanged.
 *
 * GET  everything written after `after`, or the most recent page without it.
 * POST marks the thread read by the caller.
 */

const apiUrl =
  process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ threadId: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const { threadId } = await context.params;
  const after = request.nextUrl.searchParams.get('after');
  const before = request.nextUrl.searchParams.get('before');

  const query = new URLSearchParams();
  if (after) {
    query.set('after', after);
  }
  if (before) {
    query.set('before', before);
  }

  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return proxy(`/messages/threads/${encodeURIComponent(threadId)}/messages${suffix}`, 'GET');
}

export async function POST(_request: NextRequest, context: RouteContext) {
  const { threadId } = await context.params;
  return proxy(`/messages/threads/${encodeURIComponent(threadId)}/read`, 'POST');
}

async function proxy(path: string, method: 'GET' | 'POST') {
  const cookieHeader = (await cookies()).toString();
  if (!cookieHeader) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  let response: Response;
  try {
    response = await fetch(`${apiUrl}${path}`, {
      method,
      headers: { cookie: cookieHeader },
      cache: 'no-store',
    });
  } catch {
    // Unreachable is not "forbidden" and not "empty". The thread screen shows a
    // "could not refresh" notice for this and keeps what it already has.
    return NextResponse.json({ error: 'unreachable' }, { status: 503 });
  }

  // The API's own status is passed through so the screen can tell an access
  // refusal from a network problem — and so it never invents an empty list for
  // either.
  if (!response.ok) {
    return NextResponse.json({ error: 'unavailable' }, { status: response.status });
  }

  return NextResponse.json(await response.json(), {
    status: 200,
    headers: { 'cache-control': 'no-store' },
  });
}
