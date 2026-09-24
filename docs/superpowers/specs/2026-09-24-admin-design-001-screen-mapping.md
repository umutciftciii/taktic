# ADMIN-DESIGN-001 / Faz 0 — Admin yüzeyi ↔ tasarım referansı ekran eşlemesi

- **Tarih:** 2026-09-24
- **Taban:** `main@1bda65da`
- **Kapsam:** yalnız analiz. Bu belge ve eşlik eden uygulama planı (`docs/superpowers/plans/2026-09-24-admin-design-001-implementation-plan.md`) dışında hiçbir dosya değişmedi.
- **Tasarım kaynağı:** kullanıcının verdiği `Taktick Tasarım Projesi (1).zip` (1.290.790 bayt, 34 dosya). Arşiv salt-okunur incelendi ve depoya **kopyalanmadı**. Bu belgede yalnız dosya adları, token değerleri ve ekran/sütun adları geçer.

Etiketler:
- **[DOĞRULANDI]** kaynağı okuyarak teyit edildi.
- **[KOD-OKUMA]** mantık okumayla çıkarıldı, çalıştırılarak denenmedi.

---

## 1. Tasarım arşivi envanteri

### 1.1 Dosyalar

| Dosya | Boyut | Ne |
| --- | --- | --- |
| `design_handoff_taktick_admin/README.md` | 36.531 | Handoff: token'lar, kabuk, 30 ekranın düzeni, etkileşim ve durum eşlemesi, uygulama sırası önerisi |
| `design_handoff_taktick_admin/github.md` | 3.519 | Ekran ↔ repo dosyası eşlemesi, son senkron `2026-09-22T15:12:15Z` (`main`) |
| `design/TakTick Admin Paneli.dc.html` | 293.047 | Tek dosyalık prototip. Ekranlar `state.screen` ile değişir; veriler `renderVals()` içinde temsilidir |
| `design/support.js` | 69.150 | Prototip çalışma zamanı. **Üretime taşınmaz** |
| `design/_ds/modernist-…/styles.css` | 10.555 | Modernist tasarım sistemi token'ları ve bileşen sınıfları |
| `design/_ds/modernist-…/_ds_bundle.js` | 303 | Boş paket (sistem yalnız stil) |
| `design/assets/mark-white.png` | 136.508 | Beyaz TakTick markası. Her zaman `#ec3013` karo üstünde kullanılır |
| `screenshots/01…27-*.png` | 24–46 KB | 27 referans görüntü. Dar önizleme genişliğinde alınmış; README'ye göre **ölçü kaynağı değil** |

Dış bağımlılıklar:
- **Google Fonts:** Archivo 400/500/600/700/800.
- **Lucide ikonları:** prototipte inline `path` olarak gömülü. Lisansı ISC; paket olarak eklenirse lisans uyumlu.
- Başka CDN veya görsel yok. Panelde içerik fotoğrafı bulunmuyor.

### 1.2 Tasarım token'ları (mevcut `apps/admin/app/globals.css` ile karşılaştırma)

| Konu | Tasarım (Modernist) | Mevcut admin |
| --- | --- | --- |
| Zemin / yüzey | `#f3f2f2` / `#ffffff` | `--bg #f8fafc` / `--surface #fff` |
| Metin | `#201e1d` | `--text #0f172a` |
| Aksan | `#ec3013` (hover `#dd2b0f`, metin `#ae1800`, açık `#fff2ef`) | `--primary #2563eb` (mavi) |
| Nötr rampa | 100–900 (`#f8f4f4` … `#2d2b2b`) | Yok. Tek tek hex değerler |
| Durum renkleri | başarı `#0f6b45/#e3f0e8`, uyarı `#8a5a00/#fbf0d8`, hata `#ae1800/#ffe0d9` | `--success #16a34a`, `--warning #f59e0b`, `--error #dc2626` |
| Köşe yarıçapı | **Her yerde 0** | 6/8/10/12/14/999px (serbest) |
| Gölge | `sm/md/lg` üç kademe | Tek `--shadow` |
| Font | Archivo (web font) | Sistem fontu, `@font-face` yok |
| Başlık | h1 28px/800, −0.02em (dashboard 30, detay 27) | `clamp(28px,4vw,38px)` |
| Tablo başlığı | 11px/700/uppercase/.07em, 2px mürekkep alt çizgi | Farklı |
| Odak | `2px solid #ec3013`, offset 2px | Tarayıcı varsayılanı ve karışık |
| Karanlık tema | Yok ("tek tema") | Yok. **Çelişki yok** |
| `lang="tr"` | Zorunlu | Var (`app/layout.tsx:38`) [DOĞRULANDI] |
| Menü genişliği | 256px tam / 64px ikon modu | 260px, ikon modu yok |
| Üst bar | 56px: kırıntı + 320px arama + bildirim zili + Çıkış | Hamburger + bağlam başlığı + Çıkış. Arama ve zil yok |
| Mobil | <1024px mevcut drawer korunur | Drawer `(min-width:1024px)` eşiğinde [DOĞRULANDI]. **Uyumlu** |
| İçerik genişliği | `max-width:1760px` (form ekranlarında 1180–1500), dolgu `28px 24px 64px` | `min(1180px, 100%-32px)` |

### 1.3 Tasarımdaki yapı taşları

- **Kabuk:**
  - Sol menü: 8 grup ve genel görünüm satırı. Gruplar açılıp kapanır, ikon moduna daralır, grup ve satırlarda sayaç rozeti vardır. Altta kullanıcı bloğu bulunur ("Tam yetkili yönetici").
  - Üst bar: kırıntı, global arama, bildirim zili, Çıkış.
- **Sayfa başlığı:** h1, yanında ⓘ popover, özet satırı, sağda birincil ve ikincil eylemler.
- **ⓘ bilgi popover'ı:** sağ açıklama sütununun yerini alır. Aynı anda tek popover açıktır; Esc ve dışına tıklamayla kapanır, `aria-expanded` taşır.
- **Liste şablonu (15–22 numaralı ekranlar):**
  - Kayıtlı görünüm sekmeleri, içlerinde sayaç.
  - Filtre çubuğu (Ara · Durum · Tarih · alan filtreleri).
  - Tam genişlik tablo; son sütunda "Aç".
  - Sayfalama: "N kaydın a–b arası" + Önceki/Sonraki.
- **Detay şablonu:**
  - Geri bağlantısı.
  - Özet kartı: durum rozetleri, künye, 27px başlık, eylemler.
  - Özet şeridi (`auto-fit minmax(170px)`).
  - Sekmeler, URL'de `?tab=`.
  - Kartlar ve etiket/değer satırları; "Neler oldu" zaman çizelgesi.
- **Form:**
  - 12.5px/700 etiket, 1px `#bab6b6` kenarlı alanlar.
  - Toggle 52×28, `role="switch"`.
  - Yapışkan kayıt çubuğu (kirli durum göstergesi ve ayrılırken uyarı).
- **Modal:** 660–720px, `aria-modal`, odak tuzağı, Esc.
- **Yıkıcı işlemler:** onay istenir ve sonuç önceden yazılır.
- **Rozetler:** nötr, başarı, uyarı ve hata çiftleri.
- **KPI kartı:** sparkline'lı. Çubuk grafik: "Son 7 gün", "Aylık kredi satışı".
- **Durumlar:** boş durum için mevcut `EmptyState` korunur, metni "ne zaman dolacağını" söyler. Tasarımda **yüklenme, hata, 403 ve 404 ekranı yok** (bkz. §4.2).
- **Kimlik doğrulama (6 hâl):** giriş, oturum sonlandı, hatalı giriş, davet ile şifre belirleme, geçersiz bağlantı, şifre oluşturuldu.

### 1.4 Tasarım ekran kataloğu (prototip anahtarları)

| # | Prototip anahtarı | Ekran | Tasarımdaki route |
| --- | --- | --- | --- |
| 1 | `dashboard` | Genel görünüm | `/` |
| 2 | `requests` | Talepler | `/requests` |
| 3 | `requestDetail` | Talep detayı (4 sekme) | `/requests/[id]` |
| 4 | `providers` | Hizmet verenler | `/providers` |
| 5 | `providerDetail` | Hizmet veren detayı (3 sekme) | `/providers/[id]` |
| 6 | `offers` | Teklifler | `/offers` |
| 7 | `offerDetail` | Teklif detayı + işlemler (4 sekme) | `/offers/[id]` |
| 8 | `customerDetail` | Hizmet alan detayı (4 sekme) | `/customers/[id]` |
| 9 | `finance` | Finans özeti | `/finance` |
| 10 | `settings` | Operasyon ayarları | `/operations-settings` |
| 11 | `campaigns` | Kampanyalar | `/campaigns` |
| 12 | `manual` | Elle kredi ekle / düş | `/finance/manual-adjustments` |
| 13 | `refund` | İade kontrolü | `/refund-scan` |
| 14 | `company` | Şirket ve e-posta bilgileri | `/company-settings` |
| 15 | `list:complaints` | Şikayet edilen talepler | `/requests/reports` |
| 16 | `list:matches` | Eşleşmeler | **yok** (`/offers` görünümü önerisi) |
| 17 | `list:customers` | Hizmet alanlar | `/customers` |
| 18 | `list:support` | Destek talepleri | `/support` |
| 19 | `list:ledger` | Kredi hareketleri | `/finance/credit-ledger` |
| 20 | `list:balances` | İşletme bakiyeleri | `/finance/providers` |
| 21 | `list:purchases` | Paket satışları | `/package-purchases` |
| 22 | `list:cardReviews` | Onay bekleyen kartlar | `/showcase/reviews` |
| 23 | `list:placements` | Yayında olan kartlar | `/showcase/placements` |
| 24 | `list:leads` | Vitrinden gelen talepler | `/showcase/leads` |
| 25 | `list:reviewReports` | Şikayet edilen yorumlar | `/provider-reviews/reports` |
| 26 | `list:categories` | Hizmet kategorileri | `/categories` |
| 27 | `list:showcasePackages` | Vitrin paketleri | `/showcase/packages` |
| 28 | `list:creditPackages` | Kredi paketleri | `/credit-packages` |
| 29 | `list:notifications` | Gönderilen bildirimler | `/notifications` |
| 30 | `list:admins` | Yönetici hesapları | `/users` |
| 31 | `seoOverview` | Arama motoru durumu | **yeni** |
| 32 | `list:seoIndex` | İndekslenmeyen sayfalar | **yeni** |
| 33 | `slugs` (+ modal) | Adres (slug) yönetimi | **yeni** |
| 34 | `redirects` (+ modal) | Yönlendirmeler (301/302) | **yeni** |
| 35 | `login` ×6 hâl | Giriş / oturum sonlandı / hatalı / davet / geçersiz / tamamlandı | `/login`, `/admin-invite` |
| — | `soon` | "Sırada" yer tutucusu. Destek, vitrin, katalog, bildirim ve yönetici detaylarının **tasarlanmadığını** gösterir | — |

