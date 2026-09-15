# Hizmet Veren Puanlama ve Müşteri Değerlendirmesi — Kesin Tasarım ve Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Tarih: 2026-09-15 · Durum: **kesin (rev. 2)** — ürün kararları kapandı, uygulamaya hazır ·
Taslak tasarım: `docs/superpowers/specs/2026-09-15-provider-rating-design.md` (bu doküman onu
kesinleştirir ve yerine geçer) · Önceki iş: PR #77 (anında yayın + talep bildirimi), PR #78 (CI
tmpfs), PR #75 (kimlik gate)

**Goal:** Tamamlanmış (`COMPLETED`) bir talebin sahibi müşterinin, kabul edilmiş teklifin sahibi
hizmet vereni 1–5 yıldız + isteğe bağlı yorumla bir kez değerlendirmesi; aggregate'in public
profil, teklif kartı, vitrin feed ve vitrin kart detayında 3-eşiğiyle gösterilmesi; sağlayıcı
bildirimi + admin moderasyonu; dört e-posta; hiçbir kredi/ödeme/vitrin hakkına dokunmadan.

**Architecture:** Yeni `ProviderReviewsModule` (NestJS) üç tablo (`ProviderReview`,
`ProviderReviewReport`, `ProviderReviewModeration`) üzerinde çalışır; hizmet veren
`ServiceRequest.matchedOfferId → Offer.providerId` zincirinden sunucuda türetilir; aggregate
`GROUP BY` ile anlık hesaplanır (`removedAt IS NULL`); `COMPLETED` geçişi serializable
transaction'a alınıp davet niyeti `NotificationLog` intent satırı olarak aynı transaction'da
yazılır ve mevcut outbox sweep'iyle teslim edilir; diğer üç mail commit sonrası `sendEmailOnce`
ile gider. Web'de üç yeni rota (`/requests/[id]/degerlendir`, `/providers/[id]/degerlendirmeler`,
`/isletme/[id]`), admin'de kuyruk + detay; `OperationsSettings.providerReviewsEnabled`
fail-closed anahtarı.

**Tech Stack:** NestJS 10 + Prisma 6 + PostgreSQL (API), Next.js App Router (web/admin),
class-validator DTO'ları, vitest + supertest (API), Playwright Chromium + WebKit (E2E), pnpm 9
monorepo.

## Global Constraints

- Migration yalnız **ek** (additive): mevcut tablolara sütun eklenmez (tek istisna
  `OperationsSettings.providerReviewsEnabled BOOLEAN NOT NULL DEFAULT false`); backfill yok.
- `apps/api` `@taktic/shared` TS girişini **import edemez**; yalnız `packages/shared/*.json`
  (bkz. `apps/api/src/common/service-request-limits.ts:3-16`). Yeni sabitler `limits.json`'a.
- Değerlendirme penceresi `COMPLETED` anından itibaren **90 gün** (`completedAt + 90d`).
- Public aggregate eşiği: **en az 3** kaldırılmamış değerlendirme; altında yıldız/ortalama/sayı
  **gösterilmez**, metin: **"Henüz yeterli değerlendirme yok"**.
- Yorum ≤ **600** UTF-16 kod birimi (`MaxCodeUnitLength`); rapor/moderasyon notu ≤ 500.
- Rapor bütçesi: sağlayıcı başına **20/gün** (DB sayımı, `REPORT_MAX_PER_PROVIDER_PER_DAY` ile aynı).
- Yorum metni hiçbir e-postaya yazılmaz; hiçbir public/provider projeksiyonu müşteri adı,
  telefon, e-posta, `customerUserId` taşımaz; public `createdAt` ay hassasiyetindedir.
- Yorum web'de yalnız React text child olarak render edilir; `dangerouslySetInnerHTML` yasak.
- Dört şablon: `review-invitation`, `review-received`, `review-report-new-for-support`,
  `review-removed`; `TRANSACTIONAL_EMAIL_TEMPLATES` 41 → **45**
  (`apps/api/test/transactional-email-render.spec.ts:520` güncellenir).
- Testler: API `DATABASE_URL='postgresql://taktic_user:taktic_password@localhost:5433/taktic?schema=public' pnpm --filter @taktic/api test <dosya>`;
  worktree'de önce `pnpm db:generate`. E2E **her zaman** `pnpm e2e <filtre>` (`--` yok).
- Commit mesajı sonu: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Kullanıcıya görünen tüm metinler Türkçe; kod ve yorumlar İngilizce (repo kalıbı).

---

# BÖLÜM A — Kesinleşmiş tasarım

## A1. Ürün kararları (kapalı)

| # | Karar | Uygulama noktası |
|---|---|---|
| 1 | Yalnız talep sahibi müşteri, `COMPLETED` sonrası | `POST /service-requests/:id/review`, `@Roles(CUSTOMER)`, `customerId === user.id`, `status === COMPLETED` |
| 2 | Tek `ProviderReview` (marketplace + vitrin direct lead) | Direct lead aynı `Offer/ServiceRequest` zincirinde — `providers.service.ts:1372-1389` |
| 3 | `requestId + providerId` tek; provider sunucuda türetilir | `@@unique([requestId, providerId])`, `offerId @unique`, `matchedOffer.providerId` |
| 4 | 1–5 zorunlu, yorum isteğe bağlı | DTO `@IsInt @Min(1) @Max(5)`; CHECK `rating BETWEEN 1 AND 5` |
| 5 | v1 değişmez, müşteri silemez | `PATCH/DELETE` yok; yalnız admin moderasyonu |
| 6 | 90 gün pencere | `PROVIDER_REVIEW_WINDOW_DAYS = 90`, 409 `REVIEW_WINDOW_CLOSED` |
| 7 | Aggregate anlık, `removedAt IS NULL` | `providerReview.groupBy` + partial index |
| 8–9 | Public ≥3, altında "Henüz yeterli değerlendirme yok" | `PublicReviewSummary \| null`; `limits.json.providerReviewPublicMinCount = 3` |
| 10–11 | Profil + teklif kartı + vitrin feed + vitrin kart detayı; feed'de kompakt satır | `listRequestOffers` + `ShowcaseFeedService.list/getPublicCard` dekorasyonu; `ShowcaseCardFace` satırı |
| 12 | Yalnız değerlendirilen sağlayıcı bildirir; tek açık bildirim | `POST /providers/:providerId/reviews/:reviewId/reports`; partial unique `WHERE resolvedAt IS NULL` |
| 13 | Otomatik gizleme yok; kaldır/tamamen kaldır/geri getir; audit append-only | `ProviderReviewModeration` satırı + `commentRemovedAt/removedAt` |
| 14 | Public'te HTML yok; PII canonical filtreyle reddedilir | React text child; `assertNoContactDetails` (`common/contact-guard.ts`) |
| 15 | Kredi/ödeme/vitrin/sıralama etkisi yok | Hiçbir uç ledger/entitlement/placement yazmaz; sıralama kodu dokunulmaz |
| 16 | Tamamlama → davet + doğrudan değerlendirme sayfası | `completeServiceRequest` tx + intent; `completeRequestAction` → `redirect('/requests/<id>/degerlendir')` |
| 17 | Dört şablon, PII yok, NotificationLog dedupe | §A9 |

## A2. Keşif kanıtı (entegrasyon varsayımları)

