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

### Session policy

Two independent clocks end a session, and neither extends the other:

- **Idle** — the session is refused once its inactivity window has passed since its last request (`Session.lastSeenAt`). Activity slides this window and nothing else, and the mark is written at most once every five minutes so an active session is not a write hot spot.
- **Absolute** — the session dies a fixed time after it was created (`Session.expiresAt`), whatever happened in between. It is set at creation and never moved forward: there is no sliding session and no session that renews itself forever.

**"Beni hatırla"**, on all three sign-in surfaces, chooses between two policies of that shape. It is a policy, not a longer cookie:

| | Idle | Absolute | Cookie |
|---|---|---|---|
| Ordinary | 30 minutes | 8 hours | session cookie — dies with the browser |
| Remembered | 30 days | 30 days | persistent |

The remembered idle window is separate on purpose. Sharing the ordinary one made the box nearly meaningless: a remembered session was indistinguishable from an ordinary one after half an hour of quiet, so the persistent cookie bought only the first thirty minutes after a browser restart. What somebody ticking it is asking for is "do not make me sign in again on this device", and that is a longer idle window.

Both policies are enforced on the server from `Session.rememberMe` — `sessionIdleTimeoutSecondsFor()` is the single place that maps the column to a window, so a longer one is never something a browser can claim for itself. Nothing about "remember me" is written to `localStorage`: no password, no token, no identity. The cookie is the whole mechanism and stays `HttpOnly`. Signing out, or any server-side revoke, ends either kind immediately.

Both clocks are checked on the server against the database, so a browser whose clock has been moved cannot change the answer. The panels poll `GET /auth/session` — a read that deliberately does *not* record activity, so an open tab cannot keep an unattended browser signed in — and offer to extend the session before the cut-off via `POST /auth/session/touch`. The warning fires two minutes out for an ordinary session and a day out for a remembered one: a month-long session reaches its last two minutes at an hour nobody is watching, so a two-minute warning there would fire into an empty room. It is a courtesy either way — the server ends the session whether or not anybody saw it.

Every duration is configurable (`SESSION_IDLE_TIMEOUT_SECONDS`, `SESSION_ABSOLUTE_TTL_SECONDS`, `SESSION_REMEMBER_ME_IDLE_TIMEOUT_SECONDS`, `SESSION_REMEMBER_ME_TTL_SECONDS`, `SESSION_TOUCH_INTERVAL_SECONDS`, `SESSION_IDLE_WARNING_SECONDS`, `SESSION_REMEMBER_ME_IDLE_WARNING_SECONDS`) and a value that is not a positive whole number of seconds stops the API at boot. `SESSION_TTL_DAYS` is gone: it expressed one clock where there are two and had no inactivity rule at all.

## Post-match messaging

Once a customer accepts an offer, they and that one provider can write to each other inside the application. There is no switch that turns it on — it follows contact sharing: a conversation exists only where a `ContactRevealEvent` does, so with `CONTACT_SHARING_ENABLED=false` no thread can be opened at all.

Authorization is the relation chain, never the thread id. Every call re-derives it: the request is `MATCHED`, `matchedOfferId` names one `ACCEPTED` offer, a reveal for exactly that pair is on file, the request belongs to a signed-in customer, the winning profile belongs to a platform account, and the caller is one of those two accounts. A losing, withdrawn, rejected or still-pending offer therefore has no conversation to find, and knowing an id buys a stranger nothing.

The first version is plain text only: no attachments, no editing, no deleting, no search, no group threads. Messages are immutable, capped at 2,000 characters, rate-limited per account, and rendered as text on every surface. A thread carries the counterpart's display name and the job it belongs to — never a telephone number, an e-mail address, an address note, a credit fact, or anything about a competing offer. Admins do not see message content; moderation is separate work.


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

**Runtimes.** `REQUIRE_PHONE_VERIFICATION`, `CONTACT_SHARING_ENABLED`, `PROVIDER_CLAIM_ENABLED` and `PAYMENT_PROVIDER` are each read per call, so one API process can only represent one side of any of them. The suite therefore starts five full stacks — API + web + admin with everything at its default on ports 3200-3202, the same code with the phone gate on at 3210-3212, with contact sharing on at 3220-3222, with provider claim on at 3230-3232, and with the sandbox payment provider at 3240-3242 — and drives the comparisons across them. A loopback stand-in for the Lemon Squeezy sandbox API runs alongside them on 3299, so the payments runtime never contacts a payment provider. The ports are clear of `docker compose` (3000-3002), so you can leave the dev stack running. Override them with `E2E_WEB_PORT`, `E2E_API_PORT`, `E2E_ADMIN_PORT` and their `E2E_GATE_*` / `E2E_CONTACT_*` / `E2E_CLAIM_*` / `E2E_PAYMENTS_*` counterparts.

