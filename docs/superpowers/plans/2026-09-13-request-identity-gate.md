# Talep formlarında erken kimlik kontrolü ve taslakla devam — uygulama planı

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Misafir, vitrin veya normal talep formunu doldururken telefon + e-posta girildiği anda kimlik durumunu öğrensin; hesabı varsa giriş yapıp / etkinleştirip kaldığı yerden devam etsin; formun sonunda "telefon/e-posta kayıtlı" hatası asla görmesin.

**Architecture:** API'de tek `POST /auth/request-identity-check` (telefon + e-posta birlikte sınıflandırma) ve `…/activate` (alıcı yalnız DB e-postası); sunucu tarafı `RequestDraft` (HttpOnly cookie'de opak token, `expectedUserId` ile kilitli, tarayıcı başına tek aktif satır, talep transaction'ında tüketim). Web'de iletişim bölümü iki formda ilk sıraya alınır; ortak `useIdentityCheck` + `IdentityNotice` gate'i `ok` olmadan ilerlemeyi/SMS'i kilitler; taslak login/aktivasyon dönüşünde `defaultValue` ile geri yüklenir.

**Tech Stack:** NestJS 11 + Prisma 6 + `@nestjs/throttler` 6 (API), Next 15 / React 19 server actions (web), Vitest, Playwright (Chromium + WebKit).

**Spec:** `docs/superpowers/specs/2026-09-13-request-identity-gate-design.md` — her görev bu spec'e bağlıdır; çelişkide spec kazanır.

## Global Constraints

- Tek migration: `RequestDraft` tablosu + `RequestDraftFormType` enum; mevcut tablolara dokunulmaz. `prisma migrate dev --create-only` ile üretilir, SQL elle doğrulanır.
- Yeni env: `REQUEST_DRAFT_MAX_ACTIVE` (API, varsayılan `10000`), `WEB_TRUST_PROXY` (web, varsayılan kapalı). `.env`, compose, Lemon/Resend/Cloudflare dosyalarına dokunulmaz.
- `resolveCustomerForCreate` kuralı değişmez; yalnız iki `ConflictException` gövdesine `code: 'CUSTOMER_IDENTITY_CONFLICT'` eklenir.
- Kimlik ucu yanıtı yalnız `{ status }`: `new-customer | login-required | activation-required | identity-conflict | unavailable`.
- `activate` her koşulda `202 { status: 'accepted' }`; alıcı yalnız veritabanındaki `User.email`.
- Taslak payload'ında iletişim/disclosure anahtarı yok; URL ve `localStorage`'a PII/token yazılmaz; cookie adı `taktic_request_draft`, HttpOnly, SameSite=Lax, `secure: NODE_ENV==='production' || https`.
- Taslak silinme yolları (kapalı liste): TTL, açık Vazgeç, başarılı talep, onaylı `replace`, beklenen kullanıcı silindi (Cascade). `wrong-account` silmez.
- IP kimliği yalnız API'nin mevcut `trust proxy` + `AuthThrottlerGuard.getTracker` yolundan; web XFF üretmez.
- Misafirde gate atlanamaz (`enabled = accountContact === null`); ağ hatası `ok` sayılmaz.
- Ekran metinleri spec §2.2'deki gibi, harfi harfine.
- Her görev sonunda: ilgili paketin `vitest`/`tsc` yeşil, sonra commit. Commit mesajları Türkçe, sonunda `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Worktree'de API testleri için: `export DATABASE_URL='postgresql://taktic_user:taktic_password@localhost:5433/taktic?schema=public'` ve ilk kez `pnpm db:generate`. E2E her zaman `pnpm --filter @taktic/e2e e2e` (prepare-database içerir); tek spec için `pnpm --filter @taktic/e2e exec playwright test <isim> --project=chromium`.

## Dosya yapısı

**API (yeni)**
- `apps/api/src/modules/auth/request-identity.service.ts` — `classify()`; tek sorumluluk: iki kullanıcı satırını birlikte sınıflandırmak.
- `apps/api/src/modules/auth/request-identity.controller.ts` — iki uç; guard ve DTO'lar.
- `apps/api/src/modules/auth/dto/request-identity.dto.ts`
- `apps/api/src/modules/request-drafts/request-drafts.module.ts`, `request-drafts.controller.ts`, `request-drafts.service.ts`, `request-draft.cookie.ts`, `request-draft.throttler.ts`, `dto/create-request-draft.dto.ts`, `request-drafts.constants.ts`
- Testler: `apps/api/test/request-identity.spec.ts`, `apps/api/test/request-drafts.spec.ts`

**API (değişen)**
- `prisma/schema.prisma`, `prisma/migrations/20260913120000_add_request_draft/migration.sql`
- `apps/api/src/modules/auth/auth.module.ts` (service/controller kaydı, export)
- `apps/api/src/modules/customer-activation/customer-activation.service.ts` (`redirectTo`)
- `apps/api/src/modules/service-requests/service-requests.service.ts` (`code`, `draftToken`), `service-requests.controller.ts`, `service-requests.module.ts`
- `apps/api/src/modules/showcase/showcase-public.controller.ts`, `showcase-lead.service.ts` (`draftToken` geçişi)
- `apps/api/src/app.module.ts` (`RequestDraftsModule`)

**Web (yeni)**
- `apps/web/lib/request-refusal-text.ts` (eski `showcase-lead-errors.ts` yerine), `apps/web/lib/request-drafts.ts` (server actions + cookie), `apps/web/lib/forwarded-for.ts`
- `apps/web/app/request-fields/identity-check.ts` (hook + saf reducer), `identity-notice.tsx`
- `apps/web/app/api/auth/request-identity-check/route.ts`, `…/activate/route.ts`
- Testler: `apps/web/test/request-refusal-text.spec.ts`, `apps/web/test/forwarded-for.spec.ts`, `apps/web/test/identity-check.spec.ts`

**Web (değişen)**
- `apps/web/app/request-fields/contact-section.tsx`, `question-field.tsx`, `description-field.tsx`, `timing-fields.tsx`, `apps/web/app/categories/[slug]/budget-fields.tsx`
- `apps/web/app/categories/[slug]/page.tsx`, `request-form.tsx`, `apps/web/app/categories/actions.ts`
- `apps/web/app/vitrin/[cardId]/page.tsx`, `lead-form.tsx`, `actions.ts`
- `apps/web/app/activate-customer/page.tsx`, `actions.ts`
- `apps/web/app/globals.css`

**E2E**
- `e2e/src/journeys.ts` (iletişim adımı önce), `e2e/tests/request-identity-gate.spec.ts` (yeni), sıraya bağlı mevcut spec'ler.

---

### Task 1: `RequestDraft` şeması ve migration

**Files:**
- Modify: `prisma/schema.prisma` (User modeline iki back-relation; dosya sonuna enum + model)
- Create: `prisma/migrations/20260913120000_add_request_draft/migration.sql`

**Interfaces:**
- Produces: Prisma modeli `prisma.requestDraft` alanları `id, tokenHash, formType, categorySlug, cardId, payload, expectedUserId, userId, expiresAt, consumedAt, createdAt`; enum `RequestDraftFormType { MARKETPLACE, SHOWCASE_LEAD }`.

- [ ] **Step 1: Şemaya modeli ekle**

`prisma/schema.prisma` içinde `model User { … }` bloğuna, `activationTokens` satırının hemen altına ekle:

```prisma
  requestDraftsExpected         RequestDraft[]                     @relation("RequestDraftExpectedUser")
  requestDrafts                 RequestDraft[]                     @relation("RequestDraftUser")
```

Dosyanın sonuna ekle:

```prisma
/// Which request form a draft belongs to. The form page asks for its own kind
/// only, so a marketplace draft can never prefill a vitrin lead or vice versa.
enum RequestDraftFormType {
  MARKETPLACE
  SHOWCASE_LEAD
}

/// A request form saved server-side while its author goes away to sign in or
/// to activate an account, and restored when they come back.
///
/// The browser holds only an opaque token (HttpOnly cookie); the row holds the
/// token's hash. `payload` never carries contact fields. `expectedUserId` is
/// the account the identity check found — set by the server, never by a
/// client — and the only session allowed to open the draft; it cascades so a
/// deleted account can never leave a protected draft behind as an anonymous
/// one. `userId` is the account the draft actually ended up bound to.
model RequestDraft {
  id             String               @id @default(cuid())
  tokenHash      String               @unique
  formType       RequestDraftFormType
  categorySlug   String
  cardId         String?
  payload        Json
  expectedUserId String?
  userId         String?
  expiresAt      DateTime
  consumedAt     DateTime?
  createdAt      DateTime             @default(now())

  expectedUser User? @relation("RequestDraftExpectedUser", fields: [expectedUserId], references: [id], onDelete: Cascade)
  user         User? @relation("RequestDraftUser", fields: [userId], references: [id], onDelete: SetNull)

  @@index([expiresAt])
  @@index([expectedUserId])
  @@index([userId])
}
```

- [ ] **Step 2: Migration SQL'ini yaz**

`prisma/migrations/20260913120000_add_request_draft/migration.sql`:

```sql
-- CreateEnum
CREATE TYPE "RequestDraftFormType" AS ENUM ('MARKETPLACE', 'SHOWCASE_LEAD');

-- CreateTable
CREATE TABLE "RequestDraft" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "formType" "RequestDraftFormType" NOT NULL,
    "categorySlug" TEXT NOT NULL,
    "cardId" TEXT,
    "payload" JSONB NOT NULL,
    "expectedUserId" TEXT,
    "userId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequestDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RequestDraft_tokenHash_key" ON "RequestDraft"("tokenHash");
CREATE INDEX "RequestDraft_expiresAt_idx" ON "RequestDraft"("expiresAt");
CREATE INDEX "RequestDraft_expectedUserId_idx" ON "RequestDraft"("expectedUserId");
CREATE INDEX "RequestDraft_userId_idx" ON "RequestDraft"("userId");

-- AddForeignKey
ALTER TABLE "RequestDraft" ADD CONSTRAINT "RequestDraft_expectedUserId_fkey" FOREIGN KEY ("expectedUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RequestDraft" ADD CONSTRAINT "RequestDraft_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

- [ ] **Step 3: Şema ile SQL'in eşleştiğini doğrula**

Run: `export DATABASE_URL='postgresql://taktic_user:taktic_password@localhost:5433/taktic?schema=public'; pnpm db:generate && npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$DATABASE_URL"`
Expected: `No difference detected.` (fark çıkarsa SQL'i şemaya göre düzelt; şemayı SQL'e uydurma). Yerel DB'ye **uygulama**; test veritabanı harness tarafından migrate edilir.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260913120000_add_request_draft/migration.sql
git commit -m "feat(prisma): RequestDraft tablosu — sunucu tarafı talep taslağı

expectedUserId ON DELETE CASCADE (koruma ilişkisi asla anonimleşmez),
userId ON DELETE SET NULL (tarihsel bağ).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `RequestIdentityService` — telefon + e-posta birlikte sınıflandırma

**Files:**
- Create: `apps/api/src/modules/auth/request-identity.service.ts`
- Create: `apps/api/src/modules/auth/dto/request-identity.dto.ts`
- Create: `apps/api/src/modules/auth/request-identity.controller.ts`
- Modify: `apps/api/src/modules/auth/auth.module.ts`
- Test: `apps/api/test/request-identity.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export type RequestIdentityStatus =
    | 'new-customer' | 'login-required' | 'activation-required' | 'identity-conflict' | 'unavailable';
  export type RequestIdentityResult = { status: RequestIdentityStatus; matchedCustomerId: string | null };
  class RequestIdentityService {
    classify(db: Prisma.TransactionClient | PrismaService, input: { phone: string; email: string }): Promise<RequestIdentityResult>;
    normalize(input: { phone: string; email: string }): { phone: string; email: string };
  }
  ```
  `AuthModule` `RequestIdentityService`'i export eder. Uç: `POST /auth/request-identity-check` → `{ status }`.

- [ ] **Step 1: Başarısız testi yaz**

`apps/api/test/request-identity.spec.ts`:

```ts
import { CustomerOrigin, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, createUser, resetDatabase, type TestContext } from './harness';

/**
 * One endpoint answers "who is this telephone number + e-mail pair" with one of
 * five product states and nothing else. The matrix below is the whole
 * contract; every case that resolveCustomerForCreate would refuse or attach
 * is named here before a form is filled in.
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
});

function check(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return request(ctx.server).post('/auth/request-identity-check').set(headers).send(body);
}

const FRESH = { phone: '05551110001', email: 'fresh@example.test' };

async function activeCustomer(phone: string, email: string) {
  return createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone, email });
}

async function claimableCustomer(phone: string, email: string) {
  return createUser(ctx.prisma, {
    role: UserRole.CUSTOMER,
    phone,
    email,
    password: null,
    customerOrigin: CustomerOrigin.AUTO_CREATED_REQUEST,
  });
}

describe('POST /auth/request-identity-check', () => {
  it('answers new-customer when neither the number nor the address is known', async () => {
    const response = await check(FRESH);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'new-customer' });
  });

  it('requires both fields', async () => {
    expect((await check({ phone: FRESH.phone })).status).toBe(400);
    expect((await check({ email: FRESH.email })).status).toBe(400);
    expect((await check({ ...FRESH, extra: 1 })).status).toBe(400);
  });

  it('answers login-required for an active customer matched by phone, by e-mail, or by both', async () => {
    await activeCustomer('05551110002', 'active@example.test');

    expect((await check({ phone: '05551110002', email: 'other@example.test' })).body).toEqual({ status: 'login-required' });
    expect((await check({ phone: '05551110003', email: 'active@example.test' })).body).toEqual({ status: 'login-required' });
    expect((await check({ phone: '05551110002', email: 'ACTIVE@example.test ' })).body).toEqual({ status: 'login-required' });
  });

  it('answers activation-required for a claimable, password-less account', async () => {
    await claimableCustomer('05551110004', 'claim@example.test');

    expect((await check({ phone: '05551110004', email: 'else@example.test' })).body).toEqual({ status: 'activation-required' });
    expect((await check({ phone: '05551110005', email: 'claim@example.test' })).body).toEqual({ status: 'activation-required' });
  });

  it('answers identity-conflict when the two fields point at two different customer accounts', async () => {
    await activeCustomer('05551110006', 'a@example.test');
    await claimableCustomer('05551110007', 'b@example.test');

    expect((await check({ phone: '05551110006', email: 'b@example.test' })).body).toEqual({ status: 'identity-conflict' });
    expect((await check({ phone: '05551110007', email: 'a@example.test' })).body).toEqual({ status: 'identity-conflict' });
  });

  it('answers unavailable for a provider, an admin, or an inactive account — without saying which', async () => {
    await createUser(ctx.prisma, { role: UserRole.PROVIDER, phone: '05551110008', email: 'prov@example.test' });
    await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN, phone: '05551110009', email: 'adm@example.test' });
    await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: '05551110010', email: 'off@example.test', isActive: false });

    for (const body of [
      { phone: '05551110008', email: FRESH.email },
      { phone: FRESH.phone, email: 'adm@example.test' },
      { phone: '05551110010', email: 'off@example.test' },
      // A provider on one side and a customer on the other is still unavailable.
      { phone: '05551110008', email: 'off@example.test' },
    ]) {
      const response = await check(body);
      expect(response.body).toEqual({ status: 'unavailable' });
    }
  });

  it('never returns anything but the status', async () => {
    await activeCustomer('05551110011', 'leak@example.test');
    const response = await check({ phone: '05551110011', email: 'leak@example.test' });
    expect(Object.keys(response.body)).toEqual(['status']);
  });

  it('is rate limited per client, and a forged X-Forwarded-For does not open a new bucket', async () => {
    // The test app runs without TRUST_PROXY, exactly like a default deployment:
    // Express ignores the header, so every request below shares one tracker.
    let last = 0;
    for (let index = 0; index < 12; index += 1) {
      const response = await check(FRESH, { 'x-forwarded-for': `10.0.0.${index}` });
      last = response.status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu gör**

Run: `cd apps/api && npx vitest run test/request-identity.spec.ts`
Expected: FAIL — `404 Cannot POST /auth/request-identity-check` (ilk test).

- [ ] **Step 3: DTO'yu yaz**

`apps/api/src/modules/auth/dto/request-identity.dto.ts`:

```ts
import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * The pair the request form asks about. Both are mandatory on purpose: the
 * answer is about the *pair* (two fields pointing at two accounts is its own
 * state), and a single-field lookup would be a plain "is this registered"
 * oracle.
 */
export class RequestIdentityCheckDto {
  @IsString()
  @MinLength(7)
  @MaxLength(20)
  phone!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @IsNotEmpty()
  @IsEmail()
  email!: string;
}

export class RequestIdentityActivateDto extends RequestIdentityCheckDto {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  redirectTo?: string;
}
```

- [ ] **Step 4: Servisi yaz**

`apps/api/src/modules/auth/request-identity.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { CustomerOrigin, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizePhoneNumber } from '../phone-verification/phone.util';

export type RequestIdentityStatus =
  | 'new-customer'
  | 'login-required'
  | 'activation-required'
  | 'identity-conflict'
  | 'unavailable';

export type RequestIdentityResult = {
  status: RequestIdentityStatus;
  /** Server-side only. Never part of any response body. */
  matchedCustomerId: string | null;
};

type Row = {
  id: string;
  role: UserRole;
  isActive: boolean;
  passwordHash: string | null;
  customerOrigin: CustomerOrigin | null;
};

type RowKind = 'none' | 'active' | 'claimable' | 'blocked';

const rowSelect = {
  id: true,
  role: true,
  isActive: true,
  passwordHash: true,
  customerOrigin: true,
} as const;

/**
 * The same three kinds of account resolveCustomerForCreate meets, named before
 * the request exists. `claimable` mirrors CustomerActivationService's rule.
 */
function kindOf(row: Row | null): RowKind {
  if (!row) return 'none';
  if (row.role !== UserRole.CUSTOMER || !row.isActive) return 'blocked';
  if (row.passwordHash !== null) return 'active';
  if (row.customerOrigin === CustomerOrigin.AUTO_CREATED_REQUEST) return 'claimable';
  return 'blocked';
}

/**
 * Classifies a telephone number + e-mail pair against the accounts that exist.
 *
 * Both rows are read in one transaction and judged together; there is no
 * "first match wins". The result set is exactly the one
 * resolveCustomerForCreate acts on at submit time — this only moves the answer
 * to the moment the two fields are typed.
 */
@Injectable()
export class RequestIdentityService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  normalize(input: { phone: string; email: string }) {
    return {
      // The same spelling the request service stores and matches on.
      phone: normalizePhoneNumber(input.phone),
      email: input.email.trim().toLowerCase(),
    };
  }

  async classify(
    db: Prisma.TransactionClient | PrismaService,
    input: { phone: string; email: string },
  ): Promise<RequestIdentityResult> {
    const { phone, email } = this.normalize(input);

    const [byPhone, byEmail] = await Promise.all([
      db.user.findFirst({ where: { phone: { in: [phone, denormalizedPhone(phone)] } }, select: rowSelect }),
      db.user.findUnique({ where: { email }, select: rowSelect }),
    ]);

    const phoneKind = kindOf(byPhone);
    const emailKind = kindOf(byEmail);

    if (phoneKind === 'none' && emailKind === 'none') {
      return { status: 'new-customer', matchedCustomerId: null };
    }

    if (phoneKind === 'blocked' || emailKind === 'blocked') {
      return { status: 'unavailable', matchedCustomerId: null };
    }

    if (byPhone && byEmail && byPhone.id !== byEmail.id) {
      return { status: 'identity-conflict', matchedCustomerId: null };
    }

    const matched = (byPhone ?? byEmail) as Row;
    const kind = byPhone ? phoneKind : emailKind;

    return {
      status: kind === 'active' ? 'login-required' : 'activation-required',
      matchedCustomerId: matched.id,
    };
  }

  /** Classifies with the service's own client, outside any transaction. */
  classifyNow(input: { phone: string; email: string }) {
    return this.classify(this.prisma, input);
  }
}

