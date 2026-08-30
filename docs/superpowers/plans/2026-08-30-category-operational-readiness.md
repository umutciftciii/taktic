# Kategori Operasyonel Hazırlık Durumu ve Hizmet Veren Kaydı — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kategori için veritabanına yazılmayan bir arz durumu (`supplyStatus`) türet ve adminin bilinçli olarak açtığı taslak hizmetlere hizmet verenlerin kendi kendine kaydolmasını mümkün kıl.

**Architecture:** İki saf kural fonksiyonu (`resolveCategorySupplyStatus`, `isProviderEnrollmentOpen`) tüm mantığı taşır; servisler onları çağırır, ekranlar sunucudan gelen değeri gösterir. Tek additive kolon `ServiceCategory.providerEnrollmentOpen`. `supplyStatus` yalnız operatör projeksiyonunda döner; hizmet veren kayıt kataloğu ayrı ve dar bir uçtur.

**Tech Stack:** NestJS + Prisma (PostgreSQL), Next.js App Router (admin ve web), Vitest + supertest (API), Playwright (e2e), pnpm + turbo monorepo.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-30-category-operational-readiness-design.md`. Çelişki hâlinde spec kazanır.
- Testler `DATABASE_URL` kabukta tanımlı olmadan koşmaz. Her test komutundan önce:
  `export $(grep -E '^(DATABASE_URL|AUTH_COOKIE_NAME)=' .env | xargs)`
- Kullanıcıya dönük tüm metinler Türkçe.
- `supplyStatus`, `approvedProviderCount`, `_count.providers` ve hazırlık metni **asla** public kategori, public provider veya müşteri yanıtlarında yer almaz.
- `includeInactive` güvenlik kuralı (`assertElevatedQueryAccess` + `resolveIncludeInactive`) aynen korunur.
- Public/müşteri kategori API'si (`GET /categories`, `GET /categories/:slug` yetkisiz yol) hiç değişmez.
- Yeni kolon varsayılanı `false`. Migration additive; DROP yok.
- Gerçek dev veritabanında import, provider atama, kategori aktivasyonu, davet veya e-posta **çalıştırılmaz**.
- Push, PR, merge, deploy, container recreate **yapılmaz**.
- Mevcut testler korunur: `category-taxonomy-rules`, `category-visibility`, `provider-draft-category-binding`, `provider-invite-links`, `wave-1-release-readiness`, `category-import-seed`, `category-import-wave-2`, ve e2e `category-release-readiness`, `provider-draft-category-binding`, `category-wave-2-drafts`.

## Dosya haritası

**Yeni:**
- `apps/api/src/modules/categories/category-supply-status.ts` — türetilmiş arz durumu, saf.
- `apps/api/test/category-supply-status.spec.ts` — arz durumu ve enrollment matrisleri, veritabanısız.
- `apps/api/test/category-provider-enrollment.spec.ts` — enrollment kapısı, yazma kuralı, kayıt kataloğu ucu, sızıntı.
- `apps/api/test/category-supply-status-projection.spec.ts` — `supplyStatus` operatör projeksiyonunda, geçişler, sızıntı, DRAFT kapalılığı.
- `prisma/migrations/20260830120000_add_provider_enrollment_open/migration.sql`
- `e2e/tests/category-supply-status.spec.ts`
- `e2e/tests/provider-enrollment-self-service.spec.ts`

**Değişecek:**
- `prisma/schema.prisma` — `ServiceCategory.providerEnrollmentOpen`
- `prisma/import-draft-categories.ts`, `prisma/import-draft-categories-wave-2.ts`
- `apps/api/src/modules/categories/category-taxonomy.ts` — `isProviderEnrollmentOpen`, `providerEnrollmentCategoryWhere`, `canBeSelectedByProviders`
- `apps/api/src/modules/categories/categories.service.ts` — `supplyStatus`, kayıt kataloğu, yazma kuralı
- `apps/api/src/modules/categories/categories.controller.ts` — `GET /categories/provider-enrollment`
- `apps/api/src/modules/categories/dto/create-category.dto.ts`, `dto/update-category.dto.ts`
- `apps/api/src/modules/providers/providers.service.ts` — seçim kapısı, `updateProvider` silme filtresi, `upcomingServiceCategories`
- `apps/api/test/harness.ts` — `createCategory` fixture'ına `providerEnrollmentOpen`
- `apps/admin/lib/api.ts`, `apps/admin/app/categories/category-taxonomy.ts`, `apps/admin/app/categories/page.tsx`, `apps/admin/app/categories/[slug]/page.tsx`, kategori formu
- `apps/web/lib/api.ts`, `apps/web/app/providers/register/page.tsx`, `apps/web/app/providers/[id]/edit/page.tsx`, `apps/web/app/providers/[id]/page.tsx`
- `e2e/src/fixtures.ts` — `createCategory` fixture'ına `providerEnrollmentOpen`

---

### Task 1: Kolon, migration ve import tanımları

**Files:**
- Modify: `prisma/schema.prisma` (`model ServiceCategory`)
- Create: `prisma/migrations/20260830120000_add_provider_enrollment_open/migration.sql`
- Modify: `prisma/import-draft-categories.ts`, `prisma/import-draft-categories-wave-2.ts`
- Modify: `apps/api/test/harness.ts` (`createCategory`)
- Modify: `e2e/src/fixtures.ts` (`createCategory`)

**Interfaces:**
- Consumes: yok (ilk görev).
- Produces: `ServiceCategory.providerEnrollmentOpen: boolean` kolonu; test fixture'larında `providerEnrollmentOpen?: boolean` seçeneği.

- [ ] **Step 1: Şemaya kolonu ekle**

`prisma/schema.prisma` içinde `model ServiceCategory`, `status` satırının hemen altına:

```prisma
  /// Whether a provider may put this category in their own service list.
  ///
  /// Only ever consulted for a DRAFT leaf. An ACTIVE leaf is always open — see
  /// isProviderEnrollmentOpen — because closing a live category to provider
  /// selection breaks every existing profile save, and that is one misclick
  /// away from an outage nobody would attribute to a checkbox.
  ///
  /// Defaults to false so a category never starts recruiting by accident: a
  /// newly imported or newly created draft is invisible to applicants until an
  /// operator opens it. The migration backfills ACTIVE leaves to true, which is
  /// what keeps enrollment open if one of them is later pulled back to DRAFT.
  providerEnrollmentOpen Boolean @default(false)
```

- [ ] **Step 2: Migration dosyasını yaz**

`prisma/migrations/20260830120000_add_provider_enrollment_open/migration.sql`:

```sql
-- Provider self-enrollment, off by default so nothing recruits by accident.
ALTER TABLE "ServiceCategory"
  ADD COLUMN "providerEnrollmentOpen" BOOLEAN NOT NULL DEFAULT false;

-- Live services keep the state they already had: a provider has always been
-- able to select an ACTIVE leaf. The stored value matters if one of these is
-- ever pulled back to DRAFT, where the column is what decides enrollment.
UPDATE "ServiceCategory"
   SET "providerEnrollmentOpen" = true
 WHERE "status" = 'ACTIVE' AND "kind" = 'LEAF';
```

- [ ] **Step 3: Migration'ı uygula ve client'ı üret**

```bash
export $(grep -E '^(DATABASE_URL|AUTH_COOKIE_NAME)=' .env | xargs)
pnpm exec prisma migrate deploy && pnpm db:generate
```

Beklenen: migration uygulandı, `prisma generate` başarılı.

> Not: `migrate deploy` yalnız commit edilmiş migration'ları uygular; dev veritabanına veri yazmaz.

- [ ] **Step 4: Import tanımlarına `providerEnrollmentOpen: true` ekle**

Her iki import scriptinde de kategoriler `upsert` ile yazılıyor. 32 DRAFT LEAF hizmetin **hem `create` hem `update`** dalına alanı ekle — yalnız `create`'e eklemek, daha önce import edilmiş bir kurulumda hiçbir şeyi değiştirmez.

`prisma/import-draft-categories.ts` ve `prisma/import-draft-categories-wave-2.ts` içinde LEAF hizmetleri yazan `upsert` çağrısını bul ve her iki dala ekle:

```ts
      // The wave's services are the ones this expansion is recruiting for, so
      // they are opened to provider applications explicitly. Every other
      // category — groups, routers, anything created later — stays closed until
      // an operator opens it.
      providerEnrollmentOpen: true,
```

GROUP ve ROUTER satırlarını yazan `upsert` çağrılarına **ekleme**; onlar `false` kalır.

- [ ] **Step 5: Test fixture'larını genişlet**

`apps/api/test/harness.ts`, `createCategory` options tipine ve `data`'sına:

```ts
    providerEnrollmentOpen?: boolean;
```

```ts
      providerEnrollmentOpen: options.providerEnrollmentOpen ?? false,
```

`e2e/src/fixtures.ts` içindeki `createCategory` için aynı iki ekleme.

- [ ] **Step 6: Preflight'ı tekrar koş**

```bash
export $(grep -E '^(DATABASE_URL|AUTH_COOKIE_NAME)=' .env | xargs) && pnpm typecheck && pnpm test
```

Beklenen: PASS. Import spec'leri (`category-import-seed`, `category-import-wave-2`) hâlâ geçmeli.

- [ ] **Step 7: Commit**

```bash
git add prisma apps/api/test/harness.ts e2e/src/fixtures.ts
git commit -m "feat(prisma): add providerEnrollmentOpen to ServiceCategory"
```

---

### Task 2: Enrollment kuralı — saf predicate ve Prisma karşılığı

**Files:**
- Modify: `apps/api/src/modules/categories/category-taxonomy.ts`
- Create: `apps/api/test/category-supply-status.spec.ts` (bu görevde yalnız enrollment bölümü)

**Interfaces:**
- Consumes: Task 1'in `providerEnrollmentOpen` kolonu.
- Produces:
  - `isProviderEnrollmentOpen(category: CategoryEnrollmentFacts): boolean`
  - `type CategoryEnrollmentFacts = CategoryTaxonomyFacts & { providerEnrollmentOpen: boolean }`
  - `providerEnrollmentCategoryWhere: Prisma.ServiceCategoryWhereInput`
  - `canBeSelectedByProviders(category: CategoryEnrollmentFacts): boolean`

- [ ] **Step 1: Failing test'i yaz**

`apps/api/test/category-supply-status.spec.ts` oluştur:

```ts
import { Prisma, ServiceCategoryKind, ServiceCategoryStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  canBeSelectedByProviders,
  isProviderEnrollmentOpen,
  providerEnrollmentCategoryWhere,
} from '../src/modules/categories/category-taxonomy';

/**
 * The two derived rules this feature rests on, with no database and no HTTP in
 * the way. The endpoints delegate to them, so pinning the whole matrix here
 * means the integration specs can ask "does the endpoint consult the rule"
 * rather than re-deriving eighteen combinations through supertest.
 */

const { GROUP, LEAF, ROUTER } = ServiceCategoryKind;
const { DRAFT, ACTIVE, INACTIVE } = ServiceCategoryStatus;

const ALL_KINDS = [GROUP, LEAF, ROUTER];
const ALL_STATUSES = [DRAFT, ACTIVE, INACTIVE];

