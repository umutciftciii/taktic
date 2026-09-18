import { ROBOTS_DISALLOW } from './seo-routes';
import type { SeoSite } from './seo-site';

/**
 * `robots.txt`, from the same gate as everything else.
 *
 * Open: crawl the root, keep out of the panels, forms and API, and here is
 * the sitemap. Closed — staging, local, an undeclared or unconfigured
 * production — `Disallow: /` and no sitemap line: the sitemap is empty there
 * anyway, and a crawler must not be handed its address.
 *
 * Same shape as Next's `MetadataRoute.Robots`, kept here so the rule is unit
 * testable without the route module.
 */
export type RobotsRules = {
  rules: { userAgent: string; allow?: string; disallow: string | string[] }[];
  sitemap?: string;
};

export function buildRobots(site: SeoSite): RobotsRules {
  if (!site.indexable) {
    return { rules: [{ userAgent: '*', disallow: '/' }] };
  }

  return {
    rules: [{ userAgent: '*', allow: '/', disallow: [...ROBOTS_DISALLOW] }],
    sitemap: `${site.origin}/sitemap.xml`,
  };
}
