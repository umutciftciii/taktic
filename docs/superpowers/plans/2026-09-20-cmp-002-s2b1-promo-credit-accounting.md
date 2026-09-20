# CMP-002 S2B1 Promo Credit Accounting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ledger types, lot consumption, source-aware refund and expiry accounting for campaign promo credits, with the engine still off and no hooks.

**Architecture:** One additive migration (enum values + `PromoCreditLotConsumption`). One tx-scoped function module `credits/promo-credit-ledger.ts` used by the entitlement resolver (spend), the refund free function (restore/forfeit), and an internal expiry service (sweep). No DI, no scheduler, no endpoints. Spec: `docs/superpowers/specs/2026-09-20-cmp-002-s2b1-promo-credit-accounting-design.md`.

**Tech Stack:** NestJS 11, Prisma 6 (PostgreSQL), vitest + supertest integration tests against a per-checkout `_test` database.

## Global Constraints

- Base `origin/main@e801443a`; branch `claude/cmp-002-s2b1-promo-credits-7c88bd`; no merge/deploy/local-staging sync/real `.env`/Cloudflare/Lemon/real data.
- Enum values exactly `CAMPAIGN_GRANT`, `CAMPAIGN_EXPIRE`, `CAMPAIGN_REVOKE`; the six existing values keep their meaning.
- Migration is additive only: no DML, backfill, DROP, ALTER COLUMN.
- `campaignEngineEnabled` stays false; no toggle, activation, hooks, scheduler, seed, admin grant.
- `campaign-engine.service.ts` / `campaign-engine.repository.ts` untouched.
- Lot selection: ACTIVE, remaining > 0, expiresAt > now; `expiresAt ASC, id ASC`.
- Tests run with `DATABASE_URL='postgresql://taktic_user:taktic_password@localhost:5433/taktic?schema=public' pnpm --filter @taktic/api test <filter>` after `pnpm db:generate`.

---

## File structure

| File | Responsibility |
| --- | --- |
| `prisma/schema.prisma` | enum values, `PromoCreditLotConsumptionStatus`, `PromoCreditLotConsumption`, back-relations on `ProviderCreditTransaction`/`PromoCreditLot` |
| `prisma/migrations/20260920090000_add_promo_credit_consumption/migration.sql` | Migration C (hand-written from `prisma migrate diff`, plus CHECKs) |
| `apps/api/src/modules/credits/promo-credit-ledger.ts` | tx-scoped accounting functions (spend, restore, grant, expire, revoke, invariant read) |
| `apps/api/src/modules/credits/promo-credit-lot-expiry.service.ts` | `PromoCreditLotExpiryService.expireDueLots(now)` sweep seam (per-lot `runSerializable`) |
| `apps/api/src/modules/credits/credits.module.ts` | provide + export the expiry service |
| `apps/api/src/modules/entitlements/entitlement-resolver.service.ts` | resolve: subtract unswept-expired remaining; consume: lot consumption after the debit |
| `apps/api/src/modules/offers/offers.service.ts` | `refundOfferCreditInTransaction`: take `creditSpentTransactionId`, restore/forfeit, return `balanceAfter` |
| `apps/api/src/modules/service-requests/service-requests.service.ts` | pass `creditSpentTransactionId` |
| `apps/api/test/harness.ts` | truncate list += `PromoCreditLotConsumption` |
| `apps/api/test/campaign-fixtures.ts` | `engineWriteSnapshot` += `consumptions`; `createPromoLotFixture` (event + redemption + grant primitive) |
| `apps/api/test/promo-credit-consumption-schema.spec.ts` | schema/CHECK/enum proofs |
| `apps/api/test/promo-credit-ledger.spec.ts` | accounting scenarios |
| `apps/api/test/campaign-engine-isolation.spec.ts` | zero-write proof extended |

## Interfaces (`promo-credit-ledger.ts`)

