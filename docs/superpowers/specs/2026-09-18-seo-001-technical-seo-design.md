# SEO-001 — Teknik SEO altyapısı — Tasarım Notu

Tarih: 2026-09-18 · Taban: `origin/main` @ `5800e07a` · Tek PR.

Migration yok. Prisma/schema, gerçek `.env`, Cloudflare, Search Console, deploy, yerel/staging
eşitlemesi değişmedi. İçerik/keyword/şehir-kategori stratejisi (SEO-002) kapsam dışı; yeni sayfa
çoğaltılmadı, URL şeması icat edilmedi.

---

## 1. Envanter

### 1.1 Public route'lar ve indekslenebilirlik kararı

Kaynak: `apps/web/app/**/page.tsx` (find), `apps/web/lib/panel-routes.ts:32` (`PANEL_ROUTES`) ve
`:94` (`PUBLIC_ROUTES`).

| Route | Dosya | Veri kaynağı / görünürlük kuralı | Karar |
| --- | --- | --- | --- |
| `/` | `app/page.tsx:29` | statik + `GET /categories?limit=10` | **indeks** |
| `/categories` | `app/categories/page.tsx:14` | `GET /categories` → yalnız `ACTIVE`+`LEAF` (`categories.service.ts:306-309`) | **indeks**; `?q=` arama varyantı **noindex** |
| `/categories/[slug]` | `app/categories/[slug]/page.tsx:31` | `GET /categories/:slug` → `isPubliclyReachable` (`category-taxonomy.ts:59`: ACTIVE leaf **veya** ACTIVE router); public'e kapalı olan 404 | **indeks** (yalnız API 200 dönen); `?entry=&r=` akış varyantı **noindex** |
| `/isletme/[id]` | `app/isletme/[id]/page.tsx:30-36,207-227` | `GET /providers/:id` public projeksiyon; sayfa ayrıca `status !== 'APPROVED'` → null → 404 (`:216`); API tarafı `provider-visibility.ts:20` | **indeks** (yalnız APPROVED); `?cursor=` sayfalama **noindex** |
| `/vitrin` | `app/vitrin/page.tsx:29` | `GET /showcase/feed` (yalnız yayındaki kartlar) | **indeks**; `?il=&ilce=` filtre varyantı **noindex** |
| `/vitrin/[cardId]` | `app/vitrin/[cardId]/page.tsx:60,257-263` | `GET /showcase/cards/:id` → `getPublicCard` (`showcase-feed.service.ts:176`): yalnız ACTIVE placement + APPROVED kart + APPROVED sağlayıcı (`:462-467`); aksi 404 | **indeks**; `?step=&sent=&city=&district=&neighborhood=&phone=` form/prefill varyantı **noindex** |
| `/sozlesmeler/iletisim-paylasimi` | `app/sozlesmeler/iletisim-paylasimi/page.tsx:23` | statik aydınlatma metni | **noindex, follow** — allowlist'te değil; hukuki metin, açılış yüzeyi değil (SEO-002'ye not) |
| `/providers/register` | `app/providers/register/page.tsx` | başvuru formu | **noindex** (kayıt yüzeyi) |
| `/providers/success`, `/requests/success` | `panel-routes.ts:95-97` | başarı ekranları | **noindex** |

### 1.2 Private / panel / auth / akış route'ları — hepsi indeks dışı

