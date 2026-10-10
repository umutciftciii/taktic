# Changelog

All notable changes to Taktick are recorded here. Versions follow
[Semantic Versioning](https://semver.org/); the policy and the release steps
are in [docs/release.md](docs/release.md).

## Unreleased

## 0.1.0 - 2026-10-10

First versioned baseline. The product runs end to end; staging/production
parity and some operations and security work are still open, so this is not
the 1.0.0 stable-production milestone.

### Added

- Marketplace flows for customers and providers: categorised service
  requests with quality moderation, provider enrollment and claim, offers,
  messaging, notifications, provider reviews and the public showcase.
- Admin panel redesign (ADMIN-DESIGN-001): shared components, every screen
  rebuilt, confirmation dialogs for destructive and lifecycle actions, an
  action audit trail.
- Contact disclosure on accepted offers, with phone and e-mail proof.
- SEO core and admin tooling: index eligibility, sitemap, redirects and
  404 suggestions managed from the admin.
- Turkish-aware admin search, normalised for phone numbers and Turkish
  case folding.
- Release baseline: `0.1.0` in the root `package.json`, `pnpm version:check`,
  this changelog, and the build version in the admin and web footers.

### Changed

- Database-side pagination for the admin customer and offer lists.
- Search performance: trigram indexes and id pre-resolution for offer search.
- CI: required `CI result` check, post-merge result reuse for identical
  trees, Postgres on tmpfs.

### Fixed

- Permission-based admin RBAC with cross-domain response projection, so a
  screen never carries data its viewer may not read.
- Payment, credit and refund correctness: promo credit accounting, credit
  holds, refund revoke and offer-refund acceptance.
- E2E hardening of race-prone and browser-specific flows (WebKit included).
- The offers list names its pinned provider and request even when the page
  has no row (ADMIN-PINNED-LABEL-001).