**One-time codes.** The verification scenario needs the code the application sent, which is never returned over HTTP and only reaches the database as a bcrypt hash. `NOTIFICATION_OUTBOX_DIR` (set automatically by the Playwright config, together with `EMAIL_TRANSPORT=file-outbox`) swaps the SMS and e-mail transports for ones that record what they sent to a file the test reads. It cannot be set in production — the API refuses to boot with it — and the suite never reaches a real e-mail provider.

Tests run serially in one worker: several assertions are about global state ("no refund transaction exists"), and every actor shares one database.

In CI the suite is its own job, on Chromium only, with its own PostgreSQL service container. Traces, screenshots and videos are captured on failure and uploaded as artifacts.

## Transactional E-mail

Outbound e-mail goes through one port (`NotificationPort`) and one audit path (`NotificationDispatcher`). Which adapter is bound is decided by a single allow-listed setting:

```bash
EMAIL_TRANSPORT=console        # console | file-outbox | resend
RESEND_API_KEY=                # required only when EMAIL_TRANSPORT=resend
EMAIL_FROM="Taktick <noreply@notify.taktick.com.tr>"
RESEND_TIMEOUT_MS=10000        # optional, 1000-60000
```

| Transport | Delivers? | Where it runs | Notes |
| --- | --- | --- | --- |
| `console` | no | development default | Writes the message and its link to the application log; refuses to print an action URL in production. |
| `file-outbox` | no | browser suite only | Records what it would have sent to `NOTIFICATION_OUTBOX_DIR`; cannot exist in production. |
| `resend` | **yes** | staging / production | Real transactional delivery over Resend's `POST /emails`. |

**Boot rules.** An unrecognised `EMAIL_TRANSPORT` fails at boot, and so does a value that contradicts `NOTIFICATION_OUTBOX_DIR`. In production the API refuses to start on `console` or `file-outbox` — either would look healthy while no customer ever receives an activation link. With `EMAIL_TRANSPORT=resend`, `RESEND_API_KEY` is mandatory and `EMAIL_FROM` must be `Taktick <noreply@notify.taktick.com.tr>`: `notify.taktick.com.tr` (region `eu-west-1`) is the verified domain, and an address outside it is not DKIM-signed for this deployment. Outside production `EMAIL_FROM` defaults to that same value, so a local smoke test only needs the key. No boot error ever echoes the key or the sender back.

**The key is a deployment secret.** It exists in the process environment and in one `Authorization` header. It is never committed, never written to `.env.example`, never logged, never stored on a `NotificationLog` row and never included in an error.

