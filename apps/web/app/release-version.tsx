/**
 * The release this bundle was built from, as `Taktick vX.Y.Z`
 * (RELEASE-BASELINE-001).
 *
 * The value is the root package.json version, inlined by next.config.ts at
 * build time; it is never written here. With no value — a bundle compiled
 * outside `next build`/`next dev` — nothing is drawn rather than a guess.
 */
export const RELEASE_VERSION = process.env.TAKTIC_RELEASE_VERSION ?? '';

export function ReleaseVersion({ version = RELEASE_VERSION }: { version?: string }) {
  if (!version) return null;
  return (
    <small className="lp-footer-version" data-testid="app-version">{`Taktick v${version}`}</small>
  );
}