/**
 * User.phone is stored the way ServiceRequestsService.normalizePhone leaves it
 * (digits, national trunk zero kept: "05551234567") while
 * normalizePhoneNumber yields E.164 ("+905551234567"). Both spellings are
 * looked up so the pre-check sees the same account the request service will.
 */
function denormalizedPhone(e164: string): string {
  return e164.startsWith('+90') ? `0${e164.slice(3)}` : e164;
}
```

> Not: `normalizePhone` (service-requests) ile `User.phone` formatını Task 2 uygulanırken `apps/api/src/modules/service-requests/service-requests.service.ts:1314` civarında doğrula; `createUser` fixture'ı `0555…` yazar. İki yazım da sorgulanır; başka bir üçüncü yazım varsa `denormalizedPhone`'a ekle.

- [ ] **Step 5: Controller'ı yaz (yalnız check ucu; activate Task 3'te)**

`apps/api/src/modules/auth/request-identity.controller.ts`:

```ts
import { Body, Controller, HttpCode, HttpStatus, Inject, Post, UseGuards } from '@nestjs/common';
import { AuthThrottlerGuard } from './auth.throttler';
import { RequestIdentityCheckDto } from './dto/request-identity.dto';
import { RequestIdentityService } from './request-identity.service';

/**
 * Asks, before a request form is filled in, whether its author already has an
 * account. Session-less and rate limited: the answer is one of five product
 * states and carries nothing about the account itself.
 */
@Controller('auth/request-identity-check')
export class RequestIdentityController {
  constructor(@Inject(RequestIdentityService) private readonly identity: RequestIdentityService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthThrottlerGuard)
  async check(@Body() dto: RequestIdentityCheckDto) {
    const { status } = await this.identity.classifyNow(dto);
    return { status };
  }
}
```

`apps/api/src/modules/auth/auth.module.ts`: `controllers: [AuthController, EmailVerificationController, RequestIdentityController]`, `providers`'a `RequestIdentityService`, `exports`'a `RequestIdentityService, AuthThrottlerGuard` ekle (import satırlarını da ekle).

- [ ] **Step 6: Testleri çalıştır**

Run: `cd apps/api && npx vitest run test/request-identity.spec.ts`
Expected: PASS (8 test). Throttle testi 429 görmüyorsa `AuthThrottlerGuard`'ın controller'a uygulandığını ve `AUTH_RATE_LIMIT_MAX`'ın test ortamında 10 olduğunu kontrol et (harness env).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/auth apps/api/test/request-identity.spec.ts
git commit -m "feat(api): request-identity-check — telefon + e-posta birlikte sınıflandırma

Yanıt yalnız beş durumdan biri; hesap bilgisi dönmez. AuthThrottlerGuard ile
IP başına sınırlı; sahte X-Forwarded-For yeni bucket açmaz.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `activate` ucu — alıcı yalnız veritabanındaki e-posta

**Files:**
- Modify: `apps/api/src/modules/customer-activation/customer-activation.service.ts` (`buildActivationUrl`, `issueToken`, `issueAndNotify`, `issueForAutoCreatedCustomer` imzaları)
- Modify: `apps/api/src/modules/auth/request-identity.controller.ts`
- Modify: `apps/api/src/modules/auth/auth.module.ts` (`CustomerActivationModule` zaten import; değişiklik yok)
- Test: `apps/api/test/request-identity.spec.ts` (yeni describe)

**Interfaces:**
- Produces: `issueForAutoCreatedCustomer(customerId: string, options?: { redirectTo?: string | null })`; aktivasyon URL'si `redirectTo` varsa `&redirectTo=<encoded>` taşır. Uç: `POST /auth/request-identity-check/activate` → `202 { status: 'accepted' }`.

- [ ] **Step 1: Başarısız testleri yaz**

`apps/api/test/request-identity.spec.ts` dosyasına ekle:

```ts
describe('POST /auth/request-identity-check/activate', () => {
  function activate(body: Record<string, unknown>) {
    return request(ctx.server).post('/auth/request-identity-check/activate').send(body);
  }

  it('mails the activation link to the account’s own e-mail, never to the address in the form', async () => {
    // The attacker knows the victim's number and supplies their own mailbox.
    await claimableCustomer('05552220001', 'victim@example.test');

    const response = await activate({ phone: '05552220001', email: 'attacker@example.test' });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ status: 'accepted' });

    const mails = ctx.notifications.sent.filter((m) => m.template === 'customer-activation');
    expect(mails).toHaveLength(1);
    expect(mails[0]?.to).toBe('victim@example.test');
    expect(ctx.notifications.sent.some((m) => m.to === 'attacker@example.test')).toBe(false);

    const token = await ctx.prisma.customerActivationToken.findFirstOrThrow({ where: { usedAt: null } });
    const victim = await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'victim@example.test' } });
    expect(token.customerId).toBe(victim.id);
  });

  it('carries a validated redirectTo on the link and drops an invalid one', async () => {
    await claimableCustomer('05552220002', 'back@example.test');

    await activate({ phone: '05552220002', email: 'back@example.test', redirectTo: '/vitrin/abc?step=form' });
    const good = ctx.notifications.lastOfTemplate('customer-activation');
    expect(good?.actionUrl).toContain('redirectTo=%2Fvitrin%2Fabc%3Fstep%3Dform');

    ctx.notifications.clear();
    await ctx.prisma.customerActivationToken.deleteMany();
    await activate({ phone: '05552220002', email: 'back@example.test', redirectTo: 'https://evil.example/x' });
    const bad = ctx.notifications.lastOfTemplate('customer-activation');
    expect(bad?.actionUrl).not.toContain('redirectTo');
  });

  it('answers 202 and sends nothing for every other state', async () => {
    await activeCustomer('05552220003', 'active2@example.test');
    await createUser(ctx.prisma, { role: UserRole.PROVIDER, phone: '05552220004', email: 'prov2@example.test' });
    // A claimable account with no e-mail cannot be mailed.
    await createUser(ctx.prisma, {
      role: UserRole.CUSTOMER, phone: '05552220005', email: undefined, password: null,
      customerOrigin: CustomerOrigin.AUTO_CREATED_REQUEST,
    });
    await ctx.prisma.user.update({ where: { phone: '05552220005' }, data: { email: null } });

    for (const body of [
      { phone: FRESH.phone, email: FRESH.email },                       // new-customer
      { phone: '05552220003', email: 'active2@example.test' },          // login-required
      { phone: '05552220004', email: FRESH.email },                     // unavailable
      { phone: '05552220003', email: 'victim@example.test' },           // conflict (if victim exists) or login
      { phone: '05552220005', email: FRESH.email },                     // claimable, no e-mail
    ]) {
      const response = await activate(body);
      expect(response.status).toBe(202);
      expect(response.body).toEqual({ status: 'accepted' });
    }
    expect(ctx.notifications.sent.filter((m) => m.template === 'customer-activation')).toHaveLength(0);
  });
});
```

> `createUser` fixture'ında `email: undefined` varsayılan üretir; sonraki `update` ile `null`'a çekilir. `User.email` nullable (schema: `String?`).

- [ ] **Step 2: Başarısız olduğunu gör**

Run: `cd apps/api && npx vitest run test/request-identity.spec.ts -t activate`
Expected: FAIL — 404.

- [ ] **Step 3: Aktivasyon servisine `redirectTo` ekle**

`customer-activation.service.ts` içinde:

```ts
import { safeRedirectPathOrNull } from '@taktic/shared'; // KULLANMA — API @taktic/shared import edemez (bkz. hafıza). Aşağıdaki yerel kopyayı kullan.
```

**Dikkat:** API `@taktic/shared`'i import edemez (boot hatası). Yerel kopya ekle:

```ts
/**
 * Only a same-origin path may be carried on an activation link. The web app's
 * login form applies the same rule (safeRedirectPathOrNull in @taktic/shared);
 * it is repeated here because the API cannot import that package at runtime.
 */
function safeRedirectPath(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('\\')) return null;
  if (/[ -]/.test(trimmed)) return null;
  return trimmed.length <= 512 ? trimmed : null;
}

function buildActivationUrl(rawToken: string, redirectTo: string | null = null): string {
  const base = getWebAppBaseUrl();
  const url = new URL(CUSTOMER_ACTIVATION_PATH, `${base}/`);
  url.searchParams.set('token', rawToken);
  if (redirectTo) {
    url.searchParams.set('redirectTo', redirectTo);
  }
  return url.toString();
}
```

İmzaları güncelle: `issueToken(customerId, createdById, redirectTo: string | null = null)` → `return { activationUrl: buildActivationUrl(rawToken, redirectTo), expiresAt }`; `issueAndNotify(customerId, email, name, createdById, redirectTo: string | null = null)` → `this.issueToken(customerId, createdById, redirectTo)`; `issueForAutoCreatedCustomer(customerId: string, options: { redirectTo?: string | null } = {})` → `this.issueAndNotify(customer.id, customer.email, customer.name, null, safeRedirectPath(options.redirectTo))`. Diğer çağrılar (`createForCustomer`, `requestActivationForEmail`) varsayılan `null` ile aynı davranır.

- [ ] **Step 4: Ucu ekle**

`request-identity.controller.ts`:

```ts
import { CustomerActivationService } from '../customer-activation/customer-activation.service';
import { RequestIdentityActivateDto, RequestIdentityCheckDto } from './dto/request-identity.dto';

// constructor'a ekle:
//   @Inject(CustomerActivationService) private readonly activation: CustomerActivationService,

  /**
   * Re-sends the claim link for a password-less account the pair points at.
   *
   * The recipient is the account's own stored e-mail — read inside
   * issueForAutoCreatedCustomer, never taken from this body. Somebody who knows
   * a victim's number and types their own address gets a 202 and nothing else;
   * the mail, if any, goes to the victim. Every other state is the same 202
   * with no mail, so the endpoint reveals nothing on its own.
   */
  @Post('activate')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(AuthThrottlerGuard)
  async activate(@Body() dto: RequestIdentityActivateDto) {
    const { status, matchedCustomerId } = await this.identity.classifyNow(dto);

    if (status === 'activation-required' && matchedCustomerId) {
      try {
        await this.activation.issueForAutoCreatedCustomer(matchedCustomerId, {
          redirectTo: dto.redirectTo ?? null,
        });
      } catch {
        // Best effort by design: the answer must not change with the outcome.
      }
    }

    return { status: 'accepted' as const };
  }