Özet:
- **34 içerik ekranı** (17 özel + 17 ortak liste düzeni).
- **6 kimlik doğrulama hâli** ve **2 modal**.
- **1 yer tutucu** (`soon`): 11 liste ekranının "Aç" eylemi buraya düşüyor. Bu ekranların detay sayfası tasarımda yok.

---

## 2. Mevcut admin envanteri

### 2.1 Sayısal özet

| Kalem | Adet |
| --- | --- |
| `page.tsx` route | **55**: 52 oturumlu ekran + `/login`, `/admin-invite`, `/yetkisiz` |
| Route handler (`route.ts`) | 5: `/login/submit`, `/admin-invite/submit`, `/logout`, `/api/session`, `/api/uploads/category-image` |
| `actions.ts` (server action dosyası) | 21 (+ `providers/[id]/registration-actions.ts`) |
| Kök sınırlar | `app/error.tsx`, `app/global-error.tsx`, `app/not-found.tsx`. **Hiçbir yerde `loading.tsx` yok** |
| Menü satırı (`lib/nav.ts`) | 29 satır, 5 grup: Genel, Operasyon, Katalog, Finans, Yönetim |
| Menüde olmayan ekran | `/showcase/cards`, `/showcase/price-terms`, tüm `[id]`/`new` alt route'ları |
| `AdminPermission` değeri | **82** (`prisma/schema.prisma`) |
| API rota-izin haritası | 121 satır `ADMIN_ROUTE_PERMISSIONS` + 10 `ROOT_ONLY_ROUTES` (`apps/api/src/modules/auth/route-permission-map.ts`) |
| Admin'de `requireAdmin(...)` çağrısı | 52. Hepsi yalnız **okuma** izni ister; `/categories/new` ve `/campaigns/new` yazma iznini de ister |
| Admin'de işlem düzeyi `can()` kapısı | **5**. `providers/[id]` 4 tane, `operations-settings` 1 tane (`CAMPAIGN_ENGINE_TOGGLE`) [DOĞRULANDI] |
| Admin UI'da hiç anılmayan izin | **49 / 82** (listesi §5.1'de) [DOĞRULANDI] |

### 2.2 RBAC sözleşmesi (bugünkü hâli) [DOĞRULANDI]

- **Tek kaynak `GET /admin/me/permissions`.**
  - `requireAdmin` (`lib/api.ts:2107`) ve menü filtresi (`app/layout.tsx` → `readAdminAccess` → `filterNavGroups`) aynı yanıtı okur.
  - Süper admin için yanıt tüm kataloğu açılmış olarak döner; kök yetkiler `isSuperAdmin` bayrağıyla gelir.
- **Reddetme yolları:**
  - Personel değil → `/login`.
  - Personel ama izni eksik → `/yetkisiz`.
  - `apiFetch` sonuçları: 401 → `/login`; 403 `NOT_STAFF` → `/login`; diğer 403 → `/yetkisiz`; 404/400 → `fetchOrNotFound` ile `notFound()`.
- **Menü satır izinleri** ilgili sayfanın `requireAdmin` iznine bire bir eşit. Tek istisna `/roles` (`superAdminOnly`, sayfa `requireAdmin()`).
- **Server action'lar izin kontrol etmez.** Tüm yazma yetkisi API guard'ına dayanır. UI'da düğme görünür, tıklanınca 403 gelir ve `/yetkisiz`'e düşülür. Kimi yerlerde bu yönlendirme `catch` içinde yutulur (bkz. §5.2).

### 2.3 Route envanteri

Kısaltmalar: **P** = sayfa kapısı (`requireAdmin`), **R** = okunan API, **W** = yazan server action → API → gerekli izin, **UI** = başlıca öğeler, **Durum** = boş/hata/404 davranışı.

Ortak davranışlar (her satırda tekrarlanmaz):
- Yüklenme göstergesi yok; sayfa sunucuda bloklayarak render edilir.
- Hata → kök `app/error.tsx` ("Bir şeyler ters gitti", digest, "Tekrar dene").
- 403 → `/yetkisiz`.
- Tablolar `.table-scroll` ile yatay kayar.
- Onay diyaloğu yok. Tek istisnalar `ModerationDialog` (hizmet veren durumu) ile kampanya motoru ve rol pasifleştirmedeki onay kutusu.

#### Genel

| URL | Ekran | P | R | W | UI / Durum |
| --- | --- | --- | --- | --- | --- |
| `/` | Dashboard "TakTic Admin" | `DASHBOARD_READ` | `GET /dashboard/admin-summary` | — | Bkz. not |

`/` notu:
- 10 `StatCard` (`lib/dashboard-metrics.ts`): toplam, bekleyen ve incelemedeki talep; onaylı ve bekleyen hizmet veren; teklif; iade adayı; paket talebi; açık destek; açık talep bildirimi.
- 8 "Hızlı işlemler" bağlantısı.
- Vitrin kuyruk sayacı **yok**; özette alanı da yok.
- Uyarı rozeti yalnız eylem kartında ve sayı 0'dan büyükken görünür.
- Boş durum yok.

#### Talepler ve teklifler

| URL | Ekran | P | R | W | UI / Durum |
| --- | --- | --- | --- | --- | --- |
| `/requests` | Talepler | `REQUESTS_READ` | `GET /service-requests` (tüm liste, sayfalama yok), `GET /admin/categories` | — | Bkz. not |
| `/requests/[id]` | "{Kategori} Talebi" | `REQUESTS_READ` | Bkz. not | Bkz. not | Bkz. not |
| `/requests/reports` | Talep bildirimleri | `REQUEST_REPORTS_READ` | `GET /service-requests/reports?state&cursor&limit=50` | — | Bkz. not |
| `/offers` | Teklifler | `OFFERS_READ` | `GET /offers?q&status&providerId&requestId&categorySlug&city&submittedFrom&submittedTo`, kategoriler | — | Bkz. not |
| `/offers/[id]` | İşletme adı | `OFFERS_READ` | `GET /offers/:id` | Bkz. not | Bkz. not |
| `/refund-scan` | İade Taraması | `OFFER_REFUND_SCAN_READ` | `GET /offers/refund-scan?limit` (sunucu + istemci) | İstemciden doğrudan `POST /offers/refund-scan/execute` (`OFFER_REFUND_EXECUTE`) | Bkz. not |

`/requests` notu:
- Filtreler sayfada, sunucu tarafında uygulanır: `q`, `status` (9 durum), `quality`, `category`, `city`, `from`, `to`.
- Sütunlar: No · Gönderim · Kategori · Müşteri (tel/e-posta açık) · Konum · Bütçe · Kalite · Durum + yaşam döngüsü notu · Teklif · İşlem.
- İki ayrı boş durum metni var.

`/requests/[id]`:
- **R:**
  - `GET /service-requests/:id` (404 destekli).
  - `/offers?requestId` (`OFFERS_READ`), `/service-requests/:id/reports` (`REQUEST_REPORTS_READ`), `/service-requests/:id/review` (**yalnız CUSTOMER/SUPER_ADMIN**), `/service-requests/:id/contact-reveal` (`CONTACT_REVEAL_READ`).
- **W:**
  - Durum `PATCH …/status` (`REQUESTS_STATUS`).
  - `POST …/complete` ve `…/cancel` (**CUSTOMER/SUPER_ADMIN rolü**).
  - `…/reports/resolve` (`REQUEST_REPORTS_RESOLVE`), `…/reopen` (`REQUESTS_REOPEN`), `…/recalculate-quality` (`REQUESTS_QUALITY_RECALC`).
- **UI:**
  - Durum Yönetimi: İncelemeye al, Onayla, Tamamlandı, İptal et, Reddet fold'u.
  - Eşleşme, iletişim paylaşım denetimi (değer göstermez), ilgili teklifler, kalite.
  - Özet (süre bitişi **planlanan**, 14 gün kod sabiti), Bildirimler (Uygun bulundu / Talebi kaldır / Geri aç).
  - Müşteri (tel/e-posta açık), konum, kalite kırılımı, dinamik yanıtlar, değerlendirme.
- **Durum:** 404 var. "7 gün uzat" **yok**.

`/requests/reports` notu:
- Sekmeler: Açık / Çözülen. Cursor sayfalama yalnız "Sonraki".
- Salt okunur; kararlar talep detayında verilir.
- İki ayrı boş durum.

`/offers` notu:
- 4 stat kartı; hizmet veren ve talep sabitleyici.
- Sütunlar: Teklif No · Talep · Gönderim · Hizmet Veren · Kategori · Müşteri (tel) · Konum · Fiyat · Kredi · Durum · İade sinyali · İşlem.
- `refundAction` filtresi sayfada uygulanır. Sayfalama yok.

