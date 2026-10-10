# Releases and versioning

## Policy

Taktick follows [Semantic Versioning](https://semver.org/). The first
baseline is **0.1.0**.

| Change | Bump | Example |
| --- | --- | --- |
| Bug fix, no behaviour a client depends on changes | PATCH | 0.1.0 → 0.1.1 |
| Backwards-compatible feature | MINOR | 0.1.x → 0.2.0 |
| Stable production milestone | MAJOR | 0.x → 1.0.0 |

Before 1.0.0 a breaking change is a MINOR bump, called out in the changelog.

## Source of truth

The `version` in the root `package.json` is the release version, and the only
place it is written. Workspace manifests (`apps/*`, `packages/*`, `e2e`) are
private, are not versioned on their own, and keep the placeholder `0.0.0`.
The admin and web footers show `Taktick vX.Y.Z`: `next.config.ts` reads the
root version while the app is built and inlines it.

`pnpm version:check` (CI runs it on every PR) checks the root version's shape,
the workspace placeholders, a dated `CHANGELOG.md` section for the version, that
no app source writes the version as a literal, and that any `v*` tag on `HEAD`
is annotated and equal to `v<version>`. `pnpm --silent version:check --print`
prints the version for scripts. Nothing is published to a registry.

## Tags

Format `vX.Y.Z`, annotated (`git tag -a`), on the **merge commit on `main`**
that carries that version. Tags are never created inside a PR.

## Release steps

1. In a PR: bump the root `package.json` version, move the `Unreleased`
   entries into `## X.Y.Z - YYYY-MM-DD` in `CHANGELOG.md`, run
   `pnpm version:check`.
2. Merge. Wait for the merge commit's `CI result` on `main` to succeed.
3. Locally: `git switch main && git pull --ff-only`; check `HEAD` is that merge
   commit and `pnpm version:check` prints `OK X.Y.Z`.
4. Tag and push the tag:
   `git tag -a vX.Y.Z <merge-sha> -m "Taktick vX.Y.Z"`,
   `pnpm version:check --tag vX.Y.Z`, `git push origin vX.Y.Z`.
5. GitHub Release `Taktick vX.Y.Z` from that tag, notes = the changelog
   section: `gh release create vX.Y.Z --verify-tag --title "Taktick vX.Y.Z" --notes-file <section>`.
6. Deploying the tagged commit is a separate step (docs/ops/deploy-runtime.md).

## Rollback and tag corrections

- A pushed tag is never moved or force-updated, and never re-pointed to
  another commit.
- A broken release is fixed forward: a new PATCH (`vX.Y.Z+1`) with the fix.
  Rolling a deployment back means deploying the previous tag's commit; the
  version history stays as it is.
- A tag created on the wrong commit and not yet used by any deploy or release
  may be deleted (`git push origin :refs/tags/vX.Y.Z`) and created again on the
  right merge commit — record why in the changelog. Once a release or deploy
  used it, take the next PATCH instead.
