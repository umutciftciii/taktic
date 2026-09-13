# Talep formlarında erken kimlik kontrolü ve taslakla devam — teslim raporu

Dal: `claude/request-identity-gate` (worktree `admin-dashboard-metric-cards-2430c6`),
taban `main` (`e89fc501`). Spec: `docs/superpowers/specs/2026-09-13-request-identity-gate-design.md`
(v4, onaylı). Plan: `docs/superpowers/plans/2026-09-13-request-identity-gate.md`. 15 görev
tamamlandı (Task 1–15); bu rapor Task 16'nın 1–3. adımlarını kapsar (push/PR HARİÇ —
kontrolcü dal genelinde son bir review'dan sonra PR'ı açacak).

## 1. Özet

Misafir bir talep formunu (normal `/categories/[slug]` veya vitrin direct-lead
`/vitrin/[cardId]`) doldururken, iletişim bilgileri girilir girilmez arka planda
`POST /auth/request-identity-check` çalışır ve beş durumdan birine göre formu kilitler ya
da açar: yeni müşteri, aktif hesap (giriş gerekir), şifresiz otomatik hesap (etkinleştirme
gerekir), iki farklı müşteriye ait kimlik (çakışma), kullanılamaz (provider/pasif). Giriş
veya etkinleştirmeye yönlendirilen kullanıcı, formda o ana kadar yazdıklarını kaybetmez:
form içeriği (iletişim hariç) sunucu tarafında `RequestDraft` tablosunda saklanır, tek
kullanımlık HttpOnly çerezle taşınır ve doğru hesapla geri dönüldüğünde aynen geri gelir.
Hesabı olmayan misafir için mevcut akış (talep + otomatik müşteri + aktivasyon maili)
değişmeden çalışmaya devam eder.

## 2. API sözleşmesi

### 2.1 `POST /auth/request-identity-check`

- Guard: `AuthThrottlerGuard` (adlandırılmış throttler `auth`, IP başına 10/60 sn
  varsayılan — `AUTH_RATE_LIMIT_MAX`/`AUTH_RATE_LIMIT_WINDOW_SECONDS`). Oturumsuz.
- Body: `{ phone: string; email: string }`, `forbidNonWhitelisted` — ikisi de zorunlu.
- `ServiceRequestsService.resolveContactDetails` ile aynı normalizasyon
  (`normalizePhone`, `trim().toLowerCase()`); iki `User.findUnique` (telefon/e-posta) tek
  `$transaction` içinde birlikte okunur ve birlikte sınıflandırılır ("ilk bulunan kazanır"
  yok).
- Yanıt yalnız `{ status }` — isim, e-posta, telefon, rol, id, sahiplik hiçbir zaman dönmez.
- Beş durum: `new-customer` (ikisi de yok) · `login-required` (aynı/tek eşleşme, aktif
  şifreli CUSTOMER) · `activation-required` (aynı/tek eşleşme, şifresiz
  `AUTO_CREATED_REQUEST` claimable CUSTOMER) · `identity-conflict` (iki **farklı** CUSTOMER
  satırı) · `unavailable` (PROVIDER/ADMIN, pasif veya claimable olmayan şifresiz).
- Telefon eşleşmesi, `User.phone`'un her yazma yolunda kanonikleşmediği gerçeğine göre
  dört yazımı (`equivalentPhoneSpellings`: E.164, ulusal `0…`, çıplak abone no, artısız
  ülke kodu `90…`) tarar — DB'deki gerçek yazım ne olursa olsun aynı sonucu verir (Task 2
  fix round 1).

### 2.2 `POST /auth/request-identity-check/activate`

- Aynı guard/bütçe. Body: `{ phone, email, redirectTo? }`; `redirectTo`
  `safeRedirectPath` ile doğrulanır (şekil kontrolü + ≤512 karakter + `fullyDecode` sonrası
  tekrar şekil kontrolü — çift kodlanmış `/%2f%2fevil.example` gibi adresler de reddedilir),
  geçersizse yok sayılır.
