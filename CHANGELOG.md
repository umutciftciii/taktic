# Changelog

All notable changes to Taktick are recorded here. Versions follow
[Semantic Versioning](https://semver.org/); the policy and the release steps
are in [docs/release.md](docs/release.md).

## Unreleased

### Added

- MATCH-001: category delivery model (`ON_SITE` / `REMOTE` / `HYBRID`) and
  location-independent remote matching. A request snapshots its delivery mode
  at creation (HYBRID: the customer chooses); REMOTE requests reach every
  eligible provider of the category regardless of service areas — discovery,
  detail, offer and the publish fan-out share one location rule, and every
  other guard (approval, category, round, exclusion, credit, schedule) is
  unchanged. Existing categories and requests stay ON_SITE; a later category
  change never moves an existing request (database-enforced). Admin category
  form, request forms, vitrin leads, provider area settings and request screens
  show the mode. Migration 99 → 100; rollback only before the feature is used.
  See `docs/match-001-delivery-model.md`.

- CAMPAIGN-ENTITLEMENT-001: bounded vitrin offer allowances. Each vitrin
  placement now carries 3 free direct-lead offers (`OfferAllowanceGrant`,
  one per placement, granted in the placement's birth transaction); each free
  answer writes an append-only `OfferAllowanceUsage` row (no ledger row, no
  balance movement) and is never given back. After the three, answers cost
  the category's credits like any paid offer — still marking the lead
  ANSWERED. Resolver order: category-unlimited → vitrin allowance → monthly
  quota → credits. The direct-lead offer form previews the effective cost
  (`GET /providers/:id/requests/:requestId/offer-cost`) and sends it as
  `expectedCreditCost`; a changed cost is a 409 `CREDIT_COST_CHANGED`, never a
  silent charge. Admin placement and offer details show quota, usage and
  subsidy. Migration 100 → 101 backfills grants for live placements as
  `legacy free offers + 3`; historical zero-credit offers are untouched.
  Rollback only while no usage exists. See
  `docs/campaign-entitlement-001-offer-allowance.md`.

### Changed

- CAMPAIGN-ENTITLEMENT-001: answering a direct vitrin lead is no longer
  unconditionally free (`SHOWCASE_PLACEMENT ⇒ creditCost 0` removed); the
  direct-lead identity is read from the request's gate rather than from what
  paid, and a paid direct answer carries the ordinary unviewed-offer refund
  policy. `expectedCreditCost` accepts 0.
- MOBILE-UX-HARDENING-001: public and auth mobile layouts. Auth screens
  (login, register, verification, recovery, reset) put the form or result
  first and the "TakTick hesabı" poster after it as a compact band — form-first
  DOM order, desktop two columns unchanged via grid placement. The public
  header stays one row below 900px with its links behind a "Menü" disclosure
  (Escape, outside click, focus return); the footer folds its link groups below
  640px while the legal links stay visible; the request form's step tabs share
  one row and its back/next buttons sit side by side. No business logic, API or
  migration change. See `docs/mobile-ux-hardening-001.md`.

## 0.2.0 - 2026-10-12

Match rounds and service assurance (REL-002 Faz 1–5). A request is now matched
in rounds; a customer whose provider did not deliver can close that match and
reopen the request without that provider; staff adjudicate the incident and
recover requests whose automatic rounds ran out. The customer-facing service
issue report ships **off** and is enabled separately after deploy.

### Highlights

- Match rounds: every request has numbered rounds; offers, contact reveals,
  threads, notifications, schedulers and reviews belong to a round.
- Customer service-issue reporting (behind
  `serviceIssueReportingEnabled`): the failed match round closes as `FAILED`,
  a provider incident is recorded and the provider is permanently excluded
  from that request.
- Automatic reopen into Round 2 and Round 3; after a third failure the request
  goes to `MATCH_REVIEW` instead of a Round 4.
- Staff recovery: a SUPER_ADMIN opens Round 4, 5, … from `MATCH_REVIEW` with a
  mandatory internal note; no hard cap.
- Incident handling: the failed provider answers once; staff adjudicate
  (`CONFIRMED` / `DISMISSED`) with a rationale; only a SUPER_ADMIN corrects a
  decision, as an append-only correction.
- Provider reliability review, computed from effective `CONFIRMED` incidents
  of the last 90 days (2 = warning, 3+ = admin review); no automatic sanction.
- Offers require an estimated start and completion day.
- Conversations of an ended match stay readable, read-only.
- Admin: per-request round timeline („Eşleşme turları"), `MATCH_REVIEW` queue
  and dashboard counter, incident and reliability queues.
- Credit: the failed provider's offer credit is never refunded.

### Provider / customer impact

- Providers must give `estimatedStartDate` and `estimatedCompletionDate` on
  every new offer (marketplace and vitrin lead forms enforce it).
- A provider excluded after a failed match no longer sees or can offer on that
  request in any round; it reads its own incidents (masked) and may answer
  once. Decisions are told to the provider as an outcome only, never the
  rationale; nothing is shown on public profiles or to customers.
- Customers (once the flag is on) see a „Hizmetle ilgili sorun bildir" action
  after the promised days, earlier matches on the request page, and notices
  for a recorded issue, reopening, match review and a manual reopening (never
  the staff note).
- Ended conversations (completed, cancelled, failed) are read-only for both
  participants instead of `403`.

### Admin / ops impact

- New permissions: `SERVICE_ISSUE_SETTING_WRITE`, `SERVICE_INCIDENTS_READ`,
  `SERVICE_INCIDENTS_ADJUDICATE`, `PROVIDER_RELIABILITY_READ`,
  `PROVIDER_RELIABILITY_MANAGE`; reserved for SUPER_ADMIN (no role may carry
  them): `SERVICE_INCIDENTS_CORRECT`, `MATCH_REVIEW_OPEN_ROUND`.
- New request status `MATCH_REVIEW` (list filter, queue, dashboard
  `matchReviewRequests`).
- Read-only ops checks: `scripts/ops/rel-002-preflight.sql`,
  `scripts/ops/rel-002-round-consistency.sql` (checks 1–14, 0 rows =
  consistent); `rel002_event` log lines (ids and enums only).
- Procedures: [docs/ops/rel-002-runbook.md](docs/ops/rel-002-runbook.md).

### Breaking API changes

1. `POST` offer creation requires `estimatedStartDate` and
   `estimatedCompletionDate` (`YYYY-MM-DD`, Istanbul calendar days).
2. A client that omits or sends invalid dates gets `400`
   (`OFFER_SCHEDULE_REQUIRED`, `OFFER_SCHEDULE_INVALID`, `OFFER_START_IN_PAST`,
   `OFFER_END_BEFORE_START`, `OFFER_SCHEDULE_TOO_FAR`).
3. Accept, shortlist, reject and withdraw on an offer of a closed or earlier
   round answer `409 OFFER_ROUND_CLOSED`.
4. Threads of a completed, cancelled or failed match are read-only: reads
   return `mode: READ_ONLY` and a `closedReason`; send and mark-read answer
   `403 THREAD_READ_ONLY`.
5. The service issue feature is **off** after deploy
   (`OperationsSettings.serviceIssueReportingEnabled = false`;
   `POST /service-requests/:id/service-issue` answers `404` while off) and is
   enabled separately.

### Feature flag

`serviceIssueReportingEnabled` defaults to `false` and stays off through the
deploy. Enable it only once the deploy is stable, with separate approval and in
a controlled environment first (runbook §4). Turning it off again hides the
report and keeps every round, incident, exclusion and the `MATCH_REVIEW`
recovery working.

### Migrations and deploy

- Five new migrations (M1–M5); **99** in total.
- Schema first (`migrate deploy`), then API, web and admin **in one
  coordinated release** — the new code does not run on the old schema, and the
  web offer form and the API's date rule depend on each other.
- After deploy: preflight and consistency checks 0, flag still `false`, smoke
  test (runbook §3).

### Rollback boundary

- `scripts/ops/rel-002-m2…m5-rollback.sql` work only while their phase has no
  data, and refuse otherwise.
- Once a real Round 2, an incident response or adjudication, or a staff round
  opening exists, there is **no backward schema rollback**. Recovery is flag
  OFF plus a forward fix; deploying the previous tag's code is not supported on
  a REL-002 schema with such data.

### Known limitations

- Matches accepted before offer dates were required have no authoritative
  schedule: the automatic report is unavailable for them and the customer is
  sent to support (`SERVICE_ISSUE_REQUIRES_SUPPORT`); no dates are backfilled.
- No provider-response reminder; no formal warning e-mail or action at the
  reliability thresholds.
- Customers do not see the provider's response or the decision.
- No SLA or auto-close for `MATCH_REVIEW`; a staff round opening cannot be
  undone (history is append-only).
- Not yet deployed to staging or production.

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
- REL-002 Faz 3: customer service issue (behind
  `OperationsSettings.serviceIssueReportingEnabled`, **off by default**;
  migration `20261012090000_add_service_issue_reopen_core`). A customer whose
  matched provider did not deliver can close the match with
  `POST /service-requests/:id/service-issue` (reason, optional note,
  idempotency key; eligibility from the accepted offer's promised days in
  Europe/Istanbul, server clock only). The match round becomes `FAILED`
  (terminal), a `ProviderServiceIncident` is recorded (`REPORTED`, no
  penalty), the provider is permanently excluded from the request on every
  surface and by an Offer INSERT trigger, and the request reopens into Round 2
  or 3 (a direct vitrin lead goes through the ordinary marketplace publish
  gate). After a third failure the request goes to `MATCH_REVIEW` (no
  automatic Round 4). The failed match is never refunded (offer refunds of it
  answer `409 FAILED_MATCH_NOT_REFUNDABLE`). New notices:
  `service-issue-recorded`, `request-reopened`, `request-match-review`,
  `provider-incident-opened`, `provider-incident-new`. Customer detail
  (`GET /service-requests/my/:id`) gains `currentRound`, `rounds[]` and
  `serviceIssue`; the request page offers the report and lists earlier
  matches. Admin: the switch (permission `SERVICE_ISSUE_SETTING_WRITE`), the
  `MATCH_REVIEW` status and filter, incident and exclusion data on
  `GET /service-requests/:id/rounds`. Ops: `scripts/ops/rel-002-m3-rollback.sql`
  (only before the flow is used; afterwards forward-fix only).
- REL-002 Faz 4: incident adjudication and provider reliability (migration
  `20261012120000_add_incident_adjudication_reliability`; the Faz 3 switch
  stays **off**). The failed provider reads its incidents (masked note, no
  customer detail) and answers once:
  `POST /providers/:providerId/incidents/:incidentId/response` (10–2000
  characters; the 72-hour window is a signal, never a lock; closed once
  decided). Staff decide with a mandatory rationale —
  `POST /admin/service-incidents/:id/adjudications` (`CONFIRMED` /
  `DISMISSED`) — recorded in the append-only `ProviderIncidentAdjudication`
  chain; only a SUPER_ADMIN corrects a decision, by appending a `CORRECTION`
  against the head they saw (`POST /admin/service-incidents/:id/corrections`,
  `409 INCIDENT_ADJUDICATION_CHANGED` on a stale head). The effective decision
  is the chain head (`ProviderServiceIncident.effectiveAdjudicationId`).
  Provider reliability is computed, never stored: effective `CONFIRMED`
  incidents reported in the last 90 days — 0–1 `NORMAL`, 2 `WARNING`, 3+
  `ADMIN_REVIEW_REQUIRED`, which opens one `ProviderReliabilityReview`
  (acknowledge / resolve with a note). No decision refunds credit, removes the
  exclusion, touches the failed round or the reopened request, or suspends
  anybody; nothing is shown to customers or on public profiles. A customer's
  dismissed-report ratio is an admin-only signal (`HIGH_DISMISSAL_RATIO`, no
  restriction). New permissions `SERVICE_INCIDENTS_READ`,
  `SERVICE_INCIDENTS_ADJUDICATE`, `SERVICE_INCIDENTS_CORRECT` (reserved for
  SUPER_ADMIN: no role may carry it, `GET /admin/permissions` lists it under
  `reservedForSuperAdmin`), `PROVIDER_RELIABILITY_READ`,
  `PROVIDER_RELIABILITY_MANAGE`. New notices: `service-incident-confirmed`,
  `service-incident-dismissed` (provider; outcome only, never the rationale),
  `service-incident-provider-responded`, `provider-reliability-review-opened`
  (support inbox). Screens: provider panel „Hizmet aksaklıkları"; admin
  „Hizmet aksaklıkları" queue/detail, „Güvenilirlik" queue and the provider
  page's reliability card. Ops: `scripts/ops/rel-002-m4-rollback.sql` (only
  before any Faz 4 data exists), preflight M4 section, consistency checks
  11–12.
- REL-002 Faz 5: staff recovery from `MATCH_REVIEW` and release hardening —
  REL-002 is complete (migration `20261013090000_add_match_review_round_opening`;
  the Faz 3 switch stays **off**). A SUPER_ADMIN opens Round 4, 5, … on a
  request whose three automatic rounds failed:
  `POST /admin/service-requests/:id/open-next-round`
  (`expectedCurrentRoundId`, mandatory internal note 10–2000, idempotency key;
  same key and payload replays, `409 IDEMPOTENCY_KEY_REUSED` otherwise, a
  concurrent second opening is `409 MATCH_REVIEW_ALREADY_REOPENED`). The new
  round is a marketplace round on the same request (`openedBy = ADMIN`, no
  hard cap) and enters the ordinary publish gate (auto-publish on → live at
  once with the round-aware fan-out; off → moderation). Earlier rounds,
  exclusions, incidents and credit are untouched; nothing is refunded. Each
  opening is recorded in the append-only `ServiceRequestRoundOpening` (who,
  note, from which failed round, into which round). New permission
  `MATCH_REVIEW_OPEN_ROUND`, reserved for SUPER_ADMIN. New customer notice
  `request-manually-reopened` (never the staff note). Admin: the request's
  „Eşleşme turları" tab — a full round timeline (source, opener, clock,
  outcome, winner, incident and its effective decision, exclusion, thread
  mode, contact reveal, staff opening) — and „Yeni tur aç"; the MATCH_REVIEW
  queue (`GET /admin/service-requests/match-review`, oldest first) on the
  requests list and the dashboard („İnceleme bekleyen eşleşmeler",
  `matchReviewRequests`). Observability: one-line `rel002_event` log events
  (ids and enums only). Ops: `docs/ops/rel-002-runbook.md` (deploy order,
  flag procedure, emergency, MATCH_REVIEW recovery, legacy dateless matches),
  `scripts/ops/rel-002-m5-rollback.sql`, preflight M5 section, consistency
  checks 13–14.

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
- A conversation whose match ended (completed, cancelled or failed) is now
  readable by its two participants, read-only, instead of answering `403`:
  `GET` thread/messages return `mode: READ_ONLY` and a `closedReason`; sending
  and marking read answer `403 THREAD_READ_ONLY`. The screens label it
  "Kapandı · salt okunur" and show no composer.

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
