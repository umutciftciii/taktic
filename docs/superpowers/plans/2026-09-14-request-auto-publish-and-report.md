# Pazar taleplerinde anında yayın + "Talebi bildir" — uygulama planı

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normal pazar talebi, operasyon anahtarı açıkken oluşturma transaction'ında `APPROVED` doğar; hizmet veren talebi bildirebilir; admin bildirimi "uygun bulundu / talebi kaldır / geri aç" ile çözer; kaldırma aktif teklifleri `CANCELLED` yapıp harcanan kredileri atomik ve idempotent biçimde iade eder; yayın bildirimleri NotificationLog niyeti olarak kalıcılaşır.

**Architecture:** Spec: `docs/superpowers/specs/2026-09-14-request-auto-publish-and-report-design.md` (rev. 2, onaylı). Yeni talep statüsü yok (`APPROVED`/`REJECTED` mevcut), yeni teklif statüsü yok (`CANCELLED` mevcut, ilk yazarı bu iş). Yeni tablo `ServiceRequestReport`; `OperationsSettings.marketplaceAutoPublishEnabled`; `Offer.cancelledAt`. Kaldırma cascade'i `ServiceRequestsService.rejectRequestInTransaction`'da tek yerde; iade mevcut `refundOfferCreditInTransaction(..., { enforceUnviewedPolicy: false })` ile. Yayın bildirimleri `RequestPublishOutbox` (mevcut `notification-intents.ts` deseni).

**Tech Stack:** NestJS 10 + Prisma (PostgreSQL), Next.js (apps/web, apps/admin), vitest (`apps/api/test/*.spec.ts`, gerçek DB + supertest), Playwright (`e2e/tests`, Chromium + WebKit), pnpm monorepo.

## Global Constraints

- Worktree'de `.env` yok: API testlerinden önce `export DATABASE_URL=...` (memory: `project_worktree_env_for_tests`) ve `pnpm --filter @taktic/api db:generate` (kökten `pnpm db:generate`).
- API `@taktic/shared` TypeScript'ini import edemez; ortak değer JSON'dan okunur (`limits.json` deseni).
- Yeni env değişkeni **yok**. Scheduler cron'ları, Lemon/ödeme, Cloudflare, Resend kapsam dışı.
- Migration'da **DML yok**; mevcut `ServiceRequest`/`Offer`/ledger satırlarına dokunulmaz.
- Her talep serializable tx için `runSerializable(this.prisma, fn, { label })` kullanır.
- Kullanıcıya dönük metinler Türkçe; kod yorumları repo geleneğiyle İngilizce.
- E2E: `pnpm e2e <filtre>` (`--` yok); WebKit'te yeni metinler `data-testid` ile seçilir.
- Commit mesajı sonu: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. Ana dalda değil, mevcut worktree dalında çalışılır.
- Sabitler: rapor 20/24 s provider; talep 5/10 dk IP, 5/24 s telefon, 10 açık talep; not ≤ 500 code unit.

---

## Dosya haritası

| Dosya | Sorumluluk |
|---|---|
| `prisma/schema.prisma`, `prisma/migrations/<ts>_add_request_reports_and_auto_publish/migration.sql` | Enum'lar, `ServiceRequestReport`, `OperationsSettings.marketplaceAutoPublishEnabled`, `Offer.cancelledAt`, `ServiceRequest` telefon indeksi, CHECK + partial index |
| `apps/api/src/modules/operations-settings/marketplace-publish-settings.service.ts` (+ controller, dto) | Anahtarın fail-closed okunması ve denetimli yazımı |
| `apps/api/src/modules/notifications/request-publish-outbox.service.ts` | `request-published` / `request-available` niyetlerinin enqueue + teslimi |
| `apps/api/src/modules/service-requests/service-requests.service.ts` | `publishAtCreate`, `publishRequestInTransaction`, `rejectRequestInTransaction` (cascade + iade), `reopenAfterRemoval` |
| `apps/api/src/modules/offers/refund-policy.ts`, `offers.service.ts` | `REQUEST_REMOVED_REFUND_REASON`, etiketler |
| `apps/api/src/modules/request-reports/*` | Rapor modülü: provider uç, admin kuyruk/karar uçları, hız bütçesi |
| `apps/api/src/common/contact-detection.ts`, `packages/shared/contact-patterns.json`, `packages/shared/src/contact-detection.ts` | PII tespiti (tek kural, iki okuyucu) |
| `apps/api/src/modules/service-requests/service-request.throttler.ts` + `service-requests.constants.ts` | IP throttler ve telefon/kullanıcı sayımları |
| `apps/api/src/modules/notifications/templates/transactional-templates.ts`, `transactional-mail.service.ts` | `request-removed`, `request-report-new-for-support`, `request-received.nextStep` |
| `apps/web/app/providers/[id]/requests/[requestId]/report-dialog.tsx` (+ actions) | "Talebi bildir" |
| `apps/admin/app/requests/reports/page.tsx`, `apps/admin/app/requests/[id]/page.tsx`, `apps/admin/app/operations-settings/*` | Kuyruk, kararlar, anahtar |
| `e2e/tests/request-auto-publish.spec.ts`, `request-report-flow.spec.ts`, `request-contact-filter.spec.ts` | Uçtan uca |

---

### Task 1: Migration ve Prisma şeması

**Files:**
- Modify: `prisma/schema.prisma` (enum bloğu `ServiceRequestStatus` altı; `ServiceRequest` ilişkiler/indeksler `:862-910`; `Offer` `:1219-1340`; `OperationsSettings` `:452-500`; `ProviderProfile`, `User` ters ilişkiler)
- Create: `prisma/migrations/20260914120000_add_request_reports_and_auto_publish/migration.sql`
- Test: `apps/api/test/request-report-schema.spec.ts`

**Interfaces:**
- Produces: Prisma modelleri `ServiceRequestReport`, enum `ServiceRequestReportReason { SPAM, FAKE_OR_TEST, CONTAINS_CONTACT_INFO, WRONG_CATEGORY, INAPPROPRIATE_CONTENT, DUPLICATE, OTHER }`, enum `ServiceRequestReportResolution { DISMISSED, REQUEST_REMOVED }`, `OperationsSettings.marketplaceAutoPublishEnabled: boolean`, `Offer.cancelledAt: Date | null`.

- [ ] **Step 1: Failing test — şema alanları ve unique constraint**

```ts
// apps/api/test/request-report-schema.spec.ts
import { Prisma, ServiceRequestReportReason } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApprovedRequest,
  createCategory,
  createDiscoverableProvider,
  createTestApp,
  resetDatabase,
  type TestContext,
} from './harness';

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

describe('ServiceRequestReport schema', () => {
  it('refuses a second report from the same provider on the same request', async () => {
    const category = await createCategory(ctx.prisma);
    const provider = await createDiscoverableProvider(ctx.prisma, { categoryId: category.id });
    const request = await createApprovedRequest(ctx.prisma, { categoryId: category.id });

    await ctx.prisma.serviceRequestReport.create({
      data: { requestId: request.id, reporterProviderId: provider.id, reason: ServiceRequestReportReason.SPAM },
    });

    await expect(
      ctx.prisma.serviceRequestReport.create({
        data: { requestId: request.id, reporterProviderId: provider.id, reason: ServiceRequestReportReason.OTHER },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('refuses a resolution without a resolvedAt (CHECK)', async () => {
    const category = await createCategory(ctx.prisma);
    const provider = await createDiscoverableProvider(ctx.prisma, { categoryId: category.id });
    const request = await createApprovedRequest(ctx.prisma, { categoryId: category.id });

    await expect(
      ctx.prisma.serviceRequestReport.create({
        data: {
          requestId: request.id,
          reporterProviderId: provider.id,
          reason: ServiceRequestReportReason.SPAM,
          resolution: 'DISMISSED',
        },
      }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });

  it('ships the new columns with their safe defaults', async () => {
    const settings = await ctx.prisma.operationsSettings.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', unviewedOfferRefundWindowHours: 48 },
      update: {},
    });
    expect(settings.marketplaceAutoPublishEnabled).toBe(false);

    const category = await createCategory(ctx.prisma);
    const provider = await createDiscoverableProvider(ctx.prisma, { categoryId: category.id });
    const request = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    const offer = await ctx.prisma.offer.create({
      data: { requestId: request.id, providerId: provider.id, priceAmount: 1000, message: 'x' },
    });
    expect(offer.cancelledAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run — fails**

Run: `cd apps/api && pnpm vitest run test/request-report-schema.spec.ts`
Expected: FAIL — `serviceRequestReport` Prisma client'ta yok (TS/ runtime hatası).

- [ ] **Step 3: Şema değişiklikleri**

`prisma/schema.prisma`, `enum ServiceRequestStatus` bloğundan hemen sonra:

```prisma
/// Why a provider brought a request in front of an operator.
enum ServiceRequestReportReason {
  SPAM
  FAKE_OR_TEST
  CONTAINS_CONTACT_INFO
  WRONG_CATEGORY
  INAPPROPRIATE_CONTENT
  DUPLICATE
  OTHER
}

/// The one decision an operator takes about a report.
///
/// DISMISSED       — the request stays live.
/// REQUEST_REMOVED — the request was taken off the market (REJECTED), its
///                   live offers closed and their credits returned.
enum ServiceRequestReportResolution {
  DISMISSED
  REQUEST_REMOVED
}
```

`model ServiceRequest` ilişkilerine `reports ServiceRequestReport[]`, indekslerine
`@@index([customerPhone, submittedAt])` ekle. `model Offer`'a `withdrawnAt` altına:

```prisma
  /// When the platform closed this offer because its request was taken off the
  /// market. Written together with `status: CANCELLED` by
  /// ServiceRequestsService.rejectRequestInTransaction — the only writer of
  /// CANCELLED in the product. NULL on every offer that was never closed that
  /// way, which is every offer written before this column existed.
  cancelledAt                 DateTime?
```

`model OperationsSettings`'e `showcasePlacementExpirySchedulerEnabled` altına:

```prisma
  /// Whether a marketplace request is published to matching providers the
  /// moment it is created, without an operator approving it first.
  ///
  /// Same contract as the scheduler switches above: false by default, read
  /// fail-closed on every request creation, switched on by a person on the
  /// operations screen and never by a migration or an environment variable.
  marketplaceAutoPublishEnabled           Boolean  @default(false)
```

`model ProviderProfile`'a `requestReports ServiceRequestReport[]`, `model User`'a
`resolvedRequestReports ServiceRequestReport[] @relation("ServiceRequestReportResolvedBy")`.
Yeni model (`RequestDraft` modelinden önce):

```prisma
/// A provider telling an operator that a live request needs a look.
///
/// Append-only by contract: a row is created once and resolved once
/// (open → resolved); nothing updates or deletes it afterwards. A report never
/// hides anything by itself — the request stays exactly as visible and
/// offerable as it was until an operator decides.
///
/// A PostgreSQL CHECK ("ServiceRequestReport_resolution_pair",
/// ("resolvedAt" IS NULL) = ("resolution" IS NULL)) and a partial index on the
/// open queue ("ServiceRequestReport_open_idx", WHERE "resolvedAt" IS NULL)
/// live in the migration's raw SQL; Prisma cannot express either.
model ServiceRequestReport {
  id                 String                          @id @default(cuid())
  requestId          String
  reporterProviderId String
  reason             ServiceRequestReportReason
  /// Optional free text, bounded by the DTO (500 UTF-16 code units). Read by
  /// admin surfaces only; never rendered to a customer or another provider.
  note               String?
  createdAt          DateTime                        @default(now())
  resolvedAt         DateTime?
  resolvedByUserId   String?
  resolution         ServiceRequestReportResolution?
  /// The operator's note on the decision. Admin-only, like `note`.
  resolutionNote     String?

  request    ServiceRequest  @relation(fields: [requestId], references: [id], onDelete: Restrict)
  reporter   ProviderProfile @relation(fields: [reporterProviderId], references: [id], onDelete: Restrict)
  resolvedBy User?           @relation("ServiceRequestReportResolvedBy", fields: [resolvedByUserId], references: [id], onDelete: SetNull)

  /// One report per provider per request — the database's answer to a
  /// double-click and to a provider filing the same complaint twice.
  @@unique([requestId, reporterProviderId])
  @@index([requestId])
  /// The per-provider daily budget count.
  @@index([reporterProviderId, createdAt])
  @@index([resolvedAt, createdAt])
}
```

- [ ] **Step 4: Migration SQL'i yaz (elle, DML'siz)**

`prisma/migrations/20260914120000_add_request_reports_and_auto_publish/migration.sql`:

```sql
-- CreateEnum
CREATE TYPE "ServiceRequestReportReason" AS ENUM ('SPAM', 'FAKE_OR_TEST', 'CONTAINS_CONTACT_INFO', 'WRONG_CATEGORY', 'INAPPROPRIATE_CONTENT', 'DUPLICATE', 'OTHER');
CREATE TYPE "ServiceRequestReportResolution" AS ENUM ('DISMISSED', 'REQUEST_REMOVED');

-- AlterTable: additive, defaulted / nullable. No row is rewritten.
ALTER TABLE "OperationsSettings" ADD COLUMN "marketplaceAutoPublishEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Offer" ADD COLUMN "cancelledAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ServiceRequestReport" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "reporterProviderId" TEXT NOT NULL,
    "reason" "ServiceRequestReportReason" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,
    "resolution" "ServiceRequestReportResolution",
    "resolutionNote" TEXT,

    CONSTRAINT "ServiceRequestReport_pkey" PRIMARY KEY ("id"),
    -- A resolution and its timestamp are one fact: neither may exist alone.
    CONSTRAINT "ServiceRequestReport_resolution_pair" CHECK (("resolvedAt" IS NULL) = ("resolution" IS NULL))
);

-- CreateIndex
CREATE UNIQUE INDEX "ServiceRequestReport_requestId_reporterProviderId_key" ON "ServiceRequestReport"("requestId", "reporterProviderId");
CREATE INDEX "ServiceRequestReport_requestId_idx" ON "ServiceRequestReport"("requestId");
CREATE INDEX "ServiceRequestReport_reporterProviderId_createdAt_idx" ON "ServiceRequestReport"("reporterProviderId", "createdAt");
CREATE INDEX "ServiceRequestReport_resolvedAt_createdAt_idx" ON "ServiceRequestReport"("resolvedAt", "createdAt");
-- The open queue, oldest first. Partial: resolved rows never enter it.
CREATE INDEX "ServiceRequestReport_open_idx" ON "ServiceRequestReport"("createdAt") WHERE "resolvedAt" IS NULL;
CREATE INDEX "ServiceRequest_customerPhone_submittedAt_idx" ON "ServiceRequest"("customerPhone", "submittedAt");

