# VIT-DESIGN-002 — Vitrin paket-önce akışı Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vitrin paketini önce sattırıp, ödemeden doğan yayın hakkıyla kart oluşturma → inceleme → onayda otomatik yayın akışını API + web + admin'de uygulamak ve tüm vitrin arayüzünü ürün seviyesine çıkarmak.

**Architecture:** Yeni `ShowcaseEntitlement` (yayın hakkı) tablosu ödeme ile placement arasına girer: settlement hak üretir, kart oluşturma hakkı rezerve eder, admin onayı hakkı tüketip placement doğurur. İnceleme süresi hakkın saatini durdurur (`ShowcaseEntitlementReviewPause`). Web tarafında tek `ShowcaseCardFace` bileşeni sağlayıcı, müşteri ve özet ekranlarında aynı kartı çizer; durum çözümü sunucuda (`ShowcasePublicationService`) yapılır.

**Tech Stack:** NestJS + Prisma 6 (PostgreSQL), Next.js App Router (web/admin), Vitest (API/web unit), Playwright (Chromium + WebKit). Spec: `docs/superpowers/specs/2026-09-11-vitrin-package-first-flow-design.md`.

## Global Constraints

- Yeni dependency **eklenmez**. Lemon/Resend/Cloudflare/`.env`/compose ayarlarına **dokunulmaz**. Para iadesi davranışı **eklenmez**.
- `apps/api` **asla** `@taktic/shared` import etmez (runtime boot hatası).
- Migration additive; hiçbir mevcut satır okunmaz/güncellenmez/silinmez. Dry-run yalnız izole kopya DB'de. Aktif `DATABASE_URL` shadow olarak kullanılmaz; `db push`, reset, aktif DB'ye `migrate diff --shadow-database-url` **yasak**.
- Worktree'de `.env` yok: API testleri `DATABASE_URL='postgresql://taktic_user:taktic_password@localhost:5433/taktic?schema=public' pnpm --filter @taktic/api test -- <spec>` şeklinde koşulur (test DB adı checkout yoluna göre türetilir, aktif DB'ye yazmaz). E2E her zaman `pnpm e2e` / `pnpm e2e:webkit` ile (migrate deploy adımı dahil).
- Kullanıcıya `ShowcaseCardVersion`, placement, purchase ID, variant, raw kabul kaydı, teknik hata kodu veya sistem içi durum **gösterilmez**.
- Kopya (aynen): sayfa başlığı `Vitrinde yer alın`; sayaç `N kullanılabilir vitrin hakkınız var`; CTA'lar `Vitrin paketi al`, `Vitrin kartını oluştur`, `Güvenli ödemeye geç`, `İncelemeye gönder`, `Düzenle ve yeniden gönder`, `Yayını görüntüle`, `Yeniden yayınla`, `Kartı düzenle`, `Kartı sil ve yayın hakkını serbest bırak`, `Bu hizmeti incele`, `Devam et`, `Vazgeç`; rozetler `Taslak`, `İncelemede`, `Pakete hazır`, `Yayında`, `Reddedildi`, `Süresi doldu`; ödeme dönüşü `Vitrin hakkınız hazır` / `Şimdi kartınızı oluşturun`; yapılandırmasız paket `Bu paket şu an satın alınamıyor`; bölge satırı `Hizmet bölgesi · Kadıköy, İstanbul`.
- Hak geçerliliği: `ShowcasePackage.activationWindowDays` DEFAULT 90. İnceleme süresi hakkı tüketmez.
- Admin menü: `Paketler`, `Kart incelemeleri`, `Yayındaki kartlar`, `Vitrin talepleri`.
- 320px'te yatay taşma 0; grid 1 / 2 (≥768px) / 3 (≥1200px) kolon. Reduced-motion ve panel mobil drawer korunur.
- Commit mesajları Türkçe, mevcut `feat(showcase): …` üslubunda; her commit sonunda `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

## Dosya haritası

**Prisma**
- Modify `prisma/schema.prisma` — enum'lar, `ShowcasePackage.activationWindowDays`, `ShowcasePackageTermsAcceptance`, `ShowcaseEntitlement`, `ShowcaseEntitlementReviewPause`, `PackagePurchase.showcasePackageTermsAcceptanceId`, ilişkiler.
- Create `prisma/migrations/20260911120000_add_showcase_entitlements/migration.sql`.

**API (`apps/api/src/modules/showcase/`)**
- Create `showcase-entitlement.service.ts` — hak yaşam döngüsü (grant / reserve / release / pause / resume / consume / list / expire).
- Create `showcase-publish-preflight.ts` — `assertCategoryStillOpen` + `assertVersionAreasCovered` (checkout servisinden taşınır; onay ve `use-entitlement` paylaşır).
- Create `showcase-package-checkout.service.ts` — `POST packages/checkout`, `GET package-terms`.
- Create `dto/showcase-package-checkout.dto.ts`, `dto/use-showcase-entitlement.dto.ts`.
- Modify `showcase-placement.service.ts` — `createForEntitlement`.
- Modify `showcase-placement-expiry.service.ts` — hak süpürmesi.
- Modify `provider-showcase-cards.service.ts` — create/submit/withdraw/archive/use-entitlement.
- Modify `provider-showcase-cards.controller.ts` — `price-terms` / `:cardId/price-terms(-acceptances)` kaldır; `:cardId/use-entitlement` ekle; `:cardId/archive` release.
- Modify `provider-showcase-placements.controller.ts` — `placements/checkout`, `placements/eligibility` kaldır; `packages/checkout`, `package-terms`, `entitlements` ekle.
- Modify `admin-showcase.service.ts` — approve consume+preflight, reject resume; `getVersion` hak bilgisi.
- Modify `showcase-publication.service.ts` — yeni durum modeli.
- Modify `showcase-packages.service.ts`, `dto/showcase-package.dto.ts` — `activationWindowDays`.
- Modify `showcase.errors.ts` — yeni hata kodları.
- Modify `showcase.module.ts` — sağlayıcı kayıtları.
- Modify `../payments/payments-webhook.service.ts`, `../package-purchases/package-purchases.service.ts` — settlement dalı.
- Delete `showcase-checkout.service.ts`, `dto/showcase-checkout.dto.ts`; `showcase-price-terms.service.ts` sadece admin listeleme için kalır (provider uçları kaldırılır).
- Tests: `apps/api/test/showcase-entitlement-lifecycle.spec.ts`, `showcase-package-checkout.spec.ts`, `showcase-entitlement-review-flow.spec.ts`, `showcase-legacy-routes.spec.ts`; güncellenen: `showcase-placement-settlement.spec.ts`, `showcase-publication-state.spec.ts`, `showcase-price-terms-acceptance.spec.ts`, `showcase-card-authoring.spec.ts`, `showcase-review-lifecycle.spec.ts`, `showcase-withdraw-submission.spec.ts`, `showcase-placement-version-pin.spec.ts`, `showcase-placement-lifecycle.spec.ts`, `showcase-lead-flow.spec.ts`, `harness.ts`; silinen: `showcase-placement-checkout.spec.ts`.

**Web (`apps/web/`)**
- Modify `lib/api.ts` — tipler; `lib/panel-routes.ts` — rotalar.
- Create `app/showcase-card-face.tsx` — paylaşılan kart yüzü.
- Create `app/providers/[id]/vitrin/paketler/page.tsx` + `package-picker.tsx` (client); `app/providers/[id]/vitrin/odeme/[purchaseId]/page.tsx`; `app/providers/[id]/vitrin/[cardId]/duzenle/page.tsx`; `app/providers/[id]/vitrin/card-menu.tsx` (client: ⋯ + dialog).
- Modify `app/providers/[id]/vitrin/page.tsx`, `actions.ts`, `showcase-stage.ts`, `showcase-errors.ts`, `showcase-card-fields.tsx`, `yeni/page.tsx`, `yeni/new-card-form.tsx`, `[cardId]/page.tsx`, `[cardId]/edit-card-form.tsx`; delete `publish-panel.tsx`.
- Modify `app/providers/[id]/package-purchases/[purchaseId]/checkout/actions.ts` — vitrin dönüşü.
- Modify `app/showcase-shelf.tsx`, `app/vitrin/[cardId]/page.tsx`, `app/globals.css`.
- Tests: `test/panel-routes.spec.ts` (mevcut, rota listesi), Create `test/showcase-legacy-routes.spec.ts`.

**Admin (`apps/admin/`)**
- Modify `lib/nav.ts`, `lib/api.ts`, `app/showcase/packages/page.tsx`, `packages/actions.ts`, `app/showcase/reviews/[versionId]/page.tsx`, `reviews/[versionId]/actions.ts`, `app/showcase/price-terms/page.tsx`.

**E2E (`e2e/tests/`)**
- Create `showcase-package-first-flow.spec.ts`, `showcase-screens-viewport.spec.ts`.
- Modify `showcase-cards.spec.ts`, `showcase-placement-lead.spec.ts`.

---

### Task 1: Prisma şeması ve additive migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260911120000_add_showcase_entitlements/migration.sql`
- Test: `apps/api/test/showcase-entitlement-lifecycle.spec.ts` (yalnız şema testi bu adımda)

**Interfaces:**
- Produces: Prisma modelleri `ShowcaseEntitlement`, `ShowcaseEntitlementReviewPause`, `ShowcasePackageTermsAcceptance`; enum'lar `ShowcaseEntitlementStatus`, `ShowcaseEntitlementPauseEnd`; kolonlar `ShowcasePackage.activationWindowDays`, `PackagePurchase.showcasePackageTermsAcceptanceId`.

- [x] **Step 1: Şemaya enum'ları ve kolonları ekle**

`prisma/schema.prisma` içinde `enum ShowcaseLeadCloseReason { … }` bloğundan hemen sonra ekle:

```prisma
/// Where a purchased vitrin publication right stands.
///
/// AVAILABLE — paid for, bound to no card yet. Usable while `expiresAt > now`.
/// RESERVED  — bound to exactly one card that has not been published yet.
///             Usable while `expiresAt > now` OR the card is under review
///             (`reviewPausedAt IS NOT NULL`): review time is the operator's,
///             and it must never cost the provider their right.
/// CONSUMED  — the card was approved and its placement was born. Terminal.
/// EXPIRED   — the activation window closed before the card went live.
///             Written by the sweeper as a query optimisation; every reader
///             checks the window itself, exactly as placements do.
enum ShowcaseEntitlementStatus {
  AVAILABLE
  RESERVED
  CONSUMED
  EXPIRED
}

/// How one review pause on a right ended. Copied onto the pause row so the
/// history of a right is readable without replaying the card's reviews.
enum ShowcaseEntitlementPauseEnd {
  REJECTED
  WITHDRAWN
  RELEASED
  CONSUMED
}
```

`model ShowcasePackage` içinde `requiresAdminApproval` satırından sonra ekle:

```prisma
  /// How many days after payment an unused right stays claimable. The right is
  /// consumed when the card is first approved; until then this is the clock —
  /// paused while the card is under review, because that time is the
  /// operator's, not the provider's. Snapshotted onto the entitlement as
  /// `expiresAt`, so reshaping the package cannot shorten a right already sold.
  activationWindowDays  Int               @default(90)
```

`model ShowcasePackage` ilişkilerine ekle: `entitlements ShowcaseEntitlement[]`.

`model PackagePurchase` içinde `showcasePriceTermsAcceptanceId String?` satırından sonra ekle:

```prisma
  /// The provider-level acceptance a package-first vitrin purchase was opened
  /// against. Exactly one of this and `showcasePriceTermsAcceptanceId` is set on
  /// a SHOWCASE_PACKAGE row — the legacy card-bound shape or the package-first
  /// one — and the CHECK `PackagePurchase_showcase_card_matches_kind` says so.
  showcasePackageTermsAcceptanceId String?
```

ve ilişkilerine:

```prisma
  showcasePackageTermsAcceptance ShowcasePackageTermsAcceptance? @relation(fields: [showcasePackageTermsAcceptanceId], references: [id], onDelete: Restrict)
  /// The publication right this purchase produced, when it was package-first.
  showcaseEntitlement          ShowcaseEntitlement?
```

ve index: `@@index([showcasePackageTermsAcceptanceId])`.

Back-relation'lar: `model ProviderProfile` içine `showcasePackageTermsAcceptances ShowcasePackageTermsAcceptance[]` ve `showcaseEntitlements ShowcaseEntitlement[]`; `model User` içine `showcasePackageTermsAcceptances ShowcasePackageTermsAcceptance[]`; `model ShowcaseCard` içine `entitlements ShowcaseEntitlement[]`; `model ShowcasePlacement` içine `entitlement ShowcaseEntitlement?`; `model ShowcaseCardVersion` içine `entitlementPauses ShowcaseEntitlementReviewPause[]`.

- [x] **Step 2: Yeni modelleri ekle**

`model ShowcaseCardPriceTermsAcceptance` bloğundan hemen sonra:

```prisma
/// One provider accepting one version of the price-responsibility text, for
/// the package-first flow. Append-only, no `updatedAt`.
///
/// Provider-level rather than card-level, because in this flow there is no card
/// yet when the money moves. `UNIQUE(providerId, termsVersion)` means a
/// provider is asked once per version and never twice — and that a second
/// concurrent acceptance cannot produce a second row. A bump of
/// `SHOWCASE_PRICE_TERMS_VERSION` means no row names the new version, so the
/// next purchase asks again.
model ShowcasePackageTermsAcceptance {
  id                String   @id @default(cuid())
  providerId        String
  termsVersion      String
  termsTextSnapshot String
  acceptedByUserId  String
  acceptedAt        DateTime @default(now())

  provider       ProviderProfile @relation(fields: [providerId], references: [id])
  acceptedByUser User            @relation("ShowcasePackageTermsAcceptedBy", fields: [acceptedByUserId], references: [id], onDelete: Restrict)
  purchases      PackagePurchase[]

  @@unique([providerId, termsVersion])
  @@index([termsVersion, acceptedAt])
}

/// One paid, not-yet-used right to publish one vitrin card.
///
/// Sits between the payment and the placement: settlement grants it, creating a
/// card reserves it, the operator's first approval consumes it and births the
/// placement in the same transaction. A card cannot be "approved but
/// unpublishable" because approval refuses without a valid reserved right.
///
/// What was sold is snapshotted here (package name, duration, price, terms) and
/// copied onto the placement at consumption; the catalogue is never re-read.
model ShowcaseEntitlement {
  id                String                    @id @default(cuid())
  providerId        String
  /// One settled payment, one right. Unique: a redelivered settlement cannot
  /// grant twice.
  purchaseId        String                    @unique
  showcasePackageId String

  packageNameSnapshot       String
  durationDaysSnapshot      Int
  priceAmountSnapshot       Int
  currencySnapshot          String            @default("TRY")
  allowedCardKindSnapshot   ShowcaseCardKind?
  maxAreasSnapshot          Int?
  priceTermsVersionSnapshot String
  priceTermsTextSnapshot    String

  status    ShowcaseEntitlementStatus @default(AVAILABLE)
  grantedAt DateTime
  /// `grantedAt + activationWindowDays`, moved forward by exactly the time the
  /// card spent under review (see ShowcaseEntitlementReviewPause).
  expiresAt DateTime

  cardId      String?
  reservedAt  DateTime?
  consumedAt  DateTime?
  placementId String?   @unique
  /// Non-NULL while the reserved card is with an operator: the clock is stopped.
  reviewPausedAt     DateTime?
  /// Sum of every closed review pause, in whole seconds. Seconds rather than
  /// milliseconds because a 90-day window in milliseconds does not fit an Int.
  totalPausedSeconds Int       @default(0)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  provider  ProviderProfile    @relation(fields: [providerId], references: [id])
  purchase  PackagePurchase    @relation(fields: [purchaseId], references: [id], onDelete: Restrict)
  package   ShowcasePackage    @relation(fields: [showcasePackageId], references: [id], onDelete: Restrict)
  card      ShowcaseCard?      @relation(fields: [cardId], references: [id], onDelete: Restrict)
  placement ShowcasePlacement? @relation(fields: [placementId], references: [id], onDelete: Restrict)
  reviewPauses ShowcaseEntitlementReviewPause[]

  // A partial unique index — "ShowcaseEntitlement_one_reserved_per_card",
  // UNIQUE ("cardId") WHERE status = 'RESERVED' — is created by the migration:
  // one card can hold one reserved right at a time.

  @@index([providerId, status, expiresAt])
  @@index([cardId])
}

/// One interval a reserved right spent with its card under review, and what
/// happened to the right's clock because of it. Append-only, closed once.
///
/// The activation window is the provider's obligation to *submit*; the time an
/// operator takes to decide is not billed to them. So the clock stops when the
/// card enters review and `expiresAt` is pushed forward by the interval when it
/// leaves. `expiresAtBefore/After` record the move, exactly as
/// ShowcasePlacementSuspension records `endAtBefore/After`.
model ShowcaseEntitlementReviewPause {
  id             String                       @id @default(cuid())
  entitlementId  String
  cardVersionId  String
  startedAt      DateTime                     @default(now())
  endedAt        DateTime?
  expiresAtBefore DateTime
  expiresAtAfter  DateTime?
  endReason      ShowcaseEntitlementPauseEnd?
  createdAt      DateTime                     @default(now())

  entitlement ShowcaseEntitlement @relation(fields: [entitlementId], references: [id], onDelete: Restrict)
  version     ShowcaseCardVersion @relation(fields: [cardVersionId], references: [id], onDelete: Restrict)

  // A partial unique index — "ShowcaseEntitlementReviewPause_one_open",
  // UNIQUE ("entitlementId") WHERE "endedAt" IS NULL — is created by the
  // migration: one right is paused for one reason at a time.

  @@index([entitlementId, startedAt])
}
```

- [x] **Step 3: Migration SQL'ini yaz**

`prisma/migrations/20260911120000_add_showcase_entitlements/migration.sql`:

```sql
-- VIT-DESIGN-002: the package is bought first; the right it grants is spent at
-- the card's first approval.
--
-- ────────────────────────────────────────────────────────────────────────────
-- Data effect on rows that already exist: none.
-- ────────────────────────────────────────────────────────────────────────────
-- No row of any table is read, updated or deleted by this file. Every change
-- is a new column with a default, a new nullable column, a new table, a new
-- index, or a CHECK that every existing row already satisfies:
--   * ShowcasePackage.activationWindowDays gets 90 on every existing package.
--   * PackagePurchase.showcasePackageTermsAcceptanceId is NULL everywhere, so
--     every OFFER_PACKAGE row satisfies the first branch of the rewritten CHECK
--     and every existing SHOWCASE_PACKAGE row (card-bound by construction)
--     satisfies the legacy branch.

-- CreateEnum
CREATE TYPE "ShowcaseEntitlementStatus" AS ENUM ('AVAILABLE', 'RESERVED', 'CONSUMED', 'EXPIRED');
CREATE TYPE "ShowcaseEntitlementPauseEnd" AS ENUM ('REJECTED', 'WITHDRAWN', 'RELEASED', 'CONSUMED');

-- AlterTable: the activation window. A default rather than a backfill, so the
-- statement is catalogue-only and no package row is rewritten.
ALTER TABLE "ShowcasePackage"
  ADD COLUMN "activationWindowDays" INTEGER NOT NULL DEFAULT 90;

ALTER TABLE "ShowcasePackage"
  ADD CONSTRAINT "ShowcasePackage_activation_window_positive"
    CHECK ("activationWindowDays" > 0);

-- CreateTable: provider-level acceptance for the package-first sale.
CREATE TABLE "ShowcasePackageTermsAcceptance" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "termsVersion" TEXT NOT NULL,
    "termsTextSnapshot" TEXT NOT NULL,
    "acceptedByUserId" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShowcasePackageTermsAcceptance_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ShowcasePackageTermsAcceptance"
  ADD CONSTRAINT "ShowcasePackageTermsAcceptance_version_not_blank"
    CHECK (btrim("termsVersion") <> ''),
  ADD CONSTRAINT "ShowcasePackageTermsAcceptance_text_not_blank"
    CHECK (btrim("termsTextSnapshot") <> '');

CREATE UNIQUE INDEX "ShowcasePackageTermsAcceptance_providerId_termsVersion_key"
  ON "ShowcasePackageTermsAcceptance"("providerId", "termsVersion");
CREATE INDEX "ShowcasePackageTermsAcceptance_termsVersion_acceptedAt_idx"
  ON "ShowcasePackageTermsAcceptance"("termsVersion", "acceptedAt");

ALTER TABLE "ShowcasePackageTermsAcceptance" ADD CONSTRAINT "ShowcasePackageTermsAcceptance_providerId_fkey"
  FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShowcasePackageTermsAcceptance" ADD CONSTRAINT "ShowcasePackageTermsAcceptance_acceptedByUserId_fkey"
  FOREIGN KEY ("acceptedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable: the purchase names which acceptance it was opened against.
ALTER TABLE "PackagePurchase"
  ADD COLUMN "showcasePackageTermsAcceptanceId" TEXT;

ALTER TABLE "PackagePurchase" ADD CONSTRAINT "PackagePurchase_showcasePackageTermsAcceptanceId_fkey"
  FOREIGN KEY ("showcasePackageTermsAcceptanceId") REFERENCES "ShowcasePackageTermsAcceptance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "PackagePurchase_showcasePackageTermsAcceptanceId_idx"
  ON "PackagePurchase"("showcasePackageTermsAcceptanceId");

-- The discriminator CHECK, rewritten so a SHOWCASE_PACKAGE row is either the
-- legacy card-bound shape or the package-first shape — never a mixture, never
-- neither. Dropped and recreated so exactly one constraint answers the question.
ALTER TABLE "PackagePurchase"
  DROP CONSTRAINT "PackagePurchase_showcase_card_matches_kind";

ALTER TABLE "PackagePurchase"
  ADD CONSTRAINT "PackagePurchase_showcase_card_matches_kind" CHECK (
    ("kind" = 'OFFER_PACKAGE'
       AND "showcaseCardId" IS NULL
       AND "showcaseCardVersionId" IS NULL
       AND "durationDaysSnapshot" IS NULL
       AND "showcasePriceTermsAcceptanceId" IS NULL
       AND "showcasePackageTermsAcceptanceId" IS NULL)
    OR
    ("kind" = 'SHOWCASE_PACKAGE'
       AND "durationDaysSnapshot" IS NOT NULL
       AND (
         -- legacy, card-bound purchase: history only, nothing writes it any more
         ("showcaseCardId" IS NOT NULL
            AND "showcaseCardVersionId" IS NOT NULL
            AND "showcasePriceTermsAcceptanceId" IS NOT NULL
            AND "showcasePackageTermsAcceptanceId" IS NULL)
         OR
         -- package-first purchase
         ("showcaseCardId" IS NULL
            AND "showcaseCardVersionId" IS NULL
            AND "showcasePriceTermsAcceptanceId" IS NULL
            AND "showcasePackageTermsAcceptanceId" IS NOT NULL)
       ))
  );

-- CreateTable: the right itself.
CREATE TABLE "ShowcaseEntitlement" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "showcasePackageId" TEXT NOT NULL,
    "packageNameSnapshot" TEXT NOT NULL,
    "durationDaysSnapshot" INTEGER NOT NULL,
    "priceAmountSnapshot" INTEGER NOT NULL,
    "currencySnapshot" TEXT NOT NULL DEFAULT 'TRY',
    "allowedCardKindSnapshot" "ShowcaseCardKind",
    "maxAreasSnapshot" INTEGER,
    "priceTermsVersionSnapshot" TEXT NOT NULL,
    "priceTermsTextSnapshot" TEXT NOT NULL,
    "status" "ShowcaseEntitlementStatus" NOT NULL DEFAULT 'AVAILABLE',
    "grantedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "cardId" TEXT,
    "reservedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "placementId" TEXT,
    "reviewPausedAt" TIMESTAMP(3),
    "totalPausedSeconds" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShowcaseEntitlement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShowcaseEntitlement_purchaseId_key" ON "ShowcaseEntitlement"("purchaseId");
CREATE UNIQUE INDEX "ShowcaseEntitlement_placementId_key" ON "ShowcaseEntitlement"("placementId");
CREATE INDEX "ShowcaseEntitlement_providerId_status_expiresAt_idx"
  ON "ShowcaseEntitlement"("providerId", "status", "expiresAt");
CREATE INDEX "ShowcaseEntitlement_cardId_idx" ON "ShowcaseEntitlement"("cardId");

-- One card, one reserved right at a time. The reservation itself is a
-- conditional update on status = AVAILABLE, so two cards racing for one right
-- are refused by the row; this index refuses two rights racing for one card.
CREATE UNIQUE INDEX "ShowcaseEntitlement_one_reserved_per_card"
  ON "ShowcaseEntitlement"("cardId") WHERE "status" = 'RESERVED';

ALTER TABLE "ShowcaseEntitlement"
  ADD CONSTRAINT "ShowcaseEntitlement_window_positive" CHECK ("expiresAt" > "grantedAt"),
  ADD CONSTRAINT "ShowcaseEntitlement_status_shape" CHECK (
    ("status" = 'AVAILABLE' AND "cardId" IS NULL AND "reservedAt" IS NULL
       AND "consumedAt" IS NULL AND "placementId" IS NULL AND "reviewPausedAt" IS NULL)
    OR
    ("status" = 'RESERVED' AND "cardId" IS NOT NULL AND "reservedAt" IS NOT NULL
       AND "consumedAt" IS NULL AND "placementId" IS NULL)
    OR
    ("status" = 'CONSUMED' AND "cardId" IS NOT NULL AND "reservedAt" IS NOT NULL
       AND "consumedAt" IS NOT NULL AND "placementId" IS NOT NULL AND "reviewPausedAt" IS NULL)
    OR
    ("status" = 'EXPIRED' AND "consumedAt" IS NULL AND "placementId" IS NULL
       AND "reviewPausedAt" IS NULL)
  );

ALTER TABLE "ShowcaseEntitlement" ADD CONSTRAINT "ShowcaseEntitlement_providerId_fkey"
  FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShowcaseEntitlement" ADD CONSTRAINT "ShowcaseEntitlement_purchaseId_fkey"
  FOREIGN KEY ("purchaseId") REFERENCES "PackagePurchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShowcaseEntitlement" ADD CONSTRAINT "ShowcaseEntitlement_showcasePackageId_fkey"
  FOREIGN KEY ("showcasePackageId") REFERENCES "ShowcasePackage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShowcaseEntitlement" ADD CONSTRAINT "ShowcaseEntitlement_cardId_fkey"
  FOREIGN KEY ("cardId") REFERENCES "ShowcaseCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShowcaseEntitlement" ADD CONSTRAINT "ShowcaseEntitlement_placementId_fkey"
  FOREIGN KEY ("placementId") REFERENCES "ShowcasePlacement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: the audit of every review pause.
CREATE TABLE "ShowcaseEntitlementReviewPause" (
    "id" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "cardVersionId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "expiresAtBefore" TIMESTAMP(3) NOT NULL,
    "expiresAtAfter" TIMESTAMP(3),
    "endReason" "ShowcaseEntitlementPauseEnd",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShowcaseEntitlementReviewPause_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ShowcaseEntitlementReviewPause_entitlementId_startedAt_idx"
  ON "ShowcaseEntitlementReviewPause"("entitlementId", "startedAt");
CREATE UNIQUE INDEX "ShowcaseEntitlementReviewPause_one_open"
  ON "ShowcaseEntitlementReviewPause"("entitlementId") WHERE "endedAt" IS NULL;

-- Open and closed are the two shapes, and nothing in between.
ALTER TABLE "ShowcaseEntitlementReviewPause"
  ADD CONSTRAINT "ShowcaseEntitlementReviewPause_closed_shape" CHECK (
    ("endedAt" IS NULL AND "expiresAtAfter" IS NULL AND "endReason" IS NULL)
    OR
    ("endedAt" IS NOT NULL AND "expiresAtAfter" IS NOT NULL AND "endReason" IS NOT NULL
       AND "endedAt" >= "startedAt" AND "expiresAtAfter" >= "expiresAtBefore")
  );

ALTER TABLE "ShowcaseEntitlementReviewPause" ADD CONSTRAINT "ShowcaseEntitlementReviewPause_entitlementId_fkey"
  FOREIGN KEY ("entitlementId") REFERENCES "ShowcaseEntitlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShowcaseEntitlementReviewPause" ADD CONSTRAINT "ShowcaseEntitlementReviewPause_cardVersionId_fkey"
  FOREIGN KEY ("cardVersionId") REFERENCES "ShowcaseCardVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
```

- [x] **Step 4: Prisma client'ı üret ve şemayı doğrula**

Run: `pnpm db:generate && pnpm exec prisma validate`
Expected: `Generated Prisma Client` ve `The schema … is valid`. Hata olursa ilişki adlarını (`ShowcasePackageTermsAcceptedBy`) ve back-relation eksiklerini düzelt.

- [x] **Step 5: Migration'ın test DB'de uygulandığını kanıtlayan ilk spec'i yaz**

