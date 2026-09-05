import type { NextConfig } from 'next';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The response headers every page and asset this application serves carries.
 *
 * Set here rather than per route: a header that has to be remembered at each
 * page is a header the next page will be missing. The API sets the same five in
 * `apps/api/src/common/http-security.ts`, which is where the reasoning behind
 * each one is written out in full — the values are deliberately identical,
 * because a person moving between the three origins is inside one product and a
 * rule that holds on two of them is a rule with a hole in it.
 *
 *   Strict-Transport-Security  one year; ignored by browsers over plain http,
 *                              so it is safe on a local stack. No
 *                              includeSubDomains and no preload: both are
 *                              commitments about hostnames this repository does
 *                              not own, and neither is quick to take back.
 *   X-Content-Type-Options     no second-guessing a declared content type.
 *   Content-Security-Policy    clickjacking only. frame-ancestors is the single
 *                              directive on purpose — a broader policy here
 *                              would break a screen months from now for no
 *                              stated threat.
 *   X-Frame-Options            the same rule for browsers that never
 *                              implemented frame-ancestors.
 *   Referrer-Policy            this product puts single-use tokens in query
 *                              strings (activation, password reset, provider
 *                              claim); the default policy hands those to
 *                              whatever third party a page happens to load.
 */
const securityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
];

const nextConfig: NextConfig = {
  outputFileTracingRoot: workspaceRoot,
  // @taktic/shared ships TypeScript source rather than a build output, so Next
  // has to compile it like first-party code. Without this the shared urgency
  // table and the safe-redirect guard would only resolve by accident of
  // hoisting.
  transpilePackages: ['@taktic/shared'],
  // Next announces itself in `X-Powered-By` on every response. It tells an
  // attacker which stack to look up known issues for and tells a legitimate
  // visitor nothing at all.
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