-- AddForeignKey
ALTER TABLE "ServiceRequestReport" ADD CONSTRAINT "ServiceRequestReport_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ServiceRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ServiceRequestReport" ADD CONSTRAINT "ServiceRequestReport_reporterProviderId_fkey" FOREIGN KEY ("reporterProviderId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ServiceRequestReport" ADD CONSTRAINT "ServiceRequestReport_resolvedByUserId_fkey" FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

- [ ] **Step 5: Şema ile migration'ın uyuştuğunu doğrula, client üret**

Run (kökten): `pnpm exec prisma validate && pnpm exec prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$SHADOW_DATABASE_URL" --exit-code`
Expected: exit 0 ("No difference detected"). Sonra `pnpm db:generate`.
Not: CHECK ve partial index Prisma diff'inde görünmez; bu beklenir. `SHADOW_DATABASE_URL` yoksa aynı komutu `--shadow-database-url` yerine geçici bir boş DB URL'siyle çalıştır.

- [ ] **Step 6: Run — passes**

Run: `cd apps/api && pnpm vitest run test/request-report-schema.spec.ts`
Expected: PASS (global-setup `prisma migrate deploy` uygular).

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260914120000_add_request_reports_and_auto_publish apps/api/test/request-report-schema.spec.ts
git commit -m "feat(prisma): ServiceRequestReport tablosu, otomatik yayın anahtarı ve Offer.cancelledAt

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Otomatik yayın anahtarı (operations settings)

**Files:**
- Create: `apps/api/src/modules/operations-settings/marketplace-publish-settings.service.ts`
- Create: `apps/api/src/modules/operations-settings/marketplace-publish-settings.controller.ts`
- Modify: `apps/api/src/modules/operations-settings/operations-settings.module.ts` (provider + controller + export)
- Test: `apps/api/test/marketplace-publish-settings.spec.ts`

**Interfaces:**
- Produces: `MarketplacePublishSettingsService.isAutoPublishEnabled(): Promise<boolean>` (fail-closed), `setAutoPublishEnabled(enabled: boolean, changedById: string): Promise<MarketplacePublishSettingsView>`, `getForAdmin(): Promise<MarketplacePublishSettingsView>`; `MarketplacePublishSettingsView = { enabled: boolean; recentChanges: SchedulerSettingsChangeView[] }`; sabit `MARKETPLACE_AUTO_PUBLISH_SETTING = 'marketplaceAutoPublishEnabled'`. Uçlar: `GET /operations-settings/marketplace-publish`, `PUT /operations-settings/marketplace-publish` body `{ enabled }` (`SetSchedulerEnabledDto` yeniden kullanılır).

- [ ] **Step 1: Failing test**

```ts
// apps/api/test/marketplace-publish-settings.spec.ts
import { UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, createUser, loginAs, resetDatabase, type TestContext } from './harness';

let ctx: TestContext;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.app.close(); });
beforeEach(async () => { await resetDatabase(ctx.prisma); });

describe('marketplace auto-publish switch', () => {
  it('reads false with no row, records one audit entry per real change', async () => {
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const token = await loginAs(ctx.prisma, admin.id);

    const before = await request(ctx.server)
      .get('/operations-settings/marketplace-publish')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(before.body.enabled).toBe(false);

    await request(ctx.server)
      .put('/operations-settings/marketplace-publish')
      .set('Authorization', `Bearer ${token}`)
      .send({ enabled: true })
      .expect(200);
    // Same value again: no second audit row.
    await request(ctx.server)
      .put('/operations-settings/marketplace-publish')
      .set('Authorization', `Bearer ${token}`)
      .send({ enabled: true })
      .expect(200);

    const row = await ctx.prisma.operationsSettings.findUnique({ where: { id: 'singleton' } });
    expect(row?.marketplaceAutoPublishEnabled).toBe(true);
    const changes = await ctx.prisma.operationsSettingsChange.findMany({
      where: { setting: 'marketplaceAutoPublishEnabled' },
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ previousValue: null, newValue: 'true', changedById: admin.id });
  });

  it('is refused to a provider account', async () => {
    const provider = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const token = await loginAs(ctx.prisma, provider.id);
    await request(ctx.server)
      .put('/operations-settings/marketplace-publish')
      .set('Authorization', `Bearer ${token}`)
      .send({ enabled: true })
      .expect(403);
  });
});
```

Not: `loginAs`'ın cookie mi bearer mı döndürdüğünü `test/admin-offer-status.spec.ts`'teki kullanımdan kopyala; oradaki `.set(...)` şeklini birebir kullan.

- [ ] **Step 2: Run — fails (404)**

Run: `cd apps/api && pnpm vitest run test/marketplace-publish-settings.spec.ts`

- [ ] **Step 3: Servis**

```ts
// apps/api/src/modules/operations-settings/marketplace-publish-settings.service.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import { DEFAULT_UNVIEWED_OFFER_REFUND_WINDOW_HOURS } from '../offers/refund-policy';
import { OPERATIONS_SETTINGS_ID } from './operations-settings.service';
import type { SchedulerSettingsChangeView } from './scheduler-settings.service';

export const MARKETPLACE_AUTO_PUBLISH_SETTING = 'marketplaceAutoPublishEnabled';

export type MarketplacePublishSettingsView = {
  enabled: boolean;
  recentChanges: SchedulerSettingsChangeView[];
};

const RECENT_CHANGE_LIMIT = 20;

/**
 * The one switch that decides whether a marketplace request waits for an
 * operator. Same contract as SchedulerSettingsService: no row, an unreadable
 * row and a false column all mean "off"; every creation re-reads it.
 */
@Injectable()
export class MarketplacePublishSettingsService {
  private readonly logger = new Logger(MarketplacePublishSettingsService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async isAutoPublishEnabled(): Promise<boolean> {
    try {
      const row = await this.prisma.operationsSettings.findUnique({
        where: { id: OPERATIONS_SETTINGS_ID },
        select: { marketplaceAutoPublishEnabled: true },
      });
      return row?.marketplaceAutoPublishEnabled ?? false;
    } catch (error) {
      this.logger.error(
        `Auto-publish setting could not be read; treating it as off (${error instanceof Error ? error.name : 'UnknownError'})`,
      );
      return false;
    }
  }

  async getForAdmin(): Promise<MarketplacePublishSettingsView> {
    const [row, changes] = await Promise.all([
      this.prisma.operationsSettings.findUnique({
        where: { id: OPERATIONS_SETTINGS_ID },
        select: { marketplaceAutoPublishEnabled: true },
      }),
      this.prisma.operationsSettingsChange.findMany({
        where: { setting: MARKETPLACE_AUTO_PUBLISH_SETTING },
        orderBy: { createdAt: 'desc' },
        take: RECENT_CHANGE_LIMIT,
        select: {
          id: true, setting: true, previousValue: true, newValue: true, createdAt: true,
          changedBy: { select: { id: true, name: true } },
        },
      }),
    ]);
    return { enabled: row?.marketplaceAutoPublishEnabled ?? false, recentChanges: changes };
  }

  async setAutoPublishEnabled(enabled: boolean, changedById: string) {
    await runSerializable(
      this.prisma,
      async (tx) => {
        const current = await tx.operationsSettings.findUnique({
          where: { id: OPERATIONS_SETTINGS_ID },
          select: { marketplaceAutoPublishEnabled: true },
        });
        const stored = current?.marketplaceAutoPublishEnabled ?? null;
        if ((stored ?? false) === enabled) {
          return;
        }
        await tx.operationsSettings.upsert({
          where: { id: OPERATIONS_SETTINGS_ID },
          create: {
            id: OPERATIONS_SETTINGS_ID,
            unviewedOfferRefundWindowHours: DEFAULT_UNVIEWED_OFFER_REFUND_WINDOW_HOURS,
            updatedById: changedById,
            marketplaceAutoPublishEnabled: enabled,
          },
          update: { updatedById: changedById, marketplaceAutoPublishEnabled: enabled },
        });
        await tx.operationsSettingsChange.create({
          data: {
            setting: MARKETPLACE_AUTO_PUBLISH_SETTING,
            previousValue: stored === null ? null : String(stored),
            newValue: String(enabled),
            changedById,
          },
        });
      },
      { label: 'marketplacePublishSettings.set' },
    );
    return this.getForAdmin();
  }
}
```

Controller (`marketplace-publish-settings.controller.ts`), `SchedulerSettingsController` ile aynı guard/dekoratörler:

```ts
import { Body, Controller, ForbiddenException, Get, Inject, Put, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { RolesGuard } from '../auth/roles.guard';
import { SetSchedulerEnabledDto } from './dto/set-scheduler-enabled.dto';
import { MarketplacePublishSettingsService } from './marketplace-publish-settings.service';

@Controller('operations-settings/marketplace-publish')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class MarketplacePublishSettingsController {
  constructor(
    @Inject(MarketplacePublishSettingsService)
    private readonly settings: MarketplacePublishSettingsService,
  ) {}

  @Get()
  get() {
    return this.settings.getForAdmin();
  }

  @Put()
  set(@Body() dto: SetSchedulerEnabledDto, @CurrentUser() user: AuthUser) {
    if (!user?.id) {
      throw new ForbiddenException('Bu ayar yalnızca oturum açmış bir yönetici tarafından değiştirilebilir');
    }
    return this.settings.setAutoPublishEnabled(dto.enabled, user.id);
  }
}
```

`operations-settings.module.ts`: `providers`'a `MarketplacePublishSettingsService`, `controllers`'a controller, `exports`'a servis ekle (ServiceRequestsModule ve ShowcaseModule import edecek). `OperationsSettingsModule`'ün `ServiceRequestsModule`'e zaten import edilip edilmediğini kontrol et (`OperationsSettingsService.getUnviewedOfferRefundWindowHours` providers.service'te kullanılıyor → `ProvidersModule` import ediyor); değilse Task 4'te ekle.

- [ ] **Step 4: Run — passes**; **Step 5: Commit** `feat(operations-settings): pazar talepleri için otomatik yayın anahtarı`.

---

### Task 3: `RequestPublishOutbox` — yayın bildirimlerinin kalıcı niyeti

**Files:**
- Create: `apps/api/src/modules/notifications/request-publish-outbox.service.ts`
- Modify: `apps/api/src/modules/notifications/transactional-mail.service.ts:1466` (`findMatchingProviders` export + tx client tipi), `:241-297` (`fanOutApprovedRequest` → enqueue'ya delege)
- Modify: `apps/api/src/modules/notifications/notifications.module.ts` (provider + export)
- Modify: `apps/api/src/modules/request-lifecycle/request-lifecycle-scheduler.service.ts:83` (expiry tick'inde `publishOutbox.deliverPending`)
- Test: `apps/api/test/request-publish-outbox.spec.ts`

**Interfaces:**
- Consumes: `intentRow`, `deliverPendingIntents`, `claimablePredicate` (`notification-intents.ts`), `NotificationDispatcher`, `TransactionalMailService.composeRetryMessage`.
- Produces: `RequestPublishOutbox.enqueue(tx: Prisma.TransactionClient, requestId: string, approvedAt: Date): Promise<{ reached: number; enqueued: number }>`, `deliverPending(options?: { limit?: number }): Promise<IntentDeliveryResult>`, `REQUEST_PUBLISH_TEMPLATES = ['request-published', 'request-available'] as const`.

- [ ] **Step 1: Failing test**

```ts
// apps/api/test/request-publish-outbox.spec.ts
import { NotificationStatus } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RequestPublishOutbox } from '../src/modules/notifications/request-publish-outbox.service';
import {
  createApprovedRequest, createCategory, createDiscoverableProvider, createTestApp, createUser,
  resetDatabase, type TestContext,
} from './harness';
import { UserRole } from '@prisma/client';

let ctx: TestContext;
let outbox: RequestPublishOutbox;
beforeAll(async () => { ctx = await createTestApp(); outbox = ctx.app.get(RequestPublishOutbox); });
afterAll(async () => { await ctx.app.close(); });
beforeEach(async () => { await resetDatabase(ctx.prisma); ctx.notifications.clear(); });

describe('RequestPublishOutbox', () => {
  it('enqueues one customer intent and one intent per matching provider, once', async () => {
    const category = await createCategory(ctx.prisma);
    const providerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    await createDiscoverableProvider(ctx.prisma, { categoryId: category.id, userId: providerUser.id });
    await createDiscoverableProvider(ctx.prisma, { categoryId: category.id, city: 'Ankara', district: 'Çankaya' });
    const approvedAt = new Date();
    const request = await createApprovedRequest(ctx.prisma, { categoryId: category.id, approvedAt });

    const first = await ctx.prisma.$transaction((tx) => outbox.enqueue(tx, request.id, approvedAt));
    const second = await ctx.prisma.$transaction((tx) => outbox.enqueue(tx, request.id, approvedAt));

    expect(first).toEqual({ reached: 1, enqueued: 2 });
    expect(second.enqueued).toBe(0);
    const pending = await ctx.prisma.notificationLog.findMany({ where: { requestId: request.id } });
    expect(pending.map((row) => row.template).sort()).toEqual(['request-available', 'request-published']);
    expect(pending.every((row) => row.status === NotificationStatus.PENDING && row.attemptCount === 0)).toBe(true);
  });

  it('delivers pending intents exactly once across two sweeps', async () => {
    const category = await createCategory(ctx.prisma);
    const providerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    await createDiscoverableProvider(ctx.prisma, { categoryId: category.id, userId: providerUser.id });
    const approvedAt = new Date();
    const request = await createApprovedRequest(ctx.prisma, { categoryId: category.id, approvedAt });
    await ctx.prisma.$transaction((tx) => outbox.enqueue(tx, request.id, approvedAt));

    const a = await outbox.deliverPending();
    const b = await outbox.deliverPending();
    expect(a.sent).toBe(2);
    expect(b.claimed).toBe(0);
    expect(ctx.notifications.sent.filter((m) => m.template === 'request-available')).toHaveLength(1);
    expect(ctx.notifications.sent.filter((m) => m.template === 'request-published')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run — fails** (modül yok).

- [ ] **Step 3: `findMatchingProviders`'ı dışa aç**

`transactional-mail.service.ts:1466`: `async function findMatchingProviders(prisma: PrismaService, ...)` → `export async function findMatchingProviders(prisma: Pick<Prisma.TransactionClient, 'serviceRequest' | 'providerProfile'>, ...)`. `Prisma` import'u dosyada zaten varsa yeniden ekleme. `recipientFor` aynı dosyada kalır; export gerekmez.

- [ ] **Step 4: Outbox servisi**

```ts
// apps/api/src/modules/notifications/request-publish-outbox.service.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, ServiceRequestStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { deliverPendingIntents, IntentDeliveryResult, intentRow } from './notification-intents';
import { findMatchingProviders, TransactionalMailService } from './transactional-mail.service';

export const REQUEST_PUBLISH_TEMPLATES = ['request-published', 'request-available'] as const;

const DEFAULT_DELIVERY_LIMIT = 200;

/**
 * The approval fan-out as a durable intent rather than a synchronous send.
 *
 * `enqueue` runs inside the transaction that publishes the request, so "the
 * request is live" and "its notifications are owed" commit together.
 * `deliverPending` runs after the commit and never on the request path's
 * critical section; anything it does not finish is picked up by the next
 * delivery, by the expiry scheduler's tick, or by the admin retry button —
 * all three keyed on the same (template, dedupeKey) unique index.
 */
@Injectable()
export class RequestPublishOutbox {
  private readonly logger = new Logger(RequestPublishOutbox.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(NotificationDispatcher) private readonly dispatcher: NotificationDispatcher,
    @Inject(TransactionalMailService) private readonly mail: TransactionalMailService,
  ) {}

  async enqueue(tx: Prisma.TransactionClient, requestId: string, approvedAt: Date) {
    const request = await tx.serviceRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true, status: true, customerId: true, customerEmail: true,
        categoryId: true, city: true, district: true, neighborhood: true,
        directShowcaseProviderId: true,
      },
    });

    // Post-update state. A request that is not live, or one still reserved for
    // a single vitrin business, is fanned out to nobody.
    if (!request || request.status !== ServiceRequestStatus.APPROVED || request.directShowcaseProviderId !== null) {
      return { reached: 0, enqueued: 0 };
    }

    const audience = await findMatchingProviders(tx, request);
    const intents: Prisma.NotificationLogCreateManyInput[] = [];

    const customerEmail = request.customerEmail?.trim();
    if (customerEmail) {
      intents.push(intentRow({
        template: 'request-published',
        to: customerEmail,
        dedupeKey: `request-published:${request.id}:${approvedAt.toISOString()}`,
        requestId: request.id,
        userId: request.customerId,
        providerId: null,
      }));
    }

    for (const provider of audience) {
      if (!provider.recipient) continue;
      intents.push(intentRow({
        template: 'request-available',
        to: provider.recipient,
        dedupeKey: `request-available:${request.id}:${provider.id}`,
        requestId: request.id,
        userId: provider.userId,
        providerId: provider.id,
      }));
    }

    const created = intents.length === 0
      ? { count: 0 }
      : await tx.notificationLog.createMany({ data: intents, skipDuplicates: true });

    this.logger.log(`request publish intents for ${request.id}: reached=${audience.length} enqueued=${created.count}`);
    return { reached: audience.length, enqueued: created.count };
  }

  async deliverPending(options: { limit?: number } = {}): Promise<IntentDeliveryResult> {
    return deliverPendingIntents({
      prisma: this.prisma,
      dispatcher: this.dispatcher,
      mail: this.mail,
      logger: this.logger,
      templates: REQUEST_PUBLISH_TEMPLATES,
      limit: options.limit ?? DEFAULT_DELIVERY_LIMIT,
      label: 'Request publish',
    });
  }

  /** Fire after a commit: never awaited by a request handler. */
  deliverSoon(): void {
    void this.deliverPending().catch((error) => {
      this.logger.error('Request publish delivery failed', error instanceof Error ? error.stack : String(error));
    });
  }
}
```

`deliverPendingIntents`'in `request-published` dedupeKey'ini (ISO tarih içerir, `:` ile bölünür) `parseRetrySource` ile çözebildiğini `composeRetryMessage('request-published', key)` üzerinden doğrula — mevcut admin retry zaten aynı anahtarı kullanıyor.

- [ ] **Step 5: Modül kaydı ve senkron fan-out'un kaldırılması**

`notifications.module.ts`: `RequestPublishOutbox` provider + export (modül `@Global`).
`transactional-mail.service.ts:241` `fanOutApprovedRequest`: gövdeyi koru ama artık tek çağıranı Task 4'te kalkacak; bu adımda dokunma (Task 4'te silinir).
`request-lifecycle-scheduler.service.ts`: constructor'a `@Inject(RequestPublishOutbox) private readonly publishOutbox: RequestPublishOutbox`; `:83` `const result = await this.expiry.execute({ limit });` satırından sonra:

```ts
      // The publish outbox rides the same tick: anything a request handler's
      // post-commit delivery did not finish is swept here, with no cron of its own.
      const publish = await this.publishOutbox.deliverPending({ limit });
