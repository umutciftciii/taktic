# SEO-003 (B2) — İndeks uygunluğu: teknik allowlist × içerik kalitesi — Tasarım Notu

Tarih: 2026-09-18 · Taban: `origin/main` @ `060207ef` (SEO-002 merge) · Tek PR.

Migration yok; yeni içerik alanı/CMS yok; admin ayarı, feature flag, SQL/JS ifade kuralı yok. Gerçek `.env`,
Cloudflare, Search Console, deploy, yerel/staging eşitlemesi değişmedi. Gerçek veri yazılmadı (yalnız test
fixture'ları).

Amaç: SEO-001'in **teknik** kapısı (ortam + origin + allowlist + temiz path) ile SEO-002'nin **içerik
kalitesi** kararlarını tek, server-authoritative, fail-closed bir modelde birleştirmek. Geçerli production
origin'inde bugün yalnız `/` ve `/categories` indekslenebilir kalır; kategori, işletme, vitrin rafı ve vitrin
kartı ancak nesnel kalite koşullarını sağladığında `index` olur. Aynı karar robots metadata, canonical,
`og:url`, JSON-LD ve sitemap'in tek kaynağıdır.

---

## 1. Mevcut mimari (SEO-001) ve neden yetmiyor

| Katman | Bugün | Boşluk |
| --- | --- | --- |
| Ortam kapısı | `apps/web/lib/seo-site.ts` `resolveSeoSite()`: `APP_ENVIRONMENT=production` + geçerli https origin; aksi noindex, canonical/OG/JSON-LD/sitemap yok | Değişmiyor — aynen korunur |
| Route allowlist | `apps/web/lib/seo-routes.ts` `INDEXABLE_ROUTES` (6 route), işlevsel query → `noindex, follow` | Değişmiyor |
| Sayfa metadata | `publicPageMetadata()` — `site.indexable && !variant` → `index` + canonical + `og:url` | **Kalite boyutu yok**: public olan her kayıt `index` |
| JSON-LD | `structuredDataOrigin(route, searchParams)` — aynı iki koşul | Aynı boşluk |
| Sitemap | `GET /sitemap/entries` (`apps/api/src/modules/sitemap/`): ACTIVE leaf kategoriler, APPROVED işletmeler, canlı kartlar | Public görünürlük = sitemap üyeliği; kalite yok |
| Public projection'lar | `GET /categories/:slug` (`withoutOperatorColumns`), `GET /providers/:id` (`toPublicProvider` allow-list), `GET /showcase/cards/:id` (`getPublicCard`), `GET /showcase/feed` | Sayfanın "uygun mu" sorusuna cevap verecek alan yok |

SEO-002 §4.1 kararı: kategori/profil/raf/kart **koşulla** indekslenir; koşul sağlanmayan public sayfa
`noindex, follow` olmalı, sitemap'te olmamalı. Bugünkü veri (yerel/staging kopyası) hiçbir koşulu
karşılamadığı için sonuç: yalnız `/` ve `/categories`.

## 2. Model: `SeoIndexEligibility` — tek predicate, API'de

**Tek kaynak:** `apps/api/src/modules/seo/seo-index-eligibility.ts` (saf, Prisma'sız) + veri yükleyen
`SeoIndexEligibilityService` (`seo-index-eligibility.service.ts`, `SeoModule`). Web **hiçbir eşik bilmez**;
public projection'lardaki dar `seoIndexable: boolean` alanını okur ve `=== true` değilse kapalı davranır.

```
uygunluk(yüzey) = publicGörünürlük(yüzey) ∧ kaliteKanıtı(yüzey)
sayfa index     = resolveSeoSite().indexable ∧ !işlevselQuery ∧ uygunluk(yüzey)
sitemap satırı  = uygunluk(yüzey)            (ortam kapısı web sitemap.ts'te zaten var)
JSON-LD         = sayfa index ile aynı üç koşul
canonical/og:url= sayfa index ile aynı üç koşul
```

Uygunluk ≠ public görünürlük: kayıt 200 döner, sayfa render edilir, ama `noindex, follow` olabilir.

### 2.1 Saf kurallar ve başlangıç eşikleri

Sayılar **başlangıç eşiğidir** (SEO-002 §4.1/§5.3 "başlangıç önerisi"); koddaki `SEO_INDEX_THRESHOLDS`
sabitinde tek yerde durur, admin/flag ile değişmez.

| Yüzey | Kural (tümü sağlanmalı) | Veri alanı | Bugün neden geçemiyor (yerel/staging kopyası) |
| --- | --- | --- | --- |
| Ana sayfa `/`, dizin `/categories` | Ortam kapısı açık | — (route'un kendi kuralı; web `indexEligible: true` geçirir) | Geçer (kapı açıksa) |
| Kategori `/categories/:slug` | `status=ACTIVE` ∧ `kind=LEAF` ∧ `meaningful(description) ≥ 400` ∧ üç editoryal blok (`decisionGuide`, `priceFactors`, `faq`) her biri `meaningful ≥ 80` | `ServiceCategory.status/kind/description`; bloklar **modelde yok** → `editorialBlocks` girdisi `undefined` → `false` | Açıklama 23–43 karakter; bloklar yok. **Model gelene kadar hiçbir kategori geçemez** (B4) |
| İşletme `/isletme/:id` | `status=APPROVED` ∧ `meaningful(description) ≥ 300` ∧ ≥1 ACTIVE+LEAF kategori bağı ∧ `city`,`district` dolu ∧ ≥1 hizmet bölgesi ve **her** bölge satırı kapsamına göre tam (CITY: il; DISTRICT: il+ilçe; NEIGHBORHOOD: üçü) | `ProviderProfile.status/description/city/district`, `ProviderServiceCategory→category.status/kind`, `ProviderServiceArea.scope/city/district/neighborhood` | `description` 0/3 dolu. Görsel şartı modelde alan olmadığı için **uydurulmadı** (B9) |
| Vitrin rafı `/vitrin` | uygun canlı kart sayısı ≥ 5 | canlı kart kümesi (aşağıdaki kart kuralı) | 2 canlı kart, ikisi de uygun değil |
| Vitrin kartı `/vitrin/:cardId` | canlı placement (`livePlacementPredicate`) ∧ sağlayıcı uygun ∧ `meaningful(summary) ≥ 200` ∧ `scopeIncluded` ≥ 3 ayrı anlamlı madde ∧ `scopeExcluded` ≥ 1 ∧ özet aynı sağlayıcının başka canlı kartıyla normalize-eşit değil | `ShowcaseCardVersion.summary/scopeIncluded/scopeExcluded` (pinned version), sağlayıcı alanları | Özet 91–116; sağlayıcı uygun değil |

**Anlamlı karakter sayımı** (`meaningfulLength`): `<script>`/`<style>` içerikleri atılır, HTML etiketleri
sökülür, HTML entity'leri çözülür (`&amp;` vb. — tek karakter sayılır), kontrol/görünmez karakterler
(U+0000–001F, U+007F–009F, U+200B–200F, U+2028/2029, U+2060, U+FEFF, U+00AD) atılır; kalanlardan yalnız
`\p{L}` ve `\p{N}` sayılır — noktalama ve boşluk anlamlı değildir. Türkçe harfler `\p{L}` ile korunur
(`ğüşıöçİ` sayılır). Tekrar eden tek karakter (`"aaaa…"`) ya da tek kelime tekrarı ayrıca düşürülmez —
eşik kandırmanın bu türü B4 editoryal kurallarına (insan onayı) bırakılır; bu belgede "kandırma" =
boşluk/HTML/script/noktalama/görünmez karakterle uzunluk şişirmedir.

**Fail-closed girdiler:** tanınmayan `status/kind/scope`, `null/undefined`, dize olmayan metin, dizi olmayan
kapsam listesi, boş dizi → `false`. Kural fonksiyonları `unknown`-toleranslıdır (tip dışı veri fırlatmaz, `false` döner).

### 2.2 Veri erişimi (N+1 yok)

| Tüketici | Yol |
| --- | --- |
| `GET /categories/:slug` (public dal) | satırdan saf `isCategoryIndexable` → `seoIndexable` (bugün her zaman `false`) |
| `GET /providers/:id` (public dal) | `providerInclude` zaten bağları (category `status/kind`) ve bölgeleri getiriyor → saf `isProviderIndexable` → `seoIndexable`; ek sorgu yok |
| `GET /showcase/cards/:id` | `SeoIndexEligibilityService.liveShowcaseCardEligibility(now, { cardId })`: **bir** SQL — canlı kart predicate'i + sağlayıcının canlı kartları (kopya özet için) + sağlayıcı alanları (`description`, `status`, `city/district`, bölge satırları `json_agg`, ACTIVE-LEAF bağ sayısı alt sorgusu) → `seoIndexable` |
| `GET /showcase/feed` | aynı servis, filtresiz → uygun canlı kart sayısı → gövdeye üst düzey `seoIndexable` (raf kuralı); filtre/sayfalamadan bağımsız — kart başına iş yok |
| `GET /sitemap/entries` | kategoriler: `listCategories` × saf kural (bugün boş); işletmeler: tek `findMany` (APPROVED + bağ + bölge include) × saf kural; kartlar: aynı servis, filtresiz |

Sitemap, sayfa metadata'sı ve JSON-LD **aynı** boolean'ı okur; web'de eşik yok, API'de tek modül.

### 2.3 Wire sözleşmesi

- `seoIndexable: boolean` — yalnız public projection'larda (`GET /categories/:slug` public dal, `GET /providers/:id`
  public dal, `GET /showcase/cards/:id`) ve `GET /showcase/feed` gövdesinde üst düzey. Owner/admin dalları
  değişmez. Ham uzunluk, puan, kopya bilgisi, sebep listesi **dönmez** (yalnız boolean).
- `GET /sitemap/entries` şekli aynı (`slug/updatedAt`, `id/updatedAt`, `cardId`); üyelik daralır.

## 3. Web davranışı

`publicPageMetadata` girdisine **zorunlu** `indexEligible: boolean`; `structuredDataOrigin` üçüncü parametre.

| Ortam × durum | robots | canonical / `og:url` | JSON-LD | sitemap |
| --- | --- | --- | --- | --- |
| production+origin, temiz path, uygun | `index, follow` | var | var | var |
| production+origin, temiz path, **uygun değil** | `noindex, follow` | **yok** | **yok** | **yok** |
| production+origin, işlevsel query | `noindex, follow` | yok | yok | — |
| local/staging/undeclared/bozuk origin | `noindex, nofollow` | yok | yok | boş (`Disallow: /`) |
| private/panel/auth | `noindex, nofollow` | yok | yok | — |

Sayfalar: kategori `category.seoIndexable === true`; işletme `provider.seoIndexable === true`; raf
`feed?.seoIndexable === true` (loader `cache()` ile metadata+sayfa tek istek); kart `card.seoIndexable === true`.
`/` ve `/categories` `true`. Alan yoksa/`undefined` → kapalı.

**SEO'ya özel iç link seçici:** repoda yok (SEO-001 iç link eklemedi; mevcut linkler ürün navigasyonudur ve
kaldırılmaz). Sitemap tek "SEO link seçimi"dir ve uygunluk predicate'ini kullanır. B3 (profil→kategori vb.)
geldiğinde hedef uygunluğu bu boolean'dan okunur.

Query/trailing slash/canonical normalizasyonu SEO-001 `absoluteUrl/canonicalUrl` ile aynen.

## 4. Test planı

- **API unit** `seo-index-eligibility.spec.ts`: her yüzey geçen/kalan; whitespace/HTML/script/entity/görünmez
  karakter/noktalama şişirmesi; Türkçe karakter sayımı; ACTIVE olmayan kategori, ROUTER, blok yok; APPROVED
  olmayan sağlayıcı, kısa açıklama, DRAFT bağ, eksik bölge (DISTRICT scope ilçesiz); kart: kısa özet, 2 madde,
  kopya özet, sağlayıcı uygun değil, canlı değil; raf 4 vs 5; tanınmayan/`null` girdi → `false`.
- **API integration**: `sitemap-entries.spec.ts` (uygun/uygun-olmayan işletme ve kart; ACTIVE kategori bile
  listelenmez; süresi bitmiş/askıda kart; alan seti aynı, sızıntı yok); `providers-access.spec.ts` (+`seoIndexable`
  boolean, owner/admin dalında yok); `showcase-feed.spec.ts` (kart `seoIndexable`, feed üst düzey; ham
  içerik/skor sızmaz); üçünün aynı sonucu verdiği (sitemap üyeliği ⇔ projection `seoIndexable`).
- **Web unit**: `seo-metadata.spec.ts` (`indexEligible:false` → noindex,follow, canonical/og yok;
  `structuredDataOrigin` null); mevcut testler `indexEligible: true` ile.
- **E2E** `seo-indexing.spec.ts` (production-benzeri `https://taktick.example`): mevcut fixture envanteriyle
  `/` ve `/categories` index; kısa kategori, açıklamasız işletme, 2-kartlık raf, kısa kart → `noindex, follow`,
  canonical/OG/JSON-LD yok, sitemap'te yok; **uygun sahne** (300+ açıklamalı işletme, 5 uygun canlı kart) →
  işletme + raf + kartlar birlikte index, canonical = og:url = JSON-LD url = sitemap `<loc>`; sitemap'teki her
  URL 200; staging/local fail-closed regresyonu aynen.

## 5. Neden production hâlâ kapalı tutulmalı

Bu PR "ince sayfa indekse girmez" garantisini kodlar; ama `/` ve `/categories` dışında indekslenecek sayfa
yoktur ve kapı açılırsa Google sitemap'te 3 satır görür. Kapıyı açmak (SEO-001 §8 operatör adımları) ancak
K1/K2 içerik işi (SEO-002 §5.1) ve Search Console kurulumu ile anlamlıdır; ayrıca kategori sayfaları B4 modeli
gelmeden **hiçbir zaman** geçemez.

## 6. B4'e kalan içerik modeli gereksinimleri

- `ServiceCategory` için üç editoryal blok (`decisionGuide`, `priceFactors`, `faq`) — kalıcı alan/ayrı model,
  admin düzenleme, sayfada render; `isCategoryIndexable({ editorialBlocks })` girdisi hazır, ek kural gerekmez.
- (B9) işletme görseli alanı — profil kuralına eklenecek; şimdi uydurulmadı.
- (B3) profil→kategori, kart→kategori iç linkleri — hedef uygunluğu `seoIndexable`'dan.

## 7. Değişmeyenler

Ortam kapısı (`seo-site.ts`), allowlist ve query kuralları (`seo-routes.ts`), kanonik URL standardı, robots.txt,
web sitemap builder, JSON-LD şemaları (yalnız render koşulu), public görünürlük predicate'leri
(`isPubliclyReachable`, `PUBLICLY_VISIBLE_PROVIDER_STATUSES`, `livePlacementPredicate`), auth/guard'lar,
görünür kopya/tasarım, Prisma/DB, gerçek `.env`, Cloudflare, Search Console, deploy, container'lar.
