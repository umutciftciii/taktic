import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

/**
 * The browser's window onto its own session.
 *
 * A proxy rather than a direct call to the API, for the reason every other
 * browser-facing read in this app goes through Next: the session cookie is
 * HttpOnly and scoped to this origin, and the API may not even be reachable
 * from a visitor's network. Forwarding the cookie server-side keeps the browser
 * talking to one origin and keeps the cookie unreadable by script.
 *
 * GET  reports how much life the session has left — and deliberately does not
 *      record activity, so an open tab cannot keep an unattended browser signed
 *      in. That is what makes an idle warning possible at all.
 * POST records activity: the throttled heartbeat behind real interaction, and
 *      the "stay signed in" button.
 *
 * Neither carries personal data. Two timestamps, the policy's own durations and
 * the server's clock — the clock being the point, since the countdown has to be
 * measured against the machine that will actually decide.
 */

const apiUrl =
  process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export const dynamic = 'force-dynamic';

export async function GET() {
  return proxy('/auth/session', 'GET');
}

export async function POST() {
  return proxy('/auth/session/touch', 'POST');
}

async function proxy(path: string, method: 'GET' | 'POST') {
  const cookieHeader = (await cookies()).toString();

  // No cookie at all is "not signed in", answered here rather than by a round
  // trip that can only say the same thing.
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
    // The API is unreachable. 503, never 401: a network blip must not read as
    // "your session ended" and throw somebody out of a form they were filling in.
    return NextResponse.json({ error: 'unreachable' }, { status: 503 });
  }

  if (response.status === 401) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  if (!response.ok) {
    return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  }

  return NextResponse.json(await response.json(), {
    status: 200,
    headers: { 'cache-control': 'no-store' },
  });
}