- Yalnız `activation-required` ise `CustomerActivationService.issueForAutoCreatedCustomer`
  çağrılır; **alıcı her zaman `User.email`'den (veritabanından) okunur** — istemcinin
  gönderdiği `email` yalnızca sınıflandırma girdisidir, hiçbir kod yolunda mail alıcısına
  dönüşmez. Hesabın e-postası yoksa/claimable değilse: mail yok.
- Her durumda `202 { status: 'accepted' }` — uç tek başına oracle değildir. Mail üretimi
  best-effort `try/catch` içinde; hata olursa loglanır (sabit mesaj + stack, telefon/e-posta
  loglanmaz), yanıt yine 202.
- Aktivasyon linki: `buildActivationUrl(rawToken, redirectTo?)` → `/activate-customer?token=…&redirectTo=…`; taslak sırrı taşımaz.

### 2.3 Taslak — `RequestDraft` uçları

- **`POST /request-drafts`** — yalnız web server action çağırır (server-to-server).
  Guard: `RequestDraftThrottlerGuard`, `AuthThrottlerGuard` ile **aynı tracker**
  (`req.ip`/socket), ayrı bütçe: **5 istek / 10 dakika, IP başına** (sabit,
  yapılandırılamaz). Body: `{formType, categorySlug, cardId?, payload, identity:{phone,email}, replace?}`.
  `payload` allow-list DTO (iletişim/disclosure alanı yok, ≤32 KB); `identity` saklanmaz,
  yalnız sınıflandırma için kullanılır (`login/activation-required` → `expectedUserId`;
  `new-customer` → `null`; `conflict/unavailable` → `409 DRAFT_NOT_CONTINUABLE`, satır yok).
  Aynı bağlamda güncelleme; farklı bağlamda `replace` yoksa `409 DRAFT_EXISTS`; `replace:true`
  ise tek transaction'da eski satır silinip yeni token ile yeni satır yazılır. Global tavan
  `REQUEST_DRAFT_MAX_ACTIVE` (varsayılan 10 000) aşılırsa `503 DRAFT_STORAGE_BUSY` +
  `Retry-After: 60`. Yanıt `{token, expiresAt}` — yalnız web sunucusuna.
- **`GET /request-drafts/current?formType&categorySlug&cardId`** — satır yok/süresi
  dolmuş/tüketilmiş/anahtar uyumsuz → `204`; anonim taslak (`expectedUserId=null`) → her
  zaman `200 {payload}`; korumalı taslak + oturum yok → `204`; doğru oturum → `userId`
  bağlanır, `200 {payload}`; **yanlış hesap → `200 {status:'wrong-account'}`, satır/cookie/
  `expectedUserId` değişmez**.
- **Tüketim** — `POST /service-requests` ve `POST /showcase/cards/:id/leads`'in talep
  transaction'ı içinde: hash eşleşen, geçerli, anahtarları uyan ve `expectedUserId` boş
  **veya** `= created.customerId` olan satıra `consumedAt=now, userId=created.customerId`
  yazılır; uyumsuz taslak dokunulmadan kalır ve talebi **hiçbir zaman** engellemez
  (`consumeInTransaction` sessizce çıkar, exception fırlatmaz).
- **`DELETE /request-drafts/current`** — yalnız kullanıcı "Vazgeç" dediğinde; satır silinir,
  web cookie'yi temizler.
- **Silinme yolları (kapalı liste):** TTL doldu (mantıksal; fiziksel `sweepExpired()` — en
  fazla 200 satır, process başına en fazla 60 dakikada bir, `POST` sonrası `setImmediate`
  ile fırsatçı) · açık Vazgeç · başarılı talep (tüketim) · onaylı `replace` · beklenen
  kullanıcı silindi (FK Cascade). Başka hiçbir yol taslağı silmez; `wrong-account` silmez.

### 2.4 `TRUST_PROXY` / `WEB_TRUST_PROXY` sözleşmesi

