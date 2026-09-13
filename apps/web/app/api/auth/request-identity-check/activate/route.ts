import { NextRequest, NextResponse } from 'next/server';
import { apiUrl } from '../../../../api-base';
import { clientForwardingHeaders } from '../../../../../lib/forwarded-for';

/**
 * Same-origin hop for the identity-check activation. Forwards the body as-is
 * and the API's status as-is; no cookies travel (the endpoint is session-less),
 * and the client address is forwarded only under the trusted-proxy rule.
 */
export async function POST(request: NextRequest) {
  const body = await request.text();
  try {
    const upstream = await fetch(`${apiUrl}/auth/request-identity-check/activate`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', ...(await clientForwardingHeaders()) },
      body,
    });
    return new NextResponse(await upstream.text(), {
      status: upstream.status,
      headers: { 'content-type': 'application/json' },
    });
  } catch {
    return NextResponse.json({ code: 'IDENTITY_CHECK_UNAVAILABLE' }, { status: 503 });
  }
}