| Varsayım | Kanıt |
|---|---|
| `COMPLETED` tek yazıcı `POST /service-requests/:id/complete`, `CUSTOMER` (sahip) veya `SUPER_ADMIN`; koşullu `updateMany`, transaction yok, bildirim yok | `apps/api/src/modules/service-requests/service-requests.controller.ts:110-115`, `service-requests.service.ts:1096-1114, 1154-1176`; test `apps/api/test/request-lifecycle.spec.ts:146-185` |
| Moderasyon dropdown'u `COMPLETED` yazamaz; `COMPLETED` terminal | `service-requests.service.ts:186-190, 209-214`; `prisma/schema.prisma:102-121` |
| Değerlendirebilen herkes oturumlu CUSTOMER; her yeni talep bir `customerId` alır | `service-requests.service.ts:1283-1336` (`resolveCustomerForCreate`) |
| `matchedOfferId` unique; kabul tx'i `MATCHED` + `ACCEPTED` + rakipler `REJECTED` | `schema.prisma:882`, `offers.service.ts:538-689` (`:590-626`) |
| Direct lead aynı zincir, `showcaseLeadId` asla silinmez | `providers.service.ts:1372-1389`; `schema.prisma:861-866` |
| Mesajlaşma yalnız `MATCHED`; `COMPLETED` sonrası kapalı | `apps/api/src/modules/messaging/messaging.service.ts:444-455` |
| Dedupe: `@@unique([template, dedupeKey])`, `sendEmailOnce`, retry `composeRetryMessage/rebuild` | `schema.prisma:1070`; `notification-dispatcher.service.ts:20-34, 118-130`; `transactional-mail.service.ts:992-1010, 2494-2560, 2625-2648` |
| Outbox intent deseni: tx içinde `intentRow` + `createMany skipDuplicates`, commit sonrası `deliverSoon()`, expiry tick sweep | `notification-intents.ts:57-195`; `request-publish-outbox.service.ts:68-197`; `request-lifecycle-scheduler.service.ts:85-89`; `service-requests.service.ts:500-531` |
| Şablon defteri 41, render testi sayıyı kilitler; "there is no rating system" | `templates/transactional-templates.ts:45, 76-175`; `transactional-email-render.spec.ts:515-521` |
| Talep bildirimi deseni: günlük 20, P2002→409, kuyruk `open/resolved` cursor, karar serializable tx, CHECK + partial index | `request-reports.service.ts:48-85, 98-170, 246-292`; `prisma/migrations/20260914120000_add_request_reports_and_auto_publish/migration.sql` |
| `ProviderAccessGuard`: sahip PROVIDER veya SUPER_ADMIN | `apps/api/src/modules/auth/provider-access.guard.ts:9-36` |
| Public sağlayıcı: yalnız `APPROVED`, aksi 404; allow-list projeksiyon; web'de public sayfa **yok** | `providers.service.ts:427-452, 1941-1945, 1975-1992`; `apps/web/app/providers/[id]/page.tsx:27-33` |
| Teklif kartı `provider` projeksiyonunda `id` yok; "no rating column" | `offers.service.ts:327-334`; `apps/web/app/requests/[id]/offers/offers-view.tsx:200-204` |
| Vitrin feed raw SQL; `toFeedCard(row)` projeksiyonu; `ShowcaseCardFace` tek yüz | `showcase-feed.service.ts:91-174, 258-310`; `apps/web/app/showcase-card-face.tsx:24-115` |
| PII filtresi modül-özel `assertNoContactDetails`; canonical `detectContactDetails` | `service-requests.service.ts:60-86`; `common/contact-detection.ts:357`; web `app/request-fields/description-field.tsx` |
| Operasyon anahtarı deseni (fail-closed, change log, admin toggle) | `operations-settings/marketplace-publish-settings.service.ts`, `.controller.ts`; `apps/admin/app/operations-settings/auto-publish-toggle.tsx`, `actions.ts:111-141` |
| Silme yok: user/provider/request `delete` çağrısı yok; `SUSPENDED` tek kapatma | `grep` boş; `providers.service.ts:932-955` |
| Müşteri liste projeksiyonu satırı yayar (`completedAt`, `matchedOfferId` API'de var, web tipinde yok) | `service-requests.service.ts:668-746`; `apps/web/lib/api.ts:147-178` |
| Web complete action ve admin complete action | `apps/web/app/requests/[id]/offers/actions.ts:12-21`; `apps/admin/app/requests/actions.ts:62-69` |
| Test harness: `createTestApp`, `createApprovedRequest`, `createDiscoverableProvider`, `loginAs`, `ACCEPT_OFFER`, `RecordingNotificationPort.ofTemplate` | `apps/api/test/harness.ts:124-131, 274-300, 466-556` |
| E2E yardımcıları: `acceptOffer`, `reportRequest`, `resolveReports` | `e2e/src/journeys.ts:380-400, 507-575` |

## A3. Veri modeli (kesin)

```prisma
/// Why the reviewed business brought a comment in front of an operator.
enum ProviderReviewReportReason {
  OFFENSIVE
  CONTAINS_CONTACT_INFO
  NOT_ABOUT_THIS_JOB
  SUSPECTED_FAKE
  OTHER
}

/// One operator action on one review. Append-only: a row is written per action
/// and never updated or deleted; the review row only carries the derived state.
enum ProviderReviewModerationAction {
  REMOVE_COMMENT
  REMOVE_REVIEW
  RESTORE
}

/// The one decision an operator takes about a review report.
enum ProviderReviewReportResolution {
  DISMISSED
  COMMENT_REMOVED
  REVIEW_REMOVED
}

/// A customer's rating of the business whose offer they accepted on their own,
/// now completed, request. Created once; never edited or deleted by anyone.
/// Only moderation writes `commentRemovedAt`/`removedAt`, always together with
/// a ProviderReviewModeration row in the same transaction.
model ProviderReview {
  id               String    @id @default(cuid())
  requestId        String
  /// The accepted offer. Unique: one review per delivered offer. `providerId`
  /// is copied from this offer inside the create transaction — never from a
  /// request body.
  offerId          String    @unique
  providerId       String
  /// The request's owner. NOT NULL: `/complete` requires a session, so the
  /// reviewer is always a signed-in CUSTOMER.
  customerUserId   String
  /// 1..5 — CHECK "ProviderReview_rating_range" in raw SQL.
  rating           Int
  /// Trimmed, whitespace-collapsed; NULL when empty. Bounded by
  /// limits.providerReviewCommentMaxLength. Never rendered as HTML anywhere.
  comment          String?
  /// Set by REMOVE_COMMENT. The text stays on the row for the audit trail and
  /// the operator; every non-admin projection treats it as absent.
  commentRemovedAt DateTime?
  /// Set by REMOVE_REVIEW. Excluded from every aggregate and every list except
  /// the customer's own and the operator's. Cleared by RESTORE.
  removedAt        DateTime?
  createdAt        DateTime  @default(now())

  request    ServiceRequest             @relation(fields: [requestId], references: [id], onDelete: Restrict)
  offer      Offer                      @relation(fields: [offerId], references: [id], onDelete: Restrict)
  provider   ProviderProfile            @relation(fields: [providerId], references: [id], onDelete: Restrict)
  customer   User                       @relation("ProviderReviewCustomer", fields: [customerUserId], references: [id], onDelete: Restrict)
  reports    ProviderReviewReport[]
  moderation ProviderReviewModeration[]

  /// One review per request + provider — the database's answer to a
  /// double-click and to a re-submission after a removal.
  @@unique([requestId, providerId])
  @@index([customerUserId, createdAt])
  @@index([providerId, createdAt])
}

/// The reviewed business telling an operator that a comment needs a look.
/// Append-only: opened once, resolved once. A report never hides anything.
model ProviderReviewReport {
  id                 String                          @id @default(cuid())
  reviewId           String
  reporterProviderId String
  reason             ProviderReviewReportReason
  /// Optional free text (≤500). Operator-only.
  note               String?
  createdAt          DateTime                        @default(now())
  resolvedAt         DateTime?
  resolvedByUserId   String?
  resolution         ProviderReviewReportResolution?
  resolutionNote     String?

  review     ProviderReview  @relation(fields: [reviewId], references: [id], onDelete: Restrict)
  reporter   ProviderProfile @relation(fields: [reporterProviderId], references: [id], onDelete: Restrict)
  resolvedBy User?           @relation("ProviderReviewReportResolvedBy", fields: [resolvedByUserId], references: [id], onDelete: SetNull)

  // "ProviderReviewReport_one_open_per_review": UNIQUE ("reviewId") WHERE
  // "resolvedAt" IS NULL — raw SQL, Prisma cannot express it. A second open
  // report on one review is unrepresentable; a new report after a decision is.
  @@index([reviewId, createdAt])
  @@index([reporterProviderId, createdAt])
  @@index([resolvedAt, createdAt])
}

/// Every operator action on a review: who, what, why, when. Never updated.
model ProviderReviewModeration {
  id            String                         @id @default(cuid())
  reviewId      String
  action        ProviderReviewModerationAction
  /// Required for REMOVE_*, NULL for RESTORE — CHECK in raw SQL. The key of
  /// the fixed label the customer is mailed; never the operator's note.
  reason        ProviderReviewReportReason?
  /// Operator-only.
  note          String?
  performedById String
  createdAt     DateTime                       @default(now())

  review      ProviderReview @relation(fields: [reviewId], references: [id], onDelete: Restrict)
  performedBy User           @relation("ProviderReviewModerationPerformedBy", fields: [performedById], references: [id], onDelete: Restrict)

  @@index([reviewId, createdAt])
  @@index([performedById])
}
```

Ters ilişkiler: `ServiceRequest.review ProviderReview?`, `Offer.review ProviderReview?`,
`ProviderProfile.reviews ProviderReview[]`, `ProviderProfile.reviewReports ProviderReviewReport[]`,
`User.providerReviews ProviderReview[] @relation("ProviderReviewCustomer")`,
`User.resolvedReviewReports ProviderReviewReport[] @relation("ProviderReviewReportResolvedBy")`,
`User.reviewModerations ProviderReviewModeration[] @relation("ProviderReviewModerationPerformedBy")`.
`OperationsSettings.providerReviewsEnabled Boolean @default(false)`.

Raw SQL (migration `20260916120000_add_provider_reviews`):

```sql
ALTER TABLE "ProviderReview"
  ADD CONSTRAINT "ProviderReview_rating_range" CHECK ("rating" BETWEEN 1 AND 5),
  ADD CONSTRAINT "ProviderReview_comment_removal_needs_comment"
    CHECK ("commentRemovedAt" IS NULL OR "comment" IS NOT NULL);
ALTER TABLE "ProviderReviewReport"
  ADD CONSTRAINT "ProviderReviewReport_resolution_pair"
    CHECK (("resolvedAt" IS NULL) = ("resolution" IS NULL));
ALTER TABLE "ProviderReviewModeration"
  ADD CONSTRAINT "ProviderReviewModeration_reason_by_action"
    CHECK (("action" = 'RESTORE') = ("reason" IS NULL));
-- Aggregate + public list: live rows only, index-only for count/avg.
CREATE INDEX "ProviderReview_live_by_provider_idx"
  ON "ProviderReview"("providerId", "createdAt" DESC) INCLUDE ("rating")
  WHERE "removedAt" IS NULL;
-- One open report per review; a new one may follow a decision.
CREATE UNIQUE INDEX "ProviderReviewReport_one_open_per_review"
  ON "ProviderReviewReport"("reviewId") WHERE "resolvedAt" IS NULL;
-- The open queue, oldest first.
CREATE INDEX "ProviderReviewReport_open_idx"
  ON "ProviderReviewReport"("createdAt") WHERE "resolvedAt" IS NULL;
ALTER TABLE "OperationsSettings"
  ADD COLUMN "providerReviewsEnabled" BOOLEAN NOT NULL DEFAULT false;
```

`onDelete` gerekçesi: kullanıcı/sağlayıcı/talep/teklif hiçbir yoldan silinmez (A2);
`Restrict` ile bir değerlendirme kaynağını kaybedemez. Admin FK'si raporda `SetNull`
(`ServiceRequestReport.resolvedBy` ile aynı), moderasyonda `Restrict`
(`ManualOfferRefundAudit.performedBy` ile aynı: "operatörsüz denetim kaydı olamaz").

## A4. `COMPLETED` geçişi ve davet niyeti

**Bugün:** tek koşullu `UPDATE`, transaction yok, bildirim yok (`service-requests.service.ts:1096-1114`).
Koşullu `UPDATE` idempotency için yeterli; ancak davet maili `UPDATE` ile aynı anda
kalıcılaşmazsa süreç ölümünde kaybolur ve admin retry edecek satır olmaz.

**Değişiklik (kesin):** `completeServiceRequest` `runSerializable` içine alınır; aynı
transaction'da (1) koşullu `updateMany` (`count !== 1` → 409, aynen), (2)
`ReviewInvitationOutbox.enqueue(tx, requestId, now)` → `intentRow({ template: 'review-invitation',
dedupeKey: 'review-invitation:<requestId>', to: customerEmail, requestId, userId: customerId })`
`createMany skipDuplicates`. Commit sonrası `outbox.deliverSoon()`. Sweep:
`RequestLifecycleScheduler.runScheduledExpiry` mevcut `publishOutbox.deliverPending` satırının
yanına `reviewInvitationOutbox.deliverPending({ limit })` eklenir (`request-lifecycle-scheduler.service.ts:85-89`
kalıbı). Anahtar kapalıysa `enqueue` satır yazmaz (geriye dönük davet yok).

Teslimde mesaj `composeRetryMessage('review-invitation', key)` ile canlı veriden kurulur;
`rebuild` şu hallerde `null` (→ `FAILED/SOURCE_UNAVAILABLE`): talep `COMPLETED` değil,
`customerEmail` yok, anahtar kapalı, `completedAt + 90g < now`, değerlendirme zaten var.

## A5. API sözleşmesi

Modül `apps/api/src/modules/provider-reviews/`. Hata gövdesi repo kalıbı:
`{ statusCode, error, code, message }`.

| Uç | Guard | Kod/başarı | Hata kodları |
|---|---|---|---|
| `POST /service-requests/:id/review` `{ rating, comment? }` | `AuthGuard, RolesGuard @Roles(CUSTOMER)` | 201 `CustomerReviewState` | 404 `REVIEWS_DISABLED`; 404 talep yok; 403 sahibi değil; 409 `REQUEST_NOT_COMPLETED`, `MATCH_INCONSISTENT`, `REVIEW_WINDOW_CLOSED`, `REVIEW_ALREADY_EXISTS`; 400 `CONTACT_DETAILS_IN_TEXT` (`field: 'comment'`, `kind`), 400 DTO |
| `GET /service-requests/:id/review` | `AuthGuard` (sahip CUSTOMER veya SUPER_ADMIN) | 200 `CustomerReviewState` | 404 / 403 |
| `GET /providers/:providerId/reviews?cursor&limit` | `AuthGuard, ProviderAccessGuard` | 200 `{ summary: ReviewSummary, items: ProviderReviewItem[], nextCursor }` | 403 |
| `GET /providers/:providerId/reviews/summary` | aynı | 200 `ReviewSummary` | 403 |
| `POST /providers/:providerId/reviews/:reviewId/reports` `{ reason, note? }` | aynı | 201 `{ id, reason, createdAt }` | 404 review başkasının/yok; 409 `REVIEW_NOT_REPORTABLE` (yorum yok / yorum kaldırılmış / değerlendirme kaldırılmış), `REVIEW_REPORT_ALREADY_EXISTS`; 429 `REVIEW_REPORT_RATE_LIMITED` |
| `GET /providers/:id/reviews/public?cursor&limit` | `OptionalAuthGuard` | 200 `{ summary: PublicReviewSummary, items: PublicReviewItem[], nextCursor }` | 404 sağlayıcı `APPROVED` değil / anahtar kapalı |
| `GET /provider-reviews/reports?state=open\|resolved&cursor&limit` | `SUPER_ADMIN` | 200 `{ items: ReviewReportQueueItem[], nextCursor }` | — |
| `GET /provider-reviews/:reviewId` | `SUPER_ADMIN` | 200 `AdminReviewDetail` | 404 |
| `POST /provider-reviews/:reviewId/moderate` `{ action, reason?, note? }` | `SUPER_ADMIN` | 201 `AdminReviewDetail` | 404; 409 `REVIEW_MODERATION_NOOP`; 400 (REMOVE_* için `reason` zorunlu) |
| `POST /provider-reviews/:reviewId/reports/dismiss` `{ resolutionNote? }` | `SUPER_ADMIN` | 201 `AdminReviewDetail` | 409 `NO_OPEN_REVIEW_REPORT` |
| `GET/PUT /operations-settings/provider-reviews` `{ enabled }` | `SUPER_ADMIN` | 200 `{ enabled, recentChanges }` | 400 |

Tipler (API yanıtı; web `lib/api.ts`'e birebir kopyalanır):

```ts
export type ReviewSummary = {
  count: number;
  average: number | null;                 // 2 decimals; null when count === 0
  distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
};
/** null = fewer than PROVIDER_REVIEW_PUBLIC_MIN_COUNT live reviews. */
export type PublicReviewSummary = { count: number; average: number } | null;
export type PublicReviewItem = { id: string; rating: number; comment: string; month: string /* YYYY-MM */; categoryName: string };
export type ProviderReviewItem = {
  id: string; rating: number; comment: string | null; commentRemoved: boolean; createdAt: string;
  request: { id: string; requestNumber: string | null; categoryName: string };
  myReport: { reason: ProviderReviewReportReason; createdAt: string; resolution: ProviderReviewReportResolution | null } | null;
};
export type CustomerReviewState = {
  eligibility: 'ok' | 'disabled' | 'not-completed' | 'window-closed' | 'already-reviewed' | 'removed';
  windowEndsAt: string | null;
  provider: { id: string; businessName: string } | null;
  review: { id: string; rating: number; comment: string | null; createdAt: string; commentRemoved: boolean; removed: boolean; removalReason: ProviderReviewReportReason | null } | null;
};
```

**Oluşturma predikatı (sırayla, `ProviderReviewsService.createForCustomer`):**
1. `settings.isEnabled()` false → 404 `REVIEWS_DISABLED`.
2. Talep `select { id, status, customerId, completedAt, matchedOfferId, matchedOffer: { id, providerId, status } }`; yok → 404; `customerId !== user.id` → 403.
3. `status !== COMPLETED` → 409 `REQUEST_NOT_COMPLETED`.
4. `!matchedOffer || matchedOffer.status !== ACCEPTED` → 409 `MATCH_INCONSISTENT`.
5. `completedAt` NULL ya da `now > completedAt + 90g` → 409 `REVIEW_WINDOW_CLOSED`.
6. `comment = normalizeComment(dto.comment)`; `assertNoContactDetails('comment', comment)`.
7. `create({ requestId, offerId, providerId: matchedOffer.providerId, customerUserId: user.id, rating, comment })`; P2002 → 409 `REVIEW_ALREADY_EXISTS`.
8. Commit sonrası `notifySafely(() => mail.sendReviewReceived(review.id))`.

**90 gün:** `PROVIDER_REVIEW_WINDOW_DAYS = 90`; `windowEndsAt = completedAt + 90 * 86_400_000 ms`;
karşılaştırma `Date.now() > windowEndsAt.getTime()`. Aynı hesap `rebuild('review-invitation')`
ve `getForCustomer` içinde tek fonksiyondan (`reviewWindowEndsAt(completedAt)`).

## A6. Public profil, projeksiyonlar, teklif kartı

- **Public profil rotası yok → oluşturulur:** web `/isletme/[id]` (`apps/web/app/isletme/[id]/page.tsx`).
  API tarafında yeni "profil" ucu gerekmez: `GET /providers/:id` (`OptionalAuthGuard`, allow-list
  `toPublicProvider`) + `GET /providers/:id/reviews/public`. Her ikisi `APPROVED` değilse 404.
- **Teklif kartı:** `listRequestOffers` provider select'ine `id` eklenir ve sonuç
  `reviewSummary: PublicReviewSummary` ile dekore edilir (tek `groupBy`). Kart başlığı
  `/isletme/<id>`'ye bağlanır. Güvenlik: `id` zaten `cuid`; public GET'in kendisi 404 kuralını
  uygular; kart hiçbir ek alan taşımaz.
- **Vitrin feed / kart detayı:** `ShowcaseFeedService.list` ve `getPublicCard` sonuçları
  `provider.reviewSummary` ile dekore edilir (raw SQL'e dokunulmaz; `providerId` seti için tek
  `groupBy`). Web `ShowcaseFaceData.reviewSummary?: PublicReviewSummary` → `providerName` altında
  `<p className="vitrin-face-rating">★ 4,7 · 12 değerlendirme</p>`; `null` ise satır **render
  edilmez** (fiyat ve bölge satırlarını gölgelememek için "yetersiz" metni feed'de değil yalnız
  profil ve kart detayında gösterilir).
- **Public projeksiyon allow-list (`toPublicReview`):** `{ id, rating, comment, month, categoryName }`;
  yalnız `comment IS NOT NULL AND commentRemovedAt IS NULL AND removedAt IS NULL`.

## A7. Ekranlar

| Ekran | Yol | Kaynak |
|---|---|---|
| Müşteri değerlendirme | `apps/web/app/requests/[id]/degerlendir/{page.tsx, review-form.tsx, actions.ts}` | `GET /service-requests/:id/review` + `POST` |
| Taleplerim CTA | `apps/web/app/requests/my/requests-board.tsx:143-199` | `CustomerServiceRequest.review` (liste include) |
| Teklif sayfası `COMPLETED` özeti | `apps/web/app/requests/[id]/offers/page.tsx:311-313` | link/durum |
| Tamamlama → yönlendirme | `apps/web/app/requests/[id]/offers/actions.ts:12-21` | `redirect` |
| Sağlayıcı paneli | `apps/web/app/providers/[id]/degerlendirmeler/{page.tsx, report-dialog.tsx, actions.ts}`, `provider-shell.tsx:116-161` menü, `providers/me/page.tsx` kart, `providers/[id]/page.tsx:41-47` rail | `GET /providers/:id/reviews`, `/summary`, dashboard `reviewSummary` |
| Public profil | `apps/web/app/isletme/[id]/page.tsx` | `GET /providers/:id`, `/reviews/public` |
| Teklif kartı | `apps/web/app/requests/[id]/offers/offers-view.tsx:102-118, 228-236` | `RequestOfferPreview.provider.id/reviewSummary` |
| Vitrin | `apps/web/app/showcase-card-face.tsx`, `vitrin/[cardId]/page.tsx:141` | `reviewSummary` |
| Admin kuyruk/detay | `apps/admin/app/provider-reviews/reports/page.tsx`, `provider-reviews/[reviewId]/{page.tsx, moderation-form.tsx, actions.ts}`, `lib/nav.ts:19-21` | admin uçları |
| Admin sağlayıcı/talep detay | `apps/admin/app/providers/[id]/page.tsx:572`, `requests/[id]/page.tsx:594` | `GET /providers/:id/reviews` (admin geçer), `GET /provider-reviews/:id` |
| Admin ayar | `apps/admin/app/operations-settings/{page.tsx, provider-reviews-toggle.tsx, actions.ts}` | `/operations-settings/provider-reviews` |
| Admin bildirim geçmişi | `apps/admin/lib/api.ts` şablon etiketleri | 4 yeni etiket |

## A8. Kaldırma, geri getirme, askıya alma, arşiv, yarış

| Durum | Davranış |
|---|---|
| `REMOVE_COMMENT` | `commentRemovedAt = now` (koşullu: `comment IS NOT NULL AND commentRemovedAt IS NULL AND removedAt IS NULL`); yıldız aggregate'te kalır; açık rapor `COMMENT_REMOVED`; müşteriye `review-removed` (scope COMMENT) |
| `REMOVE_REVIEW` | `removedAt = now` (koşullu `removedAt IS NULL`); aggregate anında düşer; açık rapor `REVIEW_REMOVED`; müşteriye `review-removed` (scope REVIEW); sağlayıcı listesinden çıkar |
| `RESTORE` | `removedAt = NULL, commentRemovedAt = NULL` (koşullu: en az biri dolu); moderasyon satırı; mail yok; rapor dokunulmaz |
| Koşul tutmazsa | 409 `REVIEW_MODERATION_NOOP` — iki admin aynı anda: biri kazanır, diğeri 409 |
| Sağlayıcı `SUSPENDED/REJECTED` | Oluşturma serbest (iş gerçek); public profil/liste 404; feed/teklif dekorasyonu sağlayıcı zaten görünmediği için tetiklenmez; yeniden `APPROVED` olunca aggregate aynen |
| Talep `CANCELLED/EXPIRED/REJECTED` | 409 `REQUEST_NOT_COMPLETED`; `COMPLETED` terminal olduğu için sonradan bu durumlara geçemez (`terminalStatuses`; `rejectRequestInTransaction` MATCHED'ı bile reddeder — `request-reports.service.ts:236-240`) |
| Teklif `WITHDRAWN/CANCELLED` | Kabul edilmiş teklif bu durumlara geçemez (`withdrawProviderOffer` yalnız `APPROVED` talepte; `CANCELLED` yalnız `REJECTED` talepte `schema.prisma:1323-1329`); adım 4 savunma |
| İki paralel `POST review` | `create` + P2002: tam bir satır; kaybeden 409 `REVIEW_ALREADY_EXISTS` |
| İki paralel `/complete` | Koşullu `updateMany` (mevcut); ikinci 409; tek intent satırı (`skipDuplicates` + unique) |
| Aynı sağlayıcı ikinci rapor | Açık rapor varken 409 `REVIEW_REPORT_ALREADY_EXISTS` (servis kontrolü + partial unique P2002 fallback); karar sonrası yeni rapor açılabilir |
| Anahtar kapalı | `POST` 404; public uçlar 404; CTA/bölümler gizli; mevcut satırlar dokunulmaz; provider paneli listeyi görmeye devam eder (kendi verisi) |
| Eski `customerId NULL` talep | `/complete` zaten 403; değerlendirme yolu yok |
| Kredi/iade/vitrin | Hiçbir uç `ProviderCreditTransaction`, `Offer.*refund*`, `ShowcasePlacement`, `ShowcaseEntitlement`, `PackagePurchase` yazmaz; test `credits-integrity` uzantısı |

## A9. Bildirim dedupe ve retry

| Şablon | Alıcı | dedupeKey | `RETRY_SOURCE_ID_COUNT` | `rebuild` null koşulu | Data (PII yok) |
|---|---|---|---|---|---|
| `review-invitation` | müşteri | `review-invitation:<requestId>` | 1 | A4 | fullName (müşteri adı — kendi maili), businessName, categoryName, requestNumber, windowEndsAt, reviewUrl, accountUrl |
| `review-received` | sağlayıcı (`recipientFor`) | `review-received:<reviewId>` | 1 | review `removedAt` dolu, alıcı yok | fullName (contactName), rating, categoryName, requestNumber, reviewsUrl, accountUrl |
| `review-report-new-for-support` | `readSupportInboxEmail()` | `review-report-new:<reportId>` | 1 | rapor yok | reasonLabel, businessName, requestNumber, adminReviewUrl; **not yok** |
| `review-removed` | müşteri | `review-removed:<reviewId>:<removedAt ISO>` | 1 (ISO kuyruğu yok sayılır, `request-removed` gibi) | review hem `removedAt` hem `commentRemovedAt` NULL (RESTORE sonrası) | scopeLabel ("Yorumunuz"/"Değerlendirmeniz"), reasonLabel (sabit), requestNumber, supportUrl, accountUrl |

Retry: admin `/notifications/[id]` "Yeniden gönder" → `composeRetryMessage` → `parseRetrySource`
(prefix + id) → `rebuild` → aynı `NotificationLog` satırı, yeni kimlik yok
(`notification-dispatcher.service.ts:70-80`). `DUPLICATE` sonucu hata değildir.

## A10. Test matrisi (özet; ayrıntı görevlerde)

| Alan | API spec | E2E |
|---|---|---|
| Şema/CHECK/partial unique | `provider-review-schema.spec.ts` | — |
| Yetki (sahip/başka müşteri/provider/admin), predikat sırası, 90 gün, PII, DTO sınırları, anahtar | `provider-reviews.spec.ts` | `provider-review-flow.spec.ts` |
| İdempotency/yarış (10 paralel create, paralel complete → tek intent) | `provider-reviews.spec.ts`, `review-invitation-outbox.spec.ts` | — |
| Aggregate, 3-eşik, kaldırma/geri getirme, public allow-list, ay hassasiyeti | `provider-reviews-aggregate.spec.ts` | flow (adım 4–6) |
| Rapor/moderasyon (tek açık rapor, bütçe, no-auto-hide, NOOP) | `provider-review-moderation.spec.ts` | flow |
| Bildirimler (4 dedupe, rebuild, PII yok, admin tamamlama daveti) | `provider-review-notifications.spec.ts`, `transactional-email-render.spec.ts` (45) | `notification-history` kontrolü |
| Entegrasyon projeksiyonları (teklif kartı id/summary, feed/kart detayı, dashboard, müşteri listesi) | `provider-review-projections.spec.ts` | flow + `showcase-*` |
| Vitrin direct lead ortak senaryo | `provider-reviews-direct-lead.spec.ts` | `provider-review-flow.spec.ts` ikinci test |
| Kredi/entitlement değişmezliği | `credits-integrity.spec.ts` uzantısı | — |
| Anahtar + change log | `operations-settings.spec.ts` uzantısı | `scheduler-settings.spec.ts` uzantısı |

---

# BÖLÜM B — Implementation Plan

## Dosya haritası

```
packages/shared/limits.json                                   (+3 anahtar)
apps/api/src/common/contact-guard.ts                          (yeni: assertNoContactDetails, CONTACT_DETAILS_IN_TEXT_CODE)
apps/api/src/common/provider-review-limits.ts                 (yeni)
apps/api/src/common/web-routes.ts                             (+customerReviewUrl, providerReviewsUrl, adminProviderReviewUrl)
prisma/schema.prisma, prisma/migrations/20260916120000_add_provider_reviews/migration.sql
apps/api/src/modules/operations-settings/provider-review-settings.{service,controller}.ts
apps/api/src/modules/notifications/templates/transactional-templates.ts   (+4 doküman, +4 subject)
apps/api/src/modules/notifications/transactional-mail.service.ts          (+3 send, +4 prefix/count/rebuild, +data builders)
apps/api/src/modules/notifications/review-invitation-outbox.service.ts    (yeni)
apps/api/src/modules/notifications/notifications.module.ts                (provider/export)
apps/api/src/modules/service-requests/service-requests.service.ts         (completeServiceRequest tx; listCustomerServiceRequests include; assertNoContactDetails import)
apps/api/src/modules/request-lifecycle/request-lifecycle-scheduler.service.ts (sweep)
apps/api/src/modules/provider-reviews/
  provider-reviews.module.ts
  provider-reviews.constants.ts
  provider-review-copy.ts                     (etiketler)
  provider-review-window.ts                   (reviewWindowEndsAt, isReviewWindowOpen — saf)
  provider-review-aggregate.ts                (toReviewSummary, toPublicSummary — saf)
  provider-review-comment.ts                  (normalizeComment — saf)
  provider-reviews.service.ts                 (müşteri/sağlayıcı/public okuma-yazma)
  provider-review-moderation.service.ts       (rapor + admin)
  customer-provider-reviews.controller.ts     (/service-requests/:id/review)
  provider-panel-reviews.controller.ts        (/providers/:providerId/reviews, /reports)
  public-provider-reviews.controller.ts       (/providers/:id/reviews/public)
  admin-provider-reviews.controller.ts        (/provider-reviews/...)
  dto/{create-provider-review,create-provider-review-report,moderate-provider-review,dismiss-provider-review-report}.dto.ts
apps/api/src/modules/offers/offers.service.ts + offers.module.ts        (provider.id + reviewSummary)
apps/api/src/modules/showcase/showcase-feed.service.ts + showcase.module.ts (reviewSummary)
apps/api/src/modules/providers/providers.service.ts + providers.module.ts (dashboard reviewSummary)
apps/api/src/app.module.ts                                            (ProviderReviewsModule)
apps/api/test/{provider-review-schema,provider-reviews,provider-reviews-aggregate,provider-review-moderation,
  provider-review-notifications,review-invitation-outbox,provider-review-projections,provider-reviews-direct-lead}.spec.ts
apps/web/lib/api.ts (tipler) · apps/web/lib/reviews.ts (formatRating, ratingLabel)
apps/web/app/requests/[id]/degerlendir/{page.tsx,review-form.tsx,actions.ts}
apps/web/app/requests/[id]/offers/{actions.ts,page.tsx,offers-view.tsx}
apps/web/app/requests/my/requests-board.tsx
apps/web/app/providers/[id]/degerlendirmeler/{page.tsx,report-dialog.tsx,actions.ts}
apps/web/app/providers/provider-shell.tsx · providers/me/page.tsx · providers/[id]/page.tsx
apps/web/app/isletme/[id]/page.tsx · apps/web/app/showcase-card-face.tsx · apps/web/app/review-stars.tsx (paylaşılan yıldız bileşeni)
apps/admin/lib/{api.ts,nav.ts} · apps/admin/app/provider-reviews/reports/page.tsx ·
  apps/admin/app/provider-reviews/[reviewId]/{page.tsx,moderation-form.tsx,actions.ts} ·
  apps/admin/app/operations-settings/{page.tsx,provider-reviews-toggle.tsx,actions.ts} ·
  apps/admin/app/providers/[id]/page.tsx · apps/admin/app/requests/[id]/page.tsx
e2e/src/journeys.ts (+completeRequest, submitReview, reportReview, moderateReview) · e2e/tests/provider-review-flow.spec.ts
docs/superpowers/plans/2026-09-16-provider-reviews-migration-dryrun.txt · ...-teslim-raporu.md
```

PR bölümlemesi: **PR-A** = Task 1–10 (API + migration; anahtar kapalı olduğu için tek başına
yayınlanabilir). **PR-B** = Task 11–16 (web/admin/E2E). Her task kendi commit'ini atar.

---

### Task 1: Ortak sınırlar ve canonical PII koruyucusunun çıkarılması

**Files:**
- Modify: `packages/shared/limits.json`
- Create: `apps/api/src/common/provider-review-limits.ts`
- Create: `apps/api/src/common/contact-guard.ts`
- Modify: `apps/api/src/modules/service-requests/service-requests.service.ts:60-86` (fonksiyonu kaldır, import et)
- Test: `apps/api/test/request-contact-filter.spec.ts` (mevcut; davranış değişmemeli)

**Interfaces:**
- Produces: `PROVIDER_REVIEW_COMMENT_MAX_LENGTH: number`, `PROVIDER_REVIEW_PUBLIC_MIN_COUNT: number`,
  `PROVIDER_REVIEW_WINDOW_DAYS: number` (`provider-review-limits.ts`);
  `assertNoContactDetails(field: string, value: string | null): void`,
  `CONTACT_DETAILS_IN_TEXT_CODE` (`contact-guard.ts`).

- [ ] **Step 1: `limits.json`'a üç anahtar ekle**

```json
{
  "serviceRequestDescriptionMaxLength": 5000,
  "supportTicketSubjectMaxLength": 120,
  "supportTicketMessageMaxLength": 2000,
  "providerReviewCommentMaxLength": 600,
  "providerReviewPublicMinCount": 3,
  "providerReviewWindowDays": 90
}
```

- [ ] **Step 2: `apps/api/src/common/provider-review-limits.ts`**

```ts
import limits from '@taktic/shared/limits.json';

/**
 * Review limits, read from the same file the web screens read. JSON import
 * only — see service-request-limits.ts for why the package's TS entry point
 * cannot be required from the compiled API.
 */
export const PROVIDER_REVIEW_COMMENT_MAX_LENGTH = limits.providerReviewCommentMaxLength;
export const PROVIDER_REVIEW_PUBLIC_MIN_COUNT = limits.providerReviewPublicMinCount;
export const PROVIDER_REVIEW_WINDOW_DAYS = limits.providerReviewWindowDays;
```

- [ ] **Step 3: `apps/api/src/common/contact-guard.ts` — `assertNoContactDetails`'i taşı**

`service-requests.service.ts:60-86`'daki `CONTACT_DETAILS_IN_TEXT_CODE` sabitini ve
`assertNoContactDetails` fonksiyonunu **aynen** bu dosyaya taşı (`export` ekle; mesaj ve
`BadRequestException` gövdesi değişmez). `service-requests.service.ts` içinde
`import { assertNoContactDetails, CONTACT_DETAILS_IN_TEXT_CODE } from '../../common/contact-guard';`
ve eski tanımları sil. `CONTACT_DETAILS_IN_TEXT_CODE`'u dışa aktaran başka yer varsa
(`grep -rn CONTACT_DETAILS_IN_TEXT_CODE apps/api`) re-export ile koru:
`export { CONTACT_DETAILS_IN_TEXT_CODE } from '../../common/contact-guard';`.

- [ ] **Step 4: Mevcut filtre testlerini çalıştır**

Run: `DATABASE_URL='postgresql://taktic_user:taktic_password@localhost:5433/taktic?schema=public' pnpm --filter @taktic/api test request-contact-filter`
Expected: PASS (davranış aynı). `pnpm --filter @taktic/api typecheck` → temiz.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/limits.json apps/api/src/common/provider-review-limits.ts apps/api/src/common/contact-guard.ts apps/api/src/modules/service-requests/service-requests.service.ts
git commit -m "refactor(api): shared review limits and a common contact-details guard

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

**Risk:** Re-export unutulursa `CONTACT_DETAILS_IN_TEXT_CODE` import eden spec derlenmez → typecheck yakalar.

---

### Task 2: Prisma şeması + additive migration + şema testi

**Files:**
- Modify: `prisma/schema.prisma` (A3'teki enum/model'ler; ters ilişkiler `User:319-424`, `ServiceRequest:791-941`, `ProviderProfile:1103-1189`, `Offer:1251-1376`, `OperationsSettings:474-524`)
- Create: `prisma/migrations/20260916120000_add_provider_reviews/migration.sql`
- Test: `apps/api/test/provider-review-schema.spec.ts`
- Create: `docs/superpowers/plans/2026-09-16-provider-reviews-migration-dryrun.txt`

**Interfaces:**
- Produces: Prisma modelleri `ProviderReview`, `ProviderReviewReport`, `ProviderReviewModeration`; enum'lar `ProviderReviewReportReason`, `ProviderReviewModerationAction`, `ProviderReviewReportResolution`; `OperationsSettings.providerReviewsEnabled`.

- [ ] **Step 1: Şema testini yaz (`apps/api/test/provider-review-schema.spec.ts`)**

```ts
import { ProviderReviewReportReason, UserRole } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApprovedRequest, createCategory, createDiscoverableProvider, createTestApp, createUser,
  grantCredits, offerPayload, loginAs, resetDatabase, type TestContext,
} from './harness';
import request from 'supertest';

let ctx: TestContext;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.app.close(); });
beforeEach(async () => { await resetDatabase(ctx.prisma); });

/** A completed request with its accepted offer, written straight into the tables. */
async function completedJob() {
  const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 1 });
  const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
  const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, { categoryId: category.id, userId: owner.id });
  const req = await createApprovedRequest(ctx.prisma, { categoryId: category.id, customerId: customer.id });
  await grantCredits(ctx.prisma, provider.id, 5);
  const created = await request(ctx.server).post(`/providers/${provider.id}/requests/${req.id}/offers`)
    .set('Cookie', await loginAs(ctx.prisma, owner.id)).send(offerPayload()).expect(201);
  await ctx.prisma.offer.update({ where: { id: created.body.id }, data: { status: 'ACCEPTED', acceptedAt: new Date() } });
  await ctx.prisma.serviceRequest.update({ where: { id: req.id }, data: { status: 'COMPLETED', matchedOfferId: created.body.id, matchedAt: new Date(), completedAt: new Date() } });
  return { customer, provider, request: req, offerId: created.body.id as string };
}

describe('ProviderReview schema', () => {
  it('allows one review per request + provider and per offer', async () => {
    const job = await completedJob();
    const data = { requestId: job.request.id, offerId: job.offerId, providerId: job.provider.id, customerUserId: job.customer.id, rating: 5 };
    await ctx.prisma.providerReview.create({ data });
    await expect(ctx.prisma.providerReview.create({ data: { ...data, rating: 1 } })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('refuses a rating outside 1..5 (CHECK ProviderReview_rating_range)', async () => {
    const job = await completedJob();
    await expect(ctx.prisma.providerReview.create({
      data: { requestId: job.request.id, offerId: job.offerId, providerId: job.provider.id, customerUserId: job.customer.id, rating: 6 },
    })).rejects.toThrow(/ProviderReview_rating_range/);
  });

  it('refuses commentRemovedAt on a review with no comment', async () => {
    const job = await completedJob();
    await expect(ctx.prisma.providerReview.create({
      data: { requestId: job.request.id, offerId: job.offerId, providerId: job.provider.id, customerUserId: job.customer.id, rating: 4, comment: null, commentRemovedAt: new Date() },
    })).rejects.toThrow(/ProviderReview_comment_removal_needs_comment/);
  });

  it('allows one OPEN report per review and a second one after a decision', async () => {
    const job = await completedJob();
    const review = await ctx.prisma.providerReview.create({ data: { requestId: job.request.id, offerId: job.offerId, providerId: job.provider.id, customerUserId: job.customer.id, rating: 2, comment: 'Kötü' } });
    const first = await ctx.prisma.providerReviewReport.create({ data: { reviewId: review.id, reporterProviderId: job.provider.id, reason: ProviderReviewReportReason.OFFENSIVE } });
    await expect(ctx.prisma.providerReviewReport.create({ data: { reviewId: review.id, reporterProviderId: job.provider.id, reason: ProviderReviewReportReason.OTHER } }))
      .rejects.toThrow(/ProviderReviewReport_one_open_per_review/);
    await ctx.prisma.providerReviewReport.update({ where: { id: first.id }, data: { resolvedAt: new Date(), resolution: 'DISMISSED' } });
    await expect(ctx.prisma.providerReviewReport.create({ data: { reviewId: review.id, reporterProviderId: job.provider.id, reason: ProviderReviewReportReason.OTHER } })).resolves.toBeTruthy();
  });

  it('pairs resolvedAt with resolution and reason with action', async () => {
    const job = await completedJob();
    const review = await ctx.prisma.providerReview.create({ data: { requestId: job.request.id, offerId: job.offerId, providerId: job.provider.id, customerUserId: job.customer.id, rating: 3 } });
    await expect(ctx.prisma.providerReviewReport.create({ data: { reviewId: review.id, reporterProviderId: job.provider.id, reason: 'OTHER', resolvedAt: new Date() } }))
      .rejects.toThrow(/ProviderReviewReport_resolution_pair/);
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    await expect(ctx.prisma.providerReviewModeration.create({ data: { reviewId: review.id, action: 'REMOVE_REVIEW', reason: null, performedById: admin.id } }))
      .rejects.toThrow(/ProviderReviewModeration_reason_by_action/);
    await expect(ctx.prisma.providerReviewModeration.create({ data: { reviewId: review.id, action: 'RESTORE', reason: 'OTHER', performedById: admin.id } }))
      .rejects.toThrow(/ProviderReviewModeration_reason_by_action/);
  });
});
```

- [ ] **Step 2: Testi çalıştır, şema olmadığı için derlenmediğini gör**

Run: `DATABASE_URL='postgresql://taktic_user:taktic_password@localhost:5433/taktic?schema=public' pnpm --filter @taktic/api test provider-review-schema`
Expected: FAIL (`providerReview` PrismaClient'ta yok).

- [ ] **Step 3: `prisma/schema.prisma`'ya A3'teki enum/model'leri ve ters ilişkileri ekle**

A3 bloğunu birebir ekle. Ters ilişkiler:
- `User`: `providerReviews ProviderReview[] @relation("ProviderReviewCustomer")`,
  `resolvedReviewReports ProviderReviewReport[] @relation("ProviderReviewReportResolvedBy")`,
  `reviewModerations ProviderReviewModeration[] @relation("ProviderReviewModerationPerformedBy")`
- `ServiceRequest`: `review ProviderReview?` · `Offer`: `review ProviderReview?`
- `ProviderProfile`: `reviews ProviderReview[]`, `reviewReports ProviderReviewReport[]`
- `OperationsSettings`: `providerReviewsEnabled Boolean @default(false)` (yorum: `marketplaceAutoPublishEnabled` ile aynı sözleşme).

- [ ] **Step 4: Migration SQL'i yaz**

`prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --script`
çıktısını `migration.sql` olarak al; sonuna A3'teki raw SQL bloğunu ekle (CHECK'ler, partial
index'ler, `ProviderReview_live_by_provider_idx`). `ADD COLUMN "providerReviewsEnabled"` diff'te
zaten olacaktır — tekrar etme. Migration'ın başına yorum: `-- Additive only: three new tables,
one defaulted column on the singleton settings row. No row is rewritten.`

- [ ] **Step 5: Migration'ı uygula ve client'ı üret**

Run: `pnpm db:generate && DATABASE_URL='postgresql://taktic_user:taktic_password@localhost:5433/taktic?schema=public' pnpm exec prisma migrate deploy`
(Test DB `harness`/`provision-test-database.ts` tarafından checkout yoluna göre hazırlanır; ayrıca elle gerekmiyorsa bu adımı test koşusu yapar.)

- [ ] **Step 6: Şema testini çalıştır**

Run: aynı komut. Expected: 5 PASS.

- [ ] **Step 7: Dry-run raporu**

`docs/superpowers/plans/2026-09-16-provider-reviews-migration-dryrun.txt`: `migrate diff` çıktısı
+ `migrate deploy` log'u + `\d "ProviderReview"` çıktısı (index/CHECK listesi) — repo deseni
`2026-09-14-request-auto-publish-migration-dryrun.txt`.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260916120000_add_provider_reviews apps/api/test/provider-review-schema.spec.ts docs/superpowers/plans/2026-09-16-provider-reviews-migration-dryrun.txt
git commit -m "feat(db): provider reviews, reports and moderation log (additive)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

**Risk:** Partial unique ihlali Prisma'da `PrismaClientUnknownRequestError` olarak gelir (bkz.
`request-report-schema.spec.ts:40-45` yorumu) — serviste P2002 yerine hata mesajında index adı
aranır (Task 7'de `isOpenReportConflict(error)`).

---

### Task 3: `providerReviewsEnabled` anahtarı (API servis + controller + admin toggle)

**Files:**
- Create: `apps/api/src/modules/operations-settings/provider-review-settings.service.ts`
- Create: `apps/api/src/modules/operations-settings/provider-review-settings.controller.ts`
- Modify: `apps/api/src/modules/operations-settings/operations-settings.module.ts` (provider + controller + export)
- Modify: `apps/admin/lib/api.ts`, `apps/admin/app/operations-settings/page.tsx`, `apps/admin/app/operations-settings/actions.ts`
- Create: `apps/admin/app/operations-settings/provider-reviews-toggle.tsx`
- Test: `apps/api/test/operations-settings.spec.ts` (ekleme), `e2e/tests/scheduler-settings.spec.ts` (ekleme)

**Interfaces:**
- Produces: `ProviderReviewSettingsService.isEnabled(): Promise<boolean>`, `getForAdmin()`, `setEnabled(enabled, changedById)`; `GET/PUT /operations-settings/provider-reviews`; sabit `PROVIDER_REVIEWS_SETTING = 'providerReviewsEnabled'`.

- [ ] **Step 1: API testi ekle (`operations-settings.spec.ts` sonuna)**

```ts
describe('provider reviews switch', () => {
  it('is off by default, flips with an audit row, and refuses non-boolean', async () => {
    const cookie = await adminCookie();
    const before = await request(ctx.server).get('/operations-settings/provider-reviews').set('Cookie', cookie).expect(200);
    expect(before.body).toMatchObject({ enabled: false, recentChanges: [] });

    const on = await request(ctx.server).put('/operations-settings/provider-reviews').set('Cookie', cookie).send({ enabled: true }).expect(200);
    expect(on.body.enabled).toBe(true);
    expect(on.body.recentChanges[0]).toMatchObject({ setting: 'providerReviewsEnabled', previousValue: null, newValue: 'true' });

    await request(ctx.server).put('/operations-settings/provider-reviews').set('Cookie', cookie).send({ enabled: 'evet' }).expect(400);
    // Same value twice writes no second change row.
    await request(ctx.server).put('/operations-settings/provider-reviews').set('Cookie', cookie).send({ enabled: true }).expect(200);
    expect(await ctx.prisma.operationsSettingsChange.count({ where: { setting: 'providerReviewsEnabled' } })).toBe(1);
  });
});
```
(`adminCookie` bu spec'te zaten varsa kullan, yoksa `createUser SUPER_ADMIN + loginAs`.)

- [ ] **Step 2: Çalıştır → 404 ile FAIL**

- [ ] **Step 3: Servis — `marketplace-publish-settings.service.ts` birebir kopyası**

```ts
export const PROVIDER_REVIEWS_SETTING = 'providerReviewsEnabled';
export type ProviderReviewSettingsView = { enabled: boolean; recentChanges: SchedulerSettingsChangeView[] };

@Injectable()
export class ProviderReviewSettingsService {
  private readonly logger = new Logger(ProviderReviewSettingsService.name);
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Fail-closed: no row, unreadable row and false all mean "off". */
  async isEnabled(): Promise<boolean> {
    try {
      const row = await this.prisma.operationsSettings.findUnique({ where: { id: OPERATIONS_SETTINGS_ID }, select: { providerReviewsEnabled: true } });
      return row?.providerReviewsEnabled ?? false;
    } catch (error) {
      this.logger.error(`Provider reviews setting could not be read; treating it as off (${error instanceof Error ? error.name : 'UnknownError'})`);
      return false;
    }
  }
  // getForAdmin / setEnabled: copy of MarketplacePublishSettingsService with
  // `providerReviewsEnabled` and PROVIDER_REVIEWS_SETTING; label 'providerReviewSettings.set'.
}
```

Controller: `@Controller('operations-settings/provider-reviews')`, `SetSchedulerEnabledDto`
(mevcut) ile `GET`/`PUT` — `MarketplacePublishSettingsController` kopyası. Modülde
`providers`/`controllers`/`exports`'a ekle.

- [ ] **Step 4: Test PASS; commit (API)**

- [ ] **Step 5: Admin — tip, toggle, action, sayfa**

`apps/admin/lib/api.ts`: `export type ProviderReviewSettings = MarketplacePublishSettings;`
(aynı şekil). `provider-reviews-toggle.tsx` = `auto-publish-toggle.tsx` kopyası
(`toggleProviderReviewsAction`, `aria-label="Hizmet veren değerlendirmeleri: açık/kapalı"`,
`data-testid="provider-reviews-toggle"`). `actions.ts`'e `toggleProviderReviewsAction`
(`/operations-settings/provider-reviews`, `#degerlendirmeler` anchor, ok kodları
`provider-reviews-on/off`). `page.tsx`'te "Otomatik yayın" kartının altına
"Hizmet veren değerlendirmeleri" kartı (`data-testid="provider-reviews"`, state
`provider-reviews-state`, audit tablosu `provider-reviews-audit`) — açıklama: "Açıkken müşteri,
tamamlanan işin hizmet verenini değerlendirebilir; public profil ve teklif kartlarında
aggregate görünür. Kapalıyken mevcut değerlendirmeler silinmez, yalnız gizlenir."

- [ ] **Step 6: E2E ekleme (`scheduler-settings.spec.ts`)** — mevcut auto-publish toggle testinin kopyası: toggle'a tıkla → `provider-reviews-state` "Açık" → audit satırı 1 → geri kapat.

Run: `pnpm e2e scheduler-settings` → PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/operations-settings apps/api/test/operations-settings.spec.ts apps/admin/lib/api.ts apps/admin/app/operations-settings e2e/tests/scheduler-settings.spec.ts
git commit -m "feat(settings): providerReviewsEnabled switch with audit trail and admin toggle

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

**Risk:** `OperationsSettings` upsert'i `unviewedOfferRefundWindowHours` zorunlu alanını ister — kopyalanan servis bunu `DEFAULT_UNVIEWED_OFFER_REFUND_WINDOW_HOURS` ile zaten geçiyor.

---

### Task 4: URL yardımcıları + dört e-posta şablonu + render testi (45)

**Files:**
- Modify: `apps/api/src/common/web-routes.ts` (üç fonksiyon)
- Modify: `apps/api/src/modules/notifications/templates/transactional-templates.ts` (`TRANSACTIONAL_EMAIL_TEMPLATES`, `transactionalSubject`, doküman switch'i, 4 builder)
- Modify: `apps/api/test/transactional-email-render.spec.ts:520` + `FULL_DATA`

**Interfaces:**
- Produces: `customerReviewUrl(requestId)` → `/requests/<id>/degerlendir`; `providerReviewsUrl(providerId)` → `/providers/<id>/degerlendirmeler`; `adminProviderReviewUrl(reviewId)` → `<admin>/provider-reviews/<id>`; şablon adları `'review-invitation' | 'review-received' | 'review-report-new-for-support' | 'review-removed'`; data anahtarları A9 tablosundaki gibi.

- [ ] **Step 1: Render testini güncelle** — `toHaveLength(45)`; `FULL_DATA`'ya dört giriş:

```ts
'review-invitation': { fullName: 'Ayşe Yılmaz', businessName: 'Usta Klima', categoryName: 'Klima servisi', requestNumber: 'TR-2026-000123', windowEndsAt: '14 Aralık 2026', reviewUrl: 'https://taktic.example/requests/req_1/degerlendir', accountUrl: 'https://taktic.example/account/profile' },
'review-received': { fullName: 'Mehmet Usta', rating: '5', categoryName: 'Klima servisi', requestNumber: 'TR-2026-000123', reviewsUrl: 'https://taktic.example/providers/prov_1/degerlendirmeler', accountUrl: 'https://taktic.example/providers/me' },
'review-report-new-for-support': { fullName: 'Destek Ekibi', reasonLabel: 'Hakaret / uygunsuz dil', businessName: 'Usta Klima', requestNumber: 'TR-2026-000123', adminReviewUrl: 'https://admin.example/provider-reviews/rev_1', accountUrl: null },
'review-removed': { fullName: 'Ayşe Yılmaz', scopeLabel: 'Yorumunuz', reasonLabel: 'İletişim bilgisi içeriyor', requestNumber: 'TR-2026-000123', supportUrl: 'https://taktic.example/destek', accountUrl: 'https://taktic.example/account/profile' },
```

- [ ] **Step 2: Çalıştır → FAIL (41 ≠ 45, bilinmeyen şablon)**

Run: `DATABASE_URL=... pnpm --filter @taktic/api test transactional-email-render`

- [ ] **Step 3: `web-routes.ts`**

```ts
/** The customer's review form for one completed request. `apps/web/app/requests/[id]/degerlendir`. */
export function customerReviewUrl(requestId: string): string {
  return publicWebUrl(`/requests/${encodeURIComponent(requestId)}/degerlendir`);
}
/** The provider's own review list. `apps/web/app/providers/[id]/degerlendirmeler`. */
export function providerReviewsUrl(providerId: string): string {
  return publicWebUrl(`/providers/${encodeURIComponent(providerId)}/degerlendirmeler`);
}
/** One review in the operator panel. Support-inbox notices only. */
export function adminProviderReviewUrl(reviewId: string): string {
  return `${getAdminAppBaseUrl()}/provider-reviews/${encodeURIComponent(reviewId)}`;
}
```

- [ ] **Step 4: Şablon defteri + subject + dokümanlar**

`TRANSACTIONAL_EMAIL_TEMPLATES` sonuna (yorumla: "Reviews: four messages, each to exactly one
audience; the comment text is in none of them"):
`'review-invitation', 'review-received', 'review-report-new-for-support', 'review-removed'`.
Dosya başındaki "there is no rating system" notunu (`:45`) "`provider_rating` — replaced by the
review summary, which only the public profile and offer cards render, never a mail" olarak güncelle.

`transactionalSubject`:
```ts
case 'review-invitation': return withSuffix('İşiniz tamamlandı — hizmet vereni değerlendirin', text(data.businessName));
case 'review-received': return withSuffix('Yeni değerlendirme aldınız', text(data.requestNumber));
case 'review-report-new-for-support': return 'Yeni değerlendirme bildirimi';
case 'review-removed': return withSuffix(`${text(data.scopeLabel) ?? 'Değerlendirmeniz'} kaldırıldı`, text(data.requestNumber));
```

Dört builder, `requestRemoved` (`:1567-1607`) ile aynı yapıda (`audience`, `kicker`, `heading`,
`dataTable`, `cta`). Örnek:

```ts
function reviewInvitation(subject: string, fullName: string, data: Data): EmailDocument {
  return {
    subject, fullName,
    preheader: 'Tamamlanan işinizin hizmet verenini birkaç saniyede değerlendirin.',
    audience: 'HİZMET ALAN', kicker: 'İş tamamlandı', heading: 'Hizmet vereni değerlendirin',
    accountUrl: text(data.accountUrl),
    blocks: compact([
      paragraph(`${text(data.businessName) ?? 'Hizmet veren'} ile ${text(data.categoryName) ?? 'talebiniz'} işiniz tamamlandı olarak işaretlendi. Deneyiminizi 1–5 yıldızla değerlendirebilir, dilerseniz kısa bir yorum bırakabilirsiniz.`),
      spacer(4),
      dataTable([row('Talep', text(data.requestNumber)), row('Hizmet veren', text(data.businessName)), row('Son tarih', text(data.windowEndsAt))]),
      spacer(16),
      paragraph('Yorumunuz herkese açık görünür; adınız, telefonunuz ve e-postanız paylaşılmaz. Yorumda iletişim bilgisi bulunamaz.'),
      spacer(24),
      cta('Değerlendir', text(data.reviewUrl), 'primary'),
    ]),
  };
}
```
`reviewReceived` (HİZMET VEREN; satırlar: Talep, Kategori, Puan `"★ 5 / 5"`; CTA
"Değerlendirmeleri gör" → `reviewsUrl`; **yorum yok**). `reviewReportNewForSupport` (DESTEK;
satırlar: İşletme, Talep, Gerekçe; CTA → `adminReviewUrl`; not yok). `reviewRemoved` (HİZMET
ALAN; `scopeLabel` + `reasonLabel`; CTA "Destek ekibine yaz" → `supportUrl`).

- [ ] **Step 5: Render testi PASS; commit**

```bash
git add apps/api/src/common/web-routes.ts apps/api/src/modules/notifications/templates/transactional-templates.ts apps/api/test/transactional-email-render.spec.ts
git commit -m "feat(mail): review invitation, received, report and removed templates

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

**Risk:** Render testi her şablonda "no placeholder link" arar (`:573`) — `accountUrl: null` yalnızca destek şablonunda; müşteri/sağlayıcı şablonlarında `accountUrl` zorunlu.

---

### Task 5: Mail servisi — gönderim metotları, retry prefix/rebuild, data builder'lar

**Files:**
- Modify: `apps/api/src/modules/notifications/transactional-mail.service.ts` (`RETRY_DEDUPE_PREFIXES:2494`, `RETRY_SOURCE_ID_COUNT:2576`, `rebuild` switch `:1013+`, yeni `send*`, data builder'lar, `loadReview`)
- Create: `apps/api/src/modules/provider-reviews/provider-review-copy.ts` (etiketler; mail servisi import eder — modül bağımlılığı yok, saf sabit)
- Create: `apps/api/src/modules/provider-reviews/provider-review-window.ts`
- Test: `apps/api/test/provider-review-notifications.spec.ts`

**Interfaces:**
- Consumes: Task 3 `ProviderReviewSettingsService` (NotificationsModule `OperationsSettingsModule`'ü import etmiyor → `isEnabled` okuması için mail servisine `PrismaService` ile doğrudan fail-closed okuma yapan küçük yardımcı `readProviderReviewsEnabled(prisma)` yaz; **aynı** dosyada export et ki Task 7 de kullansın).
- Produces: `sendReviewReceived(reviewId)`, `sendReviewReportNewForSupport(reportId)`, `sendReviewRemoved(reviewId, removedAt: Date)`; `composeRetryMessage` dört şablon için; `reviewWindowEndsAt(completedAt: Date): Date`, `isReviewWindowOpen(completedAt, now)`; `REVIEW_REASON_CUSTOMER_LABELS`, `REVIEW_REASON_ADMIN_LABELS`, `REVIEW_SCOPE_LABELS`.

- [ ] **Step 1: Saf yardımcılar**

`provider-review-window.ts`:
```ts
import { PROVIDER_REVIEW_WINDOW_DAYS } from '../../common/provider-review-limits';
const DAY_MS = 24 * 60 * 60 * 1000;
export function reviewWindowEndsAt(completedAt: Date): Date {
  return new Date(completedAt.getTime() + PROVIDER_REVIEW_WINDOW_DAYS * DAY_MS);
}
export function isReviewWindowOpen(completedAt: Date, now = new Date()): boolean {
  return now.getTime() <= reviewWindowEndsAt(completedAt).getTime();
}
```
`provider-review-copy.ts`:
```ts
export const REVIEW_REASON_CUSTOMER_LABELS: Record<ProviderReviewReportReason, string> = {
  OFFENSIVE: 'Hakaret veya uygunsuz dil', CONTAINS_CONTACT_INFO: 'İletişim bilgisi içeriyor',
  NOT_ABOUT_THIS_JOB: 'Bu işle ilgili değil', SUSPECTED_FAKE: 'Gerçek bir deneyime dayanmıyor', OTHER: 'Platform kurallarına aykırı',
};
export const REVIEW_REASON_ADMIN_LABELS: Record<ProviderReviewReportReason, string> = {
  OFFENSIVE: 'Hakaret / uygunsuz dil', CONTAINS_CONTACT_INFO: 'İletişim bilgisi', NOT_ABOUT_THIS_JOB: 'İşle ilgisiz', SUSPECTED_FAKE: 'Sahte şüphesi', OTHER: 'Diğer',
};
export const REVIEW_SCOPE_LABELS = { COMMENT: 'Yorumunuz', REVIEW: 'Değerlendirmeniz' } as const;
```

- [ ] **Step 2: Bildirim testini yaz (`provider-review-notifications.spec.ts`)**

Kurulum: `completedJob()` (Task 2'deki gibi, ama `/complete` uç noktası yerine doğrudan DB) +
anahtar açık (`ctx.prisma.operationsSettings.upsert(... providerReviewsEnabled: true)`).
Testler:
```ts
it('review-received goes to the provider once, without the comment or the customer', async () => {
  const job = await completedJob();
  const review = await ctx.prisma.providerReview.create({ data: { ...ids(job), rating: 5, comment: 'Harika iş, teşekkürler Ayşe' } });
  const mail = ctx.app.get(TransactionalMailService);
  await mail.sendReviewReceived(review.id);
  await mail.sendReviewReceived(review.id);
  const sent = ctx.notifications.ofTemplate('review-received');
  expect(sent).toHaveLength(1);
  expect(JSON.stringify(sent[0]!.data)).not.toMatch(/Harika|Ayşe|0555/);
  expect(sent[0]!.data.rating).toBe('5');
  const logs = await ctx.prisma.notificationLog.findMany({ where: { template: 'review-received' } });
  expect(logs).toHaveLength(1);
  expect(logs[0]!.dedupeKey).toBe(`review-received:${review.id}`);
});
it('review-removed carries the scope and a fixed label, is keyed on the removal instant, and does not rebuild after RESTORE', ...)
it('review-report-new-for-support goes to the support inbox without the note', ...)
it('composeRetryMessage rebuilds each of the four from its key and returns null when the source no longer supports it', ...)
```
`review-invitation` rebuild testi: `mail.composeRetryMessage('review-invitation', 'review-invitation:<requestId>')`
→ `to === customerEmail`, `data.reviewUrl` `/degerlendir` içerir; `completedAt` 91 gün geriye
çekilince `null`; değerlendirme yazılınca `null`; anahtar kapalıyken `null`.

- [ ] **Step 3: Çalıştır → FAIL (metot yok)**

- [ ] **Step 4: Uygulama**

`RETRY_DEDUPE_PREFIXES`'e: `'review-invitation': 'review-invitation', 'review-received': 'review-received', 'review-report-new-for-support': 'review-report-new', 'review-removed': 'review-removed'`;
`RETRY_SOURCE_ID_COUNT`'a dördü `1`.

```ts
async function loadReview(prisma: PrismaService, reviewId: string) {
  return prisma.providerReview.findUnique({
    where: { id: reviewId },
    select: {
      id: true, rating: true, removedAt: true, commentRemovedAt: true, createdAt: true,
      request: { select: { id: true, requestNumber: true, customerName: true, customerEmail: true, customerId: true, category: { select: { name: true } } } },
      provider: { select: { id: true, businessName: true, contactName: true, email: true, userId: true, user: { select: { email: true } } } },
      moderation: { where: { action: { in: ['REMOVE_COMMENT', 'REMOVE_REVIEW'] } }, orderBy: { createdAt: 'desc' }, take: 1, select: { action: true, reason: true, createdAt: true } },
    },
  });
}

export async function readProviderReviewsEnabled(prisma: Pick<PrismaService, 'operationsSettings'>): Promise<boolean> {
  try {
    const row = await prisma.operationsSettings.findUnique({ where: { id: 'singleton' }, select: { providerReviewsEnabled: true } });
    return row?.providerReviewsEnabled ?? false;
  } catch { return false; }
}

async sendReviewReceived(reviewId: string) {
  const review = await loadReview(this.prisma, reviewId);
  if (!review || review.removedAt) return;
  const to = recipientFor(review.provider);
  if (!to) return;
  await this.send('review-received', to, reviewReceivedData(review), {
    requestId: review.request.id, providerId: review.provider.id, userId: review.provider.userId,
    dedupeKey: `review-received:${review.id}`,
  });
}

async sendReviewRemoved(reviewId: string, removedAt: Date) {
  const review = await loadReview(this.prisma, reviewId);
  const scope = removalScopeOf(review);           // 'REVIEW' | 'COMMENT' | null
  if (!review?.request.customerEmail || !scope) return;
  await this.send('review-removed', review.request.customerEmail, reviewRemovedData(review, scope), {
    requestId: review.request.id, userId: review.request.customerId, providerId: review.provider.id,
    dedupeKey: `review-removed:${review.id}:${removedAt.toISOString()}`,
  });
}
```
`removalScopeOf`: `removedAt` dolu → `'REVIEW'`; yalnız `commentRemovedAt` dolu → `'COMMENT'`;
ikisi de boş → `null`. `reasonLabel` = `REVIEW_REASON_CUSTOMER_LABELS[review.moderation[0]?.reason ?? 'OTHER']`.

`rebuild` case'leri:
```ts
case 'review-invitation': {
  const request = await loadRequestForReview(this.prisma, source.ids[0]); // select status, customerEmail, customerName, customerId, completedAt, requestNumber, category.name, matchedOffer.provider.businessName, review.id
  if (!request?.customerEmail || request.status !== ServiceRequestStatus.COMPLETED || !request.completedAt) return null;
  if (!isReviewWindowOpen(request.completedAt) || request.review) return null;
  if (!(await readProviderReviewsEnabled(this.prisma))) return null;
  return { to: request.customerEmail, data: reviewInvitationData(request) };
}
case 'review-received': { const review = await loadReview(...); if (!review || review.removedAt) return null; const to = recipientFor(review.provider); return to ? { to, data: reviewReceivedData(review) } : null; }
case 'review-report-new-for-support': { const report = await this.prisma.providerReviewReport.findUnique({ where: { id: source.ids[0] }, select: { id: true, reason: true, review: { select: { id: true, provider: { select: { businessName: true } }, request: { select: { requestNumber: true, id: true } } } } } }); return report ? { to: readSupportInboxEmail(), data: reviewReportNewForSupportData(report) } : null; }
case 'review-removed': { const review = await loadReview(...); const scope = removalScopeOf(review); return review?.request.customerEmail && scope ? { to: review.request.customerEmail, data: reviewRemovedData(review, scope) } : null; }
```
`windowEndsAt` formatı: mevcut `formatDate` (`templates/format.ts`).

- [ ] **Step 5: Test PASS; `transactional-email-events.spec.ts` ve `notification-retry.spec.ts` hâlâ PASS; commit**

```bash
git commit -am "feat(mail): review notifications with dedupe keys and retry rebuild

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

**Risk:** `RETRY_DEDUPE_PREFIXES` `Record<...>` tipi exhaustive — bir şablon unutulursa typecheck düşer (istenen).

---

### Task 6: `ReviewInvitationOutbox` + `completeServiceRequest` transaction'ı + scheduler sweep

**Files:**
- Create: `apps/api/src/modules/notifications/review-invitation-outbox.service.ts`
- Modify: `apps/api/src/modules/notifications/notifications.module.ts` (provider + export)
- Modify: `apps/api/src/modules/service-requests/service-requests.service.ts:1096-1114` (+ constructor inject)
- Modify: `apps/api/src/modules/request-lifecycle/request-lifecycle-scheduler.service.ts:85-89`
- Test: `apps/api/test/review-invitation-outbox.spec.ts`; `request-lifecycle.spec.ts` PASS kalmalı

**Interfaces:**
- Produces: `ReviewInvitationOutbox.enqueue(tx, requestId, completedAt): Promise<{ enqueued: number }>`, `deliverPending({ limit? })`, `deliverSoon()`; sabit `REVIEW_INVITATION_TEMPLATES = ['review-invitation'] as const`.

- [ ] **Step 1: Test**

```ts
it('completing a request writes one review-invitation intent inside the transaction and delivers it once', async () => {
  await enableReviews();
  const { customerCookie, serviceRequest } = await matchedRequest();   // via /offers/:id/action ACCEPT_OFFER
  await request(ctx.server).post(`/service-requests/${serviceRequest.id}/complete`).set('Cookie', customerCookie).expect(201);
  const outbox = ctx.app.get(ReviewInvitationOutbox);
  await outbox.deliverPending();
  const logs = await ctx.prisma.notificationLog.findMany({ where: { template: 'review-invitation' } });
  expect(logs).toHaveLength(1);
  expect(logs[0]).toMatchObject({ dedupeKey: `review-invitation:${serviceRequest.id}`, status: 'SENT', requestId: serviceRequest.id });
  expect(ctx.notifications.ofTemplate('review-invitation')).toHaveLength(1);
  expect(ctx.notifications.ofTemplate('review-invitation')[0]!.data.reviewUrl).toContain(`/requests/${serviceRequest.id}/degerlendir`);
});
it('a second /complete is 409 and adds no intent; two parallel completes leave exactly one intent', ...)   // Promise.allSettled([post, post]) → statuses [201, 409] herhangi sırada; count 1
it('writes no intent while the switch is off', ...)
it('an admin completing on the customer\'s behalf still invites the customer', ...)
it('the scheduler tick sweeps an intent a crashed delivery left behind', async () => {
  // create intent row directly with attemptCount 0, lastAttemptAt null → runScheduledExpiry (settings enabled) → SENT
});
```

- [ ] **Step 2: FAIL (sınıf yok)**

- [ ] **Step 3: Outbox sınıfı** — `request-publish-outbox.service.ts:38-197` kopyası, tek şablon:

```ts
export const REVIEW_INVITATION_TEMPLATES = ['review-invitation'] as const;

async enqueue(tx: Prisma.TransactionClient, requestId: string, completedAt: Date): Promise<{ enqueued: number }> {
  if (!(await readProviderReviewsEnabled(tx))) return { enqueued: 0 };
  const request = await tx.serviceRequest.findUnique({ where: { id: requestId }, select: { id: true, status: true, customerId: true, customerEmail: true } });
  const to = request?.customerEmail?.trim();
  if (!request || request.status !== ServiceRequestStatus.COMPLETED || !to) return { enqueued: 0 };
  const created = await tx.notificationLog.createMany({
    data: [intentRow({ template: 'review-invitation', to, dedupeKey: `review-invitation:${request.id}`, requestId: request.id, userId: request.customerId, providerId: null })],
    skipDuplicates: true,
  });
  this.logger.log(`review invitation intent for ${request.id}: enqueued=${created.count}`);
  return { enqueued: created.count };
}
```
`deliverPending`/`deliverSoon`/`onModuleDestroy` birebir (label `'review-invitation'`,
`templates: REVIEW_INVITATION_TEMPLATES`). `completedAt` parametresi ileride anahtar taşımak için
tutulur; v1'de anahtarda yok (talep bir kez tamamlanır).

- [ ] **Step 4: `completeServiceRequest`**

```ts
async completeServiceRequest(id: string, user: AuthUser) {
  const request = await this.getRequestForLifecycleAction(id, user);
  if (request.status !== ServiceRequestStatus.MATCHED) throw new ConflictException('Only a matched request can be completed');
  const now = new Date();
  await runSerializable(this.prisma, async (tx) => {
    const updated = await tx.serviceRequest.updateMany({ where: { id, status: ServiceRequestStatus.MATCHED }, data: { status: ServiceRequestStatus.COMPLETED, completedAt: now } });
    if (updated.count !== 1) throw new ConflictException('Only a matched request can be completed');
    // The invitation is owed by the same transaction that finished the job:
    // a crash between the two can no longer lose it, and a retry of this
    // request collides on (template, dedupeKey) and adds nothing.
    await this.reviewInvitations.enqueue(tx, id, now);
  }, { label: 'serviceRequests.complete' });
  this.reviewInvitations.deliverSoon();
  return this.getLifecycleProjection(id);
}
```
Constructor: `@Inject(ReviewInvitationOutbox) private readonly reviewInvitations: ReviewInvitationOutbox`.
Scheduler: `const invitations = await this.reviewInvitationOutbox.deliverPending({ limit });`
+ summary'ye `reviewInvitationsSent=${invitations.sent}`.

- [ ] **Step 5: Testler PASS (`review-invitation-outbox`, `request-lifecycle`, `scheduler-settings`); commit**

```bash
git commit -am "feat(requests): complete inside a transaction and enqueue the review invitation as an outbox intent

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

**Risk:** `ConflictException` runSerializable içinde fırlatılınca retry edilmemeli — `runSerializable` yalnız P2034'ü tekrar dener (`serializable-transaction.ts:15-17`); `cancelServiceRequest` aynı deseni kullanıyor (`:1129-1145`).

---

### Task 7: `ProviderReviewsModule` çekirdeği — oluşturma, müşteri durumu, saf yardımcılar

**Files:**
- Create: `provider-reviews.module.ts`, `provider-reviews.constants.ts`, `provider-review-comment.ts`, `provider-review-aggregate.ts`, `provider-reviews.service.ts`, `customer-provider-reviews.controller.ts`, `dto/create-provider-review.dto.ts`
- Modify: `apps/api/src/app.module.ts` (`ProviderReviewsModule` — `ProvidersModule`'den sonra herhangi bir yer; rota çakışması yok)
- Test: `apps/api/test/provider-reviews.spec.ts`

**Interfaces:**
- Consumes: Task 1 `assertNoContactDetails`, limits; Task 5 `sendReviewReceived`, `reviewWindowEndsAt`, `isReviewWindowOpen`, `readProviderReviewsEnabled`.
- Produces: `ProviderReviewsService.createForCustomer(requestId, user: AuthUser, dto): Promise<CustomerReviewState>`, `getForCustomer(requestId, user): Promise<CustomerReviewState>`, `normalizeComment(raw: string | null | undefined): string | null`, `toReviewSummary(rows: { rating: number; _count: number }[]): ReviewSummary`, `toPublicSummary(summary: ReviewSummary): PublicReviewSummary`; hata kodları sabitleri.

- [ ] **Step 1: Sabitler ve saf yardımcılar**

`provider-reviews.constants.ts`:
```ts
export const REVIEWS_DISABLED_CODE = 'REVIEWS_DISABLED';
export const REQUEST_NOT_COMPLETED_CODE = 'REQUEST_NOT_COMPLETED';
export const MATCH_INCONSISTENT_CODE = 'MATCH_INCONSISTENT';
export const REVIEW_WINDOW_CLOSED_CODE = 'REVIEW_WINDOW_CLOSED';
export const REVIEW_ALREADY_EXISTS_CODE = 'REVIEW_ALREADY_EXISTS';
export const REVIEW_NOT_REPORTABLE_CODE = 'REVIEW_NOT_REPORTABLE';
export const REVIEW_REPORT_ALREADY_EXISTS_CODE = 'REVIEW_REPORT_ALREADY_EXISTS';
export const REVIEW_REPORT_RATE_LIMITED_CODE = 'REVIEW_REPORT_RATE_LIMITED';
export const REVIEW_MODERATION_NOOP_CODE = 'REVIEW_MODERATION_NOOP';
export const NO_OPEN_REVIEW_REPORT_CODE = 'NO_OPEN_REVIEW_REPORT';
export const REVIEW_REPORT_MAX_PER_PROVIDER_PER_DAY = 20;
export const REVIEW_REPORT_NOTE_MAX_LENGTH = 500;
export const REVIEW_MODERATION_NOTE_MAX_LENGTH = 500;
export const REVIEW_LIST_DEFAULT_LIMIT = 20;
export const REVIEW_LIST_MAX_LIMIT = 50;
export const PUBLIC_REVIEW_LIST_MAX_LIMIT = 20;
```
`provider-review-comment.ts`:
```ts
/** Trim, drop control characters except newline, collapse runs of blanks, cap newlines; empty → null. */
export function normalizeComment(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned.length === 0 ? null : cleaned;
}
```
`provider-review-aggregate.ts`:
```ts
export type ReviewSummary = { count: number; average: number | null; distribution: Record<'1'|'2'|'3'|'4'|'5', number> };
export type PublicReviewSummary = { count: number; average: number } | null;

export function toReviewSummary(rows: ReadonlyArray<{ rating: number; count: number }>): ReviewSummary {
  const distribution = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 } as ReviewSummary['distribution'];
  let count = 0; let sum = 0;
  for (const row of rows) { distribution[String(row.rating) as keyof typeof distribution] += row.count; count += row.count; sum += row.rating * row.count; }
  return { count, average: count === 0 ? null : Math.round((sum / count) * 100) / 100, distribution };
}
export function toPublicSummary(summary: ReviewSummary): PublicReviewSummary {
  return summary.count >= PROVIDER_REVIEW_PUBLIC_MIN_COUNT && summary.average !== null
    ? { count: summary.count, average: summary.average }
    : null;
}
```

- [ ] **Step 2: Testleri yaz (`provider-reviews.spec.ts`)**

Kurulum yardımcıları: `enableReviews()`, `matchedRequest()` (`request-lifecycle.spec.ts:146-176`
kalıbı: `createApprovedRequest` + `addOffer` + `ACCEPT_OFFER`), `completeAs(cookie, id)`.

```ts
const reviewUrl = (id: string) => `/service-requests/${id}/review`;

it('the owner rates the matched provider once after COMPLETED; provider is derived from the accepted offer', async () => {
  await enableReviews();
  const { customerCookie, serviceRequest, winner } = await matchedRequest();
  await completeAs(customerCookie, serviceRequest.id);
  const res = await request(ctx.server).post(reviewUrl(serviceRequest.id)).set('Cookie', customerCookie)
    .send({ rating: 5, comment: '  Çok  memnun kaldım.  ' }).expect(201);
  expect(res.body.eligibility).toBe('already-reviewed');
  expect(res.body.review).toMatchObject({ rating: 5, comment: 'Çok memnun kaldım.', removed: false });
  const stored = await ctx.prisma.providerReview.findUniqueOrThrow({ where: { offerId: winner.offerId } });
  expect(stored.providerId).toBe(winner.provider.id);
  const dup = await request(ctx.server).post(reviewUrl(serviceRequest.id)).set('Cookie', customerCookie).send({ rating: 1 }).expect(409);
  expect(dup.body.code).toBe('REVIEW_ALREADY_EXISTS');
});
it('refuses while MATCHED (409 REQUEST_NOT_COMPLETED), CANCELLED, and for a request that is not mine (403)', ...)
it('refuses a provider, a super admin and an anonymous caller (403/401)', ...)
it('refuses after 90 days (409 REVIEW_WINDOW_CLOSED) and reports window-closed eligibility', async () => {
  // completedAt = now - 91d via prisma.update → 409; GET → eligibility 'window-closed', windowEndsAt present
});
it('refuses rating 0, 6, 2.5, a 601-code-unit comment, and a comment with a phone number (400 CONTACT_DETAILS_IN_TEXT field=comment)', ...)
it('is 404 REVIEWS_DISABLED while the switch is off and GET reports disabled', ...)
it('ten parallel submissions leave exactly one row', async () => {
  const results = await Promise.allSettled(Array.from({ length: 10 }, () =>
    request(ctx.server).post(reviewUrl(serviceRequest.id)).set('Cookie', customerCookie).send({ rating: 4 })));
  const statuses = results.map((r) => (r.status === 'fulfilled' ? r.value.status : 500));
  expect(statuses.filter((s) => s === 201)).toHaveLength(1);
  expect(statuses.filter((s) => s === 409)).toHaveLength(9);
  expect(await ctx.prisma.providerReview.count()).toBe(1);
});
it('sends review-received to the provider after the commit', ...)  // ctx.notifications.ofTemplate('review-received') length 1
it('GET eligibility for a SUSPENDED provider is still ok and creation succeeds', ...)
it('leaves the credit ledger and entitlements untouched', ...)  // count ProviderCreditTransaction before/after
```

- [ ] **Step 3: FAIL (404 rota yok)**

- [ ] **Step 4: DTO, servis, controller, modül**

```ts
// dto/create-provider-review.dto.ts
export class CreateProviderReviewDto {
  @IsInt() @Min(1) @Max(5) rating!: number;
  @IsOptional() @IsString() @MaxCodeUnitLength(PROVIDER_REVIEW_COMMENT_MAX_LENGTH) comment?: string | null;
}
```

```ts
@Injectable()
export class ProviderReviewsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService,
              @Inject(TransactionalMailService) private readonly mail: TransactionalMailService) {}

  async createForCustomer(requestId: string, user: AuthUser, dto: CreateProviderReviewDto): Promise<CustomerReviewState> {
    if (!(await readProviderReviewsEnabled(this.prisma))) throw notFound(REVIEWS_DISABLED_CODE, 'Değerlendirme özelliği kapalı.');
    const request = await this.loadForCustomer(requestId, user);      // 404 / 403 as getRequestForLifecycleAction
    if (request.status !== ServiceRequestStatus.COMPLETED) throw conflict(REQUEST_NOT_COMPLETED_CODE, 'Yalnızca tamamlanmış bir iş değerlendirilebilir.');
    const offer = request.matchedOffer;
    if (!offer || offer.status !== OfferStatus.ACCEPTED) throw conflict(MATCH_INCONSISTENT_CODE, 'Bu talebin kabul edilmiş bir teklifi bulunamadı.');
    if (!request.completedAt || !isReviewWindowOpen(request.completedAt)) throw conflict(REVIEW_WINDOW_CLOSED_CODE, 'Değerlendirme süresi doldu.');
    const comment = normalizeComment(dto.comment);
    assertNoContactDetails('comment', comment);
    let review;
    try {
      review = await this.prisma.providerReview.create({
        data: { requestId: request.id, offerId: offer.id, providerId: offer.providerId, customerUserId: user.id, rating: dto.rating, comment },
        select: { id: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw conflict(REVIEW_ALREADY_EXISTS_CODE, 'Bu iş için değerlendirmeniz zaten var.');
      throw error;
    }
    await this.notifySafely(() => this.mail.sendReviewReceived(review.id), request.id);
    return this.getForCustomer(requestId, user);
  }

  async getForCustomer(requestId: string, user: AuthUser): Promise<CustomerReviewState> { /* select request + matchedOffer.provider + review (+ latest REMOVE_* moderation reason); compute eligibility in the same order as create; windowEndsAt = completedAt ? reviewWindowEndsAt(completedAt) : null */ }
}
```
`loadForCustomer`: `findUnique` → yoksa 404; `user.role === SUPER_ADMIN` geçer;
`user.role !== CUSTOMER || request.customerId !== user.id` → 403 (`service-requests.service.ts:1154-1176`
metni). `conflict()`/`notFound()` yardımcıları `{ statusCode, error, code, message }` gövdesiyle.

Controller:
```ts
@Controller('service-requests/:id/review')
export class CustomerProviderReviewsController {
  @Post() @UseGuards(AuthGuard, RolesGuard) @Roles(UserRole.CUSTOMER)
  create(@Param('id') id: string, @Body() dto: CreateProviderReviewDto, @CurrentUser() user: AuthUser) { return this.reviews.createForCustomer(id, user, dto); }
  @Get() @UseGuards(AuthGuard, RolesGuard) @Roles(UserRole.CUSTOMER, UserRole.SUPER_ADMIN)
  get(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.reviews.getForCustomer(id, user); }
}
```
Modül: `imports: [PrismaModule, AuthModule]`, `providers: [ProviderReviewsService]`,
`exports: [ProviderReviewsService]` (moderasyon servisi Task 9'da eklenir). `AppModule` listesine.

- [ ] **Step 5: PASS; commit**

```bash
git add apps/api/src/modules/provider-reviews apps/api/src/app.module.ts apps/api/test/provider-reviews.spec.ts
git commit -m "feat(reviews): customers rate the matched provider once after completion

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

**Risk:** `GET :id` `ServiceRequestsController`'da `/service-requests/:id` tek segment; `/service-requests/:id/review` iki segment — çakışma yok (test `request-reports-admin` deseniyle 200 pinlenir).

---

### Task 8: Sağlayıcı paneli ve public liste uçları; aggregate ve 3-eşiği

**Files:**
- Modify: `provider-reviews.service.ts` (+ `listForProvider`, `summaryForProvider`, `summariesForProviders`, `publicSummariesForProviders`, `listPublic`)
- Create: `provider-panel-reviews.controller.ts`, `public-provider-reviews.controller.ts`
- Test: `apps/api/test/provider-reviews-aggregate.spec.ts`

**Interfaces:**
- Produces: `summariesForProviders(ids: string[]): Promise<Map<string, ReviewSummary>>`, `publicSummariesForProviders(ids): Promise<Map<string, PublicReviewSummary>>` (Task 10 tüketir), `listForProvider(providerId, cursor: string | null, limit: number)`, `listPublic(providerId, cursor, limit)`; rotalar `GET /providers/:providerId/reviews`, `/summary`, `GET /providers/:id/reviews/public`.

- [ ] **Step 1: Testler**

```ts
it('averages live rows only, to two decimals, with a distribution', async () => {
  // three completed jobs for the same provider, ratings 5,4,3 → summary { count: 3, average: 4, distribution {5:1,4:1,3:1} }
});
it('public summary is null below three live reviews and appears at three', async () => {
  // 2 reviews → GET /providers/:id/reviews/public → summary null, items [] ; add third → { count: 3, average: 4 }
});
it('REMOVE_COMMENT keeps the star, REMOVE_REVIEW drops it, RESTORE brings it back', async () => {
  // via prisma updates on the row (moderation endpoints are Task 9): count 3→3→2→3
});
it('public items carry only rating, comment, month and category — never a name, phone, e-mail or request number', async () => {
  const body = (await request(ctx.server).get(`/providers/${provider.id}/reviews/public`).expect(200)).body;
  expect(Object.keys(body.items[0]).sort()).toEqual(['categoryName', 'comment', 'id', 'month', 'rating']);
  expect(body.items[0].month).toMatch(/^\d{4}-\d{2}$/);
  expect(JSON.stringify(body)).not.toMatch(/Müşteri |0555|@example\.test|TR-TEST/);
});
it('public list is 404 for a non-APPROVED provider and while the switch is off; provider panel still lists its own', ...)
it('provider panel list hides the removed review, marks commentRemoved, exposes myReport, and never carries the customer', ...)
it('cursor pagination walks the provider list in createdAt desc, id desc order', ...)
```

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Servis**

```ts
async summariesForProviders(providerIds: readonly string[]): Promise<Map<string, ReviewSummary>> {
  const result = new Map<string, ReviewSummary>();
  if (providerIds.length === 0) return result;
  const rows = await this.prisma.providerReview.groupBy({
    by: ['providerId', 'rating'],
    where: { providerId: { in: [...providerIds] }, removedAt: null },
    _count: { _all: true },
  });
  for (const id of providerIds) result.set(id, toReviewSummary([]));
  const byProvider = new Map<string, { rating: number; count: number }[]>();
  for (const row of rows) byProvider.set(row.providerId, [...(byProvider.get(row.providerId) ?? []), { rating: row.rating, count: row._count._all }]);
  for (const [id, entries] of byProvider) result.set(id, toReviewSummary(entries));
  return result;
}
async publicSummariesForProviders(ids) { const m = await this.summariesForProviders(ids); return new Map([...m].map(([id, s]) => [id, toPublicSummary(s)])); }
async summaryForProvider(id) { return (await this.summariesForProviders([id])).get(id)!; }

async listForProvider(providerId: string, cursor: string | null, limit: number) {
  const take = Math.min(Math.max(1, limit), REVIEW_LIST_MAX_LIMIT);
  const rows = await this.prisma.providerReview.findMany({
    where: { providerId, removedAt: null },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: take + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: { id: true, rating: true, comment: true, commentRemovedAt: true, createdAt: true,
      request: { select: { id: true, requestNumber: true, category: { select: { name: true } } } },
      reports: { where: { reporterProviderId: providerId }, orderBy: { createdAt: 'desc' }, take: 1, select: { reason: true, createdAt: true, resolution: true } } },
  });
  const page = rows.slice(0, take);
  return {
    summary: await this.summaryForProvider(providerId),
    items: page.map((r) => ({
      id: r.id, rating: r.rating, comment: r.commentRemovedAt ? null : r.comment, commentRemoved: r.commentRemovedAt !== null, createdAt: r.createdAt,
      request: { id: r.request.id, requestNumber: r.request.requestNumber, categoryName: r.request.category.name },
      myReport: r.reports[0] ?? null,
    })),
    nextCursor: rows.length > take ? page[page.length - 1]!.id : null,
  };
}

async listPublic(providerId: string, cursor: string | null, limit: number) {
  const provider = await this.prisma.providerProfile.findUnique({ where: { id: providerId }, select: { status: true } });
  if (!provider || !isPubliclyVisibleProvider(provider.status) || !(await readProviderReviewsEnabled(this.prisma))) throw new NotFoundException('Provider not found');
  const take = Math.min(Math.max(1, limit), PUBLIC_REVIEW_LIST_MAX_LIMIT);
  const rows = await this.prisma.providerReview.findMany({
    where: { providerId, removedAt: null, commentRemovedAt: null, comment: { not: null } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: take + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: { id: true, rating: true, comment: true, createdAt: true, request: { select: { category: { select: { name: true } } } } },
  });
  const page = rows.slice(0, take);
  return {
    summary: toPublicSummary(await this.summaryForProvider(providerId)),
    items: page.map((r) => ({ id: r.id, rating: r.rating, comment: r.comment!, month: r.createdAt.toISOString().slice(0, 7), categoryName: r.request.category.name })),
    nextCursor: rows.length > take ? page[page.length - 1]!.id : null,
  };
}
```
`isPubliclyVisibleProvider` `providers.service.ts:1943`'ten import (saf fonksiyon; modül
bağımlılığı yaratmaz).

Controller'lar: `@Controller('providers/:providerId/reviews') @UseGuards(AuthGuard, ProviderAccessGuard)`
→ `GET` (`cursor`, `limit` query; parse `request-reports admin controller:36-44` kalıbı), `GET summary`.
`@Controller('providers/:id/reviews/public') @UseGuards(OptionalAuthGuard)` → `GET`.
**Sıra:** `public-provider-reviews.controller.ts` `ProvidersModule`'ün `GET :id`'siyle çakışmaz
(segment sayısı farklı). `ProviderAccessGuard` `PrismaModule` ister → modül `imports`'ta var.

- [ ] **Step 4: PASS; commit**

```bash
git commit -am "feat(reviews): provider panel list, public list and live aggregate with the 3-review threshold

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

**Risk:** `groupBy` `where.providerId in` 50'yi aşan feed sayfası yok (`SHOWCASE_FEED_MAX_LIMIT`); teklif listesi talep başına sınırlı.

---

### Task 9: Rapor + admin moderasyon (servis, controller'lar, kuyruk)

**Files:**
- Create: `provider-review-moderation.service.ts`, `admin-provider-reviews.controller.ts`, `dto/create-provider-review-report.dto.ts`, `dto/moderate-provider-review.dto.ts`, `dto/dismiss-provider-review-report.dto.ts`
- Modify: `provider-panel-reviews.controller.ts` (+ `POST :reviewId/reports`), `provider-reviews.module.ts`
- Test: `apps/api/test/provider-review-moderation.spec.ts`

**Interfaces:**
- Produces: `ProviderReviewModerationService.reportForProvider(providerId, reviewId, dto)`, `listQueue(state, cursor, limit)`, `getForAdmin(reviewId): Promise<AdminReviewDetail>`, `moderate(reviewId, dto, adminUserId)`, `dismissReport(reviewId, dto, adminUserId)`; rotalar A5.

- [ ] **Step 1: Testler**

```ts
it('only the reviewed provider can report, once while open; a rival is 404; no comment is 409 REVIEW_NOT_REPORTABLE', ...)
it('a report hides nothing: the public list still shows the comment', ...)
it('caps a provider at 20 review reports per day (429 REVIEW_REPORT_RATE_LIMITED)', ...)
it('REMOVE_COMMENT resolves the open report as COMMENT_REMOVED, writes a moderation row, keeps the star, mails review-removed with scope COMMENT', ...)
it('REMOVE_REVIEW drops the row from the aggregate and the provider list; the customer still sees it as removed with the fixed reason', ...)
it('RESTORE clears both stamps without a mail; a repeated REMOVE_REVIEW after restore is a new removal with a new dedupe key', ...)
it('moderating twice is 409 REVIEW_MODERATION_NOOP; REMOVE_* without reason is 400; dismiss with no open report is 409', ...)
it('the queue lists open reports oldest first with a cursor and shows the last decision under resolved', ...)
it('review-report-new-for-support reaches the support inbox once, without the note', ...)
```

- [ ] **Step 2: FAIL**

- [ ] **Step 3: DTO'lar**

```ts
export class CreateProviderReviewReportDto {
  @IsEnum(ProviderReviewReportReason) reason!: ProviderReviewReportReason;
  @IsOptional() @IsString() @MaxCodeUnitLength(REVIEW_REPORT_NOTE_MAX_LENGTH) note?: string | null;
}
export class ModerateProviderReviewDto {
  @IsEnum(ProviderReviewModerationAction) action!: ProviderReviewModerationAction;
  @ValidateIf((o) => o.action !== 'RESTORE') @IsEnum(ProviderReviewReportReason) reason?: ProviderReviewReportReason;
  @IsOptional() @IsString() @MaxCodeUnitLength(REVIEW_MODERATION_NOTE_MAX_LENGTH) note?: string | null;
}
export class DismissProviderReviewReportDto {
  @IsOptional() @IsString() @MaxCodeUnitLength(REVIEW_MODERATION_NOTE_MAX_LENGTH) resolutionNote?: string | null;
}
```

- [ ] **Step 4: Servis**

```ts
const DAY_MS = 24 * 60 * 60 * 1000;

async reportForProvider(providerId: string, reviewId: string, dto: CreateProviderReviewReportDto) {
  const review = await this.prisma.providerReview.findFirst({ where: { id: reviewId, providerId }, select: { id: true, comment: true, commentRemovedAt: true, removedAt: true } });
  if (!review) throw new NotFoundException('Review not found');          // a rival's review is indistinguishable from none
  if (!review.comment || review.commentRemovedAt || review.removedAt) throw conflict(REVIEW_NOT_REPORTABLE_CODE, 'Bu değerlendirmede bildirilecek bir yorum yok.');
  const open = await this.prisma.providerReviewReport.count({ where: { reviewId, resolvedAt: null } });
  if (open > 0) throw conflict(REVIEW_REPORT_ALREADY_EXISTS_CODE, 'Bu yorumu zaten bildirdiniz; inceleme bekliyor.');
  const since = new Date(Date.now() - DAY_MS);
  if ((await this.prisma.providerReviewReport.count({ where: { reporterProviderId: providerId, createdAt: { gte: since } } })) >= REVIEW_REPORT_MAX_PER_PROVIDER_PER_DAY)
    throw tooMany(REVIEW_REPORT_RATE_LIMITED_CODE, 'Günlük bildirim sınırına ulaştınız.');
  let report;
  try {
    report = await this.prisma.providerReviewReport.create({ data: { reviewId, reporterProviderId: providerId, reason: dto.reason, note: dto.note?.trim() || null }, select: { id: true, reason: true, createdAt: true } });
  } catch (error) {
    if (isOpenReportConflict(error)) throw conflict(REVIEW_REPORT_ALREADY_EXISTS_CODE, 'Bu yorumu zaten bildirdiniz; inceleme bekliyor.');
    throw error;
  }
  await this.notifySafely(() => this.mail.sendReviewReportNewForSupport(report.id), reviewId);
  return report;
}
// isOpenReportConflict: P2002 OR (PrismaClientUnknownRequestError && message includes 'ProviderReviewReport_one_open_per_review')

async moderate(reviewId: string, dto: ModerateProviderReviewDto, adminUserId: string) {
  const now = new Date();
  const outcome = await runSerializable(this.prisma, async (tx) => {
    const review = await tx.providerReview.findUnique({ where: { id: reviewId }, select: { id: true, comment: true, commentRemovedAt: true, removedAt: true } });
    if (!review) throw new NotFoundException('Review not found');
    const where = moderationPredicate(reviewId, dto.action);    // REMOVE_COMMENT: {comment:{not:null}, commentRemovedAt:null, removedAt:null}; REMOVE_REVIEW: {removedAt:null}; RESTORE: {OR:[{removedAt:{not:null}},{commentRemovedAt:{not:null}}]}
    const data = dto.action === 'REMOVE_COMMENT' ? { commentRemovedAt: now } : dto.action === 'REMOVE_REVIEW' ? { removedAt: now } : { removedAt: null, commentRemovedAt: null };
    const updated = await tx.providerReview.updateMany({ where: { id: reviewId, ...where }, data });
    if (updated.count !== 1) throw conflict(REVIEW_MODERATION_NOOP_CODE, 'Bu işlem değerlendirmenin mevcut durumunda uygulanamaz.');
    await tx.providerReviewModeration.create({ data: { reviewId, action: dto.action, reason: dto.action === 'RESTORE' ? null : dto.reason!, note: dto.note?.trim() || null, performedById: adminUserId } });
    if (dto.action !== 'RESTORE') {
      await tx.providerReviewReport.updateMany({ where: { reviewId, resolvedAt: null }, data: { resolvedAt: now, resolvedByUserId: adminUserId, resolution: dto.action === 'REMOVE_COMMENT' ? 'COMMENT_REMOVED' : 'REVIEW_REMOVED', resolutionNote: dto.note?.trim() || null } });
    }
    return { removed: dto.action !== 'RESTORE' };
  }, { label: 'providerReviews.moderate' });
  if (outcome.removed) await this.notifySafely(() => this.mail.sendReviewRemoved(reviewId, now), reviewId);
  return this.getForAdmin(reviewId);
}
```
`listQueue`: `request-reports.service.ts:98-170` kalıbı ama rapor başına satır
(`findMany where inState orderBy createdAt asc, id asc take+1 cursor`); satır: `{ report: { id, reason, note, createdAt, resolvedAt, resolution }, review: { id, rating, commentExcerpt(160), commentRemoved, removed, createdAt }, provider: { id, businessName }, request: { id, requestNumber, categoryName }, lastDecision }`.
`getForAdmin`: review + request (no, kategori, il/ilçe, `customerName` — admin), provider, tüm
raporlar, moderasyon günlüğü (`performedBy.name`). `dismissReport`: açık rapor yoksa 409; `updateMany` → `DISMISSED`.

Controller'lar: `@Controller('provider-reviews') @UseGuards(AuthGuard, RolesGuard) @Roles(UserRole.SUPER_ADMIN)`
(`GET reports`, `GET :reviewId`, `POST :reviewId/moderate`, `POST :reviewId/reports/dismiss`);
panel controller'a `POST :reviewId/reports`. Modül `providers`'a servis; `exports`.

- [ ] **Step 5: PASS; commit**

```bash
git commit -am "feat(reviews): provider reports and operator moderation with an append-only log

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

**Risk:** `updateMany` + `findUnique` sırası: kilit yok ama predikat `where`'de tekrarlandığı için iki admin yarışında biri 409 alır (A8).

---

### Task 10: Projeksiyon entegrasyonları — teklif kartı, vitrin feed/kart, dashboard, müşteri listesi

**Files:**
- Modify: `apps/api/src/modules/offers/offers.service.ts:312-353` (`listRequestOffers`), `offers.module.ts` (import `ProviderReviewsModule`)
- Modify: `apps/api/src/modules/showcase/showcase-feed.service.ts:91-174` (`list`, `getPublicCard`), `showcase.module.ts`
- Modify: `apps/api/src/modules/providers/providers.service.ts:743-776` (`getProviderDashboardForUser`), `providers.module.ts`
- Modify: `apps/api/src/modules/service-requests/service-requests.service.ts:668-746` (`review` include)
- Test: `apps/api/test/provider-review-projections.spec.ts`; `credits-integrity.spec.ts` (+1 test)

**Interfaces:**
- Consumes: `ProviderReviewsService.publicSummariesForProviders`, `summaryForProvider`.
- Produces: `RequestOfferPreview.provider = { id, businessName, city, district, reviewSummary: PublicReviewSummary }`; feed card `provider.reviewSummary`; dashboard `reviewSummary: ReviewSummary`; `CustomerServiceRequest.review: { id, rating, removedAt } | null`.

- [ ] **Step 1: Testler**

```ts
it('customer offer previews carry the provider id and a public summary (null under three)', ...)
it('the vitrin feed and the public card carry provider.reviewSummary, and never a review body', ...)   // createLiveShowcasePlacement harness
it('the provider dashboard carries the exact summary even with one review', ...)
it('the customer list carries review { rating, removedAt } per request', ...)
it('feed and offer projections omit reviewSummary changes to price, area and ordering', ...)   // snapshot of card keys minus reviewSummary equals pre-change keys
```
`credits-integrity.spec.ts`: "a review, its removal and its restore move no credit and no entitlement" — ledger `count` ve `sum(amount)` sabit.

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Uygulama**

Üç servise `@Inject(ProviderReviewsService) private readonly reviews: ProviderReviewsService` eklenir (modüller `ProviderReviewsModule`'ü import eder).

`listRequestOffers`: provider select'e `id: true`; sonra
`const summaries = await this.reviews.publicSummariesForProviders([...new Set(offers.map(o => o.providerId))]);`
ve map'te `provider: { ...offer.provider, reviewSummary: summaries.get(offer.providerId) ?? null }`.
Anahtar kapalıysa `publicSummariesForProviders` **her id için `null`** döner (servis içinde
`readProviderReviewsEnabled` kontrolü — tek yerde).

`ShowcaseFeedService.list`: `cards: page.map(toFeedCard)` → `const cards = page.map(toFeedCard); const summaries = await this.reviews.publicSummariesForProviders(cards.map(c => c.provider.id)); return { ..., cards: cards.map(c => ({ ...c, provider: { ...c.provider, reviewSummary: summaries.get(c.provider.id) ?? null } })) }`.
`getPublicCard` aynı, tek id. `ShowcaseModule imports` → `ProviderReviewsModule`.

Dashboard: `Promise.all`'a `this.reviews.summaryForProvider(provider.id)`; yanıta `reviewSummary`.
Müşteri listesi include: `review: { select: { id: true, rating: true, removedAt: true } }`.

- [ ] **Step 4: PASS; `showcase-feed.spec`, `offer-detail-hydration` ilgili API testleri PASS; commit**

```bash
git commit -am "feat(reviews): public summaries on offer previews, vitrin cards, dashboard and the customer list

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

**Risk:** Modül döngüsü — `ProviderReviewsModule` yalnız `PrismaModule`/`AuthModule` import eder; `Offers/Showcase/Providers` onu import eder → döngü yok. `isPubliclyVisibleProvider` saf import olduğu için `ProvidersModule` bağımlılığı doğmaz.

---

### Task 11: Web — müşteri değerlendirme sayfası, tamamlama yönlendirmesi, Taleplerim CTA

**Files:**
- Modify: `apps/web/lib/api.ts` (tipler: `ReviewSummary`, `PublicReviewSummary`, `PublicReviewItem`, `ProviderReviewItem`, `CustomerReviewState`, `CustomerServiceRequest.review/completedAt`, `RequestOfferPreview.provider.id/reviewSummary`)
- Create: `apps/web/lib/reviews.ts`, `apps/web/app/review-stars.tsx`
- Create: `apps/web/app/requests/[id]/degerlendir/{page.tsx,review-form.tsx,actions.ts}`
- Modify: `apps/web/app/requests/[id]/offers/actions.ts:12-21`, `apps/web/app/requests/[id]/offers/page.tsx:311-313`, `apps/web/app/requests/my/requests-board.tsx:143-199`
- Test: `apps/web/test/reviews.test.ts` (vitest; `formatRating`, `ratingLabel`)

**Interfaces:**
- Produces: `PublicReviewsPage = { summary: PublicReviewSummary; items: PublicReviewItem[]; nextCursor: string | null }` (tip, `lib/api.ts`); `formatRating(average: number): string` (`4.66 → "4,7"`, tr-TR, 1 ondalık), `ratingLabel(count: number): string` (`"12 değerlendirme"`), `<ReviewStars value={1..5} size? readOnly>` (aria-label "5 üzerinden 4 yıldız"), `<RatingSummaryLine summary={PublicReviewSummary} />` (null → `Henüz yeterli değerlendirme yok`).

- [ ] **Step 1: Vitest**

```ts
import { formatRating, ratingLabel } from '../lib/reviews';
it('formats to one decimal with a Turkish comma', () => { expect(formatRating(4.66)).toBe('4,7'); expect(formatRating(5)).toBe('5,0'); });
it('labels the count', () => { expect(ratingLabel(1)).toBe('1 değerlendirme'); expect(ratingLabel(12)).toBe('12 değerlendirme'); });
```
Run: `pnpm --filter @taktic/web test` → FAIL; implement:
```ts
export function formatRating(average: number): string { return new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(average); }
export function ratingLabel(count: number): string { return `${count} değerlendirme`; }
export const NOT_ENOUGH_REVIEWS_TEXT = 'Henüz yeterli değerlendirme yok';
```

- [ ] **Step 2: `review-stars.tsx`** (server-safe, saf SVG/Unicode `★`; `data-testid="review-stars"` + `data-value`):

```tsx
export function ReviewStars({ value, label }: { value: number; label?: string }) {
  return (
    <span className="review-stars" role="img" aria-label={label ?? `5 üzerinden ${value} yıldız`} data-testid="review-stars" data-value={value}>
      {[1, 2, 3, 4, 5].map((n) => <span key={n} aria-hidden="true" className={n <= value ? 'review-star is-on' : 'review-star'}>★</span>)}
    </span>
  );
}
export function RatingSummaryLine({ summary, testId = 'review-summary' }: { summary: PublicReviewSummary; testId?: string }) {
  if (!summary) return <p className="review-summary-empty" data-testid={testId}>{NOT_ENOUGH_REVIEWS_TEXT}</p>;
  return <p className="review-summary" data-testid={testId}><span aria-hidden="true">★</span> {formatRating(summary.average)} · {ratingLabel(summary.count)}</p>;
}
```

- [ ] **Step 3: Değerlendirme sayfası**

`actions.ts`:
```ts
'use server';
export async function submitReviewAction(formData: FormData) {
  const requestId = readFormString(formData, 'requestId');
  const rating = Number(readFormString(formData, 'rating'));
  const comment = readFormString(formData, 'comment');
  let status = 'ok';
  try {
    await apiFetch<CustomerReviewState>(`/service-requests/${requestId}/review`, { method: 'POST', body: JSON.stringify({ rating, comment: comment || null }) });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    status = error.status === 400 && error.code === 'CONTACT_DETAILS_IN_TEXT' ? 'contact' : error.status === 409 ? (error.code === 'REVIEW_WINDOW_CLOSED' ? 'closed' : 'exists') : 'failed';
  }
  revalidatePath('/requests/my'); revalidatePath(`/requests/${requestId}/offers`); revalidatePath(`/requests/${requestId}/degerlendir`);
  redirect(`/requests/${requestId}/degerlendir?review=${status}`);
}
```
(`ApiError.code` yoksa `lib/api.ts` `ApiError`'a gövdedeki `code`'u ekle — mevcut `callVerificationApi` yalnız status okuyor; `code` ekleme ek/geriye uyumlu.)

`page.tsx`: `getCurrentUser` CUSTOMER değilse `redirect('/login?redirectTo=...')`;
`apiFetch<CustomerReviewState>` (403/404 → `notFound()`); `eligibility`'ye göre: `ok` → form;
`already-reviewed` → `ReviewStars` + yorum + "Değerlendirmeniz için teşekkürler"; `removed` →
"Değerlendirmeniz yönetim tarafından kaldırıldı — gerekçe: <etiket>"; `not-completed` →
"Değerlendirme, iş tamamlandı olarak işaretlendikten sonra yapılabilir" + teklifler linki;
`window-closed` → "Değerlendirme süresi doldu"; `disabled` → `notFound()`. `?review=` bayrakları
`.cdash-notice-error`/success ile (E2E: `getByRole('alert')` kullanma — route announcer tuzağı).

`review-form.tsx` (`'use client'`): `fieldset`/`legend "Puanınız"`, 5 `input[type=radio][name=rating]`
(`data-testid="rating-<n>"`, label `★`), `textarea[name=comment][data-testid="review-comment"]` `maxLength={limits.providerReviewCommentMaxLength}`
+ sayaç + `detectContactDetails` canlı uyarısı (`@taktic/shared` — web import edebilir; `description-field.tsx`
deseni), submit `data-testid="review-submit"` (`useFormStatus`). Uyarı metni: "Adınız, telefonunuz
ve e-postanız paylaşılmaz; yorumda iletişim bilgisi bulunamaz."

- [ ] **Step 4: Yönlendirme ve CTA**

`offers/actions.ts` `completeRequestAction`: revalidate'lerden sonra
`redirect(\`/requests/${requestId}/degerlendir\`)` (try dışında). `offers/page.tsx:311-313`
`COMPLETED` metni: "Bu talep tamamlandı olarak işaretlendi." + `<Link href=/requests/${id}/degerlendir>Hizmet vereni değerlendir</Link>`
(review varsa "Değerlendirmenizi görün"). `requests-board.tsx` `RequestRow`: `request.status === 'COMPLETED'`
ise ikinci CTA: `!request.review` → "Değerlendir" (`data-testid="review-cta"`); `review && !review.removedAt`
→ `★ ${rating} · Değerlendirmeniz`; `review?.removedAt` → "Değerlendirme kaldırıldı".

- [ ] **Step 5: `pnpm --filter @taktic/web typecheck && pnpm --filter @taktic/web test`; commit**

```bash
git commit -am "feat(web): customer review page, completion redirect and Taleplerim CTA

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

**Risk:** `redirect` server action içinde `try/catch` altında yakalanırsa NEXT_REDIRECT yutulur — mevcut `sendPhoneCodeAction` deseninde olduğu gibi try dışında çağır.

---

### Task 12: Web — sağlayıcı paneli (liste, özet, rapor diyaloğu, dashboard kartı)

**Files:**
- Create: `apps/web/app/providers/[id]/degerlendirmeler/{page.tsx,report-dialog.tsx,actions.ts}`
- Modify: `apps/web/app/providers/provider-shell.tsx:116-161` (menü `reviews`), `apps/web/app/providers/me/page.tsx` (kart), `apps/web/app/providers/[id]/page.tsx:41-47` (rail)
- Modify: `apps/web/lib/api.ts` (`ProviderDashboard.reviewSummary`)

- [ ] **Step 1: Menü** — `{ key: 'reviews', label: 'Değerlendirmeler', Icon: IconStar (yoksa `landing-icons`'a 16px yıldız ekle), href: \`/providers/${providerId}/degerlendirmeler\` }`, "Tekliflerim"in altına. `ProviderShellActive` tipine `'reviews'`.

- [ ] **Step 2: Sayfa** — `ProviderShell active="reviews"`; `apiFetch(/providers/${id}/reviews)`;
özet kartı: `summary.count === 0` → "Henüz değerlendirme yok" (sayı yazma); aksi halde
`formatRating(average)` + `ratingLabel(count)` + dağılım çubukları (`databar` sınıfı) — **panelde 3-eşiği
yok** (kendi verisi; açıklama satırı: "Herkese açık profilinizde ortalama, en az 3 değerlendirme
olduğunda görünür."). Liste `datarow` (`data-testid="review-row"`): `ReviewStars`, yorum
(`commentRemoved` → "Yorum yönetim tarafından kaldırıldı"), tarih, kategori, talep no; `myReport`
→ "Bildirildi · inceleniyor" / karar etiketi; yoksa "Yorumu bildir" (`data-testid="review-report-button"`).
Cursor "Daha fazla" linki `?cursor=`.

- [ ] **Step 3: Rapor diyaloğu** — `providers/[id]/requests/[requestId]/report-dialog.tsx` kopyası:
`select[data-testid="review-report-reason"]` (`REVIEW_REASON_ADMIN_LABELS` metinleri web'de
`lib/reviews.ts`'e kopyalanır), `textarea[data-testid="review-report-note"]`, submit
`review-report-submit`; action `reportReviewAction` → `POST /providers/${id}/reviews/${reviewId}/reports`
→ `redirect(/providers/${id}/degerlendirmeler?reported=1)`; 409/429 → `?reportError=<code>`;
sayfada `data-testid="review-report-received"` bildirimi.

- [ ] **Step 4: Dashboard ve profil rail'i** — `providers/me/page.tsx` metrik kartı
"Değerlendirme": `reviewSummary.count === 0` → "Henüz değerlendirme yok"; aksi `★ 4,7 · 12 değerlendirme`
(`data-testid="dashboard-review-summary"`). `providers/[id]/page.tsx:41-47` yorumunu güncelle
("a rating is now recorded — see reviewSummary") ve aynı kartı rail'e koy.

- [ ] **Step 5: typecheck; commit**

```bash
git commit -am "feat(web): provider review list, report dialog and dashboard summary

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

**Risk:** `provider-shell.tsx` menü sayacı (`counts`) yeni öğe için sayı taşımaz; `count` verilmezse rozet render edilmez — mevcut `showcase` öğesiyle aynı.

---

### Task 13: Web — public profil `/isletme/[id]`, teklif kartı bağlantısı, vitrin satırı

**Files:**
- Create: `apps/web/app/isletme/[id]/page.tsx`
- Modify: `apps/web/app/requests/[id]/offers/offers-view.tsx:102-118, 228-236`, `apps/web/app/showcase-card-face.tsx:24-115`, `apps/web/app/vitrin/[cardId]/page.tsx:141`, `apps/web/lib/api.ts` (`ShowcaseFeedCard.provider.reviewSummary`)

- [ ] **Step 1: Public profil**

```tsx
export default async function PublicProviderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [provider, reviews] = await Promise.all([
    fetchOrNotFound(() => apiFetch<ProviderProfile>(`/providers/${id}`)),
    apiFetch<PublicReviewsPage>(`/providers/${id}/reviews/public`).catch(() => null),   // 404 when the switch is off → section hidden
  ]);
  // An anonymous visitor gets the public projection or a 404 from the API itself; an owner or
  // an admin gets their full record, and this page reads only the public fields either way.
  // SiteHeader + landing layout: name, city/district, description, categories, area labels (serviceAreaLabel from @taktic/shared)
  // Reviews section (only when `reviews` !== null): <RatingSummaryLine summary={reviews.summary} testId="public-review-summary" />,
  // distribution only when summary !== null, then items: <ReviewStars/> + <p>{item.comment}</p> + `${monthLabel(item.month)} · ${item.categoryName}`;
  // "Daha fazla" → ?cursor=. Comment is a text child — never innerHTML.
}
```
`generateMetadata`: `{ title: \`${provider.businessName} — TakTick\`, robots: { index: true } }`.
`monthLabel('2026-09') → 'Eylül 2026'` (`lib/reviews.ts`, `Intl.DateTimeFormat('tr-TR', { month: 'long', year: 'numeric' })`).
Not: oturumlu sahip/admin `GET /providers/:id`'den tam kaydı alır (`visibility: 'owner'|'admin'`);
sayfa yalnız `businessName/city/district/description/serviceCategories/serviceAreas` alanlarını
render eder, başka alan okumaz.

- [ ] **Step 2: Teklif kartı** — `offers-view.tsx:114` başlığı `<Link href={\`/isletme/${offer.provider.id}\`}>{businessName}</Link>`;
altına `<RatingSummaryLine summary={offer.provider.reviewSummary} testId="offer-review-summary" />`
(null → "Henüz yeterli değerlendirme yok" — karar: teklif kartında metin gösterilir, karşılaştırma
tablosuna satır eklenmez). `:200-204` yorumunu güncelle ("rating: the provider's public summary,
read from the provider, not the offer").

- [ ] **Step 3: Vitrin** — `ShowcaseFaceData.reviewSummary?: PublicReviewSummary`; `faceFromFeedCard`
`reviewSummary: card.provider.reviewSummary ?? null`; yüzde `providerName` satırının hemen altına,
yalnız `reviewSummary` varsa:
`<p className="vitrin-face-rating" data-testid="showcase-card-rating"><span aria-hidden="true">★</span> {formatRating(a)} · {ratingLabel(c)}</p>`
(tek satır, `font-size: 12px`, fiyat ve bölge satırlarının stilini değiştirme). `faceFromVersion`
(sağlayıcı ekranları) `reviewSummary` vermez. `vitrin/[cardId]/page.tsx:141` işletme adı →
`/isletme/<id>` linki + altında `RatingSummaryLine` (burada null metni gösterilir).

- [ ] **Step 4: typecheck; `pnpm e2e showcase` (mevcut vitrin testleri kırılmadı); commit**

```bash
git commit -am "feat(web): public provider profile, offer card link and compact vitrin rating line

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

**Risk:** `showcase-cards.spec`/`showcase-home-shelf.spec` kart yüzü metnini snapshot'lıyorsa yeni satır yalnız `reviewSummary` doluyken çıkar (fixture'larda değerlendirme yok → değişmez).

---

### Task 14: Admin — kuyruk, detay/moderasyon, sağlayıcı ve talep bölümleri, bildirim etiketleri

**Files:**
- Modify: `apps/admin/lib/nav.ts:19-21`, `apps/admin/lib/api.ts` (tipler + `reviewReasonLabel`, `reviewResolutionLabel`, `moderationActionLabel`, şablon etiketleri)
- Create: `apps/admin/app/provider-reviews/reports/page.tsx`, `apps/admin/app/provider-reviews/[reviewId]/{page.tsx,moderation-form.tsx,actions.ts}`
- Modify: `apps/admin/app/providers/[id]/page.tsx:572`, `apps/admin/app/requests/[id]/page.tsx:594`

- [ ] **Step 1: Nav** — Operasyon grubunda "Talep bildirimleri"nin altına `{ href: '/provider-reviews/reports', label: 'Değerlendirme bildirimleri' }`.

- [ ] **Step 2: Kuyruk** — `requests/reports/page.tsx` kopyası (`state` sekmeleri, cursor, `EmptyState`);
satır: işletme, `★ n`, yorum özeti, gerekçe, tarih, son karar; satır linki `/provider-reviews/<reviewId>`;
`data-testid="review-report-row"`.

- [ ] **Step 3: Detay** — `SectionCard`'lar: Değerlendirme (yıldız, yorum — kaldırılmışsa etiketli ama
metin görünür, tarih, durum), Talep (no, kategori, müşteri adı, link `/requests/<id>`), Hizmet veren
(link `/providers/<id>`), Bildirimler tablosu, Moderasyon günlüğü. `moderation-form.tsx`
(`moderation-dialog.tsx` kalıbı): üç düğme "Yorumu kaldır" / "Değerlendirmeyi kaldır" / "Geri getir"
(mevcut duruma göre görünür; `data-testid="moderate-REMOVE_COMMENT"`, `moderate-REMOVE_REVIEW`,
`moderate-RESTORE` — tıklanınca gerekçe/not alanlarını açar) + gerekçe `select[data-testid="moderation-reason"]`
+ not + gönder `data-testid="moderation-submit"`; durum rozeti `data-testid="review-state"`
("Yayında" / "Yorum kaldırıldı" / "Kaldırıldı"); "Uygun bulundu" ayrı form (`data-testid="review-dismiss"`). `actions.ts`: `moderateReviewAction`, `dismissReviewReportAction`
→ `revalidatePath` (`/provider-reviews/reports`, detay, `/providers/<id>`) → `?ok=` / `?error=`.

- [ ] **Step 4: Sağlayıcı/talep detayı** — `providers/[id]/page.tsx` "Son teklifler" yanına
"Değerlendirmeler" `SectionCard` (`GET /providers/:id/reviews?limit=10`, admin `ProviderAccessGuard`'dan
geçer): özet + satırlar + her satırda kaldır/geri getir (aynı action). `requests/[id]/page.tsx`
"Bildirimler" yanına "Değerlendirme" kartı (`GET /service-requests/:id/review` admin geçer; yoksa
"Değerlendirme yok").

- [ ] **Step 5: Bildirim geçmişi** — `lib/api.ts` şablon etiket haritasına 4 giriş
("Değerlendirme daveti", "Yeni değerlendirme", "Değerlendirme bildirimi (destek)", "Değerlendirme kaldırıldı").

- [ ] **Step 6: typecheck; commit**

```bash
git commit -am "feat(admin): review report queue, moderation detail and provider/request sections

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

**Risk:** `/provider-reviews/reports` ile `/provider-reviews/[reviewId]` aynı segmentte; Next literal segment dinamik olandan önce eşleşir (`/requests/reports` ile `/requests/[id]` deseniyle aynı), `nav.ts isNavItemActive` en uzun eşleşmeyi seçer.

---

### Task 15: E2E — ortak akış (marketplace + vitrin direct lead), Chromium + WebKit

**Files:**
- Modify: `e2e/src/journeys.ts` (+ `completeRequest`, `submitReview`, `reportReview`, `moderateReview`, `enableProviderReviews`)
- Modify: `e2e/src/fixtures.ts` (+ `setProviderReviewsEnabled`, `reviewCount(providerId)`)
- Create: `e2e/tests/provider-review-flow.spec.ts`
- Modify: `e2e/playwright.config.ts` (WebKit `testMatch` listesine `provider-review-flow`)

- [ ] **Step 1: Journeys**

```ts
export async function completeRequest(customer: Actor, requestId: string): Promise<void> {
  await customer.gotoWeb(`/requests/${requestId}/offers`);
  await customer.page.getByRole('button', { name: 'Hizmet tamamlandı' }).click();
  // The action redirects to the review page; wait for the form, not the URL.
  await expect(customer.page.getByTestId('review-submit')).toBeVisible();
  await assertNoErrorScreen(customer.page);
}
export async function submitReview(customer: Actor, requestId: string, rating: 1 | 2 | 3 | 4 | 5, comment?: string): Promise<void> {
  await customer.gotoWeb(`/requests/${requestId}/degerlendir`);
  await customer.page.getByTestId(`rating-${rating}`).check();
  if (comment) await customer.page.getByTestId('review-comment').fill(comment);
  await customer.page.getByTestId('review-submit').click();
  await expect(customer.page.getByTestId('review-stars')).toHaveAttribute('data-value', String(rating));
  await assertNoErrorScreen(customer.page);
}
export async function reportReview(provider: Actor, providerId: string, reason: string): Promise<void> {
  await provider.gotoWeb(`/providers/${providerId}/degerlendirmeler`);
  await provider.page.getByTestId('review-report-button').first().click();
  await provider.page.getByTestId('review-report-reason').selectOption(reason);
  await provider.page.getByTestId('review-report-submit').click();
  await expect(provider.page.getByTestId('review-report-received')).toHaveCount(1);
}
export async function moderateReview(admin: Actor, reviewId: string, action: 'REMOVE_COMMENT' | 'REMOVE_REVIEW' | 'RESTORE'): Promise<void> {
  await admin.gotoAdmin(`/provider-reviews/${reviewId}`);
  await admin.page.getByTestId(`moderate-${action}`).click();
  if (action !== 'RESTORE') await admin.page.getByTestId('moderation-reason').selectOption('OTHER');
  await admin.page.getByTestId('moderation-submit').click();
  await expect(admin.page.getByTestId('review-state')).toContainText(action === 'RESTORE' ? 'Yayında' : 'Kaldırıldı');
}
```

- [ ] **Step 2: Spec**

```ts
test.describe('provider review flow', () => {
  test('marketplace: complete → rate → provider sees it → public shows nothing under three → admin removes and restores', async ({ browser }) => {
    await setProviderReviewsEnabled(true);
    // marketplace-journey fixtures: category, customer, provider with credits, request, offer, acceptOffer
    await completeRequest(customer, requestId);
    await submitReview(customer, requestId, 5, 'Zamanında geldi, temiz iş.');
    await customer.gotoWeb('/requests/my');
    await expect(customer.page.getByTestId('request-card').filter({ hasText: 'Değerlendirmeniz' })).toHaveCount(1);
    await provider.gotoWeb(`/providers/${providerId}/degerlendirmeler`);
    await expect(provider.page.getByTestId('review-row')).toHaveCount(1);
    await expect(provider.page.locator('body')).not.toContainText(customerName);
    await visitor.gotoWeb(`/isletme/${providerId}`);
    await expect(visitor.page.getByTestId('public-review-summary')).toHaveText('Henüz yeterli değerlendirme yok');
    // two more completed jobs via prisma fixtures → reload → "5,0 · 3 değerlendirme" and the comment text, no customer name
    await reportReview(provider, providerId, 'OFFENSIVE');
    await expect(visitor.page.getByText('Zamanında geldi')).toBeVisible();      // no auto-hide
    await moderateReview(admin, reviewId, 'REMOVE_COMMENT');                    // star stays: "5,0 · 3 değerlendirme", comment gone
    await moderateReview(admin, reviewId, 'REMOVE_REVIEW');                     // "Henüz yeterli değerlendirme yok" again (2 left)
    await moderateReview(admin, reviewId, 'RESTORE');
    await admin.gotoAdmin('/notifications');                                     // rows for review-invitation, review-received, review-report-new-for-support, review-removed
  });

  test('vitrin direct lead reaches the same review path', async ({ browser }) => {
    // showcase-package-first-flow fixtures: live placement → lead form → provider offers → customer accepts → complete → submitReview
    // assert one ProviderReview row with providerId = card owner, and the card page shows the summary line once three exist
  });
});
```
Ekran görüntüleri `docs/superpowers/plans/2026-09-16-provider-reviews-screens/` (WebKit `fullPage`
için `height * devicePixelRatio > 32000` koruması — mevcut `capture()` yardımcı).

- [ ] **Step 3: Çalıştır**

Run: `pnpm e2e provider-review-flow` (Chromium) ve `pnpm e2e:webkit provider-review-flow`.
Expected: PASS. Ardından `pnpm e2e` tam suite bir kez.

- [ ] **Step 4: Commit**

```bash
git add e2e docs/superpowers/plans/2026-09-16-provider-reviews-screens
git commit -m "test(e2e): provider review flow for marketplace and vitrin direct lead

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

**Risk:** Server action redirect'i `toHaveURL` ile beklemek yarış üretir — durum değişikliğini bekle (bellek notu #2).

---

### Task 16: Teslim raporu, teslim öncesi tam doğrulama

- [ ] `pnpm typecheck && pnpm lint && pnpm --filter @taktic/api test && pnpm --filter @taktic/web test && pnpm --filter @taktic/admin test`
- [ ] `pnpm e2e` (tam) + `pnpm e2e:webkit`
- [ ] `docs/superpowers/plans/2026-09-16-provider-reviews-teslim-raporu.md` (repo kalıbı: kapsam,
  migration, test sonuçları, ekran görüntüleri, açık notlar) — commit.
- [ ] PR-A ve PR-B açıklamaları (`🤖 Generated with [Claude Code](https://claude.com/claude-code)` ile biter).

**Risk:** PR-A tek başına yayınlanırsa anahtar kapalı kaldığı sürece görünür etki yoktur; PR-B öncesi anahtar **açılmamalı** (davet maili `/degerlendir` sayfasına link verir).

---

# BÖLÜM C — Yerel kabul testi (staging öncesi)

Ortam: ana checkout + Docker stack (bellek: `taktic-api` container'ı ana checkout'u mount eder;
`.env` yalnız ana checkout'ta). Sıra, ship sonrası senkron kuralıyla aynı.

1. **Yedek + migration.** API stop → `pg_dump` (`~/Backups/taktic-pre-provider-reviews-<ts>.dump` + sha256)
   → branch checkout → `docker compose -p <proje> -f docker-compose.yml run --rm --no-deps api sh -lc "corepack enable; pnpm exec prisma migrate deploy"`
   (DB 60 → 61) → `docker exec -i taktic-postgres psql -U taktic_user -d taktic -c '\d "ProviderReview"'`
   (4 index + 2 CHECK görünmeli) → api→web→admin `force-recreate`.
2. **Parmak izi.** 13 iş tablosunun `count(*)` ve `max(updatedAt)` değerleri migration öncesi/sonrası
   aynı (yalnız DDL). `OperationsSettings.providerReviewsEnabled = false` (fail-closed).
3. **Anahtar kapalı davranışı.** Admin `/operations-settings` kartı "Kapalı"; müşteri `/requests/<id>/degerlendir`
   404; `/isletme/<approvedProviderId>` profil açılır, değerlendirme bölümü yok; teklif kartında
   summary satırı yok.
4. **Anahtarı aç** (admin, `admin@taktic.local`); `OperationsSettingsChange` satırı 1.
5. **Marketplace senaryosu (iki tarayıcı profili).** Yeni sağlayıcı (register → admin APPROVED →
   kredi grant) + yeni müşteri talebi (IP throttle 5/10 dk'ya dikkat; SMS kodu `docker logs taktic-api`
   console adapter bloğunda) → teklif → kabul → "Hizmet tamamlandı" → **doğrudan değerlendirme
   sayfası** → 5★ + yorum (önce `0532 111 22 33` içeren yorumla 400 uyarısı, sonra temiz yorum) →
   Taleplerim "★ 5 · Değerlendirmeniz".
6. **DB kanıtı.** `SELECT "requestId","providerId","offerId","rating" FROM "ProviderReview";`
   `providerId` = kabul edilen teklifin sahibi; `SELECT template,"dedupeKey",status,"errorCode" FROM "NotificationLog" WHERE template LIKE 'review-%' ORDER BY "createdAt";`
   → `review-invitation:<requestId>` ve `review-received:<reviewId>` birer satır (yerelde loopback
   koruması nedeniyle `FAILED/EMAIL_PUBLIC_URL_INVALID` olabilir — dedupe kanıtı `dedupeKey`'dir);
   `/notifications` ekranında iki satır + "Yeniden gönder" ikinci satır yaratmaz.
7. **İdempotency.** Aynı talebe ikinci `POST /service-requests/<id>/review` (curl, oturum çerezi) → 409
   `REVIEW_ALREADY_EXISTS`; ikinci `/complete` → 409; `NotificationLog` sayıları değişmez.
8. **3-eşiği.** `/isletme/<providerId>` → "Henüz yeterli değerlendirme yok"; psql ile 2 ek COMPLETED
   iş + değerlendirme satırı ekle (ya da iki müşteri daha) → sayfa "5,0 · 3 değerlendirme" + yorum;
   `/vitrin` feed'inde bu sağlayıcının kartında (varsa) kompakt satır; teklif kartında satır.
9. **Rapor + moderasyon.** Sağlayıcı paneli → "Yorumu bildir" → public'te yorum **hâlâ görünür** →
   admin kuyruğu satır → "Yorumu kaldır" → public'te yorum yok, ortalama aynı → müşteri Taleplerim'de
   "★ 5" kalır; `NotificationLog` `review-removed:<reviewId>:<iso>` → "Değerlendirmeyi kaldır" →
   public eşik altına düşer → "Geri getir" → geri gelir; `ProviderReviewModeration` 3 satır,
   `ProviderReviewReport` `COMMENT_REMOVED`.
10. **Kredi/vitrin değişmezliği.** Senaryo öncesi/sonrası `SELECT count(*), sum(amount) FROM "ProviderCreditTransaction" WHERE "providerId"=…;`
    ve `ShowcaseEntitlement`/`ShowcasePlacement` satırları birebir aynı (yalnız teklif harcaması).
11. **Vitrin direct lead.** Aktif kartı olan sağlayıcıya `/vitrin/<cardId>` formundan lead → teklif →
    kabul → tamamla → değerlendir; `ProviderReview.providerId` = kart sahibi; `ShowcaseLead` satırı
    değişmedi.
12. **90 gün.** psql ile `completedAt = now() - interval '91 days'` → sayfa "Değerlendirme süresi
    doldu", `POST` 409 `REVIEW_WINDOW_CLOSED`; `/notifications`'ta o talebin davetini "Yeniden gönder"
    → `FAILED/SOURCE_UNAVAILABLE` (rebuild null).
13. **Anahtarı kapat** → public bölüm/satırlar kaybolur, satırlar DB'de durur; tekrar aç → geri gelir.
14. **Geri dönüş provası (isteğe bağlı, aday DB'de).** `pg_restore` dump → şema 60'a döner;
    yeni tablolar yok — kayıp yalnız değerlendirme verisi.
15. Sonuçları teslim raporuna işle; staging'e ancak 1–13 temizse geç.