describe('provider enrollment', () => {
  it('opens every ACTIVE leaf, whatever the stored column says', () => {
    expect(isProviderEnrollmentOpen({ kind: LEAF, status: ACTIVE, providerEnrollmentOpen: true })).toBe(true);
    // The one case the column is deliberately powerless over: closing a live
    // category to provider selection would break every existing profile save.
    expect(isProviderEnrollmentOpen({ kind: LEAF, status: ACTIVE, providerEnrollmentOpen: false })).toBe(true);
  });

  it('opens a DRAFT leaf only when an operator has opened it', () => {
    expect(isProviderEnrollmentOpen({ kind: LEAF, status: DRAFT, providerEnrollmentOpen: true })).toBe(true);
    expect(isProviderEnrollmentOpen({ kind: LEAF, status: DRAFT, providerEnrollmentOpen: false })).toBe(false);
  });

  it('never opens a group, a router or a closed category', () => {
    for (const kind of ALL_KINDS) {
      for (const status of ALL_STATUSES) {
        for (const providerEnrollmentOpen of [true, false]) {
          const open = isProviderEnrollmentOpen({ kind, status, providerEnrollmentOpen });
          const expected =
            kind === LEAF && (status === ACTIVE || (status === DRAFT && providerEnrollmentOpen));
          expect(open).toBe(expected);
        }
      }
    }
  });

  it('is the same rule a provider selection is held to', () => {
    for (const kind of ALL_KINDS) {
      for (const status of ALL_STATUSES) {
        for (const providerEnrollmentOpen of [true, false]) {
          const facts = { kind, status, providerEnrollmentOpen };
          expect(canBeSelectedByProviders(facts)).toBe(isProviderEnrollmentOpen(facts));
        }
      }
    }
  });

  /**
   * The SQL twin of the predicate. They are asserted against each other rather
   * than only spelled next to each other, because a filter that admits one more
   * row than the predicate is a picker offering a category the API will refuse.
   */
  it('has a Prisma filter that describes exactly the same set', () => {
    const where = providerEnrollmentCategoryWhere;
    expect(where).toEqual<Prisma.ServiceCategoryWhereInput>({
      kind: LEAF,
      OR: [
        { status: ACTIVE },
        { status: DRAFT, providerEnrollmentOpen: true },
      ],
    });
  });
});
```

- [ ] **Step 2: Test'in düştüğünü gör**

```bash
export $(grep -E '^(DATABASE_URL|AUTH_COOKIE_NAME)=' .env | xargs)
pnpm --filter @taktic/api exec vitest run test/category-supply-status.spec.ts
```

Beklenen: FAIL — `isProviderEnrollmentOpen` ve `providerEnrollmentCategoryWhere` export edilmemiş.

- [ ] **Step 3: Kuralı yaz**

`apps/api/src/modules/categories/category-taxonomy.ts`:

Dosya başındaki `import` satırını genişlet:

```ts
import { Prisma, ServiceCategoryKind, ServiceCategoryStatus } from '@prisma/client';
```

Dosya başındaki blok yorumun son paragrafını şununla değiştir (artık bir `where` parçası da barındırıyor, ve yorum bunu dürüstçe söylemeli):

```
 * Nothing here runs a query. The functions take the columns they read and
 * nothing else, and the one Prisma value below is a plain `where` object — so
 * the whole matrix, that fragment included, is tested without a database.
```

`canBeSelectedByProviders`'ın mevcut gövdesini ve yorumunu şununla **değiştir**:

```ts
/** The columns an enrollment decision reads. */
export type CategoryEnrollmentFacts = CategoryTaxonomyFacts & {
  providerEnrollmentOpen: boolean;
};

/**
 * Whether a provider may put this category in their own service list.
 *
 * An ACTIVE leaf is always open and the stored column cannot close it. That is
 * not an oversight: provider selection is what every profile save and every new
 * application writes, so a checkbox able to close a live category would be one
 * misclick away from refusing saves nobody could explain. Closing a service is
 * done by closing the service — INACTIVE — which this rule already refuses.
 *
 * A DRAFT leaf is open only when an operator has opened it, and that is the
 * whole point of the column: it is how a business that signs itself up can join
 * a service the marketplace has not put in front of customers yet, without
 * every unfinished draft quietly collecting applications.
 *
 * GROUP is a folder and ROUTER is a question — neither describes work anybody
 * performs. INACTIVE is a service the marketplace has stopped selling. None of
 * the three is ever selectable, whatever the column says.
 *
 * Providers already attached to a category that later leaves this set keep the
 * row; only *new* selections are refused.
 */
export function isProviderEnrollmentOpen(category: CategoryEnrollmentFacts): boolean {
  if (!isLeafCategory(category)) {
    return false;
  }

  if (category.status === ServiceCategoryStatus.ACTIVE) {
    return true;
  }

  return category.status === ServiceCategoryStatus.DRAFT && category.providerEnrollmentOpen;
}

/**
 * The same rule, as a Prisma filter.
 *
 * It exists so the enrollment catalogue and the selection gate cannot describe
 * two different sets. A filter that admits one row the predicate refuses is a
 * picker offering a category the API rejects; one that admits one fewer is a
 * category a provider may select and can never find. The unit test asserts the
 * two against each other for exactly that reason.
 */
export const providerEnrollmentCategoryWhere: Prisma.ServiceCategoryWhereInput = {
  kind: ServiceCategoryKind.LEAF,
  OR: [
    { status: ServiceCategoryStatus.ACTIVE },
    { status: ServiceCategoryStatus.DRAFT, providerEnrollmentOpen: true },
  ],
};

/**
 * Whether a provider may newly select this category. One name for the rule the
 * profile form and the application form are both held to; see
 * {@link isProviderEnrollmentOpen} for why it says what it says.
 */
export function canBeSelectedByProviders(category: CategoryEnrollmentFacts): boolean {
  return isProviderEnrollmentOpen(category);
}
```

- [ ] **Step 4: Test'in geçtiğini gör**

```bash
export $(grep -E '^(DATABASE_URL|AUTH_COOKIE_NAME)=' .env | xargs)
pnpm --filter @taktic/api exec vitest run test/category-supply-status.spec.ts
```

Beklenen: PASS.

- [ ] **Step 5: Mevcut taxonomy spec'ini yeni kurala göre düzelt**

`apps/api/test/category-taxonomy-rules.spec.ts` içinde `canBeSelectedByProviders`'ı kullanan iki assertion artık üçüncü alanı vermediği için tip hatası verir ve DRAFT beklentisi değişmiştir. Satır 83 civarındaki döngüyü ve satır 100 civarındaki tekil assertion'ı şununla değiştir:

```ts
        // An ACTIVE leaf is selectable whatever the enrollment column says; a
        // DRAFT leaf only when an operator has opened it. The full matrix lives
        // in category-supply-status.spec.ts.
        expect(canBeSelectedByProviders({ kind, status, providerEnrollmentOpen: false })).toBe(
          kind === LEAF && status === ACTIVE,
        );
```

```ts
    expect(
      canBeSelectedByProviders({ kind: LEAF, status: DRAFT, providerEnrollmentOpen: false }),
    ).toBe(false);
    expect(
      canBeSelectedByProviders({ kind: LEAF, status: DRAFT, providerEnrollmentOpen: true }),
    ).toBe(true);
```

- [ ] **Step 6: Tüm API testlerini koş**

```bash
export $(grep -E '^(DATABASE_URL|AUTH_COOKIE_NAME)=' .env | xargs)
pnpm --filter @taktic/api test
```

Beklenen: PASS. (Derleme hatası çıkarsa `canBeSelectedByProviders` çağıran diğer yerler Task 7'de düzeltilecek — bu adımda yalnız `providers.service.ts:1312` çağrısı üçüncü alanı seçmediği için `select`'ine `providerEnrollmentOpen: true` eklemek yeterli; tam davranış Task 7'de test edilir.)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/categories/category-taxonomy.ts apps/api/test/category-supply-status.spec.ts apps/api/test/category-taxonomy-rules.spec.ts apps/api/src/modules/providers/providers.service.ts
git commit -m "feat(api): gate provider category selection on providerEnrollmentOpen"
```

---

### Task 3: Türetilmiş arz durumu — saf modül

**Files:**
- Create: `apps/api/src/modules/categories/category-supply-status.ts`
- Modify: `apps/api/test/category-supply-status.spec.ts`

**Interfaces:**
- Consumes: Task 2'nin `CategoryTaxonomyFacts` tipi.
- Produces:
  - `type CategorySupplyStatus = 'EMPTY' | 'SUPPLY_READY' | 'LAUNCH_READY' | 'LIVE'`
  - `resolveCategorySupplyStatus(facts: CategorySupplyFacts): CategorySupplyStatus | null`
  - `type CategorySupplyFacts = { kind; status; offerCreditCost: number | null; approvedProviderCount: number }`

- [ ] **Step 1: Failing test'i yaz**

`apps/api/test/category-supply-status.spec.ts` sonuna ekle (üstteki import bloğuna da ekle):

```ts
import {
  resolveCategorySupplyStatus,
  type CategorySupplyStatus,
} from '../src/modules/categories/category-supply-status';
```

```ts
describe('derived supply status', () => {
  it('says nothing about a group, a router or a closed category', () => {
    for (const kind of [GROUP, ROUTER]) {
      for (const status of ALL_STATUSES) {
        expect(
          resolveCategorySupplyStatus({
            kind,
            status,
            offerCreditCost: 5,
            approvedProviderCount: 3,
          }),
        ).toBeNull();
      }
    }

    expect(
      resolveCategorySupplyStatus({
        kind: LEAF,
        status: INACTIVE,
        offerCreditCost: 5,
        approvedProviderCount: 3,
      }),
    ).toBeNull();
  });

  /**
   * A released category is LIVE even with nobody behind it. "Published" is a
   * publishing fact; the missing supply is what releaseBlockers says, and
   * collapsing the two sentences into one badge is exactly what this status
   * exists to stop.
   */
  it('calls every ACTIVE leaf LIVE, supply or no supply', () => {
    expect(
      resolveCategorySupplyStatus({
        kind: LEAF,
        status: ACTIVE,
        offerCreditCost: null,
        approvedProviderCount: 0,
      }),
    ).toBe<CategorySupplyStatus>('LIVE');
  });

  it('walks a draft from EMPTY to LAUNCH_READY', () => {
    const draft = { kind: LEAF, status: DRAFT } as const;

    expect(
      resolveCategorySupplyStatus({ ...draft, offerCreditCost: 7, approvedProviderCount: 0 }),
    ).toBe<CategorySupplyStatus>('EMPTY');

    expect(
      resolveCategorySupplyStatus({ ...draft, offerCreditCost: null, approvedProviderCount: 1 }),
    ).toBe<CategorySupplyStatus>('SUPPLY_READY');

    expect(
      resolveCategorySupplyStatus({ ...draft, offerCreditCost: 7, approvedProviderCount: 1 }),
    ).toBe<CategorySupplyStatus>('LAUNCH_READY');
  });

  /** Supply comes first: an unpriced draft with nobody behind it is EMPTY, not SUPPLY_READY. */
  it('reports the missing provider before the missing price', () => {
    expect(
      resolveCategorySupplyStatus({
        kind: LEAF,
        status: DRAFT,
        offerCreditCost: null,
        approvedProviderCount: 0,
      }),
    ).toBe<CategorySupplyStatus>('EMPTY');
  });
});
```

- [ ] **Step 2: Test'in düştüğünü gör**

```bash
export $(grep -E '^(DATABASE_URL|AUTH_COOKIE_NAME)=' .env | xargs)
pnpm --filter @taktic/api exec vitest run test/category-supply-status.spec.ts
```

Beklenen: FAIL — `category-supply-status` modülü yok.

- [ ] **Step 3: Modülü yaz**

`apps/api/src/modules/categories/category-supply-status.ts`:

```ts
import { ServiceCategoryStatus } from '@prisma/client';
import { isLeafCategory, type CategoryTaxonomyFacts } from './category-taxonomy';

/**
 * How far an unreleased service has got towards being one — computed on every
 * read and stored nowhere.
 *
 * A column would have been a copy of three facts that move independently: a
 * provider is approved, suspended, deleted; a binding is added or removed; a
 * price is set. Every one of those is a write somebody has to remember, and a
 * forgotten one leaves a category reading "ready" with nobody behind it. Read
 * time is the only moment all three are true at once.
 *
 * EMPTY        No approved provider is attached. A pending, suspended or
 *              rejected profile is not one — none of them is ever shown a
 *              request — so binding one moves nothing, on purpose.
 * SUPPLY_READY Somebody can answer a request, but no offer can be paid for:
 *              the category has no price and refuses every offer.
 * LAUNCH_READY Both halves are in place. Still not published — that stays an
 *              operator's explicit act.
 * LIVE         Published. Whether it also has supply is a different sentence,
 *              and releaseBlockers is the one that says it.
 */
export type CategorySupplyStatus = 'EMPTY' | 'SUPPLY_READY' | 'LAUNCH_READY' | 'LIVE';

export type CategorySupplyFacts = CategoryTaxonomyFacts & {
  /** NULL means "price never set", which blocks offering. See the schema. */
  offerCreditCost: number | null;
  /** APPROVED providers only — see the count the operator projection builds. */
  approvedProviderCount: number;
};

/**
 * `null` for everything this question does not apply to.
 *
 * A GROUP is a folder and a ROUTER is a question: neither carries a price, a
 * provider or a request, so "how ready is its supply" has no answer rather than
 * a bad one. An INACTIVE category is one the marketplace has stopped selling —
 * measuring its supply would be reporting on a decision already taken.
 */
export function resolveCategorySupplyStatus(
  facts: CategorySupplyFacts,
): CategorySupplyStatus | null {
  if (!isLeafCategory(facts)) {
    return null;
  }

  if (facts.status === ServiceCategoryStatus.INACTIVE) {
    return null;
  }

  if (facts.status === ServiceCategoryStatus.ACTIVE) {
    return 'LIVE';
  }

  if (facts.approvedProviderCount < 1) {
    return 'EMPTY';
  }

  // The database CHECK constraint makes 0 and negatives unrepresentable, so
  // "priced" and "not null" are the same question and there is no third branch.
  return facts.offerCreditCost === null ? 'SUPPLY_READY' : 'LAUNCH_READY';
}
```