`apps/api/test/showcase-entitlement-lifecycle.spec.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, resetDatabase, type TestContext } from './harness';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
});

describe('schema', () => {
  it('applies the entitlement migration: the tables exist and the package default is 90 days', async () => {
    const rows = await ctx.prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name IN ('ShowcaseEntitlement', 'ShowcaseEntitlementReviewPause', 'ShowcasePackageTermsAcceptance')
      ORDER BY table_name`;
    expect(rows.map((row) => row.table_name)).toEqual([
      'ShowcaseEntitlement',
      'ShowcaseEntitlementReviewPause',
      'ShowcasePackageTermsAcceptance',
    ]);

    const pkg = await ctx.prisma.showcasePackage.create({
      data: { name: 'P', slug: 'vitrin-schema-test', priceAmount: 100, durationDays: 30 },
    });
    expect(pkg.activationWindowDays).toBe(90);
  });
});
```

- [x] **Step 6: Spec'i çalıştır**

Run: `DATABASE_URL='postgresql://taktic_user:taktic_password@localhost:5433/taktic?schema=public' pnpm --filter @taktic/api test -- showcase-entitlement-lifecycle`
Expected: PASS (test DB provisioning `migrate deploy` ile yeni migration'ı uygular).

- [x] **Step 7: Migration dry-run'ı izole kopya DB'de yap ve kanıtı sakla**

Scratchpad'e `dryrun.sh` yaz ve çalıştır (aktif DB yalnız `pg_dump` ile **okunur**):

```bash
set -euo pipefail
DB=taktic_vitdesign002_dryrun
docker exec taktic-postgres psql -U taktic_user -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"
docker exec taktic-postgres sh -c "pg_dump -U taktic_user -d taktic | psql -q -U taktic_user -d $DB"
SNAP='SELECT (SELECT count(*) FROM "ShowcaseCard") cards,(SELECT count(*) FROM "ShowcaseCardVersion") versions,(SELECT count(*) FROM "PackagePurchase") purchases,(SELECT count(*) FROM "ShowcasePlacement") placements,(SELECT count(*) FROM "ShowcasePackage") packages,(SELECT count(*) FROM "ProviderCreditTransaction") credits,(SELECT count(*) FROM "ServiceRequest") requests,(SELECT count(*) FROM "Offer") offers,(SELECT count(*) FROM "User") users;'
HASH='SELECT md5(string_agg(t::text, E'"'"'\n'"'"' ORDER BY t.id)) FROM (SELECT id,"providerId",kind,"packageId","showcasePackageId","showcaseCardId","showcaseCardVersionId","durationDaysSnapshot","showcasePriceTermsAcceptanceId",status,"creditAmountSnapshot","priceAmountSnapshot","packageNameSnapshot","paidAt","failedAt" FROM "PackagePurchase") t;'
echo "== before"; docker exec taktic-postgres psql -U taktic_user -d $DB -Atc "$SNAP" -c "$HASH" -c 'SELECT md5(string_agg(t::text, E'"'"'\n'"'"' ORDER BY t.id)) FROM (SELECT id,"providerId",kind,"categoryId",status,"liveVersionId","draftVersionId" FROM "ShowcaseCard") t;'
DATABASE_URL="postgresql://taktic_user:taktic_password@localhost:5433/$DB?schema=public" pnpm exec prisma migrate deploy
echo "== after"; docker exec taktic-postgres psql -U taktic_user -d $DB -Atc "$SNAP" -c "$HASH" -c 'SELECT md5(string_agg(t::text, E'"'"'\n'"'"' ORDER BY t.id)) FROM (SELECT id,"providerId",kind,"categoryId",status,"liveVersionId","draftVersionId" FROM "ShowcaseCard") t;' -c 'SELECT name,"activationWindowDays" FROM "ShowcasePackage";' -c 'SELECT count(*) FROM "ShowcaseEntitlement";'
```

Expected: `before` ve `after` satır sayıları ve iki md5 birebir aynı; migrate çıktısında yalnız `20260911120000_add_showcase_entitlements` uygulanır; paket satırı `activationWindowDays=90`; entitlement sayısı 0. Çıktıyı `docs/superpowers/plans/2026-09-11-vitrin-migration-dryrun.txt` olarak kaydet (teslim raporu kanıtı).

- [x] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260911120000_add_showcase_entitlements apps/api/test/showcase-entitlement-lifecycle.spec.ts docs/superpowers/plans/2026-09-11-vitrin-migration-dryrun.txt
git commit -m "feat(showcase): yayın hakkı, paket şart kabulü ve inceleme duraklaması şeması

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Hata kodları, preflight yardımcıları ve `ShowcaseEntitlementService`

**Files:**
- Modify: `apps/api/src/modules/showcase/showcase.errors.ts`
- Create: `apps/api/src/modules/showcase/showcase-publish-preflight.ts`
- Modify: `apps/api/src/modules/showcase/showcase-placement.service.ts`
- Create: `apps/api/src/modules/showcase/showcase-entitlement.service.ts`
- Modify: `apps/api/src/modules/showcase/showcase-lifecycle.module.ts` (provider kaydı)
- Test: `apps/api/test/showcase-entitlement-lifecycle.spec.ts`

**Interfaces:**
- Produces:
  - `showcaseEntitlementRequired()`, `showcaseEntitlementUnavailable()`, `showcaseEntitlementMissing()`, `showcaseEntitlementKindMismatch()`, `showcaseRevisionNeedsPublication()` (409 Conflict, kodlar `SHOWCASE_ENTITLEMENT_REQUIRED`, `SHOWCASE_ENTITLEMENT_UNAVAILABLE`, `SHOWCASE_ENTITLEMENT_MISSING`, `SHOWCASE_ENTITLEMENT_KIND_MISMATCH`, `SHOWCASE_REVISION_NEEDS_PUBLICATION`).
  - `assertCategoryStillOpen(category, cardKind)`, `assertVersionAreasCovered(db, providerId, versionId)` in `showcase-publish-preflight.ts`.
  - `ShowcasePlacementService.createForEntitlement(tx, input: { entitlement: EntitlementSnapshot; cardId; providerId; categoryId; kind; versionId; startAt }): Promise<{ placementId }>`.
  - `ShowcaseEntitlementService` metodları: `grantForPurchase(tx, purchase, paidAt)`, `reserveForCard(tx, input)`, `releaseForCard(tx, cardId, now)`, `pauseForReview(tx, cardId, cardVersionId, now)`, `resumeAfterReview(tx, cardId, endReason, now)`, `consumeForCard(tx, input)`, `findReservedForCard(db, cardId, now)`, `listForProvider(providerId, now)`, `expireStale(now, limit)`; predicate'ler `usableEntitlementWhere(now)`, `reservedEntitlementWhere(cardId, now)`.

- [x] **Step 1: Hata kodlarını ekle**

`showcase.errors.ts` sonuna:

```ts
export const SHOWCASE_ENTITLEMENT_REQUIRED_CODE = 'SHOWCASE_ENTITLEMENT_REQUIRED';
export const SHOWCASE_ENTITLEMENT_UNAVAILABLE_CODE = 'SHOWCASE_ENTITLEMENT_UNAVAILABLE';
export const SHOWCASE_ENTITLEMENT_MISSING_CODE = 'SHOWCASE_ENTITLEMENT_MISSING';
export const SHOWCASE_ENTITLEMENT_KIND_MISMATCH_CODE = 'SHOWCASE_ENTITLEMENT_KIND_MISMATCH';
export const SHOWCASE_REVISION_NEEDS_PUBLICATION_CODE = 'SHOWCASE_REVISION_NEEDS_PUBLICATION';

/** The provider has no usable right: a card cannot be opened or submitted without one. */
export function showcaseEntitlementRequired() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: SHOWCASE_ENTITLEMENT_REQUIRED_CODE,
    message: 'Vitrin kartı oluşturmak için kullanılabilir bir vitrin hakkınız olmalı. Önce vitrin paketi alın.',
  });
}

/** The named right was taken by another card (or expired) between the read and the write. */
export function showcaseEntitlementUnavailable() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: SHOWCASE_ENTITLEMENT_UNAVAILABLE_CODE,
    message: 'Bu vitrin hakkı artık kullanılabilir değil. Listeyi yenileyip tekrar deneyin.',
  });
}

/** An operator tried to approve a first version whose card holds no valid reserved right. */
export function showcaseEntitlementMissing() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: SHOWCASE_ENTITLEMENT_MISSING_CODE,
    message:
      'Bu kartın geçerli bir yayın hakkı yok. Sağlayıcı vitrin paketi almadan kart onaylanıp yayına alınamaz.',
  });
}

/** The chosen right was sold for a different card kind. */
export function showcaseEntitlementKindMismatch() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: SHOWCASE_ENTITLEMENT_KIND_MISMATCH_CODE,
    message: 'Seçtiğiniz vitrin hakkı bu kart türü için kullanılamaz.',
  });
}

/**
 * A card with a live version but no run behind it (a legacy approval) tried to
 * submit a revision. There is no terms snapshot to carry, so the card must be
 * published with a right first.
 */
export function showcaseRevisionNeedsPublication() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: SHOWCASE_REVISION_NEEDS_PUBLICATION_CODE,
    message: 'Bu kartı düzenlemeden önce bir vitrin hakkıyla yayına almanız gerekir.',
  });
}
```

- [x] **Step 2: Preflight yardımcılarını ayrı dosyaya taşı**

`apps/api/src/modules/showcase/showcase-publish-preflight.ts`:

```ts
import { Prisma, ServiceCategoryKind, ShowcaseCardKind } from '@prisma/client';
import { areaCovers, describeArea } from '../../common/provider-service-area-scope';
import {
  canReceiveRequests,
  isActiveFor,
  type CategoryTaxonomyFacts,
} from '../categories/category-taxonomy';
import { showcaseAreaNotCovered, showcaseCategoryNotOffered } from './showcase.errors';

/**
 * The two checks that have to hold at the moment a card goes on the air, shared
 * by the operator's approval and the provider's "publish an approved card"
 * action. They used to live in the card-bound checkout; the moment of truth is
 * now the moment the placement is born, not the moment money moves.
 */
export function assertCategoryStillOpen(
  category: CategoryTaxonomyFacts,
  cardKind: ShowcaseCardKind,
) {
  if (cardKind === ShowcaseCardKind.PROMOTION && category.kind === ServiceCategoryKind.GROUP) {
    if (!isActiveFor(category.status)) {
      throw showcaseCategoryNotOffered();
    }
    return;
  }

  if (!canReceiveRequests(category, false)) {
    throw showcaseCategoryNotOffered();
  }
}

/** Every area the version claims must still sit inside the provider's own coverage. */
export async function assertVersionAreasCovered(
  db: Prisma.TransactionClient,
  providerId: string,
  versionId: string,
) {
  const [coverage, areas] = await Promise.all([
    db.providerServiceArea.findMany({
      where: { providerId },
      select: { city: true, district: true, neighborhood: true },
    }),
    db.showcaseCardVersionArea.findMany({
      where: { cardVersionId: versionId },
      select: { city: true, district: true, neighborhood: true },
    }),
  ]);

  for (const area of areas) {
    if (!coverage.some((owned) => areaCovers(owned, area))) {
      throw showcaseAreaNotCovered(describeArea(area));
    }
  }
}
```

- [x] **Step 3: `createForEntitlement`'ı placement servisine ekle**

`showcase-placement.service.ts` içinde `createForPurchase`'ın hemen altına:

```ts
  /**
   * Turns a reserved right into a live run, in the caller's transaction.
   *
   * The package-first twin of {@link createForPurchase}: snapshots come from
   * the entitlement rather than from the purchase and the acceptance, and the
   * run starts at the moment of approval rather than at the moment of payment
   * — the provider paid for days on the air, and days spent writing the card
   * and waiting for an operator are not on the air.
   */
  async createForEntitlement(
    tx: Prisma.TransactionClient,
    input: {
      entitlement: EntitlementSnapshot;
      providerId: string;
      cardId: string;
      categoryId: string;
      kind: ShowcaseCardKind;
      versionId: string;
      startAt: Date;
    },
  ): Promise<{ placementId: string }> {
    const endAt = showcasePlacementEndAt(input.startAt, input.entitlement.durationDaysSnapshot);

    const placement = await tx.showcasePlacement.create({
      data: {
        purchaseId: input.entitlement.purchaseId,
        providerId: input.providerId,
        showcasePackageId: input.entitlement.showcasePackageId,
        cardId: input.cardId,
        pinnedVersionId: input.versionId,
        categoryId: input.categoryId,
        kindSnapshot: input.kind,
        packageNameSnapshot: input.entitlement.packageNameSnapshot,
        priceAmountSnapshot: input.entitlement.priceAmountSnapshot,
        currencySnapshot: input.entitlement.currencySnapshot,
        durationDaysSnapshot: input.entitlement.durationDaysSnapshot,
        priceTermsVersionSnapshot: input.entitlement.priceTermsVersionSnapshot,
        priceTermsTextSnapshot: input.entitlement.priceTermsTextSnapshot,
        startAt: input.startAt,
        endAt,
        status: ShowcasePlacementStatus.PENDING_ACTIVATION,
      },
      select: { id: true },
    });

    await this.writeShelves(tx, {
      placementId: placement.id,
      providerId: input.providerId,
      categoryId: input.categoryId,
      versionId: input.versionId,
      maxAreas: input.entitlement.maxAreasSnapshot,
      endAt,
      active: true,
    });

    await tx.showcasePlacement.update({
      where: { id: placement.id },
      data: { status: ShowcasePlacementStatus.ACTIVE },
    });

    return { placementId: placement.id };
  }
```

Dosya sonuna tip:

```ts
/** What a placement needs from the right it is born from. */
export type EntitlementSnapshot = {
  purchaseId: string;
  showcasePackageId: string;
  packageNameSnapshot: string;
  durationDaysSnapshot: number;
  priceAmountSnapshot: number;
  currencySnapshot: string;
  maxAreasSnapshot: number | null;
  priceTermsVersionSnapshot: string;
  priceTermsTextSnapshot: string;
};
```

- [x] **Step 4: Failing test — grant, reserve, race, release, pause, consume**

`showcase-entitlement-lifecycle.spec.ts` içine (`schema` describe'ının altına) ekle. Yardımcılar dosya üstünde:

```ts
import { ShowcaseEntitlementService } from '../src/modules/showcase/showcase-entitlement.service';
import { ShowcasePlacementService } from '../src/modules/showcase/showcase-placement.service';
import {
  createCategory, createDiscoverableProvider, createShowcasePackage, createUser,
} from './harness';
import { ServiceCategoryKind, UserRole } from '@prisma/client';

const DAY = 24 * 60 * 60 * 1000;

async function paidPackagePurchase(providerId: string, userId: string, pkgId: string) {
  const acceptance = await ctx.prisma.showcasePackageTermsAcceptance.create({
    data: { providerId, termsVersion: 'v1', termsTextSnapshot: 'Şartlar', acceptedByUserId: userId },
  });
  const pkg = await ctx.prisma.showcasePackage.findUniqueOrThrow({ where: { id: pkgId } });
  return ctx.prisma.packagePurchase.create({
    data: {
      providerId, kind: 'SHOWCASE_PACKAGE', showcasePackageId: pkg.id,
      durationDaysSnapshot: pkg.durationDays, creditAmountSnapshot: 0,
      priceAmountSnapshot: pkg.priceAmount, currencySnapshot: pkg.currency,
      packageNameSnapshot: pkg.name, showcasePackageTermsAcceptanceId: acceptance.id,
      status: 'PAID', paidAt: new Date(), paymentProvider: 'mock',
    },
  });
}

async function scenario() {
  const category = await createCategory(ctx.prisma, 'Klima', { kind: ServiceCategoryKind.LEAF });
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const profile = await createDiscoverableProvider(ctx.prisma, {
    userId: user.id, categoryId: category.id, areas: [{ city: 'İstanbul', district: null }],
  });
  const pkg = await createShowcasePackage(ctx.prisma, { durationDays: 30 });
  const service = ctx.app.get(ShowcaseEntitlementService);
  return { category, user, profile, pkg, service };
}

async function draftCard(providerId: string, categoryId: string) {
  const card = await ctx.prisma.showcaseCard.create({
    data: { providerId, kind: 'SERVICE', categoryId, status: 'DRAFT' },
  });
  const version = await ctx.prisma.showcaseCardVersion.create({
    data: {
      cardId: card.id, versionNumber: 1, kindSnapshot: 'SERVICE', title: 'T', summary: 'S',
      scopeIncluded: ['a'], scopeExcluded: ['b'], listedServicePriceAmount: 1000,
      reviewStatus: 'DRAFT',
      areas: { create: [{ scope: 'DISTRICT', city: 'İstanbul', district: 'Kadıköy', neighborhood: null, areaKey: 'istanbul|kadikoy|' }] },
    },
  });
  await ctx.prisma.showcaseCard.update({ where: { id: card.id }, data: { draftVersionId: version.id } });
  return { card, version };
}
```

Testler:

```ts
describe('granting', () => {
  it('grants one AVAILABLE right per settled purchase, expiring after the package window', async () => {
    const { user, profile, pkg, service } = await scenario();
    const purchase = await paidPackagePurchase(profile.id, user.id, pkg.id);
    const paidAt = new Date('2026-09-11T10:00:00Z');

    await ctx.prisma.$transaction((tx) => service.grantForPurchase(tx, purchase, paidAt));

    const right = await ctx.prisma.showcaseEntitlement.findUniqueOrThrow({ where: { purchaseId: purchase.id } });
    expect(right.status).toBe('AVAILABLE');
    expect(right.durationDaysSnapshot).toBe(30);
    expect(right.priceTermsVersionSnapshot).toBe('v1');
    expect(right.expiresAt.getTime() - paidAt.getTime()).toBe(90 * DAY);
  });

  it('cannot grant twice for one purchase', async () => {
    const { user, profile, pkg, service } = await scenario();
    const purchase = await paidPackagePurchase(profile.id, user.id, pkg.id);
    await ctx.prisma.$transaction((tx) => service.grantForPurchase(tx, purchase, new Date()));

    await expect(
      ctx.prisma.$transaction((tx) => service.grantForPurchase(tx, purchase, new Date())),
    ).rejects.toThrow();
    expect(await ctx.prisma.showcaseEntitlement.count()).toBe(1);
  });
});