```

- [ ] **Step 5: Testleri çalıştır**

Run: `cd apps/api && npx vitest run test/request-identity.spec.ts test/customer-activation*.spec.ts`
Expected: PASS. Mevcut aktivasyon testleri `actionUrl` formatını kontrol ediyorsa `redirectTo` yokken URL'nin **değişmediğini** doğrula.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/auth apps/api/src/modules/customer-activation apps/api/test/request-identity.spec.ts
git commit -m "feat(api): request-identity-check/activate — alıcı yalnız hesabın kayıtlı e-postası

Her durumda 202; yalnız claimable hesapta mail; formdaki e-posta hiçbir yolda
alıcı olmaz. Aktivasyon linki doğrulanmış redirectTo taşıyabilir.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `CUSTOMER_IDENTITY_CONFLICT` kodu

**Files:**
- Modify: `apps/api/src/modules/service-requests/service-requests.service.ts` (`resolveCustomerForCreate` içindeki iki `ConflictException`)
- Test: `apps/api/test/showcase-lead-flow.spec.ts` (mevcut describe 'the body is the marketplace request body' içine)

**Interfaces:**
- Produces: 409 gövdesi `{ statusCode: 409, error: 'Conflict', code: 'CUSTOMER_IDENTITY_CONFLICT', message: '<mevcut cümle>' }`. Sabit: `export const CUSTOMER_IDENTITY_CONFLICT_CODE = 'CUSTOMER_IDENTITY_CONFLICT'` (aynı dosyada, `ACCOUNT_CONTACT_INCOMPLETE_CODE` yanında).

- [ ] **Step 1: Başarısız test**

```ts
  it('refuses a phone and an e-mail that belong to two different customers, with a code', async () => {
    const { card, category } = await published();
    await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: '05553330001', email: 'one@example.test' });
    await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: '05553330002', email: 'two@example.test' });

    const response = await openLead(card.id, category.slug, {
      customerPhone: '05553330001',
      customerEmail: 'two@example.test',
    });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('CUSTOMER_IDENTITY_CONFLICT');
    expect(response.body.message).toBe('Telefon ve e-posta farklı müşteri kayıtlarıyla eşleşiyor.');
    expect(await ctx.prisma.serviceRequest.count()).toBe(0);
    expect(await ctx.prisma.showcaseLead.count()).toBe(0);
  });
```

- [ ] **Step 2: Başarısız olduğunu gör** — Run: `cd apps/api && npx vitest run test/showcase-lead-flow.spec.ts -t "two different customers"` → FAIL (`code` undefined).

- [ ] **Step 3: Kodu ekle**

`service-requests.service.ts` — sabitlerin yanına `export const CUSTOMER_IDENTITY_CONFLICT_CODE = 'CUSTOMER_IDENTITY_CONFLICT';`; `resolveCustomerForCreate` içinde:

```ts
  if (byPhone && byEmail && byPhone.id !== byEmail.id) {
    throw new ConflictException({
      statusCode: HttpStatus.CONFLICT,
      error: 'Conflict',
      code: CUSTOMER_IDENTITY_CONFLICT_CODE,
      message: 'Telefon ve e-posta farklı müşteri kayıtlarıyla eşleşiyor.',
    });
  }
  // … ve P2002 dalında:
      throw new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        code: CUSTOMER_IDENTITY_CONFLICT_CODE,
        message: 'Müşteri kaydı oluşturulamadı: telefon veya e-posta başka bir kayıtla çakışıyor.',
      });
```

- [ ] **Step 4: Testler** — Run: `cd apps/api && npx vitest run test/showcase-lead-flow.spec.ts test/service-requests*.spec.ts` → PASS (mesajı string olarak bekleyen bir test varsa `response.body.message` yine aynı cümledir).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/service-requests/service-requests.service.ts apps/api/test/showcase-lead-flow.spec.ts
git commit -m "feat(api): müşteri kimlik çakışması 409'una CUSTOMER_IDENTITY_CONFLICT kodu

Kural ve mesaj aynı; iki form aynı cümleyi gösterebilsin diye kod eklendi.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: `RequestDraftsModule` — oluşturma, güncelleme, onaylı değiştirme, sınırlar

**Files:**
- Create: `apps/api/src/modules/request-drafts/request-drafts.constants.ts`, `request-draft.cookie.ts`, `request-draft.throttler.ts`, `dto/create-request-draft.dto.ts`, `request-drafts.service.ts`, `request-drafts.controller.ts`, `request-drafts.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/request-drafts.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export const REQUEST_DRAFT_COOKIE_NAME = 'taktic_request_draft';
  export const REQUEST_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
  export const REQUEST_DRAFT_MAX_ACTIVE: number;              // env REQUEST_DRAFT_MAX_ACTIVE ?? 10000
  export function getDraftTokenFromRequest(req: { headers?: Record<string, string | string[] | undefined> }): string | null;
  export function hashDraftToken(raw: string): string;
  type DraftKey = { formType: RequestDraftFormType; categorySlug: string; cardId: string | null };
  class RequestDraftsService {
    create(input: { key: DraftKey; payload: RequestDraftPayload; identity: { phone: string; email: string }; replace: boolean }, existingToken: string | null): Promise<{ token: string; expiresAt: Date }>;
    current(token: string | null, key: DraftKey, sessionUserId: string | null): Promise<{ kind: 'none' } | { kind: 'payload'; payload: RequestDraftPayload } | { kind: 'wrong-account' }>;
    discard(token: string | null): Promise<void>;
    consumeInTransaction(tx: Prisma.TransactionClient, token: string | null, key: DraftKey, customerId: string | null): Promise<void>;
    sweepExpired(): Promise<number>;
  }
  ```
  Hata kodları: `DRAFT_NOT_CONTINUABLE` (409), `DRAFT_EXISTS` (409), `DRAFT_STORAGE_BUSY` (503 + `Retry-After: 60`).

- [ ] **Step 1: Başarısız testleri yaz**

`apps/api/test/request-drafts.spec.ts`:

```ts
import { CustomerOrigin, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, createUser, loginAs, resetDatabase, type TestContext } from './harness';

/**
 * The server-side draft: what a browser can make it do, and what it cannot.
 *
 * The browser only ever holds an opaque token in an HttpOnly cookie. Everything
 * that decides who may open a draft — expectedUserId — is derived on the server
 * from the same identity classification the form saw, and is never sent or
 * returned.
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
});

const COOKIE = 'taktic_request_draft';

const marketplace = {
  formType: 'MARKETPLACE',
  categorySlug: 'klima-servisi',
  payload: { city: 'İstanbul', district: 'Kadıköy', description: 'Klima bakımı', urgency: 'THIS_WEEK', answers: [] },
  identity: { phone: '05554440001', email: 'draft@example.test' },
};

const showcase = {
  formType: 'SHOWCASE_LEAD',
  categorySlug: 'klima-servisi',
  cardId: 'card-1',
  payload: { city: 'İstanbul', district: 'Kadıköy', description: 'Vitrin', urgencyBucket: 'URGENT', answers: [] },
  identity: { phone: '05554440001', email: 'draft@example.test' },
};

function post(body: Record<string, unknown>, cookie?: string, headers: Record<string, string> = {}) {
  const req = request(ctx.server).post('/request-drafts').set(headers);
  return cookie ? req.set('Cookie', `${COOKIE}=${cookie}`).send(body) : req.send(body);
}

function get(query: Record<string, string>, cookie?: string, session?: string) {
  const cookies = [cookie ? `${COOKIE}=${cookie}` : null, session ?? null].filter(Boolean).join('; ');
  const req = request(ctx.server).get('/request-drafts/current').query(query);
  return cookies ? req.set('Cookie', cookies) : req;
}

const mpQuery = { formType: 'MARKETPLACE', categorySlug: 'klima-servisi' };
const scQuery = { formType: 'SHOWCASE_LEAD', categorySlug: 'klima-servisi', cardId: 'card-1' };

describe('POST /request-drafts', () => {
  it('stores the payload under a hashed token and returns the raw token once', async () => {
    const response = await post(marketplace);

    expect(response.status).toBe(201);
    expect(typeof response.body.token).toBe('string');
    expect(response.body.token.length).toBeGreaterThan(30);
    expect(response.headers['set-cookie']).toBeUndefined();

    const row = await ctx.prisma.requestDraft.findFirstOrThrow();
    expect(row.tokenHash).not.toBe(response.body.token);
    expect(row.expectedUserId).toBeNull();
    expect(row.userId).toBeNull();
    expect(row.payload).toEqual(marketplace.payload);
    expect(JSON.stringify(row.payload)).not.toContain('05554440001');
    expect(JSON.stringify(row.payload)).not.toContain('draft@example.test');
  });

  it('refuses contact fields inside the payload', async () => {
    const response = await post({ ...marketplace, payload: { ...marketplace.payload, customerPhone: '05554440001' } });
    expect(response.status).toBe(400);
    expect(await ctx.prisma.requestDraft.count()).toBe(0);
  });

  it('refuses a payload over 32 KB', async () => {
    const response = await post({ ...marketplace, payload: { ...marketplace.payload, description: 'x'.repeat(33 * 1024) } });
    expect(response.status).toBe(400);
  });

  it('sets expectedUserId from the identity check and never returns it', async () => {
    const owner = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: '05554440001', email: 'draft@example.test' });

    const response = await post(marketplace);

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ token: expect.any(String), expiresAt: expect.any(String) });
    const row = await ctx.prisma.requestDraft.findFirstOrThrow();
    expect(row.expectedUserId).toBe(owner.id);
    expect(row.userId).toBeNull();
  });

  it('refuses to save a draft for a pair that cannot continue', async () => {
    await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: '05554440001', email: 'a@example.test' });
    await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: '05554440002', email: 'draft@example.test' });

    const conflict = await post(marketplace);
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('DRAFT_NOT_CONTINUABLE');

    await createUser(ctx.prisma, { role: UserRole.PROVIDER, phone: '05554440003', email: 'p@example.test' });
    const unavailable = await post({ ...marketplace, identity: { phone: '05554440003', email: 'new@example.test' } });
    expect(unavailable.status).toBe(409);
    expect(await ctx.prisma.requestDraft.count()).toBe(0);
  });

  it('updates the same draft in place for the same form context', async () => {
    const first = await post(marketplace);
    const second = await post({ ...marketplace, payload: { ...marketplace.payload, description: 'Güncel' } }, first.body.token);

    expect(second.status).toBe(201);
    expect(second.body.token).toBe(first.body.token);
    expect(await ctx.prisma.requestDraft.count()).toBe(1);
    expect((await ctx.prisma.requestDraft.findFirstOrThrow()).payload).toMatchObject({ description: 'Güncel' });
  });

  it('keeps one active draft per browser: a different form needs an explicit replace', async () => {
    const first = await post(marketplace);
    const firstRow = await ctx.prisma.requestDraft.findFirstOrThrow();

    const refused = await post(showcase, first.body.token);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('DRAFT_EXISTS');
    expect(await ctx.prisma.requestDraft.count()).toBe(1);
    expect((await ctx.prisma.requestDraft.findFirstOrThrow()).tokenHash).toBe(firstRow.tokenHash);
    expect((await get(mpQuery, first.body.token)).status).toBe(200);

    const replaced = await post({ ...showcase, replace: true }, first.body.token);
    expect(replaced.status).toBe(201);
    expect(replaced.body.token).not.toBe(first.body.token);
    const rows = await ctx.prisma.requestDraft.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.formType).toBe('SHOWCASE_LEAD');
    expect((await get(mpQuery, first.body.token)).status).toBe(204);
    expect((await get(scQuery, replaced.body.token)).status).toBe(200);
  });

  it('is rate limited per client and a forged X-Forwarded-For does not help', async () => {
    let last = 0;
    for (let index = 0; index < 8; index += 1) {
      // A fresh browser every time (no cookie) so each call would be a new row.
      const response = await post(marketplace, undefined, { 'x-forwarded-for': `10.1.0.${index}` });
      last = response.status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
    expect(await ctx.prisma.requestDraft.count()).toBeLessThanOrEqual(5);
  });

  it('answers 503 with Retry-After at the global ceiling, and writes nothing', async () => {
    const service = ctx.app.get(RequestDraftsService);
    const original = service.maxActive;
    service.maxActive = 1;
    try {
      const first = await request(ctx.server).post('/request-drafts').send(marketplace);
      expect(first.status).toBe(201);
      const second = await request(ctx.server).post('/request-drafts').send({ ...marketplace, identity: { phone: '05554440009', email: 'nine@example.test' } });
      expect(second.status).toBe(503);
      expect(second.body.code).toBe('DRAFT_STORAGE_BUSY');
      expect(second.headers['retry-after']).toBe('60');
      expect(await ctx.prisma.requestDraft.count()).toBe(1);
      // Updating the existing row is not a new row and passes the ceiling.
      const update = await post({ ...marketplace, payload: { ...marketplace.payload, description: 'Yine' } }, first.body.token);
      expect(update.status).toBe(201);
    } finally {
      service.maxActive = original;
    }
  });

  it('sweeps at most 200 expired rows, at most once an hour per process', async () => {
    const service = ctx.app.get(RequestDraftsService);
    const past = new Date(Date.now() - 60_000);
    await ctx.prisma.requestDraft.createMany({
      data: Array.from({ length: 250 }, (_, index) => ({
        tokenHash: `expired-${index}`,
        formType: 'MARKETPLACE' as const,
        categorySlug: 'x',
        payload: {},
        expiresAt: past,
      })),
    });

    expect(await service.sweepExpired()).toBe(200);
    expect(await ctx.prisma.requestDraft.count()).toBe(50);
    // Second call inside the hour is a no-op.
    expect(await service.sweepExpired()).toBe(0);
    expect(await ctx.prisma.requestDraft.count()).toBe(50);
  });
});
```

Dosyanın başına `import { RequestDraftsService } from '../src/modules/request-drafts/request-drafts.service';` ekle. Throttle testi için rate limit bütçesi 5/10 dk (`REQUEST_DRAFT_THROTTLE_LIMIT = 5`).

- [ ] **Step 2: Başarısız olduğunu gör** — Run: `cd apps/api && npx vitest run test/request-drafts.spec.ts` → FAIL (404).

- [ ] **Step 3: Sabitler ve cookie yardımcıları**

`request-drafts.constants.ts`:

```ts
function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export const REQUEST_DRAFT_COOKIE_NAME = 'taktic_request_draft';
export const REQUEST_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
export const REQUEST_DRAFT_MAX_PAYLOAD_BYTES = 32 * 1024;
export const REQUEST_DRAFT_MAX_ACTIVE = positiveInt(process.env.REQUEST_DRAFT_MAX_ACTIVE, 10_000);
export const REQUEST_DRAFT_THROTTLE_TTL_MS = 10 * 60 * 1000;
export const REQUEST_DRAFT_THROTTLE_LIMIT = 5;
export const REQUEST_DRAFT_SWEEP_BATCH = 200;
export const REQUEST_DRAFT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
```

`request-draft.cookie.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';
import { parseCookieHeader } from '../auth/cookie';
import { REQUEST_DRAFT_COOKIE_NAME } from './request-drafts.constants';

export function generateDraftToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashDraftToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** The draft token the web app forwarded, or null. Same parsing as the session cookie. */
export function getDraftTokenFromRequest(request: {
  headers?: Record<string, string | string[] | undefined>;
}): string | null {
  const header = request.headers?.cookie;
  const normalized = Array.isArray(header) ? header.join(';') : header;
  const value = parseCookieHeader(normalized).get(REQUEST_DRAFT_COOKIE_NAME);
  return value && value.length > 0 ? value : null;
}
```

`request-draft.throttler.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { AuthThrottlerGuard } from '../auth/auth.throttler';

/**
 * The draft endpoint's own budget, on the credential endpoints' tracker.
 *
 * Deliberately a subclass and not a second IP resolver: client identity is
 * whatever Express `req.ip` says under `trust proxy`, exactly as for login, so
 * a forged X-Forwarded-For buys nothing here that it does not buy there.
 */