- [ ] **Step 4: Test'in geçtiğini gör**

```bash
export $(grep -E '^(DATABASE_URL|AUTH_COOKIE_NAME)=' .env | xargs)
pnpm --filter @taktic/api exec vitest run test/category-supply-status.spec.ts
```

Beklenen: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/categories/category-supply-status.ts apps/api/test/category-supply-status.spec.ts
git commit -m "feat(api): derive category supply status without storing it"
```

---

### Task 4: `supplyStatus` operatör projeksiyonunda

**Files:**
- Modify: `apps/api/src/modules/categories/categories.service.ts`
- Create: `apps/api/test/category-supply-status-projection.spec.ts`

**Interfaces:**
- Consumes: Task 3'ün `resolveCategorySupplyStatus`.
- Produces: `GET /categories?includeInactive=true` ve `GET /categories/:slug?includeInactive=true` yanıtlarında `supplyStatus: CategorySupplyStatus | null`.

- [ ] **Step 1: Failing test'i yaz**

`apps/api/test/category-supply-status-projection.spec.ts`:

```ts
import { ProviderStatus, ServiceCategoryKind, ServiceCategoryStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createCategory,
  createProviderProfile,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * The readiness figure an operator signs a release off on, over HTTP.
 *
 * The matrix itself is pinned without a database in category-supply-status.spec.ts.
 * What this file owns is the two things only the wire can show: that the value
 * follows the data with no re-binding and no migration, and that it reaches
 * nobody but an operator.
 */

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.notifications.clear();
});

async function adminCookie() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return loginAs(ctx.prisma, admin.id);
}

/** The status exactly as the readiness panel reads it, from the listing. */
async function supplyStatusOf(cookie: string, slug: string) {
  const response = await request(ctx.server)
    .get('/categories?includeInactive=true')
    .set('Cookie', cookie)
    .expect(200);

  const row = (response.body as Array<{ slug: string; supplyStatus: string | null }>).find(
    (entry) => entry.slug === slug,
  );

  expect(row).toBeDefined();
  return row!.supplyStatus;
}

describe('category supply status over HTTP', () => {
  it('moves from EMPTY to SUPPLY_READY when an approved provider is bound, and to LAUNCH_READY once priced', async () => {
    const cookie = await adminCookie();
    const category = await createCategory(ctx.prisma, 'Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: null,
    });

    expect(await supplyStatusOf(cookie, category.slug)).toBe('EMPTY');

    const provider = await createProviderProfile(ctx.prisma, { status: ProviderStatus.APPROVED });
    await ctx.prisma.providerServiceCategory.create({
      data: { providerId: provider.id, categoryId: category.id },
    });

    expect(await supplyStatusOf(cookie, category.slug)).toBe('SUPPLY_READY');

    await ctx.prisma.serviceCategory.update({
      where: { id: category.id },
      data: { offerCreditCost: 4 },
    });

    expect(await supplyStatusOf(cookie, category.slug)).toBe('LAUNCH_READY');
  });

  it('stays EMPTY for a provider under review and moves on its own once approved', async () => {
    const cookie = await adminCookie();
    const category = await createCategory(ctx.prisma, 'Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 4,
    });

    const provider = await createProviderProfile(ctx.prisma, {
      status: ProviderStatus.PENDING_REVIEW,
    });
    await ctx.prisma.providerServiceCategory.create({
      data: { providerId: provider.id, categoryId: category.id },
    });

    expect(await supplyStatusOf(cookie, category.slug)).toBe('EMPTY');

    // No re-binding, no migration: approving the provider is the whole event.
    await ctx.prisma.providerProfile.update({
      where: { id: provider.id },
      data: { status: ProviderStatus.APPROVED },
    });

    expect(await supplyStatusOf(cookie, category.slug)).toBe('LAUNCH_READY');
  });

  it('falls back when the approval is withdrawn and when the binding is removed', async () => {
    const cookie = await adminCookie();
    const category = await createCategory(ctx.prisma, 'Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 4,
    });

    const provider = await createProviderProfile(ctx.prisma, { status: ProviderStatus.APPROVED });
    const binding = await ctx.prisma.providerServiceCategory.create({
      data: { providerId: provider.id, categoryId: category.id },
    });

    expect(await supplyStatusOf(cookie, category.slug)).toBe('LAUNCH_READY');

    await ctx.prisma.providerProfile.update({
      where: { id: provider.id },
      data: { status: ProviderStatus.SUSPENDED },
    });
    expect(await supplyStatusOf(cookie, category.slug)).toBe('EMPTY');

    await ctx.prisma.providerProfile.update({
      where: { id: provider.id },
      data: { status: ProviderStatus.APPROVED },
    });
    expect(await supplyStatusOf(cookie, category.slug)).toBe('LAUNCH_READY');

    await ctx.prisma.providerServiceCategory.delete({ where: { id: binding.id } });
    expect(await supplyStatusOf(cookie, category.slug)).toBe('EMPTY');
  });

  it('says LIVE for a released service and nothing at all for groups, routers and closed categories', async () => {
    const cookie = await adminCookie();
    const live = await createCategory(ctx.prisma, 'Yayinda', { offerCreditCost: 3 });
    const group = await createCategory(ctx.prisma, 'Grup', {
      kind: ServiceCategoryKind.GROUP,
      status: ServiceCategoryStatus.DRAFT,
    });
    const router = await createCategory(ctx.prisma, 'Yonlendirici', {
      kind: ServiceCategoryKind.ROUTER,
      status: ServiceCategoryStatus.DRAFT,
    });
    const closed = await createCategory(ctx.prisma, 'Kapali', {
      status: ServiceCategoryStatus.INACTIVE,
    });

    expect(await supplyStatusOf(cookie, live.slug)).toBe('LIVE');
    expect(await supplyStatusOf(cookie, group.slug)).toBeNull();
    expect(await supplyStatusOf(cookie, router.slug)).toBeNull();
    expect(await supplyStatusOf(cookie, closed.slug)).toBeNull();
  });

  it('travels on the operator detail view too', async () => {
    const cookie = await adminCookie();
    const category = await createCategory(ctx.prisma, 'Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 4,
    });

    const response = await request(ctx.server)
      .get(`/categories/${category.slug}?includeInactive=true`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.supplyStatus).toBe('EMPTY');
  });

  it('reaches nobody but an operator', async () => {
    const category = await createCategory(ctx.prisma, 'Yayinda', { offerCreditCost: 3 });

    const list = await request(ctx.server).get('/categories').expect(200);
    for (const row of list.body as Array<Record<string, unknown>>) {
      expect(row).not.toHaveProperty('supplyStatus');
      expect(row).not.toHaveProperty('approvedProviderCount');
      expect((row._count as Record<string, unknown> | undefined) ?? {}).not.toHaveProperty(
        'providers',
      );
    }

    const detail = await request(ctx.server).get(`/categories/${category.slug}`).expect(200);
    expect(detail.body).not.toHaveProperty('supplyStatus');
    expect(detail.body).not.toHaveProperty('approvedProviderCount');
    expect(detail.body._count ?? {}).not.toHaveProperty('providers');

    // A signed-in customer is still the public projection.
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const customerCookie = await loginAs(ctx.prisma, customer.id);
    const asCustomer = await request(ctx.server)
      .get('/categories')
      .set('Cookie', customerCookie)
      .expect(200);
    for (const row of asCustomer.body as Array<Record<string, unknown>>) {
      expect(row).not.toHaveProperty('supplyStatus');
    }

    // And asking for the wide view without being an operator is still refused.
    await request(ctx.server)
      .get('/categories?includeInactive=true')
      .set('Cookie', customerCookie)
      .expect(403);
  });
});
```

- [ ] **Step 2: Test'in düştüğünü gör**

```bash
export $(grep -E '^(DATABASE_URL|AUTH_COOKIE_NAME)=' .env | xargs)
pnpm --filter @taktic/api exec vitest run test/category-supply-status-projection.spec.ts
```

Beklenen: FAIL — `supplyStatus` alanı yok.

- [ ] **Step 3: Servise ekle**

`apps/api/src/modules/categories/categories.service.ts`:

Import ekle:

```ts
import {
  resolveCategorySupplyStatus,
  type CategorySupplyStatus,
} from './category-supply-status';
```

`operatorCategoryCounts` fonksiyonundan sonra şu yardımcıyı ekle:

```ts
/** The shape the supply status is derived from, as the operator queries return it. */
type CategoryWithOperatorCounts = {
  kind: ServiceCategoryKind;
  status: ServiceCategoryStatus;
  offerCreditCost: number | null;
  _count: { providers: number };
};

/**
 * Attaches the derived status to a row on its way out.
 *
 * Server-side rather than left to the admin app on purpose: the figure decides
 * whether somebody releases a service, and two clients doing the same
 * arithmetic is two chances to do it differently. The client renders a label
 * for a value it is given.
 */
function withSupplyStatus<T extends CategoryWithOperatorCounts>(
  category: T,
): T & { supplyStatus: CategorySupplyStatus | null } {
  return {
    ...category,
    supplyStatus: resolveCategorySupplyStatus({
      kind: category.kind,
      status: category.status,
      offerCreditCost: category.offerCreditCost,
      approvedProviderCount: category._count.providers,
    }),
  };
}
```

`listCategories` içindeki **operatör** dalını (public dalı değil) şununla değiştir:

```ts
    const categories = await this.prisma.serviceCategory.findMany({
      ...query,
      include: {
        parent: { select: { id: true, name: true, slug: true } },
        _count: { select: operatorCategoryCounts() },
      },
    });

    return categories.map(withSupplyStatus);
```

`getCategoryBySlug` içinde iki dalı ayır. Mevcut `const category = includeInactive ? ... : ...` üçlüsü ve ardından gelen tek `return` bloğu şununla değiştirilir — böylece `supplyStatus` yalnız onaylı hizmet veren sayısını gerçekten yükleyen sorgunun sonucuna eklenir ve tip daraltmasına gerek kalmaz:

```ts
    const questionsOf = (
      category: { questions: QuestionWithRules[] },
    ) =>
      // `includeInactive` is the admin path, and the only one that may see
      // where a router leads.
      category.questions.map((question) =>
        serializeQuestion(question, { exposeRouterTargets: includeInactive }),
      );

    if (includeInactive) {
      const category = await this.prisma.serviceCategory.findUnique({
        where: { slug },
        include: { ...include, _count: { select: operatorCategoryCounts() } },
      });

      if (!category) {
        throw new NotFoundException('Category not found');
      }

      // Only this query computes the approved-provider count, so only its
      // result can carry a status derived from one.
      return withSupplyStatus({ ...category, questions: questionsOf(category) });
    }

    const category = await this.prisma.serviceCategory.findUnique({
      where: { slug },
      include: { ...include, _count: { select: { children: true } } },
    });

    if (!category) {
      throw new NotFoundException('Category not found');
    }

    // A category the public may not reach is indistinguishable from one that
    // does not exist — a 403 would confirm the slug of an unreleased service to
    // anybody who guessed it.
    if (!isPubliclyReachable(category)) {
      throw new NotFoundException('Category not found');
    }

    return { ...category, questions: questionsOf(category) };
