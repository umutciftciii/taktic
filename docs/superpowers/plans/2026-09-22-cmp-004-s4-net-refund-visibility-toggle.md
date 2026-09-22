# CMP-004 S4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the campaign system legible (net refund communication, admin ledger labels, provider promo visibility), model the system audit actor honestly (`actorId` nullable), and add a SUPER_ADMIN-only campaign-engine toggle — without changing any S2B1/S3 money rule and without turning the engine on anywhere.

**Architecture:** One pure summarizer (`summarizeOfferRefundSettlement`) feeds the in-transaction refund result, the e-mail and the provider web projection; readers resolve settlements by exact FK (`PromoCreditLotConsumption.refundTransactionId`). Ledger/promo projections are additive fields on existing endpoints. The toggle mirrors `MarketplacePublishSettingsService` (Serializable, change-only writes, `OperationsSettingsChange` audit). Migration G is the single `ALTER COLUMN` plus a CHECK that ties a NULL actor to `summary.actorKind = 'SYSTEM'`.

**Tech Stack:** NestJS + Prisma 6 (API), Next.js app router (web/admin), vitest (API/web/admin), Playwright (E2E, Chromium + WebKit), PostgreSQL.

## Global Constraints

- Base `origin/main@0e0c17fb`; branch `claude/cmp-004-s4-net-refund-visibility-toggle`; PR stays open, no merge.
- No local/staging deploy, no real `.env`, Cloudflare, Lemon or real-data operation; local `campaignEngineEnabled=false` untouched; toggle tested only in the isolated test DB.
- S3 financial/revoke rules, webhook idempotency, worker lease behaviour unchanged (`promo-credit-ledger.ts`, `campaign-evaluation.worker.ts`, `payments-webhook.service.ts` accounting paths untouched).
- Migration: only `CampaignAuditLog.actorId DROP NOT NULL` (+ additive CHECK). No DROP, backfill, manual SQL, DML.
- No-promo refund: API result, e-mail data/template rows, web copy byte-identical.
- No PII / `revokeNote` / raw payload / campaign rule data on ledger, provider or e-mail surfaces.
- Tests run from the worktree with `DATABASE_URL='postgresql://taktic_user:taktic_password@localhost:5433/taktic?schema=public'` exported inline; E2E via `pnpm e2e <filter>` (no `--`).
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

## File map

| Area | Create | Modify |
| --- | --- | --- |
| A settlement | `apps/api/src/modules/credits/offer-refund-settlement.ts`, `apps/api/test/offer-refund-settlement.spec.ts` | `offers/offers.service.ts` (`refundOfferCreditInTransaction` return + manual refund response), `notifications/transactional-mail.service.ts` (`sendCreditRefunded`, retry branch, `creditRefundedData`), `notifications/templates/transactional-templates.ts` (`creditRefunded`), `providers/providers.service.ts` (`listProviderOffers`/`getProviderOffer`), `apps/web/lib/api.ts` (types), `apps/web/lib/formatters.ts` (labels), `apps/web/app/providers/[id]/offers/offers-table.tsx`, `.../offers/[offerId]/page.tsx`, `.../credits/page.tsx`, `apps/api/test/transactional-email-render.spec.ts` |
| B admin ledger | `apps/api/test/finance-credit-ledger-campaign.spec.ts` | `finance/finance.service.ts` (`lookupSourceNumbers` → campaign lookup, `campaign` field), `apps/admin/lib/api.ts`, `apps/admin/lib/finance-format.ts`, `apps/admin/app/finance/credit-ledger/page.tsx`, `apps/admin/app/providers/[id]/credits/transactions-panel.tsx`, `apps/admin/test/finance-format.spec.ts` |
| C provider promo | `apps/api/test/provider-promo-visibility.spec.ts` | `credits/promo-credit-ledger.ts` (`readSpendablePromoLots` — read-only addition), `credits/credits.service.ts` (`getProviderCredits.promo`), web `credits/page.tsx`, web `globals.css` |
| D system actor | `prisma/migrations/20260922120000_campaign_audit_system_actor/migration.sql` | `prisma/schema.prisma`, `campaigns/engine/campaign-revoke.service.ts`, `campaigns/campaigns.service.ts` (`CampaignAuditView.actor` nullable), `apps/admin/app/campaigns/[id]/page.tsx`, `apps/admin/lib/api.ts`, `apps/api/test/campaign-refund-revoke.spec.ts`, `apps/api/test/admin-campaign-operations.spec.ts`, `apps/api/test/campaign-engine-schema.spec.ts` |
| E toggle | `operations-settings/campaign-engine-settings.service.ts`, `operations-settings/campaign-engine-settings.controller.ts`, `apps/api/test/campaign-engine-settings.spec.ts`, `apps/admin/app/operations-settings/campaign-engine-toggle.tsx`, `e2e/tests/admin-campaign-engine-toggle.spec.ts`, `e2e/tests/provider-promo-credits.spec.ts` | `operations-settings.module.ts`, `apps/admin/lib/api.ts`, `apps/admin/app/operations-settings/page.tsx`, `apps/admin/app/operations-settings/actions.ts`, `apps/admin/app/campaigns/engine-notice.tsx`, `apps/admin/app/campaigns/[id]/page.tsx`, `e2e/playwright.config.ts` (WebKit `testMatch`) |
| F docs | `docs/superpowers/plans/2026-09-22-cmp-004-s4-migration-g-dryrun.txt`, `docs/superpowers/plans/2026-09-22-cmp-004-s4-teslim-raporu.md` | — |