describe('reserving', () => {
  it('reserves the earliest-expiring usable right and refuses a second card for it', async () => {
    const { user, profile, pkg, category, service } = await scenario();
    const purchase = await paidPackagePurchase(profile.id, user.id, pkg.id);
    await ctx.prisma.$transaction((tx) => service.grantForPurchase(tx, purchase, new Date()));
    const a = await draftCard(profile.id, category.id);
    const b = await draftCard(profile.id, category.id);

    const outcomes = await Promise.allSettled([
      ctx.prisma.$transaction((tx) =>
        service.reserveForCard(tx, { providerId: profile.id, cardId: a.card.id, kind: 'SERVICE', entitlementId: null, now: new Date() })),
      ctx.prisma.$transaction((tx) =>
        service.reserveForCard(tx, { providerId: profile.id, cardId: b.card.id, kind: 'SERVICE', entitlementId: null, now: new Date() })),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rights = await ctx.prisma.showcaseEntitlement.findMany();
    expect(rights).toHaveLength(1);
    expect(rights[0].status).toBe('RESERVED');
  });

  it('refuses a right whose kind does not match and an expired right', async () => {
    const { user, profile, pkg, category, service } = await scenario();
    const promoPkg = await createShowcasePackage(ctx.prisma, { allowedCardKind: 'PROMOTION' });
    const p1 = await paidPackagePurchase(profile.id, user.id, promoPkg.id);
    await ctx.prisma.$transaction((tx) => service.grantForPurchase(tx, p1, new Date()));
    const { card } = await draftCard(profile.id, category.id);

    await expect(
      ctx.prisma.$transaction((tx) =>
        service.reserveForCard(tx, { providerId: profile.id, cardId: card.id, kind: 'SERVICE', entitlementId: null, now: new Date() })),
    ).rejects.toMatchObject({ response: { code: 'SHOWCASE_ENTITLEMENT_REQUIRED' } });

    const p2 = await paidPackagePurchase(profile.id, user.id, pkg.id);
    await ctx.prisma.$transaction((tx) => service.grantForPurchase(tx, p2, new Date(Date.now() - 91 * DAY)));
    await expect(
      ctx.prisma.$transaction((tx) =>
        service.reserveForCard(tx, { providerId: profile.id, cardId: card.id, kind: 'SERVICE', entitlementId: null, now: new Date() })),
    ).rejects.toMatchObject({ response: { code: 'SHOWCASE_ENTITLEMENT_REQUIRED' } });
  });
});

describe('review pause, release and consumption', () => {
  it('stops the clock in review, gives the time back on rejection, and never expires a paused right', async () => {
    const { user, profile, pkg, category, service } = await scenario();
    const purchase = await paidPackagePurchase(profile.id, user.id, pkg.id);
    const paidAt = new Date('2026-09-01T00:00:00Z');
    await ctx.prisma.$transaction((tx) => service.grantForPurchase(tx, purchase, paidAt));
    const { card, version } = await draftCard(profile.id, category.id);
    await ctx.prisma.$transaction((tx) =>
      service.reserveForCard(tx, { providerId: profile.id, cardId: card.id, kind: 'SERVICE', entitlementId: null, now: paidAt }));

    const submittedAt = new Date('2026-11-25T00:00:00Z'); // 85 days in: 5 left
    await ctx.prisma.$transaction((tx) => service.pauseForReview(tx, card.id, version.id, submittedAt));

    const wayLater = new Date('2027-01-15T00:00:00Z');
    expect(await service.expireStale(wayLater, 100)).toBe(0);
    expect(await service.findReservedForCard(ctx.prisma, card.id, wayLater)).not.toBeNull();

    await ctx.prisma.$transaction((tx) => service.resumeAfterReview(tx, card.id, 'REJECTED', wayLater));
    const right = await ctx.prisma.showcaseEntitlement.findUniqueOrThrow({ where: { purchaseId: purchase.id } });
    expect(right.reviewPausedAt).toBeNull();
    expect(right.expiresAt.getTime()).toBe(paidAt.getTime() + 90 * DAY + (wayLater.getTime() - submittedAt.getTime()));
    expect(right.totalPausedSeconds).toBe((wayLater.getTime() - submittedAt.getTime()) / 1000);

    const pause = await ctx.prisma.showcaseEntitlementReviewPause.findFirstOrThrow({ where: { entitlementId: right.id } });
    expect(pause.endReason).toBe('REJECTED');
    expect(pause.expiresAtAfter?.getTime()).toBe(right.expiresAt.getTime());
  });

  it('releases a reserved right back to AVAILABLE and consumes it exactly once into a placement', async () => {
    const { user, profile, pkg, category, service } = await scenario();
    const purchase = await paidPackagePurchase(profile.id, user.id, pkg.id);
    await ctx.prisma.$transaction((tx) => service.grantForPurchase(tx, purchase, new Date()));
    const first = await draftCard(profile.id, category.id);
    await ctx.prisma.$transaction((tx) =>
      service.reserveForCard(tx, { providerId: profile.id, cardId: first.card.id, kind: 'SERVICE', entitlementId: null, now: new Date() }));

    expect(await ctx.prisma.$transaction((tx) => service.releaseForCard(tx, first.card.id, new Date()))).toBe(true);
    expect((await ctx.prisma.showcaseEntitlement.findUniqueOrThrow({ where: { purchaseId: purchase.id } })).status).toBe('AVAILABLE');

    const second = await draftCard(profile.id, category.id);
    await ctx.prisma.$transaction((tx) =>
      service.reserveForCard(tx, { providerId: profile.id, cardId: second.card.id, kind: 'SERVICE', entitlementId: null, now: new Date() }));
    await ctx.prisma.showcaseCardVersion.update({ where: { id: second.version.id }, data: { reviewStatus: 'APPROVED', publishedAt: new Date() } });

    const now = new Date();
    const { placementId } = await ctx.prisma.$transaction((tx) =>
      service.consumeForCard(tx, { cardId: second.card.id, versionId: second.version.id, providerId: profile.id, categoryId: category.id, kind: 'SERVICE', now }));

    const right = await ctx.prisma.showcaseEntitlement.findUniqueOrThrow({ where: { purchaseId: purchase.id } });
    expect(right.status).toBe('CONSUMED');
    expect(right.placementId).toBe(placementId);
    const placement = await ctx.prisma.showcasePlacement.findUniqueOrThrow({ where: { id: placementId }, include: { shelves: true } });
    expect(placement.status).toBe('ACTIVE');
    expect(placement.startAt.getTime()).toBe(now.getTime());
    expect(placement.endAt.getTime()).toBe(now.getTime() + 30 * DAY);
    expect(placement.shelves).toHaveLength(1);

    await expect(
      ctx.prisma.$transaction((tx) =>
        service.consumeForCard(tx, { cardId: second.card.id, versionId: second.version.id, providerId: profile.id, categoryId: category.id, kind: 'SERVICE', now })),
    ).rejects.toMatchObject({ response: { code: 'SHOWCASE_ENTITLEMENT_MISSING' } });
  });

  it('expires stale unreserved and reserved-but-idle rights, and lists what is usable', async () => {
    const { user, profile, pkg, service } = await scenario();
    const stale = await paidPackagePurchase(profile.id, user.id, pkg.id);
    const fresh = await paidPackagePurchase(profile.id, user.id, pkg.id);
    await ctx.prisma.$transaction((tx) => service.grantForPurchase(tx, stale, new Date(Date.now() - 91 * DAY)));
    await ctx.prisma.$transaction((tx) => service.grantForPurchase(tx, fresh, new Date()));

    expect(await service.expireStale(new Date(), 100)).toBe(1);
    const listed = await service.listForProvider(profile.id, new Date());
    expect(listed.available).toHaveLength(1);
    expect(listed.available[0].packageName).toBe((await ctx.prisma.showcasePackage.findUniqueOrThrow({ where: { id: pkg.id } })).name);
  });
});
```

- [x] **Step 5: Testi çalıştır — başarısız olmalı**

Run: `DATABASE_URL='postgresql://taktic_user:taktic_password@localhost:5433/taktic?schema=public' pnpm --filter @taktic/api test -- showcase-entitlement-lifecycle`
Expected: FAIL — `Cannot find module '../src/modules/showcase/showcase-entitlement.service'`.

- [x] **Step 6: Servisi yaz**

`apps/api/src/modules/showcase/showcase-entitlement.service.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  ShowcaseCardKind,
  ShowcaseEntitlementPauseEnd,
  ShowcaseEntitlementStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ShowcasePlacementService } from './showcase-placement.service';
import {
  showcaseEntitlementKindMismatch,
  showcaseEntitlementMissing,
  showcaseEntitlementRequired,
  showcaseEntitlementUnavailable,
} from './showcase.errors';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A right that can be bound to a new card right now. */
export function usableEntitlementWhere(now: Date): Prisma.ShowcaseEntitlementWhereInput {
  return { status: ShowcaseEntitlementStatus.AVAILABLE, expiresAt: { gt: now } };
}

/**
 * A right reserved for this card that can still be consumed. A paused right —
 * the card is with an operator — is valid regardless of `expiresAt`: review
 * time belongs to the operator and must never cost the provider their right.
 */
export function reservedEntitlementWhere(
  cardId: string,
  now: Date,
): Prisma.ShowcaseEntitlementWhereInput {
  return {
    cardId,
    status: ShowcaseEntitlementStatus.RESERVED,
    OR: [{ reviewPausedAt: { not: null } }, { expiresAt: { gt: now } }],
  };
}

/** The columns a settlement hands over. Narrowed by the caller, never asserted. */
export type SettledEntitlementPurchase = {
  id: string;
  providerId: string;
  showcasePackageId: string;
  durationDaysSnapshot: number;
  packageNameSnapshot: string;
  priceAmountSnapshot: number;
  currencySnapshot: string;
  showcasePackageTermsAcceptanceId: string;
};

export type ProviderEntitlementSummary = {
  id: string;
  packageName: string;
  durationDays: number;
  allowedCardKind: ShowcaseCardKind | null;
  expiresAt: string;
};

/**
 * The life of a purchased publication right: granted by a settlement, reserved
 * by a card, paused while that card is reviewed, released if the card is
 * discarded, consumed — once — when the card is first approved.
 *
 * Every write is conditional on the status it expects (`updateMany` with the
 * status in the WHERE and `count === 1` checked), inside the caller's
 * transaction. That is what makes two cards racing for one right, or two
 * approvals racing for one card, produce exactly one winner.
 */
@Injectable()
export class ShowcaseEntitlementService {
  private readonly logger = new Logger('ShowcaseEntitlement');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ShowcasePlacementService) private readonly placements: ShowcasePlacementService,
  ) {}

  async grantForPurchase(
    tx: Prisma.TransactionClient,
    purchase: SettledEntitlementPurchase,
    paidAt: Date,
  ): Promise<{ entitlementId: string }> {
    const [pkg, acceptance] = await Promise.all([
      tx.showcasePackage.findUniqueOrThrow({
        where: { id: purchase.showcasePackageId },
        select: { activationWindowDays: true, allowedCardKind: true, maxAreas: true },
      }),
      tx.showcasePackageTermsAcceptance.findUniqueOrThrow({
        where: { id: purchase.showcasePackageTermsAcceptanceId },
        select: { termsVersion: true, termsTextSnapshot: true },
      }),
    ]);

    const created = await tx.showcaseEntitlement.create({
      data: {
        providerId: purchase.providerId,
        purchaseId: purchase.id,
        showcasePackageId: purchase.showcasePackageId,
        packageNameSnapshot: purchase.packageNameSnapshot,
        durationDaysSnapshot: purchase.durationDaysSnapshot,
        priceAmountSnapshot: purchase.priceAmountSnapshot,
        currencySnapshot: purchase.currencySnapshot,
        allowedCardKindSnapshot: pkg.allowedCardKind,
        maxAreasSnapshot: pkg.maxAreas,
        priceTermsVersionSnapshot: acceptance.termsVersion,
        priceTermsTextSnapshot: acceptance.termsTextSnapshot,
        status: ShowcaseEntitlementStatus.AVAILABLE,
        grantedAt: paidAt,
        expiresAt: new Date(paidAt.getTime() + pkg.activationWindowDays * DAY_MS),
      },
      select: { id: true },
    });

    return { entitlementId: created.id };
  }

  /**
   * Binds one usable right to one card. The candidate is the caller's choice
   * or, absent one, the right that would expire soonest — spending the oldest
   * purchase first is what a provider holding two packages expects.
   */
  async reserveForCard(
    tx: Prisma.TransactionClient,
    input: {
      providerId: string;
      cardId: string;
      kind: ShowcaseCardKind;
      entitlementId: string | null;
      now: Date;
    },
  ) {
    const candidate = await tx.showcaseEntitlement.findFirst({
      where: {
        providerId: input.providerId,
        ...usableEntitlementWhere(input.now),
        ...(input.entitlementId ? { id: input.entitlementId } : {}),
      },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      select: { id: true, allowedCardKindSnapshot: true },
    });

    if (!candidate) {
      throw showcaseEntitlementRequired();
    }

    if (candidate.allowedCardKindSnapshot !== null && candidate.allowedCardKindSnapshot !== input.kind) {
      // A named right of the wrong kind is a mismatch; an unnamed search simply
      // has no usable right of this kind.
      throw input.entitlementId ? showcaseEntitlementKindMismatch() : showcaseEntitlementRequired();
    }

    const moved = await tx.showcaseEntitlement.updateMany({
      where: { id: candidate.id, ...usableEntitlementWhere(input.now) },
      data: {
        status: ShowcaseEntitlementStatus.RESERVED,
        cardId: input.cardId,
        reservedAt: input.now,
      },
    });

    if (moved.count !== 1) {
      throw showcaseEntitlementUnavailable();
    }

    return tx.showcaseEntitlement.findUniqueOrThrow({ where: { id: candidate.id } });
  }

  /** The card was discarded before it went live: the right goes back on the shelf. */
  async releaseForCard(tx: Prisma.TransactionClient, cardId: string, now: Date): Promise<boolean> {
    const reserved = await tx.showcaseEntitlement.findFirst({
      where: { cardId, status: ShowcaseEntitlementStatus.RESERVED },
      select: { id: true, reviewPausedAt: true },
    });
    if (!reserved) {
      return false;
    }

    if (reserved.reviewPausedAt) {
      await this.closePause(tx, reserved.id, ShowcaseEntitlementPauseEnd.RELEASED, now);
    }

    const moved = await tx.showcaseEntitlement.updateMany({
      where: { id: reserved.id, status: ShowcaseEntitlementStatus.RESERVED },
      data: {
        status: ShowcaseEntitlementStatus.AVAILABLE,
        cardId: null,
        reservedAt: null,
        reviewPausedAt: null,
      },
    });
    return moved.count === 1;
  }

  /** The card entered review: stop the clock and write the audit row. */
  async pauseForReview(
    tx: Prisma.TransactionClient,
    cardId: string,
    cardVersionId: string,
    now: Date,
  ): Promise<boolean> {
    const reserved = await tx.showcaseEntitlement.findFirst({
      where: { cardId, status: ShowcaseEntitlementStatus.RESERVED, reviewPausedAt: null },
      select: { id: true, expiresAt: true },
    });
    if (!reserved) {
      return false;
    }

    await tx.showcaseEntitlement.update({
      where: { id: reserved.id },
      data: { reviewPausedAt: now },
    });
    await tx.showcaseEntitlementReviewPause.create({
      data: {
        entitlementId: reserved.id,
        cardVersionId,
        startedAt: now,
        expiresAtBefore: reserved.expiresAt,
      },
    });
    return true;
  }

  /** The card left review without going live: the clock resumes with the time given back. */
  async resumeAfterReview(
    tx: Prisma.TransactionClient,
    cardId: string,
    endReason: 'REJECTED' | 'WITHDRAWN',
    now: Date,
  ): Promise<boolean> {
    const reserved = await tx.showcaseEntitlement.findFirst({
      where: { cardId, status: ShowcaseEntitlementStatus.RESERVED, reviewPausedAt: { not: null } },
      select: { id: true },
    });
    if (!reserved) {
      return false;
    }
    await this.closePause(tx, reserved.id, endReason, now);
    return true;
  }

  /**
   * Spends the card's reserved right and births the placement, in one
   * transaction. Refuses when there is no valid reserved right — which is what
   * makes "approved but unpublishable" unrepresentable.
   */
  async consumeForCard(
    tx: Prisma.TransactionClient,
    input: {
      cardId: string;
      versionId: string;
      providerId: string;
      categoryId: string;
      kind: ShowcaseCardKind;
      now: Date;
    },
  ): Promise<{ placementId: string; entitlementId: string }> {
    const reserved = await tx.showcaseEntitlement.findFirst({
      where: reservedEntitlementWhere(input.cardId, input.now),
    });
    if (!reserved) {
      throw showcaseEntitlementMissing();
    }

    if (reserved.reviewPausedAt) {
      await this.closePause(tx, reserved.id, ShowcaseEntitlementPauseEnd.CONSUMED, input.now);
    }

    const { placementId } = await this.placements.createForEntitlement(tx, {
      entitlement: reserved,
      providerId: input.providerId,
      cardId: input.cardId,
      categoryId: input.categoryId,
      kind: input.kind,
      versionId: input.versionId,
      startAt: input.now,
    });

    const moved = await tx.showcaseEntitlement.updateMany({
      where: { id: reserved.id, status: ShowcaseEntitlementStatus.RESERVED, cardId: input.cardId },
      data: {
        status: ShowcaseEntitlementStatus.CONSUMED,
        consumedAt: input.now,
        placementId,
        reviewPausedAt: null,
      },
    });
    if (moved.count !== 1) {
      throw showcaseEntitlementMissing();
    }

    return { placementId, entitlementId: reserved.id };
  }

  findReservedForCard(db: Prisma.TransactionClient | PrismaService, cardId: string, now: Date) {
    return db.showcaseEntitlement.findFirst({
      where: reservedEntitlementWhere(cardId, now),
      include: { purchase: { select: { showcasePackageTermsAcceptance: { select: { acceptedAt: true } } } } },
    });
  }

  async listForProvider(providerId: string, now: Date) {
    const rows = await this.prisma.showcaseEntitlement.findMany({
      where: {
        providerId,
        OR: [usableEntitlementWhere(now), { status: ShowcaseEntitlementStatus.RESERVED }],
      },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true, status: true, cardId: true, packageNameSnapshot: true,
        durationDaysSnapshot: true, allowedCardKindSnapshot: true, expiresAt: true, reviewPausedAt: true,
      },
    });

    const summary = (row: (typeof rows)[number]): ProviderEntitlementSummary => ({
      id: row.id,
      packageName: row.packageNameSnapshot,
      durationDays: row.durationDaysSnapshot,
      allowedCardKind: row.allowedCardKindSnapshot,
      expiresAt: row.expiresAt.toISOString(),
    });

    return {
      available: rows.filter((row) => row.status === ShowcaseEntitlementStatus.AVAILABLE).map(summary),
      reservedByCard: Object.fromEntries(
        rows
          .filter((row) => row.status === ShowcaseEntitlementStatus.RESERVED && row.cardId)
          .map((row) => [
            row.cardId!,
            { ...summary(row), pausedForReview: row.reviewPausedAt !== null, valid: row.reviewPausedAt !== null || row.expiresAt > now },
          ]),
      ) as Record<string, ProviderEntitlementSummary & { pausedForReview: boolean; valid: boolean }>,
    };
  }

  /** The sweeper: rights whose window closed while nobody was reviewing them. */
  async expireStale(now: Date, limit: number): Promise<number> {
    const candidates = await this.prisma.showcaseEntitlement.findMany({
      where: {
        status: { in: [ShowcaseEntitlementStatus.AVAILABLE, ShowcaseEntitlementStatus.RESERVED] },
        reviewPausedAt: null,
        expiresAt: { lte: now },
      },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true },
    });

    let expired = 0;
    for (const candidate of candidates) {
      const moved = await this.prisma.showcaseEntitlement.updateMany({
        where: {
          id: candidate.id,
          status: { in: [ShowcaseEntitlementStatus.AVAILABLE, ShowcaseEntitlementStatus.RESERVED] },
          reviewPausedAt: null,
          expiresAt: { lte: now },
        },
        data: { status: ShowcaseEntitlementStatus.EXPIRED },
      });
      expired += moved.count;
    }

    if (expired > 0) {
      this.logger.log(`vitrin entitlements expired=${expired}`);
    }
    return expired;
  }

  private async closePause(
    tx: Prisma.TransactionClient,
    entitlementId: string,
    endReason: ShowcaseEntitlementPauseEnd,
    now: Date,
  ) {
    const right = await tx.showcaseEntitlement.findUniqueOrThrow({
      where: { id: entitlementId },
      select: { expiresAt: true, reviewPausedAt: true, totalPausedSeconds: true },
    });
    const open = await tx.showcaseEntitlementReviewPause.findFirst({
      where: { entitlementId, endedAt: null },
      select: { id: true, startedAt: true },
    });
    if (!right.reviewPausedAt || !open) {
      return;
    }

    const elapsedMs = Math.max(0, now.getTime() - open.startedAt.getTime());
    const expiresAt = new Date(right.expiresAt.getTime() + elapsedMs);

    await tx.showcaseEntitlement.update({
      where: { id: entitlementId },
      data: {
        expiresAt,
        reviewPausedAt: null,
        totalPausedSeconds: right.totalPausedSeconds + Math.round(elapsedMs / 1000),
      },
    });
    await tx.showcaseEntitlementReviewPause.update({
      where: { id: open.id },
      data: { endedAt: now, expiresAtAfter: expiresAt, endReason },
    });
  }
}
```

`showcase-lifecycle.module.ts` içindeki `providers` ve `exports` dizilerine `ShowcaseEntitlementService` ekle (bu modül `ShowcasePlacementService`'i barındırır; `PaymentsModule` onu import eder).

- [x] **Step 7: Testi çalıştır — geçmeli**

Run: `DATABASE_URL='postgresql://taktic_user:taktic_password@localhost:5433/taktic?schema=public' pnpm --filter @taktic/api test -- showcase-entitlement-lifecycle`
Expected: PASS (7 test). `totalPausedSeconds` eşitliğinde ms tam saniye olmalı — test tarihleri tam saniye.

- [x] **Step 8: Commit**

```bash
git add apps/api/src/modules/showcase apps/api/test/showcase-entitlement-lifecycle.spec.ts
git commit -m "feat(showcase): yayın hakkı servisi — hak üretimi, rezervasyon, duraklama, tüketim

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Paket-önce satın alma ucu, settlement dalı ve kart-bağlı uçların kaldırılması

**Files:**
- Create: `apps/api/src/modules/showcase/dto/showcase-package-checkout.dto.ts`
- Create: `apps/api/src/modules/showcase/showcase-package-checkout.service.ts`
- Delete: `apps/api/src/modules/showcase/showcase-checkout.service.ts`, `apps/api/src/modules/showcase/dto/showcase-checkout.dto.ts`
- Modify: `apps/api/src/modules/showcase/provider-showcase-placements.controller.ts`, `provider-showcase-cards.controller.ts`, `showcase.module.ts`, `showcase-price-terms.service.ts`
- Modify: `apps/api/src/modules/payments/payments-webhook.service.ts:470-530`, `apps/api/src/modules/package-purchases/package-purchases.service.ts:200-260,310-330`
- Create: `apps/api/test/showcase-package-checkout.spec.ts`, `apps/api/test/showcase-legacy-routes.spec.ts`
- Modify: `apps/api/test/showcase-placement-settlement.spec.ts`, `apps/api/test/showcase-price-terms-acceptance.spec.ts`, `apps/api/test/harness.ts`
- Delete: `apps/api/test/showcase-placement-checkout.spec.ts`

**Interfaces:**
- Consumes: `ShowcaseEntitlementService.grantForPurchase`.
- Produces:
  - `POST /providers/:providerId/showcase/packages/checkout` body `{ showcasePackageId: string; priceTermsAccepted?: boolean; priceTermsVersion?: string }` → 201 `{ purchase, checkout: { provider, mode, url, expiresAt, reused } }`.
  - `GET /providers/:providerId/showcase/packages/terms` → `{ version, text, accepted: boolean, acceptedAt: string | null }`.
  - `GET /providers/:providerId/showcase/entitlements` → `ShowcaseEntitlementService.listForProvider` cevabı.
  - Harness: `createShowcaseEntitlement(ctx, { providerId, userId, packageId, paidAt? })` → `{ purchase, entitlement }`.

- [x] **Step 1: Failing test — paket satın alma**

`apps/api/test/showcase-package-checkout.spec.ts`:

```ts
import { ServiceCategoryKind, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createCategory, createDiscoverableProvider, createShowcasePackage, createTestApp,
  createUser, loginAs, resetDatabase, type TestContext,
} from './harness';

let ctx: TestContext;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.app.close(); });
beforeEach(async () => { await resetDatabase(ctx.prisma); });

async function scenario() {
  const category = await createCategory(ctx.prisma, 'Klima', { kind: ServiceCategoryKind.LEAF });
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const profile = await createDiscoverableProvider(ctx.prisma, {
    userId: user.id, categoryId: category.id, areas: [{ city: 'İstanbul', district: null }],
  });
  const pkg = await createShowcasePackage(ctx.prisma);
  return { category, user, profile, pkg, cookie: await loginAs(ctx.prisma, user.id) };
}

const checkout = (providerId: string, cookie: string, body: Record<string, unknown>) =>
  request(ctx.server).post(`/providers/${providerId}/showcase/packages/checkout`).set('Cookie', cookie).send(body);

describe('the package-first checkout', () => {
  it('refuses without an acceptance of the terms in force, and reports them', async () => {
    const { profile, pkg, cookie } = await scenario();

    const terms = await request(ctx.server)
      .get(`/providers/${profile.id}/showcase/packages/terms`).set('Cookie', cookie).expect(200);
    expect(terms.body).toMatchObject({ version: 'v1', accepted: false, acceptedAt: null });
    expect(typeof terms.body.text).toBe('string');

    const refused = await checkout(profile.id, cookie, { showcasePackageId: pkg.id });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('SHOWCASE_PRICE_TERMS_REACCEPT_REQUIRED');
    expect(await ctx.prisma.packagePurchase.count()).toBe(0);
  });

  it('records the acceptance once, opens a card-less purchase, and reuses it while pending', async () => {
    const { profile, pkg, cookie } = await scenario();

    const first = await checkout(profile.id, cookie, {
      showcasePackageId: pkg.id, priceTermsAccepted: true, priceTermsVersion: 'v1',
    });
    expect(first.status).toBe(201);
    expect(first.body.checkout.reused).toBe(false);

    const purchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: first.body.purchase.id } });
    expect(purchase.kind).toBe('SHOWCASE_PACKAGE');
    expect(purchase.showcaseCardId).toBeNull();
    expect(purchase.showcasePriceTermsAcceptanceId).toBeNull();
    expect(purchase.showcasePackageTermsAcceptanceId).not.toBeNull();
    expect(purchase.creditAmountSnapshot).toBe(0);
    expect(purchase.durationDaysSnapshot).toBe(30);

    // The second call no longer needs the checkbox: the provider already agreed.
    const second = await checkout(profile.id, cookie, { showcasePackageId: pkg.id });
    expect(second.status).toBe(201);
    expect(second.body.purchase.id).toBe(first.body.purchase.id);
    expect(second.body.checkout.reused).toBe(true);
    expect(await ctx.prisma.showcasePackageTermsAcceptance.count({ where: { providerId: profile.id } })).toBe(1);
  });

  it('refuses an inactive package, a stale terms version, and every role but the owner', async () => {
    const { profile, cookie } = await scenario();
    const inactive = await createShowcasePackage(ctx.prisma, { isActive: false });
    expect((await checkout(profile.id, cookie, { showcasePackageId: inactive.id, priceTermsAccepted: true, priceTermsVersion: 'v1' })).status).toBe(404);

    const pkg = await createShowcasePackage(ctx.prisma);
    const stale = await checkout(profile.id, cookie, { showcasePackageId: pkg.id, priceTermsAccepted: true, priceTermsVersion: 'v0' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('SHOWCASE_PRICE_TERMS_REACCEPT_REQUIRED');

    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const adminCookie = await loginAs(ctx.prisma, admin.id);
    expect((await checkout(profile.id, adminCookie, { showcasePackageId: pkg.id, priceTermsAccepted: true, priceTermsVersion: 'v1' })).status).toBe(403);
    expect((await request(ctx.server).post(`/providers/${profile.id}/showcase/packages/checkout`).send({ showcasePackageId: pkg.id })).status).toBe(401);
  });

  it('settles through the mock form into one AVAILABLE right, and only one', async () => {
    const { profile, pkg, cookie } = await scenario();
    const opened = await checkout(profile.id, cookie, { showcasePackageId: pkg.id, priceTermsAccepted: true, priceTermsVersion: 'v1' });
    const purchaseId = opened.body.purchase.id as string;

    const paid = await request(ctx.server)
      .post(`/providers/${profile.id}/package-purchases/${purchaseId}/mock-pay`).set('Cookie', cookie)
      .send({ cardholderName: 'Ayşe', cardNumber: '4111111111111111', expiryMonth: 12, expiryYear: 2030, cvv: '123' });
    expect(paid.status).toBe(201);
    expect(paid.body.status).toBe('PAID');

    const rights = await ctx.prisma.showcaseEntitlement.findMany({ where: { purchaseId } });
    expect(rights).toHaveLength(1);
    expect(rights[0].status).toBe('AVAILABLE');
    expect(await ctx.prisma.showcasePlacement.count()).toBe(0);
    expect(await ctx.prisma.providerCreditTransaction.count()).toBe(0);

    const again = await request(ctx.server)
      .post(`/providers/${profile.id}/package-purchases/${purchaseId}/mock-pay`).set('Cookie', cookie)
      .send({ cardholderName: 'Ayşe', cardNumber: '4111111111111111', expiryMonth: 12, expiryYear: 2030, cvv: '123' });
    expect(again.status).toBe(409);
    expect(await ctx.prisma.showcaseEntitlement.count()).toBe(1);

    const listed = await request(ctx.server).get(`/providers/${profile.id}/showcase/entitlements`).set('Cookie', cookie).expect(200);
    expect(listed.body.available).toHaveLength(1);
    expect(listed.body.available[0]).toMatchObject({ durationDays: 30, allowedCardKind: null });
  });

  it('grants nothing when the mock payment is declined', async () => {
    const { profile, pkg, cookie } = await scenario();
    const opened = await checkout(profile.id, cookie, { showcasePackageId: pkg.id, priceTermsAccepted: true, priceTermsVersion: 'v1' });
    const declined = await request(ctx.server)
      .post(`/providers/${profile.id}/package-purchases/${opened.body.purchase.id}/mock-pay`).set('Cookie', cookie)
      .send({ cardholderName: 'Ayşe', cardNumber: '4111111111110000', expiryMonth: 12, expiryYear: 2030, cvv: '123' });
    expect(declined.body.status).toBe('FAILED');
    expect(await ctx.prisma.showcaseEntitlement.count()).toBe(0);
  });
});
```

`apps/api/test/showcase-legacy-routes.spec.ts`:

```ts
import { ServiceCategoryKind, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApprovedShowcaseCard, createCategory, createDiscoverableProvider, createTestApp,
  createUser, loginAs, resetDatabase, type TestContext,
} from './harness';

let ctx: TestContext;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.app.close(); });
beforeEach(async () => { await resetDatabase(ctx.prisma); });

/**
 * The card-bound sale is gone. These routes had exactly one consumer — the web
 * application — and it no longer calls them; the only sale is
 * `POST /showcase/packages/checkout`. A 404 here is the contract.
 */
describe('the removed card-bound routes', () => {
  it('answer 404 for the owner', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', { kind: ServiceCategoryKind.LEAF });
    const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const profile = await createDiscoverableProvider(ctx.prisma, { userId: user.id, categoryId: category.id, areas: [{ city: 'İstanbul', district: null }] });
    const { card } = await createApprovedShowcaseCard(ctx.prisma, { providerId: profile.id, categoryId: category.id });
    const cookie = await loginAs(ctx.prisma, user.id);
    const base = `/providers/${profile.id}/showcase`;

    expect((await request(ctx.server).post(`${base}/placements/checkout`).set('Cookie', cookie).send({ cardId: card.id, showcasePackageId: 'x' })).status).toBe(404);
    expect((await request(ctx.server).get(`${base}/placements/eligibility?cardId=${card.id}`).set('Cookie', cookie)).status).toBe(404);
    expect((await request(ctx.server).get(`${base}/cards/${card.id}/price-terms`).set('Cookie', cookie)).status).toBe(404);
    expect((await request(ctx.server).post(`${base}/cards/${card.id}/price-terms-acceptances`).set('Cookie', cookie).send({ priceTermsAccepted: true, priceTermsVersion: 'v1' })).status).toBe(404);
  });
});
```

- [x] **Step 2: Testleri çalıştır — başarısız olmalı**

Run: `DATABASE_URL='postgresql://taktic_user:taktic_password@localhost:5433/taktic?schema=public' pnpm --filter @taktic/api test -- showcase-package-checkout showcase-legacy-routes`
Expected: FAIL — `packages/checkout` 404, legacy rotalar 200/201/409.

- [x] **Step 3: DTO ve servis**

`dto/showcase-package-checkout.dto.ts`:

```ts
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateShowcasePackageCheckoutDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  showcasePackageId!: string;

  /**
   * Both optional: a provider whose acceptance of the version in force is
   * already on file sends neither. When there is no acceptance, both are
   * required and checked by the service — an omitted checkbox is a refusal.
   */
  @IsOptional()
  @IsBoolean()
  priceTermsAccepted?: boolean;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  priceTermsVersion?: string;
}
```

`showcase-package-checkout.service.ts` — `showcase-checkout.service.ts`'ten `createCheckout` gövdesinin, `findReusableCheckout`, `showcasePurchaseInclude`, `present`, `buildReturnUrl` yardımcılarının aynısı; farklar:

```ts
@Injectable()
export class ShowcasePackageCheckoutService {
  private readonly logger = new Logger('ShowcasePackageCheckout');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PaymentProviderPort) private readonly payments: PaymentProviderPort,
  ) {}

  /** The terms in force and whether this business has already agreed to them. */
  async getTerms(providerId: string) {
    const terms = resolveShowcasePriceTerms();
    const acceptance = await this.prisma.showcasePackageTermsAcceptance.findUnique({
      where: { providerId_termsVersion: { providerId, termsVersion: terms.version } },
      select: { acceptedAt: true },
    });
    return {
      version: terms.version,
      text: terms.text,
      accepted: acceptance !== null,
      acceptedAt: acceptance?.acceptedAt.toISOString() ?? null,
    };
  }

  async createCheckout(providerId: string, user: AuthUser, dto: CreateShowcasePackageCheckoutDto) {
    if (user.role !== UserRole.PROVIDER) {
      throw new ForbiddenException('Only the provider account can start a vitrin checkout');
    }

    const kind = resolvePaymentProviderKind();
    const terms = resolveShowcasePriceTerms();
    const reference = randomBytes(32).toString('base64url');

    const opened = await runSerializable(
      this.prisma,
      async (tx) => {
        const provider = await tx.providerProfile.findUniqueOrThrow({
          where: { id: providerId },
          select: { status: true },
        });
        if (provider.status !== ProviderStatus.APPROVED) {
          throw showcaseProviderNotApproved();
        }

        const pkg = await tx.showcasePackage.findFirst({
          where: { id: dto.showcasePackageId, isActive: true },
          select: { id: true, name: true, slug: true, priceAmount: true, currency: true, durationDays: true },
        });
        if (!pkg) {
          throw showcasePackageNotFound();
        }

        /*
         * The acceptance in force, or a new one. Read/written inside this
         * transaction so a purchase and the acceptance it names cannot come
         * apart. A provider who already agreed to this version is not asked
         * again; a provider who has not must agree to *this* version.
         */
        let acceptance = await tx.showcasePackageTermsAcceptance.findUnique({
          where: { providerId_termsVersion: { providerId, termsVersion: terms.version } },
          select: { id: true },
        });
        if (!acceptance) {
          if (dto.priceTermsAccepted !== true || dto.priceTermsVersion !== terms.version) {
            throw showcasePriceTermsReacceptRequired(terms.version);
          }
          acceptance = await tx.showcasePackageTermsAcceptance.create({
            data: {
              providerId,
              termsVersion: terms.version,
              termsTextSnapshot: terms.text,
              acceptedByUserId: user.id,
            },
            select: { id: true },
          });
        }

        const reusable = await this.findReusableCheckout(tx, providerId, pkg.id, kind);
        if (reusable) {
          return { purchase: reusable, pkg, reused: true as const };
        }

        const created = await tx.packagePurchase.create({
          data: {
            providerId,
            kind: 'SHOWCASE_PACKAGE',
            packageId: null,
            showcasePackageId: pkg.id,
            showcaseCardId: null,
            showcaseCardVersionId: null,
            showcasePriceTermsAcceptanceId: null,
            showcasePackageTermsAcceptanceId: acceptance.id,
            durationDaysSnapshot: pkg.durationDays,
            creditAmountSnapshot: 0,
            priceAmountSnapshot: pkg.priceAmount,
            currencySnapshot: pkg.currency,
            packageNameSnapshot: pkg.name,
            paymentProvider: kind,
            paymentReference: reference,
          },
          include: showcasePurchaseInclude,
          omit: packagePurchaseOmit,
        });
        return { purchase: created, pkg, reused: false as const };
      },
      { label: 'showcase.createPackageCheckout', logger: this.logger },
    );

    // … buradan sonrası eski `createCheckout` ile birebir aynı: reused → present;
    // payments.createCheckoutSession(... returnUrl: buildReturnUrl(providerId, purchase.id));
    // hata → FAILED + ServiceUnavailableException({ code, message }).
  }

  private findReusableCheckout(db, providerId, showcasePackageId, kind) {
    return db.packagePurchase.findFirst({
      where: {
        providerId, kind: 'SHOWCASE_PACKAGE', showcasePackageId, showcaseCardId: null,
        status: PackagePurchaseStatus.PENDING, paymentProvider: kind,
        // The mock adapter has no hosted URL; its pending purchase is still the one to continue.
        OR: [{ providerCheckoutExpiresAt: null }, { providerCheckoutExpiresAt: { gt: new Date() } }],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: showcasePurchaseInclude,
      omit: packagePurchaseOmit,
    });
  }
}
```

`showcasePurchaseInclude`'dan `showcaseCard` çıkar (artık kartsız). `buildReturnUrl` aynı kalır: `/providers/${providerId}/vitrin/odeme/${purchaseId}?checkout=return`.

- [x] **Step 4: Controller'ları ve modülü güncelle**

`provider-showcase-placements.controller.ts`:
- `CreateShowcaseCheckoutDto`/`ShowcaseCheckoutService` import ve alanlarını `CreateShowcasePackageCheckoutDto`/`ShowcasePackageCheckoutService` ile değiştir; `ShowcaseEntitlementService` inject et.
- `@Get('placements/eligibility')` ve `@Post('placements/checkout')` metodlarını sil.
- `@Get('packages')`'in **üstüne** ekle (literal segment önce):

```ts
  @Get('packages/terms')
  getPackageTerms(@Param('providerId') providerId: string) {
    return this.checkout.getTerms(providerId);
  }

  @Post('packages/checkout')
  @HttpCode(HttpStatus.CREATED)
  createPackageCheckout(
    @Param('providerId') providerId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateShowcasePackageCheckoutDto,
  ) {
    return this.checkout.createCheckout(providerId, user, dto);
  }

  @Get('entitlements')
  listEntitlements(@Param('providerId') providerId: string) {
    return this.entitlements.listForProvider(providerId, new Date());
  }
```

`provider-showcase-cards.controller.ts`: `@Get(':cardId/price-terms')` ve `@Post(':cardId/price-terms-acceptances')` metodlarını, `ShowcasePriceTermsService` inject'ini ve `AcceptShowcasePriceTermsDto` import'unu sil. `@Get('price-terms')` kalır.