```
ve summary string'ine `publishSent=${publish.sent}` ekle.

- [ ] **Step 6: Run — passes**; **Step 7: Commit** `feat(notifications): RequestPublishOutbox — yayın bildirimleri kalıcı niyet olarak`.

---

### Task 4: Oluşturmada yayın, doğrulama sonrası yayın, moderasyonun outbox'a geçmesi

**Files:**
- Modify: `apps/api/src/modules/service-requests/service-requests.service.ts` (`createServiceRequest` `:194-392`, `updateServiceRequestStatus` `:593-723`, yeni `publishRequestInTransaction`)
- Modify: `apps/api/src/modules/service-requests/service-requests.module.ts` (import `OperationsSettingsModule`)
- Modify: `apps/api/src/modules/phone-verification/phone-verification.service.ts:180-190` (`verifyCode` tx'i)
- Modify: `apps/api/src/modules/phone-verification/phone-verification.module.ts` (import `OperationsSettingsModule`, `NotificationsModule` global)
- Modify: `apps/api/src/modules/notifications/transactional-mail.service.ts:206-220` (`sendRequestReceived(requestId, { nextStep })`), `templates/transactional-templates.ts` (`request-received` gövdesi `nextStep`)
- Test: `apps/api/test/request-auto-publish.spec.ts`

**Interfaces:**
- Consumes: `MarketplacePublishSettingsService.isAutoPublishEnabled()`, `RequestPublishOutbox.enqueue/deliverSoon`, `isPhoneVerificationRequired()`.
- Produces: `ServiceRequestsService.publishRequestInTransaction(tx, requestId: string, now: Date): Promise<boolean>` (true = bu çağrı yayınladı; enqueue dahil).

- [ ] **Step 1: Failing test**

```ts
// apps/api/test/request-auto-publish.spec.ts
import { ServiceRequestStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createCategory, createDiscoverableProvider, createTestApp, createUser, loginAs,
  resetDatabase, serviceRequestPayload, type TestContext,
} from './harness';

let ctx: TestContext;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.app.close(); });
beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.notifications.clear();
  process.env.REQUIRE_PHONE_VERIFICATION = 'false';
});
afterEach(() => { process.env.REQUIRE_PHONE_VERIFICATION = 'false'; });

async function setAutoPublish(enabled: boolean) {
  await ctx.prisma.operationsSettings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', unviewedOfferRefundWindowHours: 48, marketplaceAutoPublishEnabled: enabled },
    update: { marketplaceAutoPublishEnabled: enabled },
  });
}

async function waitForOutbox(requestId: string, template: string, count: number) {
  for (let i = 0; i < 40; i += 1) {
    const rows = await ctx.prisma.notificationLog.findMany({ where: { requestId, template, status: 'SENT' } });
    if (rows.length >= count) return rows;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`outbox never delivered ${template}`);
}

describe('marketplace auto-publish', () => {
  it('switch off: the request waits at SUBMITTED and the customer gets request-received', async () => {
    const category = await createCategory(ctx.prisma);
    const res = await request(ctx.server).post('/service-requests').send(serviceRequestPayload(category.slug)).expect(201);
    const row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.status).toBe(ServiceRequestStatus.SUBMITTED);
    expect(row.approvedAt).toBeNull();
    expect(ctx.notifications.sent.some((m) => m.template === 'request-received')).toBe(true);
  });

  it('switch on: the request is born APPROVED, visible to a matching provider, and fanned out', async () => {
    await setAutoPublish(true);
    const category = await createCategory(ctx.prisma);
    const providerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createDiscoverableProvider(ctx.prisma, { categoryId: category.id, userId: providerUser.id });

    const res = await request(ctx.server).post('/service-requests').send(serviceRequestPayload(category.slug)).expect(201);
    const row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.status).toBe(ServiceRequestStatus.APPROVED);
    expect(row.approvedAt).toEqual(row.submittedAt);
    expect(row.moderatedAt).toBeNull();

    const token = await loginAs(ctx.prisma, providerUser.id);
    const list = await request(ctx.server).get(`/providers/${provider.id}/requests`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(list.body.map((item: { id: string }) => item.id)).toContain(row.id);

    await waitForOutbox(row.id, 'request-available', 1);
    await waitForOutbox(row.id, 'request-published', 1);
    expect(ctx.notifications.sent.some((m) => m.template === 'request-received')).toBe(false);
  });

  it('switch on + verification required: SUBMITTED until verifyCode, then APPROVED without an admin', async () => {
    await setAutoPublish(true);
    process.env.REQUIRE_PHONE_VERIFICATION = 'true';
    const category = await createCategory(ctx.prisma);
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: '05551112233', email: 'v@example.test', name: 'V' });
    const token = await loginAs(ctx.prisma, customer.id);

    const res = await request(ctx.server).post('/service-requests').set('Authorization', `Bearer ${token}`)
      .send({ ...serviceRequestPayload(category.slug), customerName: undefined, customerPhone: undefined, customerEmail: undefined })
      .expect(201);
    let row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.status).toBe(ServiceRequestStatus.SUBMITTED);
    expect(ctx.notifications.sent.find((m) => m.template === 'request-received')?.data?.nextStep).toBe('verify');

    await request(ctx.server).post(`/service-requests/${row.id}/phone-verification`).set('Authorization', `Bearer ${token}`).expect(201);
    const code = ctx.sms.sent.at(-1)!.code; // RecordingSmsPort'un alan adını harness.ts'ten doğrula
    await request(ctx.server).post(`/service-requests/${row.id}/phone-verification/verify`).set('Authorization', `Bearer ${token}`).send({ code }).expect(201);

    row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: row.id } });
    expect(row.status).toBe(ServiceRequestStatus.APPROVED);
    expect(row.approvedAt).toEqual(row.phoneVerifiedAt);
  });
});
```

`createUser` seçenek adlarını (`phone`, `email`, `name`) `test/harness.ts:274` imzasından doğrula ve gerekirse uyarla.

- [ ] **Step 2: Run — fails** (2. ve 3. case).

- [ ] **Step 3: `createServiceRequest`'te yayın**

Constructor'a ekle:
```ts
    @Inject(MarketplacePublishSettingsService)
    private readonly publishSettings: MarketplacePublishSettingsService,
    @Inject(RequestPublishOutbox) private readonly publishOutbox: RequestPublishOutbox,
```
`runSerializable` çağrısından önce:
```ts
    // Read once per creation, outside the transaction: the switch is an
    // operations decision that changes rarely, and a request that raced a
    // toggle lands on whichever side it read — both sides are valid states.
    const autoPublish = await this.publishSettings.isAutoPublishEnabled();
    const publishAtCreate =
      autoPublish &&
      !context.directShowcaseProviderId &&
      (!isPhoneVerificationRequired() || Boolean(context.phoneVerifiedAt));
    const now = new Date();
```
`tx.serviceRequest.create({ data: { ... } })` içine, `customerId` satırının altına:
```ts
          // Born live when the operations switch says so. One INSERT, one state:
          // approvedAt is the same instant as submittedAt, and moderatedAt stays
          // NULL because no person approved this — that pair is how a row says
          // "auto-published" without a column for it.
          submittedAt: now,
          ...(publishAtCreate ? { status: ServiceRequestStatus.APPROVED, approvedAt: now } : {}),
```
`context.onCreated` bloğundan sonra, `return created;` öncesinde:
```ts
      if (publishAtCreate) {
        await this.publishOutbox.enqueue(tx, created.id, now);
      }
```
Commit sonrası `await this.notify(() => this.mail.sendRequestReceived(request.id), request.id);` satırını şu blokla değiştir:
```ts
    if (request.status === ServiceRequestStatus.APPROVED) {
      // Live already: the customer is told "yayında", not "alındı".
      this.publishOutbox.deliverSoon();
    } else {
      await this.notify(
        () => this.mail.sendRequestReceived(request.id, {
          nextStep: autoPublish && isPhoneVerificationRequired() ? 'verify' : 'review',
        }),
        request.id,
      );
    }
```

- [ ] **Step 4: `publishRequestInTransaction`**

`ServiceRequestsService` içine (public):
```ts
  /**
   * Moves a waiting marketplace request to APPROVED and books its fan-out, in
   * the caller's transaction. Conditional on SUBMITTED and on an open gate, so
   * two callers cannot both publish and a vitrin lead cannot be published by
   * anything but its own flow. Returns whether this call was the one.
   */
  async publishRequestInTransaction(tx: Prisma.TransactionClient, requestId: string, now: Date) {
    const moved = await tx.serviceRequest.updateMany({
      where: { id: requestId, status: ServiceRequestStatus.SUBMITTED, directShowcaseProviderId: null },
      data: { status: ServiceRequestStatus.APPROVED, approvedAt: now },
    });
    if (moved.count !== 1) {
      return false;
    }
    await this.publishOutbox.enqueue(tx, requestId, now);
    return true;
  }
```

- [ ] **Step 5: `verifyCode` kancası**

`phone-verification.service.ts`: constructor'a `@Inject(MarketplacePublishSettingsService) private readonly publishSettings`, `@Inject(forwardRef(() => ServiceRequestsService)) private readonly requests: ServiceRequestsService` (döngüsel import varsa `forwardRef`; `PhoneVerificationModule` → `ServiceRequestsModule` bağımlılığını `phone-verification.module.ts`'te `forwardRef(() => ServiceRequestsModule)` ile import et), ve `@Inject(RequestPublishOutbox) private readonly publishOutbox`. `verifyCode` tx'inde `if (verified.count !== 1) return { ok: false }` sonrasına:

```ts
        // Verification was the last thing the request waited for: publish it
        // here, in the same transaction, so "verified" and "live" are one commit.
        const published =
          (await this.publishSettings.isAutoPublishEnabled()) &&
          (await this.requests.publishRequestInTransaction(tx, requestId, now));

        return { ok: true as const, verifiedAt: now, published };
```
Transaction'dan sonra: `if (outcome.published) this.publishOutbox.deliverSoon();`.
`isAutoPublishEnabled` tx dışı bir okuma yapar (kendi prisma'sı) — kabul edilir; anahtar tx içinde değişmez.

- [ ] **Step 6: Moderasyon "Onayla" outbox'a**

`updateServiceRequestStatus` içinde, `tx.serviceRequest.update` sonrası, aynı tx'te:
```ts
        if (
          dto.status === ServiceRequestStatus.APPROVED &&
          existing.status !== ServiceRequestStatus.APPROVED &&
          updated.directShowcaseProviderId === null
        ) {
          await this.publishOutbox.enqueue(tx, id, now);
        }
```
Commit sonrası eski `await this.notify(() => this.mail.fanOutApprovedRequest(...))` bloğunu `if (...aynı koşul) this.publishOutbox.deliverSoon();` ile değiştir. `transactional-mail.service.ts:241` `fanOutApprovedRequest` metodunu sil; `requestPublishedData`/`requestAvailableData` yardımcıları `composeRetryMessage` tarafından kullanılmaya devam eder. `grep -rn fanOutApprovedRequest apps/api/src` boş dönmeli.

- [ ] **Step 7: `request-received` `nextStep`**

`sendRequestReceived(requestId: string, options: { nextStep: 'review' | 'verify' } = { nextStep: 'review' })`; `requestReceivedData(request)` çağrısına `{ ...requestReceivedData(request), nextStep: options.nextStep }`. Şablon gövdesinde (`transactional-templates.ts`, `request-received` case) mevcut "İnceleme sonrası…" cümlesini:
```ts
data.nextStep === 'verify'
  ? 'Telefon numaranızı doğruladığınızda talebiniz uygun hizmet verenlere anında iletilir.'
  : 'Ekibimiz talebinizi inceledikten sonra uygun hizmet verenlere iletilir.'
```
`composeRetryMessage`'daki `request-received` case'i `nextStep: 'review'` ile aynı kalır (retry, tarihsel metni yeniden üretir).

- [ ] **Step 8: Run — passes** (`request-auto-publish.spec.ts` + `pnpm vitest run test/request-publish-outbox.spec.ts test/phone-verification*.spec.ts test/marketplace-journey*.spec.ts` mevcutlar).
- [ ] **Step 9: Commit** `feat(service-requests): anahtar açıkken talep oluşturmada yayın; doğrulama sonrası yayın; fan-out outbox'a`.

---

### Task 5: Vitrin RELEASE otomatik yayın

**Files:**
- Modify: `apps/api/src/modules/showcase/showcase-lead.service.ts:422-451` (`decideFallback` RELEASE dalı)
- Modify: `apps/api/src/modules/showcase/showcase.module.ts` (`OperationsSettingsModule` import; `ServiceRequestsService` zaten inject ediliyor)
- Test: `apps/api/test/showcase-lead-release-auto-publish.spec.ts`

**Interfaces:** Consumes `ServiceRequestsService.publishRequestInTransaction`, `MarketplacePublishSettingsService.isAutoPublishEnabled`, `RequestPublishOutbox.deliverSoon`.

- [ ] **Step 1: Failing test** — mevcut bir breach/fallback spec'inden (`grep -l decideFallback apps/api/test`) RELEASE case'ini kopyala; anahtar açıkken talep `APPROVED` + `approvedAt` dolu + `request-available` PENDING/SENT satırı var; anahtar kapalıyken `SUBMITTED` (mevcut davranış).
- [ ] **Step 2: Run — fails.**
- [ ] **Step 3: Kod** — RELEASE dalında gate temizleme `update`'inden sonra:
```ts
          // The market's reason to wait — "unread text must pass an operator
          // first" — no longer exists when auto-publish is on: the release is
          // the customer's decision and the request goes live right here.
          const published =
            autoPublish && (await this.requests.publishRequestInTransaction(tx, requestId, now));
          return { decision: 'RELEASE' as const, leadId: lead.id, published };
```
`autoPublish` tx'ten önce `const autoPublish = await this.publishSettings.isAutoPublishEnabled();` ile okunur. Transaction sonrası `if (outcome.decision === 'RELEASE' && outcome.published) this.publishOutbox.deliverSoon();`.
- [ ] **Step 4: Run — passes; Step 5: Commit** `feat(showcase): RELEASE kararı anahtar açıkken talebi doğrudan yayınlar`.

---

### Task 6: Kaldırma cascade'i — `rejectRequestInTransaction`, teklif `CANCELLED`, kredi iadesi

