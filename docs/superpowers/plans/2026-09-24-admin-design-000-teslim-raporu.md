# ADMIN-DESIGN-000 — Admin RBAC ve erişim düzeltmeleri: teslim raporu

- **Tarih:** 2026-09-24
- **Taban:** `main@883664af`
- **Kaynak bulgular:** `docs/superpowers/specs/2026-09-24-admin-design-001-screen-mapping.md` §5.2 (F1–F20)
- **Kapsam:** Görsel değişiklik yok. Token, kabuk, font, logo, menü grupları ve ekran görünümü aynı. Migration, Prisma şeması, `.env`, compose, staging ve production'a dokunulmadı.

## 1. Kararlar (kullanıcı, 2026-09-24): Faz 1 girdisi

Bu PR bu kararları **uygulamaz**, yalnız kaydeder:

| Karar | İçerik |
| --- | --- |
| **K1** | Menüye eklenecek satırlar: Finans → Paket iadeleri; Vitrin → Vitrin kartları ve Vitrin metin onayları; Operasyon → Kampanya uygunluk incelemesi; Yönetim → Roller ve izinler (yalnız süper yönetici) |
| **K13** | Kullanıcı bloğu ad ve yetki bilgisi gösterir: süper admin için `Süper yönetici`, personel için `Yetkili personel · N yetki`. "Tam yetkili yönetici" metni kullanılmaz |
| **K15** | `mark-white.png` `public/brand/` altına eklenir. Mevcut `logo.png` görsel kabul tamamlanana kadar silinmez |

## 2. Bulgu durumu

| # | Bulgu | Durum | Nasıl |
| --- | --- | --- | --- |
| F1 | Yazma aksiyonları izne göre gizlenmiyordu | **Kapandı** | Bkz. aşağı |
| F2 | `/finance/manual-adjustments` `FINANCE_READ` ile açılıyor ama `FINANCE_LEDGER_READ` okuyordu | **Kapandı** | Menü satırı ve sayfa `FINANCE_LEDGER_READ`. "Finans Dashboard" bağlantısı `FINANCE_READ`'e bağlı |
| F3 | `/package-purchases` gizli olarak `PAYMENTS_CONFIG_READ` istiyordu | **Kapandı** | `/payments/config` yalnız izin varsa çağrılıyor. İzin yoksa "Ödeme sağlayıcı" kartı yok, liste açılıyor |
| F4 | `ProviderAccessGuard` yüzünden ADMIN kredi ekranına giremiyordu | **Kapandı** | Yeni dar admin okuma yolları (§3). Guard genişletilmedi |
| F5 | `/requests/[id]` değerlendirme okuması ADMIN'i `/yetkisiz`'e atıyordu | **Kapandı** | Uç (CUSTOMER/SUPER_ADMIN) yalnız süper adminde çağrılıyor. ADMIN'de kart ve istek yok |
| F6 | Tamamla/iptal ADMIN'e görünüyordu; ikincil okumalar 403'ü yutuyordu | **Kapandı** | Tamamla/iptal yalnız `isSuperAdmin`. Teklifler, şikayetler ve iletişim denetimi yalnız ilgili izinle çağrılıyor ve render ediliyor |
| F7 | Müşteri notları sayfayı düşürüyordu | **Kapandı** | Notlar `CUSTOMER_NOTES_READ` ile okunuyor, yazma `CUSTOMER_NOTES_WRITE` ile açılıyor |
| F8 | Kategori detayı gizli olarak `QUESTIONS_READ` ve `PROVIDER_INVITES_READ` istiyordu | **Kapandı** | İki okuma da koşullu. Soru seti ve davet paneli izne bağlı |
| F9 | Kredi paketi yeni/detay sayfalarında gizli bağımlılık vardı; 403 404'e dönüşüyordu | **Kapandı** | `/new` sayfası `READ`+`WRITE` istiyor. Satış özeti `PACKAGE_PURCHASES_READ` ile. Ana kayıt `fetchOrNotFound` ile okunuyor |
| F10 | `/users/new` herkese açıktı; metin yeni hesabı SUPER_ADMIN diye anlatıyordu | **Kapandı** | `requireSuperAdmin()`. Düğme yalnız süper admine görünüyor. Metin düzeltildi: rol atanana kadar yetkisiz personel hesabı |
| F11 | `/roles*` sayfaları panel erişimiyle açılıyordu | **Kapandı** | `requireSuperAdmin()` |
| F12 | Başka izin isteyen bağlantılar kapısızdı | **Kapandı** | Her çapraz bağlantı hedef sayfanın `requireAdmin` iznine bağlandı. İzin yoksa düz metin ya da yok |
| F13 | Hizmet veren kredi sekmesi F4'e bağlıydı | **Kapandı** | F4 ile birlikte |
| F14 | `catch` blokları Next redirect sinyalini yutuyordu | **Kapandı** | `lib/next-control-flow.ts` (redirect ve notFound). Tüm eylem ve okuma `catch`'lerinde önce bu çağrılıyor |
| F15 | Sırlar URL'de taşınıyordu | **Kısmen kapandı** | Bkz. aşağı |
| F16 | Yerel admin şifresi her ortamda görünüyordu | **Kapandı** | Yalnız `APP_ENVIRONMENT=local` iken gösterilip önceden dolduruluyor (`lib/local-environment.ts`). Not: yerel compose'da admin servisine bu değişken verilmiyor, bu yüzden ipucu yerelde de gizli (compose değişikliği kapsam dışı) |
| F17 | `/api/session` middleware'den muaf değildi | **Kapandı** | Tek, tam yol muafiyeti. Diğer `/api/*` yolları çerez ister (birim testi var) |
| F18 | Topbar başlığı filtresiz menüden hesaplanıyor | **Açık → Faz 1** | Kabuk işi. Yalnız etiket; veri sızıntısı yok |
| F19 | Rol ata/geri al geri bildirimi okunmuyordu | **Kapandı** | `/users/[id]` `?ok=role-assigned|role-revoked` ve `?error=` gösteriyor |
| F20 | "Tam yetkili yönetici" metni | **Açık → Faz 1** | K13 kararıyla |