`showcase-price-terms.service.ts`: `getForCard`, `acceptForCard`, `assertOwnedCard` sil; `listForAdmin` kalır ve iki tabloyu birleştirir:

```ts
  async listForAdmin(filters: { providerId?: string; termsVersion?: string }) {
    const where = {
      ...(filters.providerId ? { providerId: filters.providerId } : {}),
      ...(filters.termsVersion ? { termsVersion: filters.termsVersion } : {}),
    };
    const [cardBound, packageBound] = await Promise.all([
      this.prisma.showcaseCardPriceTermsAcceptance.findMany({
        where, orderBy: [{ acceptedAt: 'desc' }], take: 200,
        select: { id: true, providerId: true, cardId: true, termsVersion: true, termsTextSnapshot: true, acceptedAt: true,
          provider: { select: { businessName: true } }, acceptedByUser: { select: { email: true } } },
      }),
      this.prisma.showcasePackageTermsAcceptance.findMany({
        where, orderBy: [{ acceptedAt: 'desc' }], take: 200,
        select: { id: true, providerId: true, termsVersion: true, termsTextSnapshot: true, acceptedAt: true,
          provider: { select: { businessName: true } }, acceptedByUser: { select: { email: true } } },
      }),
    ]);
    return [
      ...cardBound.map((row) => ({ ...row, scope: 'CARD' as const })),
      ...packageBound.map((row) => ({ ...row, cardId: null, scope: 'PACKAGE' as const })),
    ].sort((a, b) => b.acceptedAt.getTime() - a.acceptedAt.getTime());
  }
```

(Mevcut `listForAdmin` imzasındaki `cardId` filtresi kalabilir; kart-bağlı listeye uygulanır.)

`showcase.module.ts`: `ShowcaseCheckoutService` → `ShowcasePackageCheckoutService`; `ShowcaseEntitlementService` `ShowcaseLifecycleModule`'dan geldiği için ek kayıt gerekmez (import zaten var; yoksa `imports`'a `ShowcaseLifecycleModule` ekle).

Sil: `showcase-checkout.service.ts`, `dto/showcase-checkout.dto.ts`.

- [x] **Step 5: Settlement dalları**

`payments-webhook.service.ts` içindeki `if (purchase.kind === PackagePurchaseKind.SHOWCASE_PACKAGE) { … }` bloğunu şu şekle getir (`ShowcaseEntitlementService` inject: `@Inject(ShowcaseEntitlementService) private readonly entitlements: ShowcaseEntitlementService`):

```ts
    if (purchase.kind === PackagePurchaseKind.SHOWCASE_PACKAGE) {
      if (!purchase.showcasePackageId || purchase.durationDaysSnapshot === null) {
        return { mismatch: 'UNKNOWN_REFERENCE', purchaseId: purchase.id };
      }

      if (purchase.showcaseCardId) {
        // Legacy, card-bound purchase opened before the package-first flow:
        // settles exactly as it always did, into a placement.
        if (!purchase.showcaseCardVersionId || !purchase.showcasePriceTermsAcceptanceId) {
          return { mismatch: 'UNKNOWN_REFERENCE', purchaseId: purchase.id };
        }
        await this.placements.createForPurchase(tx, { /* mevcut alanlar aynen */ }, now);
      } else {
        // Package-first: the money buys a right, and the right is spent when
        // the card is approved. No placement, no balance, no card yet.
        if (!purchase.showcasePackageTermsAcceptanceId) {
          return { mismatch: 'UNKNOWN_REFERENCE', purchaseId: purchase.id };
        }
        await this.entitlements.grantForPurchase(
          tx,
          {
            id: purchase.id,
            providerId: purchase.providerId,
            showcasePackageId: purchase.showcasePackageId,
            durationDaysSnapshot: purchase.durationDaysSnapshot,
            packageNameSnapshot: purchase.packageNameSnapshot,
            priceAmountSnapshot: purchase.priceAmountSnapshot,
            currencySnapshot: purchase.currencySnapshot,
            showcasePackageTermsAcceptanceId: purchase.showcasePackageTermsAcceptanceId,
          },
          now,
        );
      }

      await tx.packagePurchase.update({ /* PAID, paidAt, providerOrderId — aynen */ });
      return { mismatch: null, purchaseId: purchase.id };
    }
```

`notifySettled`: placement bulunamazsa ve purchase `SHOWCASE_PACKAGE` ise **hiç mail gönderme** (`sendPackagePurchaseConfirmation` zaten vitrin satırını reddeder; yine de açıkça `return`):

```ts
    const purchase = await this.prisma.packagePurchase.findUnique({ where: { id: purchaseId }, select: { kind: true } });
    if (purchase?.kind === PackagePurchaseKind.SHOWCASE_PACKAGE) {
      return; // A right was granted; the return screen tells the provider. No receipt template exists for it.
    }
    await this.mail.sendPackagePurchaseConfirmation(purchaseId);
```

`package-purchases.service.ts` mock settlement: aynı dallanma (`this.entitlements` inject; `ShowcaseLifecycleModule` bu modülde import edilmiş olmalı — `placements` zaten inject edildiğine göre öyledir). Tx sonrası bildirim bloğunda `if (placement) sendShowcasePlacementActivated` aynen; placement yoksa hiçbir şey gönderme.

- [x] **Step 6: Harness ve eski spec'leri taşı**

`harness.ts` sonuna:

```ts
/** A settled package-first purchase and the AVAILABLE right it granted. */
export async function createShowcaseEntitlement(
  ctx: TestContext,
  options: { providerId: string; userId: string; packageId: string; paidAt?: Date },
) {
  const pkg = await ctx.prisma.showcasePackage.findUniqueOrThrow({ where: { id: options.packageId } });
  const paidAt = options.paidAt ?? new Date();
  const acceptance = await ctx.prisma.showcasePackageTermsAcceptance.upsert({
    where: { providerId_termsVersion: { providerId: options.providerId, termsVersion: SHOWCASE_PRICE_TERMS_VERSION } },
    update: {},
    create: {
      providerId: options.providerId, termsVersion: SHOWCASE_PRICE_TERMS_VERSION,
      termsTextSnapshot: SHOWCASE_PRICE_TERMS_TEXT, acceptedByUserId: options.userId,
    },
  });
  const purchase = await ctx.prisma.packagePurchase.create({
    data: {
      providerId: options.providerId, kind: 'SHOWCASE_PACKAGE', showcasePackageId: pkg.id,
      durationDaysSnapshot: pkg.durationDays, creditAmountSnapshot: 0,
      priceAmountSnapshot: pkg.priceAmount, currencySnapshot: pkg.currency,
      packageNameSnapshot: pkg.name, showcasePackageTermsAcceptanceId: acceptance.id,
      status: 'PAID', paidAt, paymentProvider: 'mock',
    },
  });
  const entitlements = ctx.app.get(ShowcaseEntitlementService);
  const { entitlementId } = await ctx.prisma.$transaction((tx) =>
    entitlements.grantForPurchase(tx, {
      id: purchase.id, providerId: purchase.providerId, showcasePackageId: pkg.id,
      durationDaysSnapshot: pkg.durationDays, packageNameSnapshot: purchase.packageNameSnapshot,
      priceAmountSnapshot: purchase.priceAmountSnapshot, currencySnapshot: purchase.currencySnapshot,
      showcasePackageTermsAcceptanceId: acceptance.id,
    }, paidAt),
  );
  return {
    purchase,
    entitlement: await ctx.prisma.showcaseEntitlement.findUniqueOrThrow({ where: { id: entitlementId } }),
  };
}
```

`createLiveShowcasePlacement` ve `acceptShowcasePriceTerms` **kalır** (legacy yayın kurgusu; live-card testleri bunları kullanmaya devam eder).

`showcase-placement-settlement.spec.ts`: `pendingShowcasePurchase` artık `POST …/packages/checkout` + `{ showcasePackageId, priceTermsAccepted: true, priceTermsVersion: 'v1' }` çağırır (kart oluşturma ve `acceptShowcasePriceTerms` satırları silinir). Assertion'lar: "creates one live run" → **"grants one AVAILABLE right, no placement, no balance"** (`showcaseEntitlement.findUniqueOrThrow({ where: { purchaseId } })`, `status: 'AVAILABLE'`, `grantedAt === paidAt`, `placement count 0`); "tells the provider their card is on the air" → **hiç mail yok** (`notifications.sent` boş); "delivered twice / together" → `showcaseEntitlement.count() === 1`; kalan (order already settled, variant, amount, credit purchase) assertion'ları placement→entitlement sayımına çevrilir.

`showcase-price-terms-acceptance.spec.ts`: "accepting the terms", "who may accept", "the terms a card is looking at", "the checkout gate" describe'ları silinir (rotalar yok); yerine paket-önce kabulünü kapsayan iki test `showcase-package-checkout.spec.ts`'te zaten var. "the configuration itself", "what a bump must never touch" ve "the operator's read-only view" kalır; admin liste testi `scope` alanı olan iki satır (biri `createShowcaseEntitlement`'tan gelen `PACKAGE`) bekler.

`showcase-placement-checkout.spec.ts` silinir (`git rm`).

- [x] **Step 7: Testleri çalıştır — geçmeli**

Run: `DATABASE_URL='postgresql://taktic_user:taktic_password@localhost:5433/taktic?schema=public' pnpm --filter @taktic/api test -- showcase-package-checkout showcase-legacy-routes showcase-placement-settlement showcase-price-terms-acceptance showcase-package-catalog lemon-squeezy-webhook offer-package-settlement`
Expected: PASS. `pnpm --filter @taktic/api typecheck` temiz.

- [x] **Step 8: Commit**

```bash
git add -A apps/api
git commit -m "feat(showcase): paket-önce satın alma; ödeme yayın hakkı üretir, kart-bağlı uçlar kaldırıldı

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Kart yaşam döngüsü hakla bağlanır; admin onayı hakkı tüketip yayınlar

**Files:**
- Modify: `apps/api/src/modules/showcase/dto/create-showcase-card.dto.ts`, `dto/submit-showcase-card.dto.ts`
- Create: `apps/api/src/modules/showcase/dto/use-showcase-entitlement.dto.ts`
- Modify: `apps/api/src/modules/showcase/provider-showcase-cards.service.ts` (`createCard`, `submitCard`, `withdrawSubmission`, `archiveCard`, yeni `useEntitlement`)
- Modify: `apps/api/src/modules/showcase/provider-showcase-cards.controller.ts` (`:cardId/use-entitlement`)
- Modify: `apps/api/src/modules/showcase/admin-showcase.service.ts` (`approveVersion`, `rejectVersion`, `getVersion`)
- Modify: `apps/api/src/modules/showcase/showcase.module.ts`
- Create: `apps/api/test/showcase-entitlement-review-flow.spec.ts`
- Modify: `apps/api/test/showcase-card-authoring.spec.ts`, `showcase-review-lifecycle.spec.ts`, `showcase-withdraw-submission.spec.ts`, `showcase-placement-version-pin.spec.ts`, `showcase-area-narrowing.spec.ts`, `showcase-access.spec.ts`, `showcase-lead-flow.spec.ts`, `showcase-placement-lifecycle.spec.ts`, `showcase-lead-sla-fallback.spec.ts`

**Interfaces:**
- Consumes: `ShowcaseEntitlementService` (Task 2), preflight yardımcıları (Task 2).
- Produces:
  - `POST /providers/:id/showcase/cards` body: mevcut alanlar + `entitlementId?: string`.
  - `POST /providers/:id/showcase/cards/:cardId/submit` body: `{}` (DTO alanları kaldırıldı).
  - `POST /providers/:id/showcase/cards/:cardId/use-entitlement` body `{ entitlementId?: string }` → 200 `ShowcaseCard`; kart onaylı+canlıysa aynı tx'te yayınlar.
  - `POST …/:cardId/archive` → canlı sürümü olmayan kartta hakkı serbest bırakır.
  - Admin `GET /admin/showcase/versions/:id` cevabına `entitlement: { packageName, durationDays, expiresAt, pausedForReview, valid } | null` eklenir.
  - Admin `POST /admin/showcase/versions/:id/approve` → ilk onayda `409 SHOWCASE_ENTITLEMENT_MISSING` / `SHOWCASE_CATEGORY_NOT_OFFERED` / `SHOWCASE_AREA_NOT_COVERED` mümkündür.

- [x] **Step 1: Failing test — uçtan uca hak akışı**

`apps/api/test/showcase-entitlement-review-flow.spec.ts`:

```ts
import { ServiceCategoryKind, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApprovedShowcaseCard, createCategory, createDiscoverableProvider, createShowcaseEntitlement,
  createShowcasePackage, createTestApp, createUser, loginAs, resetDatabase, showcaseCardPayload,
  type TestContext,
} from './harness';

let ctx: TestContext;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.app.close(); });
beforeEach(async () => { await resetDatabase(ctx.prisma); });

const DAY = 24 * 60 * 60 * 1000;

async function scenario(options: { rights?: number } = {}) {
  const category = await createCategory(ctx.prisma, 'Klima', { kind: ServiceCategoryKind.LEAF });
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const profile = await createDiscoverableProvider(ctx.prisma, {
    userId: user.id, categoryId: category.id, areas: [{ city: 'İstanbul', district: null }],
  });
  const pkg = await createShowcasePackage(ctx.prisma, { durationDays: 30 });
  const rights = [];
  for (let i = 0; i < (options.rights ?? 1); i += 1) {
    rights.push(await createShowcaseEntitlement(ctx, { providerId: profile.id, userId: user.id, packageId: pkg.id }));
  }
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return {
    category, user, profile, pkg, rights,
    cookie: await loginAs(ctx.prisma, user.id),
    adminCookie: await loginAs(ctx.prisma, admin.id),
  };
}

const api = () => request(ctx.server);
const createCard = (providerId: string, cookie: string, categoryId: string, extra: Record<string, unknown> = {}) =>
  api().post(`/providers/${providerId}/showcase/cards`).set('Cookie', cookie)
    .send({ ...showcaseCardPayload(categoryId), ...extra });
const submit = (providerId: string, cardId: string, cookie: string) =>
  api().post(`/providers/${providerId}/showcase/cards/${cardId}/submit`).set('Cookie', cookie).send({});
const approve = (versionId: string, cookie: string) =>
  api().post(`/admin/showcase/versions/${versionId}/approve`).set('Cookie', cookie).send({});
const reject = (versionId: string, cookie: string) =>
  api().post(`/admin/showcase/versions/${versionId}/reject`).set('Cookie', cookie).send({ note: 'Başlık çok genel, düzeltin.' });

describe('a provider without a package', () => {
  it('cannot open a card', async () => {
    const { profile, cookie, category } = await scenario({ rights: 0 });
    const response = await createCard(profile.id, cookie, category.id);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('SHOWCASE_ENTITLEMENT_REQUIRED');
    expect(await ctx.prisma.showcaseCard.count()).toBe(0);
  });
});

describe('one right, one card', () => {
  it('reserves on creation, pauses in review, keeps the right through a rejection, consumes on first approval', async () => {
    const { profile, cookie, adminCookie, category, rights } = await scenario();
    const created = await createCard(profile.id, cookie, category.id);
    expect(created.status).toBe(201);
    const cardId = created.body.id as string;
    let right = await ctx.prisma.showcaseEntitlement.findUniqueOrThrow({ where: { id: rights[0].entitlement.id } });
    expect(right.status).toBe('RESERVED');
    expect(right.cardId).toBe(cardId);

    // Submit: no checkbox, the terms come from the right.
    const submitted = await submit(profile.id, cardId, cookie);
    expect(submitted.status).toBe(201);
    expect(submitted.body.draftVersion.priceTermsVersion).toBe('v1');
    right = await ctx.prisma.showcaseEntitlement.findUniqueOrThrow({ where: { id: right.id } });
    expect(right.reviewPausedAt).not.toBeNull();
    const versionId = submitted.body.draftVersion.id as string;

    // Reject: right stays reserved, clock resumes, pause row closed.
    expect((await reject(versionId, adminCookie)).status).toBe(201);
    right = await ctx.prisma.showcaseEntitlement.findUniqueOrThrow({ where: { id: right.id } });
    expect(right.status).toBe('RESERVED');
    expect(right.reviewPausedAt).toBeNull();
    expect(await ctx.prisma.showcaseEntitlementReviewPause.count({ where: { entitlementId: right.id, endReason: 'REJECTED' } })).toBe(1);

    // Edit → new draft → resubmit → approve.
    const edited = await api().patch(`/providers/${profile.id}/showcase/cards/${cardId}`).set('Cookie', cookie)
      .send({ ...showcaseCardPayload(category.id), title: 'Klima bakımı, aynı gün' });
    expect(edited.status).toBe(200);
    const resubmitted = await submit(profile.id, cardId, cookie);
    const secondVersionId = resubmitted.body.draftVersion.id as string;
    expect(secondVersionId).not.toBe(versionId);

    const approved = await approve(secondVersionId, adminCookie);
    expect(approved.status).toBe(201);

    right = await ctx.prisma.showcaseEntitlement.findUniqueOrThrow({ where: { id: right.id } });
    expect(right.status).toBe('CONSUMED');
    expect(right.placementId).not.toBeNull();
    const placement = await ctx.prisma.showcasePlacement.findUniqueOrThrow({ where: { id: right.placementId! } });
    expect(placement.status).toBe('ACTIVE');
    expect(placement.cardId).toBe(cardId);
    expect(placement.pinnedVersionId).toBe(secondVersionId);
    expect(placement.endAt.getTime() - placement.startAt.getTime()).toBe(30 * DAY);
    expect(await ctx.prisma.showcaseEntitlementReviewPause.count({ where: { entitlementId: right.id, endReason: 'CONSUMED' } })).toBe(1);

    // The card is on the public feed now, and only now.
    const card = await ctx.prisma.showcaseCard.findUniqueOrThrow({ where: { id: cardId } });
    expect(card.status).toBe('APPROVED');
    expect(card.liveVersionId).toBe(secondVersionId);
  });

  it('an approval with an expired right changes nothing; a paused right is never expired', async () => {
    const { profile, cookie, adminCookie, category, rights } = await scenario();
    const created = await createCard(profile.id, cookie, category.id);
    const cardId = created.body.id as string;
    // Right expired *before* submission (the provider sat on it).
    await ctx.prisma.showcaseEntitlement.update({ where: { id: rights[0].entitlement.id }, data: { expiresAt: new Date(Date.now() - DAY) } });

    const refused = await submit(profile.id, cardId, cookie);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('SHOWCASE_ENTITLEMENT_REQUIRED');

    // Restore the right, submit, then let the window pass *during* review.
    await ctx.prisma.showcaseEntitlement.update({ where: { id: rights[0].entitlement.id }, data: { expiresAt: new Date(Date.now() + DAY) } });
    const submitted = await submit(profile.id, cardId, cookie);
    const versionId = submitted.body.draftVersion.id as string;
    await ctx.prisma.showcaseEntitlement.update({ where: { id: rights[0].entitlement.id }, data: { expiresAt: new Date(Date.now() - DAY) } });

    const approved = await approve(versionId, adminCookie);
    expect(approved.status).toBe(201);
    expect((await ctx.prisma.showcaseEntitlement.findUniqueOrThrow({ where: { id: rights[0].entitlement.id } })).status).toBe('CONSUMED');
  });

  it('refuses to approve a first version whose card lost its right, and writes nothing', async () => {
    const { profile, cookie, adminCookie, category, rights } = await scenario();
    const created = await createCard(profile.id, cookie, category.id);
    const cardId = created.body.id as string;
    const submitted = await submit(profile.id, cardId, cookie);
    const versionId = submitted.body.draftVersion.id as string;
    // Simulate the right vanishing underneath the review (sweeper or data fault).
    await ctx.prisma.showcaseEntitlement.update({
      where: { id: rights[0].entitlement.id },
      data: { status: 'EXPIRED', cardId: null, reservedAt: null, reviewPausedAt: null },
    });

    const refused = await approve(versionId, adminCookie);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('SHOWCASE_ENTITLEMENT_MISSING');
    const version = await ctx.prisma.showcaseCardVersion.findUniqueOrThrow({ where: { id: versionId } });
    expect(version.reviewStatus).toBe('PENDING');
    expect(await ctx.prisma.showcaseCardReview.count()).toBe(0);
    expect(await ctx.prisma.showcasePlacement.count()).toBe(0);
  });

  it('deleting the card before approval releases the right, even from inside review', async () => {
    const { profile, cookie, category, rights } = await scenario();
    const created = await createCard(profile.id, cookie, category.id);
    const cardId = created.body.id as string;
    await submit(profile.id, cardId, cookie);

    const archived = await api().post(`/providers/${profile.id}/showcase/cards/${cardId}/archive`).set('Cookie', cookie).send({});
    expect(archived.status).toBe(201);

    const right = await ctx.prisma.showcaseEntitlement.findUniqueOrThrow({ where: { id: rights[0].entitlement.id } });
    expect(right.status).toBe('AVAILABLE');
    expect(right.cardId).toBeNull();
    expect(right.reviewPausedAt).toBeNull();
    expect(await ctx.prisma.showcaseEntitlementReviewPause.count({ where: { entitlementId: right.id, endReason: 'RELEASED' } })).toBe(1);
    expect(await ctx.prisma.showcaseSubmissionWithdrawal.count({ where: { cardId } })).toBe(1);

    // And the same right opens a new card.
    expect((await createCard(profile.id, cookie, category.id)).status).toBe(201);
  });
});

describe('several rights', () => {
  it('lets each right open its own card, and refuses a third card', async () => {
    const { profile, cookie, category } = await scenario({ rights: 2 });
    expect((await createCard(profile.id, cookie, category.id)).status).toBe(201);
    expect((await createCard(profile.id, cookie, category.id)).status).toBe(201);
    const third = await createCard(profile.id, cookie, category.id);
    expect(third.status).toBe(409);
    expect(third.body.code).toBe('SHOWCASE_ENTITLEMENT_REQUIRED');
    expect(await ctx.prisma.showcaseEntitlement.count({ where: { status: 'RESERVED' } })).toBe(2);
  });

  it('lets the provider name which right a card should use', async () => {
    const { profile, cookie, category, rights } = await scenario({ rights: 2 });
    const chosen = rights[1].entitlement.id;
    const created = await createCard(profile.id, cookie, category.id, { entitlementId: chosen });
    expect(created.status).toBe(201);
    expect((await ctx.prisma.showcaseEntitlement.findUniqueOrThrow({ where: { id: chosen } })).cardId).toBe(created.body.id);
  });
});

describe('an already-approved card', () => {
  it('goes on the air immediately when a right is attached, and needs a new package once it expires', async () => {
    const { profile, cookie, category, user, pkg } = await scenario({ rights: 0 });
    const { card, version } = await createApprovedShowcaseCard(ctx.prisma, { providerId: profile.id, categoryId: category.id });

    const noRight = await api().post(`/providers/${profile.id}/showcase/cards/${card.id}/use-entitlement`).set('Cookie', cookie).send({});
    expect(noRight.status).toBe(409);
    expect(noRight.body.code).toBe('SHOWCASE_ENTITLEMENT_REQUIRED');

    await createShowcaseEntitlement(ctx, { providerId: profile.id, userId: user.id, packageId: pkg.id });
    const attached = await api().post(`/providers/${profile.id}/showcase/cards/${card.id}/use-entitlement`).set('Cookie', cookie).send({});
    expect(attached.status).toBe(201);
    const placement = await ctx.prisma.showcasePlacement.findFirstOrThrow({ where: { cardId: card.id } });
    expect(placement.status).toBe('ACTIVE');
    expect(placement.pinnedVersionId).toBe(version.id);
    expect(await ctx.prisma.showcaseEntitlement.count({ where: { status: 'CONSUMED', cardId: card.id } })).toBe(1);

    // Expire the run; a second right republishes.
    await ctx.prisma.showcasePlacement.update({ where: { id: placement.id }, data: { status: 'EXPIRED', endAt: new Date(Date.now() - DAY) } });
    await createShowcaseEntitlement(ctx, { providerId: profile.id, userId: user.id, packageId: pkg.id });
    const again = await api().post(`/providers/${profile.id}/showcase/cards/${card.id}/use-entitlement`).set('Cookie', cookie).send({});
    expect(again.status).toBe(201);
    expect(await ctx.prisma.showcasePlacement.count({ where: { cardId: card.id, status: 'ACTIVE' } })).toBe(1);
  });

  it('submits a revision without a right, carrying the consumed right’s terms', async () => {
    const { profile, cookie, adminCookie, category, rights } = await scenario();
    const created = await createCard(profile.id, cookie, category.id);
    const cardId = created.body.id as string;
    const first = await submit(profile.id, cardId, cookie);
    await approve(first.body.draftVersion.id, adminCookie);

    await api().patch(`/providers/${profile.id}/showcase/cards/${cardId}`).set('Cookie', cookie)
      .send({ ...showcaseCardPayload(category.id), title: 'Klima bakımı — güncellendi' });
    const revision = await submit(profile.id, cardId, cookie);
    expect(revision.status).toBe(201);
    expect(revision.body.draftVersion.priceTermsVersion).toBe('v1');
    expect(await ctx.prisma.showcaseEntitlement.count({ where: { status: 'RESERVED' } })).toBe(0);
    expect((await ctx.prisma.showcaseEntitlement.findUniqueOrThrow({ where: { id: rights[0].entitlement.id } })).reviewPausedAt).toBeNull();
  });

  it('refuses a revision on a legacy approved card that has never been on the air', async () => {
    const { profile, cookie, category } = await scenario({ rights: 0 });
    const { card } = await createApprovedShowcaseCard(ctx.prisma, { providerId: profile.id, categoryId: category.id });
    await api().patch(`/providers/${profile.id}/showcase/cards/${card.id}`).set('Cookie', cookie)
      .send({ ...showcaseCardPayload(category.id), title: 'Yeni başlık' });
    const refused = await submit(profile.id, card.id, cookie);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('SHOWCASE_REVISION_NEEDS_PUBLICATION');
  });
});
```

- [x] **Step 2: Testi çalıştır — başarısız olmalı**

Run: `DATABASE_URL='postgresql://taktic_user:taktic_password@localhost:5433/taktic?schema=public' pnpm --filter @taktic/api test -- showcase-entitlement-review-flow`
Expected: FAIL — kart hak olmadan oluşur (201), submit `{}` 400 döner.

- [x] **Step 3: DTO'lar**

`create-showcase-card.dto.ts` içindeki `CreateShowcaseCardDto`'ya:

```ts
  /** Which usable right to bind. Omitted, the earliest-expiring one of the right kind is used. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  entitlementId?: string;
```

`submit-showcase-card.dto.ts` → içeriği boş sınıf (whitelist eski alanları düşürür):

```ts
/**
 * Submission carries no acceptance any more: the provider agreed to the
 * price-responsibility text when they bought the package, and the version's
 * terms columns are written from the reserved right's snapshot.
 */
export class SubmitShowcaseCardDto {}
```

`dto/use-showcase-entitlement.dto.ts`:

```ts
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UseShowcaseEntitlementDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  entitlementId?: string;
}
```

- [x] **Step 4: Kart servisi**

`provider-showcase-cards.service.ts`: constructor'a `@Inject(ShowcaseEntitlementService) private readonly entitlements: ShowcaseEntitlementService` ekle; import'lar: `ShowcaseEntitlementService`, `assertCategoryStillOpen`, `assertVersionAreasCovered`, `showcaseEntitlementRequired`, `showcaseRevisionNeedsPublication`, `runSerializable`.

`createCard` — tx'i `runSerializable` yap ve rezervasyonu içine al:

```ts
  async createCard(providerId: string, dto: CreateShowcaseCardDto) {
    await this.assertCategoryIsOffered(providerId, dto.categoryId, dto.kind);
    const content = await this.normalizeContent(providerId, dto, dto.kind);
    const now = new Date();

    const cardId = await runSerializable(
      this.prisma,
      async (tx) => {
        const card = await tx.showcaseCard.create({
          data: { providerId, kind: dto.kind, categoryId: dto.categoryId, status: ShowcaseCardStatus.DRAFT },
          select: { id: true },
        });
        const version = await this.writeVersion(tx, {
          cardId: card.id, versionNumber: 1, content, reviewStatus: ShowcaseVersionReview.DRAFT,
        });
        await tx.showcaseCard.update({ where: { id: card.id }, data: { draftVersionId: version.id } });

        // The right is bound in the same transaction that creates the card, so
        // a card without a right and a right without its card are both
        // unrepresentable. Refused here, nothing above is committed.
        await this.entitlements.reserveForCard(tx, {
          providerId, cardId: card.id, kind: dto.kind, entitlementId: dto.entitlementId ?? null, now,
        });

        return card.id;
      },
      { label: 'showcase.createCard' },
    );

    return this.getCard(providerId, cardId);
  }