---

### Task 1: Offer refund settlement — pure summarizer + reader

**Files:** create `apps/api/src/modules/credits/offer-refund-settlement.ts`; test `apps/api/test/offer-refund-settlement.spec.ts`.

**Interfaces (Produces):**
```ts
export type OfferRefundSettlement = {
  refundTransactionId: string;
  grossCredits: number;              // OFFER_REFUND.amount
  promoRestoredCredits: number;      // Σ refundedCredits of REFUNDED shares
  promoForfeitedCredits: { expired: number; revoked: number; total: number };
  netCredits: number;                // gross − forfeited.total
  balanceBefore: number;             // refund.balanceAfter − refund.amount
  balanceAfter: number;              // last forfeit row's balanceAfter, else refund.balanceAfter
};
export function summarizeOfferRefundSettlement(refund: { id; amount; balanceAfter }, shares: Array<{ status; refundedCredits; forfeitedCredits; forfeitTransaction: { balanceAfter; createdAt; id } | null; forfeitType: 'CAMPAIGN_EXPIRE'|'CAMPAIGN_REVOKE'|null }>): OfferRefundSettlement;
export async function readOfferRefundSettlements(db: Prisma.TransactionClient | PrismaClient, refundTransactionIds: string[]): Promise<Map<string, OfferRefundSettlement>>;
```
Reader query: `providerCreditTransaction.findMany({ where: { id: { in }, type: OFFER_REFUND }, select: { id, amount, balanceAfter, promoConsumptionsAsRefund: { select: { status, refundedCredits, forfeitedCredits, forfeitTransaction: { select: { id, type, balanceAfter, createdAt } } } } } })`. Forfeit type = `forfeitTransaction.type`.

- [ ] Write failing tests (spec file skeleton with `createTestApp`, `providerFixture`, `submitOffer`, `manualRefund` copied from `promo-credit-ledger.spec.ts`): (1) no-promo refund → `{gross 3, restored 0, forfeited {0,0,0}, net 3, before, after}` and reader `toEqual` API `settlement`; (2) full promo revivable; (3) partial promo, lot expired after spend → forfeited.expired 3, net = paid share; (4) partial promo, lot revoked → forfeited.revoked; (5) duplicate manual refund 409, reader map unchanged.
- [ ] Run: `DATABASE_URL=... pnpm --filter @taktic/api exec vitest run test/offer-refund-settlement.spec.ts` → FAIL (module missing).
- [ ] Implement module; wire into Task 2 for the API `settlement` field (tests 1–5 pass only after Task 2).
- [ ] Commit `feat(api): canonical offer refund settlement summary`.

### Task 2: Wire settlement into the refund transaction and manual refund response

**Files:** `apps/api/src/modules/offers/offers.service.ts:894-990` (`refundOfferCreditInTransaction` returns `settlement`; `refundOfferCreditRecord` returns `settlement`).

