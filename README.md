# TakTic

TakTic is a local services marketplace foundation. Phase 0 is intentionally limited to technical bootstrap: monorepo setup, thin app shells, PostgreSQL, Prisma, and seed data for service categories and dynamic request questions.

## Ports

- Public web: `http://localhost:3000`
- API: `http://localhost:3001`
- Admin: `http://localhost:3002`
- PostgreSQL: `localhost:5433` by default

## Local Setup

1. Install the Node version from `.nvmrc`.
2. Install dependencies:

```bash
pnpm install
```

3. Copy environment variables:

```bash
cp .env.example .env
```

4. Start PostgreSQL:

```bash
docker compose up -d postgres
```

5. Generate Prisma Client:

```bash
pnpm db:generate
```

6. Create the initial local migration:

```bash
pnpm db:migrate --name init
```

7. Seed local categories and questions:

```bash
pnpm db:seed
```

8. Start all apps:

```bash
pnpm dev
```

## Useful Commands

```bash
pnpm dev
pnpm build
pnpm lint
pnpm typecheck
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm db:studio
```

There are intentionally no destructive database scripts. Do not use `prisma migrate reset`, forced resets, or database drops for normal development.

## Local Auth

Seeding creates a local development admin if it does not already exist:

- Email: `admin@taktic.local`
- Password: `ChangeMe123!`
- Role: `SUPER_ADMIN`

Authentication uses an HTTP-only cookie session named `taktic_session` by default. The seed does not overwrite an existing admin password.

## End-to-End Tests

`pnpm test` runs the API integration suite (Vitest + supertest). The browser suite is separate and lives in `e2e/`.

```bash
pnpm e2e:install
```

```bash
pnpm e2e
```

`pnpm e2e` builds the apps, prepares the database, starts the runtimes and runs the scenarios. Other commands: `pnpm e2e:ui` (Playwright UI mode) and `pnpm e2e:report` (last HTML report).

**Database isolation.** The suite runs against its own database, derived from `DATABASE_URL` by appending `_e2e` (`taktic` → `taktic_e2e`), or from `E2E_DATABASE_URL` if you set one. It refuses to start against any database whose name does not end in `_e2e` — including the development database and the integration suite's `taktic_test` — and that check runs before a single server process starts. The database is created and migrated on first run, emptied before each run, and emptied again afterwards.

**Runtimes.** `REQUIRE_PHONE_VERIFICATION` and `CONTACT_SHARING_ENABLED` are read per call, so one API process can only represent one side of either. The suite therefore starts three full stacks — API + web + admin with both flags off on ports 3200-3202, the same code with the phone gate on at 3210-3212, and the same code with contact sharing on at 3220-3222 — and drives the comparisons across them. The ports are clear of `docker compose` (3000-3002), so you can leave the dev stack running. Override them with `E2E_WEB_PORT`, `E2E_API_PORT`, `E2E_ADMIN_PORT` and their `E2E_GATE_*` / `E2E_CONTACT_*` counterparts.

**One-time codes.** The verification scenario needs the code the application sent, which is never returned over HTTP and only reaches the database as a bcrypt hash. `NOTIFICATION_OUTBOX_DIR` (set automatically by the Playwright config) swaps the SMS transport for one that records what it sent to a file the test reads. It cannot be set in production — the API refuses to boot with it.

Tests run serially in one worker: several assertions are about global state ("no refund transaction exists"), and every actor shares one database.

In CI the suite is its own job, on Chromium only, with its own PostgreSQL service container. Traces, screenshots and videos are captured on failure and uploaded as artifacts.

## Contact Sharing

Once a customer accepts an offer, the two matched parties can be shown each other's contact details. The feature is **off by default** and is gated on three settings:

```bash
CONTACT_SHARING_ENABLED=false
CONTACT_DISCLOSURE_URL=https://example.com/iletisim-paylasimi
CONTACT_DISCLOSURE_VERSION=v1
```

With the flag on, both other values are mandatory: the URL must be `https`, the version must be a short identifier (`a-z`, `0-9`, `.`, `-`, `_`, normalised to lower case), and the API refuses to boot if either is missing or malformed. There is no silent fallback.