**Failures carry a class, not a body.** A failed response's body is deliberately never read: providers echo the destination address and the payload back in validation errors, and an adapter error ends up in the audit table. Only the HTTP status is used, mapped onto the existing closed set — `422` → `INVALID_RECIPIENT`, `401`/`403`/`429`/`5xx` → `TRANSPORT_UNAVAILABLE`, a timed-out or refused connection → `TIMEOUT` / `TRANSPORT_UNAVAILABLE`, any other `4xx` → `REJECTED`. The dispatcher's guarantees are unchanged: it never throws, the `PENDING` audit row is written before the send, and the row becomes `SENT` (with Resend's message id in `providerMessageId`) or `FAILED` with the error class alone.

**Transactional only, and untracked.** The three templates are customer activation, the provider-claim invitation and the day-7 request reminder. Open and click tracking are off for the domain and nothing here asks for them: the action link is a plain anchor to the application's own URL, so a single-use security link is never rewritten through a redirector.

**Turning it on does not turn anything else on.** `PROVIDER_CLAIM_ENABLED` stays `false` until somebody decides otherwise; a configured Resend transport only makes it *possible* to turn on in production.

## Credit Package Payments

Providers top their credit balance up by buying a credit package. Which provider settles that purchase is decided by one allow-listed setting:

```bash
PAYMENT_PROVIDER=mock          # mock | lemon-squeezy-test
```

| Provider | Collects money? | Where it runs | Notes |
| --- | --- | --- | --- |
| `mock` | no | shipped default, development | The in-app checkout form, labelled as a test on screen, settled by `POST /providers/:id/package-purchases/:purchaseId/mock-pay`. |
| `lemon-squeezy-test` | **no — sandbox only** | opt-in, non-production | Lemon Squeezy hosted checkout in test mode. Credits are loaded only by a signature-verified webhook. |

> **Live payment collection is not part of this build, and cannot be enabled.**
> Lemon Squeezy has not approved this marketplace's suitability in writing. Until that written approval exists, there is no live mode to switch on — not even one that is off. Setting `LEMON_SQUEEZY_LIVE_ENABLED`, `LEMON_SQUEEZY_LIVE_API_KEY`, `LEMON_SQUEEZY_LIVE_STORE_ID` or `PAYMENT_LIVE_ENABLED` to *anything*, or `LEMON_SQUEEZY_MODE` to anything but `test`, stops the API at boot. `PAYMENT_PROVIDER=lemon-squeezy-test` is additionally refused under `NODE_ENV=production`. Going live is a separate, deliberate piece of work that starts with that approval.

**What is being sold.** Provider software usage credits — *teklif gönderme kullanım kredisi*: the right to send offers inside this application, bought by a provider for its own account. It is not a service sale and no money moves from a customer to a provider. The Lemon Squeezy product name and description say exactly that, and so does the code.

**Sandbox settings.** Required only with `PAYMENT_PROVIDER=lemon-squeezy-test`, all validated at boot, none ever logged, stored or returned:

```bash
LEMON_SQUEEZY_API_KEY=<sandbox key>          # deployment secret; never commit
LEMON_SQUEEZY_STORE_ID=<numeric store id>    # sandbox store
LEMON_SQUEEZY_WEBHOOK_SECRET=<secret>        # 16-255 printable, non-space; never commit
LEMON_SQUEEZY_VARIANT_MAP=starter-20:2058219,pro-50:2058261,business-100:2058269
LEMON_SQUEEZY_TIMEOUT_MS=10000               # optional, 1000-60000
```

`LEMON_SQUEEZY_VARIANT_MAP` maps credit package **slugs** to sandbox variant ids, so the mapping survives a reseed. It is not JSON — comma-separated `slug:variantId` pairs, with the slugs `prisma/seed.ts` creates (`starter-20`, `pro-50`, `business-100`). It is an allow-list in both directions: an unmapped package cannot be checked out, and a variant may stand for exactly one package. A boot failure names the variable and never its value.

**Running the sandbox provider locally.** `docker-compose.yml` forwards `PAYMENT_PROVIDER`, `LEMON_SQUEEZY_MODE`, `LEMON_SQUEEZY_API_KEY`, `LEMON_SQUEEZY_STORE_ID`, `LEMON_SQUEEZY_WEBHOOK_SECRET`, `LEMON_SQUEEZY_VARIANT_MAP`, `LEMON_SQUEEZY_TIMEOUT_MS` and `LEMON_SQUEEZY_API_BASE_URL` into the **api** container and nowhere else — the web and admin containers open no checkouts and verify no signatures, so they are given none of them. Put the values in your own untracked `.env` (never in `.env.example`, never in `docker-compose.yml`, never in a commit), then recreate just that one service:

```bash
docker compose up -d api
```

Every one of them is forwarded as *empty when unset*, which the configuration reader treats exactly like unset: a stack that configures none of this still boots on `mock`, and a stack switched to `lemon-squeezy-test` without them fails at boot naming the variable and never its contents. The live-mode variables are **not** forwarded and must not be set anywhere — there is no live mode to configure, and `PAYMENT_PROVIDER=lemon-squeezy-test` is refused under `NODE_ENV=production` by design.

**Opening a checkout.** `POST /providers/:providerId/checkout-sessions` takes a package id and nothing else. The caller must be the provider's own `PROVIDER` account — a `SUPER_ADMIN` who needs to move a balance has the audited grant endpoint instead. The credit amount, price and currency are read from the active package and snapshotted onto a new `PENDING` `PackagePurchase`, together with an opaque correlation token minted here. Asking again for a package that already has a live checkout hands the same purchase and the same payment link back (`checkout.reused: true`) rather than opening a second one. If the provider cannot open a checkout the purchase is closed as `FAILED` with a short code — never a provider response body — so nothing lingers as an unpayable `PENDING` row.

**Only a webhook loads credits.** `POST /payments/lemon-squeezy/webhook` is public and guarded by an HMAC over the exact bytes received (`req.rawBody`; the app boots with `rawBody: true`). Nothing is parsed, stored or logged before that check passes — a bad or missing signature is a `401` with zero database writes. After it passes, the payload is read into a narrow projection that drops every buyer detail, then matched against this application's own records: test mode, store id, correlation token, amount, currency, sandbox variant, and the purchase's own state. A single mismatch loads nothing and leaves an audit row. The effect and its audit row are written in one `Serializable` transaction; unique indexes on `(provider, eventKey)` and on `providerOrderId` make a redelivered event, a re-notified order and two concurrent deliveries collapse into exactly one `PACKAGE_PURCHASE` ledger row and one balance change.

**A redirect is a navigation.** The hosted checkout's return URL points at the purchase's own screen, which re-reads the canonical status from the API. It never says "paid" on its own, it carries no correlation token, and there is no endpoint anywhere that turns a browser landing into credit. The in-app mock payment endpoint refuses purchases opened against a payment provider, and refuses to run at all on a deployment wired to one.

**Refunds and chargebacks move nothing.** `order_refunded` and `subscription_payment_refunded` set a manual-review flag on the purchase and write an audit row; no balance is deducted. Taking credits back automatically would mean reclaiming capacity a provider may already have spent on offers that were sent and answered, so that decision stays with a person. The admin package list surfaces the count and the detail screen shows the flag.

**Nothing sensitive is written down.** No raw payload, no signature, no API key, no webhook secret and no buyer name, address or card detail reaches a log line, a database row or an API response. `PaymentWebhookEvent` stores the provider's opaque event identity, the event name, a status and a short machine code such as `AMOUNT_MISMATCH`. The admin configuration screen lists the **names** of unfilled settings and has no code path that could show a value.

**The browser suite never contacts a payment provider.** A fifth runtime runs the same code with `PAYMENT_PROVIDER=lemon-squeezy-test` (ports 3240-3242), pointed at a loopback stand-in for the sandbox API via `LEMON_SQUEEZY_API_BASE_URL` — a test seam the configuration reader accepts only for loopback and refuses in production. The scenario starts a real checkout, follows the real redirect back, shows the balance still at zero, and only then posts a signed settlement notice.

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

### Unviewed-offer credit refund

The platform refunds one thing and only one thing: the credit a provider spent on an offer that the authorised customer never opened within 48 hours of it being submitted. A viewed offer is never refunded — not on rejection, expiry, withdrawal or anything else — and an unviewed one is refunded regardless of the status it ended in. There is no manual refund path; the admin offer screen shows the outcome and cannot create one.

Only offers created after this policy shipped are covered. `Offer.unviewedRefundPolicy` records that per row, so an offer sold under the earlier terms is out of scope permanently and no clock comparison decides it.

The worker is disabled by default. It uses the same execution logic as the admin refund-scan endpoint, so both share one set of eligibility checks, one transaction and one database-level idempotency guarantee (`ProviderCreditTransaction_one_refund_per_offer`, a partial unique index that makes a second refund row for one offer impossible).

To enable it locally:

```bash
UNVIEWED_OFFER_REFUND_ENABLED=true
```

Relevant environment variables:

- `UNVIEWED_OFFER_REFUND_ENABLED=false`
- `UNVIEWED_OFFER_REFUND_CRON=0 * * * *`
- `UNVIEWED_OFFER_REFUND_LIMIT=100`

There is deliberately no window setting. The 48 hours are the promise made to providers; a cron that runs late refunds on its next pass, and no configuration can refund early. Ledger rows written by the worker carry the reason `UNVIEWED_OFFER_48H`.

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

Reminder delivery is best-effort and the claim is not: `reminderSentAt` is committed before the send, so a transport failure leaves a `FAILED` row in `NotificationLog` and never re-mails the customer. Without a delivering transport (see [Transactional E-mail](#transactional-e-mail)) sends fail visibly rather than silently — the scheduling logic is still correct.

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
