import { NextRequest, NextResponse } from 'next/server';
import { apiFetch } from '../../../../lib/api';

/**
 * The neighbourhoods of one district, for the request form's third select.
 *
 * A same-origin hop rather than a browser call straight to the API: the form is
 * public and renders wherever the web app does, so it must not depend on the
 * API being reachable from the visitor's network under a build-time public URL.
 * The server already knows how to reach the API, and this reuses exactly that.
 *
 * Read-only, no authentication, no application data — the response is a list of
 * place names.
 */
export async function GET(request: NextRequest) {
  const city = request.nextUrl.searchParams.get('city')?.trim() ?? '';
  const district = request.nextUrl.searchParams.get('district')?.trim() ?? '';

  if (!city || !district) {
    return NextResponse.json([]);
  }

  try {
    const neighborhoods = await apiFetch<string[]>(
      `/locations/neighborhoods?city=${encodeURIComponent(city)}&district=${encodeURIComponent(district)}`,
    );
    return NextResponse.json(neighborhoods);
  } catch {
    // The field is optional. An unreachable list leaves it empty and says so on
    // screen rather than blocking a request the customer can already submit.
    return NextResponse.json([], { status: 503 });
  }
}