```

`QuestionWithRules` tipini `./category-serialization` içinden import et.

- [ ] **Step 4: Test'in geçtiğini gör**

```bash
export $(grep -E '^(DATABASE_URL|AUTH_COOKIE_NAME)=' .env | xargs)
pnpm --filter @taktic/api exec vitest run test/category-supply-status-projection.spec.ts
```

Beklenen: PASS.

- [ ] **Step 5: Tüm API testlerini koş**

```bash
export $(grep -E '^(DATABASE_URL|AUTH_COOKIE_NAME)=' .env | xargs)
pnpm --filter @taktic/api test
```

Beklenen: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/categories/categories.service.ts apps/api/test/category-supply-status-projection.spec.ts
git commit -m "feat(api): expose the derived supply status on the operator category view"
```

---

### Task 5: `providerEnrollmentOpen` yazma kuralı

**Files:**
- Modify: `apps/api/src/modules/categories/dto/create-category.dto.ts`
- Modify: `apps/api/src/modules/categories/dto/update-category.dto.ts`
- Modify: `apps/api/src/modules/categories/categories.service.ts`
- Create: `apps/api/test/category-provider-enrollment.spec.ts`

**Interfaces:**
- Consumes: Task 2'nin kuralı.
- Produces: `POST /categories` ve `PATCH /categories/:id` gövdelerinde `providerEnrollmentOpen?: boolean`; DRAFT LEAF olmayan sonuç için 400.

- [ ] **Step 1: Failing test'i yaz**

`apps/api/test/category-provider-enrollment.spec.ts`:

```ts
import { ServiceCategoryKind, ServiceCategoryStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createCategory,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * The one switch that opens an unreleased service to applications, and the
 * narrow rules about who may set it and when.
 */

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.notifications.clear();
});

async function adminCookie() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return loginAs(ctx.prisma, admin.id);
}

describe('writing providerEnrollmentOpen', () => {
  it('opens a draft service', async () => {
    const cookie = await adminCookie();
    const category = await createCategory(ctx.prisma, 'Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 3,
    });

    await request(ctx.server)
      .patch(`/categories/${category.id}`)
      .set('Cookie', cookie)
      .send({ providerEnrollmentOpen: true })
      .expect(200);

    const stored = await ctx.prisma.serviceCategory.findUniqueOrThrow({
      where: { id: category.id },
    });
    expect(stored.providerEnrollmentOpen).toBe(true);
  });

  it('creates a draft service already open', async () => {
    const cookie = await adminCookie();

    const response = await request(ctx.server)
      .post('/categories')
      .set('Cookie', cookie)
      .send({
        name: 'Beyaz Eşya Tamiri',
        slug: 'beyaz-esya-tamiri-test',
        offerCreditCost: 3,
        status: ServiceCategoryStatus.DRAFT,
        providerEnrollmentOpen: true,
      })
      .expect(201);

    expect(response.body.providerEnrollmentOpen).toBe(true);
  });

  /**
   * Refused rather than ignored. An operator who believes they opened a
   * category and did not is precisely the state this switch exists to prevent.
   */
  it('refuses the field on anything that is not a draft service', async () => {
    const cookie = await adminCookie();

    const live = await createCategory(ctx.prisma, 'Yayinda', { offerCreditCost: 3 });
    await request(ctx.server)
      .patch(`/categories/${live.id}`)
      .set('Cookie', cookie)
      .send({ providerEnrollmentOpen: false })
      .expect(400);

    const group = await createCategory(ctx.prisma, 'Grup', {
      kind: ServiceCategoryKind.GROUP,
      status: ServiceCategoryStatus.DRAFT,
    });
    await request(ctx.server)
      .patch(`/categories/${group.id}`)
      .set('Cookie', cookie)
      .send({ providerEnrollmentOpen: true })
      .expect(400);

    const closed = await createCategory(ctx.prisma, 'Kapali', {
      status: ServiceCategoryStatus.INACTIVE,
      offerCreditCost: 3,
    });
    await request(ctx.server)
      .patch(`/categories/${closed.id}`)
      .set('Cookie', cookie)
      .send({ providerEnrollmentOpen: true })
      .expect(400);
  });

  /** The rule is applied to the row being written, not the one that was there. */
  it('judges the resulting category, not the previous one', async () => {
    const cookie = await adminCookie();
    const live = await createCategory(ctx.prisma, 'Yayinda', { offerCreditCost: 3 });

    // ACTIVE today, DRAFT after this same request: the field is allowed.
    await request(ctx.server)
      .patch(`/categories/${live.id}`)
      .set('Cookie', cookie)
      .send({ status: ServiceCategoryStatus.DRAFT, providerEnrollmentOpen: true })
      .expect(200);

    const draft = await createCategory(ctx.prisma, 'Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 3,
    });

    // DRAFT today, ACTIVE after this request: refused.
    await request(ctx.server)
      .patch(`/categories/${draft.id}`)
      .set('Cookie', cookie)
      .send({ status: ServiceCategoryStatus.ACTIVE, providerEnrollmentOpen: true })
      .expect(400);
  });

  it('is an operator-only field', async () => {
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const customerCookie = await loginAs(ctx.prisma, customer.id);
    const category = await createCategory(ctx.prisma, 'Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 3,
    });

    await request(ctx.server)
      .patch(`/categories/${category.id}`)
      .set('Cookie', customerCookie)
      .send({ providerEnrollmentOpen: true })
      .expect(403);
  });
});
```

- [ ] **Step 2: Test'in düştüğünü gör**

```bash
export $(grep -E '^(DATABASE_URL|AUTH_COOKIE_NAME)=' .env | xargs)
pnpm --filter @taktic/api exec vitest run test/category-provider-enrollment.spec.ts
```

Beklenen: FAIL.

- [ ] **Step 3: DTO alanlarını ekle**

`create-category.dto.ts`, `sortOrder`'dan önce:

```ts
  /**
   * Whether providers may sign themselves up for this service. Only meaningful
   * on a DRAFT leaf — see isProviderEnrollmentOpen — and CategoriesService
   * refuses it on anything else rather than storing a value nothing reads.
   */
  @IsOptional()
  @IsBoolean()
  providerEnrollmentOpen?: boolean;
```

`update-category.dto.ts`, `sortOrder`'dan önce aynı blok.

- [ ] **Step 4: Servis kuralını yaz**

`categories.service.ts` içine, `createCategory`'den önce:

```ts
/**
 * `providerEnrollmentOpen` may only be written onto a DRAFT leaf.
 *
 * Judged against the category the write produces rather than the one that was
 * there, because the same PATCH may be changing `kind` or `status` too, and the
 * rule belongs to the row being stored.
 *
 * A refusal rather than a silent drop: an operator who thinks they opened a
 * service to applications and did not is exactly the state the switch exists to
 * prevent, and an ignored field is how they would come to think it.
 */
function assertEnrollmentFieldIsWritable(
  requested: boolean | undefined,
  resulting: { kind: ServiceCategoryKind; status: ServiceCategoryStatus },
) {
  if (requested === undefined) {
    return;
  }

  if (resulting.kind !== ServiceCategoryKind.LEAF) {
    throw new BadRequestException(
      'Hizmet veren başvurusu yalnızca hizmet tipindeki kategorilerde ayarlanabilir.',
    );
  }

  if (resulting.status !== ServiceCategoryStatus.DRAFT) {
    throw new BadRequestException(
      'Hizmet veren başvurusu yalnızca taslak hizmetlerde ayarlanabilir. Yayındaki hizmetler her zaman başvuruya açıktır.',
    );
  }
}
```

`createCategory` içinde, `const status = ...` satırından sonra:

```ts
    const kind = dto.kind ?? ServiceCategoryKind.LEAF;
    assertEnrollmentFieldIsWritable(dto.providerEnrollmentOpen, { kind, status });
```

ve aynı metottaki `data` bloğunda `kind: dto.kind ?? ServiceCategoryKind.LEAF,` satırını `kind,` ile değiştir, `sortOrder`'dan önce ekle:

```ts
          providerEnrollmentOpen: dto.providerEnrollmentOpen ?? false,
```

`updateCategory` içinde, `const status = resolveRequestedStatus(dto);` satırından sonra:

```ts
    assertEnrollmentFieldIsWritable(dto.providerEnrollmentOpen, {
      kind: dto.kind ?? existing.kind,
      status: status ?? existing.status,
    });
```

ve `update`'in `data` bloğunda `sortOrder`'dan önce:

```ts
          ...(dto.providerEnrollmentOpen !== undefined
            ? { providerEnrollmentOpen: dto.providerEnrollmentOpen }
            : {}),
```

> `ensureCategoryExists` zaten `{ id, kind, status }` seçiyor, dolayısıyla ek bir select değişikliği gerekmez.

- [ ] **Step 5: Test'in geçtiğini gör**

```bash
export $(grep -E '^(DATABASE_URL|AUTH_COOKIE_NAME)=' .env | xargs)
pnpm --filter @taktic/api exec vitest run test/category-provider-enrollment.spec.ts
```

Beklenen: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/categories apps/api/test/category-provider-enrollment.spec.ts
git commit -m "feat(api): let an operator open a draft service to provider applications"
```

---

### Task 6: Hizmet veren kayıt kataloğu ucu

**Files:**
- Modify: `apps/api/src/modules/categories/categories.service.ts`
- Modify: `apps/api/src/modules/categories/categories.controller.ts`
- Modify: `apps/api/test/category-provider-enrollment.spec.ts`

**Interfaces:**
- Consumes: Task 2'nin `providerEnrollmentCategoryWhere`.
- Produces:
  - `GET /categories/provider-enrollment` → `ProviderEnrollmentCategory[]`
  - `type ProviderEnrollmentCategory = { id, name, slug, iconKey: string | null, imageUrl: string | null, parent: { id, name, slug } | null, availability: 'LIVE' | 'UPCOMING' }`
  - `CategoriesService.listProviderEnrollmentCategories(): Promise<ProviderEnrollmentCategory[]>`

- [ ] **Step 1: Failing test'i yaz**

`apps/api/test/category-provider-enrollment.spec.ts` sonuna:

```ts
describe('the provider enrollment catalogue', () => {
  it('offers live services and the drafts an operator has opened, and nothing else', async () => {
    const live = await createCategory(ctx.prisma, 'Yayinda', { offerCreditCost: 3 });
    const openDraft = await createCategory(ctx.prisma, 'Acik Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 3,
      providerEnrollmentOpen: true,
    });
    const closedDraft = await createCategory(ctx.prisma, 'Kapali Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 3,
    });
    const group = await createCategory(ctx.prisma, 'Grup', {
      kind: ServiceCategoryKind.GROUP,
      status: ServiceCategoryStatus.DRAFT,
      providerEnrollmentOpen: true,
    });
    const closed = await createCategory(ctx.prisma, 'Kapali', {
      status: ServiceCategoryStatus.INACTIVE,
      offerCreditCost: 3,
      providerEnrollmentOpen: true,
    });

    // Deliberately signed out: the application form is reachable to a business
    // that has no account yet, and that is the applicant this exists for.
    const response = await request(ctx.server).get('/categories/provider-enrollment').expect(200);

    const slugs = (response.body as Array<{ slug: string }>).map((row) => row.slug);
    expect(slugs).toContain(live.slug);
    expect(slugs).toContain(openDraft.slug);
    expect(slugs).not.toContain(closedDraft.slug);
    expect(slugs).not.toContain(group.slug);
    expect(slugs).not.toContain(closed.slug);
  });

  it('says which of them can take a request today', async () => {
    const live = await createCategory(ctx.prisma, 'Yayinda', { offerCreditCost: 3 });
    const openDraft = await createCategory(ctx.prisma, 'Acik Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 3,
      providerEnrollmentOpen: true,
    });

    const response = await request(ctx.server).get('/categories/provider-enrollment').expect(200);
    const rows = response.body as Array<{ slug: string; availability: string }>;

    expect(rows.find((row) => row.slug === live.slug)?.availability).toBe('LIVE');
    expect(rows.find((row) => row.slug === openDraft.slug)?.availability).toBe('UPCOMING');
  });

  /**
   * An allow-list asserted as an exact key set, not a handful of absences: a
   * column added to ServiceCategory later must not reach this response because
   * nobody remembered to exclude it.
   */
  it('carries nothing an applicant does not need to pick a service', async () => {
    const parent = await createCategory(ctx.prisma, 'Grup', {
      kind: ServiceCategoryKind.GROUP,
      status: ServiceCategoryStatus.DRAFT,
    });
    await createCategory(ctx.prisma, 'Acik Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 3,
      providerEnrollmentOpen: true,
      parentId: parent.id,
    });

    const response = await request(ctx.server).get('/categories/provider-enrollment').expect(200);
    const [row] = response.body as Array<Record<string, unknown>>;

    expect(Object.keys(row).sort()).toEqual([
      'availability',
      'iconKey',
      'id',
      'imageUrl',
      'name',
      'parent',
      'slug',
    ]);
    expect(Object.keys(row.parent as Record<string, unknown>).sort()).toEqual([
      'id',
      'name',
      'slug',
    ]);
  });
});
```

- [ ] **Step 2: Test'in düştüğünü gör**

```bash
export $(grep -E '^(DATABASE_URL|AUTH_COOKIE_NAME)=' .env | xargs)
pnpm --filter @taktic/api exec vitest run test/category-provider-enrollment.spec.ts
```

Beklenen: FAIL — 404, çünkü uç yok (ya da `:slug` rotası yakalar).

- [ ] **Step 3: Servise metodu ekle**

`categories.service.ts`, import'lara `providerEnrollmentCategoryWhere` ekle, ve `listCategories`'ten sonra:

```ts
/**
 * A service as the application form needs to render it, and not one field more.
 *
 * `availability` is a vocabulary of its own rather than the supply status: it
 * answers "can this take a request today", which is all an applicant is owed.
 * The operator's four-state figure would tell a stranger how many businesses
 * stand behind an unreleased service, and that is an operational number with no
 * reader outside the admin panel.
 */