- IP çözümleme yalnız API'de, mevcut doğrulanmış yoldan: Express `trust proxy`
  (`TRUST_PROXY` hop sayısı) + `AuthThrottlerGuard.getTracker` (`req.ip`, yoksa socket).
  Yeni bir IP çözümleme mantığı yazılmadı; `RequestDraftThrottlerGuard` aynı tracker'ı farklı
  bütçeyle kullanıyor.
- Web (server action/proxy route) istemci IP'sini **kendisi üretmez**: `WEB_TRUST_PROXY=true`
  iken aldığı `X-Forwarded-For`'u **değiştirmeden** iletir (`forwardedForHeaders`); kapalıyken
  hiçbir XFF iletilmez → API socket eşini (web'i) izler → paylaşımlı, sahtelenemez fallback.
  Doğrudan istemcinin yazdığı XFF hiçbir yapılandırmada tracker olamaz.
- Varsayılan: `WEB_TRUST_PROXY` kapalı (env yoksa `false`), `REQUEST_DRAFT_MAX_ACTIVE`
  varsayılanı 10 000. E2E ortamında her iki bayrak açık (bkz. §6).

## 3. Taslak yaşam döngüsü

1. **Oluşturma** — misafir iletişim bilgilerini doldurup çıktığında (`onBlur`) kimlik
   kontrolü çalışır; `login-required`/`activation-required` CTA'sına basıldığında (veya
   taslak bütçesi/koşulları gerektirdiğinde) form `saveRequestDraftAction`/
   `saveShowcaseDraftAction` ile o ana kadarki (iletişim hariç) içeriği kaydeder.
2. **Güncelleme/replace** — aynı form+kategori+kart bağlamında tekrar kaydetmek satırı
   günceller (token sabit); farklı bağlamda `replace` onayı istenir (`DRAFT_EXISTS` →
   "Evet, geç" / "Vazgeç"); onaylanırsa eski satır silinip yeni token ile yeni satır açılır.
3. **Açma** — `GET /request-drafts/current`: `expectedUserId` boşsa (yeni-müşteri yolu)
   herkese açılır; doluysa yalnız o hesapla giriş yapan kullanıcıya açılır
   (`session.userId === expectedUserId`); yanlış hesapla dönen kullanıcı `wrong-account`
   görür, satıra dokunulmaz — "Hesap değiştir" ile çıkış yapıp doğru hesapla tekrar
   girdiğinde aynı taslak eksiksiz açılır.
4. **Tüketim** — talep/lead transaction'ı içinde, talep başarıyla yazıldıktan hemen sonra;
   `consumedAt` + `userId` set edilir, cookie web tarafında temizlenir.
5. **Silinme (kapalı liste)** — yukarıdaki §2.3'teki beş yol dışında hiçbir kod yolu taslağı
   silmez.
6. **TTL** 24 saat (mantıksal — her okuma `expiresAt > now`); fiziksel temizlik
   `sweepExpired()` ile ayrı, en fazla 200 satır / saatte bir.

## 4. Ekran metinleri (tam liste, spec §2.2) ve form sıraları

| Durum | Metin | CTA |
|---|---|---|
| `checking` | İletişim bilgileriniz kontrol ediliyor… | — |
| `identity-conflict` | Bu telefon numarası ve e-posta iki farklı müşteri hesabına bağlı. Tek bir hesaba ait iletişim bilgileriyle devam edin. | yok |
| `login-required` | Bu iletişim bilgileriyle bir hesabınız var. Talebinizi hesabınızla devam ettirmek için giriş yapın. | **Giriş yap** |
| `activation-required` | Bu bilgilerle daha önce oluşturulmuş hesabınızı etkinleştirin. | **Etkinleştirme bağlantısı gönder** → sonrası: Bağlantıyı hesabınıza kayıtlı e-posta adresine gönderdik. Şifrenizi belirlediğinizde kaldığınız yerden devam edeceksiniz. |
| `unavailable` | Bu iletişim bilgileri müşteri talebi için kullanılamaz. Farklı bir telefon numarası veya e-posta girin. | yok |
| `error` | İletişim bilgileri doğrulanamadı, tekrar deneyin. | **Tekrar dene** |
| taslak kaydı 429/503 | Taslak şu anda kaydedilemedi. Birkaç dakika sonra tekrar deneyin. | **Tekrar dene** |
| taslak kaydı `DRAFT_EXISTS` | Yeni taslağa geçerseniz önceki taslak silinir. Devam edilsin mi? | **Evet, geç** (`replace:true`) / **Vazgeç** |
| dönüşte `wrong-account` | Bu talebe devam etmek için iletişim bilgilerine bağlı hesabınızla giriş yapın. | **Hesap değiştir** |