```

`submitCard` — `SubmitShowcaseCardDto` parametresi kalır ama okunmaz; `priceTerms` kontrolü ve `SHOWCASE_PRICE_TERMS_VERSION` yazımı yerine:

```ts
    const now = new Date();
    const draftId = card.draftVersion.id;

    await runSerializable(
      this.prisma,
      async (tx) => {
        /*
         * Where the terms snapshot comes from, and the two paths that exist:
         *
         *  - A card with no live version is going up for the first time. It
         *    may only be submitted on a valid reserved right, and the version
         *    records the terms that right was sold under.
         *  - A card with a live version is revising text that is already on
         *    the air. No right is needed; the terms are those of the consumed
         *    right behind its run — or, for a run bought before rights
         *    existed, the placement's own snapshot.
         *
         * There is deliberately no third source. The provider's package-level
         * acceptance or the card's old card-level one would let a card go into
         * review with no right behind it.
         */
        const terms = card.liveVersionId
          ? await this.revisionTerms(tx, card.id)
          : await this.firstPublicationTerms(tx, card.id, now);

        const moved = await tx.showcaseCardVersion.updateMany({
          where: { id: draftId, reviewStatus: ShowcaseVersionReview.DRAFT },
          data: {
            reviewStatus: ShowcaseVersionReview.PENDING,
            submittedAt: now,
            priceTermsVersion: terms.version,
            priceTermsAcceptedAt: terms.acceptedAt,
          },
        });
        if (moved.count !== 1) {
          throw showcaseVersionUnderReview();
        }

        if (!card.liveVersionId) {
          await tx.showcaseCard.update({ where: { id: card.id }, data: { status: ShowcaseCardStatus.PENDING_REVIEW } });
          await this.entitlements.pauseForReview(tx, card.id, draftId, now);
        }
      },
      { label: 'showcase.submitCard' },
    );
```

Yardımcılar (Internals bölümüne):

```ts
  private async firstPublicationTerms(tx: Prisma.TransactionClient, cardId: string, now: Date) {
    const reserved = await this.entitlements.findReservedForCard(tx, cardId, now);
    if (!reserved) {
      throw showcaseEntitlementRequired();
    }
    return {
      version: reserved.priceTermsVersionSnapshot,
      acceptedAt: reserved.purchase.showcasePackageTermsAcceptance?.acceptedAt ?? reserved.grantedAt,
    };
  }

  private async revisionTerms(tx: Prisma.TransactionClient, cardId: string) {
    const consumed = await tx.showcaseEntitlement.findFirst({
      where: { cardId, status: ShowcaseEntitlementStatus.CONSUMED },
      orderBy: [{ consumedAt: 'desc' }],
      select: { priceTermsVersionSnapshot: true, consumedAt: true },
    });
    if (consumed) {
      return { version: consumed.priceTermsVersionSnapshot, acceptedAt: consumed.consumedAt! };
    }
    const placement = await tx.showcasePlacement.findFirst({
      where: { cardId },
      orderBy: [{ startAt: 'desc' }],
      select: { priceTermsVersionSnapshot: true, startAt: true },
    });
    if (placement) {
      return { version: placement.priceTermsVersionSnapshot, acceptedAt: placement.startAt };
    }
    throw showcaseRevisionNeedsPublication();
  }
```

`withdrawSubmission` tx'inin sonuna (withdrawal satırından sonra):

```ts
        if (!card.liveVersionId) {
          await this.entitlements.resumeAfterReview(tx, card.id, 'WITHDRAWN', new Date());
        }
```

`archiveCard` tx'i — canlı sürümü olmayan kartta bekleyen incelemeyi geri çek ve hakkı serbest bırak:

```ts
        const now = new Date();
        if (!card.liveVersionId) {
          // "Kartı sil ve yayın hakkını serbest bırak": a card that never went
          // live takes nothing with it. A pending review is withdrawn first so
          // the operator's queue does not hold a version of an archived card.
          if (card.draftVersion?.reviewStatus === ShowcaseVersionReview.PENDING && card.draftVersion.submittedAt) {
            await tx.showcaseCardVersion.updateMany({
              where: { id: card.draftVersion.id, reviewStatus: ShowcaseVersionReview.PENDING },
              data: { reviewStatus: ShowcaseVersionReview.DRAFT, submittedAt: null, priceTermsVersion: null, priceTermsAcceptedAt: null },
            });
            await tx.showcaseSubmissionWithdrawal.create({
              data: { cardVersionId: card.draftVersion.id, cardId, providerId, submittedAtSnapshot: card.draftVersion.submittedAt },
            });
          }
          await this.entitlements.releaseForCard(tx, cardId, now);
        }
        await tx.showcaseCard.update({ where: { id: cardId }, data: { status: ShowcaseCardStatus.ARCHIVED, archivedAt: now } });
        await this.placements.suspendLiveFor(tx, { cardId }, { reason: ShowcasePlacementSuspendReason.CARD_ARCHIVED, actorUserId: null });
```

Yeni `useEntitlement`:

```ts
  /**
   * Binds a usable right to a card that has none, and — when the card is
   * already approved with a live version — spends it on the spot.
   *
   * This is the path for a card approved before rights existed, for a card
   * whose run has ended ("Yeniden yayınla"), and for a card whose right was
   * released and that the provider now wants back in the queue.
   */
  async useEntitlement(providerId: string, cardId: string, dto: UseShowcaseEntitlementDto) {
    const card = await this.loadOwnedCard(providerId, cardId);
    if (card.status === ShowcaseCardStatus.ARCHIVED || card.status === ShowcaseCardStatus.SUSPENDED) {
      throw showcaseCardLocked();
    }
    const now = new Date();

    await runSerializable(
      this.prisma,
      async (tx) => {
        const existing = await this.entitlements.findReservedForCard(tx, card.id, now);
        if (existing) {
          throw showcaseEntitlementUnavailable();
        }

        const publishNow = card.status === ShowcaseCardStatus.APPROVED && card.liveVersionId !== null;
        if (publishNow) {
          const live = await tx.showcasePlacement.findFirst({
            where: { cardId: card.id, status: { in: ['PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED'] } },
            select: { id: true },
          });
          if (live) {
            throw showcaseCardAlreadyPlaced();
          }
          const provider = await tx.providerProfile.findUniqueOrThrow({ where: { id: providerId }, select: { status: true } });
          if (provider.status !== ProviderStatus.APPROVED) {
            throw showcaseProviderNotApproved();
          }
          assertCategoryStillOpen(card.category, card.kind);
          await assertVersionAreasCovered(tx, providerId, card.liveVersionId!);
        }

        await this.entitlements.reserveForCard(tx, {
          providerId, cardId: card.id, kind: card.kind, entitlementId: dto.entitlementId ?? null, now,
        });

        if (publishNow) {
          await this.entitlements.consumeForCard(tx, {
            cardId: card.id, versionId: card.liveVersionId!, providerId, categoryId: card.categoryId, kind: card.kind, now,
          });
        }
      },
      { label: 'showcase.useEntitlement' },
    );

    const placement = await this.prisma.showcasePlacement.findFirst({
      where: { cardId: card.id, status: 'ACTIVE' }, orderBy: { startAt: 'desc' }, select: { id: true, startAt: true },
    });
    if (placement && placement.startAt.getTime() >= now.getTime()) {
      await this.mail.sendShowcasePlacementActivated(placement.id);
    }

    return this.getCard(providerId, cardId);
  }
```

(`this.mail` = `TransactionalMailService`; kart servisi zaten inject etmiyorsa `@Inject(TransactionalMailService)` ile ekle — `package-purchases.service.ts`'teki kullanımı örnek al. `card.category` `showcaseCardInclude` ile geliyor: `{ id, name, slug, kind, status }` — `assertCategoryStillOpen`'ın `CategoryTaxonomyFacts` tipiyle uyumlu olduğunu typecheck'te doğrula; gerekirse `select`'e eksik alanı ekle.)

Controller (`provider-showcase-cards.controller.ts`), `:cardId/withdraw-submission`'ın altına:

```ts
  /** Binds a right to a card that has none; publishes at once if the card is already approved. */
  @Post(':cardId/use-entitlement')
  useEntitlement(
    @Param('providerId') providerId: string,
    @Param('cardId') cardId: string,
    @Body() dto: UseShowcaseEntitlementDto,
  ) {
    return this.cards.useEntitlement(providerId, cardId, dto);
  }
```

- [x] **Step 5: Admin onayı ve reddi**

`admin-showcase.service.ts` — constructor'a `ShowcaseEntitlementService` inject; `approveVersion` içinde `version` select'ine `card: { select: { id, providerId, categoryId, kind, liveVersionId, category: { select: { id, kind, status } } } }` ekle ve `showcaseCardReview.create`'ten **önce**, versiyon `updateMany`'den sonra:

```ts
      const firstPublication = version.card.liveVersionId === null;
      const now = new Date();

      if (firstPublication) {
        /*
         * The first approval is the moment the card goes on the air, so the
         * three things that have to hold on the air are checked here, in this
         * transaction, before anything is written: the right, the shelf and
         * the coverage. A refusal leaves the version PENDING and the queue as
         * it was — "approved but unpublishable" cannot be produced.
         */
        const reserved = await this.entitlements.findReservedForCard(tx, version.cardId, now);
        if (!reserved) {
          throw showcaseEntitlementMissing();
        }
        assertCategoryStillOpen(version.card.category, version.card.kind);
        await assertVersionAreasCovered(tx, version.card.providerId, versionId);
      }
```

Bu kontrolleri **`updateMany`'den önce** koy (hiçbir yazım olmasın). Sonra kart güncellemesi ve review satırı mevcut haliyle; ardından:

```ts
      if (firstPublication) {
        const { placementId } = await this.entitlements.consumeForCard(tx, {
          cardId: version.cardId, versionId, providerId: version.card.providerId,
          categoryId: version.card.categoryId, kind: version.card.kind, now,
        });
        activatedPlacementId = placementId;
      } else {
        await this.placements.repinToVersion(tx, version.cardId, versionId, ShowcaseVersionChangeTrigger.ADMIN_APPROVAL);
      }
```

`activatedPlacementId` tx dışında `let activatedPlacementId: string | null = null;` olarak tanımlanır; tx sonrası `if (activatedPlacementId) await this.mail.sendShowcasePlacementActivated(activatedPlacementId);` (`TransactionalMailService` inject).

`rejectVersion` tx'inin sonuna:

```ts
      if (!version.card.liveVersionId) {
        await this.entitlements.resumeAfterReview(tx, version.cardId, 'REJECTED', new Date());
      }
```

`getVersion` cevabına hak bilgisi:

```ts
    const reserved = await this.prisma.showcaseEntitlement.findFirst({
      where: { cardId: version.cardId, status: ShowcaseEntitlementStatus.RESERVED },
      select: { packageNameSnapshot: true, durationDaysSnapshot: true, expiresAt: true, reviewPausedAt: true },
    });
    const now = new Date();
    return {
      ...toShowcaseVersion(version),
      card: toShowcaseCard(version.card),
      provider: version.card.provider,
      autoPublish: version.autoPublishAudit,
      entitlement: reserved
        ? {
            packageName: reserved.packageNameSnapshot,
            durationDays: reserved.durationDaysSnapshot,
            expiresAt: reserved.expiresAt.toISOString(),
            pausedForReview: reserved.reviewPausedAt !== null,
            valid: reserved.reviewPausedAt !== null || reserved.expiresAt > now,
          }
        : null,
    };
```

- [x] **Step 6: Mevcut spec'leri yeni akışa taşı**

Her spec'te kart oluşturmadan önce `createShowcaseEntitlement(ctx, { providerId, userId, packageId })` çağrısı ve `createShowcasePackage` gerekir; `submit` çağrılarındaki `{ priceTermsAccepted: true, priceTermsVersion: 'v1' }` gövdeleri `{}` olur. Dosya dosya:
- `showcase-card-authoring.spec.ts`: `scenario()` içine paket + hak; "submit requires acceptance" testi → "submit requires a reserved right" (hak `EXPIRED` yapılır, `SHOWCASE_ENTITLEMENT_REQUIRED` beklenir).
- `showcase-review-lifecycle.spec.ts`: ilk onay artık placement doğurur; onay sonrası `showcasePlacement.count() === 1` assert'i ekle; kart bir kez onaylandıktan sonraki revizyon senaryoları değişmez.
- `showcase-withdraw-submission.spec.ts`: `priceTermsVersion` temizleme assert'i kalır; ek olarak geri çekmede `reviewPausedAt === null` ve `WITHDRAWN` pause satırı.
- `showcase-placement-version-pin.spec.ts`, `showcase-area-narrowing.spec.ts`, `showcase-placement-lifecycle.spec.ts`, `showcase-lead-flow.spec.ts`, `showcase-lead-sla-fallback.spec.ts`, `showcase-access.spec.ts`: `createApprovedShowcaseCard` + `createLiveShowcasePlacement` legacy kurgusu **kalır** (canlı kart senaryoları); yalnız `submit` gövdeleri `{}` ve yeni kart açan testlere hak eklenir.
- `showcase-eligible-categories.spec.ts`: değişmez.

- [x] **Step 7: Testleri çalıştır**

Run: `DATABASE_URL='postgresql://taktic_user:taktic_password@localhost:5433/taktic?schema=public' pnpm --filter @taktic/api test -- showcase`
Expected: tüm `showcase-*` spec'leri PASS. Ardından `pnpm --filter @taktic/api typecheck`.

- [x] **Step 8: Commit**

```bash
git add -A apps/api
git commit -m "feat(showcase): kart hakla açılır, incelemede saat durur, onay hakkı tüketip yayınlar

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Yayın durumu çözümü, hak süpürmesi ve paket geçerlilik alanı

**Files:**
- Modify: `apps/api/src/modules/showcase/showcase-publication.service.ts`
- Modify: `apps/api/src/modules/showcase/showcase-placement-expiry.service.ts`
- Modify: `apps/api/src/modules/showcase/dto/showcase-package.dto.ts`, `showcase-packages.service.ts`
- Modify: `apps/api/test/showcase-publication-state.spec.ts`, `apps/api/test/showcase-package-catalog.spec.ts`

**Interfaces:**
- Produces: `GET /providers/:id/showcase/publication` →

```ts
type ShowcasePublicationState =
  | 'DRAFT' | 'IN_REVIEW' | 'REJECTED' | 'NEEDS_PACKAGE' | 'EXPIRED'
  | 'ACTIVATING' | 'LIVE' | 'PAUSED' | 'ARCHIVED' | 'SUSPENDED';
type ShowcaseCardPublication = {
  cardId: string; state: ShowcasePublicationState; endAt: string | null;
  packageName: string | null; areaLabels: string[]; leadCount: number;
  hasPendingRevision: boolean; hasRunBefore: boolean; needsPackage: boolean;
  entitlement: { packageName: string; durationDays: number; expiresAt: string; pausedForReview: boolean } | null;
};
type ShowcasePublicationList = {
  cards: ShowcaseCardPublication[];
  availableEntitlements: Array<{ id: string; packageName: string; durationDays: number; allowedCardKind: 'SERVICE' | 'PROMOTION' | null; expiresAt: string }>;
  hasPublicationHistory: boolean;
};
```
  - `ShowcasePackage` DTO/cevabına `activationWindowDays: number` (create: opsiyonel, default 90; update: opsiyonel; 1..365).

- [x] **Step 1: Failing test — durumlar**

`showcase-publication-state.spec.ts`'i baştan yaz (mevcut `scenario` yardımcılarını koru; `TERMS_REQUIRED`/`READY_TO_PUBLISH` testlerini sil):

```ts
describe('the state one card is in', () => {
  it('reads as a draft holding a right, then in review, then rejected — never losing the note', async () => {
    const s = await scenario(); // provider + category + package + one right + cookie/adminCookie
    const created = await request(ctx.server).post(`/providers/${s.profile.id}/showcase/cards`).set('Cookie', s.cookie).send(showcaseCardPayload(s.category.id));
    const cardId = created.body.id as string;

    let list = await publication(s.profile.id, s.cookie);
    expect(list.cards[0]).toMatchObject({ cardId, state: 'DRAFT', needsPackage: false });
    expect(list.cards[0].entitlement).toMatchObject({ durationDays: 30, pausedForReview: false });
    expect(list.availableEntitlements).toHaveLength(0);

    const submitted = await request(ctx.server).post(`/providers/${s.profile.id}/showcase/cards/${cardId}/submit`).set('Cookie', s.cookie).send({});
    list = await publication(s.profile.id, s.cookie);
    expect(list.cards[0]).toMatchObject({ state: 'IN_REVIEW' });
    expect(list.cards[0].entitlement?.pausedForReview).toBe(true);

    await request(ctx.server).post(`/admin/showcase/versions/${submitted.body.draftVersion.id}/reject`).set('Cookie', s.adminCookie).send({ note: 'Başlık çok genel, düzeltin.' });
    list = await publication(s.profile.id, s.cookie);
    expect(list.cards[0]).toMatchObject({ state: 'REJECTED', needsPackage: false });

    // The right expires underneath the rejected card: still REJECTED, now flagged.
    await ctx.prisma.showcaseEntitlement.updateMany({ where: { cardId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    list = await publication(s.profile.id, s.cookie);
    expect(list.cards[0]).toMatchObject({ state: 'REJECTED', needsPackage: true, entitlement: null });
  });

  it('reads a draft without a right as needing a package, and lists the rights on the shelf', async () => {
    const s = await scenario();
    const created = await request(ctx.server).post(`/providers/${s.profile.id}/showcase/cards`).set('Cookie', s.cookie).send(showcaseCardPayload(s.category.id));
    await request(ctx.server).post(`/providers/${s.profile.id}/showcase/cards/${created.body.id}/archive`).set('Cookie', s.cookie).send({});
    // Archived-never-published cards are hidden; the released right is back.
    let list = await publication(s.profile.id, s.cookie);
    expect(list.cards).toHaveLength(0);
    expect(list.availableEntitlements).toHaveLength(1);

    await request(ctx.server).post(`/providers/${s.profile.id}/showcase/cards/${created.body.id}/unarchive`).set('Cookie', s.cookie).send({});
    list = await publication(s.profile.id, s.cookie);
    expect(list.cards[0]).toMatchObject({ state: 'NEEDS_PACKAGE', needsPackage: true, hasRunBefore: false });
  });

  it('reads as live with the end date, then as expired needing a package', async () => {
    const s = await scenario();
    const created = await request(ctx.server).post(`/providers/${s.profile.id}/showcase/cards`).set('Cookie', s.cookie).send(showcaseCardPayload(s.category.id));
    const submitted = await request(ctx.server).post(`/providers/${s.profile.id}/showcase/cards/${created.body.id}/submit`).set('Cookie', s.cookie).send({});
    await request(ctx.server).post(`/admin/showcase/versions/${submitted.body.draftVersion.id}/approve`).set('Cookie', s.adminCookie).send({});

    let list = await publication(s.profile.id, s.cookie);
    expect(list.cards[0].state).toBe('LIVE');
    expect(list.cards[0].endAt).not.toBeNull();
    expect(list.hasPublicationHistory).toBe(true);

    await ctx.prisma.showcasePlacement.updateMany({ where: { cardId: created.body.id }, data: { status: 'EXPIRED' } });
    list = await publication(s.profile.id, s.cookie);
    expect(list.cards[0]).toMatchObject({ state: 'EXPIRED', hasRunBefore: true, needsPackage: true });
  });

  it('carries nothing a provider cannot act on', async () => { /* mevcut test: placement/purchase/version id yok — `entitlement` alanında da `id` yok */ });
  it('refuses another business’s panel', async () => { /* mevcut test aynen */ });
});
```

`publication(providerId, cookie)` yardımcısı: `GET /providers/:id/showcase/publication` → `body`.

- [x] **Step 2: Testi çalıştır — başarısız olmalı**

Run: `… pnpm --filter @taktic/api test -- showcase-publication-state`
Expected: FAIL (`needsPackage`/`entitlement` alanları yok, arşiv kartı listede).

- [x] **Step 3: `ShowcasePublicationService`'i yeniden yaz**

Tip tanımlarını yukarıdaki arayüze göre değiştir (`TERMS_REQUIRED`, `READY_TO_PUBLISH`, `AWAITING_PAYMENT`, `checkoutUrl`, `purchaseId` silinir). `listForProvider`:

```ts
  async listForProvider(providerId: string): Promise<ShowcasePublicationList> {
    const now = new Date();

    const [cards, placements, rights] = await Promise.all([
      this.prisma.showcaseCard.findMany({
        where: { providerId },
        orderBy: [{ createdAt: 'desc' }],
        select: { id: true, status: true, liveVersionId: true, draftVersionId: true,
          draftVersion: { select: { id: true, reviewStatus: true } } },
      }),
      this.prisma.showcasePlacement.findMany({
        where: { providerId },
        orderBy: { startAt: 'desc' },
        select: { cardId: true, status: true, endAt: true, packageNameSnapshot: true,
          shelves: { where: { active: true }, select: { city: true, district: true, neighborhood: true } },
          _count: { select: { leads: true } } },
      }),
      this.entitlements.listForProvider(providerId, now),
    ]);

    const cardsOut: ShowcaseCardPublication[] = [];

    for (const card of cards) {
      const runs = placements.filter((p) => p.cardId === card.id);
      const live = runs.find((p) => p.status === 'ACTIVE')
        ?? runs.find((p) => p.status === 'PENDING_ACTIVATION' || p.status === 'SUSPENDED') ?? null;
      const reserved = rights.reservedByCard[card.id] ?? null;
      const validRight = reserved && reserved.valid ? reserved : null;
      const inReview = card.draftVersion?.reviewStatus === 'PENDING';
      const hasPendingRevision = inReview && card.draftVersionId !== card.liveVersionId && card.liveVersionId !== null;

      // A card that never went live and was discarded is gone from the
      // provider's screen: "sil" is what the button said.
      if (card.status === 'ARCHIVED' && !card.liveVersionId) {
        continue;
      }

      const base = {
        cardId: card.id,
        endAt: live ? live.endAt.toISOString() : null,
        packageName: live?.packageNameSnapshot ?? validRight?.packageName ?? null,
        areaLabels: (live?.shelves ?? []).map((shelf) => describeArea(shelf)),
        leadCount: live?._count.leads ?? 0,
        hasPendingRevision,
        hasRunBefore: runs.length > 0,
        needsPackage: false,
        entitlement: validRight
          ? { packageName: validRight.packageName, durationDays: validRight.durationDays, expiresAt: validRight.expiresAt, pausedForReview: validRight.pausedForReview }
          : null,
      };

      const resolve = (): ShowcaseCardPublication => {
        if (card.status === 'ARCHIVED') return { ...base, state: 'ARCHIVED' };
        if (card.status === 'SUSPENDED') return { ...base, state: 'SUSPENDED' };
        if (live) {
          if (live.status === 'ACTIVE') return { ...base, state: 'LIVE' };
          if (live.status === 'PENDING_ACTIVATION') return { ...base, state: 'ACTIVATING' };
          return { ...base, state: 'PAUSED' };
        }
        if (inReview && !card.liveVersionId) return { ...base, state: 'IN_REVIEW' };
        // REJECTED before the right check: a rejected card keeps its reason
        // even when its right has lapsed; the flag says what to do about it.
        if (card.status === 'REJECTED') return { ...base, state: 'REJECTED', needsPackage: validRight === null };
        if (card.liveVersionId && card.status === 'APPROVED') {
          // Approved text, nothing on the air: a run that ended, or an approval
          // that predates rights. Either way the next step is a package.
          return { ...base, state: 'EXPIRED', needsPackage: true };
        }
        if (!validRight) return { ...base, state: 'NEEDS_PACKAGE', needsPackage: true };
        return { ...base, state: 'DRAFT' };
      };

      cardsOut.push(resolve());
    }

    return {
      cards: cardsOut,
      availableEntitlements: rights.available,
      hasPublicationHistory: placements.length > 0,
    };
  }
```

(`ShowcaseEntitlementService` inject edilir; `IN_REVIEW` yalnız canlı sürümü olmayan kart için; canlı kartın revizyonu `hasPendingRevision` bayrağıyla `LIVE`/`EXPIRED` kalır. `EXPIRED` durumu için `needsPackage: true`; `hasRunBefore` false ise sağlayıcı ekranı "Pakete hazır" rozeti gösterir — bkz. web Task 8.)

- [x] **Step 4: Süpürme ve paket DTO'su**

`showcase-placement-expiry.service.ts`: `ShowcaseEntitlementService` inject; `execute` sonunda `const entitlementsExpired = await this.entitlements.expireStale(now, limit);` ve sonuç tipine `entitlementsExpired: number` ekle (scheduler log satırına da).

`dto/showcase-package.dto.ts`: `CreateShowcasePackageDto` ve `UpdateShowcasePackageDto`'ya

```ts
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  activationWindowDays?: number;
```

`showcase-packages.service.ts`: `create` → `activationWindowDays: dto.activationWindowDays ?? 90`; `update` → tanımlıysa yaz; `listForProvider`/`listForAdmin`/`getForAdmin` select'lerine `activationWindowDays: true`.

`showcase-package-catalog.spec.ts`'e bir test: create body'siz → 90; `{ activationWindowDays: 45 }` ile update → 45; `0` → 400.

- [x] **Step 5: Testleri çalıştır — geçmeli**

Run: `… pnpm --filter @taktic/api test -- showcase scheduler-settings` ve `pnpm --filter @taktic/api typecheck && pnpm --filter @taktic/api lint`
Expected: PASS, temiz.

- [x] **Step 6: Commit**

```bash
git add -A apps/api
git commit -m "feat(showcase): yayın durumu hak modeline göre çözülür; hak süpürmesi ve paket geçerlilik günü

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Web temeli — tipler, rotalar, eylemler, kaldırılan yolların sıfır-referans testi

**Files:**
- Modify: `apps/web/lib/api.ts` (vitrin tipleri), `apps/web/lib/panel-routes.ts`
- Modify: `apps/web/app/providers/[id]/vitrin/actions.ts`, `showcase-errors.ts`, `showcase-stage.ts`
- Delete: `apps/web/app/providers/[id]/vitrin/publish-panel.tsx`
- Modify: `apps/web/app/providers/[id]/package-purchases/[purchaseId]/checkout/actions.ts`
- Create: `apps/web/test/showcase-legacy-routes.spec.ts`
- Test: `apps/web/test/panel-routes.spec.ts` (mevcut)

**Interfaces:**
- Produces (web `lib/api.ts`):

```ts
export type ShowcasePublicationState = 'DRAFT' | 'IN_REVIEW' | 'REJECTED' | 'NEEDS_PACKAGE' | 'EXPIRED' | 'ACTIVATING' | 'LIVE' | 'PAUSED' | 'ARCHIVED' | 'SUSPENDED';
export type ShowcaseEntitlementSummary = { id: string; packageName: string; durationDays: number; allowedCardKind: ShowcaseCardKind | null; expiresAt: string };
export type ShowcaseCardPublication = { cardId: string; state: ShowcasePublicationState; endAt: string | null; packageName: string | null; areaLabels: string[]; leadCount: number; hasPendingRevision: boolean; hasRunBefore: boolean; needsPackage: boolean; entitlement: { packageName: string; durationDays: number; expiresAt: string; pausedForReview: boolean } | null };
export type ShowcasePublicationList = { cards: ShowcaseCardPublication[]; availableEntitlements: ShowcaseEntitlementSummary[]; hasPublicationHistory: boolean };
export type ShowcasePackageTerms = { version: string; text: string; accepted: boolean; acceptedAt: string | null };
// ShowcasePackage'a: activationWindowDays: number
// PackagePurchase'a: kind: 'OFFER_PACKAGE' | 'SHOWCASE_PACKAGE'; packageId: string | null
```
  - Server actions: `startShowcasePackageCheckoutAction(formData)` (`providerId, showcasePackageId, priceTermsVersion?, priceTermsAccepted?, returnCard?`), `createShowcaseCardAction`, `updateShowcaseCardAction`, `submitShowcaseCardAction` (gövde `{}`), `withdrawShowcaseSubmissionAction`, `useShowcaseEntitlementAction` (`providerId, cardId`), `archiveShowcaseCardAction`, `unarchiveShowcaseCardAction`.
  - `showcaseStage(entry, ctx)` → `{ label, badge: 'live'|'progress'|'attention'|'muted', detail, action, secondary }`.

- [x] **Step 1: Failing test — kaldırılan yolların referansı yok**

`apps/web/test/showcase-legacy-routes.spec.ts`:

```ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The card-bound sale is gone from the API. This walks every source file the
 * web and admin applications ship and refuses a reference to any of its
 * routes, so a screen cannot quietly keep calling a path that now answers 404.
 */
const ROOTS = [join(__dirname, '..', 'app'), join(__dirname, '..', 'lib'), join(__dirname, '..', '..', 'admin', 'app'), join(__dirname, '..', '..', 'admin', 'lib')];
const FORBIDDEN = ['/placements/checkout', '/placements/eligibility', '/price-terms-acceptances', `/cards/\${`, ] as const;
const FORBIDDEN_CARD_TERMS = /\/showcase\/cards\/\$\{[^}]+\}\/price-terms/;

function walk(dir: string, out: string[] = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(path);
  }
  return out;
}

