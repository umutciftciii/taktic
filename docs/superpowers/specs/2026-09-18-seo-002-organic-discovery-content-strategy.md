# SEO-002 — Organik keşif ve içerik/landing stratejisi — Tasarım Notu

Tarih: 2026-09-18 · Taban: `origin/main` @ `e51c950c` (SEO-001 merge) · **Docs-only PR.**

Bu aşama hiçbir üretim route'u, metadata, sitemap/robots, veritabanı, migration, gerçek `.env`,
Cloudflare, Search Console, deploy ya da yerel/staging container değiştirmez. Çıktı yalnız bu iki belgedir:
strateji (bu dosya) ve `docs/superpowers/plans/2026-09-18-seo-002-teslim-raporu.md`.

Amaç: SEO-001'in teknik indeksleme altyapısının (ortam kapısı, allowlist, canonical, sitemap, JSON-LD)
üstüne **hangi sayfaların gerçekten indekslenmeye değer olduğunu** ve **hangi içeriklerin önce
üretilmesi gerektiğini** kanıtla belirlemek. Ana ilke: arama sonuçlarına ince, tekrar eden ya da
yalnız filtre parametresi olan sayfa sokmamak.

Kanıt sınırı: sayılar **yerel Docker DB'den** (2026-09-10 staging kopyası + sonrasında eklenen yerel
test verisi) salt-okunur alındı. **Production verisi bilinmiyor**; bu belgedeki her sayı "yerel/staging
kopyası" etiketiyle okunmalı. Anahtar kelime hacmi **verilmedi** (Keyword Planner / Search Console erişimi
yok); yerine ölçüm planı var (§6).

---

## 1. Gerçek envanter

### 1.1 Public yüzeyler

Kaynaklar: `apps/web/lib/seo-routes.ts` (allowlist, işlevsel query listesi, `ROBOTS_DISALLOW`,
`NOINDEX_CRAWLABLE_ROUTES`), sayfa dosyaları (`apps/web/app/**/page.tsx`), `prisma/schema.prisma`,
`apps/api/src/modules/sitemap/`.

| Yüzey | URL | Veri kaynağı | Sayfada görünen içerik alanları | Mevcut iç bağlantılar (çıkan) | Kullanıcı niyeti | İnce-içerik riski | SEO-001 sitemap |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Ana sayfa | `/` | statik landing + `GET /categories?limit=10` + vitrin rafı (`GET /showcase/feed`) | H1 + hero; "En çok talep edilen hizmetler" (10 kategori kartı); 3 adım; kredi modeli anlatımı; SSS (6 soru, `landing-faq.tsx`); vitrin rafı; CTA'lar | `/categories`, `/categories/<slug>` (10), `/vitrin`, `/vitrin/<cardId>`, `/providers/register`, `/requests/my`, `#nasil-calisir`, `#lp-sss` | marka + "ne bu?" + kategori keşfi | **Düşük** — özgün ürün anlatımı var | evet (lastmod yok) |
| Kategori dizini | `/categories` | `GET /categories` (yalnız `ACTIVE` + `LEAF`) | H1 "Hizmet kategorileri", `CATALOGUE_INTRO`, arama kutusu, "Popüler aramalar" (6 sabit etiket → `?q=`), kategori kartları (ad + açıklama) | `/categories/<slug>` (her aktif kategori), `/categories?q=…` (6, noindex varyant), `/#lp-sss`, `/` | kategori keşfi | **Orta** — liste sayfası; değeri kategori sayısı ve açıklama kalitesiyle sınırlı | evet |
| Kategori sayfası | `/categories/<slug>` | `GET /categories/:slug` (`isPubliclyReachable`: ACTIVE leaf/router) | Breadcrumb; H1 = `name`; alt başlık = `description` (yoksa akış cümlesi); 3 etiket ("Kategoriye özel form", "14 gün geçerlilik", "Teklif almak ücretsiz"); misafir/hesap notu; kategori görseli (`imageUrl/coverImageUrl/iconKey`); **talep formu** (`questions`) | `/categories`, `/register/customer`, sözleşme linki (formdan) | hizmet ihtiyacı + **talep açma** (işlemsel) | **Yüksek** — açıklama tek cümle (yerelde 23–43 karakter), geri kalanı form; sayfada hizmet veren listesi, rehber, SSS **yok** | evet (`lastmod = updatedAt`) |
| İşletme profili | `/isletme/<id>` | `GET /providers/:id` public projeksiyon (yalnız `APPROVED`) + `GET /providers/:id/reviews/public` (anahtar açıksa; eşik altı özet null) | Breadcrumb (Ana sayfa / İşletme — kategori yok); H1 = `businessName`; il, ilçe; puan özeti (eşik sağlanınca); "Hakkında" = `description` (yoksa "henüz tanıtım metni eklememiş"); "Hizmetler" = kategori **etiketleri (link değil)**; "Hizmet bölgeleri" = `serviceAreas` etiketleri; iletişim notu; CTA `/categories` | `/`, `/categories`, `/isletme/<id>?cursor=` (noindex varyant) | işletme adı / profil (navigasyonel) + güven kontrolü | **Yüksek** — `description` boşsa sayfa = ad + il/ilçe + etiketler; kategoriye/vitrine link yok | evet (`lastmod = updatedAt`) |
| Vitrin rafı | `/vitrin` | `GET /showcase/feed` (yalnız canlı kartlar, `livePlacementPredicate`) + `/locations/provinces` | H1 "Vitrin hizmetleri", `SHELF_INTRO`, il/ilçe GET formu (`?il=&ilce=`), kart ızgarası (`ShowcaseShelfCard`) | `/`, `/vitrin/<cardId>`, `/vitrin?il=…` (form, noindex varyant) | "öne çıkan/hazır fiyatlı hizmet" keşfi | **Orta–yüksek** — canlı kart sayısına bağlı; yerelde 2 kart | evet |
| Vitrin kartı | `/vitrin/<cardId>` | `GET /showcase/cards/:id` (`getPublicCard`: ACTIVE placement + APPROVED kart + APPROVED sağlayıcı) + public reviews | Breadcrumb (Ana sayfa / Vitrin); kicker = `category.name` (link değil); H1 = `title`; işletme adı → `/isletme/<id>`; puan özeti; kart yüzü (`summary`, görsel, **fiyat**); kapsam notu (bölge); "Dahil olanlar" / "Hariç olanlar" (`scopeIncluded/Excluded`); "Yanıt taahhüdü" (SLA saatleri); fiyat sorumluluğu notu; talep formu | `/`, `/vitrin`, `/isletme/<id>`, `?step=form` (noindex varyant) | vitrin/öne çıkan işletme + hazır hizmet paketi | **Orta** — özet 91–116 karakter (yerel), kapsam listeleri 1–2 madde; kategori sayfasına link **yok** | evet (lastmod **yok**) |
| Sözleşme/aydınlatma | `/sozlesmeler/iletisim-paylasimi` | statik | hukuki metin | — | hukuki/yardım | — | hayır (`noindex, follow`, crawl edilebilir) |
| Yardım/KVKK/Gizlilik/Kullanım şartları | **yok** — footer'daki üç link `href="#"` (`site-footer.tsx:87-89`) | — | — | — | yardım/güven | — | — |
| Rehber/makale/blog | **yok** — `apps/web/app/` altında böyle bir route bulunmuyor | — | — | — | bilgi amaçlı | — | — |
| Arama/filtre | `/categories?q=`, `/vitrin?il=&ilce=`, `/isletme/<id>?cursor=`, `/vitrin/<cardId>?step=…`, `/categories/<slug>?entry=&r=` | aynı sayfaların varyantı | aynı | — | — | tanım gereği tekrar | hayır (`noindex, follow`, canonical yok) |
| Auth / panel / talep / teklif / mesaj / destek | `ROBOTS_DISALLOW` listesi (`seo-routes.ts:63-78`) | oturumlu | — | — | — | — | hayır (robots Disallow + noindex) |