Ek: oturumlu müşteride "Farklı bir iletişim kişisi kullanacağım" alt metni — "Talep yine
hesabınıza bağlı kalır; yalnız bu talep için iletişim kişisi değişir."

Form sıraları: normal talep `STEPS = İletişim → İş detayı → Konum & zaman`; vitrin
`İletişim → Talebiniz → İşin yapılacağı yer → Zamanlama → onay`. "Devam et" (normal) ve
"Kod gönder"/"Talebi gönder" (vitrin) misafirde yalnız kimlik `ok` iken açık; oturumlu
müşteride kimlik kontrolü hiç çalışmaz (`enabled=false` → doğrudan açık).

## 5. Dosya etkileri

**API** — `auth/request-identity.{controller,service}.ts`, `auth/dto/request-identity.dto.ts`,
`request-drafts/` (module/controller/service/throttler/cookie/constants/dto),
`customer-activation.service.ts` (`redirectTo`), `service-requests.service.ts`
(`CUSTOMER_IDENTITY_CONFLICT_CODE`, `draftToken`/`draftCardId` tüketimi),
`showcase-lead.service.ts` + `showcase-public.controller.ts` (context geçişi),
`phone-verification/phone.util.ts` (`equivalentPhoneSpellings` — `account.service.ts`'ten
taşındı), `prisma/schema.prisma` + yeni migration. Testler: `request-identity.spec.ts`,
`request-drafts.spec.ts`, `showcase-lead-flow.spec.ts` ekleri.