@Injectable()
export class RequestDraftThrottlerGuard extends AuthThrottlerGuard {}
```

- [ ] **Step 4: DTO**

`dto/create-request-draft.dto.ts`:

```ts
import { RequestDraftFormType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  Allow, ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString,
  MaxLength, ValidateNested,
} from 'class-validator';
import { RequestIdentityCheckDto } from '../../auth/dto/request-identity.dto';

class DraftAnswerDto {
  @IsString() @IsNotEmpty() questionKey!: string;
  @Allow() value!: unknown;
}

class DraftRouterSelectionDto {
  @IsString() @IsNotEmpty() questionKey!: string;
  @IsString() @IsNotEmpty() optionKey!: string;
}

/**
 * What a draft may hold. Contact fields are absent on purpose and the global
 * ValidationPipe's forbidNonWhitelisted refuses them if sent.
 */
export class RequestDraftPayloadDto {
  @IsOptional() @IsString() @MaxLength(100) city?: string;
  @IsOptional() @IsString() @MaxLength(100) district?: string;
  @IsOptional() @IsString() @MaxLength(100) neighborhood?: string;
  @IsOptional() @IsString() @MaxLength(2000) addressNote?: string;
  @IsOptional() @IsString() @MaxLength(32) urgency?: string;
  @IsOptional() @IsString() @MaxLength(16) urgencyBucket?: string;
  @IsOptional() @IsString() @MaxLength(32) preferredDate?: string;
  @IsOptional() @IsInt() budgetMin?: number;
  @IsOptional() @IsInt() budgetMax?: number;
  @IsOptional() @IsString() @MaxLength(20_000) description?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => DraftAnswerDto)
  answers?: DraftAnswerDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => DraftRouterSelectionDto)
  routerSelections?: DraftRouterSelectionDto[];
}

export type RequestDraftPayload = RequestDraftPayloadDto;

export class CreateRequestDraftDto {
  @IsEnum(RequestDraftFormType) formType!: RequestDraftFormType;
  @IsString() @IsNotEmpty() @MaxLength(128) categorySlug!: string;
  @IsOptional() @IsString() @MaxLength(64) cardId?: string;
  @ValidateNested() @Type(() => RequestDraftPayloadDto) payload!: RequestDraftPayloadDto;
  @ValidateNested() @Type(() => RequestIdentityCheckDto) identity!: RequestIdentityCheckDto;
  @IsOptional() @IsBoolean() replace?: boolean;
}

export class CurrentRequestDraftQueryDto {
  @IsEnum(RequestDraftFormType) formType!: RequestDraftFormType;
  @IsString() @IsNotEmpty() @MaxLength(128) categorySlug!: string;
  @IsOptional() @IsString() @MaxLength(64) cardId?: string;
}
```

- [ ] **Step 5: Servis**

`request-drafts.service.ts`:

```ts
import { ConflictException, HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, RequestDraftFormType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RequestIdentityService } from '../auth/request-identity.service';
import { RequestDraftPayload } from './dto/create-request-draft.dto';
import { generateDraftToken, hashDraftToken } from './request-draft.cookie';
import {
  REQUEST_DRAFT_MAX_ACTIVE, REQUEST_DRAFT_MAX_PAYLOAD_BYTES, REQUEST_DRAFT_SWEEP_BATCH,
  REQUEST_DRAFT_SWEEP_INTERVAL_MS, REQUEST_DRAFT_TTL_MS,
} from './request-drafts.constants';

export type DraftKey = { formType: RequestDraftFormType; categorySlug: string; cardId: string | null };

export type CurrentDraft =
  | { kind: 'none' }
  | { kind: 'payload'; payload: RequestDraftPayload }
  | { kind: 'wrong-account' };

function sameKey(row: DraftKey, key: DraftKey): boolean {
  return row.formType === key.formType && row.categorySlug === key.categorySlug && (row.cardId ?? null) === (key.cardId ?? null);
}

function liveWhere(now: Date) {
  return { consumedAt: null, expiresAt: { gt: now } };
}

@Injectable()
export class RequestDraftsService {
  private readonly logger = new Logger(RequestDraftsService.name);
  /** Overridable in tests; the env-derived default otherwise. */
  maxActive = REQUEST_DRAFT_MAX_ACTIVE;
  private lastSweepAt = 0;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequestIdentityService) private readonly identity: RequestIdentityService,
  ) {}

  async create(
    input: { key: DraftKey; payload: RequestDraftPayload; identity: { phone: string; email: string }; replace: boolean },
    existingToken: string | null,
  ): Promise<{ token: string; expiresAt: Date }> {
    if (Buffer.byteLength(JSON.stringify(input.payload), 'utf8') > REQUEST_DRAFT_MAX_PAYLOAD_BYTES) {
      throw new HttpException({ statusCode: 400, error: 'Bad Request', code: 'DRAFT_TOO_LARGE', message: 'Taslak çok büyük.' }, HttpStatus.BAD_REQUEST);
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + REQUEST_DRAFT_TTL_MS);

    const classified = await this.identity.classifyNow(input.identity);
    if (classified.status === 'identity-conflict' || classified.status === 'unavailable') {
      throw new ConflictException({ statusCode: 409, error: 'Conflict', code: 'DRAFT_NOT_CONTINUABLE', message: 'Bu iletişim bilgileriyle taslak kaydedilemez.' });
    }
    const expectedUserId = classified.matchedCustomerId;

    const existing = existingToken
      ? await this.prisma.requestDraft.findFirst({ where: { tokenHash: hashDraftToken(existingToken), ...liveWhere(now) } })
      : null;

    if (existing && sameKey(existing, input.key)) {
      await this.prisma.requestDraft.update({
        where: { id: existing.id },
        data: { payload: input.payload as Prisma.InputJsonValue, expectedUserId, expiresAt },
      });
      return { token: existingToken as string, expiresAt };
    }

    if (existing && !input.replace) {
      throw new ConflictException({ statusCode: 409, error: 'Conflict', code: 'DRAFT_EXISTS', message: 'Bu tarayıcıda başka bir talep taslağı var.' });
    }

    if (!existing) {
      const active = await this.prisma.requestDraft.count({ where: liveWhere(now) });
      if (active >= this.maxActive) {
        throw new HttpException(
          { statusCode: 503, error: 'Service Unavailable', code: 'DRAFT_STORAGE_BUSY', message: 'Taslak şu anda kaydedilemedi. Birkaç dakika sonra tekrar deneyin.' },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
    }

    const token = generateDraftToken();
    await this.prisma.$transaction(async (tx) => {
      if (existing) {
        // Explicit replace: the old row goes in the same transaction the new one
        // arrives in, so no browser ever references two rows or none.
        await tx.requestDraft.delete({ where: { id: existing.id } });
      }
      await tx.requestDraft.create({
        data: {
          tokenHash: hashDraftToken(token),
          formType: input.key.formType,
          categorySlug: input.key.categorySlug,
          cardId: input.key.cardId,
          payload: input.payload as Prisma.InputJsonValue,
          expectedUserId,
          expiresAt,
        },
      });
    });

    setImmediate(() => void this.sweepExpired().catch((error) => this.logger.warn(`draft sweep failed: ${String(error)}`)));
    return { token, expiresAt };
  }

  async current(token: string | null, key: DraftKey, sessionUserId: string | null): Promise<CurrentDraft> {
    if (!token) return { kind: 'none' };
    const row = await this.prisma.requestDraft.findFirst({ where: { tokenHash: hashDraftToken(token), ...liveWhere(new Date()) } });
    if (!row || !sameKey(row, key)) return { kind: 'none' };

    if (row.expectedUserId === null) {
      // Anonymous drafts stay anonymous: nobody is bound here.
      return { kind: 'payload', payload: row.payload as RequestDraftPayload };
    }
    if (!sessionUserId) return { kind: 'none' };
    if (sessionUserId !== row.expectedUserId) {
      // The row is left exactly as it is: the right account can still open it.
      return { kind: 'wrong-account' };
    }
    if (row.userId !== sessionUserId) {
      await this.prisma.requestDraft.update({ where: { id: row.id }, data: { userId: sessionUserId } });
    }
    return { kind: 'payload', payload: row.payload as RequestDraftPayload };
  }

  async discard(token: string | null): Promise<void> {
    if (!token) return;
    await this.prisma.requestDraft.deleteMany({ where: { tokenHash: hashDraftToken(token) } });
  }

  /**
   * Marks the draft the browser carried as used by the request just created,
   * inside that request's own transaction. A draft protected for another
   * account is left untouched and never blocks the request.
   */
  async consumeInTransaction(tx: Prisma.TransactionClient, token: string | null, key: DraftKey, customerId: string | null): Promise<void> {
    if (!token) return;
    const now = new Date();
    const row = await tx.requestDraft.findFirst({ where: { tokenHash: hashDraftToken(token), ...liveWhere(now) } });
    if (!row || !sameKey(row, key)) return;
    if (row.expectedUserId !== null && row.expectedUserId !== customerId) return;
    await tx.requestDraft.update({ where: { id: row.id }, data: { consumedAt: now, userId: customerId } });
  }

  /** Bounded, throttled physical cleanup. Expired rows are already logically dead. */
  async sweepExpired(): Promise<number> {
    const now = Date.now();
    if (now - this.lastSweepAt < REQUEST_DRAFT_SWEEP_INTERVAL_MS) return 0;
    this.lastSweepAt = now;
    const victims = await this.prisma.requestDraft.findMany({
      where: { expiresAt: { lt: new Date(now) } },
      select: { id: true },
      orderBy: { expiresAt: 'asc' },
      take: REQUEST_DRAFT_SWEEP_BATCH,
    });
    if (victims.length === 0) return 0;
    const result = await this.prisma.requestDraft.deleteMany({ where: { id: { in: victims.map((v) => v.id) } } });
    return result.count;
  }
}
```

- [ ] **Step 6: Controller ve modül**

`request-drafts.controller.ts`:

```ts
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators';
import { OptionalAuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { CreateRequestDraftDto, CurrentRequestDraftQueryDto } from './dto/create-request-draft.dto';
import { getDraftTokenFromRequest } from './request-draft.cookie';
import { RequestDraftThrottlerGuard } from './request-draft.throttler';
import { RequestDraftsService } from './request-drafts.service';

type IncomingRequest = { headers?: Record<string, string | string[] | undefined> };
type OutgoingResponse = { setHeader(name: string, value: string): void; status(code: number): OutgoingResponse };

/**
 * A request form parked on the server while its author signs in or activates.
 * The token travels only in the web app's HttpOnly cookie, which the web
 * server forwards here like the session cookie; no route below ever returns
 * expectedUserId or userId.
 */
@Controller('request-drafts')
export class RequestDraftsController {
  constructor(@Inject(RequestDraftsService) private readonly drafts: RequestDraftsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RequestDraftThrottlerGuard)
  async create(@Body() dto: CreateRequestDraftDto, @Req() req: IncomingRequest, @Res({ passthrough: true }) res: OutgoingResponse) {
    try {
      return await this.drafts.create(
        {
          key: { formType: dto.formType, categorySlug: dto.categorySlug, cardId: dto.cardId ?? null },
          payload: dto.payload,
          identity: dto.identity,
          replace: dto.replace === true,
        },
        getDraftTokenFromRequest(req),
      );
    } catch (error) {
      if (error instanceof Object && 'getStatus' in error && (error as { getStatus(): number }).getStatus() === 503) {
        res.setHeader('Retry-After', '60');
      }
      throw error;
    }
  }

  @Get('current')
  @UseGuards(OptionalAuthGuard)
  async current(
    @Query() query: CurrentRequestDraftQueryDto,
    @CurrentUser() user: AuthUser | null,
    @Req() req: IncomingRequest,
    @Res({ passthrough: true }) res: OutgoingResponse,
  ) {
    const result = await this.drafts.current(
      getDraftTokenFromRequest(req),
      { formType: query.formType, categorySlug: query.categorySlug, cardId: query.cardId ?? null },
      user?.id ?? null,
    );
    if (result.kind === 'none') {
      res.status(HttpStatus.NO_CONTENT);
      return;
    }
    return result.kind === 'payload' ? { payload: result.payload } : { status: 'wrong-account' };
  }

  @Delete('current')
  @HttpCode(HttpStatus.NO_CONTENT)
  async discard(@Req() req: IncomingRequest) {
    await this.drafts.discard(getDraftTokenFromRequest(req));
  }
}
```

`request-drafts.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { RequestDraftThrottlerGuard } from './request-draft.throttler';
import { RequestDraftsController } from './request-drafts.controller';
import { RequestDraftsService } from './request-drafts.service';
import { REQUEST_DRAFT_THROTTLE_LIMIT, REQUEST_DRAFT_THROTTLE_TTL_MS } from './request-drafts.constants';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    // Its own budget, module-scoped like AuthModule's: five drafts per client
    // per ten minutes, on the same tracker as the credential endpoints.
    ThrottlerModule.forRoot([
      { name: 'request-drafts', ttl: REQUEST_DRAFT_THROTTLE_TTL_MS, limit: REQUEST_DRAFT_THROTTLE_LIMIT },
    ]),
  ],
  controllers: [RequestDraftsController],
  providers: [RequestDraftsService, RequestDraftThrottlerGuard],
  exports: [RequestDraftsService],
})
export class RequestDraftsModule {}
```

`app.module.ts` imports listesine `RequestDraftsModule` ekle (`ServiceRequestsModule`'den önce).

> Throttler notu: `ThrottlerModule.forRoot` iki modülde de çağrılıyor. `@nestjs/throttler` 6'da `forRoot` global modül döndürür; iki kayıt çakışırsa (guard hangi opsiyonu görüyor testte anlaşılır: 6. istekte 429 gelmiyorsa) alternatif: `AuthModule`'daki tek `forRoot`'a ikinci adlandırılmış throttler ekle (`{ name: 'request-drafts', ttl, limit }`) ve `RequestDraftThrottlerGuard`'ı `@Throttle({ 'request-drafts': { limit: 5, ttl: 600000 } })` dekoratörüyle controller metoduna uygula, `RequestDraftsModule`'daki `forRoot`'u kaldır. Hangi yol seçildiyse `request-identity.spec` ve `request-drafts.spec` throttle testleri birlikte yeşil olmalı.

- [ ] **Step 7: Testleri çalıştır**

Run: `cd apps/api && npx vitest run test/request-drafts.spec.ts test/request-identity.spec.ts`
Expected: PASS. (`GET` testleri Task 6'da genişler; buradaki iki `get` çağrısı 200/204 ile yeterli.)

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/request-drafts apps/api/src/app.module.ts apps/api/src/modules/auth/auth.module.ts apps/api/test/request-drafts.spec.ts
git commit -m "feat(api): request-drafts — sunucu tarafı talep taslağı (oluştur/güncelle/onaylı değiştir)

Tarayıcı başına tek aktif satır; expectedUserId identity-check'ten türetilir ve
asla dönmez; IP throttle + global tavan + ≤32 KB payload; sınırlı saatlik sweep.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Taslağı açma — `expectedUserId` kilidi, `wrong-account`, FK davranışı

**Files:**
- Test: `apps/api/test/request-drafts.spec.ts` (yeni describe)
- Modify (gerekirse): `apps/api/src/modules/request-drafts/request-drafts.service.ts`

**Interfaces:** Task 5'tekiler.

- [ ] **Step 1: Testleri yaz**

```ts
describe('GET /request-drafts/current', () => {
  it('opens an anonymous draft for its cookie bearer and binds it to nobody, even with a session', async () => {
    const someone = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const created = await post(marketplace);

    const anon = await get(mpQuery, created.body.token);
    expect(anon.status).toBe(200);
    expect(anon.body).toEqual({ payload: marketplace.payload });

    const withSession = await get(mpQuery, created.body.token, await loginAs(ctx.prisma, someone.id));
    expect(withSession.status).toBe(200);
    expect((await ctx.prisma.requestDraft.findFirstOrThrow()).userId).toBeNull();
  });

  it('keeps a protected draft closed without a session, and refuses the wrong account without deleting anything', async () => {
    const owner = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: '05554440001', email: 'draft@example.test' });
    const stranger = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const created = await post(marketplace);
    const before = await ctx.prisma.requestDraft.findFirstOrThrow();

    expect((await get(mpQuery, created.body.token)).status).toBe(204);

    const wrong = await get(mpQuery, created.body.token, await loginAs(ctx.prisma, stranger.id));
    expect(wrong.status).toBe(200);
    expect(wrong.body).toEqual({ status: 'wrong-account' });

    const after = await ctx.prisma.requestDraft.findFirstOrThrow();
    expect(after.id).toBe(before.id);
    expect(after.tokenHash).toBe(before.tokenHash);
    expect(after.expectedUserId).toBe(owner.id);
    expect(after.userId).toBeNull();
    expect(after.consumedAt).toBeNull();

    // The right account, on the same browser, afterwards: the very same draft.
    const right = await get(mpQuery, created.body.token, await loginAs(ctx.prisma, owner.id));
    expect(right.status).toBe(200);
    expect(right.body).toEqual({ payload: marketplace.payload });
    expect((await ctx.prisma.requestDraft.findFirstOrThrow()).userId).toBe(owner.id);
  });

  it('answers 204 for another form context, an expired row, or a consumed row', async () => {
    const created = await post(marketplace);
    expect((await get(scQuery, created.body.token)).status).toBe(204);

    await ctx.prisma.requestDraft.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await get(mpQuery, created.body.token)).status).toBe(204);

    await ctx.prisma.requestDraft.updateMany({ data: { expiresAt: new Date(Date.now() + 60_000), consumedAt: new Date() } });
    expect((await get(mpQuery, created.body.token)).status).toBe(204);
  });

  it('never leaks who is expected', async () => {
    await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: '05554440001', email: 'draft@example.test' });
    const created = await post(marketplace);
    const stranger = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const wrong = await get(mpQuery, created.body.token, await loginAs(ctx.prisma, stranger.id));
    expect(JSON.stringify(wrong.body)).not.toMatch(/expectedUserId|userId|@example\.test/);
  });
});