Teyit: allowlist `INDEXABLE_ROUTES` altı route'tur; başka public yüzey yoktur. Yeni `page.tsx` eklemek
`apps/web/test/seo-routes.spec.ts`'i kırar (SEO-001 kuralı) — bu belge yeni route **önermez**, yalnız aday
tanımlar.

### 1.2 Veri doluluğu (yerel DB, salt-okunur; production bilinmiyor)

Sorgular `docker exec -i taktic-postgres psql -U taktic_user -d taktic` ile çalıştırıldı; hiçbir yazma yok.

**Kategori (`ServiceCategory`)**

| Ölçüm | Değer (yerel) |
| --- | --- |
| `ACTIVE` + `LEAF` (public) | **7**: `klima-servisi`, `klima-montaji`, `kombi-servisi`, `elektrikci`, `su-tesisatcisi`, `boya-badana`, `ev-temizligi` |
| `ACTIVE` + `ROUTER` | 0 |
| `DRAFT` (public değil) | 10 GROUP + 32 LEAF (taksonomi: Temizlik ve Hijyen, Taşınma ve Lojistik, Tadilat ve Yenileme, Beyaz Eşya Teknik Servis, Yapı ve Montaj, Eğitim, Etkinlik, Sağlık ve Wellness, Kurumsal ve Danışmanlık, Dijital ve Yaratıcı) |
| Aktif kategoride `description` dolu | 7/7, ancak **23–43 karakter** (ort. 37); ≥80 karakter: **0**; hepsi "… talepleri." kalıbında tek cümle |
| Aktif kategoride `imageUrl` / `coverImageUrl` | 0 / 0 |
| Aktif kategoride soru seti (`ServiceRequestQuestion`) | 3/7 kategoride var (klima-montaji, kombi-servisi, elektrikci: 3'er soru) |
| Aktif kategori adı/açıklamasında Türkçe karakter | **yok** (ör. "Klima Montaji", "Elektrikci", "Su Tesisatcisi", "Ev Temizligi"); DRAFT taksonomi ise Türkçe karakterli ("Taşınma ve Lojistik") — title/H1 olarak arama sonucunda görünen metin bu (gözlem; bu aşamada değiştirilmedi) |

**İşletme (`ProviderProfile`)**

| Ölçüm | Değer (yerel) |
| --- | --- |
| `APPROVED` | **3** (1 gerçek — 2026-08-17; 2 tanesi 2026-09-15 kabul testi kaydı görünümünde, 50 karakterlik ad). `PENDING_REVIEW`: 1 |
| `description` dolu | **0/3** → public profilde "Bu işletme henüz bir tanıtım metni eklememiş." |
| Kategori bağı / hizmet bölgesi | 3/3 kategori (ort. 2), 3/3 bölge (ort. 1, hepsi `DISTRICT` kapsamı) |
| İl × ilçe dağılımı | tek: İstanbul / Kadıköy |
| Public puan | 1 işletmede 1 değerlendirme; public eşik (`PROVIDER_REVIEW_PUBLIC_MIN_COUNT`) altı → özet gösterilmez |

**Vitrin (`ShowcaseCard` / `ShowcasePlacement` / `ShowcaseCardVersion`)**

| Ölçüm | Değer (yerel) |
| --- | --- |
| Canlı kart (ACTIVE placement, `startAt<=now<endAt`, APPROVED sağlayıcı, live version) | **2** (ikisi de `klima-servisi`, İstanbul/Kadıköy) |
| Canlı sürüm `summary` uzunluğu | 91–116 karakter; `imageUrl` 0/2; `scopeIncluded/Excluded` ort. 1.5 madde; fiyat 2/2 |

**Talep (yalnız talep tarafı sinyali; SEO'da kullanılmaz)**: 21 talep, hepsi İstanbul; kategori: klima-servisi 12,
ev-temizligi 7, klima-montaji 2.

Sonuç: yerel/staging kopyasında **indekslenebilir sayfa sayısı 1 + 1 + 7 + 3 + 1 + 2 = 15**, bunların
çoğu tek cümlelik açıklamayla ince. Production'daki gerçek sayılar ve içerik kalitesi **bilinmiyor**; §6'daki
Search Console kurulumu ve §7'deki "envanter raporu" kod işi olmadan doğrulanamaz.

### 1.3 Kategori × il/ilçe: landing mi, filtre mi?

- Bugün **kategori × il/ilçe için hiçbir route yok**. Konum filtresi tek yerde var: `/vitrin?il=&ilce=`
  (GET formu; `seo-routes.ts` bunu işlevsel query sayar → `noindex, follow`, canonical yok). Kategori
  sayfasında (`/categories/<slug>`) konum boyutu yoktur; il/ilçe yalnız **talep formunun** alanıdır.
- Vitrin filtre sonucu bir landing değildir: başlık, açıklama ve metin il/ilçeyle değişmez; yalnız kart
  kümesi daralır (boşsa "… için şu anda vitrinde hizmet yok."). Bu, Google'ın "yalnız filtre" tanımına
  girer (§2, faceted navigation) ve SEO-001'in noindex kararı doğrudur.
- Arz ölçümü (yerel): kategori × il çifti 3, ≥3 sağlayıcı olan çift **1** (`ev-temizligi` × İstanbul);
  kategori × ilçe çifti 3, ≥3 olan 1. Production için bilinmiyor.

Karar (§4.2): şehir×kategori ve ilçe×kategori sayfaları **şimdilik üretilmez**; otomatik rota **hiç**
önerilmez; eşik modeli tanımlanır, veri eşiği karşıladığında tek tek (elle) açılır.

### 1.4 Dijital/uzaktan hizmetler — yalnız not

Veri modeli konumdan bağımsız hizmeti **ifade etmiyor**: `ProviderProfile.city/district` zorunlu,
`ProviderServiceArea.scope ∈ {CITY, DISTRICT, NEIGHBORHOOD}` (ülke/uzaktan kapsamı yok),
`ServiceRequest.city/district` zorunlu, `matchesProviderArea` (`apps/api/src/common/provider-request-matching.ts:35`)
yalnız coğrafi eşleşme yapar. DRAFT taksonomide "Dijital ve Yaratıcı" (4 leaf) ve "Kurumsal ve
Danışmanlık" (4 leaf) grupları var; bunlar açıldığında SEO tarafında "şehir" boyutu anlamsız olacak.
Eşleşme kuralı bu belgede **değiştirilmez**; §7 backlog'una "uzaktan hizmet için ürün kararı" olarak
not düşüldü. SEO etkisi: dijital kategoriler için şehir×kategori adayı **hiç** üretilmemeli; kategori sayfası
tek landing olmalı.

### 1.5 Marka yazımı çelişkisi (tespit; metin değiştirilmedi)

`grep -w` sayımı (`apps/`, `packages/`, `.ts/.tsx`, test dahil): **`TakTick` 81**, **`TakTic` 31**.

| Yüzey | Yazım | Kaynak |
| --- | --- | --- |
| SEO site adı (`og:site_name`, JSON-LD `Organization.name`), logo alt/aria, SSS, vitrin fiyat notu | `TakTick` | `lib/seo-metadata.ts:32`, `site-footer.tsx:61-62`, `landing-faq.tsx:12`, `vitrin/[cardId]/page.tsx` |
| Kök `<title>` ve `description` (arama sonucunda görünen) | `TakTic` | `lib/seo-metadata.ts:35-37` |
| Footer © satırı, landing metni, provider-invite başlığı | `TakTic` | `site-footer.tsx:85`, `page.tsx:293`, `provider-invite/[token]/page.tsx:25` |
| Paylaşılan sabit `TAKTIC_APP_NAME` (API e-posta şablonları, admin) | `TakTic` | `packages/shared/src/index.ts:1`, `transactional-templates.ts` |
| Alan adı referansları (kod/test) | `taktick.com.tr` 21, `taktick.example` 82 (E2E), `taktic.local` 2 | grep |

Sonuç: aynı sayfada `<title>` "TakTic …" derken `og:site_name` ve JSON-LD "TakTick" diyor. Marka
sorgusu (§3) için tek yazım gerekli; alan adı `taktick.com.tr` olduğuna göre aday `TakTick`'tir, ancak bu
**ürün/marka kararıdır** — §7 backlog'unda; bu PR metin değiştirmez.

### 1.6 Diğer gözlemler

- Footer "Kullanım Şartları / Gizlilik / KVKK" linkleri `href="#"` (`site-footer.tsx:87-89`): sayfalar yok.
  Güven sinyali (E-E-A-T "trust") ve yasal gereklilik açısından boşluk; SEO'dan önce ürün/hukuk işi.
- İşletme profilinde kategori etiketleri link değil; vitrin kartında kategori kicker'ı link değil →
  profil→kategori ve vitrin→kategori bağlantıları **yok** (§5.4 iç link haritasında hedef).
- Kategori dizini "Popüler aramalar" `?q=` varyantına link veriyor (noindex); crawl edilebilir ama indeks
  dışı — sorun değil, ancak bu etiketler doğrudan `/categories/<slug>`'a gitse daha temiz olur (§7).
- Sitemap vitrin satırında `lastmod` yok (SEO-001 kararı; placement tarihi public projeksiyonda değil).

---

## 2. Araştırma notları — resmî Google Search Central

Her satır kaynağın kendi ifadesine dayanır; yorum "TakTick'e etkisi" sütunundadır.

| Konu | Kaynak | Kural (özet) | TakTick'e etkisi |
| --- | --- | --- | --- |
| Doorway (kapı) sayfaları | Spam policies → "Doorway abuse" (`developers.google.com/search/docs/essentials/spam-policies`) | Benzer sorgular için yaratılan, kullanıcıyı asıl hedeften daha az yararlı ara sayfalara götüren sayfalar; örnek: "multiple domain names or pages targeted at specific regions or cities that funnel users to one page" | Aynı formu gösteren `kategori × şehir` sayfaları tam bu tanımdır. Şehir sayfası ancak **kendi başına** yararlıysa (yerel arz + özgün içerik) meşrudur |
| Ölçekli içerik | Spam policies → "Scaled content abuse" | "many pages are generated for the primary purpose of manipulating search rankings and not helping users"; üretken araçlarla değer katmadan çok sayfa üretmek örnek | 81 il × N kategori otomatik üretim **yasak sınıfı**; şablon metin + değişken şehir adı da buna girer |
| Yardımcı içerik | Creating helpful content (`…/fundamentals/creating-helpful-content`) | "Does your content leave readers feeling like they need to search again…?", "Is the content primarily made to attract visits from search engines?", "Are you using extensive automation to produce content on many topics?"; E-E-A-T'de "trust is most important" | Kategori sayfası bugün "tekrar aramaya" ittirir (yalnız form). Rehber içerikleri ilk elden bilgiyle (operasyon/moderasyon deneyimi) yazılmalı, yazar/güncelleme tarihi görünür olmalı |
| Canonical | Consolidate duplicate URLs (`…/crawling-indexing/consolidate-duplicate-urls`) | "link to the canonical URL rather than a duplicate URL"; noindex ile canonical seçimini yönlendirmemek ("rel=canonical … preferred solution") | SEO-001 standardı uyumlu: varyantta canonical yok, temiz path tek canonical; iç linkler temiz path'e gitmeli (`?q=` linkleri istisna, noindex) |
| Faceted / filtre URL'leri | Managing faceted navigation (`…/crawling-managing-faceted-navigation`) | Filtre URL'leri indekslenmeyecekse taramayı engelle/azalt; boş sonuç için 404; canonical filtresiz sürüme | `/vitrin?il=` noindex doğru; ileride şehir landing'i açılırsa filtre parametresi değil **ayrı statik path** olmalı ve boş sonuçta rota olmamalı |
| noindex | Block indexing (`…/crawling-indexing/block-indexing`) | noindex'in görülmesi için sayfa robots.txt ile **engellenmemeli** | Sözleşme sayfası ve varyantlar bu kurala uygun (crawl edilebilir, noindex). Yeni "koşullu indeks" sayfaları da robots'ta engellenmemeli, meta ile kapatılmalı |
| Sitemap | Build sitemap (`…/sitemaps/build-sitemap`) | 50.000 URL / 50 MB; `lastmod` yalnız "consistently and verifiably accurate" ise; `priority/changefreq` yok sayılır; yalnız canonical URL'ler | SEO-001 uyumlu. Vitrin `lastmod` yok = doğru (uydurulmaz). Sitemap index 50k'ya kadar gereksiz |
| Yapısal veri genel | SD policies (`…/appearance/structured-data/sd-policies`) | "Don't mark up content that is not visible…", "true representation of the page content", zorunlu alan eksikse rich result yok, gösterim garantisi yok | JSON-LD'de puan/fiyat yok = doğru (görünmeyen/kural dışı iddia yok). `LocalBusiness` için zorunlu `address` tam adres ister (streetAddress vb.) — profilde yalnız il/ilçe var → rich result beklenmez; markup zararsız ama "kazanım" vaat etmemeli |
| Yorum yıldızı | Review snippet (`…/structured-data/review-snippet`) | "Ratings must be sourced directly from users"; işletme kendi yorumlarını kontrol ediyorsa `LocalBusiness/Organization` sayfaları yıldız için **uygun değil** | Platform yorumları kullanıcı kaynaklı; ancak eşik/gizleme kuralları ve "puan JSON-LD'ye girmez" kararı (SEO-001) korunur. `aggregateRating` **açılmaz** (bu belge) |
| LocalBusiness | Local business SD (`…/structured-data/local-business`) | Zorunlu: `name`, `address`; önerilen: `telephone`, `openingHours`, `priceRange`, `aggregateRating`… | Telefon/fiyat/puan bilinçli dışarıda (ürün kuralı). Rich result hedeflenmez; şema yalnız varlık tanımı |
| Page indexing raporu | Search Console help 7440203 | Durumlar: "Crawled – currently not indexed", "Discovered – currently not indexed", "Duplicate without user-selected canonical", "Excluded by noindex", "Alternate page with proper canonical"; sitemap'e göre filtre | §6 haftalık kontrol listesinin çekirdeği; "Crawled – not indexed" artışı = ince içerik sinyali |
| Performance raporu | Search Console help 7576553 | Metrikler: clicks, impressions, CTR, average position; boyutlar: query, page, country, device, search appearance, date; search type filtresi | §6 ölçüm planı bu boyutlarla kurulur; hacim yerine **impressions** gerçek talep vekilidir |

---

## 3. Niyet kümeleri (Türkçe yerel hizmet pazaryeri)

Hacim **verilmiyor**. Her küme için: örnek sorgu kalıbı, hedef yüzey, bugünkü karşılama düzeyi, ölçüm.

| # | Niyet kümesi | Örnek kalıp (hacimsiz) | Hedef yüzey | Bugün | Nasıl ölçülür (SC kurulunca) |
| --- | --- | --- | --- | --- | --- |
| N1 | Kategori/hizmet ihtiyacı (işlemsel) | "klima servisi", "kombi bakımı", "boya badana ustası", "ev temizliği" | `/categories/<slug>` | Sayfa var ama tek cümle + form; sorguyu **karşılamıyor** (hizmet veren yok, rehber yok) | Performance → Page = `/categories/*`, query listesi; CTR/pozisyon |
| N2 | Yerel hizmet + bölge | "Kadıköy klima servisi", "İstanbul kombi bakımı", "<ilçe> elektrikçi" | **hedef yüzey yok** (bkz. §4.2) — kısa vadede `/categories/<slug>` + `/vitrin` | Karşılanmıyor; vitrin filtresi noindex | Query içinde il/ilçe adı geçen sorgular (regex filtre) → hangi kategori × şehir çiftinin gösterim aldığı; §4.2 eşik girdisi |
| N3 | İşletme adı / profil (navigasyonel) | "<işletme adı>", "<işletme adı> yorum" | `/isletme/<id>` | Ad + il/ilçe + etiket; `description` çoğunlukla boş | Query = işletme adı (brand-benzeri) → impressions; profil doluluğuyla korelasyon |
| N4 | Vitrin / öne çıkan / hazır fiyatlı hizmet | "klima bakım fiyatı", "sabit fiyat klima temizliği <ilçe>" | `/vitrin/<cardId>`, `/vitrin` | Kart sayfası orta; raf kart sayısına bağlı | Page = `/vitrin/*`; "fiyat" içeren sorgular |
| N5 | Bilgi amaçlı: nasıl seçilir / fiyatı ne etkiler / ne zaman | "klima bakımı ne zaman yapılır", "kombi servisi seçerken nelere dikkat", "boya badana fiyatını ne etkiler" | **yok** — rehber sayfaları (§5) | Karşılanmıyor | Yeni sayfalar açılınca Page filtresi; bilgi sorguları → kategori sayfasına iç link tıklaması (event) |
| N6 | Marka | "taktick", "taktic", "taktick teklif kredisi" | `/` + SSS | Var; yazım çelişkisi (§1.5) | Query = marka varyantları; iki yazımın dağılımı **karar girdisi** |
| N7 | Hizmet veren tarafı (arz) | "hizmet veren ol", "teklif kredisi nasıl çalışır", "işletme kaydı taktick" | `/` (kredi anlatımı, SSS) → `/providers/register` (noindex) | Landing anlatıyor; başvuru noindex (doğru) | Query listesi; `/providers/register` dönüşümü (event) |

Öncelik sırası (kanıt-temelli, hacimsiz): **N1 → N5 → N3 → N4 → N6 → N2 → N7**. Gerekçe: N1 mevcut
route'ta, düzeltilebilir; N5 N1'i besler ve şehir sayfası olmadan bölge sorgularının bir kısmını (bilgi
kısmını) karşılar; N3/N4 veri doluluğuna bağlı; N2 arz eşiğine bağlı (§4.2); N6 tek karar; N7 ürün
CTA'sı, SEO değil.

---

## 4. URL ve indeksleme politikası

### 4.1 Karar tablosu

Kararlar: **şimdi indeksle** (SEO-001'de zaten açık, koruma kriteriyle), **koşulla indeksle** (kriter
sağlanmayan tekil sayfa noindex), **indeksleme**.

| Sınıf | Karar | Gerekçe | Objektif giriş kriteri (sayfa başına) | Bugün (yerel) |
| --- | --- | --- | --- | --- |
| Ana sayfa `/` | **Şimdi indeksle** | Özgün ürün anlatımı, SSS, kategori ve vitrin çıkışları; marka sorgusunun hedefi | — (her zaman) | ✔ |
| Kategori dizini `/categories` | **Şimdi indeksle** | Tek kategori dizini; `?q=` noindex kalır | ≥1 ACTIVE leaf kategori (aksi halde boş liste — sitemap'ten çıkarma backlog'u §7) | ✔ (7) |
| Kategori sayfası `/categories/<slug>` | **Koşulla indeksle** (koşul sağlanana kadar mevcut indeks durumu **değiştirilmez**; koşulsuz kategori için noindex kararı §7 kod işi olarak ayrı verilir) | Bugün form + tek cümle = ince. İndeks değerini içerik alanları belirler | **İndexable kategori** = aşağıdakilerin tümü: (a) `description` ≥ 2 paragraf **özgün** hizmet açıklaması (başlangıç önerisi ≥ 400 karakter, "… talepleri." kalıbı değil); (b) §5.2 şablonundaki en az 3 blok dolu (karar rehberi, fiyatı etkileyen etmenler, SSS); (c) `imageUrl` ya da `coverImageUrl` var; (d) Türkçe karakterli ad (title/H1 kalitesi) | 0/7 karşılıyor (açıklama 23–43 karakter, görsel yok) |
| İşletme profili `/isletme/<id>` | **Koşulla indeksle** | Ad + il/ilçe + etiket tek başına arama sonucuna değer katmaz; aynı ilçede N boş profil = ince kopyalar | §5.3 **minimum indexable profile** kontrol listesi | 0/3 (açıklama boş) |
| Vitrin rafı `/vitrin` | **Koşulla indeksle** | Boş ya da 1–2 kartlık raf "boş liste sayfası"dır | ≥ **5** canlı kart (başlangıç önerisi) — altında rafa `noindex, follow` (kod işi §7) | 2 kart → eşik altı |
| Vitrin kartı `/vitrin/<cardId>` | **Koşulla indeksle** | Kart, işletmenin kendi fiyat/kapsam beyanı; özgün olduğunda değerli, şablon olduğunda tekrar | (a) `summary` ≥ 200 karakter (başlangıç önerisi) **ve** aynı sağlayıcının diğer canlı kartlarıyla birebir değil; (b) `scopeIncluded` ≥ 3 ve `scopeExcluded` ≥ 1 madde; (c) `imageUrl` var; (d) sağlayıcı profili §5.3'ü karşılıyor. Placement bittiğinde 404 (zaten böyle) | 0/2 (özet 91–116, görsel yok) |
| Şehir × kategori | **İndeksleme — şimdilik üretme** | Route yok; otomatik üretim doorway/scaled content sınıfı; arz eşiği yerelde karşılanmıyor | §4.2 eşik modeli; **elle, tek tek** açılır | aday 0 |
| İlçe × kategori | **İndeksleme — şimdilik üretme** | Aynı; daha da granüler → daha ince | §4.2 (ilçe eşiği şehirden yüksek) | aday 0 |
| Arama/filtre (`?q`, `?il/ilce`, `?cursor`, `?step`, `?entry/r`) | **İndeksleme** (mevcut `noindex, follow`, canonical yok) | Filtre = aynı sayfa; Google faceted-nav rehberi | — | ✔ (SEO-001) |
| Bilgi rehberi / makale | **Koşulla indeksle** (route henüz yok) | N5 niyeti; kategori sayfasını besler | §5.2 rehber şablonu: yazar/güncelleme tarihi görünür, ≥ 1 kategori sayfasına ve ≥ 1 kategori sayfasından link, ürün kuralı dışı iddia yok (fiyat/başarı oranı/sayı uydurma yok) | route yok |
| Sözleşme/aydınlatma `/sozlesmeler/*` | **İndeksleme** (`noindex, follow` kalsın) | Hukuki metin; landing değil; marka sorgusunda gereksiz sonuç | — | ✔ |
| Yardım / KVKK / Gizlilik / Kullanım şartları | **Şimdi indeksle** — sayfalar **var olduğunda** | Güven sinyali; marka + "güvenilir mi" sorguları; link'ler şu an `#` | Sayfa gerçek içerikle var; footer'dan link | yok |
| Auth / panel / talep / teklif / mesaj / destek / API | **İndeksleme** (robots Disallow + noindex) | Oturumlu/kişisel | — | ✔ |

"Koşulla indeksle" sınıflarında **bu PR hiçbir noindex değişikliği yapmaz**; koşul, içerik üretim
planının (§5) kabul kriteridir ve kod tarafı (§7 backlog) ayrı PR'da gelir. SEO-001 notuna göre
staging/prod deploy'u ve Search Console kurulumu henüz yapılmadı; production'da indeks kapısının açık
olup olmadığı bu oturumda **doğrulanamadı** (bilinmiyor). Bu belge, production açılmadan önce koşulların
(B2) uygulanmasını öngörür; kapı zaten açıksa B2 ilk sıraya alınır.

### 4.2 Şehir × kategori / ilçe × kategori eşik modeli

**Kesin kural:** otomatik rota **yok**. `/[il]/[kategori]` ya da `/categories/[slug]/[il]` gibi bir dinamik
segmentin her il için sayfa üretmesi bu belgeyle **reddedilir**. Aday sayfa yalnız aşağıdaki beş
koşulun **tamamı** sağlandığında, tek tek, operatör kararıyla açılır; koşullardan biri düşerse sayfa
`noindex` olur ya da rota hiç açılmaz.

| # | Koşul | Başlangıç önerisi eşik (ölçülebilir) | Yerel veri (2026-09-18) | Prod |
| --- | --- | --- | --- | --- |
| 1 | Benzersiz editoryal içerik ve gerçek yarar | ≥ 2 paragraf yalnız o şehir/ilçe için doğru bilgi (yerel koşullar, mevsim, bina tipi, yerel gereklilik) — şehir adı değiştirilmiş şablon **sayılmaz**; kategori rehberine ve kategori sayfasına link | yok | bilinmiyor |
| 2 | Yeterli güncel arz | Şehir: ≥ **5** APPROVED sağlayıcı (kategori bağı + o ilde `ProviderServiceArea`) **ve** ≥ 2 farklı işletme son 90 günde aktif (teklif/kart/giriş); İlçe: ≥ **3** sağlayıcı o ilçe/`CITY` kapsamı | il çifti max 3 (`ev-temizligi`×İstanbul); ilçe max 3 | bilinmiyor |
| 3 | Arama niyetini karşılayan gerçek sonuç | Sayfa o şehir/ilçedeki **görünür** sağlayıcı/vitrin kartlarını listeler (≥ 3 görünür öğe); yalnız form değil; boş liste = sayfa yok | listeleme bileşeni yok | — |
| 4 | Canonical, iç bağlantı, sitemap uygunluğu | Statik temiz path (query değil), kendi canonical'ı, kategori sayfasından ve ana sayfa/dizin bloğundan link, sitemap'e `updatedAt` ile | route yok | — |
| 5 | Düşük/boş sonuçta noindex ya da rota yok | Koşul 2/3 düşünce otomatik `noindex, follow` (kod) ve sitemap'ten çıkış; 30 gün altında kalırsa rota kapatılır (404, redirect **değil** — kategori sayfasına redirect doorway sinyali verir) | — | — |

Eşik sayıları **başlangıç önerisidir**; Search Console'da N2 sorgularının gösterim aldığı çiftler ve
gerçek dönüşüm (talep açılma) verisiyle 90. günde revize edilir (§6).

**Mevcut veri eşiği karşılıyor mu?** Hayır. Yerelde hiçbir kategori × il çifti koşul 2'yi (≥5) sağlamıyor;
koşul 1 ve 3 için içerik/bileşen yok. Production sayıları bilinmiyor; §7'deki "arz envanteri raporu"
(salt-okunur sorgu) çıkmadan aday listesi yapılmaz. **Karar: şimdilik üretme.**

Dijital/uzaktan kategoriler (§1.4) bu modelin dışındadır: şehir boyutu anlamsız olduğu için hiçbir
zaman şehir×kategori adayı olmazlar.

---

## 5. İçerik ve iç bağlantı planı

### 5.1 İlk 90 gün — öncelik sırası ve mantık

Sıra, "mevcut indekslenebilir sayfayı ince olmaktan çıkar → onu besleyen bilgi içeriğini ekle → veriye
bağlı yüzeyleri doldur" mantığıyla kurulur. Sayılar hedef değil, sıralama ölçütüdür.

| Dönem | İçerik tipi | Neden önce | Kapsam (yerel veriye göre) | Kabul kriteri |
| --- | --- | --- | --- | --- |
| Gün 0–30 | **K1. Kategori sayfası içeriği** (7 aktif kategori) | Tek indekslenebilir N1 yüzeyi; bugün 0/7 koşulu karşılıyor; `description` alanı ve görsel alanları zaten var (kod değişikliği gerekmeden `description` doldurulabilir; §5.2'nin blok yapısı için alan/bileşen gerekiyorsa §7) | 7 sayfa; önce talep sinyali olanlar: klima-servisi, ev-temizligi, klima-montaji; sonra kombi-servisi, elektrikci, su-tesisatcisi, boya-badana | §4.1 kategori kriteri (a)–(d) |
| Gün 0–30 | **K2. Yardım/güven sayfaları** (KVKK, Gizlilik, Kullanım şartları, "Nasıl çalışır" tek sayfa) | Footer linkleri `#`; E-E-A-T trust; marka sorgularına doğru hedef | 3–4 sayfa; hukuki metin ürün/hukuk sahibinden | Gerçek metin, footer link, indexable |
| Gün 30–60 | **K3. Kategori rehberleri** (N5) — kategori başına 1: "nasıl seçilir / fiyatı ne etkiler / ne zaman" | N1'i besler; bölge sorgularının bilgi kısmını karşılar; şehir sayfası olmadan mümkün | 7 rehber; klima-servisi ve ev-temizligi önce (talep sinyali) | §5.2 rehber şablonu; kategori sayfası ↔ rehber çift yönlü link |
| Gün 30–60 | **K4. İşletme profili doldurma kampanyası** (ürün/ops) | N3; 0/3 açıklama; sağlayıcı paneli alanı zaten var (`description`) | APPROVED tüm sağlayıcılar; panel içi yönlendirme (kod işi §7'de, kampanya ops) | §5.3 minimum indexable profile |
| Gün 60–90 | **K5. Vitrin kartı kalitesi** (sağlayıcı yönlendirmesi + kart yazım kılavuzu) | N4; kart alanları var (summary, scope, image) | canlı kartlar | §4.1 vitrin kartı kriteri |
| Gün 60–90 | **K6. Ana sayfa SSS genişletme + "hizmet veren" bilgi sayfası** (N6/N7) | Marka/arz sorguları; mevcut SSS 6 soru | 1 sayfa + SSS | Özgün, ürün kurallarıyla tutarlı (kredi, iade, moderasyon) |
| Gün 90+ | **K7. Şehir × kategori aday değerlendirmesi** | Yalnız §4.2 eşiği sağlanırsa | 0 aday (bugün) | §4.2 beş koşul |

Bu sırada **yeni route gerektirenler** (K2, K3, K6'nın bilgi sayfası) kod işidir; bu PR'da açılmaz (§7).
K1, K4, K5 mevcut alanlarla (`description`, `imageUrl`, kart `summary/scope/image`) **kodsuz**
başlayabilir; §5.2'deki çok bloklu yapı için alan gerekiyorsa o da §7'dedir.

### 5.2 Şablonlar

**Kategori sayfası (K1) — yalnız doldurulabilir alanlar**

| Öğe | Değer |
| --- | --- |
| Amaç | N1 sorgusunu sayfada karşılamak: "bu hizmet nedir, nasıl talep açılır, seçerken ne bakılır" |
| Zorunlu özgün alanlar | (1) **Hizmet açıklaması**: ne kapsar / ne kapsamaz, 2 paragraf (`description`); (2) **Karar rehberi**: seçerken bakılacak 4–6 somut madde (belge, garanti, keşif, yedek parça, ustalık belgesi vb. — kategoriye özgü); (3) **Fiyatı etkileyen etmenler**: rakam **vermeden** değişkenler (m², kat, marka, aciliyet, malzeme, mevsim); (4) **Sık sorular**: 4–6 soru, ürün kurallarıyla tutarlı (14 gün geçerlilik, iletişim paylaşımı, ücretsiz teklif); (5) **Güvenli kapsam/sınırlar**: platformun yapmadığı şeyler (fiyat garantisi yok, işi platform yapmaz, acil durum yönlendirmesi) |
| Yasak | Uydurma fiyat/aralık, "%X memnuniyet", "N hizmet veren", yorum alıntısı, bölge iddiası, "en iyi/en ucuz" |
| Ana CTA | Mevcut talep formu (sayfada) — "Teklif almak ücretsiz" |
| İç link kaynak → hedef | Ana sayfa kategori kartı → bu sayfa; `/categories` → bu sayfa; rehber (K3) → bu sayfa; işletme profili kategori etiketi → bu sayfa (kod §7). Bu sayfadan → ilgili rehber, → `/vitrin` (kategoride canlı kart varsa; kod §7), → `/categories` |
| Güncelleme sahibi | Operasyon/kategori sahibi (admin kategori düzenleme); 6 ayda bir gözden geçirme; `updatedAt` sitemap `lastmod`'unu otomatik besler (yalnız gerçek içerik değişince kaydet) |
| Bugün doldurulabilir mi? | `description` evet (admin). (2)–(5) için ayrı alan/bileşen yok → §7 |

**Kategori rehberi (K3)**

| Öğe | Değer |
| --- | --- |
| Amaç | N5 bilgi niyeti; kategori sayfasına nitelikli trafik |
| Zorunlu özgün alanlar | Başlık (soru formunda), yazar/ekip + yayın ve güncelleme tarihi (görünür), 600+ kelime ilk elden bilgi (moderasyon/operasyon deneyimi, sık görülen talep kalıpları — kişisel veri yok), "Ne zaman profesyonel gerekir" bölümü, kategoriye özgü kontrol listesi, en az 1 görsel/diyagram (özgün), "Talep açmadan önce hazırlayın" listesi |
| Yasak | Fiyat rakamı, yorum/başarı oranı, sağlayıcı sayısı, şehir varyantı üretme (aynı rehberin "İstanbul" kopyası **yasak**) |
| Ana CTA | İlgili kategori sayfasına "Teklif al" |
| İç link | ← kategori sayfası, ← ana sayfa "rehberler" bloğu (varsa); → kategori sayfası, → ilgili 1–2 rehber |
| Güncelleme sahibi | İçerik sahibi; 12 ayda bir; tarih görünür güncellenir |
| Route | Yok — §7 backlog (örn. `/rehber/<slug>`; kesin URL kod aşamasında) |

**Yardım/güven sayfaları (K2)**: amaç güven ve yasal uyum; içerik hukuk sahibinden; footer'dan link;
indexable; `Organization` şemasına iletişim eklenmesi ancak sayfada görünür gerçek iletişim varsa (§2 SD
policies).

**İşletme profili (K4)** ve **vitrin kartı (K5)** için içerik sağlayıcıya aittir; platform yalnız
**kılavuz + kontrol listesi** verir (§5.3) ve panelde eksikleri gösterir (kod §7).

### 5.3 Minimum "indexable profile" kontrol listesi (işletme profili ve vitrin kartı)

Eksikse **noindex** yerine önce **hangi ürün verisi gerekli** yazılır; noindex, alan var ama boş
kaldığında uygulanır (kod §7).

| # | Şart | Veri alanı (var mı?) | Eksikse ürün gereksinimi |
| --- | --- | --- | --- |
| P1 | `businessName` gerçek işletme adı (test/placeholder değil) | var | Moderasyon kuralı (zaten APPROVED kapısı) |
| P2 | `description` ≥ 300 karakter (başlangıç önerisi), özgün, iletişim içermiyor (`seoText` zaten düşürüyor) | var (`ProviderProfile.description`), 0/3 dolu | Panelde "profil doluluğu" göstergesi + zorunlu alan yapma kararı (ürün) |
| P3 | ≥ 1 ACTIVE kategori bağı | var | — |
| P4 | ≥ 1 hizmet bölgesi | var | — |
| P5 | Kategori etiketleri kategori sayfasına link | **kod yok** | §7 iç link işi |
| P6 | Görsel (logo/kapak) | **alan yok** (`ProviderProfile`'da görsel alanı bulunmuyor) | Ürün: işletme görseli alanı + moderasyon (SEO'dan önce ürün kararı) |
| P7 | Public puan özeti eşik üstü **ya da** sayfada başka özgün içerik (P2) | var (eşikli) | — (puan zorunlu değil; JSON-LD'ye girmez) |
| P8 | Vitrin kartı için: `summary` ≥ 200, `scopeIncluded` ≥ 3, `scopeExcluded` ≥ 1, `imageUrl` var, aynı sağlayıcının diğer kartıyla birebir değil | alanlar var | Kart oluşturma ekranında yazım kılavuzu + minimumlar (ürün kararı) |

Kural: P1–P4 sağlanıyor ama P2 boşsa sayfa bugün "ad + il/ilçe + etiket"tir → indeksten değer beklenmez;
§7 "koşullu noindex" kod işi bunu meta ile kapatır (robots.txt ile değil — noindex görülmeli).

### 5.4 İç link haritası

Yalnız public, temiz path'ler. Private, teklif, talep, filtre (`?q`, `?il`, `?cursor`, `?step`) URL'lerine
SEO amaçlı link **önerilmez**.

| Kaynak | Hedef | Bugün | Öneri |
| --- | --- | --- | --- |
| `/` | `/categories` | ✔ (header, hero, footer-col) | kalsın |
| `/` | `/categories/<slug>` (10 kategori kartı) | ✔ | kalsın; başlık `name` (Türkçe karakter düzeltmesi içerikle) |
| `/` | `/vitrin`, `/vitrin/<cardId>` (raf) | ✔ | raf eşik altındayken (§4.1) rafın ana sayfada görünmesi ürün kararı; SEO açısından zararsız |
| `/` | rehberler (K3) | yok | "Rehberler" bloğu (kod §7) |
| `/` | yardım/güven sayfaları | footer `#` | gerçek linkler (K2) |
| `/categories` | `/categories/<slug>` | ✔ | kalsın |
| `/categories` "Popüler aramalar" | `?q=` (noindex) | ✔ | doğrudan `/categories/<slug>`'a çevirme (kod §7, düşük öncelik) |
| `/categories/<slug>` | ilgili rehber | yok | K3 ile (kod §7) |
| `/categories/<slug>` | `/vitrin` (o kategoride canlı kart varsa) | yok | kod §7; boşsa link yok |
| `/isletme/<id>` | `/categories/<slug>` (hizmet etiketleri) | **yok** (etiket) | P5 — link yap (kod §7) |
| `/isletme/<id>` | `/vitrin/<cardId>` (işletmenin canlı kartları) | yok | kod §7 (public projeksiyona kart listesi gerek; ürün kararı) |
| `/isletme/<id>` breadcrumb | Ana sayfa / **Kategori** / İşletme | Ana sayfa / İşletme | çok kategorili işletmede breadcrumb'a kategori konmaz; bunun yerine etiket linkleri (P5) |
| `/vitrin` | `/vitrin/<cardId>` | ✔ | kalsın |
| `/vitrin/<cardId>` | `/isletme/<id>` | ✔ | kalsın |
| `/vitrin/<cardId>` | `/categories/<slug>` (kicker) | **yok** | link yap (kod §7) |
| rehber (K3) | `/categories/<slug>` | — | zorunlu |
| her sayfa | `/sozlesmeler/*` | form içinden | kalsın (noindex, follow) |

---

## 6. Ölçüm ve operasyon

### 6.1 Search Console kurulunca — minimal ölçüm planı

Bu PR kurmaz; operatör adımları SEO-001 §8 ile birlikte uygulanır (`APP_ENVIRONMENT=production` +
`WEB_APP_URL`, edge `X-Robots-Tag` yok).

| Adım | Ne | Kabul |
| --- | --- | --- |
| 1 | Domain property (tüm protokol/alt alan) doğrulama | Property "verified" |
| 2 | `/sitemap.xml` gönderimi | Sitemaps raporunda "Success", keşfedilen URL sayısı = beklenen (yerel eşdeğeri 15) |
| 3 | Pages (Page indexing) raporu: "Submitted and indexed" vs "Excluded by noindex" / "Crawled – currently not indexed" / "Duplicate without user-selected canonical" / "Alternate page with proper canonical tag" | Sitemap'teki her URL indexed; `?q/?il/?cursor/?step` yalnız "noindex" altında; "Duplicate" sınıfı **0** (canonical standardı) |
| 4 | Performance: Search type = Web; boyutlar Query / Page / Country (TR) / Device; sayfa grupları için regex: `^/categories/`, `^/isletme/`, `^/vitrin/`, `^/$`; sorgu grupları: marka (`taktic|taktick`), bölge (il/ilçe adları regex'i), bilgi (`nasıl|ne zaman|fiyat|seç`) | Haftalık dışa aktarma; hacim **bu rapordan** okunur, tahmin edilmez |
| 5 | Dönüşüm olayları (ürün analitiği; SC dışı): `request_submitted` (kaynak sayfa path), `showcase_lead_sent`, `provider_register_started`, `guide_to_category_click`, `profile_category_click` | Organik oturum → olay oranı sayfa sınıfı bazında |
| 6 | Rich results / URL Inspection: allowlist'teki 1'er örnek sayfa için "Page is indexed", canonical = beyan edilen | Google-selected canonical == user-declared |
| 7 | Haftalık kontrol listesi | (a) Pages raporunda yeni "Excluded/Error" var mı; (b) sitemap URL sayısı ↔ `GET /sitemap/entries` sayısı; (c) "Crawled – not indexed" artışı → ince sayfa şüphesi → §5.3/§4.1 kriteri; (d) marka sorgu yazım dağılımı; (e) bölge sorguları alan kategori×il çiftleri → §4.2 aday listesi; (f) Core Web Vitals/HTTPS raporunda yeni uyarı; (g) manuel işlem/güvenlik raporu boş |

### 6.2 30/60/90 gün başarı ölçümleri (hedef sayı yok)

| Gün | Ölçüm | Nasıl okunur |
| --- | --- | --- |
| 30 | Sitemap'teki tüm URL'ler indexed; "Duplicate" 0; K1 kategori sayfalarının §4.1 kriterini karşılama oranı (x/7); K2 sayfaları yayında | Teknik taban + ilk içerik tamam mı |
| 60 | Kategori sayfaları için impressions ve ortalama pozisyon **trendi** (mutlak değil, haftalık seri); N5 rehberlerin indekslenmesi; rehber→kategori tıklama olayı > 0; profil doluluğu (P2) oranı | İçerik keşfediliyor mu, iç link akıyor mu |
| 90 | Organik oturum → talep açma dönüşümü sayfa sınıfı bazında; "Crawled – not indexed" oranı düşüyor mu; N2 bölge sorgularının hangi çiftlerde gösterim aldığı (§4.2 aday girdisi); eşik revizyonu | Şehir×kategori kararının veriyle yeniden değerlendirilmesi |

### 6.3 İçerik yayın süreci, kalite kontrolü, güncelleme, kaldırma/redirect

**Yayın süreci (K1–K6)**: (1) brief (niyet, hedef sorgu kalıbı, kaynak sayfa, CTA) → (2) taslak (şablon
zorunlu alanları) → (3) kalite kontrol → (4) yayın (kategori için admin `description`/görsel; rehber için
kod route'u geldikten sonra içerik) → (5) 7. gün URL Inspection → (6) 30. gün performans notu.

**Kalite kontrol listesi**: özgün mü (kopya/şablon değil, şehir adı değiştirilmiş kopya değil); ürün
kuralı dışı iddia yok (fiyat rakamı, puan, hizmet veren sayısı, başarı oranı, "en iyi"); iletişim bilgisi
yok; Türkçe karakter ve yazım; yazar/tarih görünür (rehber); iç link kaynak+hedef mevcut; metadata
`seoText` fallback'e düşmüyor (açıklama iletişim tespitine takılmıyor); JSON-LD sayfada görünen içerikle
tutarlı.

**Eski içerik güncelleme**: kategori/rehber 6–12 ayda; ürün kuralı değişince (kredi, iade, geçerlilik
süresi) ilgili SSS aynı PR/aynı gün; `updatedAt` yalnız gerçek içerik değişiminde (sitemap `lastmod`
güvenilirliği — §2).

**İndeks kaldırma / redirect karar ağacı**

```
Sayfa hâlâ var ve içerik doğru mu?
├─ Evet, ama §4.1/§5.3 kriterini karşılamıyor → noindex, follow (meta); robots.txt'e ekleme; sitemap'ten çıkar
├─ Evet, kriteri karşılıyor → indekste kal; içerik güncelle
└─ Hayır (kategori INACTIVE, işletme SUSPENDED/REJECTED, placement bitti)
   ├─ Birebir eşdeğer sayfa var mı (aynı niyet, aynı içerik; örn. slug değişimi, kart yeni sürüm aynı URL)?
   │   ├─ Evet → 301 eşdeğere (yalnız gerçek eşdeğer; kategori sayfasına "toplama" redirect'i YOK — doorway sinyali)
   │   └─ Hayır → 404/410 (bugünkü davranış: API 404 → sayfa notFound); sitemap otomatik düşer (no-store)
   └─ Yasal/kişisel veri talebi → 404/410 + Search Console Removals (geçici) 
```

---

## 7. SEO-001 temas noktaları ve kod backlog'u (bu aşamada uygulanmaz)

Sıra = önerilen öncelik. Hiçbiri bu PR'da yapılmaz; her biri ayrı PR ve SEO-001 test sözleşmesine
(`seo-routes.spec` allowlist, `seo-metadata.spec`, E2E `seo-indexing`) tabi.

| # | İş | SEO-001 temas noktası | Not |
| --- | --- | --- | --- |
| B1 | **Arz/içerik envanteri raporu** (salt-okunur sorgu ya da admin raporu): kategori × il/ilçe APPROVED sağlayıcı sayısı, profil doluluğu (P2), kart doluluğu | yok (API/admin) | §4.2 aday listesi ve §5.3 kampanyası için ön koşul; production sayıları bugün bilinmiyor |
| B2 | **Koşullu noindex**: kategori (§4.1 kriteri), işletme profili (P2 boş), vitrin rafı (< eşik), vitrin kartı (P8) → `publicPageMetadata`'ya `thin` bayrağı; sitemap `GET /sitemap/entries` aynı predicate'i uygular | `seo-metadata.ts`, `seo-routes.ts`, `apps/api/src/modules/sitemap/` (predicate tek yerde) | Meta noindex, robots.txt değil (§2). Production açılmadan önce |
| B3 | **İç linkler**: profil kategori etiketleri → `/categories/<slug>`; vitrin kartı kicker → kategori; kategori sayfası → `/vitrin` (kategoride canlı kart varsa) | görünür kopya değişmez, yalnız `<a>` | P5, §5.4 |
| B4 | **Kategori sayfası içerik blokları**: karar rehberi / fiyat etmenleri / SSS / sınırlar için alan(lar) (ServiceCategory'de yeni alan **ya da** ayrı içerik modeli) + admin düzenleme + sayfada render; `FAQPage` JSON-LD ancak SSS sayfada görünürse | JSON-LD test anahtar tarama kuralı (fiyat/puan yok) | Migration gerektirir → ayrı tasarım notu |
| B5 | **Rehber route'u** (örn. `/rehber/<slug>`; içerik kaynağı: DB modeli ya da repo-içi MDX — karar tasarım aşamasında) + allowlist'e ekleme + sitemap satırı (`updatedAt`) + `Article` JSON-LD (yazar/tarih sayfada görünür) | `INDEXABLE_ROUTES`, sitemap entries, E2E allowlist testleri | K3 için ön koşul |
| B6 | **Yardım/güven sayfaları** (`/kvkk`, `/gizlilik`, `/kullanim-sartlari`, "nasıl çalışır") + footer linkleri + allowlist | `INDEXABLE_ROUTES` (indexable) ya da `NOINDEX_CRAWLABLE_ROUTES` (hukuk kararı) | K2; metin hukuk sahibinden |
| B7 | **Marka yazımı tek kaynak**: `SEO_DEFAULT_TITLE/DESCRIPTION`, footer ©, `TAKTIC_APP_NAME`, e-posta şablonları → tek yazım (ürün kararı sonrası) | `seo-metadata.spec` (kök title aynen kuralı gevşetilir) | N6 |
| B8 | **Kategori adlarında Türkçe karakter** (7 aktif kategori `name`/`description`; slug **değişmez** — slug değişimi URL kırar) | title/H1/JSON-LD `name` | İçerik/veri işi; admin'den yapılabilir, kod gerekmeyebilir |
| B9 | **Profil görsel alanı** (P6) — ürün kararı; OG image için de gerekli | `publicPageMetadata.image` | SEO-001 "OG görselleri" bırakılanı |
| B10 | **Vitrin `lastmod`**: placement `startAt`/sürüm `publishedAt` public projeksiyona | sitemap entries | yalnız doğrulanabilir tarih; aksi halde bugünkü "yok" doğru |
| B11 | `/categories` "Popüler aramalar" → doğrudan kategori linkleri | — | düşük öncelik |
| B12 | **Şehir×kategori route'u** — yalnız §4.2 beş koşul + B1 verisiyle; statik path, elle açılan liste, boşta rota yok | allowlist, sitemap, E2E | **Bugün açılmaz** |
| B13 | **Uzaktan/dijital hizmet ürün kararı** (`ProviderServiceArea` kapsamı / kategori bayrağı) | — | SEO değil, ürün; §1.4 |
| B14 | `LocalBusiness` şemasının tam adres gerektirmesi: adres toplanmayacaksa `Organization`/`ProfessionalService` ile sınırlı beyan; puan/telefon yine yok | `seo-json-ld.ts` + spec | Rich result vaat edilmez |
| B15 | Sözleşme sayfası indeks kararı: **noindex, follow kalsın** (§4.1) — kod işi yok | `NOINDEX_CRAWLABLE_ROUTES` | Kapatıldı |

---

## 8. Değişmeyenler

Üretim route'ları, metadata, `robots.ts`/`sitemap.ts`, `seo-*.ts` modülleri, API, Prisma/DB/migration,
gerçek `.env`, Cloudflare, Search Console, deploy, yerel/staging container'lar, görünür kopya (marka
yazımı dahil), Turnstile sözleşmesi. Bu PR yalnız `docs/superpowers/` altına iki dosya ekler.
