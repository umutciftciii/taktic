# ADMIN-DESIGN-001 — Admin paneli tasarım dönüşümü: uygulama planı

- **Tarih:** 2026-09-24
- **Taban:** `main@1bda65da`
- **Eşleme belgesi:** `docs/superpowers/specs/2026-09-24-admin-design-001-screen-mapping.md` (aşağıda "EB"). Route numaraları (#1–#55), bulgular (F1–F20) ve karar soruları (K1–K15) oradadır.
- **Tasarım referansı:** `Taktick Tasarım Projesi (2).zip` (2026-09-28 revizyonu) → `design_handoff_taktick_admin/`. Depoya kopyalanmaz. Her dilim PR'ı, referans aldığı ekranın prototip anahtarını ve ekran görüntüsü adını belirtir.
  - Prototip ve stiller (1) ile aynıdır; yalnız ekran görüntüleri 54 tam sayfa, 1440px görüntüyle yenilendi.
  - Numaralar paket (2)'ninkidir; eşleme EB §1.5'te. Bu belgedeki eski (1) numaraları 2026-09-28'de güncellendi.

## 0. Değişmez kurallar (her dilim için)

1. **RBAC tek kaynaktır.** `GET /admin/me/permissions`:
   - Sunucuda `requireAdmin(...)` ile okunur, dönen `can` kullanılır.
   - Menüde `readAdminAccess()` → `filterNavGroups` ile okunur.
   - İkinci bir izin kaynağı, istemci önbelleği ya da sabit rol listesi eklenmez.
2. **Görünürlük dört katmanda ayrı ayrı kapılanır:**
   - **Menü:** satır izni = sayfa izni. `lib/nav.ts` sözleşmesi ve `nav.spec.ts` korunur.
   - **Route:** `requireAdmin(<okuma izni>)`.
   - **Liste ve detay bölümü:** başka bir alanın okuma izni gerekiyorsa `can()`. Yoksa bölüm render edilmez, yerine "yetkiniz yok" notu da konmaz; bugünkü `providers/[id]` deseni korunur.
   - **Aksiyon:** her yazma düğmesi ve formu, API'nin istediği izinle `can()` kapısından geçer. Kaynak: `apps/api/src/modules/auth/route-permission-map.ts`.
3. **Tasarım uğruna veri veya aksiyon açılmaz.** Sayaç, KPI, arama ve bildirim; kaynağı ve izni yoksa render edilmez. Sahte metrik, sahte eylem ve "yakında" düğmesi yoktur.
4. **İşlev kaybı yok.** Her dönüştürülen ekran, EB §3.1'deki "korunacak işlevler" sütununun tamamını taşır. Tasarım bir alanı düşürüyorsa alan ikincil sekme veya karta taşınır (K7).
5. **Bu programda API, Prisma, migration, `.env` ve compose değişikliği yok.** Backend gerektiren her öğe D olarak işaretlidir ve ayrı iş kalemidir. İstisnası olmayan kural: bir dilim API değişikliği gerektirirse dilim durur ve karar sorusu açılır.
6. **Metinler:**
   - Tasarımdaki ⓘ ve "ne olur" metinleri birebir alınır, ancak gerçek davranışa uymayanlar düzeltilir. Örnek: operasyon ayarlarındaki "14 gün" satırı bir ayar değildir.
   - Metin değişikliği E2E seçicisi olarak kullanılan bir metni etkiliyorsa, test aynı PR'da güncellenir.
7. **Her dilim ayrı PR'dır.** CI 3/3 yeşil olmadan (verify · e2e chromium · e2e webkit) merge yok. Merge sonrası yerel stack eşitlenir: ana checkout ff-pull, `docker restart` / force-recreate `taktic-admin`.

## 0.1 Ön dilim önerisi: ADMIN-DESIGN-000 (davranış düzeltmeleri, tasarımdan bağımsız)

Tasarım dönüşümü görsel bir değişikliktir. Aşağıdakiler ise **davranış hatasıdır** ve görsel PR'lara karışırsa regresyonları ayırt edilemez. Önerim, Faz 1'den önce ya da paralel olarak ayrı bir PR'da kapatılmaları (K14):

| Bulgu | Önerilen düzeltme | API etkisi |
| --- | --- | --- |
| F5 | Değerlendirme okumasında redirect de yutulup kart gizlensin, ya da admin için ayrı bir okuma ucu | UI veya API |
| F6 | "Tamamlandı" / "İptal et" düğmeleri yalnız `isSuperAdmin` için; offers ve contact-reveal okumaları izin yoksa "yetkiniz yok" göstersin | UI |
| F2 | `/finance/manual-adjustments` menü ve sayfa izni `FINANCE_LEDGER_READ` olsun | UI (`nav.ts` + sayfa) |
| F3, F7, F8, F9 | Gizli ikinci okuma `can()` ile koşullu olsun, yetki yoksa bölüm gizlensin | UI |
| F4 | `ProviderAccessGuard` uçlarına `FINANCE_LEDGER_READ` ile admin okuma yolu | **API** (ayrı karar) |
| F10, F11 | "Yeni Admin Kullanıcısı" düğmesi ve `/users/new`, `/roles*` sayfaları için `isSuperAdmin` kapısı | UI |
| F14 | `catch` bloklarında `isRedirectError` ayrımı | UI |
| F16 | Kimlik bilgisi ipucu yalnız `APP_ENVIRONMENT=local` iken | UI |
| F17 | `/api/session` middleware'den muaf tutulsun | UI |
| F15 | Sırların query'den çıkarılması (tek seferlik flash) | UI, ayrı tasarım |

Bu ön dilim **bu Faz 0 PR'ının kapsamı dışında**; yalnız öneridir.

---

## Dilim 1 — Tasarım sistemi + uygulama kabuğu + RBAC uyumlu navigasyon (= **Faz 1**)

**Amaç:** Modernist token'ları, Archivo'yu ve yeni kabuğu (8+ grup, ikon modu, üst bar) tüm ekranlara tek seferde getirmek. Ekran içerikleri değişmez.

### Faz 1 route seti (kesin)

| Kapsam | Route / dosya |
| --- | --- |
| Kabuk (tüm oturumlu 52 route'u görsel olarak etkiler, içeriklerine dokunmaz) | `app/layout.tsx`, `app/admin-shell.tsx`, `components/sidebar.tsx`, `components/topbar.tsx`, `components/breadcrumbs.tsx`, `lib/nav.ts`, `app/globals.css` (token katmanı) |
| Menüsüz ekranlar | `/login`, `/admin-invite` (#53, #54) |
| Sistem durumları | `/yetkisiz` (#55), `app/not-found.tsx`, `app/error.tsx`, `app/global-error.tsx` |

### İş kalemleri

1. **Token katmanı** (`globals.css` başı):
   - Modernist değişkenleri `:root`'a eklenir.
   - Mevcut `--bg/--surface/--text/--primary/…` yeni değerlere **alias** olarak bağlanır. Böylece dönüştürülmemiş ekranlar kırılmadan yeni paleti alır.
   - Köşe yarıçapları 0'a çekilir. Kapsam bilerek geniş tutuldu: görsel regresyon beklenir, işlevsel regresyon beklenmez.
2. **Font:** Archivo `next/font/google` ile yüklenir (400/500/600/700/800). CDN `<link>` kullanılmaz; bu yolla font self-host edilir ve CSP etkilenmez.
3. **`lib/nav.ts`:**
   - Tasarımın 8 grubu uygulanır ve EB §3.3'teki 5 ek satır eklenir (K1 onayıyla).
   - Her satırın `permission` ya da `superAdminOnly` değeri **bugünkü değerle aynı** kalır. Tek istisna F2: ADMIN-DESIGN-000'da düzeltilmediyse satır `FINANCE_LEDGER_READ`'e çekilir.
   - SEO grubu **eklenmez** (SEO-004).
   - "Eşleşmeler" satırı K8 onayı gelmeden eklenmez.
   - Her satıra ikon adı eklenir (Lucide; `lucide-react` bağımlılığı ya da tasarımdaki inline path'ler). Karar PR'da verilir, lisans ISC.
4. **`sidebar.tsx`:**
   - Grup aç/kapa ve ikon modu. Tercih `localStorage`'da, try/catch ile ve SSR uyumlu (ilk render varsayılanla).
   - Kırmızı karo + `mark-white.png` (K15 onayıyla, `public/brand/`).
   - Kullanıcı bloğu K13 metnini kullanır.
   - **Sayaç rozeti yok** (K2).
5. **`topbar.tsx`:**
   - Kırıntı ("Grup / Sayfa") **filtreli** gruplardan hesaplanır (F18).
   - Çıkış 1px mürekkep kenarlı düğme olur.
   - Arama ve zil **yok** (K3).
   - Hamburger <1024px'te kalır.
6. **`admin-shell.tsx`:**
   - Drawer davranışı birebir korunur: Esc, odak tuzağı, body kilidi, odak iadesi, 1024px eşiği.
   - İkon modu yalnız ≥1024px'te geçerlidir.
7. **Kimlik doğrulama ekranları:**
   - 420px kart ve 6 hâl.
   - "Beni hatırla" açıklama metni eklenir.
   - `formPostRoute` akışına, alan adlarına ve `stale-auth-forms` sözleşmesine **dokunulmaz**.
8. **Sistem durumları:** `/yetkisiz`, 404, hata ve global hata tasarım token'larıyla yeniden stillenir. Metinler ve akış korunur. `global-error` kendi inline stiliyle kalır, yalnız renkler güncellenir.

### İzin etkisi
- İzin değeri değişmez; yalnız gruplama ve etiket değişir. F2 düzeltmesi yapılırsa tek değişiklik odur.
- `filterNavGroups` semantiği aynı kalır: izinsiz satır görünür, `superAdminOnly` yalnız süper admine, boş grup düşer.
- Yeni grup başlıkları da boşsa düşer.

### API etkisi
Yok.

### Test planı
- **Birim:**
  - `test/nav.spec.ts` yeni gruplara göre güncellenir.
  - Her satırın izninin sayfa `requireAdmin` iznine eşitliği için statik bir tablo testi eklenir. Tablo, `app/**/page.tsx` taramasından elle tutulur ve satır eklenince kırılır.
  - `isNavItemActive` en-özgül-satır kuralı yeni route'larla test edilir: `/showcase/cards` ↔ `/showcase/reviews`, `/package-refunds` ↔ `/package-purchases`.
- **E2E (Chromium):**
  - `admin-rbac-permissions.spec.ts`: izin kombinasyonlarıyla menü satırlarının görünürlüğü.
  - `admin-session.spec.ts`, `session-lifecycle.spec.ts`, `access-and-errors.spec.ts`: `/yetkisiz` ve 404.
- **E2E (WebKit):**
  - `login-screen.spec.ts`, `password-criteria.spec.ts`, `stale-auth-forms.spec.ts`, `responsive-shell.spec.ts`.
  - WebKit'te `fullPage` × DPR tuzağına dikkat edilir; ekran görüntüsü karşılaştırmasında viewport boyutu kullanılır.
- Metin tabanlı seçiciler (menü etiketi değişiyor) aynı PR'da güncellenir. Tam liste için `grep -rn "Dashboard\|Talep bildirimleri\|Provider Finans" e2e/tests` çalıştırılır.

### Görsel kabul kriteri
Aşağıdakilerde `01-genel-gorunum.png`, `02-menu-daraltilmis.png` ve giriş hâlleri `49`–`54` (`49-giris.png` … `54-sifre-olusturuldu.png`) ile yan yana karşılaştırma yapılır:
- Menü genişliği 256/64px, üst bar 56px.
- Aktif satır `#fff2ef` zemin + 3px kırmızı iç çizgi.
- Grup başlığı 12px/700/uppercase ve Türkçe "İ" doğru.
- Odak halkası `#ec3013`, köşeler 0.

Ekran görüntüleri 1440×900 ve 390×844 (drawer açık/kapalı) boyutlarında PR'a eklenir.

### Geri dönüş riski
- **Orta.** Token alias'ları tüm ekranları etkiler.
- Geri dönüş tek bir revert commit'idir; migration veya veri yok.
- Risk noktası, yeni font ve 0 radius'un eski sınıflarda taşma veya kırpma yaratmasıdır. Kabul turunda 52 route'un tamamı en az bir kez açılır.

---

## Dilim 2 — Ortak liste / detay / form / feedback bileşenleri

**Amaç:** Dilim 3'teki ekranların birleşeceği yapı taşlarını ve izin kapısı yardımcılarını kurmak. Bu dilimde **hiçbir ekran dönüştürülmez**; bileşenler yalnız birim testleriyle ve bir referans ekranda (bkz. aşağı) kanıtlanır.

### Bileşenler (`apps/admin/components/`)

| Bileşen | Tasarım deseni | Not |
| --- | --- | --- |
| `PageHeader` (genişletme) | h1 + ⓘ + özet satırı + eylem alanı | Mevcut API geriye uyumlu |
| `InfoPopover` | ⓘ (tek açık, Esc, dışına tıklama, `aria-expanded`) | İstemci bileşeni; açık popover global tek durum |
| `SummaryStrip` | Detay özet şeridi | Sunucu bileşeni |
| `Tabs` | `?tab=` query ile | Link tabanlı (JS'siz çalışır); `aria-current` |
| `SavedViewTabs` | Liste "kayıtlı görünüm" sekmeleri + sayaç | Sayaç yalnız veri o sayfada zaten varsa |
| `FilterBar` | Ara · Durum · Tarih · alan filtreleri, Filtrele/Temizle | GET form; mevcut query adları korunur |
| `DataTable` stilleri | 11px uppercase başlık, 2px mürekkep çizgi, satır hover, sağa yaslı sayılar | `.table-scroll` her yerde kendi yatay kaydırmasıyla (EB: `/customers`, `/users`, `/notifications`, `/roles` taşma boşluğu kapanır) |
| `Pagination` | "N kaydın a–b arası" + Önceki/Sonraki | Sayfa tabanlı ve cursor tabanlı iki varyant |
| `Badge` | nötr / başarı / uyarı / hata | Mevcut `statusBadgeClass` eşlemeleri korunur |
| `KeyValueList`, `Timeline` | Etiket/değer satırları, "Neler oldu" | — |
| `ConfirmDialog` | Yıkıcı işlem onayı + sonucu önceden yazan metin | Native `<dialog>`, `aria-modal`, odak tuzağı, Esc. **Server action'ı değiştirmez**, yalnız submit'ten önce araya girer |
| `StickyActionBar` | Yapışkan kayıt çubuğu | Kirli durum + `beforeunload` uyarısı |
| `Toggle` | 52×28 `role="switch"` | Mevcut `*-toggle.tsx` bileşenlerinin görsel katmanı |
| `EmptyState` (restil) | "Ne zaman dolacağını söyleyen" metin | Mevcut prop'lar korunur |
| `Can` / `requireCan` yardımcıları | Aksiyon kapısı | Bkz. aşağı |

**İzin kapısı deseni:**
- Sunucu bileşeni `const { can } = await requireAdmin('X_READ')` alır ve düğme ya da formu `can('X_WRITE') ? … : null` ile render eder.
- İstemci bileşenine yalnız hesaplanmış boolean prop geçer (`canApprove`), izin listesi geçmez.
- Yeni bir istemci-tarafı izin bağlamı **eklenmez**; tek kaynak kuralı böylece korunur.

### İzin etkisi
Yok. Yardımcılar yalnız eklenir.

### API etkisi
Yok.

### Test planı
- Vitest (`apps/admin/test/`) ile:
  - `InfoPopover` tek-açık kuralı, `Tabs` query üretimi, `Pagination` sınırları.
  - `ConfirmDialog`'un iptalde submit etmemesi.
  - Bugün admin vitest'i yalnız `node` ortamında `test/**/*.spec.ts` koşuyor. Bileşen testleri için `apps/web/vitest.config.ts`'deki `oxc: { jsx: { runtime: 'automatic' } }` deseni ve bir DOM ortamı eklenmesi gerekir; bu bir bağımlılık kararıdır. Alternatif: saf mantık (`lib/`) ayrılıp node'da test edilir, render davranışı E2E'de doğrulanır.
- Referans ekran olarak `/notifications` (#46) bu dilimde yeni bileşenlerle kurulur: salt okunur, düşük riskli ve `notification-history.spec.ts` kapsamı var. `NotificationRetryButton` `can('NOTIFICATION_RETRY')` kapısına alınır. Bu, desenin uçtan uca kanıtıdır.

### Görsel kabul kriteri
- `/notifications`, README "15–22 ortak liste" tanımı ve `list:notifications` sütun setiyle (paket 2: `46-gonderilen-bildirimler.png`) karşılaştırılır.
- 320px genişlikte sayfa yatay kaymaz, yalnız tablo kayar.

### Geri dönüş riski
Düşük. Bileşenler eklemedir; tek ekran değişir.

---

## Dilim 3 — Ekran gruplarının dönüşümü

Her alt dilim ayrı PR'dır ve sırası risk/bağımlılığa göredir. Her PR'da şunlar birlikte yapılır:
- **(a)** Ekranlar Dilim 2 bileşenleriyle kurulur.
- **(b)** Ekrandaki **tüm** yazma yüzeyleri §5.1'deki izinlerle `can()` kapısına alınır (F1'in o ekrandaki payı).
- **(c)** Yıkıcı işlemler `ConfirmDialog`'a alınır.
- **(d)** EB §3.1'deki korunacak işlevler PR açıklamasında madde madde işaretlenir.

### 3A — Talepler ve teklifler (#2, #3, #4, #5, #6, #11)

| Route | Tasarım | Aksiyon kapıları | Onay diyaloğu |
| --- | --- | --- | --- |
| `/requests` | `requests`, `03-talepler.png` | — | — |
| `/requests/[id]` | `requestDetail` (4 sekme), `04`–`07` | `REQUESTS_STATUS`, `REQUESTS_QUALITY_RECALC`, `REQUEST_REPORTS_RESOLVE`, `REQUESTS_REOPEN`; tamamla/iptal yalnız `isSuperAdmin` (F6) | Reddet, Talebi kaldır, İptal |
| `/requests/reports` | `list:complaints`, `08` | — | — |
| `/offers` | `offers`, `09` | — | — |
| `/offers/[id]` | `offerDetail` (4 sekme), `10`–`13` | `OFFERS_STATUS`, `OFFER_REFUND_MANUAL` | Kabul et (diğer teklifleri kapatır), Krediyi iade et |
| `/refund-scan` | `refund`, `30` | "Taramayı çalıştır" `OFFER_REFUND_EXECUTE` | Toplu iade onayı ("N teklifin iadesini onayla") |

- **Sekmeler:** talep detayında "Talep bilgileri · Teklifler · Şikayet · Neler oldu" sekmeleri; bugünkü tüm bölümler bunlara dağıtılır. "Durum yönetimi" formları özet kartının eylem alanına ve "Talep bilgileri" sekmesine taşınır.
- **İzin etkisi:**
  - "Teklifler" sekmesi ancak `can('OFFERS_READ')` ile görünür.
  - "Şikayet" sekmesi ancak `can('REQUEST_REPORTS_READ')` ile görünür.
  - İletişim paylaşım kartı ancak `can('CONTACT_REVEAL_READ')` ile görünür.
- **K11 (2026-09-28 kararı):** Faz 3A'da çalışan karşılığı olmayan eylem render edilmez; ADMIN-ACTIONS-001–007 ayrı ürün/backend/UI dilimlerinde teslim edilir.
  - Kapsam: 7 gün uzat (001), teklifi kaldır (002), hatırlat (003), uyar (004), eşleşmeyi iptal et (005), Excel'e aktar (006), elle talep ekle (007).
  - Bunlar iptal edilmiş özellik değildir. Mevcut API karşılıkları, gereken izinler, veri/bildirim etkileri, açık ürün kararları, uygulama sırası ve görev tanımları: `docs/superpowers/specs/2026-09-28-admin-actions-001-007-inventory.md`.
  - Tasarım dönüşümü bu yedi işlevin backend kapsamını büyütmez; her biri kendi PR'ında, kendi izni ve testleriyle gelir. O PR'a kadar ekranda düğme, "yakında" etiketi ya da devre dışı yer tutucu yoktur.
- **API etkisi:** yok. Refund-scan'in iki çağrısı (önizleme, çalıştırma) aynı uç, gövde ve izinle tarayıcıdan admin sunucu aksiyonlarına taşındı: derleme anında gömülen API adresi E2E'de erişilemiyordu ve 401/403'te ham gövde gösteriliyordu (envanter §3, F25).
- **Test:**
  - `request-report-flow`, `marketplace-journey`, `offer-experience`, `offer-detail-hydration`, `offer-withdrawal`, `request-auto-publish`, `contact-sharing`.
  - Yeni: izni olmayan rolde yazma düğmelerinin yokluğu (`admin-rbac-permissions` genişletmesi). Tasarımın `?tab=` URL'leri için derin bağlantı testi.
- **Görsel kabul:** `03`–`13` ve `30` (paket 2). Karşılaştırma ve sapmalar aşağıdaki "Faz 3A görsel karşılaştırma" bölümünde.
- **Geri dönüş riski:** Yüksek (6 yazma formu yer değiştiriyor). Revert tek PR.

#### Faz 3A görsel karşılaştırma (paket 2, 2026-09-28)

Karşılaştırma, PR #118'in 1440px Chromium görüntüleriyle yapıldı. "Uygulandı", tasarımın yerleşimi ve içeriğinin gerçek veriyle kurulduğu anlamına gelir. Sapmaların gerekçeleri:

- **D:** veri ya da API yok.
- **K11:** ADMIN-ACTIONS kapsamında.
- **K7:** mevcut bilgi korunuyor.
- **İzin:** yetki kuralı gereği.

| Görüntü | Uygulandı | Sapma ve gerekçe |
| --- | --- | --- |
| `03-talepler` | Başlık + ⓘ + özet; filtre çubuğu (Ara, Kalite ⓘ, Hizmet=Kategori, Şehir, tarih); tablo sütunları ve sırası; kalite çubuğu; "Aç"; "N kaydın a–b arası" + Önceki/Sonraki | **K11:** Excel ve Elle talep ekle yok. **K7:** Durum filtresi ve kayıtlı görünümler (README'de var, görüntüde yok) korunuyor; Başlangıç/Bitiş gün alanı, tasarımdaki "Son 30 gün" hazır seçimi yerine. Durum rozetleri mevcut sözlük ("Onaylandı"); tasarımın insan dili ("Yayında", "Teklif bekliyor") ayrı metin kararı. **K6:** telefon listede tam gösteriliyor, tasarımda maskeli |
| `04-talep-detayi-bilgiler` | Geri bağlantısı; özet kartı (rozetler, künye, 27px "Kategori · İlçe, İl", müşteri satırı); 5 hücreli şerit; 4 sekme; "Müşteri ne istiyor", "Kalite puanı neden N" (ⓘ), "Adres ve erişim", "Bu talebe ne olacak" (ilerleme çubuğu) | **İzin, K7:** tasarımda olmayan "Durum yönetimi" kartı (incelemeye al, onayla, tamamla, iptal, reddet) ve Eşleşme, Müşteri, Kayıt bilgileri, Kategori soruları, Değerlendirme kartları; 3 kolon yerine 2 kolon. **K11:** "Süreyi 7 gün uzat" (001). Başlık eylemleri: "Şikayeti kapat" → Şikayet sekmesindeki "Uygun bulundu"; "Yayından kaldır" → Durum yönetimindeki "Talebi reddet". **D:** fotoğraf yok. Kalite kırılımı API'nin 10 başlığı (tasarımda 4) |
| `05-talep-detayi-teklifler` | "Bu talebe gelen teklifler" tablosu: Hizmet veren, Teklif, Ne zaman gelebilir (`estimatedStartDate`), Verildiği zaman, Durum; sağ üstte durum cümlesi | **D:** "4,8 puan · 128 iş" alt satırı yok; yerine konum. Ek: Teklif no ve "Aç". Sekme sayacı rozet, parantez değil (ortak `Tabs`) |
| `06-talep-detayi-sikayet` | "Karar bekliyor" rozeti, bildiren + zaman, sol kırmızı çizgili alıntı, karar formu, alt açıklama | Gerçek iki karar "Uygun bulundu" ve "Talebi kaldır" (onaylı). Tasarımdaki "Haklı bul, krediyi geri ver" API'de talebi kaldırır, tüm açık tekliflerin kredisini iade eder (EB §1.5). "Önce müşteriyle görüş" bir işlem değil |
| `07-talep-detayi-neler-oldu` | Zaman + olay + yapan, en yeni başta | Olaylar yalnız kayıttaki zamanlardan ve oturumun okuyabildiği kayıtlardan. "Talep kendiliğinden yayına girdi · otomatik yayın" ayrımı kayıtta yok (D) |
| `08-sikayet-edilen-talepler` | Başlık + ⓘ (gerçeğe göre düzeltildi); tablo: Talep (+kategori/konum), Şikayeti eden, Gerekçe, Bildirim zamanı, Durum, "Aç" (Şikayet sekmesine); cursor sayfalama | **D:** Harcanan kredi sütunu yok; Ara ve Tarih filtresi yok (API yalnız `state` ve `cursor` alıyor); "Kararı bekleyenleri sırayla aç" yok. Açık/Çözülen kayıtlı görünümleri eklendi |
| `09-teklifler` | Başlık + ⓘ + özet; tablo sütunları (Teklif no, Talep, Hizmet veren, Teklif, Harcanan kredi, Verildiği zaman, Durum, Aç) | **D:** "ortalama · eşleşme oranı" özeti yok. **K7:** 4 sayı şeridi, 9 filtre + sabitleyiciler, müşteri/konum/iade sinyali sütunları ve kayıtlı görünümler korunuyor |
| `10-teklif-detayi-islemler` | Özet kartı, 5 hücreli şerit, 4 sekme, "Hizmet verenin teklifi", "Yapabileceğin işlemler" (ad, açıklama, "Ne zaman:", düğme) | **K11:** 002–005 yok. Çalışan işlemler: Krediyi iade et (forma götürür), Kabul et, Kısa listeye al, Reddet. "Dahil olanlar / geçerlilik" alanları sistemde yok; mesaj, garanti, iç not, tahmini tarihler gösteriliyor |
| `11-teklif-detayi-ilgili-talep` | Talep ve müşteri bilgileri; "Aynı talebe gelen diğer teklifler" tablosu | **D:** talep açıklaması ve bütçe teklif yanıtında yok; "Talebin tamamını aç" bağlantısı var |
| `12-teklif-detayi-kredi-iade` | "Bu teklifin kredi hikâyesi"; iade sebebi seçimi + açıklama + "N krediyi iade et" | Sebep listesi API'nin 6 operasyon kodu (tasarımdaki 5 örnek değil). Önceki/sonraki bakiye cümlesi yok (D); kredi işlem kimlikleri ve politika durumu gösteriliyor. İade onaylı |
| `13-teklif-detayi-neler-oldu` | Zaman çizelgesi | Olmamış adımlar "Henüz olmayanlar" satırında |
| `30-iade-kontrolu` | Başlık + ⓘ + süre notu; sayı kartları; "Tarama sonucu" + "Onaylamadan hiçbir kredi hareket etmez"; "Yeniden tara"; "N teklifin iadesini onayla" (onaylı) | **D:** "Taranan teklif" ve "Son tarama" yok (API vermiyor; son çalışma yalnız süreç belleğinde); yerine "Atlanan" ve "Yeni tekliflerin iade süresi". Tablo ham id'lerle, izin varsa bağlantılı (D: işletme/talep adı yok). Limit alanı ve 7 atlanma nedeni korunuyor |

İnceleme düzeltmeleri (PR #118, 2026-09-28). Üçü de arayüz koruması; aynı kurallar artık API'de de var (PR #119 API-GUARD-OFFER-001 + API-GUARD-REQUEST-001, PR #120 API-GUARD-REQUEST-002):
- `10`: kabul edilmiş teklifte "Reddet" ve "Kısa listeye al" sunulmaz; ekran nedenini yazar.
- `04`: "İncelemeye al / Onayla" yalnız SUBMITTED, IN_REVIEW ve APPROVED taleplerde sunulur.
- `11`: "diğer teklifler" mevcut teklifi içermez; toplam ayrıca "toplam" diye etiketlenir.

main@4e1d1c98 entegrasyonu (PR #118, 2026-09-28):
- **409 eşleme.** Durum yazımlarının 409'ları işlem bağlamında açıklanır, genel hata sınırına düşmez (`apps/admin/lib/status-conflicts.ts`). Talep: `REQUEST_STATUS_TRANSITION_NOT_ALLOWED`, `REQUEST_STATUS_NOT_MODERATION_TARGET`, `PHONE_NOT_VERIFIED`, `REQUEST_NOT_REMOVABLE` ve `/cancel`, `/complete` uçlarının kodsuz 409'u → "Durum yönetimi" kartındaki bant (`?statusError=`). Geri açma yolunda `REQUEST_STATUS_TRANSITION_NOT_ALLOWED` → Şikayet sekmesindeki "geri açılamaz" bandı. Teklif: `OFFER_ACTION_NOT_ALLOWED`, `CONTACT_DISCLOSURE_REQUIRED` ve diğer 409'lar → işlem listesinin üstündeki bant. Tasarımda karşılığı yok; mevcut `status-action-error` bandı kullanıldı.
- **`10`:** REJECTED teklifte de durum işlemi sunulmaz (API 409 verir); ekran nedenini yazar.
- **`04`, "İptal et" diyaloğu (tarihsel; aşağıdaki iptal sözleşmesi bu davranışın yerini aldı):** metin ADMIN-ACTIONS-005 risk raporu §1–§3'e göre düzeltildi. Açık teklifler kapanmaz, kredi iadesi yapılmaz; görülmemiş teklifler otomatik iade kuralıyla süresi dolunca yine iade edilebilir. Eşleşmiş talepte kabul edilen teklif kalır, iletişim ve mesajlaşma kapanır, kimseye bildirim gitmez. Davranış değişmedi; K2–K5 ürün kararı olarak açık.

Merge öncesi düzeltmeler (PR #118, head `624f3e06` sonrası):
- **Ret/kaldırma kullanılamadığında yönlendirme (eşleşmiş talep metni iptal sözleşmesiyle güncellendi):** "Eşleşmiş veya kapanmış talep için İptal et kullanın" kaldırıldı. Neden, durum başına yazılıyor (`removalUnavailableReason`, `apps/admin/lib/request-moderation.ts`). Kapanmış talep için iptal de yok. Eşleşmiş talep için iptal ret karşılığı olarak sunulmuyor; K2–K5 riskiyle anlatılıyor. Taslak için yalnız iptal var. `notRemovable` ve `notModerationTarget` bantları iptale yönlendirmiyor. Ret düğmesi API ile aynı koşulda (eşleşme dahil) açılıyor.
- **İptal diyaloğu:** talebin gerçek teklif listesinden sayıyor: kabul edilen dışında açık kalan ve kabul anında reddedilen teklifler. İptal hiçbirine dokunmuyor; E2E onaydan sonra veritabanında doğruluyor.
- **Görüntüler:** `2026-09-28-admin-design-001-faz-3a-screens/pre-merge-409/` (Chromium 1440, WebKit 320). Üst klasördeki görüntüler head `b79f968a`'ya aittir.

İptal sözleşmesi (PR #118, head `08ab7c86` sonrası; `docs/superpowers/specs/2026-09-28-request-cancellation-contract.md`):
- **API:** müşteri ya da `REQUESTS_CANCEL` izinli personel iptal eder. İadesiz iptal ayrı uçtadır (`REQUESTS_CANCEL_WITHOUT_REFUND` + gerekçe). Kabul edilmiş teklif CANCELLED olur; kabul ve eşleşme izi (`acceptedAt`, `matchedOfferId`) korunur (K2). Kazanamayan tekliflerden açık olanlar kapanır, reddedilmiş olanlar (elle ret dahil) REJECTED kalır; hepsinin harcanmış ve henüz iade edilmemiş kredisi, kazanan kararından bağımsız olarak iade edilir. WITHDRAWN ve EXPIRED değişmez (K4). Bildirim müşteriye, kazanana ve kapanan ya da iade alan her teklif sahibine gider (K5). Denetim satırı ve üç bildirim şablonu var. Migration `20260928160000_add_request_cancellation_contract`.
- **Admin `04`:** iptal artık `REQUESTS_CANCEL` ile açılıyor, tamamlama yalnız süper yöneticide. Eşleşmiş talepte "Kazanan teklifin kredisini iade et" kutusu varsayılan işaretli; işaret kaldırılınca gerekçe zorunlu. "İptal kaydı" kartı eklendi. Durum metinleri kapanmış talepte eşleşme varsa da "kapanmış" diyor.
- **Müşteri web:** açık ve eşleşmemiş talepte "Talebi iptal et" onay diyaloğuyla sunuluyor. Eşleşmiş talepte sunulmuyor; bayat sayfadan gelen 409 açıklanıyor.
- **Görüntüler:** `2026-09-28-admin-design-001-faz-3a-screens/cancellation-contract/` klasöründe (Chromium 1440, WebKit 320).


### 3B — Kişiler ve destek (#7, #8, #9, #10, #12, #13, #14)

- **Tasarım karşılıkları:**
  - `list:customers` (`19`), `customerDetail` (`20`–`23`), `list:support` (`24`), `providers` (`15`), `providerDetail` (`16`–`18`).
  - `/support/[id]` ve `/providers/[id]/credits` için şablon kullanılır.
- **Aksiyon kapıları:**
  - Müşteri: `CUSTOMER_NOTES_WRITE`, `CUSTOMERS_STATUS`, `CUSTOMER_ACTIVATION_LINK_ISSUE`; notlar sekmesi `CUSTOMER_NOTES_READ` (F7).
  - Destek: `SUPPORT_WRITE`, `PACKAGE_REFUND_REQUEST_CREATE`.
  - Hizmet veren: `PROVIDERS_MODERATE` (`ModerationDialog`), `PROVIDER_CATEGORIES_WRITE`, `PROVIDER_CLAIM_INVITE_ISSUE`; mevcut 4 `can()` korunur.
  - Krediler: `CREDITS_GRANT` ve `CREDITS_DEDUCT` sekme bazında.
- **Onay diyaloğu:** hesabı pasife al, hizmet vereni askıya al/reddet, kategori kaldır, kredi düş.
- **Hizmet veren detay sekmeleri:** "İşletme bilgileri · Kredi hareketleri · Değerlendirmeler".
  - "Kredi hareketleri" sekmesi `can('FINANCE_LEDGER_READ')` ile render edilir (aşağıdaki F4 satırı). Yoksa sekme de "Krediler" bağlantısı da yok; `?tab=kredi` ilk sekmeye düşer.
  - "Belgeler" kartı ve "kazanma oranı" metrikleri render edilmez (D).
- **API etkisi (gerçekleşen, 2026-09-29):** F4 için API kodu gerekmedi; F4 bu PR'da test kapsamıyla kapatıldı. Ayrı ve dar bir API değişikliği inceleme sonrası eklendi (aşağıda "kredi tamsayı sınırı").
  - Plandaki "yok (F4 ayrı)" satırı yazıldığında `ProviderAccessGuard` ADMIN personelini kredi okumasında 403'e düşürüyordu. ADMIN-DESIGN-000 (PR #114) ayrı ve salt okunur iki personel ucu ekledi: `GET /admin/providers/:id/credits` (`FINANCE_LEDGER_READ`) ve `…/entitlements` (`PACKAGE_PURCHASES_READ`). Sahip rotaları (`/providers/:id/credits|entitlements`) genişletilmedi. `/providers/[id]/credits` ve yeni "Kredi hareketleri" sekmesi yalnız bu personel uçlarını okur.
  - Yazma yolları zaten kendi izinleriyle açıktı: `POST /providers/:id/credits/grant` → `CREDITS_GRANT`, `…/deduct` → `CREDITS_DEDUCT` (`AdminAccessGuard` + `PermissionsGuard`), biri diğerini açmaz.
  - Bu PR'ın eklediği kanıt: API testi (`admin-provider-credits-read.spec.ts`) — sahip başka sağlayıcıyı iki rotadan da okuyamaz, kendisininkine ve başkasınınkine kredi ekleyip düşemez; müşteri her kredi rotasında 403, anonim 401; personel yazısı `createdById`, tür ve gerekçeyle kaydolur, eksiye düşme 400 ve satır yazmaz. E2E (`admin-people-support-screens.spec.ts`) — `SUPER_ADMIN` olmayan personel gerçek Next ekranında okur, ekler, düşmeyi iptal eder (yazı yok), onaylar, sunucu reddinde form korunur; `FINANCE_LEDGER_READ` olmayan personelde sekme/bağlantı yok ve sayfa `/yetkisiz`.
  - **Kredi tamsayı sınırı (PR #122 incelemesi):** ledger `amount`/`balanceAfter` PostgreSQL `integer`. Sınır `packages/shared/limits.json` → `creditLedgerIntegerMax` (2.147.483.647); admin formu, `ManualCreditTransactionDto` (`@Max`) ve servis aynı değeri okur. Elle ekleme/düşme `runSerializable` ile (yazma çakışmasında yeniden dener, tükenince 409) ve bakiye üst sınırı nihai bakiyenin hesaplandığı transaction içinde denetlenir: aşılırsa 400 `CREDIT_BALANCE_LIMIT_EXCEEDED` (`currentBalance`, `maxBalance` ile), satır yazılmaz. Ortak `createProviderCreditTransactionInTransaction`'da denetim `maxBalanceAfter` ile isteğe bağlıdır; paket satın alma, webhook ve kota yolları değişmedi.
  - Migration, Prisma, env ve compose değişmedi.
- **Test:** `admin-customer-verification`, `customer-activation-proof`, `provider-support-tickets`, `provider-claim`, `provider-business-registration`, `provider-draft-category-binding`, `package-refund-request`.
- **Geri dönüş riski:** Orta-yüksek (ham kayıt no gösterimi ve denetim kaydı korunmalı).

#### Faz 3B görsel karşılaştırma (paket 2, 2026-09-29)

Karşılaştırma, bu PR'ın 1440×1617 Chromium görüntüleriyle yapıldı (`2026-09-29-admin-design-001-faz-3b-screens/`; WebKit 320 örnekleri aynı klasörde). Gerekçe kısaltmaları 3A ile aynı (D, K7, K11, İzin). `/support/[id]` ve `/providers/[id]/credits` tasarımda ekranı olmayan B sınıfıdır; detay şablonuyla kuruldu.

| Görüntü | Uygulandı | Sapma ve gerekçe |
| --- | --- | --- |
| `15-hizmet-verenler` | Başlık + ⓘ + "N işletme · M başvuru karar bekliyor"; kayıtlı görünümler (Tümü, İnceleme bekliyor, Onaylandı, Askıya alındı, Reddedildi) sayfadaki listeden tam sayaçla; filtre çubuğu; tablo: İşletme (+yetkili, maskeli kayıt no, kayıt tarihi) · İletişim · Çalıştığı bölgeler · Hizmetler · Durum (+hesap satırı) · Kredi · Açık teklif · "Aç"; 50'lik sayfalama | **D:** "Elle işletme ekle" yok (operatör oluşturma API'si yok). **K7:** Paket sütunu, Teklifler/Krediler satır bağlantıları korunuyor. Durum dili mevcut sözlük ("Onaylandı"), 3A ile aynı karar. "Kendi hesabı yok" sahiplik filtresinde, görünüm değil (görünümler tek parametreye, `status`'a bağlı) |
| `16-hizmet-veren-detayi-bilgiler` | Geri bağlantısı (izin varsa); özet kartı (durum + hesap rozeti, kayıt tarihi, 27px ad, yetkili · telefon · bölgeler); 5 hücreli şerit; sekmeler; "İşletme bilgileri" satırları; "İş almasını durdur" (onaylı) | **D:** "Belgeler" kartı, "Bu ay verdiği teklif", "Kazanma oranı", "Açık şikayet" yok; yerine Açık teklif, Toplam teklif, Paket alımı. **D:** "Profili düzenle" yok (operatör düzenleme API'si yok). "Kredi ekle" yerine "Krediler" bağlantısı (form kredi ekranında, K4). **K7:** Durum yönetimi (tam form), Hizmet kategorileri, Bölgeler, Sahiplik, İşletme kaydı, Promosyon uygunluğu aynı sekmede. **İzin:** her kart ve düğme kendi izninde |
| `17-hizmet-veren-detayi-kredi` | "Kredi hareketleri" + ⓘ + "Bugünkü bakiye N kredi"; tablo: Tarih · Ne oldu · İlgili kayıt · Yapan · Mevcut · Değişim · Kalan; 6 çip + arama | **İzin:** sekme `FINANCE_LEDGER_READ` ile (F4 satırı). Son 20 hareket (personel ucunun sınırı), altta kredi ekranına bağlantı. "Yapan" sütunu ek (denetim) |
| `18-hizmet-veren-detayi-degerlendirmeler` | Puan + tarih + durum rozeti + yorum kartları, iki kolon | **D:** müşteri adı değerlendirme yanıtında yok; yerine talep no ve kategori. Rozet: şikayet varsa karar durumu, yoksa "Yayında" (uç yalnız yayındakileri döndürür). "Detay" bağlantısı korunuyor |
| — (`16`'da yok) | "Teklifler ve paketler" sekmesi: Son teklifler, Son paket alımları | **K7:** tasarımın düşürdüğü iki tablo |
| `19-hizmet-alanlar` | Başlık + ⓘ + özet; filtre çubuğu; tablo: Müşteri (+"Kayıt:" + tür) · Telefon · E-posta · Doğrulama · Şehir · Talep · Teklif · Kabul · Son talep · Durum · "Aç"; API sayfalaması "N kaydın a–b arası" | **D:** "Excel'e aktar" ve Durum filtresi yok (API'de yok). **K7:** Son talep tarih aralığı, Müşteri tipi, Sıralama/Yön korunuyor ("Son 30 gün" hazır seçimi yerine). **K6:** telefon/e-posta tam gösteriliyor, tasarımda maskeli |
| `20-hizmet-alan-detayi-profil` | Özet kartı (Aktif/Pasif hesap + tür rozeti, kayıt tarihi, ad, iletişim satırı); "Not ekle", "Hesabı pasife al" (onaylı); 5 hücreli şerit; 4 sekme; "Profil ve iletişim" satırları + doğrulama rozetleri; "Hesap erişimi" + ⓘ, bağlantı bloğu, "Bağlantıyı kopyala", "Yeni bağlantı oluştur" | "Şifre belirleme bağlantısı oluştur" başlıkta değil, Hesap erişimi kartında: tek seferlik bağlantı yalnız düğmenin yanında gösterilir, URL/log/önbelleğe girmez. Son oluşturulan bağlantı kalıcı gösterilmez (güvenlik). **D:** "Talep başına", "Eşleşme oranı" notları yok (türetilmiş metrik uydurulmadı) |
| `21-hizmet-alan-detayi-talepler` | "Açtığı talepler" + toplam; Talep no · Hizmet · Konum · Kalite · Durum · Tarih · Teklif · "Aç" | API son 10 talebi döndürür; "Son 10 kayıt · toplam N" yazılır. Kalite puan sayısı değil etiket (yanıtta puan yok, D) |
| `22-hizmet-alan-detayi-teklifler` | "Aldığı teklifler" + "N teklifin K tanesini kabul etti"; Teklif no · Talep · Hizmet veren · Tutar · Durum · Tarih · "Aç" | **K7:** "Kabul ettiği teklifler" tablosu aynı sekmede |
| `23-hizmet-alan-detayi-notlar` | "Operasyon notları"; metin alanı + "Notu ekle"; gri not kartları (yazan + zaman) | **İzin (F7):** sekme `CUSTOMER_NOTES_READ`, form `CUSTOMER_NOTES_WRITE`; izin yoksa yalnız bu sekme gizlenir |
| `24-destek-talepleri` | Başlık + ⓘ + "N talep açık veya işlemde"; kayıtlı görünümler (Tümü, Açık + İşlemde, 4 durum) API'nin masa kapsamlı sayaçlarıyla; filtre çubuğu (Talep sahibi, Durum); tablo: Konu (+kısa no) · Gönderen · Talep sahibi · Geldiği zaman · Son hareket · Durum · "Aç"; sayfalama | **D:** Ara, Tarih filtresi, "Kategori" ve "Bekleme süresi" yok (liste API'si almıyor/döndürmüyor). "Kapanmış talepleri göster" düğmesi yerine "Kapatıldı" görünümü |
| — (`/support/[id]`, şablon) | Özet kartı (masa + durum rozeti, kısa no, konu, talep sahibi); 5 hücreli şerit; Yazışma + Yanıtla solda, Durum + Talep sahibi + Paket ve kredi iadesi sağda; "Talebi kapat" onaylı | N2 düzeltildi: "Hesabı görüntüle" `/users/:id` (yalnız personel, müşteri için 404) yerine hizmet alanda `/customers/:id` (`CUSTOMERS_READ`); hizmet verende bağlantı yok (yanıtta profil kimliği yok, D) |
| — (`/providers/[id]/credits`, şablon) | Özet kartı + 4 hücreli şerit; Dönemsel paketler; İşlem geçmişi; Manuel kredi işlemi; Denetim notu | Düşme onaylı (önce/sonra bakiye); sonuç ve ret form üstünde, ret'te girilenler korunur |

Onay diyalogları ve gerçek etkileri (metinler API koduna göre yazıldı):
- **Hesabı pasife al:** giriş reddedilir, açık oturum bir sonraki istekte düşer, bu telefon/e-postayla misafir talep açılamaz; talepler, teklifler, notlar değişmez.
- **Askıya al / reddet / onaydan çıkarma:** onaysız işletme talep göremez ve teklif veremez; onaylıyken yayındaki vitrin kartları hemen kalkar (ödenmiş süre işler); DRAFT/REJECTED/SUSPENDED'da kullanılmamış claim bağlantıları geçersiz olur; teklif, kredi, geçmiş silinmez; e-posta gitmez.
- **Kategori bağını kaldır:** bu kategorideki talepler işletmeye gösterilmez, hazırlık sayacında sayılmaz; verilmiş teklifler değişmez.
- **Kredi düş:** önce → sonra bakiye; satır gerekçe ve işlemi yapanla kalıcı; yanlış düşme ancak ters işlemle dengelenir.
- **Destek talebini kapat:** kalıcı; iki taraf da yazamaz, yeniden açılamaz; talep sahibine durum e-postası gider.

StickyActionBar bu dilimde kullanılmadı (ekranlardaki formlar tek alanlı eylem formları); Faz 2 entegrasyon kabul kriteri bu PR'a düşmedi.

### 3C — Vitrin ve değerlendirmeler (#15–#24)

- **Tasarım karşılıkları:**
  - `list:reviewReports` (`34`), `list:cardReviews` (`31`), `list:placements` (`32`), `list:leads` (`33`), `list:showcasePackages` (`36`).
  - Şablon kullananlar: `/provider-reviews/[reviewId]`, `/showcase/reviews/[versionId]`, `/showcase/placements/[placementId]`, `/showcase/cards`, `/showcase/price-terms`.
- **Aksiyon kapıları:** `PROVIDER_REVIEWS_MODERATE`, `SHOWCASE_REVIEW_DECIDE`, `SHOWCASE_PACKAGES_WRITE`, `SHOWCASE_PLACEMENTS_MODERATE`, `SHOWCASE_PLACEMENT_CANCEL`.
- **Onay diyaloğu:** değerlendirmeyi kaldır (müşteriye e-posta gider), sürümü reddet, yerleşimi iptal et (geri alınamaz, iade yok).
- **Vitrin paketleri:** satır içi düzenleme kartları, liste + detay/düzenleme modalı desenine taşınır. Form alanları ve slug değişmezliği korunur.
- **Render edilmeyen:** kart askıya al/aç (K9).
- **Test:** `showcase-cards`, `showcase-package-first-flow`, `showcase-package-price`, `showcase-placement-lead`, `showcase-screens-viewport`, `showcase-home-shelf`, `provider-review-flow`.
- **Geri dönüş riski:** Orta.

#### Faz 3C gerçekleşen (2026-09-29)

- **Kapılar (menü · route · bölüm · aksiyon), `route-permission-map.ts` ile karşılaştırıldı:**

  | Route | Route izni | Yazma kapıları (`can()`) | Çapraz bağlantılar |
  | --- | --- | --- | --- |
  | `/provider-reviews/reports` | `PROVIDER_REVIEWS_READ` | — (salt okunur) | işletme `PROVIDERS_READ_DETAIL`, talep `REQUESTS_READ` |
  | `/provider-reviews/[reviewId]` | `PROVIDER_REVIEWS_READ` | kaldır/geri getir ve "Uygun bulundu" `PROVIDER_REVIEWS_MODERATE` | aynı |
  | `/showcase/reviews` | `SHOWCASE_REVIEW_READ` | — | "Tüm vitrin kartları" `SHOWCASE_CARDS_READ` |
  | `/showcase/reviews/[versionId]` | `SHOWCASE_REVIEW_READ` | Onayla/Reddet `SHOWCASE_REVIEW_DECIDE` | işletme `PROVIDERS_READ_DETAIL` |
  | `/showcase/cards` | `SHOWCASE_CARDS_READ` | — (K9: askıya al/aç yok) | "Aç" `SHOWCASE_REVIEW_READ` |
  | `/showcase/leads` | `SHOWCASE_LEADS_READ` | — (kapatma/serbest bırakma kasıtlı yok) | talep `REQUESTS_READ` |
  | `/showcase/packages` | `SHOWCASE_PACKAGES_READ` | Yeni paket + Kaydet `SHOWCASE_PACKAGES_WRITE` | "Metin onayları" `SHOWCASE_TERMS_ACCEPTANCES_READ` |
  | `/showcase/price-terms` | `SHOWCASE_TERMS_ACCEPTANCES_READ` | — (yalnız eklenen defter) | kart `SHOWCASE_CARDS_READ` |
  | `/showcase/placements` | `SHOWCASE_PLACEMENTS_READ` | — | işletme `PROVIDERS_READ_DETAIL` |
  | `/showcase/placements/[placementId]` | `SHOWCASE_PLACEMENTS_READ` | durdur/sürdür `SHOWCASE_PLACEMENTS_MODERATE`; iptal `SHOWCASE_PLACEMENT_CANCEL` | sürüm `SHOWCASE_REVIEW_READ` |

  Menü satırları (`lib/nav.ts`) sayfa izniyle aynı. Tek değişiklik: `/provider-reviews/[reviewId]` kuyruğun alt yolu değil kardeşi olduğu için hiçbir satır yanmıyor, üst bar sayfa adı göstermiyordu; "Şikayet edilen yorumlar" satırına `alsoUnder: '/provider-reviews'` eklendi (aynı izin, `nav.spec.ts` + `access-boundaries.spec.ts` güncellendi). İstemciye izin listesi gitmez: istemci bileşenlerine (moderasyon formu, onay diyalogları, paket penceresi) yalnız sunucunun render etmeye karar verdiği kontroller gelir. İzin yoksa bölüm render edilmez, "yetkiniz yok" notu konmaz.
- **Onay diyalogları ve gerçek etkileri (metinler API koduna göre yazıldı; Esc/Vazgeç/× yazmaz, E2E veritabanında doğrular):**
  - **Yorumu kaldır / Değerlendirmeyi kaldır** (`ProviderReviewModerationService.moderate`): yorum kaldırmada yıldız ortalamada kalır; değerlendirme kaldırmada ortalama ve sayı hemen yeniden hesaplanır. Açık bildirim ilgili kararla kapanır, günlüğe işlemi yapanla yazılır. Talepte e-posta varsa müşteriye yalnız gerekçenin müşteri metniyle e-posta gider (bildiren ve not söylenmez). "Geri getir" ile geri alınır; giden e-posta geri alınamaz. Geri getirme e-posta göndermez ve onay sormaz.
  - **Sürümü reddet** (`AdminShowcaseService.rejectVersion`): **e-posta gitmez** (yalnız onay e-posta gönderir). Yayındaki bir kartın yeni sürümünde yayındaki sürüm, kart durumu, süre ve raflar değişmez; gerekçe kayda geçer ama bugünkü hizmet veren paneli bu notu **göstermez** (açık bulgu, aşağıda). İlk yayın sürümünde kart "Reddedildi" olur, yayın hakkı kartta kalır ve inceleme süresi hakka geri eklenir; gerekçe panelde "İnceleme notu" olarak görünür. Önceki başarı metni "Gerekçe hizmet verene iletildi" iki durumda da gerçeği anlatmıyordu; düzeltildi.
  - **Yerleşimi iptal et** (`AdminShowcasePlacementsService.cancel`): hemen CANCELLED, tüm raflar kapanır, açık durdurma kapanır; geri alınamaz, kalan gün geri verilmez; para iadesi yapılmaz, satın alma `SHOWCASE_PLACEMENT_CANCELLED` ile manuel incelemeye işaretlenir ve not `adminNote`'a yazılır (daha önce işaretlenmişse yazılmaz); e-posta gitmez; kart, sürüm ve gelmiş talepler değişmez; **iptal eden kişi kaydedilmez** (açık bulgu).
- **Vitrin paketleri:** satır içi düzenleme kartları kaldırıldı; liste + "Aç" / "Yeni paket ekle" → URL'ye bağlı pencere (`?paket=<id>` / `?paket=yeni`, `components/route-dialog.tsx`, yerel `<dialog>` + `showModal()`). Aynı alanlar ve aynı server action'lar; slug yalnız oluşturmada yazılır, pencerede salt okunur gösterilir ve gönderilmez. Ret pencereye geri döner (`?paket=…&error=`). Pencere derin bağlantıdır; Geri kapatır, İleri açar; Esc/×/Vazgeç yazmadan kapatır; arka plana tıklama yazılanı atmamak için kapatmaz. `SHOWCASE_PACKAGES_WRITE` yoksa pencere yalnız değerleri gösterir, `?paket=yeni` açılmaz.
- **Eski varsayım düzeltmeleri (güncel koda göre):**
  - EB "`/showcase/cards` ve `/showcase/price-terms` menüde yok": K1 ile ikisi de menüye alınmıştı (`lib/nav.ts`); geçerli değil.
  - EB "`/showcase/placements/[placementId]` `fetchOrNotFound` yok": main'de vardı.
  - EB "`?cardId=` görmezden geliniyor": artık `GET /admin/showcase/cards/:cardId` (mevcut uç, aynı izin) ile tek kart gösteriliyor.
  - Metin onaylarında sürüm çipleri süzülmüş satırlardan türetildiği için bir sürüm seçilince diğerleri kayboluyordu; çipler süzülmemiş okumadan geliyor.
- **API etkisi:** yok. Prisma, migration, `.env`, compose değişmedi. Ekranlar mevcut uçları aynı gövdeyle çağırır; yerleşim ve kart listelerinde `status` API yerine sunucu bileşeninde süzülür (API bu listeleri zaten sayfasız, tamamını döndürüyor), sayaçlar böylece kesin.
- **StickyActionBar kullanılmadı:** paket penceresi Kaydet/Vazgeç'li tek form, diğer yazmalar eylem formları. Faz 2 entegrasyon kabul kriteri bu PR'a düşmedi.
- **Test:** yeni `e2e/tests/admin-showcase-review-screens.spec.ts` (Chromium + WebKit): üç onay diyaloğu için Esc/Vazgeç/× → yazma yok, onay → DB'de beklenen satırlar; beş yazma izninin her biri yalnız kendi kontrolünü açar; salt okunur personel yazma kontrolü görmez; okuma izni olmayan personel 10 route'ta `/yetkisiz`, menüde vitrin satırı yok; paket penceresi derin bağlantı/Geri/İleri/Esc; kayıtlı görünümler URL; 320/390/1440 taşma. Güncellenen: `provider-review-flow` (journeys `moderateReview` diyaloğu onaylar), `showcase-package-first-flow` (ret onayı), `showcase-package-price` (pencere), `admin-route-scan` (`CONVERTED_ROUTES` + 10 route, 320px).

#### Faz 3C görsel karşılaştırma (paket 2, 2026-09-29)

Karşılaştırma bu PR'ın fixture verili 1440×1617 Chromium görüntüleriyle yapıldı (`2026-09-29-admin-design-001-faz-3c-screens/`; WebKit 320 örnekleri aynı klasörde). Gerekçe kısaltmaları 3A ile aynı (D, K7, K9, K11, İzin). Tasarımın ortak liste iskeleti (başlık + ⓘ + tek satır özet + birincil eylem → filtre çubuğu → tablo + "Aç" → alt bilgi) her ekranda uygulandı; ⓘ metinleri prototipten alındı ve gerçek davranışa uymayan cümleler düzeltildi.

| Görüntü | Uygulandı | Sapma ve gerekçe |
| --- | --- | --- |
| `34-sikayet-edilen-yorumlar` | Başlık "Şikayet edilen yorumlar" + ⓘ + "N yorum karar bekliyor · en eski bildirim başta"; Açık/Çözülen kayıtlı görünümleri (tek sayfaysa sayaçlı); tablo: Yorum (alıntı + değerlendirme tarihi) · İşletme · Şikayet gerekçesi · Puan · Bildirim · Durum ("Karar bekliyor" + değerlendirme durumu) · "Aç"; cursor sayfalama | **D:** Ara/Durum/Tarih filtresi yok (API yalnız `state`, `cursor`); yorum altında müşteri adı yok (kuyruk yanıtında yok, detayda var). **K7:** Talep sütunu korunuyor. "Kapanmış şikayetleri göster" düğmesi yerine "Çözülen" görünümü. ⓘ düzeltildi: kararın üç sonucu var, yalnız tüm değerlendirme kaldırılınca ortalama değişir, kaldırmada müşteriye e-posta gider, karar geri alınabilir |
| — (`/provider-reviews/[reviewId]`, şablon) | Özet kartı (geri bağlantısı, durum + "Karar bekliyor" + yıldız rozetleri, talep no · kategori, başlık, müşteri · konum); 5 hücreli şerit (Puan, Durum, Bildirim, Karar, Değerlendirme); Değerlendirme, Talep, Hizmet veren, Bildirimler (+ "Uygun bulundu"), Moderasyon günlüğü | İki kaldırma onaylı (yukarıda). Eski "Dashboard" kırıntısı kaldırıldı (izinsiz bağlantı üretiyordu) |
| `31-vitrin-onay-bekleyen-kartlar` | Başlık "Onay bekleyen kartlar" + ⓘ + "N kart okunmayı bekliyor · en eski gönderim başta"; birincil eylem "Tüm vitrin kartları" (`SHOWCASE_CARDS_READ`); tablo: Kart (+kategori · N. sürüm · ilk yayın / yayındaki metni değiştirir) · İşletme · Tür · İlan ettiği fiyat · Bölge ("N bölge") · Gönderim · "Aç" | **D:** Ara/Durum/Tarih filtresi yok (kuyruk tek durum; API arama/tarih almıyor). **K7:** Durum sütunu korunuyor. Önceki/Sonraki yok: API kuyruğun tamamını döndürür, alt bilgi "N sürüm, tamamı gösteriliyor" |
| — (`/showcase/reviews/[versionId]`, şablon) | Özet kartı (inceleme + kart durumu rozetleri, "N. sürüm · kategori", başlık, işletme · merkez); şerit (Kart türü, İlan ettiği fiyat, Bölge, Yanıt taahhüdü, Gönderim); İşletme, Yayın hakkı, yan yana sürüm karşılaştırması, otomatik yayın, verilmiş karar, Karar | Ret onaylı; onay metni ilk yayın / revizyona göre değişir. Başarı metinleri e-posta gerçeğine göre düzeltildi |
| — (`/showcase/cards`, C) | Liste şablonu: başlık + ⓘ + "N kart · M onaylı · K tanesinin sürümü incelemede"; 7 durum görünümü kesin sayaçla; tablo: Kart · İşletme · Tür · İlan ettiği fiyat · Durum (+askı/arşiv zamanı) · Güncelleme · "Aç" (bekleyen → canlı → son reddedilen sürüm) | **K9:** askıya al/aç yok. `?cardId=` tek kartı gösteriyor |
| `33-vitrinden-gelen-talepler` | Başlık + ⓘ (birebir doğru) + "N talep · en yeni başta"; 6 görünüm; tablo: Talep (no + kategori · konum + kalite · tarih) · İşletme (+"Yalnız bu işletmeye açık / Genel pazara açık") · Kart (+sürüm) · Aciliyet (+taahhüt) · Dönüş süresi (+aşıldı/dönüş zamanı) · Durum (+müşteri kararı) · "Aç" (talep) | **D:** "Bu ay 38 talep · 4 tanesi süre aşıldı" yok (API son 200 kaydı sayısız döndürür; aylık sayı üretilmedi); görünümlerde sayaç yok; "Kalan: 1 saat" geri sayımı yok (önbellekli render bayat süre yazardı); Ara/Tarih yok. Alt bilgi 200 sınırına ulaşıldığında "En yeni 200 talep" der. "Süresi aşılanları göster" → "Süre doldu" görünümü |
| `36-vitrin-paketleri` | Başlık + ⓘ + "N paket satışta · M kapalı"; "Yeni paket ekle" (`SHOWCASE_PACKAGES_WRITE`) + "Metin onayları"; tablo: Paket (+açıklama, oluşturma) · Kısa ad · Yayın bedeli · Süre · Geçerlilik · Kart tipi · Bölge · Durum · "Aç"; detay/düzenleme penceresi | **D:** Ara/Durum/Tarih filtresi yok (API almıyor; katalog birkaç satır). Tasarımın "Aç" hedefi `soon`du; pencere olarak kuruldu. Listeleme sırası "Gelişmiş ayarlar"da korunuyor |
| — (`/showcase/price-terms`, C) | Liste şablonu: başlık + ⓘ + "N onay · M metin sürümü"; sürüm görünümleri (süzülmemiş okumadan, sınır altındaysa sayaçlı); işletme/kart süzgeci notu; tablo: İşletme · Kapsam · Kart (etiketli tür/durum) · Sürüm · Onaylayan · Onay zamanı · Onaylanan metin | Kart türü/durumu ham enum yerine etiket. Her tablo 200 ile sınırlı; sınıra ulaşılınca alt bilgi ve özet "en yeni" der |
| `32-vitrin-yayinda-olan-kartlar` | Başlık + ⓘ + "N kart yayında · M tanesi durdurulmuş" (tam listeden); 6 görünüm kesin sayaçla; tablo: Kart (+kategori) · İşletme · Paket (+bedel) · Yayın süresi (başlangıç → bitiş + durum satırı) · Gelen talep · Durum (+sebep ve sayaç durumu) · "Aç" | **D:** "N gün kaldı" geri sayımı yok (yukarıdaki gerekçe); yerine durdurma zamanı, uzatma günü, tamamlandı/iptal zamanı. Ara/Tarih yok. "Durdurulmuşları göster" → "Yayında değil" görünümü. ⓘ düzeltildi: iptal "iade konuşulur" değil; geri alınamaz, otomatik iade yok, satın alma manuel incelemeye işaretlenir; yalnız operatör/sistem durdurmaları sayacı durdurur |
| — (`/showcase/placements/[placementId]`, şablon) | Özet kartı (durum rozeti, sebep/iptal zamanı, başlık, işletme · tür · kategori); şerit (Paket, Yayın bedeli, Başlangıç, Bitiş, Gelen talep); Yerleşim, Durdurma geçmişi, Sürüm değişiklikleri, Yayından kaldır, Yayına al, Yerleşimi iptal et | İptal onaylı. "İptal zamanı" satırı eklendi (alan vardı, gösterilmiyordu) |

### 3D — Finans, paketler ve iadeler (#25–#32)

- **Tasarım karşılıkları:**
  - `finance` (`25`), `list:ledger` (`26`), `manual` (`27`), `list:balances` (`28`), `list:purchases` (`29`).
  - Şablon kullananlar: `/package-purchases/[id]`, `/package-refunds`, `/package-refunds/[id]`.
- **Aksiyon kapıları:**
  - `PACKAGE_PURCHASE_STATUS_WRITE`.
  - Paket iadesinde `allowedActions` **tek kaynak kalır**; UI ek `can()` eklemez, çünkü API zaten izin + maker/checker'ı hesaplıyor.
  - Finans üst bağlantıları `FINANCE_LEDGER_READ` / `OFFER_REFUND_SCAN_READ` ile kapılanır (F12).
  - Ödeme sağlayıcı kartı `PAYMENTS_CONFIG_READ` ile kapılanır (F3; ADMIN-DESIGN-000 yapılmadıysa burada).
- **Onay diyaloğu:** normal iade onayı, istisna onayı, reddet, ödeme başarısız kaydı, paket satın alma durum düzeltmesi.
- **Finans özeti:**
  - Tasarımın 4 KPI'ı üstte, mevcut diğer bölümler altta (K7). Aylık çubuk grafik, mevcut analytics uçlarından `groupBy=month` ile kurulabilir.
  - "Satılan kredi nereye gitti" kırılımı ve "Rapor indir" render edilmez.
- **Manuel işlemler:** K4 kararına göre. Varsayılan: liste kalır, form hizmet veren kredi ekranında kalır, bu ekranda "İşletme seç → kredi ekranına git" bağlantısı olur.
- **Test:** `package-refund-request`, `provider-package-purchase-detail`, `lemon-checkout`, `purchase-terms-checkout`, `offer-packages`, `provider-promo-credits`.
- **Geri dönüş riski:** Yüksek (para hareketi). Onay diyaloğu eklemek dışında akış değişikliği yok.

#### Faz 3D gerçekleşen (2026-09-29)

- **Eski bulgular güncel main'de (`fd64edbe`) koddan doğrulandı; hiçbiri için yeni iş gerekmedi:**
  - F2: `/finance/manual-adjustments` hem menüde hem sayfada `FINANCE_LEDGER_READ` (ADMIN-DESIGN-000).
  - F3: ödeme sağlayıcı kartı `can('PAYMENTS_CONFIG_READ')` ile; izin yoksa liste açılır, kart çizilmez.
  - F4: PR #114 personel okuma uçlarıyla kapalıydı (3B).
  - F12: `/finance` üst ve hızlı bağlantıları hedef sayfanın izniyle kapılıydı; 3D E2E ile sabitlendi.
- **Kapılar (menü · route · bölüm · aksiyon), `route-permission-map.ts` ile karşılaştırıldı; hiçbiri değişmedi:**

  | Route | Route izni | Bölüm / bağlantı kapıları | Yazma |
  | --- | --- | --- | --- |
  | `/finance` | `FINANCE_READ` | Kredi hareketleri ve elle işlemler `FINANCE_LEDGER_READ`; paket satışları `PACKAGE_PURCHASES_READ`; iade kontrolü `OFFER_REFUND_SCAN_READ`; kredi paketleri `CREDIT_PACKAGES_READ`; hizmet verenler `PROVIDERS_READ`; işletme `PROVIDERS_READ_DETAIL`; kayıt bağlantıları `gateLedgerSource` | — |
  | `/finance/credit-ledger` | `FINANCE_LEDGER_READ` | Finans özeti `FINANCE_READ`; ilgili kayıt `CAMPAIGNS_READ` / `OFFERS_READ` / `PACKAGE_PURCHASES_READ` | — |
  | `/finance/manual-adjustments` | `FINANCE_LEDGER_READ` | "Yeni düzeltme" kartı `CREDITS_GRANT` ∨ `CREDITS_DEDUCT`; "İşletme seç" `FINANCE_READ` | — (K4: form `/providers/[id]/credits`'te) |
  | `/finance/providers` | `FINANCE_READ` | Kredi ekranı / hareketler / elle işlemler `FINANCE_LEDGER_READ` | — |
  | `/package-purchases` | `PACKAGE_PURCHASES_READ` | Ödeme sağlayıcı kartı `PAYMENTS_CONFIG_READ`; işletme `PROVIDERS_READ_DETAIL` | — |
  | `/package-purchases/[id]` | `PACKAGE_PURCHASES_READ` | İşletme `PROVIDERS_READ_DETAIL`; kredi geçmişi `FINANCE_LEDGER_READ` | İptal / süresi doldu `PACKAGE_PURCHASE_STATUS_WRITE`, yalnız PENDING ve açık kredi vakası yokken |
  | `/package-refunds` | `PACKAGE_REFUND_READ` | — | — |
  | `/package-refunds/[id]` | `PACKAGE_REFUND_READ` | Destek talebi `SUPPORT_READ` | Yalnız API'nin `allowedActions`'ı; UI `can()` eklemez |

- **Onay diyalogları ve gerçek etkileri (API koduna göre; Vazgeç/Esc/× yazmaz, E2E veritabanında doğrular):**
  - **Normal / istisna iade onayı** (`PackageRefundRequestsService.approve`): APPROVED_PENDING_SETTLEMENT; TakTic'te para ve kredi hareket etmez, dış iade sağlayıcı panelinde tam tutarla yapılır; uygunluk onay transaction'ında yeniden hesaplanır; SETTLED yalnız imzalı iade bildirimiyle; hizmet verene durum e-postası (gerekçesiz).
  - **Reddet** (`reject`): REJECTED, para/kredi hareketi yok, gerekçe hizmet verene gösterilmez, durum e-postası gider.
  - **Ödeme iadesi tamamlanamadı** (`markSettlementFailed`): SETTLEMENT_FAILED, hareket yok, sonradan gelen kanıtlı bildirim yine tamamlayabilir, durum e-postası gider.
  - **Bekleyen satın almayı İptal / Süresi doldu** (`updateAdminPurchaseStatus`): geri dönüşsüz; para/kredi hareketi yok; sonradan tamamlanan ödeme kredi yüklemez (webhook yalnız PENDING'i işler); not mevcut yönetici notunun yerine geçer; yalnız iptal edilen *vitrin* satın alması hizmet verene e-posta gönderir. Tek form, iki düğme; `status` basılan düğmenin değeri.
  - **İşleme al** onaysız kaldı: karar değil, geri dönüşü olan bir durum geçişi (yine de hizmet verene durum e-postası gider).
- **Bulunan ve bu PR'da düzeltilen hata:** formda `name="id"` gizli alanı `form.id`'yi gölgeliyor; React 19 basılan düğmenin name/value'sunu FormData'ya eklerken geçici input'a `form="[object HTMLInputElement]"` yazıyor ve değer düşüyor. Satın alma düzeltme formunun alanı `purchaseId` oldu. `ConfirmDialog`'un `name`/`value` desteği, `id` adlı alan taşıyan başka bir formda aynı şekilde sessizce kaybolur; bileşen düzeyinde koruma ayrı bir iş olarak önerildi.
- **API etkisi:** yok. Prisma, migration, `.env`, compose değişmedi. `/finance`'ta aylık çubuklar mevcut `/finance/analytics` ucuna ikinci bir `groupBy=month` okumasıyla kuruldu. `PackagePurchase.kind` admin tipine eklendi (API zaten döndürüyordu).
- **StickyActionBar kullanılmadı:** formlar kısa eylem formları; Faz 2 entegrasyon kabul kriteri bu PR'a düşmedi.
- **Test:** yeni `e2e/tests/admin-finance-package-screens.spec.ts` (Chromium + WebKit) ve `apps/admin/test/finance-package-screens.spec.tsx`; güncellenen `package-refund-request` (onay/ret/tamamlanamadı diyalogları, salt okunur personel, 6 genişlik), `lemon-checkout` (vaka rakamları, OPEN'da iki düğme de yok), `admin-route-scan` (`CONVERTED_ROUTES` + 8 route, 320px).

#### Faz 3D görsel karşılaştırma (paket 2, 2026-09-29)

Görüntüler `e2e/.artifacts/faz-3d-screens/` altında (1440×1617 ve 320). Gerekçe kısaltmaları 3A ile aynı (D = backend yok, K7 = bilgi korunur, İzin).

| Görüntü / prototip | Uygulandı | Korunan (gerçek veri) | Uygulanmayan (gerekçe) |
| --- | --- | --- | --- |
| `25-finans-ozeti` / `finance` | Başlık + ⓘ (düzeltildi: gelir kredi *ve* vitrin paketi) + dönem satırı; 4 KPI (Tahsilat, Harcanan, İade edilen, Elle düzeltme); "Aylık tahsilat" 6 ay çubuk (gerçek `groupBy=month`, son ay vurgulu); "Son paket satışları" + "Tümünü gör" | K7: dönem seçici/gruplama, tahsilat trendi + 3 içgörü, paket satışları, kredi kullanımı, operasyonel müdahale, tüm zaman tahsilat/kredi, 6 paket durum sayacı, son kredi hareketleri, hızlı bağlantılar | D: "Satılan kredi nereye gitti", "Rapor indir", "geçen aya göre %" (önceki dönem okuması yok) |
| `26-kredi-hareketleri` / `list:ledger` | Liste şablonu; Tarih · İşletme · Ne oldu · İlgili kayıt · Önceki · Değişim · Sonraki | K7: Sebep (+not) ve İşlemi yapan sütunları; 9 tip, arama, tarih aralığı, `providerId` sabitleme, 50'lik sayfa | D: "Excel'e aktar", "Bu ay … harcandı" satırı (ledger okuması dönem toplamı taşımaz) |
| `27-elle-kredi-ekle-dus` / `manual` | Başlık + ⓘ (form bu ekranda değil diye düzeltildi); "Yeni düzeltme" kartı gerçek kredi ekranına bağlanır; Tümü/Ekleme/Düşme görünümleri | K7: denetim notu, arama, tarih, `providerId`, tüm sütunlar | K4: form taşınmadı |
| `28-isletme-bakiyeleri` / `list:balances` | Liste şablonu, "Aç" = kredi ekranı | K7: 11 sütun (tablo kendi kabında kayar), 9 alanlı sıralama, arama | D: "Bu ay harcadığı", "Son teklif", Durum/Tarih filtresi, "Excel'e aktar" |
| `29-paket-satislari` / `list:purchases` | Liste şablonu; satın alma no + tarih, paket, kredi, tutar, ödeme rozeti, "Aç" | Açık kredi vakası uyarısı (filtreden bağımsız sayım) + satır rozeti, manuel inceleme uyarısı + satır rozeti, ödeme sağlayıcı kartı (listenin altında), `status`/`creditHold` alanları, `providerId`/`packageId` sabitleme; liste sayfasız olduğundan `WholeListFooter` | D: Ara/Tarih filtresi, "Bu ay 96 satış" (FINANCE_READ verisi), "Excel'e aktar" |
| — `/package-purchases/[id]` (şablon) | Özet kartı + şerit (Tutar, Kredi, Ödeme, Kredi teslimi, Oluşturulma) | "Tahsilat · kredi teslimi" kartı (tahsil edilen / teslim edilecek / teslim edilen ayrı), sağlayıcı bildirimleri, zaman çizgisi, notlar | — |
| — `/package-refunds` (tasarımda yok) | Liste şablonu, durum görünümleri API sayaçlarıyla | 8 sütun, 25'lik sayfa, `?status=` | — |
| — `/package-refunds/[id]` (tasarımda yok) | Özet kartı + şerit; 7 bölüm detay ızgarasında | Uygunluk ×3, kararlar, denetim kaydı | — |

### 3E — Kampanyalar, uygunluk ve operasyon ayarları (#33–#37, #45)

- **Tasarım karşılıkları:** `campaigns` (`45`), `settings` (`44`). Şablon kullananlar: `/campaigns/new`, `/campaigns/[id]`, `/promotion-eligibility*`.
- **Aksiyon kapıları:**
  - Kampanya: `CAMPAIGNS_WRITE` (yeni taslak, revizyon), `CAMPAIGNS_LIFECYCLE` (etkinleştir, durdur, sürdür, bitir, taslağı kapat), `CAMPAIGN_REDEMPTION_REVOKE`, `CAMPAIGN_EVENT_RETRY`.
  - Operasyon ayarları: `OPERATIONS_SETTINGS_WRITE`, `SCHEDULERS_WRITE`, `MARKETPLACE_PUBLISH_WRITE`, `PROVIDER_REVIEWS_SETTING_WRITE`, `CAMPAIGN_ENGINE_TOGGLE` (mevcut).
- **Onay diyaloğu:** bitir, taslağı kapat, hak edişi geri al, uygunluk kararı (kesin), motor aç/kapat (mevcut onay kutusu diyaloğa taşınır), zamanlanmış iş açma.
- **Operasyon ayarları (K5):**
  - Yalnız gerçek 9 ayar render edilir: iade süresi (saat), otomatik yayın, değerlendirmeler, kampanya motoru ve 6 zamanlanmış iş. Her biri tasarımın "ad + durum rozeti + açıklama + 'Kapatırsam ne olur?'" satırı olarak.
  - Kayıt ayar başına kalır. Tek yapışkan çubuk kullanılmaz, çünkü her ayar ayrı izin ve ayrı denetim satırı taşır.
  - 5 denetim tablosu "Neler oldu" bölümünde korunur.
- **Kampanyalar:** "Bir kampanya üç sorudan oluşur" kartı statik metindir. Tanım formu ve terimler (`lib/campaign-rules.ts` `TRIGGER_LABELS`) tasarım diline çevrilir, **veri anahtarları değişmez**.
- **Test:** `admin-campaign-drafts`, `admin-campaign-lifecycle`, `admin-campaign-operations`, `admin-campaign-engine-toggle`, `admin-campaign-channel`, `scheduler-settings`, `request-auto-publish`.
- **Geri dönüş riski:** Yüksek (motor anahtarı ve kampanya yaşam döngüsü).

#### Faz 3E gerçekleşen (2026-09-30)

- **Kapsam:** `/campaigns`, `/campaigns/new`, `/campaigns/[id]`, `/promotion-eligibility`, `/promotion-eligibility/[eventId]`, `/operations-settings` (görevdeki `/operations/settings`; koddaki route budur). Taban `main@a4a288e4`, DB 82 migration.
- **Kapılar (menü · route · bölüm · aksiyon), `route-permission-map.ts` ile karşılaştırıldı; hiçbiri değişmedi:**

  | Route | Route izni | Bölüm / bağlantı kapıları | Yazma |
  | --- | --- | --- | --- |
  | `/campaigns` | `CAMPAIGNS_READ` | "Ayarlara git" ve Operasyon Ayarları bağlantısı `OPERATIONS_SETTINGS_READ` | "Yeni kampanya yaz" `CAMPAIGNS_WRITE` |
  | `/campaigns/new` | `CAMPAIGNS_WRITE` + `CAMPAIGNS_READ` | aynı | Doğrula `CAMPAIGNS_READ`, kaydet `CAMPAIGNS_WRITE` (API) |
  | `/campaigns/[id]` | `CAMPAIGNS_READ` | İşletme `PROVIDERS_READ_DETAIL`; kredi hareketleri `FINANCE_LEDGER_READ`; ayarlar `OPERATIONS_SETTINGS_READ` | Revizyon `CAMPAIGNS_WRITE` (ENDED değilken); etkinleştir/duraklat/devam/sonlandır/taslağı kapat `CAMPAIGNS_LIFECYCLE`; geri al `CAMPAIGN_REDEMPTION_REVOKE` (yalnız GRANTED); kuyruğa al `CAMPAIGN_EVENT_RETRY` (yalnız `retryable` ve motor açık) |
  | `/promotion-eligibility` | `PROMOTION_ELIGIBILITY_REVIEW` | İşletme `PROVIDERS_READ_DETAIL` | — |
  | `/promotion-eligibility/[eventId]` | aynı | İşletme `PROVIDERS_READ_DETAIL`; aday kampanya `CAMPAIGNS_READ` | Karar: aynı izin, yalnız `review` yok ve olay `HELD_FOR_REVIEW` iken |
  | `/operations-settings` | `OPERATIONS_SETTINGS_READ` | Talep bildirimleri `REQUEST_REPORTS_READ`; değerlendirme bildirimleri `PROVIDER_REVIEWS_READ`; kampanyalar `CAMPAIGNS_READ` | İade süresi `OPERATIONS_SETTINGS_WRITE`; otomatik yayın `MARKETPLACE_PUBLISH_WRITE`; değerlendirmeler `PROVIDER_REVIEWS_SETTING_WRITE`; motor `CAMPAIGN_ENGINE_TOGGLE`; işler `SCHEDULERS_WRITE` |

- **Onay diyalogları ve gerçek etkileri (API koduna göre; Vazgeç/Esc/× yazmaz, E2E veritabanında doğrular):**
  - **Sonlandır** (`CampaignsService.end`, ACTIVE/PAUSED → ENDED): kalıcı; yeni hak ediş üretilmez; verilmiş lotlar etkilenmez; gerekçe denetim satırına. Motor ya da kanal okunmaz.
  - **Taslağı kapat** (aynı `end` rotası, DRAFT → ENDED): hiç etkinleşmeden kalıcı kapanış; hak ediş, promosyon kredisi, olay oluşmaz; `fromStatus: DRAFT` denetim satırı.
  - **Hak edişi geri al** (`revokeRedemption` → `CampaignRevokeService`): lotun kullanılmamış kredisi bakiyeden düşülür, harcanan kısım kayda geçer, borç oluşmaz; UTC gün sayacı artar, çalışan sürümün `maxRevokesPerDay` eşiği aşılırsa kampanya kendini duraklatır (AUTO_PAUSED). E-posta yok.
  - **Uygunluk kararı** (`PromotionEligibilityReviewsService.decide`, serializable): tek seferlik ve kesin; ELIGIBLE olayı bir kez PENDING'e alır (kredi vermez, limitler ve motor anahtarı yine geçerli), INELIGIBLE olayı EVALUATED yapar ve `PROMOTION_INELIGIBLE` günlük satırı yazar. İkinci/eşzamanlı karar 409. E-posta yok.
  - **Kampanya motoru aç/kapat**: onay kutusu diyaloğa taşındı. Server action'ın `confirm=yes` kuralı değişmedi; alan yalnız hydration sonrası form'a eklenir, böylece JS'den önceki bir tıklama (eskiden işaretsiz kutu) yine reddedilir.
  - **Zamanlanmış işi açma**: iş sıradaki cron çalışmasında devreye girer; iki para işi (`entitlement-renewal`, `unviewed-offer-refund`) diyalogda para/kredi hareketini yazar. Kapatma onaysız kaldı (yalnız sıradaki çalışmayı durdurur).
  - Onaysız kalanlar: etkinleştir / duraklat / devam ettir (geri dönüşü olan geçişler), kuyruğa al, otomatik yayın ve değerlendirme anahtarları (yalnız sonraki talepleri/görünürlüğü etkiler, iki yönde de geri alınır), iade süresi kaydı (yalnız yeni teklifler).
- **ConfirmDialog + `name="id"` denetimi (PR #125 bulgusu):**
  - Kök neden React 19.2'de doğrulandı (`createFormDataWithSubmitter`: `form.id && temp.setAttribute("form", form.id)`).
  - 3E formlarının hiçbirinde `id` adlı alan yok (`campaignId`, `targetId`, `eventId`, `job`, `enabled`). Tüm admin'de `id` alanı taşıyan formlarda adlı submit düğmesi ya da `name/value`'lu ConfirmDialog kalmadı.
  - Yine de ortak bileşen güvenli hale getirildi: `ConfirmDialog.confirm()` gölgelenmiş `form.id`'yi (`shadowedFormId`) algılarsa düğmenin name/value'sunu yalnız o senkron `requestSubmit` süresince gizli bir alanla taşır, sonra kaldırır. Gölgelenme yoksa davranış birebir aynı.
  - Regresyon: `admin-form-components` harness'ine `/confirm-shadowed` ekranı; düzeltme kapatıldığında test düştü, açıkken Chromium + WebKit geçti. Birim testi 3E dosyalarında `name="id"` olmadığını kaynak düzeyinde de sabitler.
- **Ortak bileşen eki:** `ConfirmDialog`'a isteğe bağlı `switchChecked` (tetik tasarımın anahtarı olarak, `role="switch"`, `aria-checked`, `aria-haspopup` yok). Verilmediğinde tetik değişmedi.
- **Operasyon ayarları (K5):** yalnız gerçek ayarlar: iade süresi, otomatik yayın, değerlendirmeler, kampanya motoru ve API'nin listelediği 6 iş. Her biri ad + durum rozeti + açıklama + "ne olur" (native `<details>`) + kendi kontrolü. Tek kaydet çubuğu yok; her satır kendi formu, izni ve denetim satırıyla kaydolur. 5 denetim tablosu "Neler oldu" altında, test kimlikleri ve boş cümleleriyle korunur.
- **Kampanyalar:** "Bir kampanya üç sorudan oluşur" statik kartı; tanım formu aynı üç başlık altında gruplandı. `TRIGGER_LABELS` ve veri anahtarları, form alan adları ve gönderilen tanım değişmedi.
- **API etkisi:** yok. Prisma, migration, `.env`, compose değişmedi.
- **StickyActionBar kullanılmadı:** ayarlar ayar başına kaydolur (K5); kampanya formu kendi Doğrula/Kaydet düğmelerini taşır.
- **Yeni bulgular (bu PR'a genişletilmedi):**
  - `GET /admin/promotion-eligibility/holds` `take: 100` ile keser, sayfa/cursor ve toplam döndürmez. 100'den fazla bekleyen olduğunda eski ekran da yeni ekran da fazlasını gösteremez. Yeni ekran listenin 100'de kesildiğini açıkça yazar; sayfalama API işi.
  - `GET /admin/campaigns` yalnız `nextCursor` döndürür (toplam ve önceki cursor yok); liste "bu sayfada N kampanya" ve "İlk sayfa / Sonraki sayfa" ile sınırlı kalır.
- **Test:** yeni `e2e/tests/admin-campaign-settings-screens.spec.ts` (Chromium + WebKit) ve `apps/admin/test/campaign-settings-screens.spec.tsx`; güncellenen `admin-campaign-lifecycle` (sonlandır diyaloğu, Vazgeç yazmaz), `admin-campaign-channel` (taslağı kapat diyaloğu), `admin-campaign-operations` (geri al diyaloğu, Vazgeç yazmaz), `admin-campaign-engine-toggle` (diyalog iki yönde), `scheduler-settings` (iş açma diyaloğu, 320px), `provider-business-registration` (karar diyaloğu, Vazgeç yazmaz), `admin-form-components` (`/confirm-shadowed`), `admin-route-scan` (`CONVERTED_ROUTES` + 6 route).

#### Faz 3E görsel karşılaştırma (paket 2, 2026-09-30)

Görüntüler `e2e/.artifacts/faz-3e-screens/` altında (1440×1617 ve 320). Gerekçe kısaltmaları 3A ile aynı (D = backend yok, K7 = bilgi korunur, İzin).

| Görüntü / prototip | Uygulandı | Korunan (gerçek veri) | Uygulanmayan (gerekçe) |
| --- | --- | --- | --- |
| `45-kampanyalar` / `campaigns` | Başlık + ⓘ, "Yeni kampanya yaz"; motor bandı + "Ayarlara git"; "Bir kampanya üç sorudan oluşur" (metin motorun gerçek davranışına göre yazıldı); tablo: Kampanya · Kimi kapsıyor · Ne veriyor · Hak ediş · Sürüm · Son değişiklik · Durum · Aç | K7: anahtar, tetikleyici, kanal, kredi/gün, çalışan ve son sürüm, kuyruk satırı | Tasarım örnekleri "30 gündür teklif vermeyen", "sınır dolunca kendiliğinden durur" (motorda böyle koşul/davranış yok); "3 kampanya" toplamı (D: cursor listesi toplam taşımaz) |
| — `/campaigns/new` (şablon) | Geri bağlantı, başlık + ⓘ (eski yan kart), motor bandı, form üç soru başlığıyla | 8 alan grubu, alan hataları, "Kaydetmek etkinleştirmez" | — |
| — `/campaigns/[id]` (şablon) | Özet kartı + şerit (çalışan/son sürüm, kanal, hak ediş, verilen kredi, son değişiklik); sürüm/hak ediş/kuyruk tabloları; "Neler oldu" zaman çizgisi | Çalışan kural, bekleyen revizyon, 13 sütunlu sürüm geçmişi, revizyon formu, yaşam döngüsü paneli, "bu ekranda yapılamayanlar" | — |
| — `/promotion-eligibility` (tasarımda yok) | Liste şablonu; Bekleyen / Karar verilen kayıtlı görünüm; "Aç" | 6 sütun | Karar verilenler sayacı (D: bu istek yalnız seçili görünümü getirir) |
| — `/promotion-eligibility/[eventId]` (tasarımda yok) | Özet kartı (karar rozeti) + şerit; olay, değişmez gerekçeler, karar | Karar formu, gerekçe kuralları | — |
| `44-operasyon-ayarlari` / `settings` | Başlık + açıklama; gruplar (Talep akışı · Teklif kredisi · Değerlendirme ve kampanyalar · Zamanlanmış İşler · Neler oldu); satır = ad + durum rozeti + açıklama + "ne olur" + kontrol | İade süresi (min/max/varsayılan, hizmet verene gösterilen metin), iş cron'u ve son çalışma, para işi uyarısı, 5 denetim tablosu | K5: "talep 14 gün", "hatırlatma 7. gün", "teklif 3 kredi", "en fazla 5 teklif", "aynı işletme tekrar teklif" (ayar değil); "Yorumlar yayından önce okunsun" (gerçek anahtarın anlamı farklı, gerçek metinle çizildi); tek "Değişiklikleri kaydet" çubuğu ve "Son değişiklik" satırı (ayar başına kayıt + ayrı izin) |

### 3F — Katalog (#38–#43)

- **Tasarım karşılıkları:** `list:categories` (`35`), `list:creditPackages` (`37`). Formlar şablonla kurulur.
- **Aksiyon kapıları:**
  - Kategori: `CATEGORIES_WRITE`, `CATEGORIES_STATUS`, `UPLOADS_WRITE`.
  - Soru: `QUESTIONS_WRITE` (soru seti editörü `QUESTIONS_READ` yoksa gizli, F8).
  - Davet: `PROVIDER_INVITES_READ/ISSUE/REVOKE`.
  - Kredi paketi: `CREDIT_PACKAGES_WRITE`, `CREDIT_PACKAGES_STATUS`. Satış özeti `PACKAGE_PURCHASES_READ` ile (F9).
- **Kategori ağacı:** tasarımın düz tablosu yerine derinlik girintisi korunur; "Yayına hazır mı?" sütunu eklenir.
- **Test:** `category-expansion`, `category-release-readiness`, `category-supply-status`, `category-wave-2-drafts`, `provider-invite-links`, `offer-packages`.
- **Geri dönüş riski:** Yüksek (`/categories/[slug]` soru ve koşul editörü).

#### Faz 3F envanter (dönüşümden önce, `main@4d83f64f`, DB 82 migration)

Dönüşüm bu tabloya karşı yapıldı; her satır dönüşümden sonra da aynı koşulla render edilmek zorunda. İzin adları `route-permission-map.ts` ile karşılaştırıldı.

**`/categories/[slug]`** — route `CATALOG_READ`. Okumalar: `GET /admin/categories/:slug` (`fetchOrNotFound`), `GET /admin/categories` (üst kategori ve yönlendirme hedefi seçicileri), `GET /categories/:id/questions` yalnız `QUESTIONS_READ` ile, `GET /categories/:id/provider-invites` yalnız hizmet (LEAF) + `PROVIDER_INVITES_READ` ile.

| Bölüm / kontrol | Render koşulu | Yazma ucu (izin) | Test tutamağı |
| --- | --- | --- | --- |
| Künye: durum, tip, slug, üst kategori / üst seviye, soru sayısı, sıra, arz durumu | her zaman; soru sayısı yalnız `QUESTIONS_READ`; arz durumu `supplyStatus` varsa | — | `supply-status` |
| Kategori formu (isim, slug, tip, üst kategori, sıra, başvuru anahtarı, limitsiz paket uygunluğu, teklif kredisi, açıklama, 2 görsel, ikon) | `CATEGORIES_WRITE` | `PATCH /categories/:id` (`CATEGORIES_WRITE`, durum için `orInstead CATEGORIES_STATUS`) | "Kategoriyi kaydet", `provider-enrollment-open`, `unlimited-package-eligible` |
| Formdaki durum seçimi | `CATEGORIES_STATUS` varsa açık; yoksa kilitli + gizli `status` ve `statusLocked=1` (API'ye durum gönderilmez) | aynı | `select[disabled]` |
| Başvuru anahtarı | yalnız LEAF + DRAFT'ta değiştirilebilir; ACTIVE'de işaretli + kapalı; INACTIVE/grup/yönlendiricide kapalı | payload yalnız LEAF + DRAFT'ta gönderir | `provider-enrollment-open` |
| Limitsiz paket uygunluğu | INACTIVE'de kapalı ve payload'a girmez | — | `unlimited-package-eligible` |
| Teklif kredisi | LEAF'te zorunlu; diğerlerinde kapalı, payload'a girmez | — | — |
| Görsel yükleme düğmesi | `UPLOADS_WRITE` (URL alanı her zaman) | `POST /admin/uploads/category-image` (`UPLOADS_WRITE`) | "Dosya yükle" |
| Salt okunur kategori bilgileri | `CATEGORIES_WRITE` yok | — | `category-read-only` |
| Yönlendirme hedefleri kartı | ROUTER + `QUESTIONS_READ`; yönlendirme sorusu varsa `QUESTIONS_WRITE` ile form, yoksa salt okunur liste; soru yoksa boş durum (ipucu yalnız yazma izniyle) | `PUT /questions/:id/router-rules` (`QUESTIONS_WRITE`) | "Yönlendirmeyi kaydet", `routerTargetSlug` |
| Soru seti (satır: sıra, etiket + sistem alanı / yönlendirme / koşullu rozetleri, key, tip, zorunlu, durum) | `QUESTIONS_READ` | — | `details.question-row` |
| Soru düzenleme formu | `QUESTIONS_READ` ∧ `QUESTIONS_WRITE` | `PATCH /questions/:id` | "Soruyu kaydet" |
| Koşul editörü (kaynak soru, beklenen cevaplar `kaynak::seçenek`, eşleşme kuralı; ALL yalnız çok seçimli kaynak varken) | aynı | `PUT /questions/:id/conditions` | "Koşulu kaydet", `option[value="ALL"]` disabled |
| Soruyu aktifleştir / pasifleştir | aynı | `PATCH /questions/:id/status` | "Pasifleştir" / "Aktifleştir" |
| Salt okunur soru ayrıntısı (sistem alanı, yardım metni, seçenekler, koşul) | `QUESTIONS_READ`, yazma yok | — | — |
| Yeni soru ekle | `QUESTIONS_READ` ∧ `QUESTIONS_WRITE` | `POST /categories/:id/questions` | `details.question-create-panel`, "Soruyu oluştur" |
| Kategori durumu paneli | `CATEGORIES_STATUS` | `PATCH /categories/:id/status` | "Kategori durumu", "Durumu güncelle" |
| Hizmet veren daveti paneli (geçmiş, sayaç) | LEAF + `PROVIDER_INVITES_READ` | — | `provider-invite-panel`, `provider-invite-count`, `provider-invite-list` |
| Davet üret | `PROVIDER_INVITES_ISSUE` ve durum ≠ INACTIVE; INACTIVE'de "kapalı" notu | `POST /categories/:id/provider-invites` | `provider-invite-create`, `provider-invite-closed` |
| Bağlantı bir kez gösterilir (yalnız action sonucu, URL/çerez/listede yok) | davet üretildiğinde | — | `provider-invite-issued`, `provider-invite-url` |
| Daveti iptal et | `PROVIDER_INVITES_REVOKE` ve davet ACTIVE | `POST …/provider-invites/:inviteId/revoke` | `provider-invite-revoke-<id>`, `provider-invite-revoked` |
| Yayın kontrol listesi (teklif kredisi, onaylı hizmet veren, soru sayısı `QUESTIONS_READ`, geçerli davet "hazır sayılmaz", başvuru durumu, hazır mı) + engel gerekçeleri | DRAFT; liste yalnız LEAF | — | `draft-explainer`, `release-checklist`, `release-active-invites`, `enrollment-note`, `release-blockers`, `release-blocker-<kod>` |
| Yönlendirici açıklaması | ROUTER | — | `router-explainer` |
| Hızlı bilgi (soru sırası, options JSON, koşul sırası, sistem alanı) | her zaman | — | — |

UI'sı olmayan ve açılmayacak yetenekler (K9): `DELETE /categories/:id` (`CATEGORIES_DELETE`), `DELETE /questions/:id` (`QUESTIONS_DELETE`).

**`/categories`** — route `CATALOG_READ`, tek okuma `GET /admin/categories`. "Yeni Kategori" `CATALOG_READ` + `CATEGORIES_WRITE`. Yayın hazırlığı kartı (taslak hizmetler, filtreden bağımsız, hazırlar önce; 8 sütun: hizmet, üst grup, soru, teklif kredisi, onaylı hizmet veren, geçerli davet, arz durumu + başvuru notu, hazır mı + gerekçeler; `release-readiness-summary`, `release-row-<slug>`, `release-invites-<slug>`, `supply-status-<slug>`, `enrollment-note-<slug>`, `release-blocker-<kod>`). Filtre `q` (ad/slug) ve `status` (eski `active`/`inactive` değerleri eşlenir). Ağaç (`category-tree-table`): derinlik girintisi, filtrelenmiş ağaçta üstü düşen satır kök olarak kalır; 10 sütun (görsel, ad bağlantısı, slug, tip, durum, teklif kredisi, soru, onaylı hizmet veren, sıra, düzenle).

**`/categories/new`** — route `CATALOG_READ` + `CATEGORIES_WRITE`; `UPLOADS_WRITE` yükleme düğmesi. 12 alan (isim, sıra, teklif kredisi, tip, durum, üst kategori yalnız GROUP, slug deseni, açıklama, 2 görsel, ikon); `createCategoryAction` → `/categories/<slug>`. Yan kart: sıradaki adım ve ipuçları.

**`/credit-packages`** — route `CREDIT_PACKAGES_READ`, `GET /admin/offer-packages` (üç tür). "Yeni Paket" ve sıra ↑/↓ `CREDIT_PACKAGES_WRITE` (↑ ilk satırda, ↓ son satırda kapalı; kanonik sıra sortOrder → ad → id; takas iki PATCH, ikincisi düşerse `partial=1` uyarısı); aktif/pasif `CREDIT_PACKAGES_STATUS` (`redirectTo=/credit-packages`). Filtre `q`, `status` (all/active/inactive); `ok`/`error` bildirimleri; özet "N / M kayıt · A aktif · P pasif". 9 sütun: sıra, paket + slug, tür (+ limitsiz kapsamı veya "Kapsam tanımsız", dönem günü), kredi/kota/"Limitsiz" (+ günlük sınır), fiyat, para birimi, durum, güncellenme, işlem (Düzenle/Görüntüle).

**`/credit-packages/new`** — route `CREDIT_PACKAGES_READ` + `CREDIT_PACKAGES_WRITE`; uygun kategori listesi `GET /admin/offer-packages/unlimited-eligible-categories`. 12 alan (isim, sıra, slug, tür, kredi, aylık kota, günlük teklif limiti, limitsiz kapsamı çoklu seçim veya "açılmış kategori yok" notu, para birimi TRY/USD/EUR, fiyat lira deseni, durum, açıklama). Doğrulama hatasında girilen değerler URL'den geri yazılır.

**`/credit-packages/[id]`** — route `CREDIT_PACKAGES_READ`; paket `fetchOrNotFound`; uygunluk listesi (kapsamda olup artık uygun olmayan kategori de seçenek olarak kalır, yoksa kayıt kapsamı düşürürdü). Form `CREDIT_PACKAGES_WRITE` (tür gizli alanla gönderilir, düzenlenemez; türe göre kredi / aylık kota / günlük limit + kapsam; para birimi mevcut değer listede yoksa eklenir; fiyat `formatMinorAsTurkishLiraInput`; durum `CREDIT_PACKAGES_STATUS` yoksa kilitli + `statusLocked`); yoksa salt okunur (`credit-package-read-only`). Satış özeti `PACKAGE_PURCHASES_READ` (4 sayı, son 5 satın alma, işletme bağlantısı `PROVIDERS_READ_DETAIL`, "Tüm satın almaları gör (N)"). Durum paneli `CREDIT_PACKAGES_STATUS` ("Paketi pasifleştir/aktifleştir"). Künye: durum, slug, tür, kredi/kota/limitsiz, dönem, fiyat, sıra, güncellenme.

#### Faz 3F gerçekleşen (2026-09-30)

- **Kapsam:** yalnız yukarıdaki 6 route. Taban `main@4d83f64f`, DB 82 migration. API, Prisma, migration, `.env`, compose değişmedi; yeni yazma yeteneği yok; server action'lar (`categories/actions.ts`, `credit-packages/actions.ts`) ve gönderdikleri alanlar dokunulmadan kaldı.
- **Kapılar (menü · route · bölüm · aksiyon), `route-permission-map.ts` ile karşılaştırıldı; hiçbiri değişmedi.** Envanterdeki her satır aynı koşulla çizilir; birim testi sayfa kaynağındaki `requireAdmin`/`can()` kapılarını da sabitler.

  | Route | Route izni | Bölüm / bağlantı kapıları | Yazma |
  | --- | --- | --- | --- |
  | `/categories` | `CATALOG_READ` | — | "Yeni kategori ekle" `CATALOG_READ` + `CATEGORIES_WRITE` |
  | `/categories/new` | `CATALOG_READ` + `CATEGORIES_WRITE` | — | Oluştur `CATEGORIES_WRITE`; yükleme `UPLOADS_WRITE` |
  | `/categories/[slug]` | `CATALOG_READ` | Soru seti ve yönlendirme haritası `QUESTIONS_READ`; davet paneli LEAF + `PROVIDER_INVITES_READ` | Form `CATEGORIES_WRITE` (durum seçimi `CATEGORIES_STATUS`, yoksa `statusLocked`); yükleme `UPLOADS_WRITE`; soru/koşul/durum/yeni soru/yönlendirme `QUESTIONS_READ` ∧ `QUESTIONS_WRITE`; durum paneli `CATEGORIES_STATUS`; davet üret `PROVIDER_INVITES_ISSUE` (INACTIVE değilken); iptal `PROVIDER_INVITES_REVOKE` (ACTIVE davet) |
  | `/credit-packages` | `CREDIT_PACKAGES_READ` | — | "Yeni paket ekle" ve ↑/↓ `CREDIT_PACKAGES_WRITE`; Aktifleştir/Pasifleştir `CREDIT_PACKAGES_STATUS` |
  | `/credit-packages/new` | `CREDIT_PACKAGES_READ` + `CREDIT_PACKAGES_WRITE` | — | Oluştur `CREDIT_PACKAGES_WRITE` |
  | `/credit-packages/[id]` | `CREDIT_PACKAGES_READ` | Satış özeti `PACKAGE_PURCHASES_READ` (F9); işletme bağlantısı `PROVIDERS_READ_DETAIL` | Form `CREDIT_PACKAGES_WRITE` (durum `CREDIT_PACKAGES_STATUS`, yoksa `statusLocked`); durum paneli `CREDIT_PACKAGES_STATUS` |

- **`/categories/[slug]` bölünmesi:** sayfa veriyi yükler ve izinleri hesaplar; editörler `[slug]/category-sections.tsx` içinde birebir taşındı (alan adları, gizli alanlar, `kaynak::seçenek` koşul değerleri, ALL'un yalnız çok seçimli kaynakta açılması, yönlendiricide `isRouter` gizli `false`, başvuru ve limitsiz uygunluk anahtarlarının durum kuralları). Aksiyonlar prop olarak geçer; böylece her izin kombinasyonu oturumsuz birim testiyle çizilir. Salt okunur görünümler `KeyValueList`'e taşındı, içerik aynı.
- **Korunan karmaşık işlevler:** kategori ağacı (derinlik girintisi + sol çizgi, üstü filtrelenen satır kök olarak kalır), filtreden bağımsız yayın hazırlığı kartı (8 sütun, gerekçeler satırda), soru seti editörü (satır içi açılır düzenleme, koşul editörü, aktif/pasif, yeni soru), yönlendirme kuralları (form / salt okunur / boş durum), davet paneli (bağlantı yalnız action sonucunda bir kez görünür; URL, çerez veya listede yok), yayın kontrol listesi (davet "hazır sayılmaz", başvuru durumu, engel gerekçeleri), kredi paketlerinde kanonik sıra ↑/↓ (iki PATCH, `partial=1` uyarısı), aktif/pasif, üç paket türü (kapsam, dönem, günlük sınır), paket formunda tüm alanlar ve doğrulama hatasında girilen değerlerin URL'den geri yazılması.
- **Onay diyaloğu eklenmedi:** plan 3F için diyalog listelemiyor ve bu ekranlardaki yazmalar ya geri alınabilir (durum, aktif/pasif, sıra) ya da mevcut akışın parçası. Davet iptali geri alınamaz; ancak yeni bağlantı her zaman üretilebilir ve akış E2E'lerle sabit. İstenirse ayrı karar.
- **StickyActionBar kullanılmadı:** kategori ekranında aynı sayfada birbirinden bağımsız 6+ form var (kategori, yönlendirme, soru başına 3 form, yeni soru, durum, davet); tek bir kayıt çubuğu bunlardan yalnız birini kaydeder ve yanıltır. Paket formu başarısızlıkta `?error=` ile yönlendirir; çubuğun "reddedilen kayıtta değerler korunur" sözü action sözleşmesini değiştirmeden verilemez. Faz 2 entegrasyon kabul kriteri bu PR'a düşmedi.
- **Metinler:** tasarımın ⓘ'ları gerçek davranışa göre düzeltildi. Kategoriler: "Yayına hazır" soru seti istemez ve durumu değiştirmez, yalnız kontrol listesidir; müşteriyi gizleyen durumdur; kapatma vitrin yayınlarını süre durdurularak askıya alır. Kredi paketleri: aylık kota takvim ayı değil satın almadan itibaren 30 gündür ve devretmez; limitsiz paketin günlük sınırı isteğe bağlıdır; sıra hizmet verene listelenme sırasıdır. "Slug" etiketleri "Kısa ad (slug)" oldu; "provider" kalıntıları "hizmet veren".
- **CSS (yalnız bu ekranlar):** `/categories/[slug]`'da telefon düzeninde soru satırının 720px taban genişliği kaldırıldı (≤900px iki sütun). WebKit, seçili seçeneği uzun olan bir `<select>`'in metnini kutusu sığsa da sayfa genişliğine katıyordu (uzun üst kategori adıyla 320px'te +731px); form alanlarına küçülebilir iz verildi ve dolgulu kart gövdelerine `contain: paint` kondu (select'e `overflow: hidden` macOS WebKit'te yetti, CI'ın Linux WebKit'inde yetmedi; +704px). Ana ve yan sütun `minmax(0, 1fr)`.
- **Yeni bulgular (bu PR'a genişletilmedi):**
  - `/providers/[id]` (3B): boşluksuz çok uzun bir kategori adı, işletmenin kategori listesinde 320/390px'te sayfayı genişletiyor (rota taraması bu PR'ın ilk uzun-ad fixture'ıyla yakaladı; fixture gerçekçi, boşluklu ada çevrildi). Gerçek kategori adlarında düşük olasılık; ayrı UI işi.
  - Backend açığı yeni değil, bilinenler: kredi paketi sırası için toplu/atomik uç yok (takas iki PATCH, ikinci adım düşerse UI `partial=1` der); `GET /categories/:id/provider-invites` ve `GET /package-purchases?packageId=` sayfasız (satış özeti tüm satın almaları okuyup istemcide toplar); `_count.questions` pasif soruları da sayar (detay şeridi "N aktif" notunu soru listesinden hesaplar).
- **Test:** yeni `e2e/tests/admin-catalog-screens.spec.ts` (Chromium + WebKit: kategori ekranında 5 izin kombinasyonu, paket listesinde okuma/yazma/durum ayrımı ve gerçek sıra takası + pasifleştirme, 3 tür, 6 genişlikte taşma, açık soru satırı) ve `apps/admin/test/catalog-screens.spec.tsx` (27 test: form/soru/yönlendirme/kontrol listesi/paket hücreleri, kaynak düzeyinde kapılar); güncellenen `admin-status-permission` (durum paneli test kimliğiyle), `offer-packages` (tür metni paket satırına daraltıldı; ⓘ de türleri anıyor), `admin-route-scan` (`CONVERTED_ROUTES` + 6 route, 320px), `playwright.config` (WebKit eşleşmesi).

#### Faz 3F görsel karşılaştırma (paket 2, 2026-09-30)

Görüntüler `e2e/.artifacts/faz-3f-screens/` altında (1440×1617 ve 320). Gerekçe kısaltmaları 3A ile aynı (D = backend yok, K7 = bilgi korunur, İzin).

| Görüntü / prototip | Uygulandı | Korunan (gerçek veri) | Uygulanmayan (gerekçe) |
| --- | --- | --- | --- |
| `35-hizmet-kategorileri` / `list:categories` | Başlık + ⓘ (düzeltildi) + "N kategori · M tanesi yayında"; "Yeni kategori ekle"; filtre çubuğu (Ara, Durum); tablo: Kategori adı (+ "X altında" / "N alt kategori") · Kısa ad · Tip · Teklif kredisi · Soru sayısı · Onaylı hizmet veren · Yayına hazır mı? · Aç; liste sonu | K7: ağaç girintisi, görsel, Durum ve Sıra sütunları; yayın hazırlığı kartı (8 sütun, gerekçeler); filtrelenmiş ağaç | Tarih filtresi (kategoride filtrelenecek tarih yok); Önceki/Sonraki (API listeyi bütün döndürür); "Üst grup" tip adı (mevcut sözlük "Grup") |
| `37-kredi-paketleri` / `list:creditPackages` | Başlık + ⓘ (düzeltildi) + "N paket satışta · M pasif"; "Yeni paket ekle"; filtre çubuğu; tablo: Sıra (↑/↓ + sayı) · Paket (+ kısa ad) · Tür (+ kapsam / dönem) · Kredi / kota (+ günlük) · Fiyat · Durum · Güncellenme · Aç | K7: Para birimi sütunu, satır içi Aktifleştir/Pasifleştir, `ok`/`error`/`partial` bildirimleri | "En çok satan" (D: satın alma listesi ayrı okuma, `PACKAGE_PURCHASES_READ`); Tarih filtresi; Önceki/Sonraki |
| — `/categories/new` (şablon) | Geri bağlantı, başlık + ⓘ (eski yan kartlar), form kartı | 12 alan, 2 yükleyici | — |
| — `/categories/[slug]` (şablon) | Özet kartı (durum/tip/arz rozetleri, kısa ad · üst kategori, başlık, tip açıklaması) + şerit (Tip, Teklif kredisi, Soru + aktif, Onaylı hizmet veren, Geçerli davet, Sıra); ana sütun editörler, yan sütun masa | Envanterdeki tüm bölümler | — |
| — `/credit-packages/new` (şablon) | Geri bağlantı, başlık + ⓘ (eski yan kartlar), form kartı | 12 alan, tür kuralları | — |
| — `/credit-packages/[id]` (şablon) | Özet kartı (durum, kısa ad, başlık, limitsiz kapsamı) + şerit (Tür + dönem, Kredi/kota + günlük sınır, Fiyat, Sıra, Güncellenme); satış özeti şeridi + tablo | Form, salt okunur görünüm, satış özeti, durum paneli, hatırlatmalar | — |

### 3F.1 — Katalog detay ekranları, sekmeli tasarım (2026-09-30)

- **Taban:** `main@327e847d`, DB 83 migration. API, Prisma, migration, `.env`, compose değişmedi. Referans: yeni Claude Design detay görüntüleri (kategori ×4 sekme, kredi paketi ×3, vitrin paketi ×3).
- **Sekmeler** mevcut `Tabs` bileşeniyle bağlantıdır (`?tab=`): okunamayan sekme çizilmez, URL ile istenirse ilk sekme açılır. Soru aksiyonları yönlendirme yapmadığından (yalnız `revalidatePath`) kayıttan sonra Sorular sekmesinde kalınır; kategori/paket formu düz URL'ye (ilk sekme) döner.
  - `/categories/[slug]`: Kategori bilgileri (form + taslakta yayın kontrol listesi + `CATEGORIES_STATUS` durum masası + yönlendirici açıklaması) · Sorular (`QUESTIONS_READ`; yönlendirme haritası + soru tablosu: Sıra · Soru · Cevap tipi · Zorunlu · Ne zaman sorulur · Durum · Düzenle; satır içi editör aynen) · Hizmet veren davetleri (LEAF + `PROVIDER_INVITES_READ`; tablo) · Neler oldu.
  - `/credit-packages/[id]`: Paket bilgileri (form; tür kilitli alan + aynı gizli `type`; "Paketin diğer türleri") · Satışlar (`PACKAGE_PURCHASES_READ`; özet şeridi + son 5 + satın alma no bağlantısı) · Neler oldu. Aktifleştir/Pasifleştir yan panelden özet kartına taşındı (aynı form, aynı test kimliği).
  - `/showcase/packages/[id]` (**yeni rota**): gerçek `GET /admin/showcase/packages/:packageId` (`SHOWCASE_PACKAGES_READ`). Paket bilgileri (eski `?paket=<id>` penceresinin alanları ve aksiyonu; "Satışta" onay kutusu aynı payload'u gönderen Durum seçimi oldu; sıra alanı görünür) · Satışlar ve yayınlar (`PACKAGE_PURCHASES_READ`) · Neler oldu. Başlıkta Metin onayları (`SHOWCASE_TERMS_ACCEPTANCES_READ`) ve Satıştan kaldır/Satışa aç (`SHOWCASE_PACKAGES_WRITE`, aynı PATCH, yalnız `isActive`). Liste "Aç" buraya gider; eski `?paket=<id>` bağlantıları yönlendirilir; `?paket=yeni` penceresi listede kaldı. Kayıt/ret aksiyonları detaya döner.
- **"Neler oldu":** kategori, soru, kredi paketi ve vitrin paketi tablolarında değişiklik günlüğü yok. Sekme yalnız kayıtların kendi zamanlarını gösterir (oluşturuldu, son güncellendi, soru eklendi, davet oluşturuldu/kullanıldı/iptal/süresi doldu); "Yapan" yalnız davet üreten kişi kayıtlıysa dolar, aksi halde "Kayıtlı değil". Dipnot bunu açıkça söyler. Referanstaki "Fiyat 2.200 → 2.400" gibi fark satırları uygulanmadı (D).
- **Uygulanmayan (gerekçe):** kategori "Arama motoru içeriği" kartı (D: editoryal içerik alanları yok, B4); "Müşteri sayfasını aç" (admin'de web adresi yapılandırması yok); kategori Tip/Kısa ad "Değiştirilemez" (bugün formda düzenlenebilir, işlev kaybı olurdu); davetlerde "Davet edilen" sütunu (D: davet kişiye bağlı değil); vitrin satırında "Kalan gün" ve "Hakkı kullanılmayan" (D: hak durumu admin satın alma projeksiyonunda yok → "Yayına bağlanmamış" = ödenmiş ve yayını olmayan); güncellemeyi yapan kişi (D).
- **Backend açıkları (ayrı iş):** (1) katalog tabloları için değişiklik günlüğü (alan farkı + yapan); (2) `GET /package-purchases` vitrin paketi filtresi yok — Satışlar ve yayınlar sekmesi listeyi bütün okuyup süzer, bu yüzden yalnız o sekme açıkken okunur ve sekme sayacı yalnız orada görünür; (3) satın alma projeksiyonunda vitrin hakkı (entitlement) durumu yok; (4) davet iptalini yapan kişi saklanmıyor.
- **Test:** yeni `apps/admin/test/detail-screens.spec.tsx`; `access-boundaries` (53 rota); E2E `admin-catalog-screens` (sekme kapıları, geçmiş, taşma: sekmeler + davet satırı), `admin-showcase-review-screens` (detay rotası, eski bağlantı, Vazgeç, kayıt, durum anahtarı, satış sekmesi, 768 eklendi), `showcase-package-price`, `admin-route-scan` (+ `/showcase/packages/[id]`), `category-expansion`, `provider-invite-links`, `category-wave-2-drafts` (sekme URL'leri), `category-supply-status` (kayıt sonrası gezinme yarışı DB yoklamasıyla beklendi).

### 3G — Sistem ve yönetim (#44, #47–#52)

(#46 `/notifications` Dilim 2'de yapıldı.)

- **Tasarım karşılıkları:** `company` (`48`), `list:admins` (`47`). Şablon kullananlar: `/notifications/[id]`, `/users/new`, `/users/[id]`, `/roles`, `/roles/[id]`.
- **Aksiyon kapıları:**
  - `COMPANY_SETTINGS_WRITE`, `NOTIFICATION_RETRY`, `ADMIN_USERS_STATUS`.
  - Kök yetkiler (`/users/new`, davet bağlantısı, rol atama, `/roles*`) yalnız `isSuperAdmin` ile (F10, F11).
- **Onay diyaloğu:** kullanıcıyı pasife al, rolü pasifleştir, rol geri al, izin matrisi kaydı (etkilenen hesap sayısı yazılır).
- **Roller:** izin matrisi 82 izni alanlara göre gruplar. `adminPermissionLabel` metinleri korunur; `<code>` etiketi ikincil satırda kalır.
- **Test:** `admin-rbac-permissions` (rol oluşturma ve atama), `admin-session`, `notification-history`.
- **Geri dönüş riski:** Yüksek (yetki tanımlama yüzeyi).

#### Faz 3G gerçekleşen (2026-09-30)

- **Kapsam:** `/company-settings`, `/notifications/[id]`, `/users/new`, `/users/[id]`, `/roles`, `/roles/[id]`. Taban `main@f294ffd8`, DB 83 migration. API, Prisma, migration, `.env`, compose değişmedi. Server action'lar (`company-settings/actions.ts`, `notifications/actions.ts`, `users/actions.ts`, `roles/actions.ts`) ve gönderdikleri alanlar aynı; `/users` listesi bu dilimde değişmedi.
- **Kapılar (hiçbiri değişmedi; birim testi kaynaktan sabitler):**

  | Route | Route kapısı | Bölüm / aksiyon |
  | --- | --- | --- |
  | `/company-settings` | `COMPANY_SETTINGS_READ` | Form `COMPANY_SETTINGS_WRITE`, yoksa salt okunur `KeyValueList` |
  | `/notifications/[id]` | `NOTIFICATION_LOGS_READ` | "Yeniden gönder" `retryable` ∧ `NOTIFICATION_RETRY`; talep bağlantısı `REQUESTS_READ` |
  | `/users/new` | `requireSuperAdmin()` | Oluştur (root) |
  | `/users/[id]` | `ADMIN_USERS_READ` | Durum `ADMIN_USERS_STATUS` (kendi aktif hesabında yok); davet kartı ve rol okumaları/kontrolleri yalnız `isSuperAdmin` |
  | `/roles`, `/roles/[id]` | `requireSuperAdmin()` | Tüm yazmalar root |

- **Onay diyalogları (ortak `ConfirmDialog`):**
  - Hesabı pasifleştir (`/users/[id]`): giriş ve açık oturumların bir sonraki istekte reddi, açık oturum sayısı (`metrics.activeSessionCount`), hiçbir şeyin silinmediği; süper admin hedefinde "son aktif süper yönetici" kuralı. Aktifleştir doğrudan.
  - Rol geri al (`/users/[id]` Roller kartı): hesabın **gerçekten** kaybedeceği izinler = rolün izinlerinden hesabın diğer canlı ∧ aktif rollerinde olmayanlar (`permissionsLostOnRevoke`, kartın zaten okuduğu `GET /admin/users/:id/roles`'tan). Pasif rolde "yetki değişmez".
  - İzin matrisi kaydı (`/roles/[id]`): eklenecek/kaldırılacak izinler (etiket + `<code>`), kayıttan sonraki toplam, **etkilenen hesap sayısı** = `GET /admin/roles/:id` → `assignments` (API `revokedAt: null` ile yalnız canlı atamaları döndürür) uzunluğu ve bunların `user.isActive` sayısı. Rol pasifse "şu an kimseyi etkilemez", atama yoksa sayı yazılmaz. Değişiklik yokken tetik kapalı.
  - Rolü pasifleştir (`/roles/[id]`): aynı taşıyan sayısı ve kaybedilecek izin sayısı. Eski onay kutusu kalktı; action'ın `confirm=on` kuralı aynen duruyor — alan yalnız hydration sonrası eklenir (Faz 3E motor anahtarı deseni), JS öncesi tıklama reddedilir. Aktifleştir doğrudan.
- **Rol matrisi:** `groupPermissions` tüm kataloğu (`GET /admin/permissions`, 84 izin, 29 alan) `adminPermissionLabel` alanına göre gruplar; Türkçe etiket + ikincil satırda `<code>` korunur. Alan başlığında canlı "seçili/toplam", üstte genel sayaç. Kutular kontrolsüz ve adları aynı (`permissions`), form JS'siz de aynı veriyi gönderir. `adminPermissionLabel`'a yalnız eksik `CATALOG: 'Katalog'` alanı eklendi (önceden ham `CATALOG` başlığı altında görünüyordu).
- **Tuzak (bulundu, çözüldü):** form `reset` sonrası React'ın değer izleyicisi eski kalıyor; reset öncesi değiştirilmiş bir kutuyu yeniden işaretlemek `onChange`'e ulaşmıyor. Matris sayaçları yerel `change` dinleyicisiyle okunur.
- **StickyActionBar kullanılmadı:** şirket formu reddedilen kayıtta değerleri URL'ye taşıyarak yönlendirir; çubuğun "kaydedilmemiş" durumu yönlendirme sonrası doğruyu söyleyemez. Formun kendi bandı (`DetailFormFooter`: Vazgeç = reset, "Değişiklikleri kaydet"). Faz 2 entegrasyon kabul kriteri bu PR'a düşmedi.
- **Uygulanmayan (gerekçe):** `company` tasarımındaki "faturalarda ve yasal metinlerde" (değerler yalnız e-posta altbilgisi) ve "— destek e-postası güncellendi" (hangi alanın değiştiğini tutan günlük yok, D); rol/kullanıcı ekranlarında "Neler oldu" (D, aşağıda).
- **Backend açıkları (ayrı iş, bu PR'a genişletilmedi):** (1) `AdminRoleAudit` satırları yazılıyor ama okuma ucu yok — rol ve atama geçmişi panelde gösterilemiyor; (2) personel durum değişikliği (`PATCH /users/:id/status`) için yapan/zaman kaydı okunamıyor; (3) şirket ayarlarında alan bazlı değişiklik günlüğü yok (yalnız son `updatedAt/updatedBy`).
- **Test:** yeni `apps/admin/test/system-screens.spec.tsx` (16) ve `e2e/tests/admin-system-screens.spec.ts` (6; Chromium + WebKit, iptal = yazma yok, onay = tek yazma, DB'den gerçek sayılar, 320/390/768/1440 taşma, 320'de diyalog); `admin-rbac-permissions` (+ /roles'ta rol oluştur → kullanıcıya ata → personel bölümü görür → onaylı geri al → /yetkisiz); `admin-route-scan` (`CONVERTED_ROUTES` + 6); `playwright.config` WebKit eşleşmesi.

### 3H — Genel görünüm (#1)

En sona bırakıldı, çünkü K2 ve K12 kararlarına bağlı.

- "Önce bunlara bak" hücreleri yalnız mevcut özet alanlarından (başvuru, şikayet, destek) ve **ilgili okuma izni varsa** render edilir. Vitrin hücresi, özet ucu genişletilene kadar yoktur.
- 4 KPI mevcut metriklerden seçilir. Değişim yüzdesi ve sparkline yalnız veri kaynağı varsa gösterilir.
- "Sistem şu anda ne yapıyor" bölümü `OPERATIONS_SETTINGS_READ` varsa operasyon ayarları okumalarından türetilir.
- "Panelde son yapılanlar" render edilmez.
- `dashboard-metrics.ts` rozet tonu kuralı korunur.
- **Test:** `admin-dashboard-metrics`, `dashboard-metrics.spec.ts`.
- **Geri dönüş riski:** Orta.

#### Faz 3H gerçekleşen (2026-09-30)

- **Kapsam:** yalnız `/`. Taban `main@7ab05d66`, DB 83 migration. API, Prisma, migration, `.env`, compose değişmedi. Referans `01-genel-gorunum` (paket 2–4 aynı dosya).
- **Veri kaynakları (hepsi mevcut uçlar):** `GET /dashboard/admin-summary` (`DASHBOARD_READ`, `buildAdminDashboardMetrics` üzerinden); `GET /auth/me` (`name`); `GET /admin/me/permissions`; `OPERATIONS_SETTINGS_READ` varsa operasyon ekranının okuduğu beş uç (`/operations-settings`, `/schedulers`, `/marketplace-publish`, `/provider-reviews`, `/campaign-engine`). Tarih/saat sunucu saatinden, `Europe/Istanbul`.
- **Karşılama:** "{Günaydın|İyi günler|İyi akşamlar|İyi geceler}, {ad}" (hesabın `name` alanının ilk kelimesi; ad yoksa yalnız selam, e-posta kullanılmaz) + "30 Eylül, Çarşamba". Eylemler: "Talepleri incele" (`REQUESTS_READ`), "Operasyon ayarları" (`OPERATIONS_SETTINGS_READ`). Bekleyen iş toplamı yazılmaz (bildirim + başvuru + destek farklı birimler; hiçbir liste bu toplamı göstermez).
- **Önce bunlara bak (K2):** hücre yalnız hedef listeyi açma izni varsa; hiç hücre yoksa kart yok.

  | Hücre | Özet alanı | Hedef (aynı sözleşme) | İzin |
  | --- | --- | --- | --- |
  | Başvuru · Onay bekleyen işletme | `pendingProviders` (PENDING_REVIEW) | `/providers?status=PENDING_REVIEW` (tam liste, aynı eşitlik) | `PROVIDERS_READ` |
  | Şikayet · Karar bekleyen talep bildirimi | `openRequestReports` (bildirim başına, `resolvedAt: null`) | `/requests/reports?state=open` — satır talep başınadır; "Bildirim" sütunu toplamı = sayı | `REQUEST_REPORTS_READ` |
  | Destek · Açık destek talebi | `openSupportTickets` (OPEN + IN_PROGRESS) | `/support?status=OPEN,IN_PROGRESS` | `SUPPORT_READ` |

  Vitrin hücresi yok (özette sayaç yok). Renk yalnız `dashboard-metrics` tonu `warning` iken (sayı > 0); 0 düz mürekkep, "dikkat" yok.
- **4 KPI:** Toplam talep (`/requests`), Toplam teklif (`/offers`), Onaylı hizmet veren (`/providers?status=APPROVED`), Paket satın alma (`/package-purchases`); etiket bağlantısı hedef izni varsa. Kalan eylem sayıları KPI alt notunda, tam durum görünümüne bağlı ve aynı ton kuralıyla: "N onay bekliyor" (`/requests?status=SUBMITTED`), "N incelemede" (`?status=IN_REVIEW`), "N iade adayı" (`/refund-scan`). `dashboard-metrics.ts` bağlantıları bu görünümlere çekildi (bekleyen/incelemedeki talep, bekleyen hizmet veren).
- **Sistem şu anda ne yapıyor:** otomatik yayın, kampanya motoru, değerlendirmeler (Açık/Kapalı), görüntülenmeyen teklif iade süresi (nötr rozet "N saat", kaydedilmemişse "Varsayılan değer"), API'nin listelediği her zamanlanmış iş (Açık/Kapalı; son çalışma kaydı varsa zaman + sonuç, FAILED ise hata tonu). "Kapalı" operasyon ekranındaki gibi sönük (tasarımdaki kırmızı değil).
- **Render edilmeyen (K12):** KPI değişim yüzdeleri ve sparkline, "Son 7 gün" grafiği, "N dakika önce güncellendi", "Panelde son yapılanlar", vitrin hücresi, "E-posta ve bildirim gönderimi — son 24 saatte N bildirim" satırı, bekleyen iş toplamı, "Hızlı işlemler" yığını (tasarımda yok; menü aynı yerlere gider).
- **Backend açıkları (ayrı iş):** (1) özet ucunda onay bekleyen vitrin kartı sayacı yok; (2) talep/teklif/eşleşme/kredi satışı için zaman serisi yok (değişim %, sparkline, 7 gün); (3) global denetim akışı yok ("Panelde son yapılanlar"); (4) özette bildirilen *talep* sayısı yok (yalnız bildirim sayısı) — liste satır sayısı ile kutu sayısı birebir değil, sütun toplamıyla eşit; (5) zamanlanmış iş son çalışması süreç belleğinde (yeniden başlatmada kaybolur); (6) `/refund-scan` `limit` ile keser — "iade adayı" sayısı 100'ü aşarsa ekran aynı kümeyi tek sayfada göstermez.
- **Tuzak (bulundu, çözüldü):** ilk tam Chromium koşusunda `provider-claim` girişten sonra `/`'de hata ekranı gördü; API logu `P2037 too many clients already`. 10 çekirdekte Prisma havuzu süreç başına 21, E2E ~6 API süreci → 126 > yerel `max_connections` 100; özet (10 paralel sayım) ile beş ayar okumasını aynı anda başlatmak tepeyi aştırdı. Okumalar sıralı yapıldı (önce özet, sonra ayarlar). Ortam sınırı ayrıca not: paylaşılan Postgres'te E2E havuz toplamı zaten sınırda.
- **Ekranlar:** `docs/superpowers/plans/2026-09-30-admin-design-001-faz-3h-screens/` (Chromium + WebKit, 320/390/768/1440).
- **Test:** yeni `apps/admin/test/dashboard-overview.spec.tsx`; `dashboard-metrics.spec.ts` (+ bağlantı sözleşmesi); E2E `admin-dashboard-metrics` yeniden yazıldı (0/pozitif ton kuralı, destek/başvuru/şikayet/bekleyen talep → filtreli liste DB ile, K2 üç personel rolü, 320/390/768/1440 + ⓘ), WebKit `testMatch`'e eklendi; `admin-route-scan` `CONVERTED_ROUTES` + `/`.

---

## Dilim 4 — Çapraz E2E, responsive ve erişilebilirlik denetimi

- **RBAC matrisi:**
  - `admin-rbac-permissions.spec.ts` genişletilir. Tek izinli roller (her `*_READ` için bir rol), yazma iznisiz okuyucu ve süper admin.
  - Her dönüştürülmüş ekranda doğrulananlar: menü satırı görünürlüğü, route erişimi (`/yetkisiz`), bölüm görünürlüğü, yazma düğmesi yokluğu.
- **Responsive:**
  - `responsive-shell` ve `showcase-screens-viewport` desenleri tüm liste ekranlarına uygulanır.
  - 320, 390, 768, 1024, 1280 ve 1440 genişliklerinde sayfa yatay kaymaz; tablo kayar.
  - WebKit projesinin `testMatch` listesine yeni mobil kabuk testleri eklenir.
- **Erişilebilirlik:**
  - Klavyeyle tam gezinme: menü grupları, ikon modu, popover, sekmeler, diyaloglar.
  - Odak görünürlüğü ve Türkçe büyük harf (`lang="tr"`).
  - Kontrast: `#7d7979` üzerindeki 11px başlık için WCAG AA hesabı; yetersizse `#605d5d`.
  - `role="switch"`/`aria-checked`, `aria-modal`, `aria-expanded`.
  - `@axe-core/playwright` eklenmesi bir bağımlılık kararıdır. Eklenmezse manuel denetim listesi PR'a eklenir.
- **Görsel kabul:** paket (2)'nin 54 tam sayfa görüntüsüne karşı ekran başına yan yana karşılaştırma tablosu (SEO `38`–`43` hariç). Sapmalar gerekçeli listelenir: gerçek veri, D öğesi ya da izin.
- **Yüklenme (K10):** onay gelirse `loading.tsx` iskeletleri eklenir; E2E zamanlaması ve `form-post` akışları yeniden koşulur.
- **Geri dönüş riski:** Düşük (test ve iskelet).

---

## Kapsam kontrolü: 55 route'un dilimlere dağılımı

| Dilim | Route'lar |
| --- | --- |
| 1 | Kabuk (52 route'u görsel olarak etkiler), #53, #54, #55 + not-found / error / global-error |
| 2 | #46 |
| 3A | #2, #3, #4, #5, #6, #11 |
| 3B | #7, #8, #9, #10, #12, #13, #14 |
| 3C | #15, #16, #17, #18, #19, #20, #21, #22, #23, #24 |
| 3D | #25, #26, #27, #28, #29, #30, #31, #32 |
| 3E | #33, #34, #35, #36, #37, #45 |
| 3F | #38, #39, #40, #41, #42, #43 |
| 3G | #44, #47, #48, #49, #50, #51, #52 |
| 3H | #1 |
| 4 | Tümü (denetim) |

Toplam: 3 (Dilim 1) + 1 (Dilim 2) + 6 + 7 + 10 + 8 + 6 + 6 + 7 + 1 = **55**. "Sonra bakılır" kategorisi yoktur.

**Programın dışında kalan ve ayrı iş kalemi olanlar:**
- SEO-004 (4 SEO ekranı).
- ADMIN-DESIGN-000 (davranış düzeltmeleri).
- ~~F4 API işi.~~ PR #114 personel okuma uçlarıyla kapandı; Faz 3B testlerle doğruladı (bkz. 3B "API etkisi").
- K3 (arama ve zil), K8 "Sonrası" sütunu, K11 backend eylemleri (talep/teklif ekranlarındakiler ADMIN-ACTIONS-001–007 olarak envanterde), K12 dashboard veri kaynakları, vitrin kuyruk sayacı.

## Karar soruları özeti

Ayrıntı EB §6'dadır. **Faz 1'i bloklayanlar:**
- **K1:** yeni menü yerleşimi.
- **K13:** kullanıcı bloğu metni.
- **K15:** marka varlığı.

Diğerleri ilgili Dilim 3 alt dilimine kadar yanıtlanabilir.
