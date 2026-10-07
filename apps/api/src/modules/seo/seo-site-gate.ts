/**
 * SEO-004 — whether the web is open to search engines, as the admin overview
 * reports it.
 *
 * The decision itself is the web's (apps/web/lib/seo-site.ts): it is read
 * there, on every render, from the web process's own environment. The API
 * cannot ask the web, and an admin screen that guessed would be worse than
 * none, so this is the same rule over the same variables, held to the same
 * cases (`packages/shared/seo-site-gate-cases.json`) by both test suites. The
 * deployments pass both processes the same `APP_ENVIRONMENT` and `WEB_APP_URL`
 * (docker-compose.prod.yml), which is what makes the answer the web's answer;
 * the response says where it was read (`source`), so the screen can say so.
 */

const ORIGIN_VARIABLES = ['WEB_APP_URL', 'WEB_ORIGIN', 'NEXT_PUBLIC_WEB_URL'] as const;

export type SeoSiteClosedReason =
  | 'ENVIRONMENT_UNDECLARED'
  | 'ENVIRONMENT_NOT_PRODUCTION'
  | 'ENVIRONMENT_INVALID'
  | 'ORIGIN_MISSING'
  | 'ORIGIN_MALFORMED'
  | 'ORIGIN_NOT_AN_ORIGIN'
  | 'ORIGIN_INSECURE'
  | 'ORIGIN_LOOPBACK';

export type SeoSiteGate =
  | { open: true; origin: string; reason: null; source: 'API_ENVIRONMENT' }
  | { open: false; origin: null; reason: SeoSiteClosedReason; source: 'API_ENVIRONMENT' };

const closed = (reason: SeoSiteClosedReason): SeoSiteGate => ({ open: false, origin: null, reason, source: 'API_ENVIRONMENT' });

export function resolveSeoSiteGate(env: NodeJS.ProcessEnv = process.env): SeoSiteGate {
  const environment = env.APP_ENVIRONMENT?.trim() ?? '';
  if (!environment) return closed('ENVIRONMENT_UNDECLARED');
  if (environment === 'local' || environment === 'staging') return closed('ENVIRONMENT_NOT_PRODUCTION');
  if (environment !== 'production') return closed('ENVIRONMENT_INVALID');

  const raw = ORIGIN_VARIABLES.map((name) => env[name]?.trim()).find((value) => value);
  if (!raw) return closed('ORIGIN_MISSING');

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return closed('ORIGIN_MALFORMED');
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) return closed('ORIGIN_NOT_AN_ORIGIN');
  const host = parsed.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') return closed('ORIGIN_LOOPBACK');
  if (parsed.protocol !== 'https:') return closed('ORIGIN_INSECURE');
  return { open: true, origin: parsed.origin, reason: null, source: 'API_ENVIRONMENT' };
}
