import { headers } from 'next/headers';

/**
 * Whether to pass the client's forwarded address on to the API.
 *
 * Never computed here. When WEB_TRUST_PROXY is on, the X-Forwarded-For the web
 * received was written by a trusted edge in front of it, and it is forwarded
 * untouched — the API's own `trust proxy` hop count (TRUST_PROXY) picks the
 * real client out of it. When the flag is off nothing is forwarded, the API
 * sees the web server's own address, and a client-written header can change
 * nothing. There is no third mode.
 */
export function forwardedForHeaders(received: string | null, trustProxy: boolean): Record<string, string> {
  if (!trustProxy) return {};
  const value = received?.trim();
  return value ? { 'x-forwarded-for': value } : {};
}

export async function clientForwardingHeaders(): Promise<Record<string, string>> {
  const trustProxy = process.env.WEB_TRUST_PROXY === 'true';
  return forwardedForHeaders((await headers()).get('x-forwarded-for'), trustProxy);
}