`/offers/[id]`:
- **W:**
  - Durum `PATCH /offers/:id/status` (`OFFERS_STATUS`); ACCEPTED talebi eşleştirir ve diğer teklifleri kapatır.
  - `POST /offers/:id/refund-credit` (`OFFER_REFUND_MANUAL`, 6 sebep kodu + not).
- **UI:** özet, 6 adımlı zaman çizelgesi, Kredi ve İade, Hizmet Veren ve Müşteri iletişimi (açık), Durumu Güncelle, Kredi İadesi.
- **Durum:** `fetchOrNotFound` yok, bu yüzden bozuk id kök hata sınırına düşer. Tasarımdaki "teklifi kaldır / hatırlat / uyar / eşleşmeyi iptal et" **yok**.

`/refund-scan` notu:
- Limit alanı, 9 stat, Dry-run tablosu (ham id'ler) ve Çalıştırma sonucu tablosu.
- "Taramayı çalıştır" toplu ve geri alınamaz bir işlemdir; **onay yok**.
- İstemci çağrısında 401/403 yönlendirmesi çalışmaz; ham API gövdesi gösterilir.

#### Kişiler ve destek

| URL | Ekran | P | R | W | UI / Durum |
| --- | --- | --- | --- | --- | --- |
| `/customers` | Hizmet Alanlar | `CUSTOMERS_READ` | `GET /customers?page&pageSize&sortBy&sortDir&q&city&lastRequestFrom/To&customerOrigin` | — | Bkz. not |
| `/customers/[id]` | Ad / e-posta / telefon | `CUSTOMERS_READ` | `GET /customers/:id`, `GET /customers/:id/notes` (**`CUSTOMER_NOTES_READ`**) | `POST …/notes` (`CUSTOMER_NOTES_WRITE`), `PATCH …/status` (`CUSTOMERS_STATUS`), `POST …/activation-link` (`CUSTOMER_ACTIVATION_LINK_ISSUE`) | Bkz. not |
| `/support` | Destek Talepleri | `SUPPORT_READ` | `GET /admin/support/tickets?page&pageSize=25&status&requesterRole` | — | Bkz. not |
| `/support/[id]` | Konu | `SUPPORT_READ` | `GET /admin/support/tickets/:id` (404) | Bkz. not | Bkz. not |
| `/providers` | Hizmet Verenler | `PROVIDERS_READ` | `GET /providers?status&city&categoryId&ownership`, kategoriler | — | Bkz. not |
| `/providers/[id]` | İşletme adı | `PROVIDERS_READ_DETAIL` | Bkz. not | Bkz. not | Bkz. not |
| `/providers/[id]/credits` | Hizmet Veren Kredileri | `FINANCE_LEDGER_READ` | `GET /providers/:id/credits`, `…/entitlements` (**`ProviderAccessGuard`: yalnız SUPER_ADMIN veya sahibi**), `…/admin-detail` | `POST …/credits/grant` (`CREDITS_GRANT`), `…/deduct` (`CREDITS_DEDUCT`) | Bkz. not |

`/customers` notu:
- Sütunlar: Müşteri + tür · Telefon · E-posta · Doğrulama · Şehir · Talep · Teklif · Kabul · Son Talep · Kayıt · Durum · İşlem.
- Önceki/Sonraki sayfalama; anonim talep uyarısı.
- Tabloda alt kaydırma sınıfı yok, dar telefonda sayfa genişleyebilir.

`/customers/[id]` notu:
- Aktivasyon kartı yalnız otomatik oluşturulan hesapta görünür; üretilen URL 72 saat geçerli.
- Profil ve iletişim, Pasifleştir/Aktifleştir (onay yok), notlar, talep ve teklif tabloları.
- 404 var.

`/support` notu:
- Filtreler: Talep sahibi, Durum (sayaçlı). Sayfalama var.
- Sütunlar: Durum · Talep sahibi · Konu · Kim · Son hareket · Oluşturulma · Detay.
- Üç ayrı boş durum.

`/support/[id]`:
- **W:** `POST …/messages` ve `…/status` (`SUPPORT_WRITE`), iade isteği `POST /admin/package-refund-requests` (`PACKAGE_REFUND_REQUEST_CREATE`).
- **UI:** talep sahibi, paket/iade isteği açma, izinli durum geçişleri, yazışma zaman çizelgesi, yanıt alanı.
- **Durum:** hata kodları `?error=` ile döner.

`/providers` notu:
- `q` filtresi sayfada uygulanır; status, city, category ve ownership filtreleri var.
- Sütunlar: Oluşturulma · İşletme (maskeli kayıt no) · İletişim · Konum/bölgeler · Kategoriler · Durum · Sahiplik · Kredi · Açık teklif · Paket · İşlem.
- Sayfalama yok.

`/providers/[id]`:
- **R:**
  - `GET …/admin-detail` (404 destekli).
  - `can('PROVIDERS_READ')` ile hizmet kategorileri ve katalog.
  - `can('PROVIDER_REVIEWS_READ')` ile `/provider-reviews/by-provider/:id`.
  - `can('PROMOTION_ELIGIBILITY_REVIEW')` ile uygunluk kayıtları.
- **W:**
  - Durum `PATCH …/status` (`PROVIDERS_MODERATE`) `ModerationDialog` üzerinden.
  - Kategori ekle/kaldır (`PROVIDER_CATEGORIES_WRITE`).
  - Claim daveti (`PROVIDER_CLAIM_INVITE_ISSUE`).
  - Ham kayıt no (`PROVIDER_REGISTRATION_READ_SENSITIVE` + `PROMOTION_ELIGIBILITY_REVIEW` + `PROVIDERS_READ_DETAIL`).
- **UI:** 4 stat kartı; Profil, Hizmet kategorileri, Bölgeler, Sahiplik, İşletme kaydı (maskeli, talep üzerine ham), Durum bilgisi, Son teklifler, Promosyon uygunluğu, Değerlendirmeler, Son paket alımları.
- **Durum:** 404 var. Değerlendirme yüklenemezse ayrı mesaj gösterilir.

`/providers/[id]/credits` notu:
- İçerik: dönemsel paketler, işlem geçmişi (6 çip, arama, Önceki/Sonraki bakiye), manuel kredi formu (ekle/düş sekmeleri, bakiye önizlemesi, eksiye düşme engeli), denetim notu.
- `fetchOrNotFound` yok.

#### Vitrin ve değerlendirmeler

| URL | Ekran | P | R | W | UI / Durum |
| --- | --- | --- | --- | --- | --- |
| `/provider-reviews/reports` | Değerlendirme bildirimleri | `PROVIDER_REVIEWS_READ` | `GET /provider-reviews/reports?state&cursor&limit=50` | — | Açık/Çözülen sekmeleri, cursor sayfalama, salt okunur |
| `/provider-reviews/[reviewId]` | "{işletme} — değerlendirme" | `PROVIDER_REVIEWS_READ` | `GET /provider-reviews/:id` (404) | `…/moderate`, `…/reports/dismiss` (`PROVIDER_REVIEWS_MODERATE`) | Bkz. not |
| `/showcase/reviews` | Kart İncelemeleri | `SHOWCASE_REVIEW_READ` | `GET /admin/showcase/versions` | — | Sütunlar: Kart · İşletme · Tür · Hizmet bedeli · Bölge · Gönderim · Durum. Filtre ve sayfalama yok; "Tüm vitrin kartları" bağlantısı var |
| `/showcase/reviews/[versionId]` | Sürüm başlığı | `SHOWCASE_REVIEW_READ` | `GET …/versions/:id` (404) | `…/approve`, `…/reject` (`SHOWCASE_REVIEW_DECIDE`) | Bkz. not |
| `/showcase/cards` | Vitrin Kartları | `SHOWCASE_CARDS_READ` | `GET /admin/showcase/cards?status` | — | Bkz. not |
| `/showcase/leads` | Vitrin Talepleri | `SHOWCASE_LEADS_READ` | `GET /admin/showcase/leads?status&providerId` | — | 5 durum çipi. Kapatma veya serbest bırakma kasıtlı olarak yok. Müşteri iletişimi gösterilmez |
| `/showcase/packages` | Vitrin Paketleri | `SHOWCASE_PACKAGES_READ` | `GET /admin/showcase/packages` | `POST`/`PATCH /admin/showcase/packages` (`SHOWCASE_PACKAGES_WRITE`) | Liste + "Yeni paket" + paket başına satır içi düzenleme kartı. Slug `vitrin-…` ve değiştirilemez |
| `/showcase/price-terms` | Vitrin Metin Onayları | `SHOWCASE_TERMS_ACCEPTANCES_READ` | `GET …/price-terms-acceptances?providerId&cardId&termsVersion` | — | Bkz. not |
| `/showcase/placements` | Yayındaki Kartlar | `SHOWCASE_PLACEMENTS_READ` | `GET …/placements?status&providerId` | — | 5 durum çipi |
| `/showcase/placements/[placementId]` | Sürüm başlığı | `SHOWCASE_PLACEMENTS_READ` | `GET …/placements/:id` | Bkz. not | Bkz. not |

`/provider-reviews/[reviewId]` notu:
- Moderasyon işlemleri: yorumu kaldır, değerlendirmeyi kaldır, geri al. Kaldırmada sebep zorunlu ve müşteriye e-posta gider.
- Bildirimler ve moderasyon günlüğü görünür.

`/showcase/reviews/[versionId]` notu:
- İncelenen sürümle canlı sürüm yan yana karşılaştırılır.
- Yayın hakkı yoksa Onayla kapalı. Reddetmede not 10–1000 karakter.

`/showcase/cards` notu:
- **Menüde yok.** API'deki `suspend/unsuspend` (`SHOWCASE_CARDS_MODERATE`) **hiç kullanılmıyor**.
- `?cardId=` bağlantısı görmezden geliniyor.

`/showcase/price-terms` notu:
- **Menüde yok.** Yalnız ekleme yapılan (append-only) onay defteri; onaylayanın e-postası görünür.

`/showcase/placements/[placementId]`:
- **W:** `…/suspend`, `…/resume` (`SHOWCASE_PLACEMENTS_MODERATE`), `…/cancel` (`SHOWCASE_PLACEMENT_CANCEL`, geri alınamaz).
- **Durum:** `fetchOrNotFound` yok.

#### Finans

| URL | Ekran | P | R | W | UI / Durum |
| --- | --- | --- | --- | --- | --- |
| `/finance` | Finans | `FINANCE_READ` | `GET /finance/summary`, `/finance/analytics?from&to&groupBy` | — | Bkz. not |
| `/finance/credit-ledger` | Kredi Hareketleri | `FINANCE_LEDGER_READ` | `GET /finance/credit-ledger?page&pageSize=50&q&type&providerId&from&to` | — | Bkz. not |
| `/finance/manual-adjustments` | Manuel Kredi İşlemleri | **`FINANCE_READ`** | `GET /finance/credit-ledger?type=ADMIN_GRANT,ADMIN_DEDUCT` (**API `FINANCE_LEDGER_READ` ister**) | — | Bkz. not |
| `/finance/providers` | Provider Finans Bakiyeleri | `FINANCE_READ` | `GET /finance/providers?page&pageSize=25&sortBy&sortDir&q` | — | 11 sütun, 9 alanlı sıralama, 3 aksiyon bağlantısı, sayfalama |
| `/package-purchases` | "Paket Talepleri" (menüde "Paket Satın Almaları") | `PACKAGE_PURCHASES_READ` | `GET /package-purchases?status&providerId&packageId`, `GET /payments/config` (**`PAYMENTS_CONFIG_READ`**) | — | Bkz. not |
| `/package-purchases/[id]` | Paket adı | `PACKAGE_PURCHASES_READ` | `GET /package-purchases/:id` | PENDING durumdaysa `PATCH …/status` (`PACKAGE_PURCHASE_STATUS_WRITE`) | Bkz. not |
| `/package-refunds` | Paket İadeleri | `PACKAGE_REFUND_READ` | `GET /admin/package-refund-requests?page&pageSize=25&status` | — | Durum filtresi (sayaçlı), 8 sütun, sayfalama |
| `/package-refunds/[id]` | "İade isteği · {paket}" | `PACKAGE_REFUND_READ` | `GET …/:id` (404) | Bkz. not | Bkz. not |

`/finance` notu:
- Dönem seçici: 7g/30g/bu ay/bu yıl/özel + gruplama.
- Dönem özeti (5 kart), tahsilat trendi (SVG çizgi grafik + 3 içgörü), paket satışları, kredi kullanımı, operasyonel müdahale, tahsilat, kredi hareketleri, paket durum kartları, son kredi hareketleri ve son paket alımları tabloları, hızlı bağlantılar.
- "Satılan kredi nereye gitti" kırılımı **yok**; API bu kırılımı döndürmüyor.

`/finance/credit-ledger` notu:
- 9 işlem tipi (kampanya türleri dahil).
- Sütunlar: Tarih · HV · Tip · Kredi · Önceki · Sonraki · Sebep · İlişkili · Yapan.
- Sayfalama var.

`/finance/manual-adjustments` notu:
- Yalnız liste; **form yok**. Form `/providers/[id]/credits` içinde.
- "Audit notu" kartı var.

`/package-purchases` notu:
- Ödeme sağlayıcı kartı, manuel inceleme uyarısı, 9 sütunlu tablo.
- Filtre yalnız query ile verilir; sayfalama yok.

`/package-purchases/[id]` notu:
- Özet, zaman çizgisi, notlar ve referanslar.
- Durum formundan geri bildirim yok. `fetchOrNotFound` yok.

`/package-refunds/[id]`:
- **W:** `…/take` (`PACKAGE_REFUND_REQUEST_CREATE`); `…/approve` (normal/istisna), `…/reject`, `…/settlement-failed` (`PACKAGE_REFUND_APPROVE`).
- **UI:** düğmeleri API'nin `allowedActions` alanı belirler. İstisna onayında maker ≠ checker kuralı işler. SETTLED yalnız webhook ile yazılır.
- **Durum:** 7 bölüm (özet, uygunluk ×3, işlemler, kararlar, denetim). Onay diyaloğu yok.

#### Kampanya ve uygunluk

| URL | Ekran | P | R | W | UI / Durum |
| --- | --- | --- | --- | --- | --- |
| `/campaigns` | Kampanyalar | `CAMPAIGNS_READ` | `GET /admin/campaigns?limit=25&cursor` (motor bayrağı ve kuyruk dahil) | — | Bkz. not |
| `/campaigns/new` | Yeni kampanya taslağı | `CAMPAIGNS_WRITE` | `GET /admin/campaigns?limit=1` | `POST /admin/campaigns/validate` (`CAMPAIGNS_READ`), `POST /admin/campaigns` (`CAMPAIGNS_WRITE`) | Bkz. not |
| `/campaigns/[id]` | Kampanya adı | `CAMPAIGNS_READ` | `GET …/:id`, `…/redemptions`, `…/evaluation-events` (404) | Bkz. not | Bkz. not |
| `/promotion-eligibility` | Uygunluk İncelemesi | `PROMOTION_ELIGIBILITY_REVIEW` | `GET /admin/promotion-eligibility/holds?filter` | — | Bekleyen / Karar verilen sekmeleri, 6 sütun |
| `/promotion-eligibility/[eventId]` | "Uygunluk incelemesi · {işletme}" | aynı | `GET …/holds/:eventId` (404) | `POST …/decision` (aynı izin) | Olay, değişmez gerekçeler, karar formu. Karar tek sefer verilir ve **kesin**dir |

`/campaigns` notu:
- Motor uyarı bandı (`engine-notice.tsx`).
- 10 sütun, yalnız "Sonraki" cursor sayfalama, boş durum.
- "Yeni taslak" düğmesi yazma iznine bakmadan görünür.

`/campaigns/new` notu:
- `CampaignDefinitionForm` 8 alan grubundan oluşur. "Kaydetmek etkinleştirmez" uyarısı ve alan düzeyinde API hataları var.

`/campaigns/[id]`:
- **W:**
  - Revizyon: `POST …/versions` (`CAMPAIGNS_WRITE`).
  - Etkinleştir: `…/versions/:n/activate` (`CAMPAIGNS_LIFECYCLE`).
  - Durdur, sürdür, bitir: `…/pause|resume|end` (`CAMPAIGNS_LIFECYCLE`).
  - Hak edişi geri al: `…/redemptions/:rid/revoke` (`CAMPAIGN_REDEMPTION_REVOKE`).
  - Değerlendirme olayını yeniden dene: `…/evaluation-events/:eid/retry` (`CAMPAIGN_EVENT_RETRY`).
- **UI:** çalışan kural, bekleyen revizyon, sürüm geçmişi (13 sütun), revizyon formu, hak edişler, değerlendirme kuyruğu, yaşam döngüsü paneli, denetim izi, "bu ekranda yapılamayanlar".

#### Katalog

| URL | Ekran | P | R | W | UI / Durum |
| --- | --- | --- | --- | --- | --- |
| `/categories` | Kategoriler | `CATALOG_READ` | `GET /admin/categories` | — | Bkz. not |
| `/categories/new` | Yeni kategori | `CATALOG_READ`+`CATEGORIES_WRITE` | kategoriler | `POST /categories` (`CATEGORIES_WRITE`), görsel yükleme (`UPLOADS_WRITE`) | 12 alanlı form, 2 görsel yükleyici |
| `/categories/[slug]` | Kategori | `CATALOG_READ` | Bkz. not | Bkz. not | Bkz. not |
| `/credit-packages` | Kredi Paketleri | `CREDIT_PACKAGES_READ` | `GET /admin/offer-packages` | Durum `PATCH …/status` (`CREDIT_PACKAGES_STATUS`), sıra ↑/↓ `PATCH` (`CREDIT_PACKAGES_WRITE`) | 9 sütun, satır içi aktif/pasif ve sıra düğmeleri |
| `/credit-packages/new` | Yeni paket | `CREDIT_PACKAGES_WRITE` | `…/unlimited-eligible-categories` (**`CREDIT_PACKAGES_READ`**) | `POST /credit-packages` | 12 alanlı form |
| `/credit-packages/[id]` | Paket | `CREDIT_PACKAGES_READ` | `…/:id` (`catch`→404), `/package-purchases?packageId` (**`PACKAGE_PURCHASES_READ`**, hata yutulur) | `PATCH /credit-packages/:id`, `…/status` | Bilgi formu, satış özeti, durum kartı |

`/categories` notu:
- "Yayın hazırlığı" kartı (taslaklar için, 8 sütun) ve "Kategori ağacı" (10 sütun).
- Arama ve durum filtresi sunucu render'ında uygulanır.
- "Yeni Kategori" düğmesi yazma iznine bakmadan görünür.

`/categories/[slug]`:
- **R:** `GET /admin/categories/:slug`, `GET /categories/:id/questions` (**`QUESTIONS_READ`**), yaprak kategoride `…/provider-invites` (**`PROVIDER_INVITES_READ`**).
- **W:**
  - Kategori: `PATCH` (`CATEGORIES_WRITE`), `…/status` (`CATEGORIES_STATUS`).
  - Sorular: `POST`/`PATCH` soru, `…/status`, `…/conditions`, `…/router-rules` (`QUESTIONS_WRITE`).
  - Davetler: davet üret (`PROVIDER_INVITES_ISSUE`), iptal et (`PROVIDER_INVITES_REVOKE`).
- **UI:** kategori formu, yönlendirme hedefleri, soru seti (satır içi düzenleme, koşul editörü), durum, davet paneli (URL bir kez gösterilir), yayın kontrol listesi.
- **Durum:** `fetchOrNotFound` yok. `CATEGORIES_DELETE` ve `QUESTIONS_DELETE` için UI yok.

#### Sistem ve yönetim

| URL | Ekran | P | R | W | UI / Durum |
| --- | --- | --- | --- | --- | --- |
| `/company-settings` | Şirket ve E-posta | `COMPANY_SETTINGS_READ` | `GET /company-settings` | `PUT /company-settings` (`COMPANY_SETTINGS_WRITE`) | 3 alan (legalName, supportEmail, postalAddress) + "Teknik ayarlar burada değildir" |
| `/operations-settings` | Operasyon Ayarları | `OPERATIONS_SETTINGS_READ` | Bkz. not | Bkz. not | Bkz. not |
| `/notifications` | Bildirim Geçmişi | `NOTIFICATION_LOGS_READ` | `GET /notification-logs?page&pageSize=50&status&channel&template&requestId&userId&providerId&from&to` | `POST …/:id/retry` (`NOTIFICATION_RETRY`) | 8 filtre, 8 sütun, yeniden gönder (yalnız `retryable` ise), sayfalama |
| `/notifications/[id]` | Bildirim | aynı | `GET /notification-logs/:id` (404) | yeniden gönder | 4 stat, Gönderim, İlişkili kayıtlar |
| `/users` | Admin Kullanıcıları | `ADMIN_USERS_READ` | `GET /users?…` | — | 8 filtre, 9 sütun. "Yeni Admin Kullanıcısı" düğmesi süper admin kontrolü olmadan görünür |
| `/users/new` | Yeni admin | `ADMIN_USERS_READ` | — | `POST /users` (**root-only**) | 3 alan. Davet URL'si query'de döner. Metin "SUPER_ADMIN rolü" diyor |
| `/users/[id]` | Kullanıcı | `ADMIN_USERS_READ` | `GET /users/:id`; süper adminse `…/roles` ve `/admin/roles` | `PATCH /users/:id/status` (`ADMIN_USERS_STATUS`), davet bağlantısı (root), rol ata/geri al (root) | Bkz. not |
| `/roles` | Roller ve izinler | `requireAdmin()` (izin yok) | `GET /admin/roles`, `/admin/permissions` (root) | `POST /admin/roles` (root) | Tanımlı roller tablosu, yeni rol + izin matrisi |
| `/roles/[id]` | Rol | `requireAdmin()` | `GET /admin/roles/:id` (404), izinler | `PATCH`, `PUT …/permissions`, aktif/pasif (onay kutusu) | Ad ve açıklama, izin matrisi, bu rolü taşıyan hesaplar |

`/operations-settings`:
- **R:** `GET /operations-settings`, `…/schedulers`, `…/marketplace-publish`, `…/provider-reviews`, `…/campaign-engine`.
- **W:**
  - `PUT /operations-settings` (`OPERATIONS_SETTINGS_WRITE`): iade süresi, saat cinsinden.
  - `PUT …/schedulers/:job` (`SCHEDULERS_WRITE`): 6 zamanlanmış iş.
  - `…/marketplace-publish` (`MARKETPLACE_PUBLISH_WRITE`), `…/provider-reviews` (`PROVIDER_REVIEWS_SETTING_WRITE`).
  - `…/campaign-engine` (`CAMPAIGN_ENGINE_TOGGLE`; tek `can()` kapısı, onay kutulu).
- **UI:** her ayar kendi formuyla anında kaydedilir. 5 denetim tablosu var.

`/users/[id]` notu:
- Profil, davet bölümü, durum anahtarı, rol atama kartı (yalnız süper admin görür).
- Rol ata/geri al geri bildirimi sayfada okunmuyor.

#### Kimlik doğrulama ve sistem sayfaları

| URL | Ekran | P | Not |
| --- | --- | --- | --- |
| `/login` | Giriş | — | Bkz. not |
| `/admin-invite` | Şifre belirleme | — | `GET /auth/admin-invite?token`, 3 hâl (form / geçersiz / tamamlandı), canlı kriter listesi (≥8, eşleşme). Hata durumunda token query'de geri döner |
| `/yetkisiz` | "Bu sayfa için yetkiniz yok" | Oturumlu | Kabuk içinde render edilir, HTTP 200. "Panele dön" ve "Başka bir hesapla giriş yap". Eksik izni adlandırmaz |
| (sınır) `not-found` / `error` / `global-error` | "Kayıt bulunamadı" / "Bir şeyler ters gitti" | — | `global-error` kendi inline stili ve `#2563eb` ile gelir |

`/login` notu:
- Form `POST /login/submit`. Alanlar: e-posta, şifre, "Beni hatırla".
- `?error` ve `?reason=session-expired` durumları var.
- **Yerel kimlik bilgisi ipucu ortamdan bağımsız, her zaman görünür** (`login/page.tsx:53`).

### 2.4 Kabuk

- **`app/layout.tsx`:** `readAdminAccess()` → `filterNavGroups`. Hata veya oturum yoksa menü boş gelir.
- **`admin-shell.tsx`:**
  - <1024px drawer: Esc, odak tuzağı, body kilidi, odak iadesi.
  - `/login` ve `/admin-invite` kabuksuz render edilir.
  - `SessionGuard` 30 sn'de bir yoklar, 5 dakikada bir heartbeat gönderir, `alertdialog` ile uyarır, BroadcastChannel kullanır.
- **`topbar.tsx`:** hamburger, grup ve satır adı (filtresiz `navGroups`'tan), Çıkış. Arama, zil ve kullanıcı menüsü yok.
- **`sidebar.tsx`:** `/brand/logo.png`, grup başlıkları, `aria-current`.
- **`breadcrumbs.tsx`:** yalnız `PageHeader` içinde; mobilde daraltma yok.

---

## 3. Eşleme ve boşluk analizi

Sınıflar:
- **A — doğrudan karşılık var.** Tasarımda bu route'un kendi ekranı var.
- **B — aynı şablona uyarlanacak.** Tasarımda ekran yok, ama liste/detay/form şablonu doğrudan uygulanır.
- **C — tasarımda eksik.** Tasarımda ne ekran ne menü satırı var; şablonla kurulacak, kompozisyonu için tasarım onayı gerekir.
- **D — tasarımda var, backend veya izin bağımlısı eksik.** Ekranın tamamı ya da bir parçası.

Bir A satırı D parçaları taşıyabilir. D parçaları "Bağımlı öğe" sütununda listelenir ve **bu programda üretilmez**; §6'daki karar sorularına bağlıdır.

### 3.1 Route eşleme tablosu (55 route)

| # | Route | Sınıf | Tasarım karşılığı | Korunacak işlevler | Bağımlı öğe (D) | Regresyon riski |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `/` | A | `dashboard` | 10 metrik + rozet tonu kuralı (boş pazarda 0 "dikkat" değil), kart→kuyruk bağlantıları | Vitrin kuyruğu sayacı (özette yok), KPI değişim yüzdesi + sparkline, "Son 7 gün" grafiği, "Sistem şu anda ne yapıyor", "Panelde son yapılanlar" (global denetim akışı yok) | **Yüksek**: kuyruk hücreleri izin sınırı aşabilir (bkz. K2) |
| 2 | `/requests` | A | `requests` | 7 filtre, 9 durum sözlüğü, kalite çubuğu, yaşam döngüsü notları, 2 boş durum, `/offers?requestId` bağlantısı | Sekme sayaçları (liste zaten tam geliyor, sayfada sayılabilir), "Excel'e aktar", "Elle talep ekle", sunucu sayfalaması (liste sayfalamasız) | Orta: müşteri tel/e-posta listede açık, tasarım da gösteriyor → K6 |
| 3 | `/requests/[id]` | A | `requestDetail` (4 sekme) | Durum geçişleri + `statusError` bantları, reddet fold'u, bildirim kararları (Uygun bulundu / Talebi kaldır / Geri aç), kalite yeniden hesaplama, iletişim paylaşım denetimi (değer göstermez), eşleşme tutarsızlık rozeti, 404 | "Süreyi 7 gün uzat" (API yok; süre kod sabiti), "Müşteriyi ara" (`tel:` ile yapılabilir), sekmeli yeniden düzen | **Yüksek**: F5/F6 (ADMIN rolü sayfaya giremeyebilir), 6 yazma formu sekmelere taşınıyor |
| 4 | `/requests/reports` | A | `list:complaints` | Açık/Çözülen, cursor sayfalama, salt okunur | "Harcanan kredi" sütunu (API alanı doğrulanmalı) | Düşük |
| 5 | `/offers` | A | `offers` | 9 filtre + sabitleyiciler, iade sinyali, 4 stat | Sekme sayaçları (durum sayımı API'de yok, sayfada hesaplanabilir) | Düşük |
| 6 | `/offers/[id]` | A | `offerDetail` (4 sekme) | Durum güncelleme (ACCEPTED eşleştirir), manuel kredi iadesi (6 sebep kodu) | "Teklifi müşteriden kaldır", "Müşteriye hatırlatma", "Hizmet vereni uyar" (3 uyarıda otomatik durdurma), "Eşleşmeyi iptal et": **dördü de backend'de yok** | **Yüksek**: 4 sahte eylem riski; 404 eksik |
| 7 | `/customers` | A | `list:customers` | Sunucu sayfalama + sıralama, doğrulama rozetleri, müşteri kökeni filtresi, anonim talep uyarısı | — | Düşük |
| 8 | `/customers/[id]` | A | `customerDetail` (4 sekme) | Aktivasyon bağlantısı (72 saat), notlar, aktif/pasif, talep/teklif tabloları | — | Orta: F7 (not okuma izni sayfayı düşürür), F14/F15 |
| 9 | `/support` | A | `list:support` | Durum kümesi ve rol filtresi, sayaçlar, 3 boş durum | "Bekleme süresi" sütunu (türetilebilir) | Düşük |
| 10 | `/support/[id]` | B | (`soon`) | Yanıt, izinli durum geçişleri, iade isteği açma (maker), yazışma çizelgesi | — | Orta |
| 11 | `/refund-scan` | A | `refund` | Dry-run → çalıştır, limit, sonuç tablosu | — | **Yüksek**: tasarım "onaylamadan hiçbir kredi hareket etmez" + onay adımı istiyor; bugün onay yok, istemci doğrudan API çağırıyor |
| 12 | `/providers` | A | `providers` | 5 filtre (sahiplik dahil), maskeli kayıt no, 3 satır eylemi | Sekme sayaçları (sayfada), "Kendi hesabı yok" = `ownership=unclaimed` | Düşük |
| 13 | `/providers/[id]` | A | `providerDetail` (3 sekme) | 4 `can()` kapısı, ham kayıt no talep üzerine ve denetimli, `ModerationDialog`, kategori bağlama, claim daveti, promosyon uygunluğu | "Belgeler" kartı (belge modeli yok), "Bu ay verdiği teklif / Kazanma oranı" şerit metrikleri (API yok) | **Yüksek**: tasarım "Kredi hareketleri" sekmesini buraya koyuyor ama o uç yalnız SUPER_ADMIN'e açık (F4) |
| 14 | `/providers/[id]/credits` | B | (`manual` + `providerDetail` kredi sekmesi) | Bakiye önizlemesi, eksiye düşme engeli, 6 çipli geçmiş, dönemsel paketler | — | **Yüksek**: F4; formun yeri K4 |
| 15 | `/provider-reviews/reports` | A | `list:reviewReports` | Açık/Çözülen, cursor | — | Düşük |
| 16 | `/provider-reviews/[reviewId]` | B | (`soon`) | Kaldır/geri al + sebep, müşteriye giden e-posta, günlük | — | Orta |
| 17 | `/showcase/reviews` | A | `list:cardReviews` | Kuyruk (en eski başta), "Tüm vitrin kartları" | "Sürüm" alt satırı | Düşük |
| 18 | `/showcase/reviews/[versionId]` | B | (`soon`) | Yan yana sürüm karşılaştırma, yayın hakkı koşulu, red notu 10–1000 | — | Orta |
| 19 | `/showcase/cards` | C | yok | Durum çipleri | Kart askıya al/aç UI'ı (API var, UI yok) → K9 | Düşük |
| 20 | `/showcase/leads` | A | `list:leads` | 5 durum, müşteri iletişimi gizli, kapatma yok (kasıtlı) | — | Düşük |
| 21 | `/showcase/packages` | A | `list:showcasePackages` | Oluştur ve düzenle, slug değişmezliği, "Metin onayları" bağlantısı | Satır içi düzenleme kartları → detay/modal kalıbı (B parçası) | Orta |
| 22 | `/showcase/price-terms` | C | yok | Değişmez onay defteri, sürüm çipleri | — | Düşük |
| 23 | `/showcase/placements` | A | `list:placements` | 5 durum | "Kalan / sayaç durdu" alt satırı | Düşük |
| 24 | `/showcase/placements/[placementId]` | B | (`soon`) | Durdur, sürdür, iptal (geri alınamaz, iade yok), durdurma geçmişi | — | Orta |
| 25 | `/finance` | A | `finance` | Dönem seçici + gruplama, trend grafiği, paket durum kartları, 2 son-kayıt tablosu | "Satılan kredi nereye gitti" kırılımı (API yok), "Rapor indir" (yok), tasarımın 4 KPI'ı mevcut 5+ kartın alt kümesi | Orta: tasarım mevcut bilgileri azaltıyor → K7 |
| 26 | `/finance/credit-ledger` | A | `list:ledger` | 9 tip, sayfalama, kampanya satırı bağlantıları, `providerId` sabitleyici | — | Düşük |
| 27 | `/finance/manual-adjustments` | A | `manual` | Liste + filtreler + denetim notu | Formun bu ekrana taşınması (K4) | **Yüksek**: F2 izin çelişkisi |
| 28 | `/finance/providers` | A | `list:balances` | 11 sütun, 9 alanlı sıralama | "Bu ay harcadığı" (API'de dönemsel kırılım yok) | Orta: tasarım 6 sütuna indiriyor → K7 |
| 29 | `/package-purchases` | A | `list:purchases` | Ödeme sağlayıcı kartı, manuel inceleme uyarısı | Sayfalama ve filtre çubuğu (API query destekliyor) | Orta: F3 |
| 30 | `/package-purchases/[id]` | B | (`soon`) | Webhook denemeleri, PENDING manuel düzeltme | — | Orta |
| 31 | `/package-refunds` | C | yok (tasarım menüsünde de yok) | Durum sayaçları | — | Orta |
| 32 | `/package-refunds/[id]` | C | yok | `allowedActions` sürücülü düğmeler, maker ≠ checker, SETTLED yalnız webhook | — | **Yüksek**: para hareketi, onay diyaloğu yok |
| 33 | `/campaigns` | A | `campaigns` | Motor bandı + kuyruk durumu, 10 sütun, cursor | "Bir kampanya üç sorudan oluşur" açıklama kartı (statik) | Düşük |
| 34 | `/campaigns/new` | B | yok ("Yeni kampanya yaz" düğmesi var) | `CampaignDefinitionForm`, doğrula ve kaydet, alan hataları | — | Orta |
| 35 | `/campaigns/[id]` | C | yok (satırda yalnız "Düzenle") | Sürüm geçmişi, revizyon, yaşam döngüsü, geri al, yeniden dene, denetim izi | — | **Yüksek**: 5 yazma yolu |
| 36 | `/promotion-eligibility` | C | yok | Bekleyen/Karar verilen | — | Düşük |
| 37 | `/promotion-eligibility/[eventId]` | C | yok | Tek seferlik kesin karar | — | Orta |
| 38 | `/categories` | A | `list:categories` | Ağaç (derinlik girintisi), yayın hazırlığı kartı, "Yayına hazır mı?" | — | Orta: ağaç görünümü düz tablo şablonuna sığmaz |
| 39 | `/categories/new` | B | (`soon`) | 12 alan, görsel yükleme | — | Düşük |
| 40 | `/categories/[slug]` | B | (`soon`) | Soru seti editörü, koşul editörü, yönlendirici kuralları, davet paneli, yayın kontrol listesi | — | **Yüksek**: en karmaşık form ekranı |
| 41 | `/credit-packages` | A | `list:creditPackages` | Sıra ↑/↓, aktif/pasif, 3 tür | — | Düşük |
| 42 | `/credit-packages/new` | B | (`soon`) | 12 alan, tür kuralları | — | Düşük |
| 43 | `/credit-packages/[id]` | B | (`soon`) | Düzenleme, satış özeti | — | Düşük |
| 44 | `/company-settings` | A | `company` | 3 alan, eksik uyarıları, "teknik ayarlar burada değil" | Yapışkan kayıt çubuğu (davranış olarak aynı) | Düşük |
| 45 | `/operations-settings` | A | `settings` | İade süresi (saat), 6 zamanlanmış iş, otomatik yayın, değerlendirmeler, motor (onaylı), 5 denetim tablosu | Tasarım satırları "talep süresi 14 gün", "hatırlatma 7. gün", "teklif 3 kredi", "en fazla 5 teklif", "aynı işletme tekrar teklif": **hiçbiri ayar değil** (kod sabiti, kategori alanı ya da yok). "Yorumlar yayından önce okunsun" gerçek `providerReviewsEnabled` anlamıyla uyuşmuyor | **Yüksek**: yanlış satırlar sahte ayar olur; tek "kaydet" çubuğu bugünkü ayar başına anında kaydetme + ayrı izinlerle çelişiyor → K5 |
| 46 | `/notifications` | A | `list:notifications` | 8 filtre, maskeli alıcı, yeniden gönder | — | Düşük |
| 47 | `/notifications/[id]` | B | (`soon`) | Gönderim ayrıntısı, yeniden gönder | — | Düşük |
| 48 | `/users` | A | `list:admins` | 8 filtre, sıralama, sayfalama | — | Düşük |
| 49 | `/users/new` | B | (`soon`) | Oluştur ve davet URL'si | — | Orta: F10/F14/F15 |
| 50 | `/users/[id]` | B | (`soon`) | Durum, davet bağlantısı, rol atama kartı | — | Orta |
| 51 | `/roles` | C | yok (tasarım menüsünde de yok) | Rol listesi, yeni rol + izin matrisi | — | **Yüksek**: yetki tanımlama yüzeyi |
| 52 | `/roles/[id]` | C | yok | Ad, izin matrisi, pasifleştirme (onaylı) | — | **Yüksek** |
| 53 | `/login` | A | `login` hâlleri 1–3 | `formPostRoute`, "Beni hatırla", `session-expired` | — | Orta: WebKit giriş E2E'leri; F16 |
| 54 | `/admin-invite` | A | `login` hâlleri 4–6 | Token doğrulama, canlı kriterler | — | Orta: WebKit |
| 55 | `/yetkisiz` | C | yok | İki çıkış yolu | — | Düşük |

**Sayılar:**
- **A — 31 route:** #1–9, 11–13, 15, 17, 20–21, 23, 25–29, 33, 38, 41, 44–46, 48, 53–54.
- **B — 14 route:** #10, 14, 16, 18, 24, 30, 34, 39, 40, 42, 43, 47, 49, 50.
- **C — 10 route:** #19, 22, 31, 32, 35, 36, 37, 51, 52, 55. `not-found`, `error` ve `global-error` sınırları route değildir; #55 ile birlikte Faz 1'de ele alınır.
- Toplam: 31 + 14 + 10 = 55.
- A satırlarından 12'si D parçası taşıyor: #1, 2, 3, 6, 9, 13, 21, 25, 27, 28, 29, 45.

### 3.2 Tasarımda olup sistemde olmayan ekranlar

| Tasarım ekranı | Durum | Karar |
| --- | --- | --- |
| `seoOverview` Arama motoru durumu | **SEO-004 bağımlılığı** | Bu programda UI yok |
| `list:seoIndex` İndekslenmeyen sayfalar | **SEO-004 bağımlılığı** | Aynı |
| `slugs` Adres (slug) yönetimi + modal | **SEO-004 bağımlılığı** | Aynı |
| `redirects` Yönlendirmeler + modal | **SEO-004 bağımlılığı** | Aynı |
| `list:matches` Eşleşmeler | D | K8 |
| Üst bar global arama | D | K3 |
| Üst bar bildirim zili ve sayaç | D | K3 |
| Menü satırı ve grup sayaçları | D (kısmen) | K2 |

SEO ekranlarının dayanakları:
- İlk ikisi (`seoOverview`, `list:seoIndex`) gerekçe döndüren indeks uygunluğu toplamasına ihtiyaç duyar; bugün yalnız boolean `seoIndexable` var (`apps/api/src/modules/seo/seo-index-eligibility.ts`).
- Slug ve yönlendirme ekranları yeni bir model, 301/302 sunumu ve zincir/döngü doğrulaması ister; şemada bunların hiçbiri yok [DOĞRULANDI].
- SEO-002 stratejisi (§6.3) bazı kaldırmalarda "redirect **değil**, 404/410" kuralı koyuyor, yani tasarımın slug modalındaki "otomatik 301" kuralı strateji belgesiyle çelişebilir.
- Menüde bu grup **gösterilmez**; SEO-004 ayrı iş kalemi olarak açılmalıdır.

`list:matches` notu: `ACCEPTED` teklif filtresiyle türetilebilir, ama "Sonrası (değerlendirme durumu)" sütunu teklif başına değerlendirme durumu gerektirir ve bu alan yok.

Global arama ve bildirim zili notu:
- Arama için birden fazla alanda arama yapan API yok; her alan için ayrı izin kontrolü gerekir.
- Zilin kaynak modeli tanımlı değil.
- Topbar'da **gösterilmez**.

Sayaçlar notu: sayaç ancak ilgili okuma iznine sahip oturum için ve o kuyruğun kendi ucundan gelirse gösterilebilir.

### 3.3 Sistemde olup tasarımda olmayan kapsam

Tasarım menüsünde **satırı olmayan** mevcut ekranlar:
- `/package-refunds`
- `/promotion-eligibility`
- `/roles`
- `/showcase/cards`
- `/showcase/price-terms`

Görevin istediği gibi kampanya, iade, fraud (uygunluk), roller ve izinler, finans, katalog ve operasyon ayarları planda **tam kapsamda**. Önerilen yeni menü yerleşimi (tasarım gruplarına ek; nihai karar K1):

| Tasarım grubu | Eklenecek satır | İzin |
| --- | --- | --- |
| Finans | Paket iadeleri `/package-refunds` | `PACKAGE_REFUND_READ` |
| Vitrin | Tüm vitrin kartları `/showcase/cards` | `SHOWCASE_CARDS_READ` |
| Katalog | Vitrin metin onayları `/showcase/price-terms` (ya da Vitrin paketlerinden bağlantı, bugünkü gibi) | `SHOWCASE_TERMS_ACCEPTANCES_READ` |
| Sistem | Uygunluk incelemesi `/promotion-eligibility` (Kampanyalar'ın altında) | `PROMOTION_ELIGIBILITY_REVIEW` |
| Sistem | Roller ve izinler `/roles` | `superAdminOnly` |

---

## 4. Durum davranışları: mevcut ve hedef

### 4.1 Mevcut
- Yüklenme göstergesi yok, sayfalar bloklayarak render edilir.
- Hata için tek kök sınır var; backend metni gösterilmez, digest gösterilir.
- 404 yalnız `fetchOrNotFound` kullanan detaylarda doğru çalışır. **Kullanmayanlar:**
  - `/offers/[id]`
  - `/package-purchases/[id]`
  - `/showcase/placements/[placementId]`
  - `/providers/[id]/credits`
  - `/categories/[slug]`
  - `/credit-packages/[id]` (`catch → null` ile 403'ü de 404'e çeviriyor)
- 403 durumunda `/yetkisiz` kabuk içinde, HTTP 200 ile döner.
- Boş durumlar: `EmptyState`, çoğu ekranda "filtreli" ve "veri yok" ayrımıyla.

### 4.2 Tasarımda eksik olan durumlar
- Tasarımda yüklenme iskeleti, hata, 403 ve 404 ekranı yok.
- Faz 1 bunları tasarım token'larıyla ve mevcut davranışı koruyarak kurar: `/yetkisiz`, `not-found`, `error`, `global-error` yeniden stillenir, akışları değişmez.
- `loading.tsx` eklenmesi davranış değişikliğidir (akış ve streaming). Bu yüzden ayrı bir karar: K10.

---

## 5. İzin çapraz kontrolü (82 izin ↔ menü/ekran/aksiyon)

### 5.1 UI'da hiç anılmayan 49 izin [DOĞRULANDI]

Aşağıdakilerin hepsi API'de korunuyor. **Veri sızıntısı yok**, ama arayüz bu izinleri hiç kontrol etmiyor; düğme herkese görünür, tıklanınca `/yetkisiz`'e düşülür.

```
CAMPAIGNS_LIFECYCLE CAMPAIGN_REDEMPTION_REVOKE CAMPAIGN_EVENT_RETRY
CATEGORIES_STATUS CATEGORIES_DELETE QUESTIONS_READ QUESTIONS_WRITE QUESTIONS_DELETE
COMPANY_SETTINGS_WRITE OPERATIONS_SETTINGS_WRITE SCHEDULERS_WRITE MARKETPLACE_PUBLISH_WRITE
PROVIDER_REVIEWS_SETTING_WRITE CREDIT_PACKAGES_STATUS CREDITS_GRANT CREDITS_DEDUCT
PACKAGE_PURCHASE_STATUS_WRITE PACKAGE_REFUND_REQUEST_CREATE PACKAGE_REFUND_APPROVE
PAYMENTS_CONFIG_READ OFFERS_STATUS OFFER_REFUND_EXECUTE OFFER_REFUND_MANUAL
REQUESTS_STATUS REQUESTS_QUALITY_RECALC REQUESTS_REOPEN REQUEST_REPORTS_RESOLVE
CONTACT_REVEAL_READ CUSTOMERS_STATUS CUSTOMER_NOTES_READ CUSTOMER_NOTES_WRITE
CUSTOMER_ACTIVATION_LINK_ISSUE PROVIDERS_WRITE PROVIDERS_MODERATE PROVIDER_CATEGORIES_WRITE
PROVIDER_CLAIM_INVITE_ISSUE PROVIDER_INVITES_READ PROVIDER_INVITES_ISSUE PROVIDER_INVITES_REVOKE
PROVIDER_REVIEWS_MODERATE SHOWCASE_PACKAGES_WRITE SHOWCASE_PLACEMENTS_MODERATE
SHOWCASE_PLACEMENT_CANCEL SHOWCASE_REVIEW_DECIDE SHOWCASE_CARDS_MODERATE SUPPORT_WRITE
NOTIFICATION_RETRY UPLOADS_WRITE ADMIN_USERS_STATUS
```

İstisnalar ve yan notlar:
- `package-refunds/[id]` düğmeleri API'nin `allowedActions` alanıyla doğru kapılanıyor; yukarıdaki iki paket-iade izni orada dolaylı olarak uygulanıyor.
- `PROVIDERS_WRITE` için UI'da hiç yazma yüzeyi yok (profil düzenleme formu yok). Tasarımdaki "Profili düzenle" düğmesi bu izne bağlanır, ama form backend alanlarıyla birlikte tasarlanmalı: K11.
- `CATEGORIES_DELETE`, `QUESTIONS_DELETE` ve `SHOWCASE_CARDS_MODERATE` için **UI eylemi hiç yok** (API var).

### 5.2 Bulgular (kod değiştirilmedi)

| # | Bulgu | Kanıt | Etiket |
| --- | --- | --- | --- |
| F1 | İşlem düzeyinde görünürlük kuralı karşılanmıyor: 52 sayfada yalnız 5 `can()` var, yazma düğmeleri okuma izni olan herkese görünüyor | §2.1, §5.1 | [DOĞRULANDI] |
| F2 | `/finance/manual-adjustments`: menü ve sayfa `FINANCE_READ` istiyor, okuduğu uç `FINANCE_LEDGER_READ` istiyor. `FINANCE_READ`'i olup `FINANCE_LEDGER_READ`'i olmayan kullanıcı menüden tıklayınca `/yetkisiz`'e düşer | `manual-adjustments/page.tsx:115,126`; RPM `/finance/credit-ledger` | [DOĞRULANDI] |
| F3 | `/package-purchases` gizli olarak `PAYMENTS_CONFIG_READ` gerektiriyor; bu izin yoksa tüm liste `/yetkisiz` olur | `package-purchases/page.tsx:23,33` | [DOĞRULANDI] |
| F4 | `/providers/[id]/credits`: sayfa `FINANCE_LEDGER_READ` istiyor, ama `GET /providers/:id/credits` ve `…/entitlements` `ProviderAccessGuard` ile yalnız SUPER_ADMIN'e veya sahibine açık. ADMIN rolündeki personel izin ne olursa olsun bu ekrana giremez. Manuel kredi formu da burada, yani `CREDITS_GRANT`/`CREDITS_DEDUCT` rol üzerinden fiilen devredilemiyor | `credits.controller.ts:115,123` | [DOĞRULANDI] |
| F5 | `/requests/[id]`: `GET /service-requests/:id/review` `@Roles(CUSTOMER, SUPER_ADMIN)`. ADMIN'de 403 `apiFetch` içinde `redirect('/yetkisiz')` atar; `catch` yalnız `ApiError`'u yutar, redirect'i yeniden fırlatır. Sonuç: ADMIN rolündeki personel talep detayını **hiç açamayabilir** | `requests/[id]/page.tsx:113-116`; `customer-provider-reviews.controller.ts:29-31` | [KOD-OKUMA] |
| F6 | `/requests/[id]`: "Tamamlandı" ve "İptal et" uçları `@Roles(CUSTOMER, SUPER_ADMIN)`, izin haritasında yok. ADMIN'e düğme görünür, tıklayınca `/yetkisiz`. Ayrıca `/offers?requestId` ve contact-reveal okumalarındaki `.catch` 403 yönlendirmesini yutar: izni olmayan "0 teklif" ya da "Kayıt yok" görür | `service-requests.controller.ts:130-139`; page `:101`, `:124` | [DOĞRULANDI] |
| F7 | `/customers/[id]` gizli olarak `CUSTOMER_NOTES_READ` gerektiriyor; bu izin yoksa tüm detay `/yetkisiz` olur | Grup A raporu | [KOD-OKUMA] |
| F8 | `/categories/[slug]` gizli olarak `QUESTIONS_READ` ve yaprak kategoride `PROVIDER_INVITES_READ` gerektiriyor | `[slug]/page.tsx:81,96` | [KOD-OKUMA] |
| F9 | `/credit-packages/new` `WRITE` ister ama `READ` ucunu okur. `/credit-packages/[id]` `PACKAGE_PURCHASES_READ` 403'ünü yutar (satış özeti sessizce boş) ve paket okumasındaki 401/403'ü 404'e çevirir | Grup D raporu | [KOD-OKUMA] |
| F10 | `/users/new` sayfası `ADMIN_USERS_READ` ister, ama `POST /users` root-only; "Yeni Admin Kullanıcısı" düğmesi süper admin olmayana da görünür. Metin, yeni hesabın SUPER_ADMIN olacağını söylüyor (PR-0 sonrası personel hesap türü ADMIN) | `users/page.tsx`, `users/new/page.tsx:81` | [KOD-OKUMA] |
| F11 | `/roles*` sayfaları `requireAdmin()` ile yalnız panel erişimini ister; koruma tamamen API'nin root-only reddine dayanır. Menü satırı doğru biçimde `superAdminOnly` | `roles/page.tsx:28` | [DOĞRULANDI] |
| F12 | Okuma iznine bakmadan görünen bağlantılar: `/campaigns` "Yeni taslak" (`CAMPAIGNS_WRITE`), `/finance` → Kredi Hareketleri (`FINANCE_LEDGER_READ`) ve → İade Taraması (`OFFER_REFUND_SCAN_READ`), `/categories` "Yeni Kategori", `/credit-packages` "Yeni Paket" | Grup C/D raporları | [KOD-OKUMA] |
| F13 | Tasarımın `/providers/[id]` "Kredi hareketleri" sekmesi F4 çözülmeden ADMIN rolüne açılamaz | — | Türetilmiş |
| F14 | `users/actions.ts`, `customers/actions.ts` (aktivasyon) ve kategori davet eylemi `catch` içinde `isRedirectError` ayırmıyor; 401/403 yönlendirmesi `?error=NEXT_REDIRECT` olarak görünür | Grup A/D raporları | [KOD-OKUMA] |
| F15 | Sırlar URL'de taşınıyor: `?activationUrl=`, `?inviteUrl=`, `/admin-invite?token=…&error=` | Aynı | [KOD-OKUMA] |
| F16 | `/login` yerel kimlik bilgisini (`admin@taktic.local / ChangeMe123!`) ortamdan bağımsız, her zaman gösteriyor | `login/page.tsx:53` | [DOĞRULANDI] |
| F17 | `middleware.ts` `/api/session` yolunu muaf tutmuyor; çerez gidince yoklama `/login` HTML'i alır ve `json()` atar | Grup D raporu | [KOD-OKUMA] |
| F18 | Topbar bağlam başlığı **filtresiz** `navGroups`'tan hesaplanıyor. Sızıntı değil (yalnız etiket), ama yeni menüde de filtreli kaynak kullanılmalı | `topbar.tsx:35-44` | [KOD-OKUMA] |
| F19 | Rol ata/geri al geri bildirimi (`?ok=role-assigned`/`?error=`) `/users/[id]` tarafından okunmuyor | Grup D raporu | [KOD-OKUMA] |
| F20 | Tasarımdaki kullanıcı bloğu "Tam yetkili yönetici" diyor. ADMIN rolündeki personel için yanlış; rol adı `/admin/me/permissions` yanıtında yok | README §Kabuk | Türetilmiş |

Menü ↔ sayfa izin tutarlılığı: F2 dışında 29 menü satırının tamamı sayfanın `requireAdmin` izniyle bire bir eşleşiyor [DOĞRULANDI: `nav.ts` ↔ `requireAdmin` sayımı].

---

## 6. Karar soruları

Bu sorular yanıtlanmadan ilgili D parçaları üretilmez; plan varsayılanı parantezde.

| # | Soru | Varsayılan |
| --- | --- | --- |
| **K1** | Tasarım menüsünde olmayan 5 ekran (paket iadeleri, uygunluk incelemesi, roller, tüm vitrin kartları, metin onayları) hangi gruba, hangi etiketle girsin? | §3.3 tablosu |
| **K2** | Dashboard "Önce bunlara bak" kuyrukları ve menü sayaçları: `DASHBOARD_READ` özetindeki sayılar ilgili okuma izni olmayana gösterilsin mi? | **Hayır**: hücre ve sayaç yalnız ilgili `*_READ` varsa render edilir. Vitrin sayacı için özet ucuna alan eklenmesi ayrı backend dilimi |
| **K3** | Global arama ve bildirim zili: kapsam, veri kaynağı ve izin modeli ne olsun? | Faz 1'de **yok**; üst bar yeri boş bırakılmaz, yalnız kırıntı + Çıkış |
| **K4** | Manuel kredi formu `/finance/manual-adjustments`'a mı taşınsın, `/providers/[id]/credits`'te mi kalsın? F4 (ProviderAccessGuard) nasıl çözülsün? | Form yerinde kalır; F4 için ayrı API işi (`FINANCE_LEDGER_READ` ile admin okuma ucu) |
| **K5** | Operasyon ayarları: tasarımdaki 5 sahte satır çıkarılsın mı, gerçek 9 ayar (iade süresi + 6 iş + 2 anahtar) tasarım diliyle mi kurulsun? Tek "Değişiklikleri kaydet" çubuğu mu, bugünkü ayar başına ayrı izinli anında kayıt mı? | Sahte satırlar yok; ayar başına kayıt ve izin korunur; tasarımın "ne olur" açıklama deseni uygulanır |
| **K6** | Listelerde müşteri telefon ve e-postası açık gösterilsin mi (`CONTACT_REVEAL_READ` benzeri bir kapı gereksin mi)? | Bugünkü davranış korunur; ayrı güvenlik işi olarak işaretlenir |
| **K7** | Tasarım bazı ekranlarda mevcut bilgiyi azaltıyor: finans (5 → 4 KPI; tahsilat, paket durum kartları), bakiyeler (11 → 6 sütun), talep detayı (tüm formlar sekmelere). Kaldırılan alanlar nereye gitsin? | Hiçbir alan kaybolmaz; fazlası ikincil sekme veya kartta kalır |
| **K8** | "Eşleşmeler" görünümü: `/offers?status=ACCEPTED` kayıtlı görünümü yeterli mi, "Sonrası" sütunu için backend alanı istensin mi? | Kayıtlı görünüm var, "Sonrası" sütunu yok |
| **K9** | `SHOWCASE_CARDS_MODERATE` (askıya al/aç), `CATEGORIES_DELETE`, `QUESTIONS_DELETE`: UI'ı olmayan API yetenekleri bu programda açılsın mı? | Hayır; tasarım programı yeni yazma yüzeyi açmaz |
| **K10** | Yüklenme iskeleti (`loading.tsx`) eklensin mi? Streaming, E2E zamanlamasını ve `form-post` akışlarını etkiler | Faz 4'te, ölçümle |
| **K11** | Tasarımdaki eylem düğmelerinden backend'i olmayanlar: "Profili düzenle" (`PROVIDERS_WRITE` var ama form yok), "7 gün uzat", "Teklifi kaldır", "Hatırlat", "Uyar", "Eşleşmeyi iptal et", "Excel'e aktar", "Elle talep ekle", "Rapor indir" | Hiçbiri render edilmez; her biri ayrı ürün ve backend kalemi |
| **K12** | Dashboard KPI değişim yüzdesi, sparkline, "Son 7 gün" grafiği, "Sistem şu anda ne yapıyor", "Panelde son yapılanlar" | Veri kaynağı yoksa **sahte metrik yok**. "Sistem ne yapıyor" operasyon ayarları okuma uçlarından türetilebilir (`OPERATIONS_SETTINGS_READ` varsa). Global denetim akışı yok |
| **K13** | Kullanıcı bloğu metni ("Tam yetkili yönetici") ve rol adı | Süper admin için "Süper yönetici", ADMIN için "Yönetici" (rol adları API'de yok) |
| **K14** | F5/F6 (ADMIN rolünün talep detayında düşmesi) ve F2/F3/F7/F8 gizli izin bağımlılıkları Faz 1 öncesinde ayrı bir düzeltme PR'ıyla mı kapansın? | **Evet**: ADMIN-DESIGN-000 (davranış düzeltmesi) önerilir |
| **K15** | Marka: `mark-white.png` kırmızı karo üstünde kullanılsın mı (README bunu öneriyor), `public/brand/logo.png` emekliye mi ayrılsın? Varlığın lisansı ve kaynağı ürün sahibince teyit edilsin | Teyit sonrası `public/brand/`'a eklenir |