describe('foreign keys', () => {
  it('deletes a protected draft with its expected user — it never becomes anonymous', async () => {
    const owner = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: '05554440001', email: 'draft@example.test' });
    const created = await post(marketplace);
    expect((await ctx.prisma.requestDraft.findFirstOrThrow()).expectedUserId).toBe(owner.id);

    await ctx.prisma.user.delete({ where: { id: owner.id } });

    expect(await ctx.prisma.requestDraft.count()).toBe(0);
    expect((await get(mpQuery, created.body.token)).status).toBe(204);
  });

  it('keeps the row and nulls userId when the bound user goes', async () => {
    const created = await post(marketplace);
    const someone = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    await ctx.prisma.requestDraft.updateMany({ data: { userId: someone.id } });

    await ctx.prisma.user.delete({ where: { id: someone.id } });

    const row = await ctx.prisma.requestDraft.findFirstOrThrow();
    expect(row.userId).toBeNull();
    expect(row.expectedUserId).toBeNull();
    expect((await get(mpQuery, created.body.token)).status).toBe(200);
  });
});

describe('DELETE /request-drafts/current', () => {
  it('removes the draft the cookie names and nothing else', async () => {
    const mine = await post(marketplace);
    const other = await request(ctx.server).post('/request-drafts').send({ ...marketplace, identity: { phone: '05554440008', email: 'eight@example.test' } });

    const response = await request(ctx.server).delete('/request-drafts/current').set('Cookie', `${COOKIE}=${mine.body.token}`);
    expect(response.status).toBe(204);
    expect(await ctx.prisma.requestDraft.count()).toBe(1);
    expect((await get(mpQuery, other.body.token)).status).toBe(200);
  });
});
```

- [ ] **Step 2: Çalıştır** — Run: `cd apps/api && npx vitest run test/request-drafts.spec.ts` → hepsi PASS bekleniyor; `user.delete` başka FK'lerde takılırsa (Session vs.) fixture kullanıcısını `createUser` ile temiz oluşturduğundan takılmamalı; takılırsa ilgili tabloyu testte önce temizle (`session.deleteMany`).

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/request-drafts.spec.ts apps/api/src/modules/request-drafts
git commit -m "test(api): taslak açma — expectedUserId kilidi, wrong-account silmez, FK davranışı

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Taslağın talep transaction'ında tüketilmesi

**Files:**
- Modify: `apps/api/src/modules/service-requests/service-requests.service.ts` (`ServiceRequestCreationContext.draftToken`, transaction içinde `consumeInTransaction`)
- Modify: `apps/api/src/modules/service-requests/service-requests.controller.ts` (cookie'den token)
- Modify: `apps/api/src/modules/service-requests/service-requests.module.ts` (`RequestDraftsModule` import)
- Modify: `apps/api/src/modules/showcase/showcase-public.controller.ts`, `showcase-lead.service.ts` (`draftToken` geçişi)
- Test: `apps/api/test/request-drafts.spec.ts` (yeni describe), `apps/api/test/showcase-lead-flow.spec.ts` (bir test)

**Interfaces:**
- Produces: `ServiceRequestCreationContext.draftToken?: string | null`; `ShowcaseLeadService.createLead(cardId, dto, user, meta, options?: { draftToken?: string | null })`.

- [ ] **Step 1: Testler**

`request-drafts.spec.ts`:

```ts
describe('consumption', () => {
  const guestBody = {
    categorySlug: '', // set per test
    customerName: 'Taslak Sahibi',
    customerPhone: '05554440001',
    customerEmail: 'draft@example.test',
    city: 'İstanbul',
    district: 'Kadıköy',
    description: 'Klima bakımı',
    answers: [],
  };

  async function leafCategory() {
    return ctx.prisma.serviceCategory.create({
      data: { name: 'Klima Servisi', slug: 'klima-servisi', kind: 'LEAF', status: 'ACTIVE', isActive: true, sortOrder: 0, offerCreditCost: 2 },
    });
  }

  it('marks the anonymous draft consumed and bound to the customer the request created', async () => {
    const category = await leafCategory();
    const created = await post(marketplace);

    const response = await request(ctx.server)
      .post('/service-requests')
      .set('Cookie', `${COOKIE}=${created.body.token}`)
      .send({ ...guestBody, categorySlug: category.slug });

    expect(response.status).toBe(201);
    const row = await ctx.prisma.requestDraft.findFirstOrThrow();
    expect(row.consumedAt).not.toBeNull();
    expect(row.userId).toBe(response.body.customerId);
    expect((await get(mpQuery, created.body.token)).status).toBe(204);
  });

  it('leaves a draft protected for another account untouched and still creates the request', async () => {
    const category = await leafCategory();
    const owner = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: '05554440001', email: 'draft@example.test' });
    const created = await post(marketplace);

    // Somebody else submits from the same browser with their own contact.
    const response = await request(ctx.server)
      .post('/service-requests')
      .set('Cookie', `${COOKIE}=${created.body.token}`)
      .send({ ...guestBody, categorySlug: category.slug, customerPhone: '05554440077', customerEmail: 'other@example.test' });

    expect(response.status).toBe(201);
    const row = await ctx.prisma.requestDraft.findFirstOrThrow();
    expect(row.consumedAt).toBeNull();
    expect(row.expectedUserId).toBe(owner.id);
  });

  it('consumes a protected draft when its expected customer submits', async () => {
    const category = await leafCategory();
    const owner = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: '05554440001', email: 'draft@example.test' });
    const created = await post(marketplace);

    const response = await request(ctx.server)
      .post('/service-requests')
      .set('Cookie', [`${COOKIE}=${created.body.token}`, await loginAs(ctx.prisma, owner.id)].join('; '))
      .send({ categorySlug: category.slug, city: 'İstanbul', district: 'Kadıköy', description: 'Klima', answers: [] });

    expect(response.status).toBe(201);
    const row = await ctx.prisma.requestDraft.findFirstOrThrow();
    expect(row.consumedAt).not.toBeNull();
    expect(row.userId).toBe(owner.id);
  });
});
```

`showcase-lead-flow.spec.ts` içine (import `RequestDraftFormType` gerekmiyor):

```ts
  it('consumes the browser’s vitrin draft inside the lead transaction', async () => {
    const { card, category } = await published();
    const draft = await request(ctx.server).post('/request-drafts').send({
      formType: 'SHOWCASE_LEAD', categorySlug: category.slug, cardId: card.id,
      payload: { description: 'Vitrin taslağı', answers: [] },
      identity: { phone: '05557770001', email: 'vitrin-draft@example.test' },
    });
    const payload = showcaseLeadPayload(category.slug, { customerPhone: '05557770001', customerEmail: 'vitrin-draft@example.test' });
    await proveShowcaseLeadPhone(ctx.prisma, '05557770001');

    const response = await request(ctx.server)
      .post(`/showcase/cards/${card.id}/leads`)
      .set('Cookie', `taktic_request_draft=${draft.body.token}`)
      .send(payload);

    expect(response.status).toBe(201);
    const row = await ctx.prisma.requestDraft.findFirstOrThrow();
    expect(row.consumedAt).not.toBeNull();
    expect(await ctx.prisma.showcaseLead.count()).toBe(1);
  });
```

- [ ] **Step 2: Başarısız olduğunu gör** — Run: `cd apps/api && npx vitest run test/request-drafts.spec.ts -t consumption` → FAIL (`consumedAt` null).

- [ ] **Step 3: Uygula**

`service-requests.service.ts`:
- Context'e ekle:
  ```ts
  /**
   * The draft token the browser carried (see RequestDraftsService). Consumed
   * inside the creation transaction so "the request exists" and "the draft is
   * used up" are one fact; a draft protected for another account is skipped.
   */
  draftToken?: string | null;
  ```
- Constructor'a `@Inject(RequestDraftsService) private readonly drafts: RequestDraftsService` ekle; modüle `RequestDraftsModule` import et.
- `runSerializable` bloğunda, `context.onCreated` çağrısından **önce**:
  ```ts
      await this.drafts.consumeInTransaction(
        tx,
        context.draftToken ?? null,
        {
          formType: context.directShowcaseProviderId ? 'SHOWCASE_LEAD' : 'MARKETPLACE',
          categorySlug,
          cardId: context.draftCardId ?? null,
        },
        created.customerId,
      );
  ```
  Context'e ayrıca `draftCardId?: string | null` ekle (vitrin path kart id'sini verir); `categorySlug` = DTO'daki giriş slug'ı (`normalizeRequiredString(dto.categorySlug)` sonucu, üstte zaten `categorySlug` değişkeni).

`service-requests.controller.ts`:
```ts
  @Post()
  @UseGuards(OptionalAuthGuard)
  createServiceRequest(@Body() dto: CreateServiceRequestDto, @CurrentUser() user: AuthUser | null, @Req() req: { headers?: Record<string, string | string[] | undefined> }) {
    return this.serviceRequestsService.createServiceRequest(dto, user, { draftToken: getDraftTokenFromRequest(req) });
  }
```

`showcase-public.controller.ts` `createLead`: `this.leads.createLead(cardId, dto, user ?? null, readMeta(req), { draftToken: getDraftTokenFromRequest(req) })`. `showcase-lead.service.ts` `createLead(..., options: { draftToken?: string | null } = {})` ve `createServiceRequest` context'ine `draftToken: options.draftToken ?? null, draftCardId: live.cardId` ekle.

- [ ] **Step 4: Testler** — Run: `cd apps/api && npx vitest run test/request-drafts.spec.ts test/showcase-lead-flow.spec.ts test/service-requests*.spec.ts` → PASS. Ardından `cd apps/api && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.test.json` → temiz.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat(api): talep transaction'ında taslak tüketimi

Cookie'deki token talep oluşturma context'ine girer; talep yazıldıktan sonra
aynı transaction'da consumedAt/userId; başka hesaba kilitli taslak dokunulmaz.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Web altyapısı — ret metni, XFF iletimi, taslak action'ları, proxy route'ları

**Files:**
- Create: `apps/web/lib/request-refusal-text.ts` (içerik: mevcut `apps/web/lib/showcase-lead-errors.ts` + `CUSTOMER_IDENTITY_CONFLICT`), sil: `apps/web/lib/showcase-lead-errors.ts`; testi yeniden adlandır `apps/web/test/request-refusal-text.spec.ts`
- Create: `apps/web/lib/forwarded-for.ts`, Test: `apps/web/test/forwarded-for.spec.ts`
- Create: `apps/web/lib/request-drafts.ts` (server actions)
- Create: `apps/web/app/api/auth/request-identity-check/route.ts`, `apps/web/app/api/auth/request-identity-check/activate/route.ts`
- Modify: `apps/web/app/vitrin/[cardId]/lead-form.tsx` (import yolu)

**Interfaces:**
- Produces:
  ```ts
  // lib/request-refusal-text.ts
  export const REQUEST_REFUSAL_GENERIC = 'SHOWCASE_LEAD_FAILED'; // kod adı korunur
  export function requestRefusalText(f: { code: string; message: string | null }): string;
  // lib/forwarded-for.ts
  export function forwardedForHeaders(received: string | null, trustProxy: boolean): Record<string, string>;
  export async function clientForwardingHeaders(): Promise<Record<string, string>>; // headers() + WEB_TRUST_PROXY
  // lib/request-drafts.ts ('use server')
  export type DraftFormType = 'MARKETPLACE' | 'SHOWCASE_LEAD';
  export type SaveDraftResult = { ok: true } | { ok: false; code: 'DRAFT_EXISTS' | 'DRAFT_NOT_CONTINUABLE' | 'DRAFT_BUSY' | 'DRAFT_FAILED' };
  export async function saveRequestDraftAction(input: { formType: DraftFormType; categorySlug: string; cardId?: string | null; payload: Record<string, unknown>; identity: { phone: string; email: string }; replace?: boolean }): Promise<SaveDraftResult>;
  export async function discardRequestDraftAction(): Promise<void>;
  export async function clearRequestDraftCookie(): Promise<void>;   // sadece cookie
  export async function readCurrentDraft(key: { formType: DraftFormType; categorySlug: string; cardId?: string | null }): Promise<{ kind: 'none' } | { kind: 'payload'; payload: RequestDraftPayload } | { kind: 'wrong-account' }>;
  export type RequestDraftPayload = { city?: string; district?: string; neighborhood?: string; addressNote?: string; urgency?: string; urgencyBucket?: string; preferredDate?: string; budgetMin?: number; budgetMax?: number; description?: string; answers?: { questionKey: string; value: unknown }[]; routerSelections?: { questionKey: string; optionKey: string }[] };
  export function draftPayloadFromForm(formData: FormData, questionMeta: string): RequestDraftPayload;
  ```

- [ ] **Step 1: Testleri yaz**

`apps/web/test/request-refusal-text.spec.ts` — mevcut `showcase-lead-errors.spec.ts`'i taşı, importu `../lib/request-refusal-text` yap, `showcaseLeadRefusalText` → `requestRefusalText`, `SHOWCASE_LEAD_FAILED` → `REQUEST_REFUSAL_GENERIC`; ek test:

```ts
  it('names the identity conflict in the product’s words', () => {
    expect(requestRefusalText({ code: 'CUSTOMER_IDENTITY_CONFLICT', message: 'Telefon ve e-posta farklı müşteri kayıtlarıyla eşleşiyor.' })).toBe(
      'Bu telefon numarası ve e-posta iki farklı müşteri hesabına bağlı. Tek bir hesaba ait iletişim bilgileriyle devam edin.',
    );
  });