export type ProviderEnrollmentCategory = {
  id: string;
  name: string;
  slug: string;
  iconKey: string | null;
  imageUrl: string | null;
  parent: { id: string; name: string; slug: string } | null;
  availability: 'LIVE' | 'UPCOMING';
};
```

ve sınıf içinde:

```ts
  /**
   * The catalogue a business signs itself up against.
   *
   * Deliberately reachable signed out. The whole problem this solves is the
   * repairer who finds the marketplace, opens the application form and cannot
   * tick the one service they actually do because it has not been released yet
   * — and that form is reachable without an account by design, since the claim
   * link mailed to the applicant is what hands the application back to them.
   *
   * What that discloses is the name of a draft service an operator has
   * explicitly opened to applications, which is what recruiting for it means.
   * `providerEnrollmentOpen` starts false, so nothing appears here until
   * somebody decides it should.
   *
   * The filter is the shared one, so this list and the selection gate cannot
   * describe two different sets — a category shown here and refused on submit
   * is a dead end with no error the applicant can act on.
   */
  async listProviderEnrollmentCategories(): Promise<ProviderEnrollmentCategory[]> {
    const categories = await this.prisma.serviceCategory.findMany({
      where: providerEnrollmentCategoryWhere,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      // A select rather than a narrowing afterwards: the columns this response
      // must never carry are then never loaded, so there is no field for a
      // later edit to forget to strip.
      select: {
        id: true,
        name: true,
        slug: true,
        iconKey: true,
        imageUrl: true,
        status: true,
        parent: { select: { id: true, name: true, slug: true } },
      },
    });

    return categories.map(({ status, ...category }) => ({
      ...category,
      availability: status === ServiceCategoryStatus.ACTIVE ? 'LIVE' : 'UPCOMING',
    }));
  }
```

- [ ] **Step 4: Controller rotasını ekle**

`categories.controller.ts` içinde, **`@Get(':slug')` bloğundan önce** (aksi hâlde `:slug` bu yolu yutar):

```ts
  /**
   * The services a business may sign itself up for.
   *
   * Unauthenticated on purpose: the application form is reachable without an
   * account, and this is the list it renders. See
   * CategoriesService.listProviderEnrollmentCategories for what that discloses
   * and why the projection is as narrow as it is.
   *
   * Declared above `:slug` because Nest matches routes in declaration order and
   * `:slug` would otherwise swallow this path.
   */
  @Get('provider-enrollment')
  listProviderEnrollmentCategories() {
    return this.categoriesService.listProviderEnrollmentCategories();
  }
```

- [ ] **Step 5: Test'in geçtiğini gör**

```bash
export $(grep -E '^(DATABASE_URL|AUTH_COOKIE_NAME)=' .env | xargs)
pnpm --filter @taktic/api exec vitest run test/category-provider-enrollment.spec.ts
```

Beklenen: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/categories apps/api/test/category-provider-enrollment.spec.ts
git commit -m "feat(api): serve the provider enrollment catalogue"
```

---

### Task 7: Seçim kapısı ve profil kaydının silme filtresi

**Files:**
- Modify: `apps/api/src/modules/providers/providers.service.ts`
- Modify: `apps/api/test/category-provider-enrollment.spec.ts`

**Interfaces:**
- Consumes: Task 2'nin `canBeSelectedByProviders` ve `providerEnrollmentCategoryWhere`.
- Produces: davranış değişikliği; yeni export yok.

- [ ] **Step 1: Failing test'i yaz**

`apps/api/test/category-provider-enrollment.spec.ts` sonuna (üstteki import bloğuna `createProviderProfile` ve `providerPayload` ekle):

```ts
describe('selecting a category as a provider', () => {
  it('accepts an open draft and refuses a closed one', async () => {
    const openDraft = await createCategory(ctx.prisma, 'Acik Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 3,
      providerEnrollmentOpen: true,
    });
    const closedDraft = await createCategory(ctx.prisma, 'Kapali Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 3,
    });

    await request(ctx.server)
      .post('/providers')
      .send(providerPayload([openDraft.id]))
      .expect(201);

    await request(ctx.server)
      .post('/providers')
      .send(providerPayload([closedDraft.id]))
      .expect(400);
  });

  it('keeps a live service selectable even with the column off', async () => {
    const live = await createCategory(ctx.prisma, 'Yayinda', { offerCreditCost: 3 });
    expect(live.providerEnrollmentOpen).toBe(false);

    await request(ctx.server)
      .post('/providers')
      .send(providerPayload([live.id]))
      .expect(201);
  });

  /**
   * The profile form replaces the provider's list. It must replace exactly what
   * the provider can manage: a draft they signed themselves up for is theirs to
   * drop, and a draft an operator bound them to behind a closed enrollment is
   * not theirs to lose.
   */
  it('a profile save drops a self-selected draft and leaves an operator-bound one alone', async () => {
    const live = await createCategory(ctx.prisma, 'Yayinda', { offerCreditCost: 3 });
    const openDraft = await createCategory(ctx.prisma, 'Acik Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 3,
      providerEnrollmentOpen: true,
    });
    const closedDraft = await createCategory(ctx.prisma, 'Kapali Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 3,
    });

    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const ownerCookie = await loginAs(ctx.prisma, owner.id);
    const provider = await createProviderProfile(ctx.prisma, { userId: owner.id });

    await ctx.prisma.providerServiceCategory.createMany({
      data: [
        { providerId: provider.id, categoryId: live.id },
        { providerId: provider.id, categoryId: openDraft.id },
        { providerId: provider.id, categoryId: closedDraft.id },
      ],
    });

    await request(ctx.server)
      .patch(`/providers/${provider.id}`)
      .set('Cookie', ownerCookie)
      .send(providerPayload([live.id]))
      .expect(200);

    const remaining = await ctx.prisma.providerServiceCategory.findMany({
      where: { providerId: provider.id },
      select: { categoryId: true },
    });
    const ids = remaining.map((row) => row.categoryId).sort();
    expect(ids).toEqual([live.id, closedDraft.id].sort());
  });
});
```

- [ ] **Step 2: Test'in düştüğünü gör**

```bash
export $(grep -E '^(DATABASE_URL|AUTH_COOKIE_NAME)=' .env | xargs)
pnpm --filter @taktic/api exec vitest run test/category-provider-enrollment.spec.ts
```

Beklenen: FAIL — açık taslak seçimi 400 döner, ve profil kaydı açık taslağı bırakır.

- [ ] **Step 3: Seçim kapısını ve silme filtresini düzelt**

`providers.service.ts` import'larına ekle:

```ts
  providerEnrollmentCategoryWhere,
```

`ensureActiveCategories`'in `select`'ini ve yorumunu değiştir:

```ts
  /**
   * A provider may only newly select a category enrollment is open on: a live
   * service, or a draft an operator has opened to applications. See
   * isProviderEnrollmentOpen.
   *
   * Kind matters as much as status. A GROUP is a folder and a ROUTER is a
   * question — neither describes work anybody performs, so neither may end up
   * in a provider's service list, where it would silently never match a
   * request. Providers already attached to a category that later closes keep
   * their row; only new selections are refused.
   */
  private async ensureActiveCategories(categoryIds: string[]) {
    const categories = await this.prisma.serviceCategory.findMany({
      where: { id: { in: categoryIds } },
      select: { id: true, kind: true, status: true, providerEnrollmentOpen: true },
    });
```

`updateProvider` içindeki `deleteMany`'yi değiştir:

```ts
      // Replace exactly what the provider can manage. A binding an operator made
      // to a category enrollment is closed on is not on their form, so a save
      // must not be able to drop it — and a draft they signed themselves up for
      // is on their form, so a save must be able to.
      await tx.providerServiceCategory.deleteMany({
        where: {
          providerId: id,
          category: providerEnrollmentCategoryWhere,
        },
      });
```

- [ ] **Step 4: Test'in geçtiğini gör**

```bash
export $(grep -E '^(DATABASE_URL|AUTH_COOKIE_NAME)=' .env | xargs)
pnpm --filter @taktic/api exec vitest run test/category-provider-enrollment.spec.ts
```

Beklenen: PASS.

- [ ] **Step 5: Tüm API testlerini koş**

```bash
export $(grep -E '^(DATABASE_URL|AUTH_COOKIE_NAME)=' .env | xargs)
pnpm --filter @taktic/api test
```

Beklenen: PASS. `provider-draft-category-binding.spec.ts` ve `provider-work-scope.spec.ts` özellikle yeşil olmalı.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/providers/providers.service.ts apps/api/test/category-provider-enrollment.spec.ts
git commit -m "feat(api): let a provider sign up for an opened draft service"
```

---

### Task 8: `upcomingServiceCategories` — hizmet verenin kendi görünümü

**Files:**
- Modify: `apps/api/src/modules/providers/providers.service.ts`
- Create: `apps/api/test/provider-upcoming-categories.spec.ts`

**Interfaces:**
- Consumes: Task 7.
- Produces: owner ve admin provider projeksiyonlarında `upcomingServiceCategories: Array<{ id: string; category: { id: string; name: string; slug: string } }>`.

- [ ] **Step 1: Failing test'i yaz**

`apps/api/test/provider-upcoming-categories.spec.ts`:

```ts
import { ProviderStatus, ServiceCategoryStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createCategory,
  createProviderProfile,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * What a provider is told about the unreleased service they joined.
 *
 * The binding used to be invisible to them because they could not have made it
 * — only an operator could. Now they can make it themselves, and a category
 * that vanishes the moment it is chosen reads as a bug rather than as a
 * release process. So it comes back, in its own list, saying the one thing that
 * is true about it: not open yet.
 *
 * The list stays as narrow as it was. No supply figure, no headcount, no price:
 * that is the operator's panel, and nothing about a provider joining a draft
 * makes it theirs.
 */

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.notifications.clear();
});

async function providerWithBothBindings() {
  const live = await createCategory(ctx.prisma, 'Yayinda', { offerCreditCost: 3 });
  const draft = await createCategory(ctx.prisma, 'Acik Taslak', {
    status: ServiceCategoryStatus.DRAFT,
    offerCreditCost: 3,
    providerEnrollmentOpen: true,
  });

  const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createProviderProfile(ctx.prisma, {
    userId: owner.id,
    status: ProviderStatus.APPROVED,
  });

  await ctx.prisma.providerServiceCategory.createMany({
    data: [
      { providerId: provider.id, categoryId: live.id },
      { providerId: provider.id, categoryId: draft.id },
    ],
  });

  return { live, draft, owner, provider };
}