```ts
export type PromoTx = Prisma.TransactionClient;
export const PROMO_SPENDABLE_LOT_ORDER = [{ expiresAt: 'asc' }, { id: 'asc' }] as const;

/** Remaining promo that still sits in balanceAfter but is no longer spendable (expiresAt <= now, not yet swept). */
export function readUnsweptExpiredPromoCredits(tx, providerId: string, now: Date): Promise<number>;

/** Called after the OFFER_SPEND row exists. Returns the per-lot split; [] when no promo lot could pay. */
export function consumePromoCreditsForSpend(tx, input: { providerId; spendTransactionId; creditCost; now }): Promise<Array<{ lotId; consumedCredits }>>;

/** Called after the OFFER_REFUND row exists. Revives or forfeits every CONSUMED row of that debit. */
export function restorePromoConsumptionsForRefund(tx, input: { providerId; spendTransactionId; refundTransactionId; now }): Promise<{ refunded: Array<{lotId; credits}>; forfeited: Array<{lotId; credits; transactionId}>; balanceAfter: number | null }>;

export function grantPromoCreditLot(tx, input: { providerId; redemptionId; credits; expiresAt; now }): Promise<{ lotId; transactionId }>;
export function expirePromoCreditLot(tx, input: { lotId; now }): Promise<{ expired: boolean; transactionId: string | null; credits: number }>;
export function revokePromoCreditLot(tx, input: { lotId; reason: CampaignRevokeReason; revokedById: string | null; now }): Promise<{ revoked: boolean; transactionId: string | null; credits: number }>;
```

---

### Task 1: Migration C + schema
- [ ] schema.prisma: enum values, `PromoCreditLotConsumptionStatus`, model, back-relations (`ProviderCreditTransaction.promoConsumptionsAsSpend/AsRefund/promoForfeitOf`, `PromoCreditLot.consumptions`).
- [ ] `pnpm db:generate`; generate SQL with `prisma migrate diff --from-migrations --to-schema-datamodel --shadow-database-url <temp db>`; write migration with header comment + CHECKs.
- [ ] Write `promo-credit-consumption-schema.spec.ts` (enum order 9 values, unique, CHECKs, FK Restrict); run → pass.
- [ ] harness truncate list; commit.

### Task 2: `promo-credit-ledger.ts` primitives (grant/expire/revoke) + fixture
- [ ] Write failing tests for grant (ledger + lot + redemption link; second grant no-op/P2002), expire (once; second call no-op; EXHAUSTED lot → EXPIRED with no ledger row; redemption EXPIRED), revoke (remaining forfeited; redemption REVOKED + spentAtRevoke).
- [ ] Implement; run; commit.

### Task 3: Spend path
- [ ] Failing tests: no promo → identical ledger/balance/402; two lots → earliest expiry first; promo + paid split; exhausted lot flips EXHAUSTED; expired-unswept lot not spendable (402 when only such credit exists) and not consumed.
- [ ] Modify resolver `resolve()` + `consume()`; run; commit.

### Task 4: Refund path
- [ ] Failing tests: refund revives ACTIVE/EXHAUSTED lot; refund after expiry/sweep forfeits with `CAMPAIGN_EXPIRE`; refund after revoke forfeits with `CAMPAIGN_REVOKE`; mixed; second refund 409 with no consumption change; worker + manual + request-removal callers.
- [ ] Modify `refundOfferCreditInTransaction` + callers; run; commit.

### Task 5: Expiry service + concurrency + invariant
- [ ] `PromoCreditLotExpiryService`; tests: sweep expires due lots once, second sweep zero writes; barrier test two concurrent offers vs last promo credit → single consumption; invariant `Σ amount = balanceAfter` and `balance = paid + Σ remaining`.
- [ ] Commit.

### Task 6: Isolation extension + regression + docs
- [ ] `engineWriteSnapshot` += consumptions; isolation spec asserts 0 consumptions and six-type ledger.
- [ ] Run full api tests, typecheck, lint, build, web/admin/shared tests, e2e chromium + webkit.
- [ ] Isolated migration dry-run record; teslim raporu; PR.
