# Changelog

All notable changes to Taktick are recorded here. Versions follow
[Semantic Versioning](https://semver.org/); the policy and the release steps
are in [docs/release.md](docs/release.md).

## Unreleased

### Added

- REL-002 Faz 1: service request match rounds. Every request now has a
  Round 1 (`ServiceRequestMatchRound`, migration
  `20261011120000_add_service_request_match_rounds`), backfilled for existing
  rows and kept in step by every lifecycle writer. No behaviour change:
  nothing reads rounds yet and no API response carries them.
- REL-002 Faz 2 (internal foundation): the match round is now the matching
  core's authority (migration `20261011180000_enforce_round_matching_core`).
  Offers, contact reveals and message threads belong to a round; uniques are
  per round (one offer per provider, one accepted offer, one reveal, one
  thread); offer creation re-checks the request and its current round inside
  its own transaction; accept, shortlist, reject and withdraw answer
  `409 OFFER_ROUND_CLOSED` for an offer of a closed or earlier round; expiry
  and reminders run on the round's clock; `request-available` /
  `request-expired-*` keys gain `:r<N>` from Round 2 on (Round 1 keys
  unchanged). With one round per request the product behaves as before.
  Internal read surface: `GET /service-requests/:id/rounds` (REQUESTS_READ).

### Changed

- Offers now require a schedule: `estimatedStartDate` and
  `estimatedCompletionDate` are mandatory `YYYY-MM-DD` Istanbul calendar days,
  start no earlier than today, end no earlier than start, at most 365 days
  ahead (`packages/shared/limits.json` `offerScheduleMaxDays`). Refusals are
  `400` with `OFFER_SCHEDULE_REQUIRED`, `OFFER_SCHEDULE_INVALID`,
  `OFFER_START_IN_PAST`, `OFFER_END_BEFORE_START` or `OFFER_SCHEDULE_TOO_FAR`
  (and a `field`). Breaking for API clients that omitted the dates; the web
  offer forms (marketplace request and vitrin lead) require them. Existing
  offers without dates are untouched and still read everywhere.
- Shortlisting or rejecting an offer of an expired request now answers
  `409 OFFER_ROUND_CLOSED` (its round is closed); the inbox's unread badge
  counts only threads of a live match.

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