**F1 ayrıntısı:**
- Admin arayüzündeki tüm yazma düğmeleri, formları, yazma sayfasına giden bağlantılar ve yıkıcı aksiyonlar, API rota haritasının istediği tam izinle `can()` üzerinden kapılandı.
- İstemci bileşenlerine izin listesi değil, sunucuda hesaplanmış boolean geçiyor.
- Önceden UI'da anılmayan 49 iznin 44'ü artık kapı olarak kullanılıyor. Kalan 5 izin:
  - `CATEGORIES_DELETE`, `QUESTIONS_DELETE`, `SHOWCASE_CARDS_MODERATE`, `PROVIDERS_WRITE`: UI eylemleri hiç yok (K9/K11).
  - `PACKAGE_REFUND_APPROVE`: düğmeler API'nin `allowedActions` alanıyla, maker/checker dahil, zaten izne göre üretiliyor (`package-refund-requests.service.ts:463-487`).

**F15 ayrıntısı:**
- Müşteri aktivasyon bağlantısı, yeni personel davet bağlantısı ve davet yenileme artık `useActionState` durumunda dönüyor. Bağlantı yanıtta bir kez gösteriliyor; redirect URL'sinde, geçmişte veya log'da yer almıyor.
- `/admin-invite?token=…` sayfası token'ı teslim biçimi gereği URL'de taşımaya devam ediyor. Uygulama geneli `Referrer-Policy: strict-origin-when-cross-origin` token'ı başka kökenlere göndermiyor.
- Sayfaya `referrer: no-referrer` denendi ve **geri alındı**. Bu politika form POST'unda `Origin: null` gönderilmesine yol açıyor, `formPostRoute`'un aynı-köken kontrolü de daveti reddediyor (WebKit `stale-auth-forms` ile doğrulandı).
- Davet teslim biçimini değiştirmek (ör. token'ı POST ile alıp URL'den silmek) geniş bir akış değişikliği ve ayrı bir iş.

## 3. Değişen API yüzeyi

İki yeni **salt okunur** rota eklendi. Migration yok ve yeni izin yok; ikisi de `route-permission-map.ts`'e işlendi (harita testi çift yönlü geçiyor).