```

`apps/web/test/forwarded-for.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { forwardedForHeaders } from '../lib/forwarded-for';

/**
 * The web never invents a client address. With the trusted-proxy flag off it
 * forwards nothing; with it on it forwards exactly the header it received,
 * because that header was written by the edge and the API's own trust-proxy
 * hop count is what picks the real client out of it.
 */
describe('forwardedForHeaders', () => {
  it('forwards nothing when the web is not behind a trusted proxy', () => {
    expect(forwardedForHeaders('1.2.3.4, 5.6.7.8', false)).toEqual({});
  });

  it('forwards the received header verbatim when it is', () => {
    expect(forwardedForHeaders('1.2.3.4, 5.6.7.8', true)).toEqual({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' });
  });

  it('never synthesises a header', () => {
    expect(forwardedForHeaders(null, true)).toEqual({});
    expect(forwardedForHeaders('   ', true)).toEqual({});
  });
});
```

- [ ] **Step 2: Başarısız olduğunu gör** — Run: `cd apps/web && npx vitest run test/request-refusal-text.spec.ts test/forwarded-for.spec.ts` → FAIL (modül yok).

- [ ] **Step 3: Uygula**

`apps/web/lib/request-refusal-text.ts` — `showcase-lead-errors.ts` içeriğini taşı; tabloya ekle:
```ts
  CUSTOMER_IDENTITY_CONFLICT:
    'Bu telefon numarası ve e-posta iki farklı müşteri hesabına bağlı. Tek bir hesaba ait iletişim bilgileriyle devam edin.',
```
Adları: `REQUEST_REFUSAL_GENERIC = 'SHOWCASE_LEAD_FAILED'`, `REQUEST_REFUSAL_TEXTS`, `requestRefusalText`. `git mv apps/web/lib/showcase-lead-errors.ts apps/web/lib/request-refusal-text.ts` ve `git mv apps/web/test/showcase-lead-errors.spec.ts apps/web/test/request-refusal-text.spec.ts`. `lead-form.tsx` importunu güncelle.

`apps/web/lib/forwarded-for.ts`:

```ts
import { headers } from 'next/headers';

/**
 * Whether to pass the client's forwarded address on to the API.
 *
 * Never computed here. When WEB_TRUST_PROXY is on, the X-Forwarded-For the web
 * received was written by a trusted edge in front of it, and it is forwarded
 * untouched — the API's own `trust proxy` hop count (TRUST_PROXY) picks the
 * real client out of it. When the flag is off nothing is forwarded, the API
 * sees the web server's own address, and a client-written header can change
 * nothing. There is no third mode.
 */
export function forwardedForHeaders(received: string | null, trustProxy: boolean): Record<string, string> {
  if (!trustProxy) return {};
  const value = received?.trim();
  return value ? { 'x-forwarded-for': value } : {};
}

export async function clientForwardingHeaders(): Promise<Record<string, string>> {
  const trustProxy = process.env.WEB_TRUST_PROXY === 'true';
  return forwardedForHeaders((await headers()).get('x-forwarded-for'), trustProxy);
}
```

`apps/web/lib/request-drafts.ts`:

```ts
'use server';

import { cookies } from 'next/headers';
import { apiUrl } from '../app/api-base';
import { appCookieOptions } from '../app/session-cookie';
import { apiFetch, ApiError } from './api';
import { clientForwardingHeaders } from './forwarded-for';
import { decodeRouterSelections } from './request-flow';
import { readFormString, readOptionalFormString } from './service-request-payload';
import { parseLiraToMinor } from './lira-input';

const COOKIE_NAME = 'taktic_request_draft';
const TTL_SECONDS = 24 * 60 * 60;

export type DraftFormType = 'MARKETPLACE' | 'SHOWCASE_LEAD';
export type RequestDraftPayload = {
  city?: string; district?: string; neighborhood?: string; addressNote?: string;
  urgency?: string; urgencyBucket?: string; preferredDate?: string;
  budgetMin?: number; budgetMax?: number; description?: string;
  answers?: { questionKey: string; value: unknown }[];
  routerSelections?: { questionKey: string; optionKey: string }[];
};
export type SaveDraftResult =
  | { ok: true }
  | { ok: false; code: 'DRAFT_EXISTS' | 'DRAFT_NOT_CONTINUABLE' | 'DRAFT_BUSY' | 'DRAFT_FAILED' };

/**
 * Parks the form on the server and hands the browser the opaque token as an
 * HttpOnly cookie on the web origin. The token is read from the API's JSON
 * reply here, server to server, and never reaches the page.
 */
export async function saveRequestDraftAction(input: {
  formType: DraftFormType; categorySlug: string; cardId?: string | null;
  payload: RequestDraftPayload; identity: { phone: string; email: string }; replace?: boolean;
}): Promise<SaveDraftResult> {
  const cookieStore = await cookies();
  const existing = cookieStore.get(COOKIE_NAME)?.value;
  const response = await fetch(`${apiUrl}/request-drafts`, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'content-type': 'application/json',
      ...(existing ? { cookie: `${COOKIE_NAME}=${existing}` } : {}),
      ...(await clientForwardingHeaders()),
    },
    body: JSON.stringify({
      formType: input.formType, categorySlug: input.categorySlug,
      ...(input.cardId ? { cardId: input.cardId } : {}),
      payload: input.payload, identity: input.identity,
      ...(input.replace ? { replace: true } : {}),
    }),
  });

  if (!response.ok) {
    let code: string | null = null;
    try { code = (JSON.parse(await response.text()) as { code?: string }).code ?? null; } catch { /* not JSON */ }
    console.error(`[request draft] save refused with ${response.status} code=${code ?? '-'}`);
    if (code === 'DRAFT_EXISTS' || code === 'DRAFT_NOT_CONTINUABLE') return { ok: false, code };
    if (response.status === 429 || response.status === 503) return { ok: false, code: 'DRAFT_BUSY' };
    return { ok: false, code: 'DRAFT_FAILED' };
  }

  const { token } = (await response.json()) as { token: string };
  cookieStore.set(COOKIE_NAME, token, {
    ...(await appCookieOptions({ maxAge: TTL_SECONDS })),
    secure: process.env.NODE_ENV === 'production' || (await appCookieOptions({ maxAge: TTL_SECONDS })).secure,
  });
  return { ok: true };
}

export async function discardRequestDraftAction(): Promise<void> {
  const cookieStore = await cookies();
  if (cookieStore.get(COOKIE_NAME)) {
    try { await apiFetch('/request-drafts/current', { method: 'DELETE' }); } catch { /* best effort */ }
  }
  await clearRequestDraftCookie();
}

export async function clearRequestDraftCookie(): Promise<void> {
  (await cookies()).set(COOKIE_NAME, '', { ...(await appCookieOptions({ maxAge: 0 })), maxAge: 0 });
}

export async function readCurrentDraft(key: { formType: DraftFormType; categorySlug: string; cardId?: string | null }) {
  if (!(await cookies()).get(COOKIE_NAME)) return { kind: 'none' as const };
  const query = new URLSearchParams({ formType: key.formType, categorySlug: key.categorySlug, ...(key.cardId ? { cardId: key.cardId } : {}) });
  try {
    const response = await fetch(`${apiUrl}/request-drafts/current?${query}`, {
      cache: 'no-store',
      headers: { cookie: (await cookies()).toString() },
    });
    if (response.status === 204) return { kind: 'none' as const };
    if (!response.ok) return { kind: 'none' as const };
    const body = (await response.json()) as { payload?: RequestDraftPayload; status?: string };
    if (body.status === 'wrong-account') return { kind: 'wrong-account' as const };
    return body.payload ? { kind: 'payload' as const, payload: body.payload } : { kind: 'none' as const };
  } catch {
    return { kind: 'none' as const };
  }
}

/** The draft payload from a posted form: the request body minus every contact field. */
export async function draftPayloadFromForm(formData: FormData): Promise<RequestDraftPayload> {
  const questionMeta = readFormString(formData, 'questionMeta');
  let meta: { key: string; type: string }[] = [];
  try { meta = JSON.parse(questionMeta || '[]'); } catch { meta = []; }
  const answers = meta.map((q) => ({
    questionKey: q.key,
    value: q.type === 'MULTI_SELECT'
      ? formData.getAll(`answer_${q.key}`).filter((v): v is string => typeof v === 'string' && v !== '')
      : q.type === 'BOOLEAN'
        ? formData.get(`answer_${q.key}`) === 'true'
        : readFormString(formData, `answer_${q.key}`),
  }));
  const opt = (k: string) => readOptionalFormString(formData, k) ?? undefined;
  const budgetMin = parseLiraToMinor(readFormString(formData, 'budgetMin'));
  const budgetMax = parseLiraToMinor(readFormString(formData, 'budgetMax'));
  return {
    city: opt('city'), district: opt('district'), neighborhood: opt('neighborhood'), addressNote: opt('addressNote'),
    urgency: opt('urgency'), urgencyBucket: opt('urgencyBucket'), preferredDate: opt('preferredDate'),
    ...(budgetMin !== null ? { budgetMin } : {}), ...(budgetMax !== null ? { budgetMax } : {}),
    description: opt('description'), answers,
    routerSelections: decodeRouterSelections(readOptionalFormString(formData, 'routerSelections')),
  };
}
```

> `'use server'` dosyasında yalnız async fonksiyon export edilebilir; `draftPayloadFromForm` bu yüzden async. Tipler (`type`) export edilebilir.

Proxy route'ları — `apps/web/app/api/auth/request-identity-check/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { apiUrl } from '../../../api-base';
import { clientForwardingHeaders } from '../../../../lib/forwarded-for';

/**
 * Same-origin hop for the identity pre-check. Forwards the body as-is and the
 * API's status as-is; no cookies travel (the endpoint is session-less), and the
 * client address is forwarded only under the trusted-proxy rule.
 */
export async function POST(request: NextRequest) {
  const body = await request.text();
  try {
    const upstream = await fetch(`${apiUrl}/auth/request-identity-check`, {
      method: 'POST', cache: 'no-store',
      headers: { 'content-type': 'application/json', ...(await clientForwardingHeaders()) },
      body,
    });
    return new NextResponse(await upstream.text(), { status: upstream.status, headers: { 'content-type': 'application/json' } });
  } catch {
    return NextResponse.json({ code: 'IDENTITY_CHECK_UNAVAILABLE' }, { status: 503 });
  }
}
```

`…/activate/route.ts` aynı şekilde `/auth/request-identity-check/activate`'e.

- [ ] **Step 4: Testler ve typecheck** — Run: `cd apps/web && npx vitest run && npx tsc -p tsconfig.json --noEmit` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): taslak action'ları, kimlik proxy route'ları, güvenli XFF iletimi, ortak ret metni

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: `useIdentityCheck` + `IdentityNotice` + ContactSection yuvası

**Files:**
- Create: `apps/web/app/request-fields/identity-check.ts`, `apps/web/app/request-fields/identity-notice.tsx`
- Modify: `apps/web/app/request-fields/contact-section.tsx` (`identityNotice?: ReactNode` prop'u, e-posta alanının altına; oturumlu "farklı iletişim kişisi" alt metni)
- Modify: `apps/web/app/globals.css`
- Test: `apps/web/test/identity-check.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export type IdentityStatus = 'idle' | 'checking' | 'ok' | 'login-required' | 'activation-required' | 'identity-conflict' | 'unavailable' | 'error';
  export type IdentityState = { status: IdentityStatus; seq: number; phone: string; email: string };
  export function identityReducer(state: IdentityState, action: IdentityAction): IdentityState;
  export function useIdentityCheck(input: { name: string; phone: string; email: string; enabled: boolean }): { status: IdentityStatus; check(): void; retry(): void; gateOpen: boolean };
  export function IdentityNotice(props: { status: IdentityStatus; onRetry(): void; onLogin(): Promise<void> | void; onActivate(): Promise<void> | void; draftError: 'DRAFT_BUSY' | 'DRAFT_FAILED' | null; draftExists: boolean; onReplaceDraft(): void; onKeepDraft(): void; activationSent: boolean; wrongAccount: boolean; changeAccountHref: string }): JSX.Element | null;
  ```
  `gateOpen === (status === 'ok')`.

- [ ] **Step 1: Saf reducer testi**

`apps/web/test/identity-check.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { identityReducer, type IdentityState } from '../app/request-fields/identity-check';

const base: IdentityState = { status: 'idle', seq: 0, phone: '', email: '' };

describe('identityReducer', () => {
  it('starts a check with a new sequence number', () => {
    const next = identityReducer(base, { type: 'start', phone: '0555', email: 'a@x.test' });
    expect(next).toEqual({ status: 'checking', seq: 1, phone: '0555', email: 'a@x.test' });
  });

  it('applies only the latest response', () => {
    const one = identityReducer(base, { type: 'start', phone: '0555', email: 'a@x.test' });
    const two = identityReducer(one, { type: 'start', phone: '0555', email: 'b@x.test' });
    const stale = identityReducer(two, { type: 'result', seq: 1, status: 'ok' });
    expect(stale.status).toBe('checking');
    const fresh = identityReducer(two, { type: 'result', seq: 2, status: 'login-required' });
    expect(fresh.status).toBe('login-required');
  });

  it('falls back to idle when the phone or e-mail changes', () => {
    const ok = identityReducer(identityReducer(base, { type: 'start', phone: '0555', email: 'a@x.test' }), { type: 'result', seq: 1, status: 'ok' });
    expect(identityReducer(ok, { type: 'fields', phone: '0556', email: 'a@x.test' }).status).toBe('idle');
    expect(identityReducer(ok, { type: 'fields', phone: '0555', email: 'a@x.test' }).status).toBe('ok');
  });

  it('turns a failed call into error, never ok', () => {
    const checking = identityReducer(base, { type: 'start', phone: '0555', email: 'a@x.test' });
    expect(identityReducer(checking, { type: 'failure', seq: 1 }).status).toBe('error');
  });
});
```

- [ ] **Step 2: Başarısız olduğunu gör** — Run: `cd apps/web && npx vitest run test/identity-check.spec.ts` → FAIL.

- [ ] **Step 3: Hook ve reducer**

`apps/web/app/request-fields/identity-check.ts`:

```ts
'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';

export type IdentityStatus =
  | 'idle' | 'checking' | 'ok' | 'login-required' | 'activation-required'
  | 'identity-conflict' | 'unavailable' | 'error';

export type IdentityState = { status: IdentityStatus; seq: number; phone: string; email: string };

export type IdentityAction =
  | { type: 'start'; phone: string; email: string }
  | { type: 'result'; seq: number; status: Exclude<IdentityStatus, 'idle' | 'checking' | 'error'> }
  | { type: 'failure'; seq: number }
  | { type: 'fields'; phone: string; email: string };

