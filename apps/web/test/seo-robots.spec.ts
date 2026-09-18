import { describe, expect, it } from 'vitest';
import { buildRobots } from '../lib/seo-robots';
import { ROBOTS_DISALLOW } from '../lib/seo-routes';
import type { SeoSite } from '../lib/seo-site';

const OPEN: SeoSite = { indexable: true, origin: 'https://taktick.example' };
const CLOSED: SeoSite = { indexable: false, origin: null, reason: 'ENVIRONMENT_UNDECLARED' };

describe('buildRobots', () => {
  it('on an open site: allows the root, disallows the private prefixes, names the sitemap', () => {
    expect(buildRobots(OPEN)).toEqual({
      rules: [{ userAgent: '*', allow: '/', disallow: [...ROBOTS_DISALLOW] }],
      sitemap: 'https://taktick.example/sitemap.xml',
    });
  });

  it('on a closed site: disallows everything and names no sitemap', () => {
    expect(buildRobots(CLOSED)).toEqual({ rules: [{ userAgent: '*', disallow: '/' }] });
  });
});