- [ ] In `refundOfferCreditInTransaction`, after `promo`, compute `settlement = summarizeOfferRefundSettlement(refundTransaction, sharesFromOutcome)` where shares are built from `promo.refunded` (status REFUNDED, refundedCredits) and `promo.forfeited` (status FORFEITED, forfeitedCredits, forfeitTransaction from a `tx.providerCreditTransaction.findMany({ where: { id: { in: forfeited.map(f => f.transactionId) } } })`). Return `{ refundTransaction, balanceAfter, promo, settlement }`.
- [ ] Manual refund response adds `settlement`; existing `balance` unchanged.
- [ ] Run Task 1 spec → PASS; run `promo-credit-ledger.spec.ts`, `unviewed-offer-refund.spec.ts`, `request-removal-refund.spec.ts` → PASS.
- [ ] Commit `feat(api): return the refund settlement from the refund transaction`.

### Task 3: E-mail uses the settlement

**Files:** `transactional-mail.service.ts` (`sendCreditRefunded`, retry `case 'credit-refunded'`, `creditRefundedData(provider, offer, settlement, reasonLabelSource)`), `templates/transactional-templates.ts` (`creditRefunded`, subject), `apps/api/test/transactional-email-render.spec.ts`, `apps/api/test/transactional-email-events.spec.ts`.

New MailData keys (all strings, null when 0): `promoRestoredCredits`, `promoForfeitedCredits`, `promoForfeitedExpiredCredits`, `promoForfeitedRevokedCredits`, `netCredits`. `previousBalance = settlement.balanceBefore`, `currentBalance = settlement.balanceAfter`, `refundedCredits = settlement.grossCredits`.

Template: rows `İade edilen`, then if forfeited>0 `Geri alınan promosyon kredisi: −Y`, `Net değişim: +Z`; then balances. Subject when forfeited>0: `withSuffix('Krediniz iade edildi', 'net +Z kredi')`; heading `X kredi iade edildi` unchanged. Note (forfeited>0): expired → "Y promosyon kredisi, ait olduğu kampanyanın süresi dolduğu için bakiyenize dönmedi; ücretli bakiyenizden düşülmedi, borç oluşmadı." revoked → "...promosyon geri alındığı için..." both → combined. Note (restored>0): "X kredisi promosyon kredisi olarak geri döndü; son kullanma tarihi değişmedi."

- [ ] Render test: existing fixture unchanged renders identically (snapshot of rows: no "promosyon" text). New fixture with `promoForfeitedCredits: '3'`, `netCredits: '2'` → HTML contains "−3", "Net değişim", "+2", and no "borç".
- [ ] Events test: settlement-driven `currentBalance` after forfeit (extend Task 1 spec: assert `ctx.notifications.ofTemplate('credit-refunded')` data for the expired case: refundedCredits '3', promoForfeitedCredits '3', netCredits '0'? — use partial promo so net > 0).
- [ ] Commit `feat(api): net refund figures in the credit-refunded e-mail`.

### Task 4: Provider web projection + copy

**Files:** `providers/providers.service.ts` (`listProviderOffers`, `getProviderOffer` add `creditRefundSettlement`), `apps/web/lib/api.ts` (`OfferRefundSettlement`, `ProviderOffer.creditRefundSettlement`, `CreditTransactionType` += 3, `ProviderCredits.promo`), `apps/web/lib/formatters.ts` (`creditTxnTypeLabel` += `CAMPAIGN_GRANT: 'Promosyon kredisi'`, `CAMPAIGN_EXPIRE: 'Promosyon süresi doldu'`, `CAMPAIGN_REVOKE: 'Promosyon geri alındı'`; new `creditReasonLabel(reason)` mapping `CAMPAIGN_GRANT`, `PROMO_LOT_EXPIRED`, `PROMO_LOT_REVOKED:*`, `PROMO_FORFEIT_ON_REFUND:*`, `UNVIEWED_OFFER_48H`, `MANUAL_ADMIN_REFUND:*` → Turkish, else raw), `offers-table.tsx`, `offers/[offerId]/page.tsx`, `credits/page.tsx` (reason column via `creditReasonLabel`).
- [ ] API test in `provider-promo-visibility.spec.ts` (Task 6) or Task 1 spec: `GET /providers/:id/offers` refunded offer carries `creditRefundSettlement` equal to reader; non-refunded → null; customer view (`GET /requests/:id/offers`) has no such key.
- [ ] Web unit test `apps/web/test/formatters.spec.ts` (+): labels.
- [ ] Commit `feat(web): net refund on provider offer history`.