**Files:**
- Modify: `apps/api/src/modules/offers/refund-policy.ts` (sabit + etiketler)
- Modify: `apps/api/src/modules/service-requests/service-requests.service.ts` (`updateServiceRequestStatus` REJECTED dalı → yardımcı; yeni `rejectRequestInTransaction`)
- Modify: `apps/api/src/modules/offers/offer-transitions.ts:60-68` (yorum: CANCELLED'ın yazarı)
- Modify: `apps/api/src/modules/providers/providers.service.ts:2474` (`withRefundEligibility` → `closureNotice`), `providerOfferInclude`'a `cancelledAt`, `status`
- Test: `apps/api/test/request-removal-refund.spec.ts` (bu görevde moderasyon "Reddet" yolu üzerinden; `resolve` yolu Task 8'de aynı dosyaya eklenir)

**Interfaces:**
- Produces: `REQUEST_REMOVED_REFUND_REASON = 'REQUEST_REMOVED'`; `ServiceRequestsService.rejectRequestInTransaction(tx, input: { requestId: string; rejectionReason: string; moderationNote: string | null; actorUserId: string | null; now: Date }): Promise<{ cancelledOfferIds: string[]; refundedOfferIds: string[] }>`; provider teklif projeksiyonunda `closureNotice: string | null`.
- Consumes: `refundOfferCreditInTransaction` (`offers.service.ts:864`, export edilmiş), `showcaseLeads.closeForRequest`.

- [ ] **Step 1: Failing test**

```ts
// apps/api/test/request-removal-refund.spec.ts
import { CreditTransactionType, OfferEntitlementSource, OfferStatus, ServiceRequestStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UnviewedOfferRefundService } from '../src/modules/offers/unviewed-offer-refund.service';
import {
  createApprovedRequest, createCategory, createDiscoverableProvider, createTestApp, createUser,
  currentCreditBalance, grantCredits, loginAs, offerPayload, resetDatabase, type TestContext,
} from './harness';

let ctx: TestContext;
const COST = 2;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.app.close(); });
beforeEach(async () => { await resetDatabase(ctx.prisma); ctx.notifications.clear(); });

async function providerWithOffer(categoryId: string, requestId: string, opts: { viewed?: boolean } = {}) {
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, { categoryId, userId: user.id });
  await grantCredits(ctx.prisma, provider.id, 10);
  const token = await loginAs(ctx.prisma, user.id);
  const res = await request(ctx.server).post(`/providers/${provider.id}/requests/${requestId}/offers`)
    .set('Authorization', `Bearer ${token}`).send(offerPayload({ expectedCreditCost: COST })).expect(201);
  if (opts.viewed) {
    await ctx.prisma.offer.update({ where: { id: res.body.id }, data: { viewedAt: new Date(), status: OfferStatus.VIEWED } });
  }
  return { provider, offerId: res.body.id as string, token };
}

async function rejectAsAdmin(requestId: string) {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  const token = await loginAs(ctx.prisma, admin.id);
  return request(ctx.server).patch(`/service-requests/${requestId}/status`)
    .set('Authorization', `Bearer ${token}`)
    .send({ status: 'REJECTED', rejectionReason: 'Sahte talep' });
}

function refundRows(providerId: string) {
  return ctx.prisma.providerCreditTransaction.findMany({ where: { providerId, type: CreditTransactionType.OFFER_REFUND } });
}

describe('removing a request closes offers and refunds credits', () => {
  it('viewed offer: CANCELLED, one full refund, balance restored', async () => {
    const category = await createCategory(ctx.prisma, { offerCreditCost: COST });
    const req = await createApprovedRequest(ctx.prisma, { categoryId: category.id, approvedAt: new Date() });
    const { provider, offerId } = await providerWithOffer(category.id, req.id, { viewed: true });
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(10 - COST);

    await rejectAsAdmin(req.id).expect(200);

    const offer = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    expect(offer.status).toBe(OfferStatus.CANCELLED);
    expect(offer.cancelledAt).not.toBeNull();
    expect(offer.creditRefundReason).toBe('REQUEST_REMOVED');
    expect(offer.creditRefundedTransactionId).not.toBeNull();
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(10);
    const rows = await refundRows(provider.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: COST, reason: 'REQUEST_REMOVED', referenceId: offerId });
    expect(ctx.notifications.sent.some((m) => m.template === 'credit-refunded')).toBe(false);
  });

  it('unviewed offer: refunded once; the unviewed sweeper never pays it again', async () => {
    const category = await createCategory(ctx.prisma, { offerCreditCost: COST });
    const req = await createApprovedRequest(ctx.prisma, { categoryId: category.id, approvedAt: new Date() });
    const { provider, offerId } = await providerWithOffer(category.id, req.id);
    await rejectAsAdmin(req.id).expect(200);
    await ctx.prisma.offer.update({ where: { id: offerId }, data: { unviewedRefundEligibleAt: new Date(Date.now() - 1000) } });

    const sweeper = ctx.app.get(UnviewedOfferRefundService);
    const result = await sweeper.execute({ limit: 50 });
    expect(result.refunded ?? 0).toBe(0); // alan adını execute() dönüşünden doğrula
    expect(await refundRows(provider.id)).toHaveLength(1);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(10);
  });

  it('several offers: one refund each; a second removal attempt changes nothing', async () => {
    const category = await createCategory(ctx.prisma, { offerCreditCost: COST });
    const req = await createApprovedRequest(ctx.prisma, { categoryId: category.id, approvedAt: new Date() });
    const a = await providerWithOffer(category.id, req.id, { viewed: true });
    const b = await providerWithOffer(category.id, req.id);
    await rejectAsAdmin(req.id).expect(200);
    await rejectAsAdmin(req.id).expect(409);
    expect(await refundRows(a.provider.id)).toHaveLength(1);
    expect(await refundRows(b.provider.id)).toHaveLength(1);
    // The database's own bar: a second refund row for one offer is unrepresentable.
    await expect(ctx.prisma.providerCreditTransaction.create({
      data: { providerId: a.provider.id, type: CreditTransactionType.OFFER_REFUND, amount: COST, balanceAfter: 12, referenceType: 'Offer', referenceId: a.offerId },
    })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('zero-credit and period-package offers close without a ledger row', async () => {
    const category = await createCategory(ctx.prisma, { offerCreditCost: COST });
    const req = await createApprovedRequest(ctx.prisma, { categoryId: category.id, approvedAt: new Date() });
    const { provider, offerId } = await providerWithOffer(category.id, req.id);
    // Rewrite the spend as a period-package offer: no ledger row to give back.
    await ctx.prisma.offer.update({ where: { id: offerId }, data: { entitlementSource: OfferEntitlementSource.MONTHLY_QUOTA, creditSpentTransactionId: null } });
    const before = await currentCreditBalance(ctx.prisma, provider.id);
    await rejectAsAdmin(req.id).expect(200);
    const offer = await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
    expect(offer.status).toBe(OfferStatus.CANCELLED);
    expect(offer.creditRefundedTransactionId).toBeNull();
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(before);
  });

  it('a MATCHED request cannot be removed and nothing moves', async () => {
    const category = await createCategory(ctx.prisma, { offerCreditCost: COST });
    const req = await createApprovedRequest(ctx.prisma, { categoryId: category.id, approvedAt: new Date() });
    const { provider, offerId } = await providerWithOffer(category.id, req.id);
    await ctx.prisma.$transaction([
      ctx.prisma.offer.update({ where: { id: offerId }, data: { status: OfferStatus.ACCEPTED, acceptedAt: new Date() } }),
      ctx.prisma.serviceRequest.update({ where: { id: req.id }, data: { status: ServiceRequestStatus.MATCHED, matchedOfferId: offerId, matchedAt: new Date() } }),
    ]);
    await rejectAsAdmin(req.id).expect(409);
    expect(await refundRows(provider.id)).toHaveLength(0);
    expect((await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } })).status).toBe(OfferStatus.ACCEPTED);
  });

  it('a failing refund rolls the whole removal back', async () => {
    const category = await createCategory(ctx.prisma, { offerCreditCost: COST });
    const req = await createApprovedRequest(ctx.prisma, { categoryId: category.id, approvedAt: new Date() });
    const { offerId } = await providerWithOffer(category.id, req.id);
    // Poison the offer so refundOfferCreditInTransaction's conditional update matches nothing.
    await ctx.prisma.offer.update({ where: { id: offerId }, data: { creditRefundedAt: new Date() } });
    await rejectAsAdmin(req.id).expect(409);
    const row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.status).toBe(ServiceRequestStatus.APPROVED);
    expect((await ctx.prisma.offer.findUniqueOrThrow({ where: { id: offerId } })).status).toBe(OfferStatus.SUBMITTED);
  });

  it('a manual refund after removal is refused as already refunded', async () => {
    const category = await createCategory(ctx.prisma, { offerCreditCost: COST });
    const req = await createApprovedRequest(ctx.prisma, { categoryId: category.id, approvedAt: new Date() });
    const { offerId } = await providerWithOffer(category.id, req.id, { viewed: true });
    await rejectAsAdmin(req.id).expect(200);
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const token = await loginAs(ctx.prisma, admin.id);
    await request(ctx.server).post(`/offers/${offerId}/refund-credit`).set('Authorization', `Bearer ${token}`)
      .send({ reasonCode: 'INVALID_REQUEST' }).expect(409);
  });
});
```

`createCategory`'nin `offerCreditCost` seçeneğini ve manuel iade uç yolunu (`grep -n "refund" apps/api/src/modules/offers/offers.controller.ts`) harness/controller'dan doğrula.

Not — "poison" senaryosu: `creditRefundedAt` dolu ama `creditRefundedTransactionId` boş satır, cascade'in aday filtresinde (`creditRefundedTransactionId: null`) **görünür**, fakat `refundOfferCreditInTransaction` `creditRefundedAt: null` şartıyla `count !== 1` → `ConflictException` → tüm tx geri alınır. Test tam bunu kanıtlar.

- [ ] **Step 2: Run — fails.**

- [ ] **Step 3: Sabit ve etiketler** (`refund-policy.ts`)

```ts
/**
 * The platform took the request off the market. Not {@link UNVIEWED_OFFER_REFUND_REASON}
 * and not a manual code: the provider did nothing and the customer decided
 * nothing — the credit comes back because the thing it bought was withdrawn.
 */
export const REQUEST_REMOVED_REFUND_REASON = 'REQUEST_REMOVED';
```
`REFUND_REASON_LABELS`: `REQUEST_REMOVED: 'Talep yayından kaldırıldı — kredi iadesi'`; `REFUND_DETAILS`: `REQUEST_REMOVED: 'Talep platform tarafından yayından kaldırıldı; harcanan teklif krediniz iade edildi.'`. `calculateRefundEligibility`'nin `refunded` dalı `ALREADY_REFUNDED` döner — değişmez.

- [ ] **Step 4: Yardımcı**

`service-requests.service.ts`'e import: `import { refundOfferCreditInTransaction } from '../offers/offers.service'; import { REQUEST_REMOVED_REFUND_REASON } from '../offers/refund-policy';`.

```ts
  /** Statuses a request may be taken off the market from. MATCHED is not one. */
  static readonly REMOVABLE_STATUSES = [
    ServiceRequestStatus.APPROVED,
    ServiceRequestStatus.IN_REVIEW,
    ServiceRequestStatus.SUBMITTED,
  ] as const;

  /**
   * Takes a request off the market: REJECTED, its vitrin lead closed, its live
   * offers CANCELLED and every one-time credit they spent returned — all in
   * the caller's transaction, so none of it exists without the rest.
   *
   * The one writer of Offer.CANCELLED in the product. Both the moderation
   * screen's "Reddet" and a report's "Talebi kaldır" arrive here.
   */
  async rejectRequestInTransaction(
    tx: Prisma.TransactionClient,
    input: { requestId: string; rejectionReason: string; moderationNote: string | null; actorUserId: string | null; now: Date },
  ) {
    const { requestId, now } = input;
    const moved = await tx.serviceRequest.updateMany({
      where: { id: requestId, status: { in: [...ServiceRequestsService.REMOVABLE_STATUSES] } },
      data: {
        status: ServiceRequestStatus.REJECTED,
        rejectionReason: input.rejectionReason,
        moderationNote: input.moderationNote,
        moderatedAt: now,
      },
    });
    if (moved.count !== 1) {
      throw new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        code: 'REQUEST_NOT_REMOVABLE',
        message: 'Bu talep bu durumdan kaldırılamaz; eşleşmiş talep için iptal kullanın.',
      });
    }

    await this.showcaseLeads.closeForRequest(tx, requestId, ShowcaseLeadCloseReason.MODERATION_REJECTED, now);

    // Read before the update, inside the transaction: exactly the set this
    // cascade closes and nothing else.
    const live = await tx.offer.findMany({
      where: { requestId, status: { in: [OfferStatus.SUBMITTED, OfferStatus.VIEWED, OfferStatus.SHORTLISTED] } },
      orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true, providerId: true, creditCost: true, entitlementSource: true,
        creditSpentTransactionId: true, creditRefundedTransactionId: true,
      },
    });

    await tx.offer.updateMany({
      where: { id: { in: live.map((offer) => offer.id) }, status: { in: [OfferStatus.SUBMITTED, OfferStatus.VIEWED, OfferStatus.SHORTLISTED] } },
      data: { status: OfferStatus.CANCELLED, cancelledAt: now },
    });

    const refundedOfferIds: string[] = [];
    for (const offer of live) {
      // Only a one-time credit has a ledger row to give back. A period package
      // (quota / unlimited) and a vitrin lead spent none; they close and that is all.
      const refundable =
        offer.entitlementSource === OfferEntitlementSource.ONE_TIME_CREDIT &&
        offer.creditSpentTransactionId !== null &&
        offer.creditCost > 0 &&
        offer.creditRefundedTransactionId === null;
      if (!refundable) continue;

      // Throws on any guard failure, which rolls the whole removal back.
      await refundOfferCreditInTransaction(
        tx,
        { id: offer.id, providerId: offer.providerId, creditCost: offer.creditCost },
        REQUEST_REMOVED_REFUND_REASON,
        { enforceUnviewedPolicy: false, createdById: input.actorUserId },
      );
      refundedOfferIds.push(offer.id);
    }

    return { cancelledOfferIds: live.map((offer) => offer.id), refundedOfferIds };
  }
```
`OfferEntitlementSource`, `OfferStatus` import'larını `@prisma/client`'tan ekle.

- [ ] **Step 5: Moderasyon REJECTED dalını yardımcıya bağla**

`updateServiceRequestStatus`: `dto.status === REJECTED` ise `runSerializable` içinde `tx.serviceRequest.update` **yerine** `await this.rejectRequestInTransaction(tx, { requestId: id, rejectionReason: rejectionReason!, moderationNote, actorUserId: null, now })` çağır (mevcut `showcaseLeads.closeForRequest` bloğunu kaldır — yardımcı yapıyor); sonra `tx.serviceRequest.findUniqueOrThrow` ile aynı `include` projeksiyonunu döndür. Diğer statüler için mevcut `update` aynen kalır. `actorUserId`: controller `@CurrentUser()`'ı `updateServiceRequestStatus(id, dto, user)`'a geçirir; `user?.id ?? null`.

- [ ] **Step 6: Provider projeksiyonu**

`providers.service.ts` `withRefundEligibility`: `RefundPolicyOfferShape`'e `status: OfferStatus; cancelledAt?: Date | null; creditRefundReason: string | null` ekle ve dönüşe:
```ts
    closureNotice: closureNoticeFor(offer),
```
```ts
/** What a provider is told about an offer the platform closed, and nothing about why the request went. */
function closureNoticeFor(offer: { status: OfferStatus; creditRefundReason: string | null }): string | null {
  if (offer.status !== OfferStatus.CANCELLED) return null;
  return offer.creditRefundReason === REQUEST_REMOVED_REFUND_REASON
    ? 'Talep yayından kaldırıldı. Harcanan teklif krediniz iade edildi.'
    : 'Talep yayından kaldırıldı.';
}
```
`providerOfferInclude` ve `getMatchingRequest`'in `offers.select`'ine `cancelledAt: true` ekle. `offer-transitions.ts:60-68` yorumunu güncelle: "`CANCELLED` is written by exactly one place — `ServiceRequestsService.rejectRequestInTransaction`; `SUBMITTED` and `EXPIRED` still have no writer."

- [ ] **Step 7: Run — passes** (+ `pnpm vitest run test/unviewed*.spec.ts test/admin-offer-status.spec.ts test/offer-withdraw*.spec.ts`).
- [ ] **Step 8: Commit** `feat(service-requests): talep kaldırmada aktif teklifler CANCELLED, harcanan krediler atomik ve idempotent iade`.

---

### Task 7: Rapor modülü — provider ucu, `myReport`, günlük bütçe

**Files:**
- Create: `apps/api/src/modules/request-reports/request-reports.module.ts`, `request-reports.service.ts`, `provider-request-reports.controller.ts`, `dto/create-request-report.dto.ts`, `request-reports.constants.ts`
- Modify: `apps/api/src/modules/providers/providers.service.ts:1739` (`ensureProviderCanSeeRequest` → public, `getMatchingRequest` `myReport`)
- Modify: `apps/api/src/app.module.ts` (modül import)
- Test: `apps/api/test/request-reports.spec.ts`

**Interfaces:**
- Produces: `POST /providers/:providerId/requests/:requestId/reports` `{ reason: ServiceRequestReportReason; note?: string }` → `201 { id, reason, createdAt }`; hata kodları `REPORT_ALREADY_EXISTS` (409), `REPORT_RATE_LIMITED` (429); `RequestReportsService.createForProvider(providerId, requestId, dto)`; `REPORT_MAX_PER_PROVIDER_PER_DAY = 20`; `REPORT_NOTE_MAX_LENGTH = 500`. `GET /providers/:providerId/requests/:requestId` → `myReport: { reason, createdAt } | null`.
- Consumes: `ProvidersService.ensureProviderCanSeeRequest(providerId, requestId)` (private → public).

- [ ] **Step 1: Failing test**

```ts
// apps/api/test/request-reports.spec.ts
import { ProviderStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApprovedRequest, createCategory, createDiscoverableProvider, createProviderProfile,
  createTestApp, createUser, loginAs, resetDatabase, type TestContext,
} from './harness';

let ctx: TestContext;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.app.close(); });
beforeEach(async () => { await resetDatabase(ctx.prisma); });

async function approvedProvider(categoryId: string) {
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, { categoryId, userId: user.id });
  return { provider, token: await loginAs(ctx.prisma, user.id) };
}
const reportUrl = (p: string, r: string) => `/providers/${p}/requests/${r}/reports`;

describe('provider request reports', () => {
  it('creates once, then 409; the detail shows only my own report', async () => {
    const category = await createCategory(ctx.prisma);
    const req = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    const { provider, token } = await approvedProvider(category.id);

    await request(ctx.server).post(reportUrl(provider.id, req.id)).set('Authorization', `Bearer ${token}`)
      .send({ reason: 'SPAM', note: 'Aynı metin üç kez açıldı' }).expect(201);
    const dup = await request(ctx.server).post(reportUrl(provider.id, req.id)).set('Authorization', `Bearer ${token}`)
      .send({ reason: 'OTHER' }).expect(409);
    expect(dup.body.code).toBe('REPORT_ALREADY_EXISTS');

    const detail = await request(ctx.server).get(`/providers/${provider.id}/requests/${req.id}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(detail.body.myReport).toMatchObject({ reason: 'SPAM' });
    expect(detail.body).not.toHaveProperty('reports');
    expect(detail.body).not.toHaveProperty('reportCount');

    const other = await approvedProvider(category.id);
    const otherDetail = await request(ctx.server).get(`/providers/${other.provider.id}/requests/${req.id}`).set('Authorization', `Bearer ${other.token}`).expect(200);
    expect(otherDetail.body.myReport).toBeNull();
  });

  it('does not hide the request: it stays listed and offerable after a report', async () => {
    const category = await createCategory(ctx.prisma, { offerCreditCost: 1 });
    const req = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    const { provider, token } = await approvedProvider(category.id);
    await request(ctx.server).post(reportUrl(provider.id, req.id)).set('Authorization', `Bearer ${token}`).send({ reason: 'SPAM' }).expect(201);
    const list = await request(ctx.server).get(`/providers/${provider.id}/requests`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(list.body.map((r: { id: string }) => r.id)).toContain(req.id);
  });

  it('refuses a request the provider cannot see with 404, and a non-approved provider with 403', async () => {
    const category = await createCategory(ctx.prisma);
    const elsewhere = await createCategory(ctx.prisma);
    const req = await createApprovedRequest(ctx.prisma, { categoryId: elsewhere.id });
    const { provider, token } = await approvedProvider(category.id);
    await request(ctx.server).post(reportUrl(provider.id, req.id)).set('Authorization', `Bearer ${token}`).send({ reason: 'SPAM' }).expect(404);

    const pendingUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const pending = await createProviderProfile(ctx.prisma, { userId: pendingUser.id, status: ProviderStatus.PENDING_REVIEW });
    const pendingToken = await loginAs(ctx.prisma, pendingUser.id);
    await request(ctx.server).post(reportUrl(pending.id, req.id)).set('Authorization', `Bearer ${pendingToken}`).send({ reason: 'SPAM' }).expect(403);
  });

  it('caps a provider at 20 reports per day', async () => {
    const category = await createCategory(ctx.prisma);
    const { provider, token } = await approvedProvider(category.id);
    for (let i = 0; i < 20; i += 1) {
      const req = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
      await request(ctx.server).post(reportUrl(provider.id, req.id)).set('Authorization', `Bearer ${token}`).send({ reason: 'SPAM' }).expect(201);
    }
    const extra = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    const res = await request(ctx.server).post(reportUrl(provider.id, extra.id)).set('Authorization', `Bearer ${token}`).send({ reason: 'SPAM' }).expect(429);
    expect(res.body.code).toBe('REPORT_RATE_LIMITED');
  });

  it('rejects a note over 500 code units', async () => {
    const category = await createCategory(ctx.prisma);
    const req = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    const { provider, token } = await approvedProvider(category.id);
    await request(ctx.server).post(reportUrl(provider.id, req.id)).set('Authorization', `Bearer ${token}`)
      .send({ reason: 'OTHER', note: 'x'.repeat(501) }).expect(400);
  });
});
```

- [ ] **Step 2: Run — fails.**

- [ ] **Step 3: Sabitler, DTO, servis, controller, modül**

```ts
// request-reports.constants.ts
export const REPORT_MAX_PER_PROVIDER_PER_DAY = 20;
export const REPORT_NOTE_MAX_LENGTH = 500;
export const REPORT_ALREADY_EXISTS_CODE = 'REPORT_ALREADY_EXISTS';
export const REPORT_RATE_LIMITED_CODE = 'REPORT_RATE_LIMITED';
```
```ts
// dto/create-request-report.dto.ts
import { ServiceRequestReportReason } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { MaxCodeUnitLength } from '../../../common/max-code-unit-length.validator';
import { REPORT_NOTE_MAX_LENGTH } from '../request-reports.constants';

