import type { MetadataRoute } from 'next';
import { buildRobots } from '../lib/seo-robots';
import { resolveSeoSite } from '../lib/seo-site';

/**
 * `/robots.txt`. Rendered per request rather than at build, because whether
 * this stack may be crawled is a fact about the process's environment (see
 * lib/seo-site.ts), and the same build runs on staging and production.
 */
export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  return buildRobots(resolveSeoSite());
}