### Task 5: Admin ledger campaign labels

**Files:** `finance/finance.service.ts` (`SourceNumberLookup` += `campaignByReference: Map<string, {id,name,versionNumber}>`; lookup for `CampaignRedemption` (redemption→campaign+campaignVersion), `PromoCreditLot` (lot→redemption→…), `PromoCreditLotConsumption` (consumption→lot→redemption→…); item `campaign`), `apps/admin/lib/api.ts` (`CREDIT_TRANSACTION_TYPES` += 3, `CreditTransactionType` += 3, `CreditLedgerEntry.campaign`), `finance-format.ts` (`REASON_LABELS` += `CAMPAIGN_GRANT: 'Kampanya promosyon kredisi'`, `PROMO_LOT_EXPIRED: 'Promosyon süresi doldu'`; special-case `PROMO_LOT_REVOKED:<tail>` → `Promosyon geri alındı (ödeme iadesi | yönetici)`, `PROMO_FORFEIT_ON_REFUND:<tail>` → `Teklif iadesinde promosyon payı düştü (süresi dolmuş | geri alınmış lot)` with `note: null`; `formatLedgerSource` accepts `campaign` → label `Kampanya`, displayNumber `<name> · sürüm N`, href `/campaigns/<id>`), `credit-ledger/page.tsx` (TYPE_LABELS/BADGE += 3), `transactions-panel.tsx` (TYPE_LABELS/BADGE/SOURCE += 3, reason via shared mapping copy).
- [ ] API test: three rows via `createPromoLotFixture` + expiry sweep + revoke → `campaign` filled for each, `null` for `ADMIN_GRANT`; `type=CAMPAIGN_REVOKE` filter works; body JSON has no `revokeNote`/provider email beyond existing `provider.email` (pre-existing field — assert `revokeNote` absent).
- [ ] Admin unit test `apps/admin/test/finance-format.spec.ts` (+3 cases).
- [ ] Commit `feat(admin): campaign ledger rows labelled`.

### Task 6: Provider promo visibility

**Files:** `promo-credit-ledger.ts` (+`readSpendablePromoLots(db, providerId, now)` → `[{ id, remainingCredits, expiresAt, campaignName }]`, same predicate/order as `consumePromoCreditsForSpend`), `credits.service.ts` (`getProviderCredits` → `promo: { spendableCredits, lots }`), web `credits/page.tsx` (+ block `data-testid="promo-credits"`), `globals.css`.
- [ ] API test `provider-promo-visibility.spec.ts`: own provider sees 2 active lots ordered by expiry with total; expired (past `expiresAt`, unswept), swept EXPIRED, REVOKED, EXHAUSTED excluded; anon 401; CUSTOMER 403; other PROVIDER 403; SUPER_ADMIN 200; response JSON contains no `definition`/`rulesSnapshot`/`conditions` keys.
- [ ] Commit `feat: provider sees spendable promo credits`.

### Task 7: Migration G + system actor

**Files:** migration SQL, `schema.prisma`, `campaign-revoke.service.ts`, `campaigns.service.ts`, admin `[id]/page.tsx`, admin `lib/api.ts`, tests.
- [ ] Schema test (`campaign-engine-schema.spec.ts` +2): insert `actorId=null` with `summary.actorKind='SYSTEM'` OK; `actorId=null` without → CHECK violation.
- [ ] `campaign-refund-revoke.spec.ts`: webhook revoke → `REDEMPTION_REVOKED` with `actorId null`, `summary.actorKind 'SYSTEM'`, `source 'PAYMENT_REVERSED'`; `AUTO_PAUSED` `actorId null`; duplicate → still one each. `admin-campaign-operations.spec.ts`: admin revoke `actorId = admin`; admin-triggered auto-pause actor admin.
- [ ] Prisma: `actorId String?`, `actor User?`. Revoke service: `AUTO_PAUSED` actorId `source.kind === 'ADMIN_REVOKED' ? source.actorId : null`; in `revokeForRefundedPurchase` after core revoke write `REDEMPTION_REVOKED` SYSTEM audit.
- [ ] `CampaignAuditView.actor: ActorView | null`; admin `auditActorLabel`: `entry.actor === null || summary.actorKind === 'SYSTEM'` → `Sistem (ödeme iadesi)`.
- [ ] Dry-run on temp DB `taktic_cmp004_s4_dryrun`: `prisma migrate deploy` (72), `prisma migrate diff --from-url --to-schema-datamodel` "No difference detected"; save output to `docs/superpowers/plans/2026-09-22-cmp-004-s4-migration-g-dryrun.txt`; drop DB.
- [ ] Commit `feat(api): system actor in the campaign audit log (Migration G)`.