export class CreateRequestReportDto {
  @IsEnum(ServiceRequestReportReason)
  reason!: ServiceRequestReportReason;

  @IsOptional()
  @IsString()
  @MaxCodeUnitLength(REPORT_NOTE_MAX_LENGTH)
  note?: string | null;
}
```
```ts
// request-reports.service.ts (provider half; admin half in Task 8)
import { ConflictException, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ProvidersService } from '../providers/providers.service';
import { CreateRequestReportDto } from './dto/create-request-report.dto';
import {
  REPORT_ALREADY_EXISTS_CODE, REPORT_MAX_PER_PROVIDER_PER_DAY, REPORT_RATE_LIMITED_CODE,
} from './request-reports.constants';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class RequestReportsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ProvidersService) private readonly providers: ProvidersService,
  ) {}

  /**
   * A provider may report exactly what they may see — the same predicate the
   * discovery screen and the offer path apply, so a report can never confirm
   * the existence of a request the caller was not shown.
   */
  async createForProvider(providerId: string, requestId: string, dto: CreateRequestReportDto) {
    await this.providers.ensureProviderCanSeeRequest(providerId, requestId);

    const since = new Date(Date.now() - DAY_MS);
    const today = await this.prisma.serviceRequestReport.count({
      where: { reporterProviderId: providerId, createdAt: { gte: since } },
    });
    if (today >= REPORT_MAX_PER_PROVIDER_PER_DAY) {
      throw new HttpException(
        { statusCode: HttpStatus.TOO_MANY_REQUESTS, error: 'Too Many Requests', code: REPORT_RATE_LIMITED_CODE, message: 'Günlük bildirim sınırına ulaştınız.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const note = dto.note?.trim() || null;
    try {
      const report = await this.prisma.serviceRequestReport.create({
        data: { requestId, reporterProviderId: providerId, reason: dto.reason, note },
        select: { id: true, reason: true, createdAt: true },
      });
      return report;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({
          statusCode: HttpStatus.CONFLICT, error: 'Conflict', code: REPORT_ALREADY_EXISTS_CODE,
          message: 'Bu talebi zaten bildirdiniz.',
        });
      }
      throw error;
    }
  }
}
```
```ts
// provider-request-reports.controller.ts
import { Body, Controller, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { ProviderAccessGuard } from '../auth/provider-access.guard';
import { CreateRequestReportDto } from './dto/create-request-report.dto';
import { RequestReportsService } from './request-reports.service';

@Controller('providers/:providerId/requests/:requestId/reports')
@UseGuards(AuthGuard, ProviderAccessGuard)
export class ProviderRequestReportsController {
  constructor(@Inject(RequestReportsService) private readonly reports: RequestReportsService) {}

  @Post()
  create(@Param('providerId') providerId: string, @Param('requestId') requestId: string, @Body() dto: CreateRequestReportDto) {
    return this.reports.createForProvider(providerId, requestId, dto);
  }
}
```
Modül: `imports: [PrismaModule, AuthModule, ProvidersModule]`, `providers: [RequestReportsService]`, `controllers: [ProviderRequestReportsController]`, `exports: [RequestReportsService]`. `ProvidersModule`'ün `ProvidersService`'i export ettiğini doğrula. `app.module.ts` imports'a ekle. `ensureProviderCanSeeRequest`'i `private` → public yap (JSDoc'a "also the report path's gate" notu).

- [ ] **Step 4: `myReport`**

`getMatchingRequest` include'una `reports: { where: { reporterProviderId: providerId }, select: { reason: true, createdAt: true }, take: 1 }`; `toProviderRequestDetail` dönüşüne `myReport: request.reports[0] ?? null` (tip tanımına `reports` ekle). Listeye eklenmez.

- [ ] **Step 5: Run — passes; Step 6: Commit** `feat(request-reports): hizmet veren talep bildirimi ucu ve günlük bütçe`.

---

### Task 8: Admin kuyruk, karar ve geri açma uçları + e-postalar + dashboard

**Files:**
- Create: `apps/api/src/modules/request-reports/admin-request-reports.controller.ts`, `dto/resolve-request-reports.dto.ts`, `request-report-copy.ts` (müşteriye dönük gerekçe sözlüğü)
- Modify: `request-reports.service.ts` (admin yarısı)
- Modify: `apps/api/src/modules/notifications/templates/transactional-templates.ts` (`request-removed`, `request-report-new-for-support` + subject/body), `transactional-mail.service.ts` (`sendRequestRemoved(requestId, resolvedAt)`, `sendRequestReportNewForSupport(reportId)`, `composeRetryMessage` case'leri, `RETRY_DEDUPE_PREFIXES`)
- Modify: `apps/api/src/modules/dashboard/dashboard.service.ts` (`openRequestReports`)
- Modify: `apps/api/src/modules/service-requests/service-requests.service.ts` (`reopenAfterRemoval`)
- Test: `apps/api/test/request-reports-admin.spec.ts`; `request-removal-refund.spec.ts`'e resolve yolu case'i

**Interfaces:**
- Produces:
  - `GET /service-requests/reports?state=open|resolved&cursor=<id>&limit=50` (SUPER_ADMIN) → `{ items: Array<{ request: { id, requestNumber, status, categoryName, city, district, descriptionExcerpt, submittedAt }, reportCount, reasons: ServiceRequestReportReason[], reporters: Array<{ id, businessName }>, firstReportedAt, lastResolution: { resolution, resolvedAt } | null, reopened: boolean }>, nextCursor: string | null }`
  - `GET /service-requests/:id/reports` → `Array<{ id, reason, note, createdAt, reporter: { id, businessName }, resolvedAt, resolution, resolutionNote, resolvedBy: { id, name } | null }>`
  - `POST /service-requests/:id/reports/resolve` body `{ resolution: 'DISMISSED' | 'REQUEST_REMOVED'; resolutionNote?: string; removalReason?: RemovalReasonKey }` (REQUEST_REMOVED için `removalReason` zorunlu) → talep projeksiyonu; hatalar `NO_OPEN_REPORTS` (409), `REQUEST_NOT_REMOVABLE` (409)
  - `POST /service-requests/:id/reopen` body `{ moderationNote?: string }` → talep projeksiyonu; hata `REQUEST_NOT_REOPENABLE` (409)
  - `RemovalReasonKey = 'SPAM' | 'FAKE_OR_TEST' | 'CONTAINS_CONTACT_INFO' | 'WRONG_CATEGORY' | 'INAPPROPRIATE_CONTENT' | 'DUPLICATE' | 'OTHER'` ve `REMOVAL_REASON_CUSTOMER_LABELS: Record<RemovalReasonKey, string>`
  - `dashboard.adminSummary().openRequestReports: number`
- Consumes: `ServiceRequestsService.rejectRequestInTransaction`, `updateServiceRequestStatus`, `readSupportInboxEmail()`, `adminRequestUrl` (`common/public-urls.ts`; yoksa mevcut admin URL yardımcısına bak).

- [ ] **Step 1: Failing tests**

```ts
// apps/api/test/request-reports-admin.spec.ts  (harness import'ları Task 7'deki gibi)
describe('admin report queue and decisions', () => {
  it('lists open reports grouped by request; DISMISSED closes all of them and keeps the request live', async () => {
    const category = await createCategory(ctx.prisma);
    const req = await createApprovedRequest(ctx.prisma, { categoryId: category.id, approvedAt: new Date() });
    const a = await approvedProvider(category.id);
    const b = await approvedProvider(category.id);
    await request(ctx.server).post(reportUrl(a.provider.id, req.id)).set('Authorization', `Bearer ${a.token}`).send({ reason: 'SPAM' }).expect(201);
    await request(ctx.server).post(reportUrl(b.provider.id, req.id)).set('Authorization', `Bearer ${b.token}`).send({ reason: 'WRONG_CATEGORY' }).expect(201);

    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const token = await loginAs(ctx.prisma, admin.id);
    const queue = await request(ctx.server).get('/service-requests/reports?state=open').set('Authorization', `Bearer ${token}`).expect(200);
    expect(queue.body.items).toHaveLength(1);
    expect(queue.body.items[0]).toMatchObject({ reportCount: 2, request: { id: req.id } });

    await request(ctx.server).post(`/service-requests/${req.id}/reports/resolve`).set('Authorization', `Bearer ${token}`)
      .send({ resolution: 'DISMISSED', resolutionNote: 'İçerik uygun' }).expect(201);
    const rows = await ctx.prisma.serviceRequestReport.findMany({ where: { requestId: req.id } });
    expect(rows.every((r) => r.resolution === 'DISMISSED' && r.resolvedByUserId === admin.id && r.resolvedAt)).toBe(true);
    expect((await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe('APPROVED');
    await request(ctx.server).post(`/service-requests/${req.id}/reports/resolve`).set('Authorization', `Bearer ${token}`)
      .send({ resolution: 'DISMISSED' }).expect(409);
  });

  it('REQUEST_REMOVED rejects the request, mails the customer, and reopen brings it back', async () => {
    const category = await createCategory(ctx.prisma);
    const req = await createApprovedRequest(ctx.prisma, { categoryId: category.id, approvedAt: new Date(), customerEmail: 'c@example.test' });
    const a = await approvedProvider(category.id);
    await request(ctx.server).post(reportUrl(a.provider.id, req.id)).set('Authorization', `Bearer ${a.token}`).send({ reason: 'CONTAINS_CONTACT_INFO' }).expect(201);
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const token = await loginAs(ctx.prisma, admin.id);

    await request(ctx.server).post(`/service-requests/${req.id}/reports/resolve`).set('Authorization', `Bearer ${token}`)
      .send({ resolution: 'REQUEST_REMOVED', removalReason: 'CONTAINS_CONTACT_INFO' }).expect(201);
    let row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.status).toBe('REJECTED');
    const mail = ctx.notifications.sent.find((m) => m.template === 'request-removed');
    expect(mail?.to).toBe('c@example.test');
    expect(mail?.data?.reasonLabel).toBe('Talep metninde iletişim bilgisi paylaşımı');
    expect(ctx.notifications.sent.some((m) => m.template === 'request-report-new-for-support')).toBe(true);

    await request(ctx.server).post(`/service-requests/${req.id}/reopen`).set('Authorization', `Bearer ${token}`).send({}).expect(201);
    row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.status).toBe('APPROVED');
    expect(row.rejectionReason).toBeNull();
    const queue = await request(ctx.server).get('/service-requests/reports?state=resolved').set('Authorization', `Bearer ${token}`).expect(200);
    expect(queue.body.items[0].reopened).toBe(true);
  });

  it('reopen refuses a request an operator rejected by hand', async () => {
    const category = await createCategory(ctx.prisma);
    const req = await createApprovedRequest(ctx.prisma, { categoryId: category.id, approvedAt: new Date() });
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const token = await loginAs(ctx.prisma, admin.id);
    await request(ctx.server).patch(`/service-requests/${req.id}/status`).set('Authorization', `Bearer ${token}`).send({ status: 'REJECTED', rejectionReason: 'x' }).expect(200);
    const res = await request(ctx.server).post(`/service-requests/${req.id}/reopen`).set('Authorization', `Bearer ${token}`).send({}).expect(409);
    expect(res.body.code).toBe('REQUEST_NOT_REOPENABLE');
  });

  it('a provider cannot reach the admin endpoints', async () => {
    const category = await createCategory(ctx.prisma);
    const { token } = await approvedProvider(category.id);
    await request(ctx.server).get('/service-requests/reports').set('Authorization', `Bearer ${token}`).expect(403);
  });
});
```
`request-removal-refund.spec.ts`'e: aynı görüntülenmiş/görüntülenmemiş iki teklif senaryosu, `rejectAsAdmin` yerine rapor + `resolve REQUEST_REMOVED` ile; ve `MATCHED` talepte `resolve` 409 `REQUEST_NOT_REMOVABLE`.

- [ ] **Step 2: Run — fails.**

- [ ] **Step 3: Gerekçe sözlüğü ve DTO**

```ts
// request-report-copy.ts
export const REMOVAL_REASON_KEYS = ['SPAM','FAKE_OR_TEST','CONTAINS_CONTACT_INFO','WRONG_CATEGORY','INAPPROPRIATE_CONTENT','DUPLICATE','OTHER'] as const;
export type RemovalReasonKey = (typeof REMOVAL_REASON_KEYS)[number];

/** What the customer is told. Never the reporter, never the operator's note. */
export const REMOVAL_REASON_CUSTOMER_LABELS: Record<RemovalReasonKey, string> = {
  SPAM: 'Talep içeriği platform kurallarına uygun bulunmadı',
  FAKE_OR_TEST: 'Talep gerçek bir hizmet ihtiyacı olarak değerlendirilemedi',
  CONTAINS_CONTACT_INFO: 'Talep metninde iletişim bilgisi paylaşımı',
  WRONG_CATEGORY: 'Talep seçilen hizmet kategorisine uygun değil',
  INAPPROPRIATE_CONTENT: 'Talep içeriği uygunsuz bulundu',
  DUPLICATE: 'Aynı hizmet için birden fazla talep açılmış',
  OTHER: 'Talep platform kurallarına uygun bulunmadı',
};
```
```ts
// dto/resolve-request-reports.dto.ts
import { ServiceRequestReportResolution } from '@prisma/client';
import { IsEnum, IsIn, IsOptional, IsString, ValidateIf } from 'class-validator';
import { MaxCodeUnitLength } from '../../../common/max-code-unit-length.validator';
import { REPORT_NOTE_MAX_LENGTH } from '../request-reports.constants';
import { REMOVAL_REASON_KEYS, RemovalReasonKey } from '../request-report-copy';

export class ResolveRequestReportsDto {
  @IsEnum(ServiceRequestReportResolution)
  resolution!: ServiceRequestReportResolution;

  @IsOptional() @IsString() @MaxCodeUnitLength(REPORT_NOTE_MAX_LENGTH)
  resolutionNote?: string | null;

  @ValidateIf((dto: ResolveRequestReportsDto) => dto.resolution === ServiceRequestReportResolution.REQUEST_REMOVED)
  @IsIn(REMOVAL_REASON_KEYS, { message: 'Talebi kaldırmak için gerekçe seçilmelidir.' })
  removalReason?: RemovalReasonKey;
}

export class ReopenRequestDto {
  @IsOptional() @IsString() @MaxCodeUnitLength(REPORT_NOTE_MAX_LENGTH)
  moderationNote?: string | null;
}
```

- [ ] **Step 4: Servis (admin yarısı)**

`RequestReportsService`'e `ServiceRequestsService`, `TransactionalMailService` inject et (`RequestReportsModule` imports'a `ServiceRequestsModule`; `NotificationsModule` global).

```ts
  async listForAdmin(state: 'open' | 'resolved', cursor: string | null, limit = 50) {
    const where: Prisma.ServiceRequestReportWhereInput =
      state === 'open' ? { resolvedAt: null } : { resolvedAt: { not: null } };
    // Group by request in SQL-free form: page over distinct requestIds ordered by first report.
    const grouped = await this.prisma.serviceRequestReport.groupBy({
      by: ['requestId'],
      where,
      _count: { _all: true },
      _min: { createdAt: true },
      orderBy: { _min: { createdAt: 'asc' } },
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { requestId: cursor } } : {}),
    });
    const page = grouped.slice(0, limit);
    const requestIds = page.map((g) => g.requestId);
    const [requests, reports] = await Promise.all([
      this.prisma.serviceRequest.findMany({
        where: { id: { in: requestIds } },
        select: { id: true, requestNumber: true, status: true, city: true, district: true, description: true, submittedAt: true, category: { select: { name: true } } },
      }),
      this.prisma.serviceRequestReport.findMany({
        where: { requestId: { in: requestIds }, ...where },
        orderBy: { createdAt: 'asc' },
        select: { requestId: true, reason: true, resolution: true, resolvedAt: true, reporter: { select: { id: true, businessName: true } } },
      }),
    ]);
    const byRequest = new Map(requests.map((r) => [r.id, r]));
    return {
      items: page.map((g) => {
        const req = byRequest.get(g.requestId)!;
        const own = reports.filter((r) => r.requestId === g.requestId);
        const last = own.filter((r) => r.resolvedAt).sort((a, b) => b.resolvedAt!.getTime() - a.resolvedAt!.getTime())[0] ?? null;
        return {
          request: {
            id: req.id, requestNumber: req.requestNumber, status: req.status, categoryName: req.category.name,
            city: req.city, district: req.district, submittedAt: req.submittedAt,
            descriptionExcerpt: (req.description ?? '').slice(0, 160),
          },
          reportCount: g._count._all,
          reasons: [...new Set(own.map((r) => r.reason))],
          reporters: [...new Map(own.map((r) => [r.reporter.id, r.reporter])).values()],
          firstReportedAt: g._min.createdAt,
          lastResolution: last ? { resolution: last.resolution, resolvedAt: last.resolvedAt } : null,
          // Derived, never stored: a request removed by a report and later reopened.
          reopened: last?.resolution === 'REQUEST_REMOVED' && req.status !== ServiceRequestStatus.REJECTED,
        };
      }),
      nextCursor: grouped.length > limit ? page[page.length - 1].requestId : null,
    };
  }

  async listForRequest(requestId: string) {
    return this.prisma.serviceRequestReport.findMany({
      where: { requestId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, reason: true, note: true, createdAt: true, resolvedAt: true, resolution: true, resolutionNote: true,
        reporter: { select: { id: true, businessName: true } },
        resolvedBy: { select: { id: true, name: true } },
      },
    });
  }

  async resolve(requestId: string, dto: ResolveRequestReportsDto, adminUserId: string) {
    const now = new Date();
    const outcome = await runSerializable(
      this.prisma,
      async (tx) => {
        const open = await tx.serviceRequestReport.count({ where: { requestId, resolvedAt: null } });
        if (open === 0) {
          throw new ConflictException({ statusCode: 409, error: 'Conflict', code: 'NO_OPEN_REPORTS', message: 'Bu talep için açık bildirim yok.' });
        }
        await tx.serviceRequestReport.updateMany({
          where: { requestId, resolvedAt: null },
          data: { resolvedAt: now, resolvedByUserId: adminUserId, resolution: dto.resolution, resolutionNote: dto.resolutionNote?.trim() || null },
        });
        if (dto.resolution === ServiceRequestReportResolution.REQUEST_REMOVED) {
          const reason = dto.removalReason!;
          await this.requests.rejectRequestInTransaction(tx, {
            requestId,
            rejectionReason: `Bildirim: ${REMOVAL_REASON_CUSTOMER_LABELS[reason]}`,
            moderationNote: dto.resolutionNote?.trim() || null,
            actorUserId: adminUserId,
            now,
          });
          return { removed: true as const, reason };
        }
        return { removed: false as const };
      },
      { label: 'requestReports.resolve' },
    );

    if (outcome.removed) {
      await this.notifySafely(() => this.mail.sendRequestRemoved(requestId, now, outcome.reason));
    }
    return this.requests.getServiceRequest(requestId);
  }