**Web** — `request-fields/identity-check.ts` (`useIdentityCheck`), `identity-notice.tsx`,
`contact-section.tsx` (notice yuvası, alt metin, `onContactBlur`), `question-field.tsx` /
`description-field.tsx` / `timing-fields.tsx` / `budget-fields.tsx` (`defaultValue`),
`lib/request-refusal-text.ts` (eski `showcase-lead-errors.ts` yeniden adlandırıldı; öncelik
sırası korunarak `CUSTOMER_IDENTITY_CONFLICT` eklendi), `lib/request-drafts.ts` (server
action'lar, cookie), `lib/forwarded-for.ts` (`forwardedForHeaders`), `lib/api-refusal.ts`
(yeni ortak `describeApiRefusal` — vitrin'in `describeFailure`'ı hem normal forma hem
vitrine taşındı), `lib/lira-input.ts` (`minorToLiraDraft` tekilleştirildi), `app/api/auth/
request-identity-check/{,activate/}route.ts` (same-origin proxy), `categories/[slug]/
{page,request-form,budget-fields}.tsx`, `categories/actions.ts`, `vitrin/[cardId]/
{page,lead-form,actions}.tsx`, `activate-customer/{page,actions}.tsx` (`redirectTo`),
`login/actions.ts` (`switchAccountAction`), `globals.css` (`.identity-notice`). Testler:
`identity-check.spec.ts`, `forwarded-for.spec.ts`, `request-refusal-text.spec.ts`,
`lira-input.spec.ts` ekleri.

**E2E** — yeni `tests/request-identity-gate.spec.ts` (1213 satır, 22 test); `src/journeys.ts`
(`completeContactStep`, `settleIdentityGate`, `expectIdentityGateOpen`, `fillLeadContact`,
`fillRequestForm` yeniden yazıldı); `src/fixtures.ts` (`createClaimableCustomer`,
`LOCATION_WORKER_BLOCKS` 8→4); `playwright.config.ts` (`TRUST_PROXY`/`WEB_TRUST_PROXY`,
webkit `testMatch`); mevcut adım/bölüm sırasına bağlı specler güncellendi
(`category-expansion`, `contact-sharing`, `request-budget-inputs`,
`request-contact-autofill`, `request-description-counter`, `request-location-form`,
`showcase-phone-bypass`, `showcase-placement-lead`).

**Kaldırılan/taşınan kod** — `account.service.ts`'teki yerel `equivalentPhoneSpellings`
kopyası `phone-verification/phone.util.ts`'e taşındı; `showcase-card-fields.tsx`'teki yerel
`minorToLiraDraft` `lib/lira-input.ts`'e taşındı; `showcase-lead-errors.ts` →
`request-refusal-text.ts` (yeniden adlandırma, ortaklaştırma); vitrin'deki yerel
`describeFailure` `lib/api-refusal.ts`'e çıkarılıp iki formda da kullanılıyor.

## 6. Migration ve yeni yapılandırma

**Migration: 1 — `20260913120000_add_request_draft`.** Tek ve yalnız ek: `RequestDraftFormType`
enum'u (`MARKETPLACE`, `SHOWCASE_LEAD`) ve `RequestDraft` tablosu. Mevcut tablolara
dokunulmadı (Task 1'deki `prisma migrate diff` çalıştırması, bu migration'dan tamamen
bağımsız, önceden var olan bir `PackagePurchase.packageId` FK sapması dışında sıfır fark
raporladı). Kolonlar: `id, tokenHash(unique), formType, categorySlug, cardId?, payload(Json),
expectedUserId?, userId?, expiresAt, consumedAt?, createdAt`. İndeksler: `tokenHash` unique,
`expiresAt`, `expectedUserId`, `userId`. **FK davranışı:** `expectedUserId` →
`User(id)` **ON DELETE CASCADE** (beklenen hesap silinirse satır tamamen silinir; hiçbir kod
yolu korumalı bir taslağı anonime çevirmez), `userId` → `User(id)` **ON DELETE SET NULL**
(bağlı hesap silinirse satır kalır, `userId=null`).

**Yeni env'ler:**
- `REQUEST_DRAFT_MAX_ACTIVE` (API, varsayılan **10 000**) — aktif (`consumedAt IS NULL AND
  expiresAt > now`) taslak sayısı tavanı; aşılırsa yazma `503 DRAFT_STORAGE_BUSY` +
  `Retry-After: 60` alır (güncelleme/replace tavana takılmaz).
- `WEB_TRUST_PROXY` (web, varsayılan **kapalı/false**) — açıkken web, aldığı
  `X-Forwarded-For`'u API'ye değiştirmeden iletir; kapalıyken hiç XFF iletmez.
- E2E config'inde (`e2e/playwright.config.ts`): API tarafı `TRUST_PROXY=1`, web tarafı
  `WEB_TRUST_PROXY=true` (yalnız `web` runtime'ı, `admin` hariç) — gerekçe: taslak yazma
  bütçesi (5/10 dk, IP başına, yükseltilemez) tüm suite'in tek bir loopback IP'sini
  paylaşmasını önlemek için; her test bağlamı kendi `x-forwarded-for` başlığıyla açılıyor
  (bkz. §9.3).

## 7. Spec'ten bilinçli sapmalar

**(a) Cookie `secure` ifadesi.** Spec §2.6 `secure: NODE_ENV === 'production' ||
requestIsOverHttps()` istiyordu. Repo'da bunu birebir uygulamak mimari bir bekçi testini
(`apps/web/test/session-cookie.spec.ts`) kırardı: bu test, `secure:` anahtarının ve
`process.env.NODE_ENV` okumasının **yalnızca** `session-cookie.ts` dosyalarında
bulunabileceğini zorunlu kılıyor — gerekçesi, Next'in `NODE_ENV`'i build-time sabitine
katlaması yüzünden geçmişte yaşanan gerçek bir prod hatasının (Safari'de çerezin düşmesi)
regresyonunu önlemek. Bunun yerine `lib/request-drafts.ts`, session çerezinin kullandığı
`appCookieOptions({ maxAge })`'ı çağırıyor; bu yardımcı `secure`'u zaten
`requestIsOverHttps()` ile (gelen isteğin gerçekten TLS üzerinden mi geldiğine bakarak)
runtime'da doğru hesaplıyor. Davranışsal fark yok: production edge'i `x-forwarded-proto:
https` gönderdiğinden `requestIsOverHttps()` orada `true` döner ve Secure yine sağlanır;
yerel HTTP'de de doğru şekilde `false` kalır. Spec §2.6 metni bu committe düzeltildi.

**(b) Throttler kablolaması.** Spec'in "AuthModule dışında ikinci bir `ThrottlerModule.forRoot()`"
önerisi denendi ve gerçekten çakıştı (`@nestjs/throttler` v6'da iki ayrı `forRoot()` aynı
storage'ı paylaşmıyor). Seçilen yol: **tek `forRoot()`** (AuthModule), içinde **iki
adlandırılmış throttler** (`auth`, `request-drafts`). `@nestjs/throttler`'ın guard'ı,
`@SkipThrottle` ile hariç tutulmadıkça kayıtlı **her** adlandırılmış throttler'ı her rotaya
uyguladığından (her (sınıf, handler, throttler-adı) üçlüsü kendi ayrı sayacına sahip —
"paylaşılan bütçe" değil, ilgisiz rotalarda kazanılan **ek, bağımsız bir sayaç”), iki guard
(`AuthThrottlerGuard`, `RequestDraftThrottlerGuard`) `onModuleInit()`'te
`this.throttlers`'ı kendi adına filtreleyecek şekilde yapısal olarak daraltıldı — dekoratör
dağıtmak yerine guard seviyesinde çözüldü (Task 5, fix round 1–2).

**(c) E2E'de paylaşılan saatlik SMS/OTP bütçesi.** "Kod gönder" server action üzerinden
gittiği için tüm tarayıcı bağlamları API'ye 127.0.0.1 olarak görünüyor (server action'lar
`x-forwarded-for` iletmiyor — bu, `WEB_TRUST_PROXY` yolunun kapsamadığı ayrı bir uygulama
değişikliği gerektirirdi). `OTP_MAX_SENDS_PER_IP_PER_HOUR=10` paylaşılan bütçesi, aynı
saatte birden fazla vitrin spec'i SMS gönderirse tükenebiliyor;
`request-identity-gate.spec.ts` kendi kanıtladığı numaraların `PhoneVerification.createdAt`
satırlarını `afterEach`'te 2 saat geriye alarak (kayıtlar aynen kalır, yalnız sayaç
penceresinden çıkar) bu paylaşımı yönetiyor. Kalıcı çözüm (server action yolundan da XFF
iletilmesi) ayrı bir iştir — Task 15/16 kararıyla ertelendi.

**(d) `LOCATION_WORKER_BLOCKS` 8 → 4.** Tam Chromium koşusu, yeni spec'in eklediği konum
tüketimiyle 8 worker bloğunun 121 sınırını aştı ("has no location block"). 4'e düşürülmesi
worker başına ayrılan ilçe sayısını artırıyor (243); bedel, artık chromium+webkit+2 retry
(4 süreç) varsayımına dayanması. Davranış değişikliği yok, yalnızca kapasite; kalıcı yön test
başına daha az benzersiz ilçe kullanmak.

**(e) `IdentityNotice` wrong-account CTA.** Spec dolaylı olarak bir "Hesap değiştir" linki
öngörüyordu; uygulamada `changeAccountHref` prop'u yerine `onChangeAccount: () =>
void|Promise<void>` callback'i kullanıldı ve buton
`startTransition(() => switchAccountAction(formPath))`'e bağlandı. `switchAccountAction`
(`login/actions.ts`) oturumu API'de sonlandırır, taslak cookie'sine dokunmadan
`/login?redirectTo=<formPath>`'e yönlendirir. Gerekçe: çıkış bir POST'tur ve normal talep
formu zaten bir `<form>` içindedir — iç içe `<form>` HTML'de geçersizdir; bir server action
callback'i buradaki tek geçerli yoldu.

## 8. Test sonuçları

`pnpm typecheck && pnpm lint && pnpm test && pnpm build` (kök, `DATABASE_URL` export
edilmiş) — dördü de yeşil.

### Birim/entegrasyon (`pnpm test`, kök)

| Paket | Test dosyası | Test |
|---|---|---|
| `@taktic/api` | 97 | **2095** |
| `@taktic/web` | 14 | **98** |
| `@taktic/shared` | 4 | **97** |
| `@taktic/admin` | 2 | **39** |
| **Toplam** | 117 | **2329** |

Hepsi geçti; `pnpm build` (web + api + admin) hatasız tamamlandı.

### E2E

- Chromium tam suite (`pnpm --filter @taktic/e2e e2e`, prepare-database dahil):
  **227/227 geçti** (7.1 dk).
- WebKit (`pnpm --filter @taktic/e2e e2e:webkit`): **74/74 geçti** (2.2 dk) — bunun
  içinde `request-identity-gate.spec.ts`'in 22 senaryosu da var (webkit `testMatch`'e
  Task 15'te eklendi).

## 9. Spec §7 kanıtlarının test adlarıyla eşlemesi

1. **Yanlış hesap → doğru hesap.** API: `apps/api/test/request-drafts.spec.ts` —
   "GET /request-drafts/current" describe bloğundaki wrong-account testleri (satır/
   `expectedUserId`/`tokenHash`/cookie değişmeden kaldığını, ardından doğru oturumla `200
   payload` döndüğünü doğrulayan ardışık çağrı testleri, Task 6). E2E:
   `e2e/tests/request-identity-gate.spec.ts` — "yanlış hesapla dönen müşteri uyarılır…"
   (senaryo 3, her iki form) — alan alan geri gelişi ve "Hesap değiştir" sonrası doğru
   hesapla gönderimi doğruluyor.
2. **`expectedUserId` Cascade (asla anonimleşmez).** API:
   `request-drafts.spec.ts` — "foreign keys" describe bloğu: beklenen kullanıcı silinince
   satırın tamamen yok olduğu (Cascade) ve aynı cookie ile `GET`'in `204` döndüğü; `userId`
   sahibi silinince satırın kaldığı ve `userId=null` olduğu (SetNull) testleri (Task 6).
3. **Sınırsız yazım kapalı.** API: `request-drafts.spec.ts` — "refuses a 6th POST from
   the same IP" (IP throttle), "keeps one active draft" / "DRAFT_EXISTS" / "replace"
   testleri (tek aktif satır), "REQUEST_DRAFT_MAX_ACTIVE aşılınca 503" testi (global tavan),
   "refuses a payload over 32 KB" (`DRAFT_TOO_LARGE`), "sweeps at most 200…" (TTL sweep) ve
   sahte `X-Forwarded-For` ile throttle'ın değişmediği izolasyon testi (Task 5, fix round
   1–2: "scopes AuthThrottlerGuard and RequestDraftThrottlerGuard to their own named
   budget"). E2E: `request-identity-gate.spec.ts` senaryo 12 ("taslak bütçesi › …
   altıncı taslak kaydı…") — 6. taslak kaydının `identity-draft-error` + "Tekrar dene"
   gösterdiğini doğruluyor.
4. **Aktivasyon alıcısı yalnız DB e-postası.** API: `request-identity.spec.ts` — "mails the
   activation link" / saldırgan senaryosu: mağdur telefonuna ait claimable hesap + saldırganın
   e-postasıyla `activate` çağrısı → outbox'ta mail yalnız mağdurun DB e-postasına, saldırgana
   hiç mail yok; hesabın `email`'i null → 202, mail yok (Task 3). E2E: senaryo 4 ("şifresiz
   hesap etkinleştirme bağlantısını…") — form e-postası farklıyken mailin yalnız hesap
   e-postasına gittiğini, `redirectTo`'nun linke taşındığını ve şifre sonrası forma taslakla
   dönüldüğünü doğruluyor.
5. **Misafirde gate atlanamaz.** Web birim: `identity-check.spec.ts` — `enabled` yalnız
   `accountContact===null` iken true, yarış/iptal testleri (geç gelen eski yanıt
   uygulanmaz). E2E: senaryo 7 ("kontrol yanıtsız kalırsa gate kapalı kalır…" — route 500
   stub'ı, "Devam et"/"Kod gönder" devre dışı kalıyor, "Tekrar dene" ile açılıyor) ve
   senaryo 11 ("misafire farklı iletişim kişisi seçeneği sunulmaz" — DOM'da
   `use-alternate-contact` yok). Ayrıca senaryo 9 ("gate açıldıktan sonra oluşan
   çakışma…") gönderim anındaki yarışta `CUSTOMER_IDENTITY_CONFLICT`'in son savunma
   (`resolveCustomerForCreate`) tarafından yakalandığını doğruluyor.

## 10. Ertelenen minor bulgular (ledger'dan, kısa)

- Task 1: `User` back-relation yerleşimi ve index sırası stil tercihi.
- Task 2: aynı yazım setiyle birden fazla kopya telefon satırı varsa `findFirst` keyfi
  seçim yapabilir.
- Task 3: yerel `safeRedirectPath` kontrol-karakter aralığı (`[\x00-\x20]`) shared
  paketinden (`[ -]`) hafifçe farklı.
- Task 5: replace sırasında eşzamanlı silme → P2025/500 (deleteMany+count ile
  önlenebilir); global tavan TOCTOU (kasıtlı, yumuşak sınır); boş `cardId` string vs null;
  `answers[].value` iç içe objeler whitelist'i atlıyor (plan tarafından öngörülmüş).
- Task 7: negatif key-match/süresi dolmuş taslak testi eksik; başarısız `onCreated`
  taslağı tüketilmemiş bırakır testi eksik; `categorySlug` draft oluşturmada trim edilmiyor.
- Task 8: `discardRequestDraftAction` 204'ü catch ile ele alıyor (ham fetch tercih
  edilebilirdi); proxy'ler `Retry-After`'ı düşürüyor; guard 2xx'te token eksikse
  sessiz; `draftPayloadFromForm` imzası tek argümanlı.
- Task 9: client-side fetch timeout yok (istek asılı kalırsa `checking`'de takılı
  kalabilir); `IdentityNotice` props'unda `busy` küçük bir arayüz sürüklenmesi.
- Task 11/12: gate kapalıyken her "Devam et"/"Kod gönder" tıklaması yeniden identity
  POST'u atıyor; "Kod gönder" tooltip metni spec cümlesiyle birebir değil; vitrin
  `formPath`'te `cardId` encode edilmiyor; `ACTIVATION_FAILED` sonrası "Tekrar dene"
  `DRAFT_EXISTS`'e düşebilir; mevcut (bu işten önce de var olan) `nextStepHref` hâlâ
  `phone` query parametresi taşıyor — PII-URL ilkesiyle çelişiyor, ayrı temizlik adayı.
- Task 15: S12 marketplace varyantı yazılmadı (yalnız vitrin); e2e SMS bütçesi
  yaşlandırması kalıcı değil (bkz. §7c); `LOCATION_WORKER_BLOCKS=4`'ün kalıcılığı, suite
  büyüdükçe test başına konum tüketiminin azaltılmasına bağlı.