### Task 8: Campaign engine toggle API

**Files:** `operations-settings/campaign-engine-settings.service.ts` (`CAMPAIGN_ENGINE_SETTING = 'campaignEngineEnabled'`, `CampaignEngineSwitchService.getForAdmin()/setEnabled(enabled, changedById)`), `campaign-engine-settings.controller.ts` (`@Controller('operations-settings/campaign-engine')`, GET/PUT, SUPER_ADMIN), `operations-settings.module.ts`, test `campaign-engine-settings.spec.ts`.
- [ ] Tests: default GET `{enabled:false, recentChanges:[]}`; anon 401; CUSTOMER/PROVIDER 403 on GET and PUT; PUT true → change `{previousValue:null,newValue:'true'}`; PUT true again → no new change; PUT false → `{previousValue:'true',newValue:'false'}`; 6 concurrent PUTs alternating → final `enabled` equals a consistent chain (each change's previousValue = prior newValue, first null); no seed/migration sets true (`resetDatabase` then GET false). Hook matrix: engine off → `providerApproved` writes no event; on → one event, worker one grant (ACTIVE campaign fixture); off again → no event; on with no ACTIVE campaign → worker `runOnce` grants nothing (`engineWriteSnapshot` only event rows). Refund-while-off: reuse `campaign-refund-revoke` #4 (unchanged).
- [ ] Commit `feat(api): SUPER_ADMIN campaign engine switch with audit`.

### Task 9: Toggle UI + notices

**Files:** admin `lib/api.ts` (`CampaignEngineSettings`), `operations-settings/actions.ts` (`toggleCampaignEngineAction` requires `confirm === 'on'`, redirects `#kampanya-motoru`, `ok=campaign-engine-on|off`, `revalidatePath('/campaigns')`), `campaign-engine-toggle.tsx` (form: hidden `enabled`, checkbox `confirm` required, submit button "Motoru aç"/"Motoru kapat", `data-testid="campaign-engine-toggle"`), `page.tsx` (card `#kampanya-motoru` with state pill `data-testid="campaign-engine-state"`, effect text, recent changes table), `campaigns/engine-notice.tsx` and `campaigns/[id]/page.tsx` copy → link to `/operations-settings#kampanya-motoru`.
- [ ] E2E `admin-campaign-engine-toggle.spec.ts`: state Kapalı; submit without confirm → error notice, API state unchanged (DB `campaignEngineEnabled` false); confirm + submit → Açık, audit row; toggle off → Kapalı; provider session → `/login`; 320/768/1024/1440 no overflow; `finally` set false.
- [ ] Commit `feat(admin): campaign engine toggle with explicit confirmation`.

### Task 10: Provider E2E + WebKit + quality gates

- [ ] `e2e/tests/provider-promo-credits.spec.ts`: seed lot (fixture like admin-campaign-operations), provider opens `/providers/<id>/credits` → promo block shows total, lot date, campaign name; ledger row label "Promosyon kredisi"; an offer refunded after lot expiry shows `net` line in `/providers/<id>/offers`; widths 320–1440 no overflow; screenshots to `e2e/.artifacts/provider-promo-credits/`.
- [ ] Add both specs to WebKit `testMatch`.
- [ ] `pnpm typecheck && pnpm lint && pnpm build`; API full `vitest run`; web/admin/shared tests; `pnpm e2e provider-promo-credits admin-campaign-engine-toggle admin-campaign-operations`; WebKit filter on fresh DB.
- [ ] Open PR; watch CI 3/3; write `docs/superpowers/plans/2026-09-22-cmp-004-s4-teslim-raporu.md` (accounting table, actorId rationale, toggle matrix, leak/authz tests, dry-run, changed files, staging steps); commit; final CI.