/**
 * The pre-check's state machine, kept pure so the two rules that matter can be
 * tested without a browser: only the latest call's answer counts, and a
 * changed number or address throws the answer away.
 */
export function identityReducer(state: IdentityState, action: IdentityAction): IdentityState {
  switch (action.type) {
    case 'start':
      return { status: 'checking', seq: state.seq + 1, phone: action.phone, email: action.email };
    case 'result':
      return action.seq === state.seq ? { ...state, status: action.status } : state;
    case 'failure':
      return action.seq === state.seq ? { ...state, status: 'error' } : state;
    case 'fields':
      return action.phone === state.phone && action.email === state.email ? state : { ...state, status: 'idle', phone: action.phone, email: action.email };
  }
}

const API_STATUSES = new Set(['new-customer', 'login-required', 'activation-required', 'identity-conflict', 'unavailable']);

export function useIdentityCheck(input: { name: string; phone: string; email: string; enabled: boolean }) {
  const [state, dispatch] = useReducer(identityReducer, { status: 'idle', seq: 0, phone: '', email: '' });
  const controllerRef = useRef<AbortController | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    dispatch({ type: 'fields', phone: input.phone, email: input.email });
  }, [input.phone, input.email]);

  const check = useCallback(() => {
    if (!input.enabled) return;
    const phone = input.phone.trim();
    const email = input.email.trim();
    if (!input.name.trim() || phone.length < 7 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return;

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    seqRef.current += 1;
    const seq = seqRef.current;
    dispatch({ type: 'start', phone: input.phone, email: input.email });

    fetch('/api/auth/request-identity-check', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone, email }), signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const body = (await response.json()) as { status?: string };
        if (!body.status || !API_STATUSES.has(body.status)) throw new Error('bad body');
        dispatch({ type: 'result', seq, status: body.status === 'new-customer' ? 'ok' : (body.status as IdentityAction extends { status: infer S } ? S : never) });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        void error;
        dispatch({ type: 'failure', seq });
      });
  }, [input.enabled, input.name, input.phone, input.email]);

  return { status: input.enabled ? state.status : ('ok' as const), check, retry: check, gateOpen: !input.enabled || state.status === 'ok' };
}
```

> `seqRef` ve reducer'ın `seq`'i birlikte artar (`start` her ikisini bir arttırır); `result` dispatch'i `seqRef.current`'ın o çağrıdaki değerini taşır. Tip cast satırını `as 'login-required' | 'activation-required' | 'identity-conflict' | 'unavailable'` olarak sadeleştir.

- [ ] **Step 4: `IdentityNotice`**

`apps/web/app/request-fields/identity-notice.tsx` — spec §2.2 metinleri harfi harfine:

```tsx
'use client';

import type { IdentityStatus } from './identity-check';

type Props = {
  status: IdentityStatus;
  onRetry: () => void;
  onLogin: () => void | Promise<void>;
  onActivate: () => void | Promise<void>;
  activationSent: boolean;
  draftError: 'DRAFT_BUSY' | 'DRAFT_FAILED' | null;
  draftExists: boolean;
  onReplaceDraft: () => void;
  onKeepDraft: () => void;
  wrongAccount: boolean;
  changeAccountHref: string;
  busy: boolean;
};

export function IdentityNotice(p: Props) {
  if (p.wrongAccount) {
    return (
      <div className="notice cdash-notice-error identity-notice" role="alert" data-testid="identity-wrong-account">
        <span>Bu talebe devam etmek için iletişim bilgilerine bağlı hesabınızla giriş yapın.</span>
        <a className="btn btn-secondary" href={p.changeAccountHref}>Hesap değiştir</a>
      </div>
    );
  }
  if (p.draftExists) {
    return (
      <div className="notice identity-notice" role="alertdialog" data-testid="identity-draft-exists">
        <span>Yeni taslağa geçerseniz önceki taslak silinir. Devam edilsin mi?</span>
        <div className="inline-actions">
          <button type="button" className="btn btn-primary" onClick={p.onReplaceDraft} disabled={p.busy}>Evet, geç</button>
          <button type="button" className="btn btn-secondary" onClick={p.onKeepDraft} disabled={p.busy}>Vazgeç</button>
        </div>
      </div>
    );
  }
  if (p.draftError) {
    return (
      <div className="notice cdash-notice-error identity-notice" role="alert" data-testid="identity-draft-error">
        <span>Taslak şu anda kaydedilemedi. Birkaç dakika sonra tekrar deneyin.</span>
        <button type="button" className="btn btn-secondary" onClick={p.onRetry} disabled={p.busy}>Tekrar dene</button>
      </div>
    );
  }
  switch (p.status) {
    case 'checking':
      return <p className="help-text" role="status" data-testid="identity-checking">İletişim bilgileriniz kontrol ediliyor…</p>;
    case 'identity-conflict':
      return (
        <div className="notice cdash-notice-error identity-notice" role="alert" data-testid="identity-conflict">
          Bu telefon numarası ve e-posta iki farklı müşteri hesabına bağlı. Tek bir hesaba ait iletişim bilgileriyle devam edin.
        </div>
      );
    case 'login-required':
      return (
        <div className="notice identity-notice" role="alert" data-testid="identity-login-required">
          <span>Bu iletişim bilgileriyle bir hesabınız var. Talebinizi hesabınızla devam ettirmek için giriş yapın.</span>
          <button type="button" className="btn btn-primary" onClick={() => void p.onLogin()} disabled={p.busy} data-testid="identity-login-cta">Giriş yap</button>
        </div>
      );
    case 'activation-required':
      return (
        <div className="notice identity-notice" role="alert" data-testid="identity-activation-required">
          {p.activationSent ? (
            <span data-testid="identity-activation-sent">Bağlantıyı hesabınıza kayıtlı e-posta adresine gönderdik. Şifrenizi belirlediğinizde kaldığınız yerden devam edeceksiniz.</span>
          ) : (
            <>
              <span>Bu bilgilerle daha önce oluşturulmuş hesabınızı etkinleştirin.</span>
              <button type="button" className="btn btn-primary" onClick={() => void p.onActivate()} disabled={p.busy} data-testid="identity-activate-cta">Etkinleştirme bağlantısı gönder</button>
            </>
          )}
        </div>
      );
    case 'unavailable':
      return (
        <div className="notice cdash-notice-error identity-notice" role="alert" data-testid="identity-unavailable">
          Bu iletişim bilgileri müşteri talebi için kullanılamaz. Farklı bir telefon numarası veya e-posta girin.
        </div>
      );
    case 'error':
      return (
        <div className="notice cdash-notice-error identity-notice" role="alert" data-testid="identity-error">
          <span>İletişim bilgileri doğrulanamadı, tekrar deneyin.</span>
          <button type="button" className="btn btn-secondary" onClick={p.onRetry} disabled={p.busy}>Tekrar dene</button>
        </div>
      );
    default:
      return null;
  }
}
```

`contact-section.tsx`: prop `identityNotice?: ReactNode`; misafir dalında e-posta `<label>`'ının hemen altına `{identityNotice}`; oturumlu dalda "Farklı bir iletişim kişisi kullanacağım" etiketinin altına `<span className="help-text">Talep yine hesabınıza bağlı kalır; yalnız bu talep için iletişim kişisi değişir.</span>` ekle. Misafir alanlarına `onBlur` desteği: prop `onContactBlur?: () => void` — üç misafir input'una `onBlur={onContactBlur}` (alternate kişi alanlarına **değil**; oturumlu kontrol yok).

`globals.css`: `.identity-notice { display:flex; flex-wrap:wrap; align-items:center; gap: var(--space-3); } .identity-notice > span { flex: 1 1 240px; }`.

- [ ] **Step 5: Testler + typecheck** — Run: `cd apps/web && npx vitest run && npx tsc -p tsconfig.json --noEmit` → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "feat(web): useIdentityCheck reducer/hook ve IdentityNotice; ContactSection'a kimlik yuvası

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Ortak alanlara `defaultValue` (taslak geri yükleme için)

**Files:**
- Modify: `apps/web/app/request-fields/question-field.tsx` (`RequestField({ question, defaultValue? })`), `description-field.tsx` (`defaultValue?: string`), `timing-fields.tsx` (`UrgencySelect defaultValue?: string`), `location-fields.tsx` (zaten `initialValue`), `apps/web/app/categories/[slug]/budget-fields.tsx` (`defaultMin?: number | null`, `defaultMax?: number | null` — kuruş; `formatLira` ile metne çevir)

**Interfaces:**
- Produces: `RequestField({ question, defaultValue?: unknown })` — SELECT/TEXT/NUMBER/DATE `defaultValue={String(v)}`, MULTI_SELECT `defaultValue={string[]}`, BOOLEAN `defaultChecked={v === true || v === 'true'}`; `DescriptionField({ defaultValue })` textarea `defaultValue`; `UrgencySelect({ defaultValue })`; `BudgetFields({ defaultMin, defaultMax })`.

- [ ] **Step 1: Uygula** — her bileşende `defaultValue` prop'unu ilgili kontrole geçir. `question-field.tsx`'te `renderInput(question, defaultValue)`; `description-field.tsx`'te `useEffect` mount okuması `defaultValue?.length ?? 0` ile başlasın. `budget-fields.tsx`: dosyanın mevcut `useState('')` başlangıçlarını `formatLira(defaultMin)` gibi değerlerle başlat (`lib/lira-input.ts` içindeki mevcut formatlayıcıyı kullan; adı farklıysa onu kullan).
- [ ] **Step 2: Typecheck ve mevcut testler** — Run: `cd apps/web && npx tsc -p tsconfig.json --noEmit && npx vitest run` → PASS.
- [ ] **Step 3: Commit**

```bash
git add apps/web/app/request-fields apps/web/app/categories/[slug]/budget-fields.tsx
git commit -m "feat(web): ortak talep alanlarına defaultValue — taslak geri yükleme hazırlığı

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: Normal talep formu — İletişim ilk adım, gate, inline hata, taslak

**Files:**
- Modify: `apps/web/app/categories/[slug]/request-form.tsx`, `apps/web/app/categories/[slug]/page.tsx`, `apps/web/app/categories/actions.ts`

**Interfaces:**
- Consumes: Task 8 (`saveRequestDraftAction`, `readCurrentDraft`, `draftPayloadFromForm`, `clearRequestDraftCookie`, `requestRefusalText`), Task 9, Task 10.
- Produces: `RequestForm` yeni proplar: `initialDraft?: RequestDraftPayload | null`, `wrongAccount?: boolean`, `formPath: string` (redirectTo için, ör. `/categories/klima-servisi`), `action: (formData: FormData) => Promise<{ ok: true; requestId: string } | { ok: false; code: string; message: string | null }>`.

- [ ] **Step 1: `submitServiceRequestAction` sonuç döndürsün**

`apps/web/app/categories/actions.ts`:

```ts
export type SubmitRequestResult =
  | { ok: true; requestId: string }
  | { ok: false; code: string; message: string | null };

export async function submitServiceRequestAction(formData: FormData): Promise<SubmitRequestResult> {
  try {
    const request = await apiFetch<ServiceRequest>('/service-requests', {
      method: 'POST',
      body: JSON.stringify(buildServiceRequestPayload(formData)),
    });
    // The API consumed the draft inside the request's transaction; only the
    // browser's cookie is left to clear.
    await clearRequestDraftCookie();
    return { ok: true, requestId: request.id };
  } catch (error) {
    return describeRefusal('service-requests', error);
  }
}

function describeRefusal(step: string, error: unknown): SubmitRequestResult {
  if (!(error instanceof ApiError)) {
    console.error(`[request] ${step}: unexpected failure`, error);
    return { ok: false, code: 'SHOWCASE_LEAD_FAILED', message: null };
  }
  let code: string | null = null;
  let message: string | null = null;
  try {
    const parsed = JSON.parse(error.body) as { code?: unknown; message?: unknown };
    if (typeof parsed.code === 'string') code = parsed.code;
    const raw = Array.isArray(parsed.message) ? parsed.message[0] : parsed.message;
    if (typeof raw === 'string' && raw.trim()) message = raw.trim();
  } catch { /* not JSON */ }
  console.error(`[request] ${step}: API refused with ${error.status} code=${code ?? '-'} message=${JSON.stringify(message ?? '-')}`);
  const userFacing = error.status >= 400 && error.status < 500;
  return { ok: false, code: code ?? 'SHOWCASE_LEAD_FAILED', message: userFacing ? message : null };
}

export async function saveMarketplaceDraftAction(formData: FormData, replace: boolean) {
  return saveRequestDraftAction({
    formType: 'MARKETPLACE',
    categorySlug: readFormString(formData, 'categorySlug'),
    payload: await draftPayloadFromForm(formData),
    identity: { phone: readFormString(formData, 'customerPhone'), email: readFormString(formData, 'customerEmail') },
    replace,
  });
}
```

`describeRefusal`'ı `apps/web/lib/api-refusal.ts` olarak çıkar ve vitrin `actions.ts`'deki `describeFailure` ile tekilleştir (aynı gövde; `SHOWCASE_LEAD_FORBIDDEN` 403 dalı dahil).

- [ ] **Step 2: Sayfa: taslak ve `wrongAccount`**

`page.tsx`: `const draft = await readCurrentDraft({ formType: 'MARKETPLACE', categorySlug: slug });` → `<RequestForm … initialDraft={draft.kind === 'payload' ? draft.payload : null} wrongAccount={draft.kind === 'wrong-account'} formPath={`/categories/${slug}${entry || r ? `?${new URLSearchParams({ ...(entry ? { entry } : {}), ...(r ? { r } : {}) })}` : ''}`} />`.

- [ ] **Step 3: RequestForm**