```
`notifySafely` = `ServiceRequestsService.notify` ile aynı try/log sarmalayıcı (kopyala; 6 satır). Provider ucundaki `createForProvider` commit sonrası `await this.notifySafely(() => this.mail.sendRequestReportNewForSupport(report.id))` ekle.

`ServiceRequestsService.reopenAfterRemoval(id, moderationNote, user)`:
```ts
  async reopenAfterRemoval(id: string, moderationNote: string | null, user: AuthUser) {
    const existing = await this.prisma.serviceRequest.findUnique({
      where: { id },
      select: { status: true, reports: { where: { resolution: ServiceRequestReportResolution.REQUEST_REMOVED }, select: { id: true }, take: 1 } },
    });
    if (!existing) throw new NotFoundException('Service request not found');
    if (existing.status !== ServiceRequestStatus.REJECTED || existing.reports.length === 0) {
      throw new ConflictException({ statusCode: 409, error: 'Conflict', code: 'REQUEST_NOT_REOPENABLE', message: 'Yalnızca bildirim sonucu kaldırılmış bir talep geri açılabilir.' });
    }
    // The ordinary approval, phone gate and fan-out included; CANCELLED offers stay closed.
    return this.updateServiceRequestStatus(id, { status: ServiceRequestStatus.APPROVED, moderationNote, rejectionReason: null }, user);
  }
```

- [ ] **Step 5: Controller**

```ts
@Controller('service-requests')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AdminRequestReportsController {
  constructor(
    @Inject(RequestReportsService) private readonly reports: RequestReportsService,
    @Inject(ServiceRequestsService) private readonly requests: ServiceRequestsService,
  ) {}

  @Get('reports')
  list(@Query('state') state?: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    const parsed = Number(limit);
    return this.reports.listForAdmin(state === 'resolved' ? 'resolved' : 'open', cursor ?? null, Number.isInteger(parsed) && parsed > 0 && parsed <= 100 ? parsed : 50);
  }

  @Get(':id/reports')
  listForRequest(@Param('id') id: string) { return this.reports.listForRequest(id); }

  @Post(':id/reports/resolve')
  resolve(@Param('id') id: string, @Body() dto: ResolveRequestReportsDto, @CurrentUser() user: AuthUser) {
    return this.reports.resolve(id, dto, user.id);
  }

  @Post(':id/reopen')
  reopen(@Param('id') id: string, @Body() dto: ReopenRequestDto, @CurrentUser() user: AuthUser) {
    return this.requests.reopenAfterRemoval(id, dto.moderationNote?.trim() || null, user);
  }
}
```
**Rota sırası:** `ServiceRequestsController`'daki `@Get(':id')` `reports`'u id sanmasın diye bu controller `app.module`/modül listesinde `ServiceRequestsModule`'den **önce** kaydedilmeli; ya da daha güvenlisi, `@Get('reports')`'u `ServiceRequestsController`'ın en üstüne (`@Get()`'ten hemen sonra) taşı ve servis çağrısını oradan yap. İkinci yolu seç: `ServiceRequestsController`'a `@Get('reports')` ekle, `AdminRequestReportsController` yalnız `:id/...` yollarını taşır.

- [ ] **Step 6: E-posta şablonları**

`transactional-templates.ts` listesine `'request-removed'`, `'request-report-new-for-support'`; subject: `'Talebiniz yayından kaldırıldı'`, `withSuffix('Yeni talep bildirimi', text(data.requestNumber))`. Gövde (`request-removed`): spec bölüm 5 metni; veri alanları `customerName, categoryName, requestNumber, reasonLabel, supportUrl, newRequestUrl`; şablon "Mevcut teklifler artık işleme alınamaz." cümlesini sabit taşır. `request-report-new-for-support`: `requestNumber, categoryName, reasonLabel (admin etiketi), adminRequestUrl` — not metni **yok**.
`transactional-mail.service.ts`:
```ts
  async sendRequestRemoved(requestId: string, resolvedAt: Date, reason: RemovalReasonKey) {
    const request = await loadRequest(this.prisma, requestId);
    if (!request?.customerEmail) return;
    await this.send('request-removed', request.customerEmail,
      { customerName: request.customerName, categoryName: request.category.name, requestNumber: request.requestNumber ?? request.id,
        reasonLabel: REMOVAL_REASON_CUSTOMER_LABELS[reason], supportUrl: supportUrl(), newRequestUrl: categoriesUrl() },
      { requestId: request.id, userId: request.customerId, dedupeKey: `request-removed:${request.id}:${resolvedAt.toISOString()}` });
  }

  async sendRequestReportNewForSupport(reportId: string) {
    const report = await this.prisma.serviceRequestReport.findUnique({
      where: { id: reportId },
      select: { id: true, reason: true, request: { select: { id: true, requestNumber: true, category: { select: { name: true } } } } },
    });
    if (!report) return;
    await this.send('request-report-new-for-support', readSupportInboxEmail(),
      { requestNumber: report.request.requestNumber ?? report.request.id, categoryName: report.request.category.name,
        reasonLabel: REPORT_REASON_ADMIN_LABELS[report.reason], adminRequestUrl: adminRequestUrl(report.request.id) },
      { requestId: report.request.id, dedupeKey: `request-report:${report.id}` });
  }