| Sınıf | Route'lar (dosya) | Neden indeks dışı |
| --- | --- | --- |
| Auth | `/login`, `/register/customer`, `/register/provider`, `/sifre-unuttum`, `/sifre-sifirla`, `/e-posta-dogrula`, `/activate-customer`, `/claim-provider`, `/provider-invite/[token]` (zaten `robots: noindex` — `provider-invite/[token]/page.tsx:27`) | Oturum/token yüzeyleri; token query'de veya path'te |
| Hesap | `/account/profile`, `/account/password` (`panel-routes.ts:33-34`) | oturumlu panel |
| Müşteri paneli | `/requests/my`, `/requests/offers`, `/requests/matches`, `/requests/[id]/offers`, `/requests/[id]/offers/[offerId]`, `/requests/[id]/vitrin-karar`, `/requests/[id]/degerlendir` (`panel-routes.ts:69-83`) | kişiye özel talep/teklif verisi |
| Sağlayıcı paneli | `/providers/me`, `/providers/[id]`, `/providers/[id]/**` (edit, credits, subscriptions, offers, degerlendirmeler, requests, package-purchases, vitrin/**) (`panel-routes.ts:41-68`) | oturumlu panel; `/providers/[id]` **panel** ekranıdır, public profil `/isletme/[id]`'dir |
| Destek / mesaj | `/destek/**`, `/mesajlar/**` (`panel-routes.ts:35-40`) | oturumlu |
| Hata | `app/not-found.tsx`, `app/error.tsx` | kök layout varsayılanını (noindex) alır |
| API route'ları | `app/api/**/route.ts` (auth/request-identity-check, locations/neighborhoods, messages/[threadId], session, showcase/feed) | JSON; metadata eklenmez, robots.txt `Disallow: /api/` |

### 1.3 Mevcut metadata / robots / sitemap / canonical / OG / ortam

| Konu | Durum | Kanıt |
| --- | --- | --- |
| Kök metadata | Statik `title` + `description`; `metadataBase`, `robots`, `openGraph`, `alternates` **yok** | `app/layout.tsx:22-26` |
| Sayfa metadata | Yalnız 3 sayfada: provider-invite (noindex), sözleşme (title), isletme (`generateMetadata`, `robots: { index: true, follow: true }` **ortamdan bağımsız**) | `provider-invite/[token]/page.tsx:24-27`, `sozlesmeler/.../page.tsx:23`, `isletme/[id]/page.tsx:30-36` |
| `robots.txt` / `sitemap.xml` | **yok** (`app/robots.ts`, `app/sitemap.ts`, `public/robots.txt` bulunmuyor) | find çıktısı |
| Canonical / OG / Twitter / JSON-LD | **yok** | grep `canonical\|openGraph\|ld+json` boş |
| Response header'ları | 5 güvenlik header'ı statik; `X-Robots-Tag` yok; `next.config.ts` build-time olduğu için request-time ortam okuyamaz | `apps/web/next.config.ts:34-40,53-55` |
| Ortam sinyali | `APP_ENVIRONMENT` = `local \| staging \| production`; **undeclared = her okuyucuda production/kapalı** (Turnstile için "kapalı" = strict) | `.env.example:398-412`, `apps/api/src/common/app-environment.ts:36`, `apps/web/lib/turnstile.ts:50` |
| Public origin sözleşmesi | API'de `WEB_APP_URL` → `WEB_ORIGIN` → `NEXT_PUBLIC_WEB_URL` sırası; https + origin-only + loopback değil kuralı; asla throw etmez | `apps/api/src/common/public-urls.ts:52,90,189-227`; `.env.example:95-119` |
| Web container'a origin iletimi | **Yok**: compose web servisi `APP_ENVIRONMENT`, `TURNSTILE_*` alır, `WEB_APP_URL`/`WEB_ORIGIN` almaz | `docker-compose.yml:162-176` |
| Host header'ı | Hiçbir okuyucu request'ten ortam/origin türetmez (kural) | `app-environment.ts:12-16` |

### 1.4 SEO için güvenle kullanılabilir veri alanları

| Model | Alan | Kaynak | Kullanım |
| --- | --- | --- | --- |
| `ServiceCategory` | `name`, `slug`, `description?`, `imageUrl?`, `coverImageUrl?`, `updatedAt` | `prisma/schema.prisma:659-704`; public projeksiyon operatör sütunlarını düşer (`categories.service.ts:126-135`) | title/description/OG image; sitemap `lastModified` |
| `ProviderProfile` (public) | `businessName`, `city`, `district`, `description?`, `serviceCategories[].category.name` | `apps/web/lib/api.ts:310-350`; public projeksiyonda `contactName/phone/email` **yok** | title/description; `LocalBusiness` name + address(locality/region/TR) |
| `ProviderProfile` | `updatedAt` | `schema.prisma:1170-1190` (public projeksiyonda değil; yeni dizin endpoint'i döner) | sitemap `lastModified` |
| `ShowcaseFeedCard` (public) | `title`, `summary`, `imageUrl?`, `category{name,slug}`, `provider{businessName,city,district}` | `apps/web/lib/api.ts:1639-1673`; placement/fiyat/ödeme/iletişim yok | title/description/OG image; `Service` + provider `LocalBusiness` |
| **Kullanılmayacak** | `reviewSummary`, `listedServicePriceAmount`, `serviceAreas`, `responseSla*`, `phone/email`, `approvedAt` | puan/fiyat/bölge/SLA iddiası kural olarak güvence altında değil (kullanıcı kuralı) | — |
| Marka | Logo alt/aria "TakTick" (56 kullanım) vs "TakTic" (20; kök title, footer ©, shared `TAKTIC_APP_NAME`) | grep sayımı | SEO modülünde `SEO_SITE_NAME = 'TakTick'`; yazım tutarsızlığı SEO-002'ye |
| İletişim/adres | `destek@taktick.com.tr` yalnız API'de env ile ezilebilir varsayılan (`support-inbox.config.ts:31,45`); web'de posta adresi/telefon yok | `Organization` şemasına **eklenmez** (uydurma yok) |

### 1.5 Staging Cloudflare `noindex` header'ı ile ilişki

Repoda bu header'a dair hiçbir referans yok (grep `X-Robots\|noindex` → yalnız provider-invite
metadata). Edge kuralı repo dışında, uygulama kodundan bağımsız yaşıyor. Bu PR sonrası:

- Staging'de iki katman aynı yönde: edge `X-Robots-Tag: noindex` + uygulama `<meta robots noindex,
  nofollow>` + `robots.txt Disallow: /` + boş sitemap. Header, HTML olmayan varlıkları (görsel, JSON)
  da kapsadığı için kalmalı; uygulama katmanı header'ın kaldırılması/unutulması durumunda da staging'i
  kapalı tutar.
- Production'da edge header **olmamalı**; varsa uygulamanın `index` sinyalini ezer (`X-Robots-Tag`
  meta'dan güçlüdür). Operatör kontrol listesine yazıldı (§8). Bu PR Cloudflare'de değişiklik yapmaz.

---

## 2. Ortam sınırı ve origin sözleşmesi

**Yeni modül:** `apps/web/lib/seo-site.ts` — `resolveSeoSite(env = process.env)`.

```
indexable = APP_ENVIRONMENT.trim() === 'production'
         && origin(WEB_APP_URL → WEB_ORIGIN → NEXT_PUBLIC_WEB_URL) geçerli
origin geçerli = parse edilir, pathname '/' + search/hash yok, https, loopback değil
```

Dönüş: `{ indexable: true, origin }` ya da `{ indexable: false, origin: null, reason }`;
`reason ∈ ENVIRONMENT_UNDECLARED | ENVIRONMENT_NOT_PRODUCTION | ENVIRONMENT_INVALID |
ORIGIN_MISSING | ORIGIN_MALFORMED | ORIGIN_NOT_AN_ORIGIN | ORIGIN_INSECURE | ORIGIN_LOOPBACK`.

- Her çağrıda okunur (cache yok) — `turnstile.ts` ve API `public-urls.ts` ile aynı örüntü.
- Request `Host`/`Origin`/`X-Forwarded-*` **okunmaz**.
- Geçersiz `APP_ENVIRONMENT` değeri (örn. `prod`) fırlatmaz, kapalı sayılır: SEO bir gate'tir, boot
  koşulu değildir; API'nin `parseAppEnvironment` fırlatması boot'ta yakalanır, burada sayfa
  render'ında yakalanamaz.
- Origin geçersizken **hiçbir absolute URL üretilmez**: `metadataBase` yok, canonical yok, OG url
  yok, sitemap yok. Localhost canonical ya da sahte origin asla basılmaz.

**Ortam matrisi**

| Ortam | `APP_ENVIRONMENT` | Origin | robots meta | `/robots.txt` | `/sitemap.xml` | canonical/OG url/JSON-LD |
| --- | --- | --- | --- | --- | --- | --- |
| local (`pnpm stack:up`) | `local` | — | `noindex, nofollow` | `Disallow: /` | boş `<urlset/>` | yok |
| staging | `staging` | (varsa) | `noindex, nofollow` | `Disallow: /` | boş | yok |
| production, origin ayarlı | `production` | `https://…` | allowlist'te `index, follow`; diğerleri `noindex` | Allow + Disallow listesi + `Sitemap:` | dolu | var |
| production, origin yok/bozuk/http/loopback | `production` | ✗ | `noindex, nofollow` (fail-closed) | `Disallow: /` | boş | yok |
| undeclared / geçersiz değer | boş / `prod` | ne olursa | `noindex, nofollow` | `Disallow: /` | boş | yok |

Not: Turnstile için "undeclared = production (strict)" ile SEO için "undeclared = indeks dışı" aynı
ilkenin iki yüzüdür: bilinmeyen ortam, her gate'te **kapalı** yönde okunur.

**Env sözleşmesi (non-secret)**

- Yeni değişken **yok**; web artık API'nin `WEB_APP_URL` sözleşmesini okur (`.env.example:95-119`).
- `docker-compose.yml` web servisi: `WEB_APP_URL: ${WEB_APP_URL:-}` ve `WEB_ORIGIN: ${WEB_ORIGIN:-}`
  eklenir (boş-iken-boş; loopback default web'e iletilmez). `compose-environment.spec.ts`'e assertion.
- `.env.example`'a "SEO" bölümü: web'in `WEB_APP_URL`'i canonical/sitemap için okuduğu,
  `APP_ENVIRONMENT=production` + geçerli https origin olmadan sitenin indeks dışı kaldığı.
- E2E'de sahte `https://taktick.example` origin'i yalnız HTML'e basılır; DNS'e gidilmez.

---

## 3. İndeks allowlist ve route sınıflandırması

**Yeni modül:** `apps/web/lib/seo-routes.ts`

```ts
INDEXABLE_ROUTES = ['/', '/categories', '/categories/:slug', '/isletme/:id', '/vitrin', '/vitrin/:cardId']
ROBOTS_DISALLOW  = ['/account/', '/activate-customer', '/api/', '/claim-provider', '/destek',
                    '/e-posta-dogrula', '/login', '/mesajlar', '/provider-invite/', '/providers/',
                    '/register/', '/requests/', '/sifre-sifirla', '/sifre-unuttum']
NOINDEX_CRAWLABLE = ['/sozlesmeler/iletisim-paylasimi']   // meta noindex,follow; robots.txt engellemez
```

- `/providers/` Disallow, `/providers/register|success`'i de kapsar — ikisi de zaten noindex; panel
  URL'lerinin taranmasını da keser.
- Unit test (`panel-routes.spec.ts` örüntüsü): her `page.tsx` yürünür; route ya `INDEXABLE_ROUTES`'ta,
  ya bir `ROBOTS_DISALLOW` öneki altında, ya `NOINDEX_CRAWLABLE`'da olmalı. Sınıflandırılmamış route =
  kırmızı test. Ayrıca allowlist'teki her route için `page.tsx` var olmalı.

**Query varyantı kuralı** (sayfa başına "işlevsel parametre" listesi):

| Route | İşlevsel parametreler | Davranış |
| --- | --- | --- |
| `/categories` | `q` | `noindex, follow`; canonical **basılmaz** |
| `/categories/:slug` | `entry`, `r` | aynı |
| `/isletme/:id` | `cursor` | aynı |
| `/vitrin` | `il`, `ilce` | aynı |
| `/vitrin/:cardId` | `step`, `sent`, `city`, `district`, `neighborhood`, `phone` | aynı |
| hepsi | diğer her parametre (utm_*, fbclid, …) | `index` + canonical = temiz path (query'siz) |

Gerekçe: filtre/arama/sayfalama/akış-durumu varyantı ayrı bir sayfa değildir; `noindex` + başka
sayfaya canonical karışık sinyaldir (Google bunu önermez), o yüzden varyantta canonical yok. Takip
parametreli kopya ise aynı sayfadır; canonical temiz URL'e toplar. Kampanya parametresiyle ayrı URL
üretilmez.

---

## 4. Metadata

**Yeni modül:** `apps/web/lib/seo-metadata.ts`

- `SEO_SITE_NAME = 'TakTick'`; `SEO_DEFAULT_TITLE` = mevcut kök title metni (aynen);
  `SEO_DEFAULT_DESCRIPTION` = mevcut kök description (aynen).
- `publicPageMetadata({ path, title, description, image?, filtered })` → `Metadata`:
  - `title: '<title> · TakTick'` (sözleşme sayfasının mevcut ayracı); ana sayfada kök title aynen.
  - `robots`: `indexable && !filtered` → `{ index: true, follow: true }`; `indexable && filtered` →
    `{ index: false, follow: true }`; `!indexable` → `{ index: false, follow: false }`.
  - `alternates.canonical`: yalnız `indexable && !filtered` → `origin + path` (query'siz, path
    segmentleri `encodeURIComponent`).
  - `openGraph` ve `twitter`: aynı title/description; `url` = canonical (yalnız varsa); `siteName`,
    `locale: 'tr_TR'`, `type: 'website'`; `images` yalnız origin varsa ve görsel `https://` absolute
    ya da `/` ile başlayan site-relative ise (origin ile birleştirilir). `twitter.card`:
    `summary_large_image` görsel varsa, yoksa `summary`.
- `privatePageMetadata(title?)` → `{ title?, robots: { index: false, follow: false } }` (sözleşme,
  provider-invite ve isletme-bulunamadı için).
- **Kök layout** `generateMetadata()`: `metadataBase` yalnız origin geçerliyken; `robots`
  varsayılanı **her zaman** `{ index: false, follow: false }` — opt-in etmeyen her sayfa
  (paneller, auth, hata, 404) kapalı. `title.default`/`description` mevcut metinler.
- **Metin normalizasyonu** `seoText(value, max)`: tag sök, kontrol karakterleri ve fazla boşluk
  düşür, `max`'ta kelime sınırında kes (`…`); `@taktic/shared` `detectContactDetails` telefon/e-posta/
  URL bulursa metin **tamamen** düşer ve fallback kullanılır (kısmi redaksiyon yerine). Puan/fiyat
  metadata'ya hiç girmez.
- **Sayfa başına** (`generateMetadata`, loader'lar React `cache()` ile sarılır — sayfa ile
  metadata aynı request'te tek fetch):

| Route | title | description | image | filtered |
| --- | --- | --- | --- | --- |
| `/` | kök title (aynen) | kök description (aynen) | `/brand/logo.png` | hayır |
| `/categories` | `Hizmet kategorileri` | sayfadaki alt başlık cümlesi | logo | `q` |
| `/categories/:slug` | `category.name` | `seoText(description)` yoksa `"<name> için talep oluşturun; bölgenizdeki onaylı hizmet verenlerden teklif alın."` | `coverImageUrl ?? imageUrl ?? logo` | `entry`/`r` |
| `/isletme/:id` | `businessName` | `seoText(description)` yoksa `"<businessName> — <city>[, <district>]. Hizmetler: <kategori adları>."` | logo | `cursor` |
| `/vitrin` | `Vitrin hizmetleri` | sayfadaki alt başlık cümlesi | logo | `il`/`ilce` |
| `/vitrin/:cardId` | `seoText(card.title)` yoksa `businessName` | `seoText(summary)` yoksa `"<businessName> tarafından sunulan <category.name> hizmeti."` (bölge/fiyat iddiası yok) | `card.imageUrl ?? logo` | step/sent/city/district/neighborhood/phone |
| 404 dalları | `İşletme bulunamadı` vb. | — | — | `privatePageMetadata` |

Mevcut görünür kopya değişmez; yalnız `<head>` içeriği eklenir/düzenlenir. `isletme` sayfasının
`—` ayracı `·`'ya döner (tek sözleşme); başka kopya değişikliği yok.

---

## 5. robots.txt ve sitemap.xml

`apps/web/app/robots.ts` ve `apps/web/app/sitemap.ts` (Next Metadata Routes), ikisi de
`export const dynamic = 'force-dynamic'` (ortam request-time okunur; build'de prerender edilmez).

**robots.ts**
- indexable: `{ rules: [{ userAgent: '*', allow: '/', disallow: ROBOTS_DISALLOW }], sitemap: origin + '/sitemap.xml' }`
- değilse: `{ rules: [{ userAgent: '*', disallow: '/' }] }` — sitemap satırı yok.

**sitemap.ts**
- indexable değilse `[]` (boş urlset; robots zaten Disallow, referans verilmez).
- indexable ise, çerezsiz `fetch` (`app/api-base.ts` `apiUrl`, `cache: 'no-store'`; ziyaretçi çerezi
  sitemap'e taşınmaz) ile:
  1. Statik: `/`, `/categories`, `/vitrin` — `lastModified` **yok** (gerçek tarih yok).
  2. `GET /categories` → `/categories/<slug>`, `lastModified = updatedAt` (public projeksiyonda
     zaten dönüyor; web `Category` tipine `updatedAt?: string` eklenir).
  3. **Yeni API endpoint** `GET /providers/public-directory` → `{ providers: [{ id, updatedAt }] }`;
     yalnız `isPubliclyVisibleProvider` (APPROVED), `orderBy id`, iki alan. `providers.controller.ts`'de
     `@Get(':id')` öncesine. → `/isletme/<id>`, `lastModified = updatedAt`.
  4. `GET /showcase/feed?limit=48` cursor ile sonuna kadar → `/vitrin/<cardId>`; `lastModified`
     **yok** (feed kartı tarih taşımıyor; uydurulmaz). Aynı predicate `getPublicCard`'ın 404
     kuralıyla birebir (`showcase-feed.service.ts:462-467` vs `:549-554`).
- Her satır: `origin + '/segment/' + encodeURIComponent(id|slug)`; `/categories/<slug>`
  `isPubliclyListable ⊂ isPubliclyReachable` olduğundan 200; APPROVED sağlayıcı → sayfa 200; feed
  kartı → `getPublicCard` 200.
- Herhangi bir kaynak fetch hatası: o kaynak atlanır, statik satırlar kalır (sitemap 500 vermez).
- Sayfalama, filtre, panel URL'leri yok. 50k satır/50 MB sınırı bugünkü hacimde uzak; sitemap index
  SEO-002'ye not.

**Veri erişimi:** kategori 1 sorgu; sağlayıcı 1 sorgu; feed sayfa başına 1 sorgu + review özeti
batch'i (mevcut `withReviewSummaries`), N+1 yok.

---

## 6. Yapısal veri (JSON-LD)

- `apps/web/lib/seo-json-ld.ts`: `serializeJsonLd(data)` → `JSON.stringify` + `<`→`<`,
  `>`→`>`, `&`→`&`, U+2028/2029 kaçışı (script-breakout'a karşı); şema kurucuları:
  `organizationSchema(origin)`, `webSiteSchema(origin)`, `breadcrumbSchema(items)`,
  `categoryServiceSchema(...)`, `providerLocalBusinessSchema(...)`, `showcaseServiceSchema(...)`.
- `apps/web/app/json-ld.tsx`: `<JsonLd data>` server component → `<script type="application/ld+json"
  dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }} />`.
- **Yalnız** `resolveSeoSite().indexable && !filtered` iken render edilir; aksi halde `null`.

| Sayfa | Şema | Alanlar (yalnız doğrulanmış) |
| --- | --- | --- |
| `/` | `Organization` | `name: TakTick`, `url: origin`, `logo: origin/brand/logo.png` — telefon/adres/e-posta **yok** |
| `/` | `WebSite` | `name`, `url` — `SearchAction` yok (arama sayfası noindex) |
| `/categories/:slug` | `Service` | `name`, `url` (canonical), `description` (normalize, varsa), `provider: { @type: Organization, name, url }` |
| `/categories/:slug` | `BreadcrumbList` | Ana sayfa → Kategoriler → `<name>` |
| `/isletme/:id` | `LocalBusiness` | `name`, `url`, `description` (varsa), `address: { PostalAddress, addressLocality: district, addressRegion: city, addressCountry: 'TR' }` — `telephone`, `aggregateRating`, `areaServed`, `priceRange` **yok** |
| `/vitrin/:cardId` | `Service` | `name` (card.title), `url`, `description` (summary), `provider: { LocalBusiness, name, address(city/district/TR) }` — `offers`, fiyat, `availability`, `areaServed` **yok** |

`AggregateRating`, `Review`, `Offer` hiçbir sayfada yok. Kullanıcı yazılı alanlar
(`description`, `title`, `summary`) `seoText`'ten geçer; iletişim tespit edilirse alan düşer.

---

## 7. Test ve kanıt

**Unit (`apps/web/test`)**
- `seo-site.spec.ts`: ortam × origin matrisi (§2 tablosu), request header'ı okunmaz, geçersiz değer
  fırlatmaz.
- `seo-routes.spec.ts`: app dizini yürüyüşü (sınıflandırılmamış route yok; allowlist route'ları var),
  `isFilteredQuery` (utm → değil; `q`/`cursor`/… → evet), `canonicalPath` kaçışı.
- `seo-metadata.spec.ts`: prod/staging/undeclared robots; canonical yalnız prod+temiz; OG/Twitter
  aynı URL; fallback'ler; `seoText` tag/PII/uzunluk; puan/fiyat asla girmez.
- `seo-json-ld.spec.ts`: `</script>` kaçışı; şemalarda `aggregateRating`/`telephone`/`offers`/
  `areaServed` anahtarı yok; iletişimli description düşer.
- `seo-sitemap.spec.ts`: builder'a sahte fetch — kapalı ortamda `[]`; APPROVED-olmayan/pasif kayıt
  yok (fetch seviyesinde public projeksiyon zaten filtreler; builder yalnız verileni yazar, 200 dönen
  URL'ler E2E'de doğrulanır); slug/id kaçışı; kaynak hatası → statik satırlar.
- `compose-environment.spec.ts` (api): web servisi `WEB_APP_URL`/`WEB_ORIGIN` boş-iken-boş alır.

**API integration** (`apps/api/test/provider-public-directory.spec.ts`): yalnız APPROVED; projeksiyon
yalnız `id`+`updatedAt`; auth gerektirmez.

**E2E** (`e2e/tests/seo-indexing.spec.ts`, chromium):
- Yeni web süreci `seoProductionWebServer()` (`turnstileClosedWebServer` örüntüsü, port 3260):
  primary API önünde `APP_ENVIRONMENT=production`, `WEB_APP_URL=https://taktick.example`.
  Turnstile bu stack'te `unconfigured`/kapalı (form yok, Cloudflare script yok) — SEO testleri form
  göndermez.
- Production-benzeri: `/`, `/categories`, `/categories/<slug>`, `/isletme/<id>`, `/vitrin`,
  `/vitrin/<cardId>` → `meta robots index,follow`, `link canonical = https://taktick.example<path>`,
  `og:url` aynı, JSON-LD parse edilir ve `aggregateRating`/`telephone` içermez; `?utm_source=`
  canonical temiz; `?q=`, `?cursor=`, `?il=`, `?step=form` → noindex ve canonical yok; `/login`,
  `/providers/register`, `/requests/success`, `/requests/my` → noindex; `/robots.txt` Allow +
  Disallow + `Sitemap:`; `/sitemap.xml` fixture URL'lerini içerir, PENDING_REVIEW sağlayıcı / DRAFT
  kategori / süresi bitmiş kart içermez; sitemap'teki **her** URL origin'i test host'una çevrilerek
  GET → 200.
- Staging-benzeri (`turnstileClosedWebRuntime`): `/` ve `/categories/<slug>` noindex,nofollow;
  canonical yok; `robots.txt` `Disallow: /`; sitemap boş.
- Local (primary): `/` noindex.
- Görünüm regresyonu **gerekmez**: yalnız `<head>` ve `<script type=ld+json>` değişiyor; görsel yüzey
  aynı.

**Komutlar:** `pnpm typecheck`, `pnpm lint`, `pnpm --filter @taktic/web test`,
`pnpm --filter @taktic/api test` (ilgili), `pnpm build`, `pnpm e2e seo-indexing`,
`pnpm e2e:webkit`; CI 3/3.

---

## 8. Operatör adımları (bu PR yapmaz)

- Production host: `APP_ENVIRONMENT=production` ve `WEB_APP_URL=https://<gerçek alan>` (API zaten
  e-posta linkleri için okuyor; web'e compose ile iletilecek). İkisi olmadan site indeks dışı kalır —
  bu istenen davranıştır.
- Staging host: `APP_ENVIRONMENT=staging`; Cloudflare `X-Robots-Tag: noindex` kuralı **kalsın**.
- Production'da edge `X-Robots-Tag` **olmadığını** doğrula; Search Console'a `/sitemap.xml` gönder.
- Gerçek değerler bu belgede ve PR'da yazılmaz.

## 9. SEO-002'ye bilinçli bırakılanlar

- Şehir/kategori kombinasyon sayfaları, keyword/başlık stratejisi, içerik metinleri.
- `TakTic`/`TakTick` marka yazımı tutarlılığı (kök title, footer ©, `TAKTIC_APP_NAME`).
- Sözleşme/aydınlatma sayfasının indekslenmesi kararı.
- Sitemap index/parçalama (50k satır), `lastModified` için vitrin placement tarihi (public
  projeksiyona ekleme kararı), OG görselleri (özel tasarım), `hreflang`.
- `X-Robots-Tag` header'ının uygulama katmanında (middleware) üretilmesi — edge bugün karşılıyor.

## 10. Değişmeyenler

DB/migration, gerçek `.env`, Cloudflare, Search Console, deploy, yerel/staging eşitlemesi, görünür
kopya/tasarım, API auth/guard'ları (yeni endpoint public ve salt-okunur), Turnstile sözleşmesi.