Değişiklikler (dosyadaki mevcut yapıyı koru):
1. `STEPS = [{ key: 'contact', label: 'İletişim' }, { key: 'detail', label: 'İş detayı' }, { key: 'place', label: 'Konum & zaman' }]`; `stepRefs = [contactRef, detailRef, placeRef]`; panel `hidden` koşulları yeni indekslerle (`contact: step !== 0`, `detail: step !== 1`, `place: step !== 2`); JSX'te iletişim panelini üste taşı.
2. Misafir iletişim state'i: `const [guestContact, setGuestContact] = useState({ name: '', phone: '', email: '' })` → `ContactSection`'a `guestContact/onGuestContactChange` ver (kontrollü). `const identity = useIdentityCheck({ ...guestContact, enabled: accountContact === null });` `ContactSection`'a `onContactBlur={identity.check}` ve `identityNotice={<IdentityNotice … />}`.
3. `goTo(index)`: `if (index > step && step === 0 && !identity.gateOpen) { identity.check(); return; }` — adım 1'den çıkış yalnız `ok`.
4. Submit: `<form ref={formRef} onSubmit={handleSubmit}>` (`action` prop'u kaldır); `handleSubmit`: `preventDefault`, `if (!identity.gateOpen && !accountContact) return;`, `startTransition(async () => { const r = await action(new FormData(form)); if (r.ok) router.push(`/requests/success?id=${r.requestId}`); else setFailure(r); })`. Hata bandı: `{failure ? <div className="notice cdash-notice-error" role="alert" data-testid="request-submit-error">{requestRefusalText(failure)}</div> : null}` iletişim panelinin üstünde. `useRouter` from `next/navigation`.
5. Login CTA: `onLogin = async () => { const r = await saveMarketplaceDraftAction(new FormData(formRef.current!), false); if (r.ok) { window.location.assign(`/login?redirectTo=${encodeURIComponent(formPath)}`); return; } if (r.code === 'DRAFT_EXISTS') setDraftExists(true); else if (r.code === 'DRAFT_NOT_CONTINUABLE') identity.check(); else setDraftError(r.code); }`. `onReplaceDraft` aynı çağrı `replace: true`. `onActivate`: önce taslak (aynı yol), sonra `fetch('/api/auth/request-identity-check/activate', { method: 'POST', body: JSON.stringify({ phone, email, redirectTo: formPath }) })` → `setActivationSent(true)` (yanıt her zaman 202).
6. Taslak geri yükleme: `initialDraft` → `LocationFields initialValue`, `DescriptionField defaultValue`, `RequestField defaultValue={initialDraft?.answers?.find(a => a.questionKey === q.key)?.value}`, `UrgencySelect defaultValue`, `preferredDate` input `defaultValue`, `addressNote` textarea `defaultValue`, `BudgetFields defaultMin/defaultMax`. `wrongAccount` → `IdentityNotice wrongAccount changeAccountHref={`/logout?redirectTo=${encodeURIComponent(`/login?redirectTo=${encodeURIComponent(formPath)}`)}`}` (logout route'u `redirectTo` desteklemiyorsa `/login?redirectTo=…`'ya götüren mevcut çıkış yolunu kullan; `apps/web/app/session/` altındaki logout action'ına bak).
7. "Vazgeç" (varsa) → `discardRequestDraftAction()`.

- [ ] **Step 4: Typecheck** — `cd apps/web && npx tsc -p tsconfig.json --noEmit` → temiz.

- [ ] **Step 5: Tarayıcıda hızlı doğrulama** — `preview_start name=web-3010` ile `/categories/klima-servisi`: İletişim ilk adım; üç alan doldurulup çıkılınca `/api/auth/request-identity-check` çağrısı (`read_network_requests`), `identity-checking` → sonuç; `Devam et` `ok` dışı kilitli.

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "feat(web): normal talep formu — İletişim ilk adım, kimlik gate'i, inline ret, taslakla devam

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: Vitrin direct-lead formu — İletişim ilk bölüm, gate, taslak

**Files:**
- Modify: `apps/web/app/vitrin/[cardId]/lead-form.tsx`, `page.tsx`, `actions.ts`

**Interfaces:**
- Consumes: Task 8–10. `ShowcaseLeadForm` yeni proplar: `initialDraft?: RequestDraftPayload | null`, `wrongAccount?: boolean`, `formPath: string` (`/vitrin/<id>?step=form`).
- `actions.ts`: `createShowcaseLeadAction` başarıda `clearRequestDraftCookie()` sonra `redirect`; `saveShowcaseDraftAction(formData, replace)` (`formType: 'SHOWCASE_LEAD'`, `cardId`).

- [ ] **Step 1: Bölüm sırası ve gate**

`lead-form.tsx`:
1. `<section>` sırası: İletişim → Talebiniz → İşin yapılacağı yer → Zamanlama → onay.
2. `const identity = useIdentityCheck({ name: guestContact.name, phone: guestContact.phone, email: guestContact.email, enabled: accountContact === null });` `ContactSection`'a `onContactBlur={identity.check}`, `identityNotice={<IdentityNotice …/>}`.
3. `PhoneProof` `onSend` yalnız `identity.gateOpen` iken çalışır; "Kod gönder" `disabled={busy || !phone.trim() || !identity.gateOpen}`; submit `disabled={!verified || submitBlocked || pending || !identity.gateOpen}`. Gate kapalıyken submit-hint metni: "Göndermeden önce iletişim bilgilerinizin kontrolü tamamlanmalı."
4. Taslak: `initialDraft` → `LocationFields initialValue={initialDraft ? {city,district,neighborhood} : prefill}`, `DescriptionField defaultValue`, `RequestField defaultValue`, `UrgencySelect defaultValue`, radyolar `defaultChecked={initialDraft?.urgencyBucket === 'URGENT'|'NORMAL'}`.
5. Login/Activate/Replace/Keep akışı Task 11 §3.5 ile aynı, `saveShowcaseDraftAction` ile; `redirectTo = formPath`.
6. `wrongAccount` notice'i formun üstünde.
7. "Vazgeç" linki → `discardRequestDraftAction()` sonra `/vitrin/<id>`'ye git (buton + `startTransition`).

`page.tsx`: `const draft = await readCurrentDraft({ formType: 'SHOWCASE_LEAD', categorySlug: card.category.slug, cardId });` → proplar; `formPath = `/vitrin/${cardId}?step=form``.

- [ ] **Step 2: Typecheck ve tarayıcı** — `npx tsc`; `preview_start name=web-3010` → `/vitrin/<kart>?step=form`: İletişim üstte; gate `ok` olmadan "Kod gönder" devre dışı; 320px'te taşma 0 (`document.documentElement.scrollWidth === innerWidth`).

- [ ] **Step 3: Commit**

```bash
git add apps/web
git commit -m "feat(web): vitrin direct-lead formu — İletişim ilk bölüm, kimlik gate'i SMS'ten önce, taslakla devam

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 13: Aktivasyon dönüşü — `redirectTo`

**Files:**
- Modify: `apps/web/app/activate-customer/page.tsx` (searchParams `redirectTo`, hidden input), `apps/web/app/activate-customer/actions.ts`

- [ ] **Step 1: Uygula**

`page.tsx`: `const { token, success, error, errorMessage, redirectTo } = await searchParams;` → formda `<input type="hidden" name="redirectTo" value={safeRedirectPathOrNull(redirectTo ?? '') ?? ''} />` (`safeRedirectPathOrNull` from `@taktic/shared`; web bu paketi import edebilir — login action'ı ediyor). Hata redirect'lerinde `redirectTo`'yu `params`'a ekle ki kaybolmasın.

`actions.ts`: `const redirectTo = safeRedirectPathOrNull(readFormString(formData, 'redirectTo'));` … `if (session) { redirect(redirectTo ?? '/requests/my'); }`.

- [ ] **Step 2: Typecheck** — `cd apps/web && npx tsc -p tsconfig.json --noEmit`.
- [ ] **Step 3: Commit**

```bash
git add apps/web/app/activate-customer
git commit -m "feat(web): aktivasyon sonrası doğrulanmış redirectTo'ya dönüş

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 14: E2E — mevcut akışların yeni adım sırasına uyarlanması

**Files:**
- Modify: `e2e/src/journeys.ts`, `e2e/tests/request-location-form.spec.ts`, `request-budget-inputs.spec.ts`, `request-contact-autofill.spec.ts`, `request-description-counter.spec.ts`, `category-expansion.spec.ts`, `contact-sharing.spec.ts`, `showcase-placement-lead.spec.ts`, `showcase-phone-bypass.spec.ts`, `showcase-screens-viewport.spec.ts` (sıraya bağlı olan her yer)

- [ ] **Step 1: `journeys.ts`**

`fillRequestFormUpToContact` → yeni akış: önce `fillContactStep(actor, values)` (adım 1), gate'in `ok` olmasını bekle (`await expect(actor.page.getByTestId('identity-checking')).toHaveCount(0)` ve `Devam et` enabled), `nextStep.click()`, açıklama, `nextStep.click()`, konum. Fonksiyonun adı yanıltıcı olur; `fillRequestForm(actor, values)` olarak yeniden adlandır ve çağıranları güncelle. `fillContactStep` misafir alanlarından çıkınca (`blur`) kontrol tetiklenir: son alanı doldurduktan sonra `await actor.page.getByLabel('E-posta *').blur()` veya `press('Tab')`.

`createRequest`: adım sırası değiştiği için disclosure kutusu artık son adımda (Konum & zaman) render edilmiyorsa — `showDisclosure` bölümü iletişim panelinde kalıyor — kutuyu iletişim adımında işaretle.

- [ ] **Step 2: Spec'leri güncelle** — her spec'te "Devam et" sayısı/sırası ve `openRequestFormContactStep` kullanımlarını yeni sıraya çevir. `request-contact-autofill`: hesap özeti artık adım 1'de. `showcase-placement-lead` ve `showcase-phone-bypass`: iletişim üstte; `proveLeadPhoneInForm` öncesi ad + e-posta doldur ve gate'i bekle (`await expect(page.getByTestId('showcase-lead-phone-send')).toBeEnabled()`).

- [ ] **Step 3: Çalıştır** — Run: `pnpm build && cd e2e && pnpm exec tsx src/prepare-database.ts && pnpm exec playwright test request- showcase-placement-lead showcase-phone-bypass showcase-screens-viewport category-expansion contact-sharing --project=chromium` → hepsi PASS.

- [ ] **Step 4: Commit**

```bash
git add e2e
git commit -m "test(e2e): talep formlarında İletişim ilk adım — journey ve spec'ler yeni sıraya uyarlandı

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 15: E2E — `request-identity-gate.spec.ts` (13 senaryo, iki form)

**Files:**
- Create: `e2e/tests/request-identity-gate.spec.ts`
- Modify (gerekirse): `e2e/src/fixtures.ts` (`createClaimableCustomer(phone, email)`: `passwordHash: null`, `customerOrigin: 'AUTO_CREATED_REQUEST'`)

- [ ] **Step 1: Spec'i yaz** — iki form için ortak `driveForm(kind: 'marketplace' | 'showcase')` yardımcısı: formu açar, iletişim alanlarını doldurur, gate sonucunu döner. Senaryolar (her biri `test(...)` ve `for (const kind of ['marketplace','showcase'])`):

1. Yeni telefon + e-posta → `identity-checking` görünür ve kaybolur, gate `ok`, akış sonuna kadar (vitrin: outbox SMS kodu) → başarı; `prisma().requestDraft.count({ where: { consumedAt: null } })` değişmedi; tarayıcı cookie `taktic_request_draft` yok (`context.cookies()`).
2. `createCustomer()` ile aktif hesap; aynı telefon+e-posta → `identity-login-required`; açıklama/konum önceden doldurulmuşsa (vitrin'de doldur, marketplace'te adım 1'de daha doldurulmadı → sadece login) `Giriş yap` → login sayfası `redirectTo` ile → giriş → forma dönüş, `initialDraft` alanları eşit, hesap özeti, gönderim → talep `customerId === customer.id`.
3. Aynı kurulum; `Giriş yap` sonrası **başka** müşteri ile giriş → `identity-wrong-account` görünür, açıklama alanı boş, `Hesap değiştir` → logout+login doğru hesap → alanlar taslaktan geri geldi → gönderim başarılı.
4. Claimable hesap (`createClaimableCustomer`), form e-postası **farklı** → `identity-activation-required` → `Etkinleştirme bağlantısı gönder` → `identity-activation-sent`; `waitForLatestActivationUrl(accountEmail)` (form e-postasına `emailCountFor(formEmail,'customer-activation') === 0`); link `redirectTo` içerir; şifre belirle → forma yönlendi, oturum açık, taslak dolu → gönder.
5. Telefon A (müşteri A) + e-posta B (müşteri B) → `identity-conflict`; `Devam et`/`Kod gönder` disabled; `smsEntriesFor(phoneA)` uzunluğu 0; talep/lead/taslak sayıları sabit.
6. Provider telefonu → `identity-unavailable`.
7. `page.route('**/api/auth/request-identity-check', r => r.fulfill({ status: 500 }))` → `identity-error`, ilerleme disabled; `unroute` + `Tekrar dene` → `ok`.
8. Vitrin: taslak kaydet (login CTA), `prisma().showcasePlacement.update({ status: 'ARCHIVED' })` (ya da `endAt` geçmiş) → login → `expectNotFoundScreen`; ikinci alt senaryo: shelf satırını `active: false` yap → login → form açılır, gönder → `showcase-lead-area-not-served` + CTA.
9. Yarış: gate `ok` sonra `prisma().user.create` ile telefonu başka müşteriye, e-postayı başka müşteriye ver → gönder → `request-submit-error` / `showcase-lead-error` metni conflict cümlesi; kayıt yok.
10. Oturumlu müşteri + "farklı iletişim kişisi" (başka bir müşterinin telefonunu yaz) → `identity-*` testid'leri yok, talep `customerId` oturumdaki.
11. Misafirde `use-alternate-contact` testid'i `toHaveCount(0)`.
12. `page.route('**/request-drafts', …)` yerine API'yi kullanamayız (server action) → `RequestDraftsService.maxActive` E2E'de ayarlanamaz; bunun yerine aynı tarayıcıdan 6 kez taslak kaydetme denemesi (throttle 5/10dk) → 6.'da `identity-draft-error` + `Tekrar dene`, form içeriği duruyor.
13. Marketplace'te taslak kaydet (login CTA, login yapmadan geri dön) → vitrin formunda `Giriş yap` → `identity-draft-exists`; `Vazgeç` → `prisma().requestDraft.findFirst()` aynı `tokenHash`, marketplace'e dönünce taslak açılır; tekrar `Giriş yap` → `Evet, geç` → tek satır, `formType SHOWCASE_LEAD`, eski token ile marketplace boş.

- [ ] **Step 2: Chromium** — `cd e2e && pnpm exec playwright test request-identity-gate --project=chromium` → PASS.
- [ ] **Step 3: WebKit** — `E2E_WEBKIT=1 pnpm exec playwright test request-identity-gate showcase-placement-lead --project=webkit` → PASS.
- [ ] **Step 4: Commit**

```bash
git add e2e
git commit -m "test(e2e): kimlik gate'i ve taslakla devam — iki form, 13 senaryo, Chromium + WebKit

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 16: Tam doğrulama, teslim raporu, PR

- [ ] **Step 1:** `export DATABASE_URL=…; pnpm typecheck && pnpm lint && pnpm test && pnpm build` → hepsi yeşil.
- [ ] **Step 2:** `pnpm --filter @taktic/e2e e2e` (tam Chromium) ve `pnpm --filter @taktic/e2e e2e:webkit` → yeşil; sonuçları not al.
- [ ] **Step 3:** `docs/superpowers/plans/2026-09-13-request-identity-gate-teslim-raporu.md`: API sözleşmesi, taslak yaşam döngüsü, ekran metinleri, dosya etkileri, **migration: 1 (RequestDraft)**, yeni env'ler, test sonuçları, spec §7 kanıtlarının test adlarıyla eşlemesi.
- [ ] **Step 4:** Commit + push + PR (`gh pr create --base main`), CI bekle; merge etme.

---

## Self-review notları

- Spec §1.1–1.5, §2.1–2.6, §3, §5 maddelerinin her biri bir görevle eşleşiyor: 1.1→T2, 1.2→T3, 1.3→T5/T6/T7, 1.4→T4/T7, 1.5→T2/T5/T8, 2.1→T9, 2.2→T9, 2.3→T11/T12, 2.4→T9/T11, 2.5→T8/T11/T12, 2.6→T8/T11/T12/T13, §5 API→T2–T7, §5 web→T8/T9, §5 E2E→T14/T15.
- Tip tutarlılığı: `DraftKey`, `CurrentDraft`, `RequestDraftPayload`, `SaveDraftResult`, `IdentityStatus` adları görevler arasında aynı; `describeRefusal` T11'de `lib/api-refusal.ts`'e çıkarılıp vitrin action'ında da kullanılır.
- Bilinen riskler: (a) `ThrottlerModule.forRoot` iki kez — T5 notu alternatifi tanımlar; (b) `User.phone` yazımı — T2 notu iki yazımı sorgular; (c) React 19 `<form action>` reset'i — iki formda da `onSubmit + startTransition`.
