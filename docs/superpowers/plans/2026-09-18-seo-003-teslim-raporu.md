# SEO-003 (B2) — İndeks uygunluğu — Teslim Raporu

Tarih: 2026-09-18 · Branch `claude/seo-003-index-eligibility` (taban `origin/main` @ `060207ef`, temiz
worktree doğrulandı) · PR [#93](https://github.com/umutciftciii/taktic/pull/93) · head/CI §8 · Tasarım notu:
`docs/superpowers/specs/2026-09-18-seo-003-index-eligibility-design.md`.

Merge, deploy, yerel/staging eşitlemesi, gerçek `.env`, Cloudflare, Search Console: **yapılmadı**. Migration
yok; yeni içerik alanı/CMS/admin ayarı/feature flag yok; gerçek veri yazılmadı (yalnız test fixture'ları ve
test veritabanları).

---

## 1. Tek predicate'in yeri

| Katman | Dosya | Rol |
| --- | --- | --- |
| Saf kurallar + eşikler | `apps/api/src/modules/seo/seo-index-eligibility.ts` | `SEO_INDEX_THRESHOLDS`, `meaningfulLength`, `isCategoryIndexable`, `isProviderIndexable`, `isShowcaseCardIndexable`, `isShowcaseShelfIndexable`, `markDuplicateSummaries` — Prisma'sız, `unknown`-toleranslı, fail-closed |
| Veri yükleme | `apps/api/src/modules/seo/seo-index-eligibility.service.ts` (`SeoModule`) | canlı kart + sağlayıcı olguları **tek** SQL (`livePlacementPredicate` + aktif raf EXISTS, feed/sitemap ile aynı join); işletmeler tek `findMany` (bağ + bölge include) |
| Tüketiciler | `categories.service.ts` (public detay), `providers.service.ts` (`toPublicProvider`), `showcase-feed.service.ts` (`list` → raf, `getPublicCard` → kart), `sitemap.service.ts` | hepsi aynı fonksiyonları çağırır; web'e yalnız `seoIndexable: boolean` iner |
| Web | `apps/web/lib/seo-metadata.ts` `publicPageMetadata({ indexEligible })`, `structuredDataOrigin(route, query, indexEligible)` | eşik bilmez; `=== true` değilse kapalı |

Web'de ve API sitemap'inde ayrı eşik kopyası **yok**; sitemap, sayfa metadata'sı ve JSON-LD aynı boolean'ı okur.

## 2. Yüzey × eşik × bugünkü sonuç

Eşikler **başlangıç eşiğidir** (SEO-002 §4.1/§5.3). "Bugün" = yerel/staging kopyası (SEO-002 envanteri);
production bilinmiyor ama aynı model alanlarıyla aynı sonuç beklenir.

| Yüzey | Kural | Bugün | Neden |
| --- | --- | --- | --- |
| `/`, `/categories` | ortam kapısı | **index** (kapı açıksa) | kayıt kuralı yok |
| `/categories/:slug` | ACTIVE leaf ∧ açıklama ≥400 ∧ 3 editoryal blok ≥80 (`decisionGuide`, `priceFactors`, `faq`) | **noindex, follow** — 7/7 | bloklar modelde yok (B4) → kategori geçemez; açıklama 23–43 karakter |
| `/isletme/:id` | APPROVED ∧ açıklama ≥300 ∧ ≥1 ACTIVE-leaf bağ ∧ il/ilçe ∧ ≥1 tam bölge satırı | **noindex, follow** — 3/3 | açıklama boş |
| `/vitrin` | ≥5 uygun canlı kart | **noindex, follow** | 2 kart, 0 uygun |
| `/vitrin/:cardId` | canlı ∧ sağlayıcı uygun ∧ özet ≥200 ∧ kapsam ≥3 dahil + ≥1 hariç ∧ kopya değil | **noindex, follow** — 2/2 | özet 91–116, sağlayıcı uygun değil |

Anlamlı karakter: HTML/script/style/entity/görünmez karakter atılır, yalnız `\p{L}\p{N}` sayılır; Türkçe
harfler korunur. Görsel şartı modelde alan olmadığı için **uydurulmadı**.

## 3. Sitemap / metadata / JSON-LD ortaklığı — kanıt

- API integration `sitemap-entries.spec.ts` (14 test): listelenen her işletme/kart için ilgili public
  projection `seoIndexable === true`, listelenmeyen public kayıtlar için `false` (aynı testte); kategori
  uzun açıklamayla bile listelenmez ve `seoIndexable=false`; raf eşiği 4 → false, 5 → true, filtre/limit'ten
  bağımsız; sızıntı yok (açıklama/kapsam/"Filtre" metni gövdede aranır).
- Web unit `seo-metadata.spec.ts`: `indexEligible:false` → `noindex, follow`, canonical/`og:url` yok;
  `undefined/null/'true'/1` → kapalı; `structuredDataOrigin` üçüncü koşulla null.
- E2E `seo-indexing.spec.ts` (production-benzeri `https://taktick.example`): ince sahne → `/` ve `/categories`
  `index`, kategori/işletme/raf/kart `noindex, follow` + canonical/OG/JSON-LD yok + sitemap'te yok; **uygun
  sahne** (300+ açıklamalı işletme, 5 uygun kart) → işletme + raf + 5 kart birlikte `index`, canonical =
  og:url = JSON-LD url = sitemap `<loc>` byte eşit, sitemap'teki her URL 200; API kaynağı (`/sitemap/entries`)
  ile sayfa projection'ları kayıt kayıt aynı; staging/local fail-closed aynen.

## 4. Kalite kapıları

| Komut | Sonuç |
| --- | --- |
| `pnpm lint` (typecheck dahil, 4 paket) | geçti |
| `pnpm --filter @taktic/api test` | 132 dosya / 3020 test geçti |
| `pnpm --filter @taktic/web test` | 36 dosya / 331 test geçti |
| `pnpm build` | geçti (E2E öncesi) |
| `pnpm e2e seo-indexing` (chromium) | 10/10 |
| `pnpm e2e:webkit` | 110/110 |
| CI | run `35377002879` 3/3 success (head `fee5ac73`) |

## 5. Production neden hâlâ kapalı tutulmalı

Bu PR "ince sayfa indekse girmez" garantisini kodlar; kapı (`APP_ENVIRONMENT=production` + geçerli
`WEB_APP_URL`) açılırsa Google bugün yalnız `/`, `/categories`, `/vitrin`-dışı 2 statik satırlık bir sitemap
görür (raf da eşik altı). Açmak, K1/K2 içerik işi (SEO-002 §5.1) ve Search Console kurulumu ile birlikte
anlamlıdır; kategori sayfaları B4 modeli gelmeden hiçbir koşulda indekslenmez.

## 6. B4'e kalan içerik modeli gereksinimleri

- `ServiceCategory` için üç editoryal blok (`decisionGuide`, `priceFactors`, `faq`) — kalıcı alan/ayrı model +
  admin düzenleme + sayfada render; `isCategoryIndexable({ editorialBlocks })` girdisi hazır, kural değişmez.
- (B9) işletme görseli alanı — profil kuralına eklenecek.
- (B3) profil→kategori / kart→kategori linkleri — hedef uygunluğu `seoIndexable`'dan.
- SEO'ya özel iç link seçici bugün yok (SEO-001 iç link eklemedi); sitemap tek "SEO link seçimi"dir ve
  predicate'i kullanır.

## 7. Değişmeyenler

Ortam kapısı (`seo-site.ts`), allowlist/query kuralları (`seo-routes.ts`), kanonik URL standardı, robots.txt,
web sitemap builder, JSON-LD şemaları (yalnız render koşulu), public görünürlük predicate'leri, auth/guard'lar,
görünür kopya/tasarım, Prisma/DB, gerçek `.env`, Cloudflare, Search Console, deploy, yerel/staging
container'lar. Owner/admin provider projection'ları `seoIndexable` taşımaz.

## 8. PR / head / CI

| Alan | Değer |
| --- | --- |
| PR | [#93](https://github.com/umutciftciii/taktic/pull/93) — `claude/seo-003-index-eligibility` → `main` |
| Kod commit'i | `fee5ac73` — CI run `35377002879`: **3/3 success** (`typecheck · lint · test · build`, `e2e (chromium)`, `e2e (webkit · sign-in and mobile shells)`) |
| Son head | bu raporu ekleyen docs commit'i; CI aynı workflow'la yeniden koşar |