describe('the removed card-bound vitrin routes', () => {
  it('are referenced by no screen or action', () => {
    const offenders: string[] = [];
    for (const file of ROOTS.flatMap((root) => walk(root))) {
      const source = readFileSync(file, 'utf8');
      if (source.includes('/placements/checkout') || source.includes('/placements/eligibility') || source.includes('/price-terms-acceptances') || FORBIDDEN_CARD_TERMS.test(source)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

(`FORBIDDEN` sabitini sil; sadece `includes` ve regex kullan.) Run: `pnpm --filter @taktic/web test -- showcase-legacy-routes` → FAIL: `actions.ts`, `[cardId]/page.tsx` listelenir.

- [x] **Step 2: Tipler**

`apps/web/lib/api.ts` — `ShowcasePublicationState`, `ShowcaseCardPublication`, `ShowcasePublicationList` tanımlarını yukarıdaki arayüzle değiştir; `ShowcaseCardPriceTerms` tipini sil; `ShowcasePackageTerms` ve `ShowcaseEntitlementSummary` ekle; `ShowcasePackage`'a `activationWindowDays: number`; `PackagePurchase`'a `kind: 'OFFER_PACKAGE' | 'SHOWCASE_PACKAGE'` ve `packageId: string | null`. `SHOWCASE_CARD_KIND_LABELS` kalır (`SERVICE: 'Hizmet vitrini'`, `PROMOTION: 'Genel tanıtım'`).

- [x] **Step 3: Rotalar**

`lib/panel-routes.ts` `PANEL_ROUTES`'a (`'/providers/:id/vitrin/yeni'` satırından sonra):

```ts
  '/providers/:id/vitrin/paketler',
  '/providers/:id/vitrin/odeme/:purchaseId',
  '/providers/:id/vitrin/:cardId/duzenle',
```

`test/panel-routes.spec.ts` dizini yürüdüğü için sayfalar oluşturulunca (Task 8–9) bu liste olmadan FAIL eder; şimdi eklemek testi sayfalar gelene kadar FAIL bırakır — bu yüzden bu satırları **Task 9'da sayfalarla birlikte** ekle. Bu adımda yalnız not.

- [x] **Step 4: Eylemler**

`actions.ts`: `startShowcaseCheckoutAction`'ı sil, `submitShowcaseCardAction` gövdesini `JSON.stringify({})` yap; ekle:

```ts
/**
 * Buys a package. The acceptance travels only when the screen asked for it —
 * the API already knows whether this business agreed to the version in force
 * and refuses a purchase without it.
 */
export async function startShowcasePackageCheckoutAction(formData: FormData) {
  const providerId = readString(formData, 'providerId');
  const returnCard = readOptionalString(formData, 'returnCard');
  const base = `/providers/${providerId}/vitrin/paketler${returnCard ? `?card=${encodeURIComponent(returnCard)}` : ''}`;
  const priceTermsVersion = readOptionalString(formData, 'priceTermsVersion');

  let outcome: ShowcaseCheckoutResult;
  try {
    outcome = await apiFetch<ShowcaseCheckoutResult>(`/providers/${providerId}/showcase/packages/checkout`, {
      method: 'POST',
      body: JSON.stringify({
        showcasePackageId: readString(formData, 'showcasePackageId'),
        ...(priceTermsVersion
          ? { priceTermsVersion, priceTermsAccepted: formData.get('priceTermsAccepted') === 'on' }
          : {}),
      }),
    });
  } catch (error) {
    redirect(`${base}${base.includes('?') ? '&' : '?'}error=${errorCode(error)}`);
  }

  revalidatePath(`/providers/${providerId}/vitrin`);

  if (outcome.checkout.url) {
    redirect(outcome.checkout.url);
  }
  // No hosted page (mock provider): the in-app form, which returns to the vitrin payment screen.
  redirect(`/providers/${providerId}/package-purchases/${outcome.purchase.id}/checkout?return=vitrin${returnCard ? `&card=${encodeURIComponent(returnCard)}` : ''}`);
}

/** Binds a right to a card that has none; the API publishes at once if the card is already approved. */
export async function useShowcaseEntitlementAction(formData: FormData) {
  const providerId = readString(formData, 'providerId');
  const cardId = readString(formData, 'cardId');
  const target = `/providers/${providerId}/vitrin/${cardId}`;
  try {
    await apiFetch<ShowcaseCard>(`/providers/${providerId}/showcase/cards/${cardId}/use-entitlement`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  } catch (error) {
    redirect(`${target}?error=${errorCode(error)}`);
  }
  revalidatePath(`/providers/${providerId}/vitrin`);
  revalidatePath(target);
  redirect(`${target}?published=1`);
}
```

`archiveShowcaseCardAction`: yayınlanmamış kart silindiğinde listeye dön — action `deleted` alanını okur: `const deleted = formData.get('deleted') === '1'`; başarıda `redirect(deleted ? \`/providers/${providerId}/vitrin?deleted=1\` : \`${target}?archived=1\`)`.

`createShowcaseCardAction`: hata durumunda `SHOWCASE_ENTITLEMENT_REQUIRED` ise `/providers/${providerId}/vitrin/paketler?error=…` yerine listeye yönlendir: `redirect(\`${base}?error=${code}\`)` (liste sayfası hata mesajını gösterir).

`package-purchases/[purchaseId]/checkout/actions.ts` `mockPayPackagePurchaseAction`: `const purchase = await apiFetch<PackagePurchase>(…)`; sonunda

```ts
  if (purchase.kind === 'SHOWCASE_PACKAGE') {
    revalidatePath(`/providers/${providerId}/vitrin`);
    const card = readFormString(formData, 'returnCard');
    redirect(`/providers/${providerId}/vitrin/odeme/${purchaseId}?checkout=return${card ? `&card=${encodeURIComponent(card)}` : ''}`);
  }
  redirect(`/providers/${providerId}/package-purchases/${purchaseId}`);
```

Checkout sayfası (`checkout/page.tsx`) `searchParams.card` değerini `<input type="hidden" name="returnCard">` olarak forma taşır.

- [x] **Step 5: Hata mesajları ve durum çözümü**

`showcase-errors.ts`: `SHOWCASE_PRICE_TERMS_REQUIRED`, `SHOWCASE_CARD_NOT_PUBLISHABLE`, `SHOWCASE_PACKAGE_KIND_MISMATCH` satırlarını kaldır (kod tarafından üretilmiyor); ekle:

```ts
  SHOWCASE_ENTITLEMENT_REQUIRED: 'Kart oluşturmak için kullanılabilir bir vitrin hakkınız olmalı. Önce vitrin paketi alın.',
  SHOWCASE_ENTITLEMENT_UNAVAILABLE: 'Bu vitrin hakkı artık kullanılabilir değil. Sayfayı yenileyip tekrar deneyin.',
  SHOWCASE_ENTITLEMENT_KIND_MISMATCH: 'Seçtiğiniz vitrin hakkı bu kart türü için kullanılamaz.',
  SHOWCASE_REVISION_NEEDS_PUBLICATION: 'Bu kartı düzenlemeden önce bir vitrin hakkıyla yayına almanız gerekir.',
  SHOWCASE_PRICE_TERMS_REACCEPT_REQUIRED: 'Devam etmek için sorumluluk metnini kabul edin.',
  PACKAGE_NOT_MAPPED: 'Bu paket şu an satın alınamıyor.',
  SHOWCASE_PACKAGE_NOT_FOUND: 'Bu paket şu an satın alınamıyor.',
```

`showcase-stage.ts` — baştan:

```ts
import { formatDate, type ShowcaseCardPublication } from '../../../../lib/api';

export type ShowcaseStage = {
  /** The badge text: one of the six human states. */
  label: string;
  badge: 'live' | 'progress' | 'attention' | 'muted';
  /** One sentence under the badge, when the state is not self-explanatory. */
  detail: string | null;
  /** The single primary action, or null when the only thing to do is wait. */
  action: { label: string; href: string; kind: 'link' } | { label: string; kind: 'submit' | 'use-entitlement' } | null;
};

export function showcaseStage(
  entry: ShowcaseCardPublication | undefined,
  ctx: { providerId: string; cardId: string; hasAvailableRight: boolean },
): ShowcaseStage {
  const cardHref = `/providers/${ctx.providerId}/vitrin/${ctx.cardId}`;
  const buy = { label: 'Vitrin paketi al', href: `/providers/${ctx.providerId}/vitrin/paketler?card=${ctx.cardId}`, kind: 'link' as const };
  const publishNow = { label: ctx.hasAvailableRight ? 'Vitrine çıkar' : 'Vitrin paketi al', kind: ctx.hasAvailableRight ? ('use-entitlement' as const) : ('link' as const), href: buy.href };

  switch (entry?.state ?? 'DRAFT') {
    case 'DRAFT':
      return { label: 'Taslak', badge: 'muted', detail: 'Kartınız henüz kimseye gösterilmiyor.', action: { label: 'İncelemeye gönder', kind: 'submit' } };
    case 'IN_REVIEW':
      return { label: 'İncelemede', badge: 'progress', detail: 'Kartınız inceleniyor. Sonuçlanana kadar değiştirilemez.', action: null };
    case 'REJECTED':
      return entry?.needsPackage
        ? { label: 'Reddedildi', badge: 'attention', detail: 'Yayın hakkınızın süresi dolduğu için yeniden göndermek üzere paket almanız gerekiyor.', action: buy }
        : { label: 'Reddedildi', badge: 'attention', detail: 'İnceleme notunu okuyup düzenledikten sonra yeniden gönderebilirsiniz.', action: { label: 'Düzenle ve yeniden gönder', href: `${cardHref}/duzenle`, kind: 'link' } };
    case 'NEEDS_PACKAGE':
      return { label: 'Pakete hazır', badge: 'muted', detail: 'Bu kartı incelemeye göndermek için bir vitrin hakkı gerekiyor.', action: ctx.hasAvailableRight ? { label: 'Vitrine çıkar', kind: 'use-entitlement' } : buy };
    case 'EXPIRED':
      return entry?.hasRunBefore
        ? { label: 'Süresi doldu', badge: 'muted', detail: 'Vitrin süreniz sona erdi. Yeni bir paketle kartı tekrar yayına alabilirsiniz.', action: ctx.hasAvailableRight ? { label: 'Yeniden yayınla', kind: 'use-entitlement' } : { ...buy, label: 'Yeniden yayınla' } }
        : { label: 'Pakete hazır', badge: 'muted', detail: 'Kartınız onaylı. Bir vitrin hakkıyla hemen yayına girer.', action: publishNow.kind === 'link' ? buy : { label: 'Vitrine çıkar', kind: 'use-entitlement' } };
    case 'ACTIVATING':
      return { label: 'Yayında', badge: 'live', detail: 'Kartınız yayına alınıyor.', action: null };
    case 'LIVE':
      return { label: 'Yayında', badge: 'live', detail: entry?.endAt ? `${formatDate(entry.endAt)} tarihine kadar vitrinde.` : null, action: { label: 'Yayını görüntüle', href: `/vitrin/${ctx.cardId}`, kind: 'link' } };
    case 'PAUSED':
      return { label: 'Yayında', badge: 'progress', detail: 'Kartınız geçici olarak görünmüyor; sebep ortadan kalkınca kaldığı yerden devam eder.', action: null };
    case 'ARCHIVED':
      return { label: 'Arşivde', badge: 'muted', detail: 'Kart yayında değil ve yeni talep almıyor.', action: null };
    case 'SUSPENDED':
      return { label: 'Yayında değil', badge: 'attention', detail: 'Kartınız yönetim tarafından durduruldu. Destek ekibiyle iletişime geçebilirsiniz.', action: null };
  }
}
```

`showcaseStageBadgeClass` fonksiyonunu sil (rozet sınıfı `vitrin-badge vitrin-badge-${badge}` olur, Task 7 CSS).

`publish-panel.tsx` dosyasını sil. `[cardId]/page.tsx` ve `page.tsx` bu adımda derlenmez; Task 8–9'da yeniden yazılacak — typecheck'i **Task 9 sonunda** çalıştır. Bu görevde yalnız `showcase-legacy-routes` ve `panel-routes` (rota ekleme öncesi) testleri koşulur.

- [x] **Step 6: Testi çalıştır**

Run: `pnpm --filter @taktic/web test -- showcase-legacy-routes`
Expected: `[cardId]/page.tsx` hâlâ `price-terms` çağırdığı için FAIL — Task 9'da geçer. Bu görevde commit atma; Task 7 ile birlikte commit'lenir.

---

### Task 7: `ShowcaseCardFace` ve vitrin CSS temeli

**Files:**
- Create: `apps/web/app/showcase-card-face.tsx`
- Modify: `apps/web/app/globals.css` (`/* ---- Vitrin (showcase) ---- */` bloğunun sonuna yeni bölüm; `.showcase-stage-*` ve `.showcase-shelf-card` kuralları silinir)

**Interfaces:**
- Produces:

```ts
export type ShowcaseFaceData = {
  kind: ShowcaseCardKind; categoryName: string; categorySlug?: string | null; title: string;
  summary: string; imageUrl: string | null; listedServicePriceAmount?: number | null;
  listedServiceCurrency?: string; areaLabels: string[]; providerName?: string | null;
};
export function ShowcaseCardFace(props: { card: ShowcaseFaceData; href?: string; badge?: ReactNode; compact?: boolean; className?: string; testId?: string }): JSX.Element;
export function faceFromFeedCard(card: ShowcaseFeedCard): ShowcaseFaceData;
export function faceFromVersion(card: Pick<ShowcaseCard, 'kind' | 'category'>, version: ShowcaseCardVersion): ShowcaseFaceData;
```
- CSS sınıfları: `.vitrin-face`, `.vitrin-face-media`, `.vitrin-face-media-empty`, `.vitrin-face-body`, `.vitrin-face-kicker`, `.vitrin-face-title`, `.vitrin-face-provider`, `.vitrin-face-summary`, `.vitrin-face-price`, `.vitrin-face-area`, `.vitrin-face-badge`, `.vitrin-grid`, `.vitrin-hub-head`, `.vitrin-counter`, `.vitrin-section-title`, `.vitrin-card-foot`, `.vitrin-badge(-live|-progress|-attention|-muted)`, `.vitrin-pkg-grid`, `.vitrin-pkg`, `.vitrin-consent`, `.vitrin-form`, `.vitrin-form-group`, `.vitrin-form-group-head`, `.vitrin-choice`, `.vitrin-status`, `.vitrin-menu`, `.vitrin-dialog`, `.vitrin-return`, `.vitrin-empty`, `.vitrin-summary`, `.vitrin-public`.

- [x] **Step 1: Bileşen**

`apps/web/app/showcase-card-face.tsx`:

```tsx
import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  formatPrice,
  SHOWCASE_CARD_KIND_LABELS,
  type ShowcaseCard,
  type ShowcaseCardKind,
  type ShowcaseCardVersion,
  type ShowcaseFeedCard,
} from '../lib/api';
import { categoryImageSrc } from './category-art';

/**
 * The one face a vitrin card has.
 *
 * The home page shelf, the provider's own grid, the card's summary screen and
 * the public card page all draw this. That is the design's whole argument: a
 * provider is not managing a record, they are looking at the exact thing a
 * customer will see — and if the two ever differed, one of them would be lying.
 *
 * The area band is the loudest line after the title on purpose. The shelf is
 * shown to visitors who chose no location, so "is this card for me" is decided
 * by that band before the title is read.
 */
export type ShowcaseFaceData = {
  kind: ShowcaseCardKind;
  categoryName: string;
  categorySlug?: string | null;
  title: string;
  summary: string;
  imageUrl: string | null;
  listedServicePriceAmount?: number | null;
  listedServiceCurrency?: string;
  areaLabels: string[];
  providerName?: string | null;
};

export function ShowcaseCardFace({
  card,
  href,
  badge,
  compact = false,
  className,
  testId,
}: {
  card: ShowcaseFaceData;
  /** Wraps the title in a link when given. */
  href?: string;
  /** A state badge, rendered over the media area. Provider screens only. */
  badge?: ReactNode;
  compact?: boolean;
  className?: string;
  testId?: string;
}) {
  const art = card.imageUrl ?? categoryImageSrc(null, card.categorySlug ?? null);
  const areas = card.areaLabels.length > 0 ? card.areaLabels.join(' · ') : 'Bölge belirtilmedi';

  return (
    <article className={['vitrin-face', compact ? 'vitrin-face-compact' : '', className ?? ''].join(' ').trim()} data-testid={testId}>
      <div className={art ? 'vitrin-face-media' : 'vitrin-face-media vitrin-face-media-empty'} aria-hidden="true">
        {art ? <img src={art} alt="" loading="lazy" /> : null}
        {badge ? <span className="vitrin-face-badge">{badge}</span> : null}
      </div>
      <div className="vitrin-face-body">
        <p className="vitrin-face-kicker">
          <span>{card.categoryName}</span>
          <span className="vitrin-face-kind">{SHOWCASE_CARD_KIND_LABELS[card.kind]}</span>
        </p>
        <h3 className="vitrin-face-title">{href ? <Link href={href}>{card.title}</Link> : card.title}</h3>
        {card.providerName ? <p className="vitrin-face-provider">{card.providerName}</p> : null}
        {typeof card.listedServicePriceAmount === 'number' ? (
          <p className="vitrin-face-price" data-testid="showcase-card-price">
            {formatPrice(card.listedServicePriceAmount, card.listedServiceCurrency ?? 'TRY')}
            <span> · sabit hizmet bedeli</span>
          </p>
        ) : null}
        {!compact ? <p className="vitrin-face-summary">{card.summary}</p> : null}
        <p className="vitrin-face-area" data-testid="showcase-card-area">
          <span className="vitrin-face-area-label">Hizmet bölgesi</span>
          <span aria-hidden="true"> · </span>
          <span className="vitrin-face-area-value">{areas}</span>
        </p>
      </div>
    </article>
  );
}

export function faceFromFeedCard(card: ShowcaseFeedCard): ShowcaseFaceData {
  return {
    kind: card.kind,
    categoryName: card.category.name,
    categorySlug: card.category.slug,
    title: card.title,
    summary: card.summary,
    imageUrl: card.imageUrl,
    listedServicePriceAmount: card.listedServicePriceAmount ?? null,
    listedServiceCurrency: card.listedServiceCurrency,
    areaLabels: card.areas.length > 0 ? card.areas.map((area) => area.label) : [card.areaLabel],
    providerName: card.provider.businessName,
  };
}

export function faceFromVersion(
  card: Pick<ShowcaseCard, 'kind' | 'category'>,
  version: ShowcaseCardVersion,
): ShowcaseFaceData {
  return {
    kind: card.kind,
    categoryName: card.category.name,
    categorySlug: card.category.slug,
    title: version.title,
    summary: version.summary,
    imageUrl: version.imageUrl,
    listedServicePriceAmount: version.listedServicePriceAmount,
    listedServiceCurrency: version.listedServiceCurrency,
    areaLabels: version.areas.map((area) => area.label),
  };
}
```

(`categoryImageSrc(imageUrl, slug)` `category-art.ts`'te var; `ShowcaseCard.category` tipinde `slug` yoksa `lib/api.ts`'e ekle — API `showcaseCardInclude` category select'i `slug` içeriyor.)

- [x] **Step 2: CSS**

`globals.css` içinde `.showcase-shelf-card`, `.showcase-shelf-provider`, `.showcase-shelf-summary`, `.showcase-shelf-price`, `.showcase-shelf-sla`, `.showcase-shelf-area`, `.showcase-area-badge*`, `.showcase-stage-*` kurallarını sil; `.showcase-consent`, `.showcase-list`, `.showcase-shelf-picker`, `.showcase-shelf-grid`, `.showcase-shelf-more`, `.showcase-inline*`, `.showcase-public*`, `.showcase-coverage-note` kalır. Dosya sonuna ekle:

```css
/* ══════════════════════════════════════════════════════════════════════════
   Vitrin — VIT-DESIGN-002

   One face for a card everywhere it appears, and one quiet surface for the
   screens around it. The Modernist rules hold — radius 0, accent rare,
   everything left-aligned — but the 2px black frame is spent once per card,
   on the face itself, and nowhere else on these screens: forms sit on a
   single surface with 1px inner rules, not a stack of framed boxes.
   ══════════════════════════════════════════════════════════════════════ */

.vitrin-face {
  display: flex;
  flex-direction: column;
  border: 2px solid var(--color-text);
  background: var(--color-bg);
  min-width: 0;
  overflow-wrap: anywhere;
}

.vitrin-face-media {
  position: relative;
  aspect-ratio: 16 / 9;
  background: linear-gradient(135deg, var(--color-neutral-200), var(--color-neutral-300));
  border-bottom: 2px solid var(--color-text);
  overflow: hidden;
}

.vitrin-face-media img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/* No picture and no category art: the surface itself, with one accent seam. */
.vitrin-face-media-empty::after {
  content: '';
  position: absolute;
  inset: auto 0 0 0;
  height: 6px;
  background: var(--color-accent);
}

.vitrin-face-badge {
  position: absolute;
  top: var(--space-3);
  left: var(--space-3);
}

.vitrin-face-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4);
  min-width: 0;
}

.vitrin-face-kicker {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: 0;
  font-family: var(--font-heading);
  font-weight: 600;
  font-size: 12px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-neutral-700);
}

.vitrin-face-kind::before {
  content: '·';
  margin-right: var(--space-2);
}

.vitrin-face-title {
  margin: 0;
  font-size: 20px;
  line-height: 1.2;
}

.vitrin-face-title a {
  color: inherit;
  text-decoration: none;
}

.vitrin-face-title a:hover,
.vitrin-face-title a:focus-visible {
  color: var(--color-accent);
}

.vitrin-face-provider {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.vitrin-face-price {
  margin: 0;
  font-family: var(--font-heading);
  font-weight: var(--font-heading-weight);
  font-size: 22px;
}

.vitrin-face-price span {
  font-family: var(--font-body);
  font-weight: 400;
  font-size: 13px;
  color: var(--color-neutral-700);
}

.vitrin-face-summary {
  margin: 0;
  font-size: 14px;
  color: var(--color-neutral-800);
}

.vitrin-face-area {
  margin: var(--space-1) 0 0;
  padding: var(--space-2) var(--space-3);
  background: var(--color-text);
  color: var(--color-bg);
  font-size: 13px;
  line-height: 1.4;
}

.vitrin-face-area-label {
  font-family: var(--font-heading);
  font-weight: 600;
}

.vitrin-face-compact .vitrin-face-media { aspect-ratio: 21 / 9; }
.vitrin-face-compact .vitrin-face-title { font-size: 17px; }

/* Badges: four tones, no colour per state. */
.vitrin-badge {
  display: inline-block;
  padding: 4px 8px;
  font-family: var(--font-heading);
  font-weight: 600;
  font-size: 12px;
  letter-spacing: 0.02em;
  border: 1px solid var(--color-text);
  background: var(--color-bg);
  color: var(--color-text);
}
.vitrin-badge-live { background: var(--color-text); color: var(--color-bg); }
.vitrin-badge-progress { border-style: dashed; }
.vitrin-badge-attention { border-color: var(--color-accent); color: var(--color-accent-700); background: var(--color-accent-100); }
.vitrin-badge-muted { color: var(--color-neutral-700); border-color: var(--color-neutral-400); }

/* The hub: heading, counter, one primary action. */
.vitrin-hub-head {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding-bottom: var(--space-6);
  border-bottom: 1px solid var(--color-divider);
  margin-bottom: var(--space-6);
}

.vitrin-counter {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.vitrin-counter-text {
  margin: 0;
  font-family: var(--font-heading);
  font-weight: 600;
  font-size: 16px;
}

@media (min-width: 768px) {
  .vitrin-counter {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
  }
}

.vitrin-section-title {
  margin: var(--space-6) 0 var(--space-3);
  font-size: 14px;
  font-family: var(--font-heading);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-neutral-700);
}

.vitrin-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-4);
}

@media (min-width: 768px) {
  .vitrin-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (min-width: 1200px) {
  .vitrin-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}

.vitrin-card-foot {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4) var(--space-4);
  border-top: 1px solid var(--color-divider);
}

.vitrin-card-foot form { display: contents; }

.vitrin-card-foot .muted { margin: 0; font-size: 13px; }

.vitrin-empty {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-8) var(--space-6);
  background: var(--color-surface);
  align-items: flex-start;
}

/* Packages: selectable cards, custom radio. */
.vitrin-pkg-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-3);
}

@media (min-width: 768px) {
  .vitrin-pkg-grid { grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr)); }
}

.vitrin-pkg {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4);
  padding-left: calc(var(--space-4) + 28px);
  border: 1px solid var(--color-neutral-400);
  background: var(--color-bg);
  cursor: pointer;
  min-width: 0;
}

.vitrin-pkg input {
  appearance: none;
  position: absolute;
  top: var(--space-4);
  left: var(--space-4);
  width: 18px;
  height: 18px;
  border: 2px solid var(--color-text);
  background: var(--color-bg);
  margin: 0;
}

.vitrin-pkg input:checked { background: var(--color-accent); box-shadow: inset 0 0 0 3px var(--color-bg); }
.vitrin-pkg:has(input:checked) { border: 2px solid var(--color-text); padding: calc(var(--space-4) - 1px); padding-left: calc(var(--space-4) + 27px); }
.vitrin-pkg:has(input:checked) input { top: calc(var(--space-4) - 1px); left: calc(var(--space-4) - 1px); }
.vitrin-pkg:has(input:focus-visible) { outline: 2px solid var(--color-accent); outline-offset: 2px; }

.vitrin-pkg-name { margin: 0; font-family: var(--font-heading); font-weight: 600; font-size: 16px; }
.vitrin-pkg-price { margin: 0; font-family: var(--font-heading); font-weight: var(--font-heading-weight); font-size: 22px; }
.vitrin-pkg-meta { margin: 0; font-size: 13px; color: var(--color-neutral-700); }

.vitrin-consent {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-4);
  background: var(--color-surface);
  font-size: 14px;
  line-height: 1.5;
  cursor: pointer;
  min-width: 0;
  overflow-wrap: anywhere;
}

.vitrin-consent input {
  appearance: none;
  flex: none;
  width: 18px;
  height: 18px;
  margin-top: 2px;
  border: 2px solid var(--color-text);
  background: var(--color-bg);
}

.vitrin-consent input:checked {
  background: var(--color-accent);
  box-shadow: inset 0 0 0 3px var(--color-bg);
}

.vitrin-consent:has(input:focus-visible) { outline: 2px solid var(--color-accent); outline-offset: 2px; }

.vitrin-cta-note { margin: 0; font-size: 13px; color: var(--color-neutral-700); }

/* Forms: one surface, grouped by rule lines, never by frames. */
.vitrin-form {
  display: flex;
  flex-direction: column;
  background: var(--color-surface);
  padding: 0 var(--space-4);
}

@media (min-width: 768px) { .vitrin-form { padding: 0 var(--space-6); } }

.vitrin-form-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-6) 0;
  border-bottom: 1px solid var(--color-divider);
}

.vitrin-form-group:last-of-type { border-bottom: 0; }

.vitrin-form-group-head { display: flex; flex-direction: column; gap: 4px; }
.vitrin-form-group-head h2 { margin: 0; font-size: 16px; }
.vitrin-form-group-head p { margin: 0; font-size: 13px; color: var(--color-neutral-700); }

.vitrin-form .pdash-form-row input,
.vitrin-form .pdash-form-row textarea,
.vitrin-form .pdash-form-row select { background: var(--color-bg); }

.vitrin-choice-row { display: flex; flex-wrap: wrap; gap: var(--space-2); }

.vitrin-choice {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-neutral-400);
  background: var(--color-bg);
  cursor: pointer;
  font-size: 14px;
}

.vitrin-choice input { appearance: none; width: 14px; height: 14px; margin: 0; border: 2px solid var(--color-text); border-radius: 0; }
.vitrin-choice input:checked { background: var(--color-accent); box-shadow: inset 0 0 0 2px var(--color-bg); }
.vitrin-choice:has(input:checked) { border-color: var(--color-text); }
.vitrin-choice:has(input:focus-visible) { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.vitrin-choice:has(input:disabled) { cursor: default; color: var(--color-neutral-600); }

.vitrin-form-foot {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-6) 0;
}

@media (min-width: 640px) { .vitrin-form-foot { flex-direction: row; justify-content: flex-end; } }

/* The card screen: summary on the left, status on the right from 1024px. */
.vitrin-summary {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-6);
  align-items: start;
}

@media (min-width: 1024px) { .vitrin-summary { grid-template-columns: minmax(0, 3fr) minmax(280px, 2fr); } }

.vitrin-summary-facts { display: flex; flex-direction: column; gap: var(--space-4); padding: var(--space-4); background: var(--color-surface); }
.vitrin-summary-facts h2 { margin: 0; font-size: 14px; }
.vitrin-summary-facts p { margin: 0; font-size: 14px; }

.vitrin-status {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-5);
  border: 2px solid var(--color-text);
  background: var(--color-bg);
}

.vitrin-status h2 { margin: 0; font-size: 18px; }
.vitrin-status p { margin: 0; font-size: 14px; }
.vitrin-status-note { padding: var(--space-3); background: var(--color-accent-100); border-left: 3px solid var(--color-accent); font-size: 14px; }

.vitrin-status-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }

/* The overflow menu: <details>, so it works with no script. */
.vitrin-menu { position: relative; }
.vitrin-menu > summary { list-style: none; cursor: pointer; }
.vitrin-menu > summary::-webkit-details-marker { display: none; }
.vitrin-menu-list {
  position: absolute;
  right: 0;
  z-index: 5;
  min-width: 260px;
  margin-top: var(--space-1);
  padding: var(--space-1);
  border: 1px solid var(--color-text);
  background: var(--color-bg);
  box-shadow: var(--shadow-md);
}
.vitrin-menu-list button,
.vitrin-menu-list a {
  display: block;
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: 0;
  background: transparent;
  text-align: left;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
.vitrin-menu-list button:hover, .vitrin-menu-list a:hover { background: var(--color-surface); }
.vitrin-menu-danger { color: var(--color-accent-700); }

.vitrin-dialog {
  max-width: min(480px, calc(100vw - 32px));
  padding: var(--space-6);
  border: 2px solid var(--color-text);
  background: var(--color-bg);
}
.vitrin-dialog::backdrop { background: color-mix(in srgb, #201e1d 55%, transparent); }
.vitrin-dialog h2 { margin: 0 0 var(--space-3); font-size: 18px; }
.vitrin-dialog p { font-size: 14px; }

/* The return screen after payment: one statement, one action. */
.vitrin-return {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-8) var(--space-6);
  border: 2px solid var(--color-text);
  background: var(--color-bg);
  align-items: flex-start;
}
.vitrin-return h1 { margin: 0; font-size: 28px; }
.vitrin-return p { margin: 0; max-width: 56ch; }

/* Public card page: the face beside the decision. */
.vitrin-public { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-6); align-items: start; }
@media (min-width: 1024px) { .vitrin-public { grid-template-columns: minmax(0, 2fr) minmax(320px, 1fr); } }

@media (prefers-reduced-motion: no-preference) {
  .vitrin-face-title a, .vitrin-pkg, .vitrin-choice, .vitrin-menu-list button { transition: color 120ms ease, border-color 120ms ease, background-color 120ms ease; }
}
```

- [x] **Step 3: Typecheck (yalnız bileşen)**

Run: `pnpm --filter @taktic/web exec tsc --noEmit -p tsconfig.json 2>&1 | grep -v "vitrin/\[cardId\]/page.tsx\|vitrin/page.tsx" | head`
Expected: `showcase-card-face.tsx` hatasız (kalan hatalar Task 8–9'da kapanacak sayfalardan).

- [x] **Step 4: Commit (Task 6 ile birlikte)**

```bash
git add -A apps/web
git commit -m "feat(web): vitrin tipleri, eylemler ve tek kart yüzü bileşeni

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: `Vitrinde yer alın` merkezi, paket seçimi ve ödeme dönüş ekranı

**Files:**
- Modify: `apps/web/app/providers/[id]/vitrin/page.tsx`
- Create: `apps/web/app/providers/[id]/vitrin/paketler/page.tsx`, `apps/web/app/providers/[id]/vitrin/paketler/package-picker.tsx`
- Create: `apps/web/app/providers/[id]/vitrin/odeme/[purchaseId]/page.tsx`
- Modify: `apps/web/app/providers/[id]/package-purchases/[purchaseId]/checkout/page.tsx` (`returnCard` hidden alanı)
- Modify: `apps/web/lib/panel-routes.ts` (üç rota — Task 6 Step 3'teki satırlar)

**Interfaces:**
- Consumes: `ShowcaseCardFace`, `faceFromVersion`, `showcaseStage`, actions (Task 6–7); API `GET publication`, `GET packages`, `GET packages/terms`, `GET package-purchases/:id`.

- [x] **Step 1: Merkez sayfası**

`apps/web/app/providers/[id]/vitrin/page.tsx` — baştan:

```tsx
import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  apiFetch, fetchOrNotFound, getCurrentUser,
  type ProviderProfile, type ShowcaseCard, type ShowcasePublicationList,
} from '../../../../lib/api';
import { ShowcaseCardFace, faceFromVersion } from '../../../showcase-card-face';
import { ProviderShell } from '../../provider-shell';
import { readCreditBalance } from '../../provider-data';
import { submitShowcaseCardAction, useShowcaseEntitlementAction } from './actions';
import { SHOWCASE_ERROR_MESSAGES } from './showcase-errors';
import { showcaseStage } from './showcase-stage';

type ShowcaseListPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; deleted?: string }>;
};

/**
 * The provider's vitrin: a shop window, not a record list.
 *
 * One number and one button at the top — how many rights are unspent and
 * what to do with them — and under it the cards exactly as a customer sees
 * them, each with a single human state and a single next step. Nothing here
 * names a version, a placement, a purchase or a review status.
 */
export default async function ShowcaseListPage({ params, searchParams }: ShowcaseListPageProps) {
  const { id } = await params;
  const { error, deleted } = await searchParams;
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?redirectTo=/providers/${id}/vitrin`);
  }

  const [provider, cards, creditBalance, publication] = await Promise.all([
    fetchOrNotFound(() => apiFetch<ProviderProfile>(`/providers/${id}`)),
    fetchOrNotFound(() => apiFetch<ShowcaseCard[]>(`/providers/${id}/showcase/cards`)),
    readCreditBalance(id),
    apiFetch<ShowcasePublicationList>(`/providers/${id}/showcase/publication`).catch(() => null),
  ]);

  const stateByCard = new Map((publication?.cards ?? []).map((entry) => [entry.cardId, entry] as const));
  const available = publication?.availableEntitlements ?? [];
  const hasAvailableRight = available.length > 0;
  // Cards the publication service dropped (discarded before ever going live) are not shown.
  const visible = cards.filter((card) => stateByCard.has(card.id) || !publication);
  const live = visible.filter((card) => ['LIVE', 'ACTIVATING', 'PAUSED'].includes(stateByCard.get(card.id)?.state ?? ''));
  const preparing = visible.filter((card) => !live.includes(card));
  const buyHref = `/providers/${id}/vitrin/paketler`;
  const createHref = `/providers/${id}/vitrin/yeni`;

  return (
    <ProviderShell user={user} providerId={id} businessName={provider.businessName} active="showcase"
      creditBalance={creditBalance} status={provider.status} hasShowcaseHistory={publication?.hasPublicationHistory ?? false}>
      <nav className="pdash-crumbs" aria-label="Breadcrumb">
        <Link href="/providers/me">Panelim</Link>
        <span aria-hidden="true">/</span>
        <span>Vitrin kartlarım</span>
      </nav>

      <header className="vitrin-hub-head">
        <div className="pdash-page-head" style={{ margin: 0 }}>
          <span className="kicker">Vitrin</span>
          <h1 className="pdash-page-title">Vitrinde yer alın</h1>
          <p className="pdash-page-sub">Hizmetlerinizi ana sayfada gösterin ve doğrudan talep alın.</p>
        </div>
        <div className="vitrin-counter" data-testid="showcase-entitlement-counter">
          <p className="vitrin-counter-text">
            {hasAvailableRight
              ? `${available.length} kullanılabilir vitrin hakkınız var`
              : 'Kullanılabilir vitrin hakkınız yok'}
          </p>
          {hasAvailableRight ? (
            <Link className="pdash-btn pdash-btn-primary" href={createHref} data-testid="showcase-create-card">Vitrin kartını oluştur</Link>
          ) : (
            <Link className="pdash-btn pdash-btn-primary" href={buyHref} data-testid="showcase-buy-package">Vitrin paketi al</Link>
          )}
        </div>
      </header>

      {error ? <div className="pdash-notice pdash-notice-error" role="alert">{SHOWCASE_ERROR_MESSAGES[error] ?? SHOWCASE_ERROR_MESSAGES.SHOWCASE_SAVE_FAILED}</div> : null}
      {deleted ? <div className="pdash-notice" role="status">Kart silindi ve vitrin hakkınız yeniden kullanılabilir.</div> : null}

      {visible.length === 0 ? (
        <div className="vitrin-empty" data-testid="showcase-empty">
          <p style={{ margin: 0, maxWidth: '52ch' }}>
            Vitrin kartınız, hizmetinizi ana sayfada herkese gösterir; karttan gelen talepler yalnız size iletilir ve
            teklif kredisi harcamaz. Başlamak için bir vitrin paketi alın.
          </p>
          {hasAvailableRight
            ? <Link className="pdash-btn pdash-btn-primary" href={createHref}>Vitrin kartını oluştur</Link>
            : <Link className="pdash-btn pdash-btn-primary" href={buyHref}>Vitrin paketi al</Link>}
        </div>
      ) : (
        <>
          {live.length > 0 ? (<><h2 className="vitrin-section-title">Yayında</h2><CardGrid cards={live} /></>) : null}
          {preparing.length > 0 ? (<><h2 className="vitrin-section-title">Hazırlık</h2><CardGrid cards={preparing} /></>) : null}
        </>
      )}
    </ProviderShell>
  );

  function CardGrid({ cards: group }: { cards: ShowcaseCard[] }) {
    return (
      <div className="vitrin-grid" data-testid="showcase-card-list">
        {group.map((card) => {
          const shown = card.liveVersion ?? card.draftVersion;
          const entry = stateByCard.get(card.id);
          const stage = showcaseStage(entry, { providerId: id, cardId: card.id, hasAvailableRight });
          const cardHref = `/providers/${id}/vitrin/${card.id}`;
          return (
            <div key={card.id} data-testid="showcase-card" data-state={entry?.state ?? 'DRAFT'}>
              <ShowcaseCardFace
                compact
                href={cardHref}
                badge={<span className={`vitrin-badge vitrin-badge-${stage.badge}`}>{stage.label}</span>}
                card={shown ? faceFromVersion(card, shown) : { kind: card.kind, categoryName: card.category.name, title: 'Adsız kart', summary: '', imageUrl: null, areaLabels: [] }}
              />
              <div className="vitrin-card-foot">
                {stage.detail ? <p className="muted">{stage.detail}</p> : null}
                <StageAction stage={stage} providerId={id} cardId={card.id} />
                <Link className="pdash-btn pdash-btn-ghost pdash-btn-sm" href={`${cardHref}/duzenle`}>Kartı düzenle</Link>
              </div>
            </div>
          );
        })}
      </div>
    );
  }
}

/** The one primary action a card offers, as a link or a one-button form. */
export function StageAction({ stage, providerId, cardId }: { stage: ReturnType<typeof showcaseStage>; providerId: string; cardId: string }) {
  if (!stage.action) {
    return null;
  }
  if (stage.action.kind === 'link') {
    return <Link className="pdash-btn pdash-btn-primary" href={stage.action.href} data-testid="showcase-stage-action">{stage.action.label}</Link>;
  }
  const action = stage.action.kind === 'submit' ? submitShowcaseCardAction : useShowcaseEntitlementAction;
  return (
    <form action={action}>
      <input type="hidden" name="providerId" value={providerId} />
      <input type="hidden" name="cardId" value={cardId} />
      <button className="pdash-btn pdash-btn-primary" type="submit" data-testid="showcase-stage-action">{stage.action.label}</button>
    </form>
  );
}
```

(`StageAction` bir server component'tir; `page.tsx` içinden export etmek Next'te izinli değildir — bunu `apps/web/app/providers/[id]/vitrin/stage-action.tsx` olarak ayrı dosyaya koy ve iki sayfadan import et. `CardGrid` inner function yerine `stateByCard`, `id`, `hasAvailableRight` parametre alan üst düzey fonksiyon yap.)

- [x] **Step 2: Paket seçimi (client) ve sayfa**

`paketler/package-picker.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { formatPrice, type ShowcasePackage, type ShowcasePackageTerms } from '../../../../../lib/api';
import { startShowcasePackageCheckoutAction } from '../actions';

/**
 * Pick a package, agree to the price responsibility, pay. One form.
 *
 * The consent box appears only once a package is chosen and only when this
 * business has not already agreed to the text in force — asking twice for
 * the same consent is how a consent record stops meaning anything. The pay
 * button is inert until the box is ticked, and says why beside it.
 */
export function PackagePicker({ providerId, packages, terms, returnCard }: {
  providerId: string; packages: ShowcasePackage[]; terms: ShowcasePackageTerms | null; returnCard: string | null;
}) {
  const [selected, setSelected] = useState<string | null>(packages.length === 1 ? packages[0].id : null);
  const [accepted, setAccepted] = useState(false);
  const needsConsent = terms !== null && !terms.accepted;
  const canPay = selected !== null && (!needsConsent || accepted) && terms !== null;

  return (
    <form action={startShowcasePackageCheckoutAction} className="vitrin-form" data-testid="showcase-package-picker">
      <input type="hidden" name="providerId" value={providerId} />
      {returnCard ? <input type="hidden" name="returnCard" value={returnCard} /> : null}

      <fieldset className="vitrin-form-group" style={{ border: 0, margin: 0, minWidth: 0 }}>
        <legend className="vitrin-form-group-head"><h2>Paketinizi seçin</h2><p>Süre, kartınız onaylanıp yayına girdiği an başlar.</p></legend>
        <div className="vitrin-pkg-grid">
          {packages.map((pkg) => (
            <label className="vitrin-pkg" key={pkg.id} data-testid="showcase-package-option">
              <input type="radio" name="showcasePackageId" value={pkg.id} checked={selected === pkg.id} onChange={() => setSelected(pkg.id)} required />
              <p className="vitrin-pkg-name">{pkg.name}</p>
              <p className="vitrin-pkg-price">{formatPrice(pkg.priceAmount, pkg.currency)}</p>
              <p className="vitrin-pkg-meta">{pkg.durationDays} gün yayın{pkg.description ? ` · ${pkg.description}` : ''}</p>
            </label>
          ))}
        </div>
      </fieldset>

      {selected && needsConsent && terms ? (
        <div className="vitrin-form-group">
          <input type="hidden" name="priceTermsVersion" value={terms.version} />
          <label className="vitrin-consent" data-testid="showcase-package-consent">
            <input type="checkbox" name="priceTermsAccepted" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
            <span>{terms.text}</span>
          </label>
        </div>
      ) : null}

      <div className="vitrin-form-foot" style={{ alignItems: 'center' }}>
        {!canPay ? (
          <p className="vitrin-cta-note" data-testid="showcase-pay-reason">
            {selected === null ? 'Devam etmek için bir paket seçin.' : 'Devam etmek için sorumluluk metnini kabul edin.'}
          </p>
        ) : null}
        <button className="pdash-btn pdash-btn-primary" type="submit" disabled={!canPay} data-testid="showcase-pay">Güvenli ödemeye geç</button>
      </div>
    </form>
  );
}
```

`paketler/page.tsx`:

```tsx
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { apiFetch, fetchOrNotFound, getCurrentUser, type ProviderProfile, type ShowcasePackage, type ShowcasePackageTerms } from '../../../../../lib/api';
import { ProviderShell } from '../../../provider-shell';
import { readCreditBalance } from '../../../provider-data';
import { SHOWCASE_ERROR_MESSAGES } from '../showcase-errors';
import { PackagePicker } from './package-picker';

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ card?: string; error?: string }> };

export default async function ShowcasePackagesPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { card, error } = await searchParams;
  const user = await getCurrentUser();
  if (!user) redirect(`/login?redirectTo=/providers/${id}/vitrin/paketler`);

  const [provider, creditBalance, packages, terms] = await Promise.all([
    fetchOrNotFound(() => apiFetch<ProviderProfile>(`/providers/${id}`)),
    readCreditBalance(id),
    apiFetch<{ packages: ShowcasePackage[] }>(`/providers/${id}/showcase/packages`).then((b) => b.packages).catch(() => [] as ShowcasePackage[]),
    // No terms means no sale can be made; the picker then shows nothing technical.
    apiFetch<ShowcasePackageTerms>(`/providers/${id}/showcase/packages/terms`).catch(() => null),
  ]);

  const unavailable = packages.length === 0 || terms === null;

  return (
    <ProviderShell user={user} providerId={id} businessName={provider.businessName} active="showcase" creditBalance={creditBalance} status={provider.status}>
      <nav className="pdash-crumbs" aria-label="Breadcrumb">
        <Link href="/providers/me">Panelim</Link><span aria-hidden="true">/</span>
        <Link href={`/providers/${id}/vitrin`}>Vitrin kartlarım</Link><span aria-hidden="true">/</span>
        <span>Vitrin paketi</span>
      </nav>
      <header className="pdash-page-head">
        <span className="kicker">Vitrin</span>
        <h1 className="pdash-page-title">Vitrin paketi al</h1>
        <p className="pdash-page-sub">Ödeme tamamlanınca bir vitrin hakkı kazanırsınız; kartınızı bu hakla oluşturur, onaylandığında otomatik yayına girer.</p>
      </header>

      {error ? <div className="pdash-notice pdash-notice-error" role="alert">{SHOWCASE_ERROR_MESSAGES[error] ?? 'Bu paket şu an satın alınamıyor.'}</div> : null}

      {unavailable ? (
        <div className="vitrin-empty" data-testid="showcase-package-unavailable">
          <p style={{ margin: 0 }}>Bu paket şu an satın alınamıyor.</p>
          <Link className="pdash-btn pdash-btn-ghost" href={`/providers/${id}/vitrin`}>Vitrin kartlarıma dön</Link>
        </div>
      ) : (
        <PackagePicker providerId={id} packages={packages} terms={terms} returnCard={card ?? null} />
      )}
    </ProviderShell>
  );
}
```

- [x] **Step 3: Ödeme dönüş ekranı**

`odeme/[purchaseId]/page.tsx`:

```tsx
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { apiFetch, fetchOrNotFound, getCurrentUser, type PackagePurchase, type ProviderProfile } from '../../../../../../lib/api';
import { ProviderShell } from '../../../../provider-shell';
import { readCreditBalance } from '../../../../provider-data';

type Props = { params: Promise<{ id: string; purchaseId: string }>; searchParams: Promise<{ checkout?: string; card?: string }> };

/**
 * Where the provider lands after paying. Reads the canonical status from the
 * API — never the query string — and says one of three things: the right is
 * ready, the payment is still open, or nothing was granted.
 */
export default async function ShowcasePaymentReturnPage({ params, searchParams }: Props) {
  const { id, purchaseId } = await params;
  const { card } = await searchParams;
  const user = await getCurrentUser();
  if (!user) redirect(`/login?redirectTo=/providers/${id}/vitrin/odeme/${purchaseId}`);

  const [provider, creditBalance, purchase] = await Promise.all([
    fetchOrNotFound(() => apiFetch<ProviderProfile>(`/providers/${id}`)),
    readCreditBalance(id),
    fetchOrNotFound(() => apiFetch<PackagePurchase>(`/providers/${id}/package-purchases/${purchaseId}`)),
  ]);

  if (purchase.kind !== 'SHOWCASE_PACKAGE') {
    redirect(`/providers/${id}/package-purchases/${purchaseId}`);
  }

  const cardHref = card ? `/providers/${id}/vitrin/${card}` : null;
  const createHref = `/providers/${id}/vitrin/yeni`;
  const packagesHref = `/providers/${id}/vitrin/paketler${card ? `?card=${encodeURIComponent(card)}` : ''}`;
  const continueHref = purchase.providerCheckoutUrl ?? `/providers/${id}/package-purchases/${purchaseId}/checkout?return=vitrin${card ? `&card=${encodeURIComponent(card)}` : ''}`;

  return (
    <ProviderShell user={user} providerId={id} businessName={provider.businessName} active="showcase" creditBalance={creditBalance} status={provider.status}>
      <nav className="pdash-crumbs" aria-label="Breadcrumb">
        <Link href="/providers/me">Panelim</Link><span aria-hidden="true">/</span>
        <Link href={`/providers/${id}/vitrin`}>Vitrin kartlarım</Link><span aria-hidden="true">/</span>
        <span>Ödeme</span>
      </nav>

      {purchase.status === 'PAID' ? (
        <section className="vitrin-return" data-testid="showcase-payment-paid">
          <span className="kicker">{purchase.packageNameSnapshot}</span>
          <h1>Vitrin hakkınız hazır</h1>
          <p>{cardHref ? 'Hakkınızı bu karta bağlayıp yayına alabilirsiniz.' : 'Şimdi kartınızı oluşturun; incelemeden geçtiği an vitrinde yayına girer.'}</p>
          {cardHref
            ? <Link className="pdash-btn pdash-btn-primary" href={cardHref}>Kartı yayınla</Link>
            : <Link className="pdash-btn pdash-btn-primary" href={createHref} data-testid="showcase-create-after-payment">Şimdi kartınızı oluşturun</Link>}
        </section>
      ) : purchase.status === 'PENDING' ? (
        <section className="vitrin-return" data-testid="showcase-payment-pending">
          <span className="kicker">{purchase.packageNameSnapshot}</span>
          <h1>Ödemeniz henüz tamamlanmadı</h1>
          <p>Ödeme sayfanız hâlâ açık. Tamamladığınızda vitrin hakkınız burada hazır olacak.</p>
          <div className="pdash-form-foot" style={{ padding: 0 }}>
            <Link className="pdash-btn pdash-btn-ghost" href={packagesHref}>Paket seçimine dön</Link>
            <a className="pdash-btn pdash-btn-primary" href={continueHref}>Ödemeye devam et</a>
          </div>
        </section>
      ) : (
        <section className="vitrin-return" data-testid="showcase-payment-failed">
          <span className="kicker">{purchase.packageNameSnapshot}</span>
          <h1>Ödeme tamamlanmadı</h1>
          <p>Bu işlem için vitrin hakkı oluşmadı ve ücret alınmadı. Dilerseniz yeniden paket seçebilirsiniz.</p>
          <Link className="pdash-btn pdash-btn-primary" href={packagesHref}>Paket seçimine dön</Link>
        </section>
      )}
    </ProviderShell>
  );
}
```

`package-purchases/[purchaseId]/checkout/page.tsx`: `searchParams`'tan `card`'ı oku ve mock formun içine `<input type="hidden" name="returnCard" value={card ?? ''} />` ekle (Task 6'daki action bunu okur).

- [x] **Step 4: Rotaları kaydet ve testleri çalıştır**

`lib/panel-routes.ts`'e üç rotayı ekle (Task 6 Step 3). Run: `pnpm --filter @taktic/web test -- panel-routes`
Expected: `duzenle` sayfası henüz yoksa FAIL — Task 9'da geçer; şimdilik `paketler` ve `odeme` satırlarını ekle, `duzenle`'yi Task 9'da.

- [x] **Step 5: Commit**

```bash
git add -A apps/web
git commit -m "feat(web): vitrin merkezi, paket seçimi ve ödeme dönüş ekranı

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Kart oluşturma, kart ekranı (özet + yayın durumu), düzenleme görünümü ve sil/arşiv menüsü

**Files:**
- Modify: `apps/web/app/providers/[id]/vitrin/yeni/page.tsx`, `yeni/new-card-form.tsx`, `showcase-card-fields.tsx`
- Modify: `apps/web/app/providers/[id]/vitrin/[cardId]/page.tsx`
- Create: `apps/web/app/providers/[id]/vitrin/[cardId]/duzenle/page.tsx`, `apps/web/app/providers/[id]/vitrin/card-menu.tsx`
- Modify: `apps/web/app/providers/[id]/vitrin/[cardId]/edit-card-form.tsx` (yalnız yeni alanlar)
- Modify: `apps/web/lib/panel-routes.ts` (`'/providers/:id/vitrin/:cardId/duzenle'`)

- [x] **Step 1: Form alanlarını dört gruba böl**

`showcase-card-fields.tsx`: `pdash-form-section` bloklarını `vitrin-form-group` + `vitrin-form-group-head` ile yeniden düzenle; gruplar: **Temel bilgiler** (kart türü radio'ları `vitrin-choice-row`/`vitrin-choice`, `categorySlot`, başlık, özet, görsel), **Hizmet ve fiyat** (dahil/hariç, SERVICE'te fiyat), **Yanıt taahhüdü** (iki saat alanı). Bölgeler grubu formu çağıran sayfada (`ServiceAreaFields`) aynı `vitrin-form-group` sarmalayıcısıyla. Kopya: grup açıklamaları birer cümle; "Kapsam" başlığı "Hizmet ve fiyat" olur.

`yeni/page.tsx`: `publication` çek; `availableEntitlements.length === 0` ise `redirect(\`/providers/${id}/vitrin/paketler\`)`. Başlık `Vitrin kartını oluştur`, alt metin: "Kart onaylanınca otomatik yayına girer." Formun üstünde kullanılacak hak:

```tsx
<div className="pdash-notice" role="status" data-testid="showcase-entitlement-in-use">
  {rights.length === 1
    ? `Bu kart ${rights[0].packageName} hakkınızla oluşturulacak · ${rights[0].durationDays} gün yayın`
    : 'Kullanılacak hakkı seçin:'}
</div>
```

Birden çok hak varsa `<div className="vitrin-choice-row">` içinde `<label className="vitrin-choice"><input type="radio" name="entitlementId" value={r.id} defaultChecked={i===0} required /><span>{r.packageName} · {r.durationDays} gün</span></label>`. `createShowcaseCardAction` `entitlementId`'yi `readOptionalString` ile gövdeye ekler. Form sınıfı `vitrin-form`; foot `vitrin-form-foot`; CTA `Kartı oluştur`; `Vazgeç` ghost.

`NewShowcaseCardForm` kategori slot'u: `vitrin-form-group` yerine `pdash-form-row` içinde select (grup "Temel bilgiler"in parçası).

- [x] **Step 2: Sil/arşiv menüsü (client)**

`card-menu.tsx`:

```tsx
'use client';

import { useRef } from 'react';
import { archiveShowcaseCardAction } from './actions';

/**
 * The card's dangerous action, behind a menu and a dialog. The wording is the
 * product rule: a card that never went live is *deleted* and gives its right
 * back; a live card is *archived* and its paid days keep running.
 */
export function CardMenu({ providerId, cardId, published }: { providerId: string; cardId: string; published: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const label = published ? 'Kartı arşivle' : 'Kartı sil ve yayın hakkını serbest bırak';

  return (
    <>
      <details className="vitrin-menu">
        <summary className="pdash-btn pdash-btn-ghost pdash-btn-sm" aria-label="Diğer işlemler">⋯</summary>
        <div className="vitrin-menu-list" role="menu">
          <button type="button" role="menuitem" className="vitrin-menu-danger" onClick={() => dialog.current?.showModal()} data-testid="showcase-card-danger">{label}</button>
        </div>
      </details>

      <dialog ref={dialog} className="vitrin-dialog" aria-labelledby="vitrin-danger-title">
        <form action={archiveShowcaseCardAction} method="dialog">
          <input type="hidden" name="providerId" value={providerId} />
          <input type="hidden" name="cardId" value={cardId} />
          <input type="hidden" name="deleted" value={published ? '0' : '1'} />
          <h2 id="vitrin-danger-title">{label}</h2>
          <p>
            {published
              ? 'Kart yayından kalkar ve yeni talep almaz. Satın aldığınız vitrin süresi arşivdeyken de işlemeye devam eder; arşivde geçen günler süreye eklenmez.'
              : 'Kart kaldırılır. Bu karta bağlı vitrin hakkınız yeniden kullanılabilir olur; yeni bir kart için kullanabilirsiniz.'}
          </p>
          <div className="vitrin-form-foot" style={{ paddingBottom: 0 }}>
            <button type="button" className="pdash-btn pdash-btn-ghost" onClick={() => dialog.current?.close()}>Vazgeç</button>
            <button type="submit" className="pdash-btn pdash-btn-danger" data-testid="showcase-card-danger-confirm">{published ? 'Arşivle' : 'Sil ve hakkı serbest bırak'}</button>
          </div>
        </form>
      </dialog>
    </>
  );
}
```

(`method="dialog"` server action ile çakışırsa kaldır; `formAction` server action'dır ve `<dialog>` içinde normal çalışır.)

- [x] **Step 3: Kart ekranı**

`[cardId]/page.tsx` — baştan; veri: `provider`, `card`, `creditBalance`, `publication` (`price-terms`, `eligibility`, `packages`, `provinces` **çekilmez**):

```tsx
const entry = publication?.cards.find((e) => e.cardId === cardId);
const hasAvailableRight = (publication?.availableEntitlements.length ?? 0) > 0;
const stage = showcaseStage(entry, { providerId: id, cardId, hasAvailableRight });
const shown = card.liveVersion ?? card.draftVersion;
const rejection = lastRejection(card);
const published = entry ? ['LIVE', 'ACTIVATING', 'PAUSED'].includes(entry.state) : false;
```

Yapı:

```tsx
<header className="pdash-page-head">
  <span className="kicker">{SHOWCASE_CARD_KIND_LABELS[card.kind]} · {card.category.name}</span>
  <h1 className="pdash-page-title">{shown?.title ?? 'Vitrin kartı'}</h1>
</header>
{/* notices: error/saved/submitted/withdrawn/archived/unarchived/published */}
<div className="vitrin-summary">
  <section aria-labelledby="vitrin-ozet">
    <h2 id="vitrin-ozet" className="vitrin-section-title" style={{ marginTop: 0 }}>Kart özeti</h2>
    {shown ? <ShowcaseCardFace card={faceFromVersion(card, shown)} badge={<span className={`vitrin-badge vitrin-badge-${stage.badge}`}>{stage.label}</span>} testId="showcase-card-face" /> : null}
    {shown ? (
      <div className="vitrin-summary-facts" style={{ marginTop: 16 }}>
        <div><h2>Dahil olanlar</h2><ul className="showcase-list">{shown.scopeIncluded.map((i) => <li key={i}>{i}</li>)}</ul></div>
        <div><h2>Hariç olanlar</h2><ul className="showcase-list">{shown.scopeExcluded.map((i) => <li key={i}>{i}</li>)}</ul></div>
        <div><h2>Yanıt taahhüdü</h2><p>Acil: en geç {shown.responseSlaUrgentHours} saat · Normal: en geç {shown.responseSlaNormalHours} saat</p></div>
      </div>
    ) : null}
    {entry?.hasPendingRevision ? <p className="muted" style={{ marginTop: 12 }}>Yaptığınız değişiklik incelemede. Yayındaki metin şimdilik aynı kalıyor.</p> : null}
  </section>

  <aside className="vitrin-status" data-testid="showcase-status-panel" aria-labelledby="vitrin-durum">
    <div className="vitrin-status-head">
      <h2 id="vitrin-durum">{statusHeading(entry?.state, entry)}</h2>
      {card.status !== 'SUSPENDED' && card.status !== 'ARCHIVED' ? <CardMenu providerId={id} cardId={cardId} published={published} /> : null}
    </div>
    {entry?.state === 'LIVE' && entry.endAt ? <p>Yayın bitişi: {formatDate(entry.endAt)}{entry.packageName ? ` · ${entry.packageName}` : ''}</p> : null}
    {entry?.state === 'LIVE' ? <p>Bu yayından gelen talep: {entry.leadCount}</p> : null}
    {stage.detail && entry?.state !== 'LIVE' ? <p>{stage.detail}</p> : null}
    {rejection && (entry?.state === 'REJECTED') ? <p className="vitrin-status-note"><strong>İnceleme notu:</strong> {rejection.note}</p> : null}
    <StageAction stage={stage} providerId={id} cardId={cardId} />
    {entry?.state === 'IN_REVIEW' ? (
      <form action={withdrawShowcaseSubmissionAction}><input type="hidden" name="providerId" value={id} /><input type="hidden" name="cardId" value={cardId} />
        <button className="pdash-btn pdash-btn-ghost pdash-btn-sm" type="submit">İncelemeyi geri çek</button></form>
    ) : null}
    {card.status === 'ARCHIVED' ? (
      <form action={unarchiveShowcaseCardAction}><input type="hidden" name="providerId" value={id} /><input type="hidden" name="cardId" value={cardId} />
        <button className="pdash-btn pdash-btn-secondary" type="submit">Arşivden çıkar</button></form>
    ) : null}
    {entry && !['IN_REVIEW', 'ARCHIVED', 'SUSPENDED'].includes(entry.state) ? (
      <Link className="pdash-btn pdash-btn-ghost" href={`/providers/${id}/vitrin/${cardId}/duzenle`} data-testid="showcase-edit-link">Kartı düzenle</Link>
    ) : null}
  </aside>
</div>
```

`statusHeading`:

```ts
function statusHeading(state: ShowcasePublicationState | undefined, entry: ShowcaseCardPublication | undefined): string {
  switch (state ?? 'DRAFT') {
    case 'DRAFT': return 'Kartınızı incelemeye gönderin';
    case 'IN_REVIEW': return 'Kartınız inceleniyor';
    case 'REJECTED': return entry?.needsPackage ? 'Kartınız reddedildi' : 'Kartınızda düzenleme gerekiyor';
    case 'NEEDS_PACKAGE': return 'Kartınız pakete hazır';
    case 'EXPIRED': return entry?.hasRunBefore ? 'Yayın süreniz doldu' : 'Kartınız pakete hazır';
    case 'LIVE': case 'ACTIVATING': return 'Kartınız yayında';
    case 'PAUSED': return 'Kartınız geçici olarak görünmüyor';
    case 'ARCHIVED': return 'Kart arşivde';
    case 'SUSPENDED': return 'Kartınız durduruldu';
  }
}
```

`published` bildirimi: `?published=1` → "Kartınız vitrinde yayına girdi."

- [x] **Step 4: Düzenleme görünümü**

`[cardId]/duzenle/page.tsx`: `card`, `provider`, `provinces`, `publication` çek; `underReview` (draft PENDING) veya `ARCHIVED/SUSPENDED` ise `redirect(\`/providers/${id}/vitrin/${cardId}\`)`. Başlık `Kartı düzenle`; canlı sürüm varsa tek cümle notice: "Değişiklikler yeniden incelemeye girer; yayındaki metin onaya kadar aynı kalır." Form: `updateShowcaseCardAction`, `vitrin-form`, `EditShowcaseCardForm` (kind sabit, kategori slot'u salt okunur) + bölgeler grubu (`ServiceAreaFields`) + foot: `Vazgeç` (kart ekranına) / `Kaydet`. `updateShowcaseCardAction` başarıda `${target}?saved=1` (kart ekranı) — mevcut.

- [x] **Step 5: Rota, typecheck, testler**

`panel-routes.ts`'e `'/providers/:id/vitrin/:cardId/duzenle'` ekle (statik `paketler`, `odeme/:purchaseId` satırlarının `:cardId` satırından **önce** olduğundan emin ol — listede sıra okunabilirlik içindir ama `yeni` gibi statik segmentler `:cardId`'den önce yazılır).

Run: `pnpm --filter @taktic/web typecheck && pnpm --filter @taktic/web lint && pnpm --filter @taktic/web test`
Expected: PASS — `panel-routes` ve `showcase-legacy-routes` dahil.

- [x] **Step 6: Commit**

```bash
git add -A apps/web
git commit -m "feat(web): kart oluşturma, özet + yayın durumu ekranı, ayrı düzenleme ve sil/arşiv menüsü

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Müşteri tarafı — raf ve kart detayı aynı yüzü çizer

**Files:**
- Modify: `apps/web/app/showcase-shelf.tsx`, `apps/web/app/vitrin/page.tsx`, `apps/web/app/vitrin/[cardId]/page.tsx`
- Modify: `apps/web/app/categories/[slug]/showcase-matches.tsx` (yalnız `ShowcaseShelfCard` importu kullanıyorsa)

- [x] **Step 1: Raf**

`showcase-shelf.tsx` `ShowcaseShelfCard`:

```tsx
export function ShowcaseShelfCard({ card }: { card: ShowcaseFeedCard }) {
  return (
    <div data-testid="showcase-shelf-card">
      <ShowcaseCardFace card={faceFromFeedCard(card)} href={`/vitrin/${card.cardId}`} testId="showcase-card-face" />
      <div className="vitrin-card-foot">
        <p className="muted">Acil: {card.responseSlaUrgentHours} saat · Normal: {card.responseSlaNormalHours} saat içinde dönüş</p>
        <Link className="pdash-btn pdash-btn-primary" href={`/vitrin/${card.cardId}`}>Bu hizmeti incele</Link>
      </div>
    </div>
  );
}
```

Grid: `showcase-shelf-grid` → `vitrin-grid`. `areaSentence` export'u kalır (public sayfa kullanır). Kalan raf başlığı/metni aynen.

- [x] **Step 2: Kart detayı**

`vitrin/[cardId]/page.tsx`: `lp-container showcase-public` içini iki kolona ayır:

```tsx
<div className="vitrin-public">
  <div className="showcase-public-body">
    <ShowcaseCardFace card={faceFromFeedCard(card)} testId="showcase-card-face" />
    <p className="showcase-coverage-note" data-testid="showcase-card-coverage-note">Bu hizmet yalnız {coverage} kapsamındaki işler için sunulur.</p>
    <div className="vitrin-summary-facts">
      <div><h2>Dahil olanlar</h2>…</div>
      <div><h2>Hariç olanlar</h2>…</div>
      <div><h2>Yanıt taahhüdü</h2><p>Acil: {…} saat · Normal: {…} saat içinde dönüş</p></div>
      <p className="muted">Bu işletme, hizmet bedelini ve kapsamını kendisi belirler ve müşterisinden kendisi tahsil eder. TakTick bu bedele taraf değildir.</p>
    </div>
  </div>
  {/* sağ kolon: mevcut showcase-public-cta bloğu — adım mantığı, AreaNotServed, Devam et / Vazgeç aynen */}
</div>
```

Header'daki `showcase-area-badge` paragrafı ve ayrı fiyat paragrafı kaldırılır (yüz bunları taşır; `data-testid="showcase-card-area"` ve `showcase-card-price` yüz içinde). `h1` başlık kalır (erişilebilirlik); yüzdeki `h3` başlık tekrar eder — yüzü `compact` değil tam çiz, `h1` ise `lp-section-head` içinde kalır.

- [x] **Step 3: Görsel doğrulama**

Dev sunucusunu `.claude/launch.json` ile aç (`web` girdisi yoksa oluştur: `pnpm --filter @taktic/web dev`, port 3000; API için `taktic-api` container'ı **ana checkout**'u çalıştırır — worktree API'sini görmek için `pnpm --filter @taktic/api dev`'i 3001'de ayrıca çalıştırma; bunun yerine E2E'ye güven). Playwright ile ekran görüntüleri Task 12'de alınır.

Run: `pnpm --filter @taktic/web typecheck && pnpm --filter @taktic/web lint && pnpm --filter @taktic/web test`
Expected: PASS.

- [x] **Step 4: Commit**

```bash
git add -A apps/web
git commit -m "feat(web): ana sayfa rafı ve kart detayı tek kart yüzüyle çizilir

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: Admin — menü, paket geçerlilik alanı, inceleme detayında yayın hakkı

**Files:**
- Modify: `apps/admin/lib/nav.ts`, `apps/admin/lib/api.ts`
- Modify: `apps/admin/app/showcase/packages/page.tsx`, `packages/actions.ts`
- Modify: `apps/admin/app/showcase/reviews/[versionId]/page.tsx`, `reviews/[versionId]/actions.ts`
- Modify: `apps/admin/app/showcase/price-terms/page.tsx`

- [x] **Step 1: Menü**

`lib/nav.ts`: Operasyon altında `Kart incelemeleri`, `Yayındaki kartlar`, `Vitrin talepleri`; Katalog altında `'/showcase/packages'` etiketi `Paketler`. (`/credit-packages` `Kredi Paketleri` kalır.)

- [x] **Step 2: Tipler ve paket formu**

`lib/api.ts`: `ShowcasePackage`'a `activationWindowDays: number`; `ShowcaseVersionDetail`'a `entitlement: { packageName: string; durationDays: number; expiresAt: string; pausedForReview: boolean; valid: boolean } | null`; şart kabulü listesi tipine `scope: 'CARD' | 'PACKAGE'` ve `cardId: string | null`.

`packages/page.tsx` create/edit formlarına `durationDays` alanının yanına:

```tsx
<label className="form-row">
  <span>Kullanılmamış hakkın geçerliliği (gün)</span>
  <input name="activationWindowDays" type="number" min={1} max={365} step={1} defaultValue={pkg?.activationWindowDays ?? 90} required />
  <small>Ödemeden itibaren kartın onaylanıp yayına girmesi için tanınan süre. İnceleme süresi sayılmaz.</small>
</label>
```

`packages/actions.ts`: gövdeye `activationWindowDays: Number(readString(formData, 'activationWindowDays'))`. Liste tablosuna `Geçerlilik` kolonu (`{pkg.activationWindowDays} gün`).

- [x] **Step 3: İnceleme detayı**

`reviews/[versionId]/page.tsx`: "İşletme" `SectionCard`'ının altına, yalnız `card.liveVersion === null` (ilk yayın) iken:

```tsx
<SectionCard title="Yayın hakkı">
  {version.entitlement ? (
    <p data-testid="review-entitlement">
      {version.entitlement.packageName} · {version.entitlement.durationDays} gün yayın ·{' '}
      {version.entitlement.pausedForReview
        ? 'inceleme süresince geçerliliği durduruldu'
        : `${formatDateTime(version.entitlement.expiresAt)} tarihine kadar geçerli`}
    </p>
  ) : (
    <div className="notice notice-error" role="alert" data-testid="review-entitlement-missing">
      Bu kartın geçerli bir yayın hakkı yok. Sağlayıcı vitrin paketi almadan kart onaylanıp yayına alınamaz.
    </div>
  )}
</SectionCard>
```

Onay butonunun `disabled`'ı: `!isPending || (card.liveVersion === null && !version.entitlement?.valid)`; yanında kısa neden. `actions.ts` `run()` hata haritasına: `SHOWCASE_ENTITLEMENT_MISSING` → API mesajı aynen (zaten Türkçe); `SHOWCASE_AREA_NOT_COVERED`/`SHOWCASE_CATEGORY_NOT_OFFERED` → API mesajı. Onay başarı bildirimi: "Sürüm onaylandı; kart vitrinde yayına girdi." (ilk yayın) / "Sürüm onaylandı ve yayındaki metin güncellendi." (revizyon) — sayfa `card.liveVersion` durumuna göre seçer.

`price-terms/page.tsx`: tabloya `Kapsam` kolonu (`Paket` / `Kart`), kart kolonu boşsa `—`.

- [x] **Step 4: Doğrula ve commit**

Run: `pnpm --filter @taktic/admin typecheck && pnpm --filter @taktic/admin lint && pnpm --filter @taktic/admin test`
Expected: PASS.

```bash
git add -A apps/admin
git commit -m "feat(admin): sade vitrin menüsü, paket geçerlilik günü ve incelemede yayın hakkı

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: E2E — yeni akış, mevcut spec'lerin taşınması, viewport ve ekran görüntüsü kanıtı

**Files:**
- Create: `e2e/tests/showcase-package-first-flow.spec.ts`, `e2e/tests/showcase-screens-viewport.spec.ts`
- Modify: `e2e/tests/showcase-cards.spec.ts`, `e2e/tests/showcase-placement-lead.spec.ts`

**Interfaces:**
- Consumes: fixtures `createProvider({ categoryId, location, credits })`, `createAdmin()`, `createCustomer()`, `createCategory(depth, { namePrefix })`, `uniqueLocation()`, `prisma()`; `Actor.open(browser, 'web'|'admin', primaryRuntime)`, `loginToWeb`, `loginToAdmin`, `gotoWeb`, `gotoAdmin`, `assertNoErrorScreen`. Mock ödeme formu etiketleri: `Kart Üzerindeki İsim`, `Kart Numarası`, `Ay`, `Yıl`, `CVV`; buton `Ödemeyi Tamamla` (dosyadaki gerçek metni kullan). Test kart numarası `4111 1111 1111 1111`; `…0000` ile biten reddedilir.

- [x] **Step 1: Yeni akış spec'i**

`e2e/tests/showcase-package-first-flow.spec.ts` (paylaşılan yardımcılar `showcase-cards.spec.ts`'ten kopyalanır: `fillCardContent`, `addArea`, `expectNoHorizontalOverflow`, `seedShowcasePackage`):

```ts
test.describe('vitrin: paket-önce akış', () => {
  test('paketsiz sağlayıcı kart açamaz; paket alır, kart oluşturur, onay sonrası otomatik yayına girer', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(3, { namePrefix: 'E2E Vitrin Paket' });
    const owner = await createProvider({ categoryId: category.id, location, credits: 0 });
    const adminAccount = await createAdmin();
    const pkg = await seedShowcasePackage();
    const provider = await Actor.open(browser, 'web', primaryRuntime);
    const admin = await Actor.open(browser, 'admin', primaryRuntime);

    try {
      await provider.loginToWeb(owner.email, owner.password);
      await provider.gotoWeb(`/providers/${owner.id}/vitrin`);
      await assertNoErrorScreen(provider.page);

      // 1. No package: the only door is the package.
      await expect(provider.page.getByRole('heading', { name: 'Vitrinde yer alın' })).toBeVisible();
      await expect(provider.page.getByRole('link', { name: 'Yeni vitrin kartı' })).toHaveCount(0);
      await expect(provider.page.getByTestId('showcase-create-card')).toHaveCount(0);
      await provider.gotoWeb(`/providers/${owner.id}/vitrin/yeni`);
      await expect(provider.page).toHaveURL(/\/vitrin\/paketler/);

      // 2. Pick a package, accept, pay.
      await provider.gotoWeb(`/providers/${owner.id}/vitrin`);
      await provider.page.getByTestId('showcase-buy-package').click();
      const pay = provider.page.getByTestId('showcase-pay');
      await expect(pay).toBeDisabled();
      await provider.page.getByTestId('showcase-package-option').filter({ hasText: pkg.name }).click();
      await expect(pay).toBeDisabled();
      await expect(provider.page.getByTestId('showcase-pay-reason')).toHaveText('Devam etmek için sorumluluk metnini kabul edin.');
      await provider.page.getByTestId('showcase-package-consent').click();
      await expect(pay).toBeEnabled();
      await pay.click();

      await expect(provider.page).toHaveURL(/package-purchases\/.+\/checkout/);
      await provider.page.getByLabel('Kart Üzerindeki İsim').fill('E2E Sağlayıcı');
      await provider.page.getByLabel('Kart Numarası').fill('4111111111111111');
      await provider.page.getByLabel('CVV').fill('123');
      await provider.page.getByRole('button', { name: /Ödeme/ }).click();

      // 3. Return screen.
      await expect(provider.page).toHaveURL(/\/vitrin\/odeme\//);
      await expect(provider.page.getByRole('heading', { name: 'Vitrin hakkınız hazır' })).toBeVisible();
      expect(await prisma().showcaseEntitlement.count({ where: { providerId: owner.id, status: 'AVAILABLE' } })).toBe(1);
      await provider.page.getByTestId('showcase-create-after-payment').click();

      // 4. Create the card (no terms checkbox anywhere on this form).
      await expect(provider.page.getByRole('heading', { name: 'Vitrin kartını oluştur' })).toBeVisible();
      await expect(provider.page.getByTestId('showcase-entitlement-in-use')).toContainText(pkg.name);
      await provider.page.getByLabel('Kategori *').selectOption({ label: category.name });
      await fillCardContent(provider.page, { title: 'E2E Paketli Klima', summary: 'Standart kapsamda klima bakımı ve filtre temizliği.', included: 'Filtre temizliği\nGaz basıncı kontrolü', excluded: 'Gaz dolumu', price: '1500' });
      await addArea(provider.page, location.city, location.district);
      await provider.page.getByRole('button', { name: 'Kartı oluştur' }).click();

      // 5. Card screen: summary + one status panel + one CTA.
      await expect(provider.page.getByRole('heading', { name: 'Kartınızı incelemeye gönderin' })).toBeVisible();
      await expect(provider.page.getByTestId('showcase-card-face')).toContainText(`${location.district}, ${location.city}`);
      await expect(provider.page.getByText('sürüm', { exact: false })).toHaveCount(0);
      await expect(provider.page.getByText('TakTick bu hizmet bedelini tahsil etmez', { exact: false })).toHaveCount(0);
      await provider.page.getByRole('button', { name: 'İncelemeye gönder' }).click();
      await expect(provider.page.getByRole('heading', { name: 'Kartınız inceleniyor' })).toBeVisible();
      expect((await prisma().showcaseEntitlement.findFirstOrThrow({ where: { providerId: owner.id } })).reviewPausedAt).not.toBeNull();

      // 6. Admin sees the right and approves; the card is live at once.
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin('/showcase/reviews');
      await admin.page.getByRole('link', { name: 'E2E Paketli Klima' }).click();
      await expect(admin.page.getByTestId('review-entitlement')).toContainText(pkg.name);
      await admin.page.getByRole('button', { name: 'Onayla' }).click();
      await expect(admin.page.getByText('vitrinde yayına girdi', { exact: false })).toBeVisible();
      expect(await prisma().showcasePlacement.count({ where: { cardId: (await prisma().showcaseCard.findFirstOrThrow({ where: { providerId: owner.id } })).id, status: 'ACTIVE' } })).toBe(1);
      expect(await prisma().showcaseEntitlement.count({ where: { providerId: owner.id, status: 'CONSUMED' } })).toBe(1);

      // 7. Provider sees "Yayında"; a visitor with no location sees the card on the home page.
      await provider.gotoWeb(`/providers/${owner.id}/vitrin`);
      await expect(provider.page.getByTestId('showcase-card').first()).toHaveAttribute('data-state', 'LIVE');
      await expect(provider.page.getByTestId('pdash-nav-showcase-leads')).toBeVisible();
      const visitor = await Actor.open(browser, 'web', primaryRuntime);
      try {
        await visitor.gotoWeb('/');
        await expect(visitor.page.getByTestId('showcase-shelf').getByText('E2E Paketli Klima')).toBeVisible();
      } finally { await visitor.close(); }
    } finally {
      await provider.close();
      await admin.close();
    }
  });

  test('red → düzenle → yeniden gönder → onay: hak bir kez tüketilir', async ({ browser }) => { /* API'de kanıtlandı; UI: reddedilen kartta "Düzenle ve yeniden gönder" linki, düzenleme sayfası, kaydet, "İncelemeye gönder", admin onayı, DB'de CONSUMED=1 ve REJECTED pause satırı */ });

  test('yayınlanmamış kartı silmek hakkı serbest bırakır', async ({ browser }) => { /* kart oluştur → ⋯ → "Kartı sil ve yayın hakkını serbest bırak" → onay diyaloğu → listede "Kart silindi" bildirimi ve sayaç "1 kullanılabilir vitrin hakkınız var" */ });

  test('süresi dolmuş kart yeni paket ister ve tek tıkla yeniden yayınlanır', async ({ browser }) => { /* seedApprovedCard + seedLivePlacement (legacy) → placement EXPIRED yap → listede "Süresi doldu" + "Yeniden yayınla" paket sayfasına gider → paket al → dönüşte "Kartı yayınla" → kart ekranında "Yeniden yayınla" → "Kartınız yayında" */ });

  test('paket tanımlı değilken ekran teknik terim içermez', async ({ browser }) => { /* paket seed etme → /vitrin/paketler → "Bu paket şu an satın alınamıyor." görünür; "variant", "PACKAGE_NOT_MAPPED", "Lemon" metinleri 0 */ });
});
```

Yorum içindeki üç test gövdesi tam yazılır (yorum bırakılmaz): her biri ilk testteki adımların alt kümesidir; assert'ler yorumda listelenen ifadelerdir.

- [x] **Step 2: Viewport ve ekran görüntüsü spec'i**

`e2e/tests/showcase-screens-viewport.spec.ts`: `[320, 768, 1024, 1440]` genişliklerinde şu ekranlar için `expectNoHorizontalOverflow` + `page.screenshot({ path: \`test-results/showcase-screens/${name}-${width}.png\`, fullPage: true })`: `/vitrin` (hak var, 2 kart: biri LIVE biri DRAFT), `/vitrin/paketler`, `/vitrin/yeni`, `/vitrin/:cardId` (DRAFT), `/vitrin/:cardId/duzenle`, `/vitrin/odeme/:purchaseId` (PAID), public `/` rafı, public `/vitrin/:cardId`, admin `/showcase/reviews/:versionId`. Kurulum DB seed'leriyle (Task 12 Step 1'deki yardımcılar + `showcaseEntitlement.create` doğrudan yazım: `status: 'AVAILABLE'`, `grantedAt: now`, `expiresAt: now+90g`, snapshot alanları).

- [x] **Step 3: Mevcut spec'leri taşı**

`showcase-cards.spec.ts`: her testte kart açmadan önce `seedEntitlement(owner.id)` (paket seed + `packagePurchase` PAID + `showcaseEntitlement` AVAILABLE); `'Yeni vitrin kartı'` → `showcase-create-card` testid; `'Taslağı kaydet'` → `'Kartı oluştur'`; `acceptPriceTerms` çağrıları ve `'Onaya gönder'` → `'İncelemeye gönder'`; "Şart onayı bekliyor"/"Şartları onayla"/publish panel/`Ödemeye geç` bölümleri **silinir** (onay sonrası doğrudan `data-state="LIVE"` beklenir); geri çekme testi `'İncelemeyi geri çek'` aynı; genel tanıtım testi aynı; daraltma testi canlı kart ister → onaydan sonra zaten canlı. Dar ekran testleri yeni sayfa yollarını da ekler (`paketler`, `duzenle`).

`showcase-placement-lead.spec.ts`: `seedLivePlacement` legacy şekil **kalır**; "hizmet veren yayındaki süresini … görür" testinde `'Vitrin yayını'` başlığı → `'Kartınız yayında'`, `showcase-live-until` → `getByText('Yayın bitişi')`, arşiv cümlesi → ⋯ menüsü açılıp diyalogdaki `'arşivdeyken de işlemeye devam eder'`. Diğer testler (feed, lead, area-not-served, admin suspend) selector'ları `showcase-card-face` yüzüne göre güncellenir (`showcase-card-area`, `showcase-card-price` testid'leri korunur).

- [x] **Step 4: Çalıştır**

Portları temizle: `for p in 3200 3201 3202 $(seq 3210 3242); do lsof -ti tcp:$p | xargs -r kill -9; done`
Run: `DATABASE_URL='postgresql://taktic_user:taktic_password@localhost:5433/taktic?schema=public' pnpm e2e -- showcase` sonra `… pnpm e2e:webkit -- showcase`
Expected: tüm showcase spec'leri iki tarayıcıda PASS; `e2e/test-results/showcase-screens/*.png` üretilir. PNG'leri `docs/superpowers/plans/2026-09-11-vitrin-screens/` altına kopyala (teslim kanıtı; yalnız 320 ve 1440 genişlikler, 9 ekran → 18 dosya).

- [x] **Step 5: Commit**

```bash
git add -A e2e docs/superpowers/plans/2026-09-11-vitrin-screens
git commit -m "test(e2e): paket-önce vitrin akışı, viewport taşma ve ekran görüntüsü kanıtı

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 13: Tam doğrulama, PR ve teslim raporu

**Files:**
- Modify: `docs/superpowers/plans/2026-09-11-vitrin-package-first-flow.md` (checkbox'lar), Create: `docs/superpowers/plans/2026-09-11-vitrin-teslim-raporu.md`

- [x] **Step 1: Kök komutlar**

Run (kökten, sırayla): `pnpm typecheck`, `pnpm lint`, `DATABASE_URL='postgresql://taktic_user:taktic_password@localhost:5433/taktic?schema=public' pnpm test`, `pnpm build`
Expected: dördü de temiz. Hata varsa ilgili task'a dön.

- [x] **Step 2: Tam E2E (Chromium + WebKit)**

Run: `DATABASE_URL='…' pnpm e2e` ve `DATABASE_URL='…' pnpm e2e:webkit` (önce portları temizle).
Expected: tüm spec'ler PASS.

- [x] **Step 3: Teslim raporu**

`docs/superpowers/plans/2026-09-11-vitrin-teslim-raporu.md` — brief'in istediği beş başlık:
1. **Hakkın geçerlilik süresi nasıl belirlendi?** `ShowcasePackage.activationWindowDays` DEFAULT 90; gerekçe (spec §2.1); inceleme süresinin sayılmaması (§2.5) ve denetim tablosu.
2. **Mevcut veri migration'dan nasıl etkilenmedi?** Dry-run çıktısı (`2026-09-11-vitrin-migration-dryrun.txt`): satır sayıları ve md5'ler öncesi=sonrası; CHECK'in legacy dalı; hiçbir UPDATE/DELETE yok.
3. **Eski kart-first akışının kaldırılan/dönüştürülen ekranları:** `PublishPanel` (kart içi paket satışı) silindi → `/vitrin/paketler`; kart ekranındaki "İncelemeye gönder" şart kutusu kaldırıldı; "Şart onayı bekliyor / Yayına hazır / Ödeme bekliyor" durumları kalktı; `/placements/checkout`, `/placements/eligibility`, kart `price-terms(-acceptances)` uçları kaldırıldı (sıfır-referans testi + 404 spec'i); `/vitrin/odeme/:purchaseId` rotası eklendi (Lemon dönüşü artık 404 değil).
4. **Yeni kullanıcı akışı ekran ekran:** Vitrinde yer alın → Vitrin paketi al → (sorumluluk kabulü) Güvenli ödemeye geç → Vitrin hakkınız hazır → Vitrin kartını oluştur → Kartınızı incelemeye gönderin → Kartınız inceleniyor → (admin Onayla) Kartınız yayında → ana sayfa rafı → Bu hizmeti incele → Devam et / Vazgeç → adres → kapsam dışı reddi.
5. **Migration dry-run ve veri bütünlüğü kanıtı:** aynı dosya + `showcase-entitlement-lifecycle` şema testi.
Ayrıca ekran görüntüsü dizini ve E2E/`pnpm test` özetleri.

- [x] **Step 4: PR**

```bash
git push -u origin claude/vitrin-package-flow-redesign-27b4ed
gh pr create --base main --title "feat(showcase): vitrin paket-önce akışı ve arayüz yeniden tasarımı (VIT-DESIGN-002)" --body-file docs/superpowers/plans/2026-09-11-vitrin-teslim-raporu.md
```

PR gövdesinin sonuna `🤖 Generated with [Claude Code](https://claude.com/claude-code)` eklenir. CI sonucu `mcp__ccd_pr` araçlarıyla izlenir; **merge edilmez**.