```
`REPORT_REASON_ADMIN_LABELS` `request-report-copy.ts`'e (`SPAM: 'Spam / anlamsız'`, `FAKE_OR_TEST: 'Sahte / deneme'`, `CONTAINS_CONTACT_INFO: 'İletişim bilgisi içeriyor'`, `WRONG_CATEGORY: 'Yanlış kategori'`, `INAPPROPRIATE_CONTENT: 'Uygunsuz içerik'`, `DUPLICATE: 'Mükerrer'`, `OTHER: 'Diğer'`). `supportUrl/categoriesUrl/adminRequestUrl` yardımcılarının adlarını `common/public-urls.ts`/`web-routes.ts`'ten doğrula. `composeRetryMessage`'a iki case ekle (`request-removed` → ids `[requestId]`, `reason` dedupeKey'de yok → talebin `rejectionReason`'ından `'Bildirim: '` önekini soyarak etiketi yeniden üret; eşleşmezse `OTHER`); `RETRY_DEDUPE_PREFIXES`'e ekle.

- [ ] **Step 7: Dashboard** — `adminSummary` Promise.all'a `this.prisma.serviceRequestReport.count({ where: { resolvedAt: null } })`, dönüşe `openRequestReports`. `test/admin-dashboard-summary.spec.ts`'e alanı ekle.

- [ ] **Step 8: Run — passes** (`request-reports-admin`, `request-removal-refund`, `admin-dashboard-summary`, `support-ticket-notifications`).
- [ ] **Step 9: Commit** `feat(request-reports): admin kuyruk, kararlar, geri açma; müşteri ve destek e-postaları`.

---

### Task 9: PII tespiti — açıklama, adres notu, serbest metin cevaplar

**Files:**
- Create: `packages/shared/contact-patterns.json`, `packages/shared/src/contact-detection.ts`, `packages/shared/src/contact-detection.spec.ts`
- Create: `apps/api/src/common/contact-detection.ts`, `apps/api/test/contact-detection.spec.ts`
- Modify: `packages/shared/src/index.ts` (export), `apps/api/src/modules/service-requests/service-requests.service.ts` (`createServiceRequest` normalize sonrası; `validateAnswerValue` TEXT/TEXTAREA)
- Test: `apps/api/test/request-contact-filter.spec.ts`

**Interfaces:**
- Produces: `detectContactDetails(text: string): { kind: 'phone' | 'email' | 'url'; match: string } | null` (shared ve api'de aynı imza), `CONTACT_DETAILS_IN_TEXT_CODE = 'CONTACT_DETAILS_IN_TEXT'`; API 400 gövdesi `{ code, field, kind, message }`.

- [ ] **Step 1: Failing tests** (shared + api aynı tablo; api testi `packages/shared/contact-patterns.json`'ı da okuyup iki uygulamanın aynı sonucu verdiğini doğrular)

```ts
const POSITIVE: Array<[string, 'phone' | 'email' | 'url']> = [
  ['Beni 0532 123 45 67 arayın', 'phone'],
  ['+90 (532) 123-45-67', 'phone'],
  ['5321234567 whatsapp', 'phone'],
  ['0212 555 44 33 sabit', 'phone'],
  ['mail: ali@example.com', 'email'],
  ['ali [at] example [dot] com', 'email'],
  ['ali (at) example.com', 'email'],
  ['https://example.com/ilan', 'url'],
  ['www.example.com', 'url'],
  ['wa.me/905321234567', 'url'],
  ['t.me/aliusta', 'url'],
  ['siteme bakın aliusta.com', 'url'],
];
const NEGATIVE = [
  'Bütçem 15000 TL', 'Tarih 12.03.2026', 'Posta kodu 34000', '10.000.000 TL üstü olmasın',
  'No: 12 Kat 3 Daire 7', '3+1 daire, 120 m2', 'IBAN son 4: 1234', 'Sabah 09:30 ile 12:00 arası',
  '@usta değil, sizinle konuşmak istiyorum', '2 oda 1 salon 85 m2 2018 yapımı',
];
```
`it.each(POSITIVE)` → `detectContactDetails(text)?.kind === kind`; `it.each(NEGATIVE)` → `null`.

```ts
// apps/api/test/request-contact-filter.spec.ts
it('refuses a description carrying a phone number, names the field, stores nothing', async () => {
  const category = await createCategory(ctx.prisma);
  const res = await request(ctx.server).post('/service-requests')
    .send(serviceRequestPayload(category.slug, { description: 'Acil, 0532 123 45 67 arayın' })).expect(400);
  expect(res.body).toMatchObject({ code: 'CONTACT_DETAILS_IN_TEXT', field: 'description', kind: 'phone' });
  expect(await ctx.prisma.serviceRequest.count()).toBe(0);
});
it('refuses an address note with an e-mail and a TEXT answer with a URL', ...)  // addressNote / answers: [{ questionKey, value }]
it('accepts a clean description', ...)  // 201
```

- [ ] **Step 2: Run — fails.**

- [ ] **Step 3: Desenler (JSON) ve tespit**

`packages/shared/contact-patterns.json`:
```json
{
  "phoneSeparators": "[\\s.\\-()]",
  "phoneRun": "\\+?[\\d\\s.\\-()]{10,20}",
  "phoneDigitsMin": 10,
  "phoneDigitsMax": 13,
  "phonePrefixes": ["0", "90", "5"],
  "email": "[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}",
  "emailObfuscated": "[^\\s]+\\s*[\\[(]\\s*at\\s*[\\])]\\s*[^\\s]+(\\s*[\\[(]\\s*(dot|nokta)\\s*[\\])]\\s*[^\\s]+)?",
  "url": "(https?://\\S+|\\bwww\\.\\S+|\\bwa\\.me/\\S*|\\bt\\.me/\\S*|\\b[a-z0-9-]+\\.(com|net|org|tr|io|me|co)\\b(/\\S*)?)"
}
```
`packages/shared/src/contact-detection.ts` ve `apps/api/src/common/contact-detection.ts` **aynı gövde** (api JSON'u `@taktic/shared/contact-patterns.json`'dan import eder; `limits.json` ile aynı gerekçe yorumu):
```ts
import patterns from '@taktic/shared/contact-patterns.json'; // shared tarafında: '../contact-patterns.json'

export type ContactDetailKind = 'phone' | 'email' | 'url';
export type ContactDetection = { kind: ContactDetailKind; match: string };

const phoneRun = new RegExp(patterns.phoneRun, 'g');
const separators = new RegExp(patterns.phoneSeparators, 'g');
const email = new RegExp(patterns.email, 'i');
const emailObfuscated = new RegExp(patterns.emailObfuscated, 'i');
const url = new RegExp(patterns.url, 'i');

/**
 * Finds the first thing in `text` that looks like a way to reach somebody
 * outside the platform. An obstacle, not a guarantee: a number spelled out in
 * words walks past it, and the provider's "Talebi bildir" is the second layer.
 */
export function detectContactDetails(text: string): ContactDetection | null {
  for (const candidate of text.match(phoneRun) ?? []) {
    const digits = candidate.replace(separators, '').replace(/^\+/, '');
    if (!/^\d+$/.test(digits)) continue;
    if (digits.length < patterns.phoneDigitsMin || digits.length > patterns.phoneDigitsMax) continue;
    if (!patterns.phonePrefixes.some((prefix) => digits.startsWith(prefix))) continue;
    return { kind: 'phone', match: candidate.trim() };
  }
  const mail = text.match(email) ?? text.match(emailObfuscated);
  if (mail) return { kind: 'email', match: mail[0] };
  const link = text.match(url);
  if (link) return { kind: 'url', match: link[0] };
  return null;
}
```
Not: `phoneRun` `{10,20}` karakter aralığı boşluklu yazımı yakalar; "10.000.000" → rakam 8 → geçer; "34000 12345" → `3` ile başlar → geçer; "0532…" → `0` → yakalanır. "09:30 ile 12:00" → `:` ayraç değil → parçalanır. NEGATIVE tablosuyla ayarla; `@usta` `url` desenine girmez.

- [ ] **Step 4: API'ye bağla**

`service-requests.service.ts`:
```ts
export const CONTACT_DETAILS_IN_TEXT_CODE = 'CONTACT_DETAILS_IN_TEXT';