**This is a technical switch, not an approval.** The request form renders a checkbox stating only that the linked text was read, and stores the configured version and a timestamp on the request. That record is not a legal basis on its own, and this repository neither contains nor generates the disclosure text — the flag must stay off until approved content exists behind the URL.

How it behaves:

- **Off** — request creation, matching and every offer projection are exactly as they were. No `ContactRevealEvent` is written, and the contact endpoints answer `409 CONTACT_SHARING_DISABLED`.
- **On** — accepting an offer requires the request to carry an acceptance of the *current* version, or the accept is refused with `409 CONTACT_DISCLOSURE_REQUIRED`. When it succeeds, one immutable `ContactRevealEvent` is written inside the same transaction as the match, so a matched request either has its audit row or the match did not happen.

Contact details are never added to an offer list or detail. They are served only by three dedicated routes, each of which checks the match, the audit row and the caller: the customer sees the provider they chose, that provider sees the customer, and `SUPER_ADMIN` sees both plus the audit row. A losing provider, an unrelated party and an anonymous caller get nothing. Requests created before the disclosure columns existed carry no acceptance and are never opened.

Nothing in the product can repeat, edit or undo a reveal; the accept transaction is the only writer.

## Local Ops

Refund scan automation is disabled by default. The scheduled worker is optional and uses the same execution logic as the admin refund scan endpoint, so it preserves the same eligibility checks, transactions, and idempotency behavior.

To enable it locally:

```bash
REFUND_SCHEDULER_ENABLED=true
```

Relevant environment variables:

- `REFUND_SCHEDULER_ENABLED=false`
- `REFUND_SCHEDULER_CRON=0 * * * *`
- `REFUND_SCAN_OLDER_THAN_HOURS=48`
- `REFUND_SCAN_LIMIT=100`

The scheduler only runs full refunds for the existing not-viewed offer policy. It does not perform partial refunds.

### Request expiry and reminder

An approved request stays open for **14 days**. Two independent jobs act on that window, and both are disabled by default:

- **Expiry** — a request that is still `APPROVED` 14 days after its approval becomes `EXPIRED` and gets an `expiredAt` stamp. This is the only writer of `EXPIRED`; the admin moderation controls refuse that status by design.
- **Reminder** — a request that is still `APPROVED` 7 days after its approval and has **no offer at all** earns exactly one customer e-mail. A request with even one offer (including a withdrawn one) is never reminded.

Relevant environment variables:

- `REQUEST_EXPIRY_SCHEDULER_ENABLED=false`
- `REQUEST_EXPIRY_SCHEDULER_CRON=15 * * * *`
- `REQUEST_REMINDER_SCHEDULER_ENABLED=false`
- `REQUEST_REMINDER_SCHEDULER_CRON=45 * * * *`
- `REQUEST_LIFECYCLE_SCAN_LIMIT=200` (1–1000)

Both flags accept only `true` or `false`, and both cron expressions are validated: an unreadable value fails at boot instead of leaving a job silently off, or running on a schedule nobody chose.

Both jobs measure from `ServiceRequest.approvedAt`, which is written in the same statement that sets `APPROVED`. Requests approved before that column existed carry `NULL` and are deliberately never picked up — neither `submittedAt` nor `moderatedAt` is the approval moment, so backfilling one would expire live requests on a fabricated clock.

Both jobs are idempotent by construction: every write is a conditional update that still requires the row to be in the state the job found it in. A second run, a second instance, or a request that was matched, cancelled or completed in the meantime changes nothing.

Reminder delivery is best-effort and the claim is not: `reminderSentAt` is committed before the send, so a transport failure leaves a `FAILED` row in `NotificationLog` and never re-mails the customer. With no real e-mail provider wired, production sends are expected to fail visibly — the scheduling logic is still correct.

## Phase 0 Scope

Included:

- pnpm and Turbo monorepo
- Thin NestJS API shell with `/health`
- Thin Next.js web and admin shells
- Docker Compose PostgreSQL
- Root Prisma schema
- Idempotent local/dev seed data
- Shared TypeScript configs
- Minimal shared package

Excluded:

- Auth
- Provider profiles
- Customer service requests
- Offers and offer credits
- Lead quality scoring
- Phone verification
- Admin CRUD
- Payments
- Moderation workflows
