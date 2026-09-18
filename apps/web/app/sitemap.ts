import type { MetadataRoute } from 'next';
import { apiUrl } from './api-base';
import { buildSitemap } from '../lib/seo-sitemap';
import { resolveSeoSite } from '../lib/seo-site';

/**
 * `/sitemap.xml`. Per request, like robots.txt, and for the same reason.
 *
 * The API is asked without the visitor's cookies on purpose: `apiFetch`
 * forwards the session, and a sitemap must list what a stranger sees, never
 * what the operator who happened to request it may see. Every source it reads
 * is a public endpoint that already applies its own visibility rules.
 */
export const dynamic = 'force-dynamic';

async function fetchPublicJson(path: string): Promise<unknown> {
  const response = await fetch(`${apiUrl}${path}`, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`${path} answered ${response.status}`);
  }
  return response.json();
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return buildSitemap(resolveSeoSite(), fetchPublicJson);
}