function assertNoContactDetails(field: string, value: string | null) {
  if (!value) return;
  const found = detectContactDetails(value);
  if (found) {
    throw new BadRequestException({
      statusCode: HttpStatus.BAD_REQUEST, error: 'Bad Request', code: CONTACT_DETAILS_IN_TEXT_CODE, field, kind: found.kind,
      message: 'İletişim bilgisi (telefon, e-posta, bağlantı) paylaşılamaz; bilgiler teklif kabul edildiğinde otomatik paylaşılır.',
    });
  }
}
```
`requestData` oluşturulduktan hemen sonra: `assertNoContactDetails('description', requestData.description); assertNoContactDetails('addressNote', requestData.addressNote);`. `validateAnswerValue`'da `TEXT`/`TEXTAREA` (enum adlarını `ServiceRequestQuestionType`'tan doğrula) dalında `assertNoContactDetails(\`answers.${question.key}\`, value)`. Vitrin lead aynı `createServiceRequest`'ten geçtiği için otomatik kapsanır.

- [ ] **Step 5: Run — passes** (`pnpm --filter @taktic/shared test` + api). **Step 6: Commit** `feat: talep metinlerinde iletişim bilgisi engeli (shared JSON desenleri, api + form)`.

---

### Task 10: Talep oluşturma hız sınırları

**Files:**
- Create: `apps/api/src/modules/service-requests/service-requests.constants.ts`, `service-request.throttler.ts`
- Modify: `apps/api/src/modules/auth/auth.module.ts:48-51` (üçüncü named throttler), `service-requests.controller.ts` (`@UseGuards(ServiceRequestThrottlerGuard, OptionalAuthGuard)` `@Post()`), `service-requests.module.ts` (provider), `service-requests.service.ts` (tx içi sayımlar)
- Test: `apps/api/test/service-request-rate-limit.spec.ts`

**Interfaces:** `SERVICE_REQUEST_THROTTLE_LIMIT = 5`, `SERVICE_REQUEST_THROTTLE_TTL_MS = 10 * 60 * 1000`, `SERVICE_REQUEST_MAX_PER_PHONE_PER_DAY = 5`, `SERVICE_REQUEST_MAX_OPEN_PER_PHONE = 10`, kod `REQUEST_RATE_LIMITED` (429).

- [ ] **Step 1: Failing test** — `resetAuthThrottle(ctx.app)` ile başla; aynı IP'den 6. `POST /service-requests` → 429; farklı payload ama aynı `customerPhone` ile 24 saat içinde 6. talep → 429 `REQUEST_RATE_LIMITED` (throttle'ı her istekte `resetAuthThrottle` ile temizle ki IP sınırı karışmasın); 10 açık `APPROVED` talep (DB'ye doğrudan `createApprovedRequest` ile aynı telefon) sonra 11. → 429.
- [ ] **Step 2: Run — fails.**
- [ ] **Step 3: Throttler** — `RequestDraftThrottlerGuard`'ın birebir kopyası, `throttlerName = 'service-requests'`; `auth.module.ts` `forRoot` dizisine `{ name: 'service-requests', ttl: SERVICE_REQUEST_THROTTLE_TTL_MS, limit: SERVICE_REQUEST_THROTTLE_LIMIT }`. `AuthThrottlerGuard`'daki `onModuleInit` daraltması sayesinde diğer guard'lar bu bütçeyi görmez (yorumu oku).
- [ ] **Step 4: Tx içi sayımlar** — `createServiceRequest` `runSerializable` içinde, `resolveCustomerForCreate` öncesi:
```ts
      const phoneWindowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const [recent, open] = await Promise.all([
        tx.serviceRequest.count({ where: { customerPhone: requestData.customerPhone, submittedAt: { gte: phoneWindowStart }, status: { in: [ServiceRequestStatus.SUBMITTED, ServiceRequestStatus.APPROVED] } } }),
        tx.serviceRequest.count({ where: { customerPhone: requestData.customerPhone, status: ServiceRequestStatus.APPROVED } }),
      ]);
      if (recent >= SERVICE_REQUEST_MAX_PER_PHONE_PER_DAY || open >= SERVICE_REQUEST_MAX_OPEN_PER_PHONE) {
        throw new HttpException(
          { statusCode: 429, error: 'Too Many Requests', code: 'REQUEST_RATE_LIMITED', message: 'Bu telefon numarasıyla kısa sürede çok fazla talep açıldı. Lütfen daha sonra tekrar deneyin.' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
```
Oturumlu müşteri için `customerPhone` zaten hesap telefonu → aynı sayım kullanıcıyı kapsar.
- [ ] **Step 5: Run — passes** (+ `auth-rate-limit.spec.ts`, `request-identity-gate` spec'leri). **Step 6: Commit** `feat(service-requests): IP, telefon ve açık talep hız sınırları`.

---

### Task 11: Web (müşteri + hizmet veren) ekranları

**Files:**
- Modify: `apps/web/lib/api.ts` (`ProviderRequestDetail.myReport`, `ProviderOffer.closureNotice`, `ProviderOffer.cancelledAt`, `RequestReportReason`)
- Create: `apps/web/app/providers/[id]/requests/[requestId]/report-dialog.tsx`; Modify: `actions.ts` (`reportRequestAction`), `page.tsx` (düğme + rozet)
- Modify: `apps/web/app/providers/[id]/vitrin/talepler/[leadId]/page.tsx` (aynı dialog, `requestId` ile)
- Modify: `apps/web/app/providers/[id]/offers/[offerId]/page.tsx`, `apps/web/app/providers/[id]/offers/page.tsx` (`closureNotice`)
- Modify: `apps/web/app/requests/[id]/offers/offers-view.tsx` (`CANCELLED` teklif salt okunur: "Talep kaldırıldığı için kapatıldı")
- Modify: `apps/web/app/requests/success/page.tsx` (`?published=1` ise "Talebiniz yayında"), `apps/web/app/categories/[slug]/request-form.tsx` (submit sonrası `status === 'APPROVED'` → `published=1`; `CONTACT_DETAILS_IN_TEXT` hatasını alan altında göster; `detectContactDetails` ile anlık uyarı)
- Test: `apps/web/test/*` mevcut vitest kurulumuna `contact-detection` kullanan bir bileşen testi gerekmiyor; davranış E2E'de (Task 13).

- [ ] **Step 1: Tipler** — `RequestReportReason` union + `REQUEST_REPORT_REASON_LABELS` (provider'a dönük: `SPAM: 'Spam veya anlamsız içerik'`, `FAKE_OR_TEST: 'Gerçek bir iş değil / deneme'`, `CONTAINS_CONTACT_INFO: 'İletişim bilgisi içeriyor'`, `WRONG_CATEGORY: 'Yanlış kategori'`, `INAPPROPRIATE_CONTENT: 'Uygunsuz içerik'`, `DUPLICATE: 'Aynı iş için tekrar talep'`, `OTHER: 'Diğer'`).
- [ ] **Step 2: Server action**
```ts
export async function reportRequestAction(formData: FormData) {
  const providerId = readFormString(formData, 'providerId');
  const requestId = readFormString(formData, 'requestId');
  const base = `/providers/${providerId}/requests/${requestId}`;
  try {
    await apiFetch(`${base}/reports`, {
      method: 'POST',
      body: JSON.stringify({ reason: readFormString(formData, 'reason'), note: readOptionalFormString(formData, 'note') }),
    });
  } catch (error) {
    const code = asOfferConflict(error)?.code ?? apiErrorCode(error);
    if (code === 'REPORT_ALREADY_EXISTS') redirect(`${base}?reportError=exists`);
    if (code === 'REPORT_RATE_LIMITED') redirect(`${base}?reportError=limit`);
    throw error;
  }
  revalidatePath(base);
  redirect(`${base}?reported=1`);
}
```
(`apiErrorCode`: `ApiError` gövdesinden `code` okuyan 8 satırlık yardımcı; 429 için `asOfferConflict` 409'a bağlı olduğundan gerekli.)
- [ ] **Step 3: Dialog** — `'use client'`, `<dialog>` + `useRef`, `ModerationDialog` (admin) deseniyle; `data-testid="report-request-button"`, `report-reason`, `report-note`, `report-submit`; sayfa: `request.myReport ? <p data-testid="report-received">Bildiriminiz alındı · {formatDateTime(myReport.createdAt)}</p> : <ReportDialog … />`; `searchParams.reportError` → `role="alert"` metinleri ("Bu talebi zaten bildirdiniz." / "Günlük bildirim sınırına ulaştınız."); `reported=1` → "Bildiriminiz alındı, ekibimiz inceleyecek." (`data-testid="report-received"`).
- [ ] **Step 4: Teklif ekranları** — `closureNotice` doluysa teklif detayında `<div className="pdash-notice" data-testid="offer-closure-notice">{closureNotice}</div>`; refund badge alanı `ALREADY_REFUNDED` etiketini zaten gösterir. Liste satırında `status === 'CANCELLED'` → rozet "Kapatıldı".
- [ ] **Step 5: Müşteri tarafı** — `offers-view.tsx`: `offer.status === 'CANCELLED'` ise aksiyon düğmeleri gizli, satırda "Talep kaldırıldığı için kapatıldı". `requests-board.tsx` değişmez. Başarı sayfası: `searchParams.published === '1'` → kicker "Talebiniz yayında", başlık "Talebiniz uygun hizmet verenlere iletildi", alt metin "Talebiniz 14 gün boyunca teklif alır." (`data-testid="request-success-title"`); aksi hâlde mevcut metin. Form: API yanıtındaki `status`'a göre `published` parametresi; `CONTACT_DETAILS_IN_TEXT` → `field`'a göre alan altında `role="alert"` `data-testid="contact-details-error"`; `DescriptionField`'a `onChange` içinde `detectContactDetails` (shared) ile anlık "İletişim bilgisi paylaşılamaz" ipucu (bloklamaz; sunucu kural).
- [ ] **Step 6: `pnpm --filter @taktic/web typecheck && pnpm --filter @taktic/web build`** geçer. **Step 7: Commit** `feat(web): Talebi bildir, kapatılan teklif metinleri, yayında başarı sayfası, iletişim bilgisi uyarısı`.

---

### Task 12: Admin ekranları

**Files:**
- Modify: `apps/admin/lib/api.ts` (tipler: `RequestReportQueueItem`, `RequestReport`, `MarketplacePublishSettings`, `ServiceRequest.status` değişmez), `apps/admin/lib/nav.ts` (Operasyon › `{ href: '/requests/reports', label: 'Talep bildirimleri' }` — `/requests` satırından sonra)
- Create: `apps/admin/app/requests/reports/page.tsx`
- Modify: `apps/admin/app/requests/[id]/page.tsx` (Bildirimler bölümü + üç karar), `apps/admin/app/requests/actions.ts` (`resolveReportsAction`, `reopenRequestAction`)
- Modify: `apps/admin/app/requests/page.tsx` (SUBMITTED filtre açıklaması), `apps/admin/app/page.tsx` + `lib/dashboard-metrics.ts` (stat kartı "Açık talep bildirimi")
- Modify: `apps/admin/app/operations-settings/page.tsx`, `actions.ts` (`toggleAutoPublishAction`), `scheduler-toggle.tsx`'i genelleştirmek yerine `auto-publish-toggle.tsx` (aynı gövde, farklı action)

- [ ] **Step 1: Actions**
```ts
export async function resolveReportsAction(formData: FormData) {
  const id = readFormString(formData, 'id');
  const resolution = readFormString(formData, 'resolution');
  try {
    await apiFetch<ServiceRequest>(`/service-requests/${id}/reports/resolve`, {
      method: 'POST',
      body: JSON.stringify({
        resolution,
        resolutionNote: readOptionalFormString(formData, 'resolutionNote'),
        removalReason: resolution === 'REQUEST_REMOVED' ? readOptionalFormString(formData, 'removalReason') : undefined,
      }),
    });
  } catch (error) {
    const code = conflictCode(error);
    if (code === 'REQUEST_NOT_REMOVABLE') redirect(`/requests/${id}?reportError=notRemovable`);
    if (code === 'NO_OPEN_REPORTS') redirect(`/requests/${id}?reportError=noOpen`);
    throw error;
  }
  revalidatePath('/requests/reports'); revalidatePath(`/requests/${id}`); revalidatePath('/requests');
}
export async function reopenRequestAction(formData: FormData) {
  const id = readFormString(formData, 'id');
  try {
    await apiFetch<ServiceRequest>(`/service-requests/${id}/reopen`, { method: 'POST', body: JSON.stringify({ moderationNote: readOptionalFormString(formData, 'moderationNote') }) });
  } catch (error) {
    if (conflictCode(error) === 'PHONE_NOT_VERIFIED') redirect(`/requests/${id}?statusError=phoneNotVerified`);
    if (conflictCode(error) === 'REQUEST_NOT_REOPENABLE') redirect(`/requests/${id}?reportError=notReopenable`);
    throw error;
  }
  revalidatePath('/requests/reports'); revalidatePath(`/requests/${id}`); revalidatePath('/requests');
}
```
- [ ] **Step 2: Kuyruk sayfası** — `apiFetch<RequestReportQueue>('/service-requests/reports?state=' + state)`; sekmeler (`?state=open|resolved`); tablo sütunları: Talep (`requestNumber` → `/requests/[id]` linki), Kategori, Konum, Durum rozeti (`statusBadgeClass`), İlk bildirim, Rapor sayısı (`data-testid="report-count"`), Nedenler (rozet), Bildirenler (`/providers/[id]` link), Açıklama özeti; `reopened` → "Kaldırıldı → geri açıldı" etiketi; boş → `EmptyState`. `PageHeader` + `Breadcrumbs` mevcut bileşenler.
- [ ] **Step 3: Talep detayı "Bildirimler" bölümü** — `apiFetch<RequestReport[]>(`/service-requests/${id}/reports`)` paralel; `SectionCard` içinde liste (neden etiketi, not, işletme linki, zaman, çözüm/çözen). Açık rapor varsa: form A "Uygun bulundu" (`resolution=DISMISSED`, not alanı) `data-testid="report-dismiss"`; form B `<details>` "Talebi kaldır": `removalReason` `<select required>` (7 gerekçe, müşteri etiketi yanında gösterilir), not, buton `data-testid="report-remove"`, `disabled={!['APPROVED','IN_REVIEW','SUBMITTED'].includes(request.status)}` ipucu "Eşleşmiş talep için 'İptal et' kullanın."; `request.status === 'REJECTED' && reports.some(r => r.resolution === 'REQUEST_REMOVED')` → form C "Talebi geri aç" `data-testid="report-reopen"` + not "Kapatılan teklifler geri açılmaz; iadeler geri alınmaz." `reportError` → `role="alert"`. Mevcut "Reddet" formunun açıklamasına "Reddetme, aktif teklifleri kapatır ve harcanan kredileri iade eder." cümlesi.
- [ ] **Step 4: Dashboard + liste** — `openRequestReports` stat kartı (`/requests/reports` linki); `/requests` SUBMITTED filtresi üstüne `<p className="admin-hint">` metni (spec 2.5).
- [ ] **Step 5: Operasyon ayarları** — `apiFetch<MarketplacePublishSettings>('/operations-settings/marketplace-publish')`; yeni kart `#otomatik-yayin` "Pazar talepleri otomatik yayınlansın": açıklama "Açıkken yeni talepler moderasyon beklemeden eşleşen hizmet verenlere iletilir; kapalıyken bugünkü onay akışı sürer.", `AutoPublishToggle` (`role="switch"`, `data-testid="auto-publish-toggle"`), son değişiklikler listesi; `toggleAutoPublishAction` `toggleSchedulerAction`'ın kopyası, URL `/operations-settings/marketplace-publish`.
- [ ] **Step 6: `pnpm --filter @taktic/admin typecheck && build`**. **Step 7: Commit** `feat(admin): talep bildirimi kuyruğu ve kararları, otomatik yayın anahtarı, dashboard sayacı`.

---

### Task 13: E2E senaryoları (Chromium + WebKit)

**Files:**
- Create: `e2e/tests/request-auto-publish.spec.ts`, `e2e/tests/request-report-flow.spec.ts`, `e2e/tests/request-contact-filter.spec.ts`
- Modify: `e2e/src/journeys.ts` (`enableAutoPublish(admin)`, `reportRequest(provider, providerId, requestId, reason)`, `resolveReports(admin, requestId, 'DISMISSED' | 'REQUEST_REMOVED')`, `reopenRequest(admin, requestId)`)
- Modify: `e2e/src/fixtures.ts` (`setAutoPublish(enabled)` doğrudan Prisma ile; `openReportCount()`)

- [ ] **Step 1: Yardımcılar**
```ts
export async function enableAutoPublish(admin: Actor): Promise<void> {
  await admin.gotoAdmin('/operations-settings');
  const toggle = admin.page.getByTestId('auto-publish-toggle');
  if ((await toggle.getAttribute('aria-checked')) !== 'true') {
    await toggle.click();
    await expect(admin.page.getByTestId('auto-publish-toggle')).toHaveAttribute('aria-checked', 'true');
  }
}
export async function reportRequest(provider: Actor, providerId: string, requestId: string, reason: string): Promise<void> {
  await openRequestAsProvider(provider, providerId, requestId);
  await provider.page.getByTestId('report-request-button').click();
  await provider.page.getByTestId('report-reason').selectOption(reason);
  await provider.page.getByTestId('report-submit').click();
  await expect(provider.page.getByTestId('report-received')).toBeVisible();
  await assertNoErrorScreen(provider.page);
}
export async function resolveReports(admin: Actor, requestId: string, resolution: 'DISMISSED' | 'REQUEST_REMOVED'): Promise<void> {
  await admin.gotoAdmin(`/requests/${requestId}`);
  if (resolution === 'DISMISSED') {
    await admin.page.getByTestId('report-dismiss').click();
  } else {
    await admin.page.getByRole('group', { name: 'Talebi kaldır' }).locator('select[name="removalReason"]').selectOption('SPAM');
    await admin.page.getByTestId('report-remove').click();
  }
  await assertNoErrorScreen(admin.page);
}
```
- [ ] **Step 2: `request-auto-publish.spec.ts`** — `createAdmin`, `createCategory`, `createProvider({credits: 10})`, `createCustomer`; admin `enableAutoPublish`; müşteri `createRequest` → başarı başlığı `request-success-title` "Talebiniz uygun hizmet verenlere iletildi"; **admin'e dokunmadan** `matchingRequestIds(provider)` talebi içerir; `submitOffer`; müşteri `/requests/[id]/offers` teklifi görür. `urgency: 'URGENT'` (form değerini `requestFormValues`/`urgency.ts`'ten doğrula) varyantı aynı.
- [ ] **Step 3: `request-report-flow.spec.ts`** — iki provider (A, B) teklif verir (`submitOffer`), `creditBalance` düşer; A `reportRequest(..., 'SPAM')`; admin `/requests/reports` satırı `report-count` "1"; `resolveReports(DISMISSED)` → A listede talebi hâlâ görür. İkinci test: rapor → `resolveReports(REQUEST_REMOVED)` → `matchingRequestIds` içermez; `openRequestAsProvider` 404 (`expectNotFoundScreen`); A teklif detayında `offer-closure-notice` "Talep yayından kaldırıldı. Harcanan teklif krediniz iade edildi."; `creditBalance(A) === 10`, `countRefundTransactions(A) === 1` (B için de); müşteri `/requests/my` "Reddedildi"; `emailCountFor(customer.email, 'request-removed') === 1`; admin `report-reopen` → `matchingRequestIds` yeniden içerir, A'nın teklifi hâlâ "Kapatıldı".
- [ ] **Step 4: `request-contact-filter.spec.ts`** — açıklamaya "0532 123 45 67" → `contact-details-error` görünür, URL `/requests/success`'e gitmez; temiz metinle `createRequest` başarılı.
- [ ] **Step 5: Mevcut spec'ler** — `marketplace-journey.spec.ts`, `hero-request-demo.spec.ts`, `phone-verification-gate.spec.ts` `approveRequest` çağrılarını korur (anahtar default kapalı). `request-identity-gate.spec.ts` başarı başlığı assertion'ı varsa `published` olmayan metni beklemeye devam eder.
- [ ] **Step 6: Run** — `pnpm e2e request-auto-publish request-report-flow request-contact-filter` ve `pnpm e2e:webkit request-auto-publish request-report-flow request-contact-filter`; ardından tam `pnpm e2e`. WebKit'te `role="alert"` route-announcer çakışması için `getByTestId` kullanıldı.
- [ ] **Step 7: Commit** `test(e2e): anında yayın, talep bildirimi akışı ve iletişim bilgisi filtresi (chromium + webkit)`.

---

### Task 14: Migration dry-run, tam doğrulama, teslim raporu

**Files:**
- Create: `docs/superpowers/plans/2026-09-14-request-auto-publish-migration-dryrun.txt`
- Create: `docs/superpowers/plans/2026-09-14-request-auto-publish-teslim-raporu.md`

- [ ] **Step 1: Dry-run** — Aktif yerel DB'den `pg_dump` → `taktic_autopublish_dryrun`; öncesi parmak izi:
```sql
SELECT 'ServiceRequest', count(*), md5(string_agg(id||'|'||status||'|'||coalesce("approvedAt"::text,'')||'|'||coalesce("moderatedAt"::text,''), ',' ORDER BY id)) FROM "ServiceRequest"
UNION ALL SELECT 'Offer', count(*), md5(string_agg(id||'|'||status||'|'||coalesce("creditRefundedTransactionId",''), ',' ORDER BY id)) FROM "Offer"
UNION ALL SELECT 'ProviderCreditTransaction', count(*), md5(string_agg(id||'|'||type||'|'||amount, ',' ORDER BY id)) FROM "ProviderCreditTransaction"
UNION ALL SELECT 'ShowcaseLead', count(*), md5(string_agg(id||'|'||status, ',' ORDER BY id)) FROM "ShowcaseLead"
UNION ALL SELECT 'NotificationLog', count(*), md5(string_agg(id||'|'||status, ',' ORDER BY id)) FROM "NotificationLog"
UNION ALL SELECT 'OperationsSettings', count(*), md5(string_agg(id, ',' ORDER BY id)) FROM "OperationsSettings";
SELECT status, count(*) FROM "ServiceRequest" GROUP BY 1 ORDER BY 1;
```
`DATABASE_URL=<dryrun> pnpm exec prisma migrate deploy`; sonrası aynı sorgular → **aynı** değerler; `marketplaceAutoPublishEnabled` tüm satırlarda false, `Offer.cancelledAt` tümü NULL, `ServiceRequestReport` boş; dry-run DB DROP. Sonuçları txt'ye repo formatında yaz (bkz. `2026-09-12-vitrin-notify-migration-dryrun.txt`).
- [ ] **Step 2: Tam doğrulama** — `pnpm typecheck && pnpm build && pnpm --filter @taktic/api test && pnpm --filter @taktic/shared test && pnpm e2e && pnpm e2e:webkit`; çıktıları rapora.
- [ ] **Step 3: Teslim raporu** — spec bölüm 7.4 kabul kriterlerini madde madde kanıtla (test adları, dry-run özeti, ekran görüntüsü yolları `docs/superpowers/plans/2026-09-14-request-auto-publish-screens/`).
- [ ] **Step 4: Commit** `docs: anında yayın + talep bildirimi migration dry-run ve teslim raporu`.

---

## Self-review notları

- **Spec kapsamı:** 2.1 → T2; 2.2/2.3/2.4 → T3, T4; 2.5 → T12 (metin); 2.6 → T5; 3.1 → T1; 3.2 → T7; 3.3 → T11, T12; 3.4/3.5 → T7, T8; 3.5.1/3.5.2 → T6; 3.6 → T6, T11; 4.1 → T4; 4.2 → T10; 4.3 → T9; 4.4 → T7 (404/bütçe/unique); 5 → T8, T12; 6 → T1, T14; 7 → T1–T14 testleri.
- **Tip tutarlılığı:** `publishRequestInTransaction(tx, requestId, now)` T4/T5; `rejectRequestInTransaction(tx, {requestId, rejectionReason, moderationNote, actorUserId, now})` T6/T8; `RequestPublishOutbox.enqueue(tx, requestId, approvedAt)` + `deliverSoon()` T3/T4/T5; `closureNotice` T6/T11; `myReport` T7/T11; `REMOVAL_REASON_CUSTOMER_LABELS` T8/T12.
- **Sıra bağımlılığı:** T4 T2+T3'e, T5 T4'e, T8 T6+T7'ye, T11/T12 T7+T8'e, T13 T11+T12'ye bağlı; T9 ve T10 bağımsız (T4'ten sonra herhangi bir sırada).
- **Rota çakışması** (`/service-requests/reports` vs `:id`) T8 Step 5'te çözüldü.
- **`forwardRef`** döngüsü (PhoneVerification ↔ ServiceRequests) T4 Step 5'te; uygulayıcı `ServiceRequestsModule`'ün `PhoneVerificationModule`'ü import edip etmediğini kontrol etmeli; etmiyorsa `forwardRef` gerekmez.