describe('a provider’s upcoming services', () => {
  it('shows the owner their draft binding, apart from the live ones', async () => {
    const { live, draft, owner, provider } = await providerWithBothBindings();
    const cookie = await loginAs(ctx.prisma, owner.id);

    const response = await request(ctx.server)
      .get(`/providers/${provider.id}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(
      (response.body.serviceCategories as Array<{ category: { id: string } }>).map(
        (item) => item.category.id,
      ),
    ).toEqual([live.id]);

    const upcoming = response.body.upcomingServiceCategories as Array<{
      id: string;
      category: Record<string, unknown>;
    }>;
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0].category.id).toBe(draft.id);
    expect(Object.keys(upcoming[0].category).sort()).toEqual(['id', 'name', 'slug']);
  });

  it('shows a stranger nothing at all', async () => {
    const { provider } = await providerWithBothBindings();

    const anonymous = await request(ctx.server).get(`/providers/${provider.id}`).expect(200);
    expect(anonymous.body.visibility).toBe('public');
    expect(anonymous.body).not.toHaveProperty('upcomingServiceCategories');

    const other = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const otherCookie = await loginAs(ctx.prisma, other.id);
    const asOther = await request(ctx.server)
      .get(`/providers/${provider.id}`)
      .set('Cookie', otherCookie)
      .expect(200);
    expect(asOther.body).not.toHaveProperty('upcomingServiceCategories');
  });

  it('carries no supply figure to the provider', async () => {
    const { owner, provider } = await providerWithBothBindings();
    const cookie = await loginAs(ctx.prisma, owner.id);

    const response = await request(ctx.server)
      .get(`/providers/${provider.id}`)
      .set('Cookie', cookie)
      .expect(200);

    const body = JSON.stringify(response.body);
    expect(body).not.toContain('supplyStatus');
    expect(body).not.toContain('approvedProviderCount');
    expect(body).not.toContain('offerCreditCost');
  });
});
```

- [ ] **Step 2: Test'in düştüğünü gör**

```bash
export $(grep -E '^(DATABASE_URL|AUTH_COOKIE_NAME)=' .env | xargs)
pnpm --filter @taktic/api exec vitest run test/provider-upcoming-categories.spec.ts
```

Beklenen: FAIL — `upcomingServiceCategories` yok.

- [ ] **Step 3: Projeksiyonu ekle**

`providers.service.ts`, `visibleServiceCategories`'in yanına:

```ts
/**
 * The DRAFT half of the same bindings, in the same narrowed shape.
 *
 * Separate from `serviceCategories` rather than mixed into it, and that
 * separation is the contract: everything downstream — matching, offering,
 * e-mail — reads the first list, and a draft appearing in it would put a
 * provider in front of requests for a service that does not take any. This one
 * is read by a panel and by nothing else.
 */
function upcomingServiceCategories(
  bindings: readonly ProviderCategoryBinding[],
): Array<{ id: string; category: { id: string; name: string; slug: string } }> {
  return bindings
    .filter((binding) => !isLiveProviderBinding(binding.category))
    .map((binding) => ({
      id: binding.id,
      category: {
        id: binding.category.id,
        name: binding.category.name,
        slug: binding.category.slug,
      },
    }));
}
```

`withVisibleServiceCategories`'i değiştir:

```ts
/**
 * The same narrowing, over a whole provider record, plus the drafts in their
 * own list. Used for the owner and the operator; never for the public shape,
 * which is built by toPublicProvider and carries no draft at all.
 */
function withVisibleServiceCategories<
  T extends { serviceCategories: readonly ProviderCategoryBinding[] },
>(provider: T) {
  return {
    ...provider,
    serviceCategories: visibleServiceCategories(provider.serviceCategories),
    upcomingServiceCategories: upcomingServiceCategories(provider.serviceCategories),
  };
}
```

`toPublicProvider` değişmez — orada `upcomingServiceCategories` **yoktur**.

> Operatörün ayrı ucu `GET /providers/:id/service-categories` (`getAdminServiceCategories`) bugün zaten taslakları `serviceCategories` içinde döndürüyor ve `countsForRelease` ile işaretliyor. Onu **değiştirme** — admin ekranı o şekli okuyor. Bu görevin dokunduğu yer yalnız `withVisibleServiceCategories`, yani owner ve operatörün provider *detay* projeksiyonudur.

- [ ] **Step 4: Test'in geçtiğini gör**

```bash
export $(grep -E '^(DATABASE_URL|AUTH_COOKIE_NAME)=' .env | xargs)
pnpm --filter @taktic/api exec vitest run test/provider-upcoming-categories.spec.ts
```

Beklenen: PASS.

- [ ] **Step 5: Tüm API testlerini koş**

```bash
export $(grep -E '^(DATABASE_URL|AUTH_COOKIE_NAME)=' .env | xargs)
pnpm --filter @taktic/api test
```

Beklenen: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/providers/providers.service.ts apps/api/test/provider-upcoming-categories.spec.ts
git commit -m "feat(api): show a provider the unreleased services they joined"
```

---

### Task 9: Açık taslağın müşteri tarafına hâlâ kapalı olduğunu sabitle

**Files:**
- Modify: `apps/api/test/category-supply-status-projection.spec.ts`

**Interfaces:**
- Consumes: Task 4, 6, 7.
- Produces: yeni kod yok — regresyon kilidi.

> Bu görev kod yazmaz. Yeni yeteneklerin (açık taslak + LAUNCH_READY + kendi kendine kayıt) müşteri tarafında hiçbir kapı açmadığını kanıtlar. Kod değişikliği gerekiyorsa bir kural kırılmış demektir; onu düzelt.

- [ ] **Step 1: Kapalılık testini yaz**

`apps/api/test/category-supply-status-projection.spec.ts` sonuna. Üstteki import bloğuna `serviceRequestPayload` ekle (`createProviderProfile` zaten var):

```ts
describe('a LAUNCH_READY draft is still a draft', () => {
  it('stays out of the public catalogue, refuses requests and shows nobody anything', async () => {
    const category = await createCategory(ctx.prisma, 'Acik Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 4,
      providerEnrollmentOpen: true,
    });

    const provider = await createProviderProfile(ctx.prisma, { status: ProviderStatus.APPROVED });
    await ctx.prisma.providerServiceArea.create({
      data: { providerId: provider.id, city: 'İstanbul', district: 'Kadıköy' },
    });
    await ctx.prisma.providerServiceCategory.create({
      data: { providerId: provider.id, categoryId: category.id },
    });

    // It is LAUNCH_READY on the operator's panel...
    const cookie = await adminCookie();
    expect(await supplyStatusOf(cookie, category.slug)).toBe('LAUNCH_READY');

    // ...and nothing else about it has moved.
    const list = await request(ctx.server).get('/categories').expect(200);
    expect((list.body as Array<{ slug: string }>).map((row) => row.slug)).not.toContain(
      category.slug,
    );

    await request(ctx.server).get(`/categories/${category.slug}`).expect(404);

    // 404 rather than 403: an unreleased category is not there for anybody who
    // may not use it, and a distinguishable refusal would confirm the slug.
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const customerCookie = await loginAs(ctx.prisma, customer.id);
    await request(ctx.server)
      .post('/service-requests')
      .set('Cookie', customerCookie)
      .send(serviceRequestPayload(category.slug))
      .expect(404);

    // Signed out is the same answer.
    await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug))
      .expect(404);

    // No request means no matching, no offer and no fan-out. The mail spy is
    // the honest check that the last one did not happen.
    expect(ctx.notifications.sent).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Testi koş**

```bash
export $(grep -E '^(DATABASE_URL|AUTH_COOKIE_NAME)=' .env | xargs)
pnpm --filter @taktic/api exec vitest run test/category-supply-status-projection.spec.ts
```

Beklenen: PASS ilk denemede. Düşerse bir kural kırılmış demektir — testi değil kodu düzelt.

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/category-supply-status-projection.spec.ts
git commit -m "test(api): pin that an opened draft stays closed to customers"
```

---

### Task 10: Admin — arz durumu sütunu ve enrollment cümlesi

**Files:**
- Modify: `apps/admin/lib/api.ts`
- Modify: `apps/admin/app/categories/category-taxonomy.ts`
- Modify: `apps/admin/app/categories/page.tsx`
- Modify: `apps/admin/app/categories/[slug]/page.tsx`

**Interfaces:**
- Consumes: Task 4'ün `supplyStatus`, Task 1'in `providerEnrollmentOpen`.
- Produces:
  - `type CategorySupplyStatus = 'EMPTY' | 'SUPPLY_READY' | 'LAUNCH_READY' | 'LIVE'`
  - `SUPPLY_STATUS_LABELS: Record<CategorySupplyStatus, string>`
  - `supplyStatusBadgeClass(status: CategorySupplyStatus): string`
  - `enrollmentSentence(category: Category): string | null`

- [ ] **Step 1: Tipleri genişlet**

`apps/admin/lib/api.ts`, `Category` tipine:

```ts
  /**
   * Whether providers may sign themselves up for this service. Only editable on
   * a draft; a live service is always open and the API refuses a write that
   * says otherwise.
   */
  providerEnrollmentOpen: boolean;
  /**
   * Derived on every read from the category, its approved-provider count and
   * its price — never stored. `null` for groups, routers and closed categories,
   * which the question does not apply to. Present only on the operator view.
   */
  supplyStatus?: CategorySupplyStatus | null;
```

ve dosyaya:

```ts
export type CategorySupplyStatus = 'EMPTY' | 'SUPPLY_READY' | 'LAUNCH_READY' | 'LIVE';
```

- [ ] **Step 2: Sözlüğü yaz**

`apps/admin/app/categories/category-taxonomy.ts`, import'a `CategorySupplyStatus` ekle ve dosyaya:

```ts
/**
 * The supply question, in words.
 *
 * Deliberately a separate row from the release verdict below it. They answer
 * different questions — "is there anybody behind this" and "may this be
 * published" — and a category can be SUPPLY_READY and still not releasable
 * because it has no price. One badge for both would hide exactly that case.
 */
export const SUPPLY_STATUS_LABELS: Record<CategorySupplyStatus, string> = {
  EMPTY: 'Onaylı hizmet veren bekleniyor',
  SUPPLY_READY: 'Hizmet veren hazır · teklif kredisi tanımlanmalı',
  LAUNCH_READY: 'Yayına hazır',
  LIVE: 'Yayında',
};

export function supplyStatusBadgeClass(status: CategorySupplyStatus): string {
  if (status === 'LIVE' || status === 'LAUNCH_READY') return 'badge badge-good';
  if (status === 'SUPPLY_READY') return 'badge badge-warn';
  return 'badge badge-muted';
}

/**
 * What the enrollment switch adds to the supply sentence.
 *
 * `null` when there is nothing to add: a live service is always open, so saying
 * so on every row would be noise. A closed draft is the case worth a line,
 * because "nobody has applied" and "nobody may apply" look identical in the
 * count and are entirely different problems.
 */
export function enrollmentSentence(category: Category): string | null {
  if (category.kind !== 'LEAF' || category.status !== 'DRAFT') return null;
  if (!category.providerEnrollmentOpen) return 'Yeni hizmet veren başvurusu kapalı';
  if (category.supplyStatus === 'EMPTY') return 'Başvuruya açık, onaylı hizmet veren bekleniyor';
  return 'Başvuruya açık';
}
```

- [ ] **Step 3: Liste tablosuna sütunu ekle**

`apps/admin/app/categories/page.tsx`:

`<thead>` içinde `<th>Yayına hazır mı?</th>` satırından **önce**:

```tsx
                  <th>Arz durumu</th>
```

`<td>` sırasında, `blockers.length === 0 ? ...` hücresinden **önce**:

```tsx
                      {/*
                        The supply reading, next to the release verdict and not
                        merged into it: a draft can have its providers and still
                        be unreleasable for want of a price, and that is the row
                        somebody has to act on differently.
                      */}
                      <td data-testid={`supply-status-${category.slug}`}>
                        {category.supplyStatus ? (
                          <span className={supplyStatusBadgeClass(category.supplyStatus)}>
                            {SUPPLY_STATUS_LABELS[category.supplyStatus]}
                          </span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                        {enrollmentSentence(category) ? (
                          <div
                            className="muted"
                            data-testid={`enrollment-note-${category.slug}`}
                            style={{ fontSize: 12 }}
                          >
                            {enrollmentSentence(category)}
                          </div>
                        ) : null}
                      </td>
```

import satırına `SUPPLY_STATUS_LABELS`, `supplyStatusBadgeClass`, `enrollmentSentence` ekle.

- [ ] **Step 4: `LAUNCH_READY` olanları öne çıkar**

Aynı dosyada `draftReadiness` sıralamasını değiştir:

```tsx
  const draftReadiness = drafts
    .map((category) => ({ category, blockers: releaseBlockers(category) }))
    .sort((a, b) => {
      // Ready first: those are the rows somebody can act on today.
      if (a.blockers.length !== b.blockers.length) return a.blockers.length - b.blockers.length;
      // Then the ones whose supply is in place, so a release meeting reads the
      // actionable rows before the ones still waiting on a business.
      const rank = (entry: typeof a) => (entry.category.supplyStatus === 'LAUNCH_READY' ? 0 : 1);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return a.category.name.localeCompare(b.category.name, 'tr-TR');
    });
```

- [ ] **Step 5: Kategori detayına satırı ekle**

`apps/admin/app/categories/[slug]/page.tsx`, `release-checklist` `<dl>` içine bir çift:

```tsx
                  <dt>Arz durumu</dt>
                  <dd data-testid="supply-status">
                    {category.supplyStatus ? (
                      <span className={supplyStatusBadgeClass(category.supplyStatus)}>
                        {SUPPLY_STATUS_LABELS[category.supplyStatus]}
                      </span>
                    ) : (
                      <span className="muted">Bu kategori tipi için hesaplanmaz.</span>
                    )}
                    {enrollmentSentence(category) ? (
                      <div className="muted" data-testid="enrollment-note" style={{ fontSize: 12 }}>
                        {enrollmentSentence(category)}
                      </div>
                    ) : null}
                  </dd>
```

import satırına aynı üç ismi ekle.

- [ ] **Step 6: Derle**

```bash
pnpm --filter @taktic/admin typecheck && pnpm --filter @taktic/admin build
```

Beklenen: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/admin
git commit -m "feat(admin): show the derived supply status beside the release verdict"
```

---

### Task 11: Admin — enrollment onay kutusu

**Files:**
- Modify: `apps/admin/app/categories/[slug]/page.tsx` (kategori düzenleme formu)
- Modify: `apps/admin/app/categories/actions.ts` (`categoryPayload`)

**Interfaces:**
- Consumes: Task 5'in API alanı, Task 1'in `providerEnrollmentOpen` kolonu.
- Produces: kullanıcı arayüzü; yeni export yok.

- [ ] **Step 1: Forma onay kutusunu ekle**

`apps/admin/app/categories/[slug]/page.tsx`, "Teklif kredisi" alanının hemen ardına, çevresindeki `field` kalıbını izleyerek:

```tsx
                {/*
                  Editable on a draft service and nowhere else. A live service is
                  always open to applications — closing one would refuse every
                  profile save against it — so the box is shown ticked and
                  disabled rather than hidden, because "why can I not change
                  this" is a question the screen should answer where it is asked.
                */}
                <label className="field field-6">
                  <span>Hizmet veren başvurusu</span>
                  <input
                    name="providerEnrollmentOpen"
                    type="checkbox"
                    data-testid="provider-enrollment-open"
                    defaultChecked={
                      category.kind === 'LEAF' &&
                      (category.status === 'ACTIVE' || category.providerEnrollmentOpen)
                    }
                    disabled={!(category.kind === 'LEAF' && category.status === 'DRAFT')}
                  />
                  <span className="help-text">
                    {category.kind !== 'LEAF'
                      ? 'Yalnızca hizmet tipindeki kategoriler için geçerlidir.'
                      : category.status === 'ACTIVE'
                        ? 'Yayındaki hizmetlerde başvuru her zaman açıktır.'
                        : category.status === 'INACTIVE'
                          ? 'Kapalı hizmetler başvuruya açılamaz.'
                          : 'Açıkken hizmet verenler bu taslak hizmeti kendi profillerine ekleyebilir. Müşteri tarafı kapalı kalır.'}
                  </span>
                </label>
```

- [ ] **Step 2: `categoryPayload`'a alanı bağla**

`apps/admin/app/categories/actions.ts`, `categoryPayload` fonksiyonunda `status`'ü bir değişkene al ve alanı koşullu gönder. Fonksiyonun ilk satırını ve `status`/`offerCreditCost` satırlarını şununla değiştir:

```ts
function categoryPayload(formData: FormData) {
  const kind = readFormString(formData, 'kind') as CategoryKind;
  const status = readFormString(formData, 'status') as CategoryStatus;

  return {
    name: readFormString(formData, 'name'),
    slug: readFormString(formData, 'slug'),
    description: readOptionalFormString(formData, 'description'),
    imageUrl: readOptionalFormString(formData, 'imageUrl'),
    coverImageUrl: readOptionalFormString(formData, 'coverImageUrl'),
    iconKey: readOptionalFormString(formData, 'iconKey'),
    // Empty means "top level"; the API refuses a parent that is not a GROUP.
    parentId: readOptionalFormString(formData, 'parentId'),
    kind,
    status,
    sortOrder: readFormNumber(formData, 'sortOrder'),
    // Mandatory for a service, and only for a service. A group is a folder and
    // a router is a question — neither can ever be offered on, so neither has a
    // price, and sending one would be a number nothing reads. Sent as a number
    // so the API DTO's @IsInt/@Min(1) rejects empty, zero, negative and
    // non-numeric input rather than the value silently becoming null.
    ...(kind === 'LEAF' ? { offerCreditCost: readFormNumber(formData, 'offerCreditCost') } : {}),
    // Only sent where the API will take it. A live service is always open and
    // refuses the field, so sending it there would turn every unrelated edit of
    // a released category into a 400. `kind` and `status` come off this same
    // form, so the condition is asked of the category the save produces —
    // which is the row the API judges too.
    ...(kind === 'LEAF' && status === 'DRAFT'
      ? {
          providerEnrollmentOpen:
            readFormString(formData, 'providerEnrollmentOpen') === 'on',
        }
      : {}),
  };
}
```

> Bir işaretlenmemiş checkbox `FormData`'ya hiç girmez, dolayısıyla `readFormString` `''` döner ve karşılaştırma `false` verir. Kutunun kapatılması bu yüzden çalışır.

- [ ] **Step 3: Derle**

```bash
pnpm --filter @taktic/admin typecheck && pnpm --filter @taktic/admin build
```

Beklenen: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/admin
git commit -m "feat(admin): let an operator open a draft service to applications"
```

---

### Task 12: Web — kayıt ve profil formları kayıt kataloğunu kullansın

**Files:**
- Modify: `apps/web/lib/api.ts`
- Modify: `apps/web/app/providers/register/page.tsx`
- Modify: `apps/web/app/providers/[id]/edit/page.tsx`

**Interfaces:**
- Consumes: Task 6'nın ucu, Task 8'in `upcomingServiceCategories`.
- Produces: `type ProviderEnrollmentCategory` (web tarafı).

- [ ] **Step 1: Tipi ekle**

`apps/web/lib/api.ts`:

```ts
/**
 * A service as the application form offers it.
 *
 * Narrower than `Category` on purpose and served by its own endpoint: it says
 * what a business needs to pick a service and nothing about how ready that
 * service is, which is the operator's question.
 */
export type ProviderEnrollmentCategory = {
  id: string;
  name: string;
  slug: string;
  iconKey: string | null;
  imageUrl: string | null;
  parent: { id: string; name: string; slug: string } | null;
  /** LIVE takes requests today; UPCOMING has not been released yet. */
  availability: 'LIVE' | 'UPCOMING';
};
```

`ProviderProfile` tipine:

```ts
  /**
   * Unreleased services this provider has joined. Present on the owner's and
   * the operator's view only — a stranger is told nothing about them.
   */
  upcomingServiceCategories?: ProviderServiceCategory[];
```

- [ ] **Step 2: Kayıt sayfasını çevir**

`apps/web/app/providers/register/page.tsx`:

```ts
    apiFetch<ProviderEnrollmentCategory[]>('/categories/provider-enrollment'),
```

ve `categories` tipini `ProviderEnrollmentCategory[]` yap; `Category` import'unu kullanılmıyorsa kaldır.

Seçim çipini `availability`'yi gösterecek şekilde değiştir:

```tsx
                      {categories.map((category) => (
                        <label className="check-chip" key={category.id}>
                          <input name="categoryIds" type="checkbox" value={category.id} />
                          <span>{category.name}</span>
                          {/*
                            Said on the chip rather than in a footnote: a
                            business ticking a service that cannot take a request
                            yet has to know that before they submit, not after
                            they wonder why nothing arrives.
                          */}
                          {category.availability === 'UPCOMING' ? (
                            <span className="check-chip-note">Yakında açılacak</span>
                          ) : null}
                        </label>
                      ))}
```

- [ ] **Step 3: Profil düzenleme sayfasını çevir**

`apps/web/app/providers/[id]/edit/page.tsx`:

```ts
    apiFetch<ProviderEnrollmentCategory[]>('/categories/provider-enrollment'),
```

**ve seçili id kümesini düzelt** — bu adım kritik: owner'ın `serviceCategories`'i taslakları içermez, dolayısıyla kendi seçtiği taslak formda işaretsiz gelir ve bir sonraki kayıtta sessizce silinir.

```ts
  // Both lists, because the form replaces the whole selection: a draft the
  // provider signed up for lives in `upcomingServiceCategories`, and leaving it
  // unticked here would drop it on the next save without anybody asking for it.
  const selectedCategoryIds = new Set([
    ...provider.serviceCategories.map((item) => item.category.id),
    ...(provider.upcomingServiceCategories ?? []).map((item) => item.category.id),
  ]);
```

Çipe aynı `availability` notunu ekle:

```tsx
              <label className="check-chip" key={category.id}>
                <input
                  name="categoryIds"
                  type="checkbox"
                  value={category.id}
                  defaultChecked={selectedCategoryIds.has(category.id)}
                />
                <span>{category.name}</span>
                {category.availability === 'UPCOMING' ? (
                  <span className="check-chip-note">Yakında açılacak</span>
                ) : null}
              </label>
```

- [ ] **Step 4: `check-chip-note` stilini ekle**

`apps/web` global stil dosyasında (`check-chip` tanımının yanına):

```css
.check-chip-note {
  font-size: 11px;
  opacity: 0.7;
  margin-left: 6px;
}
```

- [ ] **Step 5: Derle**

```bash
pnpm --filter @taktic/web typecheck && pnpm --filter @taktic/web build
```

Beklenen: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "feat(web): offer opened draft services on the provider application forms"
```

---

### Task 13: Web — "Yakında açılacak hizmetlerim"

**Files:**
- Modify: `apps/web/app/providers/[id]/page.tsx`

**Interfaces:**
- Consumes: Task 8'in `upcomingServiceCategories`, Task 12'nin tipi.
- Produces: kullanıcı arayüzü.

- [ ] **Step 1: Bölümü ekle**

`apps/web/app/providers/[id]/page.tsx`, "Hizmet kapsamı" bloğunun hemen ardına, "Hizmet bölgeleri" başlığından önce:

```tsx
            {/*
              The services this provider joined before the marketplace released
              them. Its own block rather than a badge in the list above, because
              the two lists behave differently: one brings requests today and the
              other brings none at all, and a chip that looked the same would
              read as "no requests yet" instead of "not open yet".

              One sentence and no numbers. How many businesses stand behind an
              unreleased service, and whether it is close to launching, is the
              operator's panel — nothing about a provider joining one makes that
              figure theirs.
            */}
            {(provider.upcomingServiceCategories ?? []).length > 0 ? (
              <>
                <h2 style={{ marginTop: 8 }}>Yakında açılacak hizmetlerim</h2>
                <div className="pdash-chip-list" data-testid="upcoming-service-categories">
                  {provider.upcomingServiceCategories!.map((item) => (
                    <span className="tag tag-neutral" key={item.id}>
                      {item.category.name}
                    </span>
                  ))}
                </div>
                <p className="pdash-card-sub">Yakında açılacak — henüz talep alamaz.</p>
              </>
            ) : null}
```

- [ ] **Step 2: Kategori sayacının taslak saymadığını doğrula**

Aynı dosyadaki sağ raydaki "Kategori" metriği `provider.serviceCategories.length` okuyor. Değiştirme: o sayaç eşleşmeye giren kategorileri sayar, ve taslakları eklemek "bu kadar kategoriden talep gelmeli" beklentisi yaratır. Bir yorum bırak:

```tsx
                <span className="metric-value" style={{ fontSize: 24 }}>
                  {/* Live categories only: an unreleased one brings no request,
                      so counting it here would promise matches that cannot come. */}
                  {provider.serviceCategories.length}
                </span>
```

- [ ] **Step 3: Derle**

```bash
pnpm --filter @taktic/web typecheck && pnpm --filter @taktic/web build
```

Beklenen: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web
git commit -m "feat(web): tell a provider which of their services is not open yet"
```

---

### Task 14: E2E — admin ekranı ve kendi kendine kayıt

**Files:**
- Create: `e2e/tests/category-supply-status.spec.ts`
- Create: `e2e/tests/provider-enrollment-self-service.spec.ts`

**Interfaces:**
- Consumes: Task 10–13.
- Produces: yeni export yok.

> Yardımcıların gerçek imzaları: `createCategory(offerCreditCost: number, { kind?, status?, namePrefix?, providerEnrollmentOpen? })` (son alan Task 1'de eklendi), `createProvider({ categoryId, location, credits })` → `{ id, userId, email, password, businessName }`, `createAdmin()` → `{ email, password, ... }`, `Actor.open(browser, 'web' | 'admin', primaryRuntime)`, `actor.gotoWeb(path)`, `actor.gotoAdmin(path)`, `actor.loginToWeb(email, password)`, `actor.loginToAdmin(email, password)`.

- [ ] **Step 1: Admin ekranı testini yaz**

`e2e/tests/category-supply-status.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { Actor } from '../src/actors';
import {
  createAdmin,
  createCategory,
  createProvider,
  prisma,
  uniqueLocation,
} from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * The four supply readings on the screen an operator signs a release off on.
 *
 * The rules themselves are pinned in the API suite. What only a browser can
 * show is that the panel says two different things at once — a row can read
 * "Hizmet veren hazır" and "Hazır değil" together — and that collapsing them
 * into one verdict is exactly what this column exists to prevent.
 */

test.describe('the supply readiness column', () => {
  test('walks EMPTY → SUPPLY_READY → LAUNCH_READY without losing the release verdict', async ({
    browser,
  }) => {
    // The fixture insists on a price, so the unpriced state is produced by
    // clearing it — which is also the state a freshly imported draft is in.
    const service = await createCategory(4, { status: 'DRAFT', namePrefix: 'E2E Arz' });
    await prisma().serviceCategory.update({
      where: { id: service.id },
      data: { offerCreditCost: null },
    });

    const adminAccount = await createAdmin();
    const admin = await Actor.open(browser, 'admin', primaryRuntime);

    try {
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin('/categories');

      await expect(admin.page.getByTestId(`supply-status-${service.slug}`)).toContainText(
        'Onaylı hizmet veren bekleniyor',
      );

      // An approved provider arrives; the price does not.
      const liveCategory = await createCategory(3);
      const providerAccount = await createProvider({
        categoryId: liveCategory.id,
        location: uniqueLocation(),
        credits: 0,
      });
      await prisma().providerServiceCategory.create({
        data: { providerId: providerAccount.id, categoryId: service.id },
      });

      await admin.gotoAdmin('/categories');
      await expect(admin.page.getByTestId(`supply-status-${service.slug}`)).toContainText(
        'teklif kredisi tanımlanmalı',
      );
      // Still red on the release column, and that is the whole point of two.
      await expect(admin.page.getByTestId(`release-row-${service.slug}`)).toContainText(
        'Hazır değil',
      );

      await prisma().serviceCategory.update({
        where: { id: service.id },
        data: { offerCreditCost: 4 },
      });

      await admin.gotoAdmin('/categories');
      await expect(admin.page.getByTestId(`supply-status-${service.slug}`)).toContainText(
        'Yayına hazır',
      );
      await expect(
        admin.page.getByTestId(`release-row-${service.slug}`).getByText('Hazır', { exact: true }),
      ).toBeVisible();
    } finally {
      await admin.close();
    }
  });

  test('says when a draft is not even taking applications, and when it starts', async ({
    browser,
  }) => {
    const closed = await createCategory(4, { status: 'DRAFT', namePrefix: 'E2E Kapali Basvuru' });
    const adminAccount = await createAdmin();
    const admin = await Actor.open(browser, 'admin', primaryRuntime);

    try {
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin('/categories');
      await expect(admin.page.getByTestId(`enrollment-note-${closed.slug}`)).toContainText(
        'Yeni hizmet veren başvurusu kapalı',
      );

      // Opened through the product, on the screen that owns the switch.
      await admin.gotoAdmin(`/categories/${closed.slug}`);
      await admin.page.getByTestId('provider-enrollment-open').check();
      await admin.page.getByRole('button', { name: 'Kategoriyi kaydet' }).click();

      await admin.gotoAdmin('/categories');
      await expect(admin.page.getByTestId(`enrollment-note-${closed.slug}`)).toContainText(
        'Başvuruya açık, onaylı hizmet veren bekleniyor',
      );
    } finally {
      await admin.close();
    }
  });

  test('shows a live service as LIVE and offers no switch to close it', async ({ browser }) => {
    const live = await createCategory(3, { namePrefix: 'E2E Yayinda' });
    const adminAccount = await createAdmin();
    const admin = await Actor.open(browser, 'admin', primaryRuntime);

    try {
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin(`/categories/${live.slug}`);

      await expect(admin.page.getByTestId('supply-status')).toContainText('Yayında');

      const box = admin.page.getByTestId('provider-enrollment-open');
      await expect(box).toBeChecked();
      await expect(box).toBeDisabled();
    } finally {
      await admin.close();
    }
  });
});
```



- [ ] **Step 2: Kendi kendine kayıt testini yaz**

`e2e/tests/provider-enrollment-self-service.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { createCategory, createProvider, prisma, uniqueLocation } from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * The repairer this feature was built for: they find the marketplace, open the
 * application form, and the service they actually do is one the marketplace has
 * not released yet.
 *
 * Two halves, and both matter. They can tick it — that is the supply problem
 * being solved — and their own panel then says what they joined, because a
 * category that disappears the moment it is chosen reads as a bug rather than
 * as a release process.
 */

test.describe('signing up for an unreleased service', () => {
  test('an applicant is offered an opened draft, told it is not open yet, and never shown a closed one', async ({
    browser,
  }) => {
    const openDraft = await createCategory(4, {
      status: 'DRAFT',
      namePrefix: 'E2E Acik Taslak',
      providerEnrollmentOpen: true,
    });
    const closedDraft = await createCategory(4, {
      status: 'DRAFT',
      namePrefix: 'E2E Kapali Taslak',
    });

    // Signed out on purpose: this is the applicant with no account yet, and the
    // form they land on is the one this endpoint exists to feed.
    const applicant = await Actor.open(browser, 'web', primaryRuntime);

    try {
      await applicant.gotoWeb('/providers/register');
      await assertNoErrorScreen(applicant.page);

      const openChip = applicant.page.locator('.check-chip', { hasText: openDraft.name });
      await expect(openChip).toBeVisible();
      await expect(openChip).toContainText('Yakında açılacak');

      // A draft nobody opened is not on the form at all.
      await expect(
        applicant.page.locator('.check-chip', { hasText: closedDraft.name }),
      ).toHaveCount(0);
    } finally {
      await applicant.close();
    }
  });

  test('the provider’s own panel lists it as upcoming, with no supply figure', async ({
    browser,
  }) => {
    const openDraft = await createCategory(4, {
      status: 'DRAFT',
      namePrefix: 'E2E Panel Taslak',
      providerEnrollmentOpen: true,
    });
    const liveCategory = await createCategory(3);
    const providerAccount = await createProvider({
      categoryId: liveCategory.id,
      location: uniqueLocation(),
      credits: 0,
    });

    await prisma().providerServiceCategory.create({
      data: { providerId: providerAccount.id, categoryId: openDraft.id },
    });

    const provider = await Actor.open(browser, 'web', primaryRuntime);

    try {
      await provider.loginToWeb(providerAccount.email, providerAccount.password);
      await provider.gotoWeb(`/providers/${providerAccount.id}`);
      await assertNoErrorScreen(provider.page);

      await expect(provider.page.getByTestId('upcoming-service-categories')).toContainText(
        openDraft.name,
      );
      await expect(
        provider.page.getByText('Yakında açılacak — henüz talep alamaz.'),
      ).toBeVisible();

      // The operational figures stay on the operator's panel.
      const body = await provider.page.locator('body').innerText();
      expect(body).not.toContain('Onaylı hizmet veren');
      expect(body).not.toContain('Yayına hazır');
    } finally {
      await provider.close();
    }
  });

  test('a profile save keeps the upcoming service the provider chose', async ({ browser }) => {
    const openDraft = await createCategory(4, {
      status: 'DRAFT',
      namePrefix: 'E2E Kalici Taslak',
      providerEnrollmentOpen: true,
    });
    const liveCategory = await createCategory(3);
    const providerAccount = await createProvider({
      categoryId: liveCategory.id,
      location: uniqueLocation(),
      credits: 0,
    });

    await prisma().providerServiceCategory.create({
      data: { providerId: providerAccount.id, categoryId: openDraft.id },
    });

    const provider = await Actor.open(browser, 'web', primaryRuntime);

    try {
      await provider.loginToWeb(providerAccount.email, providerAccount.password);
      // The edit form pre-ticks both lists; saving it unchanged must not quietly
      // drop the draft, which is what it did before the form read both.
      await provider.gotoWeb(`/providers/${providerAccount.id}/edit`);
      await assertNoErrorScreen(provider.page);

      const draftBox = provider.page.locator('.check-chip', { hasText: openDraft.name }).locator('input');
      await expect(draftBox).toBeChecked();

      await provider.page.getByRole('button', { name: 'Profili Kaydet' }).click();

      await provider.gotoWeb(`/providers/${providerAccount.id}`);
      await expect(provider.page.getByTestId('upcoming-service-categories')).toContainText(
        openDraft.name,
      );
    } finally {
      await provider.close();
    }
  });
});
```



- [ ] **Step 3: Yeni e2e testlerini koş**

```bash
export $(grep -E '^(DATABASE_URL|AUTH_COOKIE_NAME)=' .env | xargs)
pnpm build && pnpm --filter @taktic/e2e e2e category-supply-status provider-enrollment-self-service
```

Beklenen: PASS.

- [ ] **Step 4: Tüm e2e paketini koş**

```bash
export $(grep -E '^(DATABASE_URL|AUTH_COOKIE_NAME)=' .env | xargs)
pnpm e2e
```

Beklenen: PASS. `provider-draft-category-binding`, `provider-invite-links`, `category-release-readiness`, `category-wave-2-drafts` yeşil kalmalı.

- [ ] **Step 5: Commit**

```bash
git add e2e
git commit -m "test(e2e): cover the supply column and provider self-enrollment"
```

---

### Task 15: Kapanış doğrulaması

**Files:** yok — doğrulama görevi.

- [ ] **Step 1: Tam preflight**

```bash
export $(grep -E '^(DATABASE_URL|AUTH_COOKIE_NAME)=' .env | xargs)
pnpm typecheck && pnpm test && pnpm build
```

Beklenen: üçü de PASS.

- [ ] **Step 2: Sızıntı taraması**

```bash
grep -rn "supplyStatus\|approvedProviderCount" apps/web/app apps/web/lib --include='*.ts' --include='*.tsx'
```

Beklenen: **çıktı yok**. Web uygulaması bu alanları hiç bilmemeli.

- [ ] **Step 3: Migration zincirini doğrula**

```bash
export $(grep -E '^(DATABASE_URL|AUTH_COOKIE_NAME)=' .env | xargs)
pnpm exec prisma migrate status
```

Beklenen: uygulanmamış migration yok, drift yok.

- [ ] **Step 4: Diff'i gözden geçir**

```bash
git diff main --stat
```

Beklenen: yalnız plandaki dosyalar. `.env` **listede olmamalı**.

---

## Kapsam dışı (yapılmayacak)

- Kategori aktivasyonunda otomatik yayın veya otomatik enrollment yazımı.
- Enrollment bayrağının davet linki üretimini etkilemesi.
- Gerçek dev veritabanında import, provider atama, kategori aktivasyonu, davet veya e-posta.
- Push, PR, merge, deploy, container recreate.
