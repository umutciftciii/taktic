# ADMIN-DESIGN-001 — Admin paneli tasarım dönüşümü: uygulama planı

- **Tarih:** 2026-09-24
- **Taban:** `main@1bda65da`
- **Eşleme belgesi:** `docs/superpowers/specs/2026-09-24-admin-design-001-screen-mapping.md` (aşağıda "EB"). Route numaraları (#1–#55), bulgular (F1–F20) ve karar soruları (K1–K15) oradadır.
- **Tasarım referansı:** `Taktick Tasarım Projesi (1).zip` → `design_handoff_taktick_admin/`. Depoya kopyalanmaz. Her dilim PR'ı, referans aldığı ekranın prototip anahtarını ve ekran görüntüsü adını belirtir.

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
Aşağıdakilerde `01-genel-gorunum.png` ve `26-giris.png`, `27-sifre-belirleme-davet.png` ile yan yana karşılaştırma yapılır:
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
- `/notifications`, README "15–22 ortak liste" tanımı ve `list:notifications` sütun setiyle karşılaştırılır.
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
| `/requests` | `requests`, `02-talepler.png` | — | — |
| `/requests/[id]` | `requestDetail` (4 sekme), `03`, `04` | `REQUESTS_STATUS`, `REQUESTS_QUALITY_RECALC`, `REQUEST_REPORTS_RESOLVE`, `REQUESTS_REOPEN`; tamamla/iptal yalnız `isSuperAdmin` (F6) | Reddet, Talebi kaldır, İptal |
| `/requests/reports` | `list:complaints` | — | — |
| `/offers` | `offers`, `07` | — | — |
| `/offers/[id]` | `offerDetail`, `08` | `OFFERS_STATUS`, `OFFER_REFUND_MANUAL` | Kabul et (diğer teklifleri kapatır), Krediyi iade et |
| `/refund-scan` | `refund`, `16` | "Taramayı çalıştır" `OFFER_REFUND_EXECUTE` | Toplu iade onayı ("N teklifin iadesini onayla") |

- **Sekmeler:** talep detayında "Talep bilgileri · Teklifler · Şikayet · Neler oldu" sekmeleri; bugünkü tüm bölümler bunlara dağıtılır. "Durum yönetimi" formları özet kartının eylem alanına ve "Talep bilgileri" sekmesine taşınır.
- **İzin etkisi:**
  - "Teklifler" sekmesi ancak `can('OFFERS_READ')` ile görünür.
  - "Şikayet" sekmesi ancak `can('REQUEST_REPORTS_READ')` ile görünür.
  - İletişim paylaşım kartı ancak `can('CONTACT_REVEAL_READ')` ile görünür.
- **Render edilmeyenler (K11):** 7 gün uzat, teklifi kaldır, hatırlat, uyar, eşleşmeyi iptal et, Excel, elle talep ekle.
- **API etkisi:** yok. Refund-scan istemci çağrıları aynen kalır.
- **Test:**
  - `request-report-flow`, `marketplace-journey`, `offer-experience`, `offer-detail-hydration`, `offer-withdrawal`, `request-auto-publish`, `contact-sharing`.
  - Yeni: izni olmayan rolde yazma düğmelerinin yokluğu (`admin-rbac-permissions` genişletmesi). Tasarımın `?tab=` URL'leri için derin bağlantı testi.
- **Görsel kabul:** `02`, `03`, `04`, `07`, `08`, `16`.
- **Geri dönüş riski:** Yüksek (6 yazma formu yer değiştiriyor). Revert tek PR.

### 3B — Kişiler ve destek (#7, #8, #9, #10, #12, #13, #14)

- **Tasarım karşılıkları:**
  - `list:customers` (`09`), `customerDetail` (`10`), `list:support`, `providers` (`05`), `providerDetail` (`06`).
  - `/support/[id]` ve `/providers/[id]/credits` için şablon kullanılır.
- **Aksiyon kapıları:**
  - Müşteri: `CUSTOMER_NOTES_WRITE`, `CUSTOMERS_STATUS`, `CUSTOMER_ACTIVATION_LINK_ISSUE`; notlar sekmesi `CUSTOMER_NOTES_READ` (F7).
  - Destek: `SUPPORT_WRITE`, `PACKAGE_REFUND_REQUEST_CREATE`.
  - Hizmet veren: `PROVIDERS_MODERATE` (`ModerationDialog`), `PROVIDER_CATEGORIES_WRITE`, `PROVIDER_CLAIM_INVITE_ISSUE`; mevcut 4 `can()` korunur.
  - Krediler: `CREDITS_GRANT` ve `CREDITS_DEDUCT` sekme bazında.
- **Onay diyaloğu:** hesabı pasife al, hizmet vereni askıya al/reddet, kategori kaldır, kredi düş.
- **Hizmet veren detay sekmeleri:** "İşletme bilgileri · Kredi hareketleri · Değerlendirmeler".
  - "Kredi hareketleri" sekmesi F4 çözülmeden **yalnız `isSuperAdmin`** için render edilir. Değilse sekme yok, "Krediler" bağlantısı da yok.
  - "Belgeler" kartı ve "kazanma oranı" metrikleri render edilmez (D).
- **API etkisi:** yok (F4 ayrı).
- **Test:** `admin-customer-verification`, `customer-activation-proof`, `provider-support-tickets`, `provider-claim`, `provider-business-registration`, `provider-draft-category-binding`, `package-refund-request`.
- **Geri dönüş riski:** Orta-yüksek (ham kayıt no gösterimi ve denetim kaydı korunmalı).

### 3C — Vitrin ve değerlendirmeler (#15–#24)

- **Tasarım karşılıkları:**
  - `list:reviewReports`, `list:cardReviews` (`17`), `list:placements`, `list:leads`, `list:showcasePackages`.
  - Şablon kullananlar: `/provider-reviews/[reviewId]`, `/showcase/reviews/[versionId]`, `/showcase/placements/[placementId]`, `/showcase/cards`, `/showcase/price-terms`.
- **Aksiyon kapıları:** `PROVIDER_REVIEWS_MODERATE`, `SHOWCASE_REVIEW_DECIDE`, `SHOWCASE_PACKAGES_WRITE`, `SHOWCASE_PLACEMENTS_MODERATE`, `SHOWCASE_PLACEMENT_CANCEL`.
- **Onay diyaloğu:** değerlendirmeyi kaldır (müşteriye e-posta gider), sürümü reddet, yerleşimi iptal et (geri alınamaz, iade yok).
- **Vitrin paketleri:** satır içi düzenleme kartları, liste + detay/düzenleme modalı desenine taşınır. Form alanları ve slug değişmezliği korunur.
- **Render edilmeyen:** kart askıya al/aç (K9).
- **Test:** `showcase-cards`, `showcase-package-first-flow`, `showcase-package-price`, `showcase-placement-lead`, `showcase-screens-viewport`, `showcase-home-shelf`, `provider-review-flow`.
- **Geri dönüş riski:** Orta.

### 3D — Finans, paketler ve iadeler (#25–#32)

- **Tasarım karşılıkları:**
  - `finance` (`11`), `list:ledger` (`14`), `manual` (`15`), `list:balances`, `list:purchases`.
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

### 3E — Kampanyalar, uygunluk ve operasyon ayarları (#33–#37, #45)

- **Tasarım karşılıkları:** `campaigns` (`13`), `settings` (`12`). Şablon kullananlar: `/campaigns/new`, `/campaigns/[id]`, `/promotion-eligibility*`.
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

### 3F — Katalog (#38–#43)

- **Tasarım karşılıkları:** `list:categories` (`18`), `list:creditPackages`. Formlar şablonla kurulur.
- **Aksiyon kapıları:**
  - Kategori: `CATEGORIES_WRITE`, `CATEGORIES_STATUS`, `UPLOADS_WRITE`.
  - Soru: `QUESTIONS_WRITE` (soru seti editörü `QUESTIONS_READ` yoksa gizli, F8).
  - Davet: `PROVIDER_INVITES_READ/ISSUE/REVOKE`.
  - Kredi paketi: `CREDIT_PACKAGES_WRITE`, `CREDIT_PACKAGES_STATUS`. Satış özeti `PACKAGE_PURCHASES_READ` ile (F9).
- **Kategori ağacı:** tasarımın düz tablosu yerine derinlik girintisi korunur; "Yayına hazır mı?" sütunu eklenir.
- **Test:** `category-expansion`, `category-release-readiness`, `category-supply-status`, `category-wave-2-drafts`, `provider-invite-links`, `offer-packages`.
- **Geri dönüş riski:** Yüksek (`/categories/[slug]` soru ve koşul editörü).

### 3G — Sistem ve yönetim (#44, #47–#52)

(#46 `/notifications` Dilim 2'de yapıldı.)

- **Tasarım karşılıkları:** `company` (`25`), `list:admins`. Şablon kullananlar: `/notifications/[id]`, `/users/new`, `/users/[id]`, `/roles`, `/roles/[id]`.
- **Aksiyon kapıları:**
  - `COMPANY_SETTINGS_WRITE`, `NOTIFICATION_RETRY`, `ADMIN_USERS_STATUS`.
  - Kök yetkiler (`/users/new`, davet bağlantısı, rol atama, `/roles*`) yalnız `isSuperAdmin` ile (F10, F11).
- **Onay diyaloğu:** kullanıcıyı pasife al, rolü pasifleştir, rol geri al, izin matrisi kaydı (etkilenen hesap sayısı yazılır).
- **Roller:** izin matrisi 82 izni alanlara göre gruplar. `adminPermissionLabel` metinleri korunur; `<code>` etiketi ikincil satırda kalır.
- **Test:** `admin-rbac-permissions` (rol oluşturma ve atama), `admin-session`, `notification-history`.
- **Geri dönüş riski:** Yüksek (yetki tanımlama yüzeyi).

### 3H — Genel görünüm (#1)

En sona bırakıldı, çünkü K2 ve K12 kararlarına bağlı.

- "Önce bunlara bak" hücreleri yalnız mevcut özet alanlarından (başvuru, şikayet, destek) ve **ilgili okuma izni varsa** render edilir. Vitrin hücresi, özet ucu genişletilene kadar yoktur.
- 4 KPI mevcut metriklerden seçilir. Değişim yüzdesi ve sparkline yalnız veri kaynağı varsa gösterilir.
- "Sistem şu anda ne yapıyor" bölümü `OPERATIONS_SETTINGS_READ` varsa operasyon ayarları okumalarından türetilir.
- "Panelde son yapılanlar" render edilmez.
- `dashboard-metrics.ts` rozet tonu kuralı korunur.
- **Test:** `admin-dashboard-metrics`, `dashboard-metrics.spec.ts`.
- **Geri dönüş riski:** Orta.

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
- **Görsel kabul:** 27 referans görüntüye karşı ekran başına yan yana karşılaştırma tablosu. Sapmalar gerekçeli listelenir: gerçek veri, D öğesi ya da izin.
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
- F4 API işi.
- K3 (arama ve zil), K8 "Sonrası" sütunu, K11 backend eylemleri, K12 dashboard veri kaynakları, vitrin kuyruk sayacı.

## Karar soruları özeti

Ayrıntı EB §6'dadır. **Faz 1'i bloklayanlar:**
- **K1:** yeni menü yerleşimi.
- **K13:** kullanıcı bloğu metni.
- **K15:** marka varlığı.

Diğerleri ilgili Dilim 3 alt dilimine kadar yanıtlanabilir.