| Rota | İzin | Döndürdüğü |
| --- | --- | --- |
| `GET /admin/providers/:providerId/credits` | `FINANCE_LEDGER_READ` | Sahip rotasıyla aynı bakiye ve son hareketler; `createdBy` dahil (ledger'ın gösterdiği gibi). Ek olarak `provider: {id, businessName, status, city, district}` |
| `GET /admin/providers/:providerId/entitlements` | `PACKAGE_PURCHASES_READ` | Süper admin dalının döndürdüğü admin projeksiyonu. Ödeme referansı taşıdığı için satın alma okuma izni istenir |

Aşağıdakiler **değişmedi**:
- `ProviderAccessGuard` ve `/providers/:id/credits|entitlements` (sahip ya da SUPER_ADMIN).
- `POST …/credits/grant` (`CREDITS_GRANT`) ve `…/deduct` (`CREDITS_DEDUCT`).

## 4. Testler

- **API** (`apps/api/test/admin-provider-credits-read.spec.ts`):
  - Ledger okuyucusu yeni rotaları okuyabiliyor; izni olmayan 403, bilinmeyen sağlayıcı 404 alıyor.
  - Sağlayıcının kendisi yeni rotadan reddediliyor.
  - Sahip rotaları ADMIN'e kapalı kalıyor; sahip ve SUPER_ADMIN'e açık.
  - Dönemsel paketler `PACKAGE_PURCHASES_READ` istiyor.
  - `CREDITS_GRANT` yalnız ekleyebiliyor, `CREDITS_DEDUCT` yalnız düşebiliyor. Reddedilen istekler bakiyeyi değiştirmiyor.
- **Admin birim** (`apps/admin/test/access-boundaries.spec.ts`):
  - Middleware: `/api/session` muaf, diğer `/api/*` ve ekranlar çerez istiyor.
  - Yerel ipucu yalnız `local` ortamında.
  - Redirect ve notFound sinyali yeniden fırlatılıyor.
  - Her menü satırının izni sayfanın `requireAdmin` iznine eşit (ya da `requireSuperAdmin()`).
- **E2E** (`e2e/tests/admin-action-visibility.spec.ts`):
  - Yalnız `REQUESTS_READ` olan ADMIN talep detayını açıyor; teklif, şikayet, iletişim denetimi, değerlendirme ve yazma kontrollerinin hiçbirini görmüyor.
  - `REQUESTS_STATUS` sahibi moderasyonu görüyor, tamamla/iptal'i görmüyor.
  - Ledger okuyucusu kredileri görüyor, yazma kontrollerini ve dönemsel paketleri görmüyor. Manuel işlemler satırı ve sayfası açık.
  - Grant ve deduct izinleri yalnız kendi aksiyonlarını açıyor.
  - Yalnız `FINANCE_READ` olan kullanıcı manuel işlemler satırını görmüyor.
  - Kök ekranlar (`/users/new`, `/roles`) personeli `/yetkisiz`'e yönlendiriyor.
  - Süper admin tüm ekran ve kontrolleri görüyor.
  - Bilinmeyen kayıt 404 veriyor.
- **Güncellenen E2E'ler:**
  - `customer-activation-proof`: bağlantı sayfadan okunuyor, adres çubuğunda olmadığı doğrulanıyor.
  - `provider-business-registration`: `CAMPAIGNS_READ` olmayan inceleyici kampanya adını bağlantısız görüyor.

## 5. Yeni bulgular (kod değiştirilmedi)

| # | Bulgu | Öneri |
| --- | --- | --- |
| N1 | `PATCH /categories/:id` (DTO'da `status`) ve `PATCH /credit-packages/:id` (`isActive`) yalnız `*_WRITE` istiyor; `*_STATUS` izni bu yoldan atlanabiliyor. UI bu PR'da mevcut değeri geri gönderiyor, ama API'nin son savunması eksik | API işi: update DTO'larından durum alanını çıkar ya da orada `*_STATUS` iste |
| N2 | `/support/[id]` "Hesabı görüntüle" bağlantısı `/users/:id`'ye gidiyor. Bu sayfa `ADMIN_USERS_READ` (personel) ister ama hedef müşteri ya da hizmet veren hesabı | Ürün kararı: müşteriyse `/customers/:id`'ye, hizmet verense `/providers/:id`'ye yönlendir |
| N3 | Yerel compose admin servisinde `APP_ENVIRONMENT` yok, bu yüzden F16 ipucu yerelde de gizli | İstenirse `docker-compose.local.yml`'e `admin: APP_ENVIRONMENT: local` (ayrı küçük PR) |

## 6. Faz 1 için başlangıç durumu

- Sayfa kapıları, bölüm kapıları ve aksiyon kapıları ekran başına tamamlandı. Faz 1 kabuk ve token dönüşümü davranışa dokunmadan yapılabilir.
- `lib/nav.ts`'teki izin değerleri sayfalarla eşit; `access-boundaries.spec.ts` bunu koruyor. Faz 1'de gruplar ve etiketler değişirken bu test kırılmamalı.
- Kalan Faz 1 kalemleri: F18 (topbar'ın filtreli menü kullanması), F20/K13 (kullanıcı bloğu), K1 (5 yeni menü satırı), K15 (marka).
