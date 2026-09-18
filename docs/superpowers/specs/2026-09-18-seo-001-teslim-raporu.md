# SEO-001 — Teknik SEO altyapısı — Teslim Raporu

Tarih: 2026-09-18 · PR [#91](https://github.com/umutciftciii/taktic/pull/91) ·
Branch `claude/seo-001-technical-setup-b89d1d` (taban `origin/main` @ `5800e07a`) ·
Merge / deploy / yerel-staging eşitlemesi / gerçek `.env` / Cloudflare / Search Console: **yapılmadı**.

Tasarım notu: `2026-09-18-seo-001-technical-seo-design.md` (envanter, ortam matrisi, allowlist, kanonik
standart, sitemap kaynağı kararları, SEO-002'ye bırakılanlar).

Migration yok; Prisma/schema, görünür kopya/tasarım, auth/guard'lar, Turnstile sözleşmesi değişmedi.

---

## 1. Pre-merge düzeltmesi (ikinci tur) — ne değişti

### 1.1 Kanonik URL standardı — tek kaynak

`apps/web/lib/seo-routes.ts` `absoluteUrl(origin, path)` / `canonicalUrl(origin, route, params)`:

- `origin + temiz path`; **trailing slash yok**; query/fragment yok; dinamik segment `encodeURIComponent`.
- **Kök = çıplak origin**: `https://host` (Next `trailingSlash:false` altında canonical'ı böyle basar;
  `https://host/` ikiliği kaldırıldı — sitemap ve JSON-LD de aynı dizeyi yazar).
- `canonical`, `og:url`, Twitter, JSON-LD `url`/`item`/`logo`, sitemap `<loc>` **yalnız** bu iki
  fonksiyondan geçer → byte düzeyinde aynı.
- Rooted olmayan path, `?`/`#` taşıyan path, origin'den fazlası olan origin → fırlatır (unit testte
  yakalanır; production'da `//` üretilemez). `/categories/` gibi istekler Next 308 ile temiz path'e iner.

Kanıt: unit `seo-routes.spec` (5 yeni test), `seo-metadata.spec` (kök canonical `https://host`),
`seo-json-ld.spec` (tüm url'ler çıplak origin tabanlı), `seo-sitemap.spec` ("her satır `canonicalUrl` ile
aynı dize"); E2E "one URL form everywhere": altı sayfada `canonical === og:url === JSON-LD url ===
sitemap <loc>` (tam bir satır), `/categories/` ve `/isletme/<id>/` 308 → temiz canonical.

### 1.2 Sitemap veri kaynağı — tek dar uç

`GET /providers/public-directory` **kaldırıldı** (genel "dizin API'si" gibi okunuyordu; `/providers`
altındaydı). Vitrin için feed yürüyüşü (kart başına 20+ alan, sayfa başına review-özeti sorgusu,
N istek) **kaldırıldı**. Yerine:

**`GET /sitemap/entries`** (`apps/api/src/modules/sitemap/`) →
`{ categories: [{slug, updatedAt}], providers: [{id, updatedAt}], showcaseCards: [{cardId}] }`

| Karar | Değer |
| --- | --- |
| Kaynak kuralları | kategori: `CategoriesService.listCategories({isSuperAdmin:false})` (public listeleme, ACTIVE leaf); işletme: `PUBLICLY_VISIBLE_PROVIDER_STATUSES` (= APPROVED, `provider-visibility.ts`); kart: **`livePlacementPredicate(now)`** (yeni `showcase-live-placement.ts`) — feed, tek-kart ve sitemap sorguları aynı SQL parçasını kullanır |
| Alanlar | yalnız `slug`/`id`/`cardId` + `updatedAt`; ad, il/ilçe, başlık, fiyat, iletişim, moderasyon notu, kredi/ödeme **yok** |
| Parametre / pagination | yok; query yok sayılır; 3 sorgu `Promise.all`, satır başına iş yok (N+1 yok); web→API **1** istek |
| Auth | guard yok, oturum okunmaz; ziyaretçi = müşteri = sağlayıcı = operatör gövdesi |
| Metot | yalnız GET; POST/PUT/PATCH/DELETE → 404; `/sitemap`, `/sitemap/providers`, `/providers/public-directory` → 404 |
| Cache | `Cache-Control: no-store` — "şu an public olanlar"; çekilen kart bir sonraki sitemap'te yok olmalı, cache bitince değil |
| Modül | `SitemapModule` imports `PrismaModule`, `CategoriesModule`; döngü yok, `ShowcaseModule` export'u değişmedi |

Web `buildSitemap`: tek fetch; her satır `canonicalUrl`; tekrar eden kayıt bir kez; alanı eksik satır
atlanır; **fail-closed**: fetch hatası ya da tanınmayan gövde → yalnız 3 statik satır (doğrulanamayan
dinamik URL listelenmez; sitemap 500 vermez).

Kanıt: API `sitemap-entries.spec.ts` (13 test: DRAFT/INACTIVE/GROUP/ROUTER, DRAFT/PENDING/REJECTED/
SUSPENDED, süresi bitmiş ve askıya alınmış işletmenin kartı **hiçbir alanda yok**; feed ve
`GET /showcase/cards/:id` ile birebir; alan kümesi; PII/içerik metinde yok; rol bağımsız gövde;
`no-store`; query yok sayılır; salt-okunur); web `seo-sitemap.spec.ts` (9 test); E2E sitemap testi:
sitemap'teki **her** URL 200, dinamik satır sayısı = kaynak kayıt sayısı, kaynak gövdesinde
DRAFT/PENDING/expired yok ve PII yok, POST 404.

### 1.3 Değişen dosyalar (ikinci tur)

| Dosya | Değişiklik |
| --- | --- |
| `apps/api/src/modules/sitemap/sitemap.{module,controller,service}.ts` | **yeni** — `GET /sitemap/entries` |
| `apps/api/src/modules/showcase/showcase-live-placement.ts` | **yeni** — paylaşılan canlı-kart predicate'i |
| `apps/api/src/modules/showcase/showcase-feed.service.ts` | iki sorgu predicate'i paylaşılan parçadan alır (davranış aynı; feed spec 19/19) |
| `apps/api/src/modules/providers/providers.controller.ts`, `providers.service.ts` | `public-directory` uç + metot **kaldırıldı** |
| `apps/api/src/modules/providers/provider-visibility.ts` | `PUBLIC_DIRECTORY_STATUSES` → `PUBLICLY_VISIBLE_PROVIDER_STATUSES` |
| `apps/api/src/app.module.ts` | `SitemapModule` |
| `apps/api/test/sitemap-entries.spec.ts` | **yeni** (13); `provider-public-directory.spec.ts` **silindi** |
| `apps/web/lib/seo-routes.ts` | `absoluteUrl`, `canonicalUrl` |
| `apps/web/lib/seo-metadata.ts` | canonical ve görsel URL'leri `canonicalUrl`/`absoluteUrl`'den |
| `apps/web/lib/seo-json-ld.ts` | tüm `url`/`item`/`logo` `absoluteUrl`/`canonicalUrl`'den |
| `apps/web/lib/seo-sitemap.ts` | tek uç, dedupe, fail-closed |
| `apps/web/test/seo-{routes,metadata,json-ld,sitemap}.spec.ts` | standart ve tek-kaynak testleri |
| `e2e/tests/seo-indexing.spec.ts` | byte eşitliği, trailing slash, kaynak uç denetimi |
| `docs/superpowers/specs/2026-09-18-seo-001-technical-seo-design.md`, bu rapor | güncellendi |

---

## 2. İlk turdan gelen ve değişmeyen özet

- Ortam kapısı `resolveSeoSite()`: yalnız `APP_ENVIRONMENT=production` + geçerli https origin
  (`WEB_APP_URL` → `WEB_ORIGIN` → `NEXT_PUBLIC_WEB_URL`); aksi her durumda `noindex, nofollow`,
  canonical/OG url/JSON-LD/sitemap üretilmez. Request `Host` okunmaz.
- Allowlist: `/`, `/categories`, `/categories/:slug`, `/isletme/:id`, `/vitrin`, `/vitrin/:cardId`;
  işlevsel query → `noindex, follow` + canonical yok; utm → temiz canonical; kök layout varsayılanı
  `noindex, nofollow`; `seo-routes.spec` her `page.tsx`'i sınıflandırmaya zorlar.
- JSON-LD yalnız indekslenebilir + temiz path'te; `aggregateRating/review/offers/price/areaServed/
  telephone/email` hiçbir şemada yok; `seoText` iletişim tespit ederse metni düşürür.
- Env: yeni değişken yok; compose web servisine `WEB_APP_URL`/`WEB_ORIGIN` boş-iken-boş; `.env.example`
  "Search engine indexing" bölümü. Operatör: prod `APP_ENVIRONMENT=production` + `WEB_APP_URL`; prod'da
  edge `X-Robots-Tag` olmamalı, staging'de kalmalı; sonra Search Console'a `/sitemap.xml`.

---

## 3. Kalite kapıları

Bölüm 4'teki tabloya bakınız (CI run bağlantısı ve sonuçlar PR'da).

## 4. Sonuçlar

| Kapı | Sonuç |
| --- | --- |
| `pnpm typecheck` | geçti |
| `pnpm lint` | geçti |
| web unit (`pnpm --filter @taktic/web test`) | 36 dosya / 330 test geçti |
| API (`sitemap-entries`, `showcase-feed`, `compose-environment`, `category-visibility`, `http-security`) | geçti |
| `pnpm build` | geçti; `/robots.txt`, `/sitemap.xml` dinamik (ƒ) |
| E2E chromium (tam suite) | bkz. PR CI |
| E2E webkit (tam suite) | bkz. PR CI |
| CI | 3/3 — PR #91 |
