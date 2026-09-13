# Talep formlarında erken kimlik kontrolü ve taslakla devam — tasarım (v4, onaylı)

Tarih: 2026-09-13 · Durum: onaylı, uygulamaya hazır · Önceki iş: VIT-003 (PR #73, #74)

## 0. Amaç ve kapsam

**Sorun.** Misafir, vitrin kartından direct-lead formunu ya da normal talep formunu
doldurup en sonda "Telefon ve e-posta farklı müşteri kayıtlarıyla eşleşiyor." hatası
alıyor. Kimliği belirleyen bilgi (telefon + e-posta) en son toplanıyor; hesabı olan
kullanıcı bunu formun sonunda öğreniyor ve emeği boşa gidiyor.

**Hedef.** Kimlik durumu iletişim bilgileri girilir girilmez belirlensin. Hesabı olan
giriş yapsın, şifresiz otomatik hesabı olan etkinleştirsin; her iki durumda da yazdıkları
korunup **kaldığı yerden** devam etsin. Hesabı olmayan için mevcut misafir akışı
(talep + otomatik müşteri + aktivasyon maili) aynen işlesin.

**Kapsam.** Normal talep formu (`/categories/[slug]`) + vitrin direct-lead formu
(`/vitrin/[cardId]`).

**Kapsam dışı / değişmeyen.** Lemon/ödeme, SMS bypass sözleşmesi, scheduler işleri,
OTP-ile-login, `resolveCustomerForCreate` kuralı (nihai savunma katmanı; yalnız hata
gövdesine `code` eklenir). VIT direct-lead korumaları — kapsam doğrulaması, tek
sağlayıcı, kredi harcanmaması, atomik `ServiceRequest + ShowcaseLead`, talep öncesi
telefon kanıtı — aynen.

**Migration.** Tek ve yalnız ek: `RequestDraft` tablosu + `RequestDraftFormType` enum.
Mevcut tablolara dokunulmaz.

**Yeni yapılandırma.** `REQUEST_DRAFT_MAX_ACTIVE` (API, varsayılan 10000) ve
`WEB_TRUST_PROXY` (web, varsayılan kapalı). İkisi de opsiyonel; yokken güvenli
varsayılanlar geçerlidir.

---

## 1. API sözleşmesi

### 1.1 `POST /auth/request-identity-check`

- Guard: `AuthThrottlerGuard` (IP başına, login bütçesi `AUTH_RATE_LIMIT_*`). Oturumsuz.
- Body (`forbidNonWhitelisted`): `{ phone: string; email: string }` — **ikisi de zorunlu**;
  tek alanla sorgu yok.
- Normalizasyon `ServiceRequestsService.resolveContactDetails` ile birebir
  (`normalizePhone`, `trim().toLowerCase()`).
- Tek okuma bağlamı: `$transaction([user.findUnique({phone}), user.findUnique({email})])`;
  iki satır **birlikte** sınıflandırılır. "İlk bulunan kazanır" yoktur.
- Yanıt yalnız `{ status }`. İsim, e-posta, telefon, rol, id, sahiplik dönmez.

Satır türü: `none` · `active` (CUSTOMER, `isActive`, `passwordHash` dolu) · `claimable`
(`isClaimableCustomer`: CUSTOMER, aktif, şifresiz, `AUTO_CREATED_REQUEST`) · `blocked`
(PROVIDER/ADMIN, pasif, ya da claimable olmayan şifresiz).

| byPhone / byEmail | status |
|---|---|
| none / none | `new-customer` |
| herhangi biri `blocked` | `unavailable` |
| iki **farklı** CUSTOMER satırı (active/claimable karışık dahil) | `identity-conflict` |
| aynı satır veya tek eşleşme, `active` | `login-required` |
| aynı satır veya tek eşleşme, `claimable` | `activation-required` |

Bu küme `resolveCustomerForCreate` ile birebir: `identity-conflict` onun 409'u,
`login/activation-required` onun "mevcut hesaba bağla" dalı, `new-customer` yeni otomatik
müşteri.

İç yardımcı: `classifyRequestIdentity(tx, {phone, email}) → { status, matchedCustomerId: string | null }`.
`matchedCustomerId` yalnız sunucu içinde (1.2, 1.3) kullanılır; hiçbir yanıta yazılmaz.

### 1.2 `POST /auth/request-identity-check/activate`

- Aynı guard. Body: `{ phone, email, redirectTo?: string }`. `redirectTo`
  `safeRedirectPathOrNull` ile doğrulanır; geçersizse yok sayılır.
- `classifyRequestIdentity` çalışır. **Yalnız** `activation-required` ise
  `CustomerActivationService.issueForAutoCreatedCustomer(matchedCustomerId, { redirectTo })`
  çağrılır. Bu metot alıcıyı **veritabanındaki `User.email`**'den okur. İstemcinin
  gönderdiği `email` hiçbir kod yolunda alıcı değildir; yalnız sınıflandırma girdisidir.
- Hesabın `email`'i yoksa, claimable değilse ya da mail üretilemiyorsa: mail yok, yanıt yine
  `202`.
- Yanıt her durumda `202 { status: 'accepted' }`. Uç tek başına oracle olmaz; neden
  açıklanmaz.
- Aktivasyon linki: `buildActivationUrl(rawToken, redirectTo?)` →
  `/activate-customer?token=…&redirectTo=…`. Link taslak sırrı taşımaz.

### 1.3 Taslak — `RequestDraft`

```prisma
enum RequestDraftFormType { MARKETPLACE SHOWCASE_LEAD }

model RequestDraft {
  id             String               @id @default(cuid())
  tokenHash      String               @unique          // sha256(32 bayt rastgele)
  formType       RequestDraftFormType
  categorySlug   String
  cardId         String?
  payload        Json                                   // iletişim içermez
  expectedUserId String?                                // kim giriş yapmalı — sunucu türetir
  expectedUser   User?    @relation("RequestDraftExpectedUser", fields: [expectedUserId], references: [id], onDelete: Cascade)
  userId         String?                                // fiilen bağlandığı hesap — tarihsel
  user           User?    @relation("RequestDraftUser", fields: [userId], references: [id], onDelete: SetNull)
  expiresAt      DateTime
  consumedAt     DateTime?
  createdAt      DateTime @default(now())

  @@index([expiresAt])
  @@index([expectedUserId])
  @@index([userId])
}
```

Semantik: `expectedUserId` = koruma ilişkisi ("kim giriş yapmalı"); istemci göremez,
gönderemez, hiçbir kod yolu `null`'a çevirmez (yalnız `new-customer` için baştan `null`).
Beklenen kullanıcı silinirse satır **Cascade** ile silinir; asla anonim taslağa dönüşmez.
`userId` = bağlılık/tarihsel alan; sahibi silinirse `SetNull`, satır kalır.

**Tarayıcı başına tek aktif taslak (değişmez).** Tarayıcı tek opak token taşır
(`taktic_request_draft`); bu token en fazla bir satırı çözer. Aşağıdaki `POST` kuralları
bunu veritabanı değişmezi yapar.

#### `POST /request-drafts` — yalnız web server action çağırır (server-to-server)

- Guard: `RequestDraftThrottlerGuard` — `AuthThrottlerGuard` ile **aynı tracker**
  (`req.ip` / socket), farklı bütçe: **IP başına 5 / 10 dk**.
- Body: `{ formType, categorySlug, cardId?, payload, identity: { phone, email }, replace?: boolean }`.
  - `payload` allow-list DTO: `city, district, neighborhood, addressNote, urgency,
    urgencyBucket, preferredDate, budgetMin, budgetMax, description,
    answers[{questionKey, value}], routerSelections[{questionKey, optionKey}]`.
    İletişim/disclosure anahtarları DTO'da yok → `forbidNonWhitelisted` reddeder.
    Serileştirilmiş boyut ≤ 32 KB.
  - `identity` **saklanmaz**; yalnız `classifyRequestIdentity` için kullanılır:
    - `login-required` / `activation-required` → `expectedUserId = matchedCustomerId`;
    - `new-customer` → `expectedUserId = null`;
    - `identity-conflict` / `unavailable` → `409 { code: 'DRAFT_NOT_CONTINUABLE' }`, satır yok.
- Mevcut cookie kuralı (istek geçerli, tüketilmemiş, süresi dolmamış bir taslağa çözülen
  cookie taşıyorsa):
  - **aynı bağlam** (`formType`, `categorySlug`, `cardId` eşit) → mevcut satır
    **güncellenir** (payload, `expectedUserId`, `expiresAt`); token aynı kalır;
  - **farklı bağlam** ve `replace` yok → `409 { code: 'DRAFT_EXISTS' }`; eski satır, token
    ve cookie dokunulmaz;
  - **farklı bağlam** ve `replace: true` → tek transaction: eski satır silinir, yeni satır
    yazılır, **yeni** token döner. Sessiz silme yok, yetim satır yok.
- Global tavan: `count(consumedAt IS NULL AND expiresAt > now) >= REQUEST_DRAFT_MAX_ACTIVE`
  (varsayılan 10000) ise `503 { code: 'DRAFT_STORAGE_BUSY' }` + `Retry-After: 60`.
  Güncelleme/replace tavana takılmaz (satır sayısı artmaz).
- Yanıt: `{ token, expiresAt }` — yalnız web sunucusuna; tarayıcıya JSON olarak asla.
  DB'de yalnız hash.
- Temizlik: kayıt başına global `deleteMany` **yok**. Süresi dolan satır mantıksal olarak
  geçersizdir (her okuma `expiresAt > now AND consumedAt IS NULL`). Fiziksel temizlik
  `RequestDraftsService.sweepExpired()`: `expiresAt` indeksiyle en fazla 200 satır,
  process başına en fazla 60 dakikada bir, `POST` sonrası `setImmediate` ile. Yeni
  scheduler işi yok.

#### `GET /request-drafts/current?formType&categorySlug&cardId` — cookie + session forward

- Satır yok / süresi dolmuş / tüketilmiş / anahtar uyumsuz → `204`.
- `expectedUserId = null` (anonim): cookie taşıyıcısına `200 { payload }`. Anonim taslak
  oturum açan kimseye **bağlanmaz**.
- `expectedUserId` dolu:
  - oturum yok → `204`;
  - `session.userId === expectedUserId` → `userId = session.userId` yazılır, `200 { payload }`;
  - farklı hesap → **`200 { status: 'wrong-account' }`**; payload yok; **satır silinmez,
    cookie silinmez, `expectedUserId` değişmez**. Doğru hesapla yeniden giriş aynı
    tarayıcıdaki aynı taslağı eksiksiz açar.
- Uç asla `expectedUserId`/`userId` döndürmez.

#### Tüketim — talep transaction'ında

`POST /service-requests` ve `POST /showcase/cards/:id/leads`, forward edilen
`taktic_request_draft` cookie'sini `ServiceRequestCreationContext.draftToken` olarak alır.
Talep yazıldıktan sonra aynı transaction içinde: hash eşleşen, geçerli, anahtarları uyan
ve `expectedUserId` boş **veya** `= created.customerId` olan satıra
`consumedAt = now, userId = created.customerId` yazılır. Uyumsuz taslak dokunulmadan kalır
ve talebi engellemez. İstemci hiçbir id göndermez.

#### `DELETE /request-drafts/current`

Yalnız kullanıcı açıkça **Vazgeç** dediğinde; satır silinir, web cookie'yi temizler.

#### Silinme kuralı (kapalı liste)

TTL doldu (mantıksal; sweep fiziksel) · açık Vazgeç · başarılı talep (tüketim) · onaylı
`replace` · beklenen kullanıcı silindi (Cascade). Başka hiçbir yol taslağı silmez;
`wrong-account` silmez.

- TTL **24 saat**. Tek kullanım. Hash'li token. HttpOnly cookie. Form-kart-kategori bağlı.
  `expectedUserId` ile kilitli.
- URL ve `localStorage`'a hiçbir kişisel veri ya da token yazılmaz.
- Sınır: taslak tarayıcıya bağlıdır; aktivasyon linki başka cihazda açılırsa kullanıcı
  oturum açık, iletişim hesaptan dolu ama içerik boş formla döner. Kabul edilen sınır.

### 1.4 Mevcut uçlara dokunuşlar

- `resolveCustomerForCreate`'in iki `ConflictException`'ına
  `code: 'CUSTOMER_IDENTITY_CONFLICT'` eklenir. Mesaj ve kural aynı.
- `createServiceRequest` context'ine `draftToken?` (1.3 tüketim); vitrin `createLead` aynı
  context'i geçirir.
- `issueForAutoCreatedCustomer(customerId, { redirectTo? })`,
  `buildActivationUrl(rawToken, redirectTo?)`.

### 1.5 IP kimliği ve sahte `X-Forwarded-For`

- IP çözümleme **yalnız API'de**, mevcut doğrulanmış yolla: Express `trust proxy`
  (`TRUST_PROXY` hop sayısı, `main.ts`) + `AuthThrottlerGuard.getTracker` (`req.ip`, yoksa
  socket). Yeni IP çözümleme mantığı yazılmaz; `RequestDraftThrottlerGuard` aynı tracker'ı
  farklı bütçeyle kullanır.
- Web (server action / proxy route) istemci IP'sini **kendisi üretmez**. Yalnız
  `WEB_TRUST_PROXY=true` iken aldığı `X-Forwarded-For` başlığını **değiştirmeden** iletir
  (güvenilir edge, gerçek istemci IP'sini en sağa ekler; API `TRUST_PROXY` ile onu seçer).
  Bayrak kapalıyken hiçbir XFF iletilmez → API socket eşini (web) izler → paylaşımlı,
  sahtelenemez fallback (bugünkü login throttle davranışıyla aynı).
- Doğrudan istemcinin yazdığı XFF hiçbir yapılandırmada tracker olamaz: `TRUST_PROXY`
  kapalıyken Express başlığı yok sayar; açıkken yalnız güvenilen hop sayısı kadar sağdan
  okur.

---

## 2. Web davranışı

### 2.1 `useIdentityCheck` (`app/request-fields/identity-check.ts`)

- Girdi `{ name, phone, email, enabled }`. **`enabled = accountContact === null`** —
  oturumsuz her talep sahibi için; hiçbir UI seçeneği kapatamaz.
- Tetik: üç alan da dolu ve tarayıcı doğrulamasını geçiyor, son alandan çıkıldığında.
  `phone`/`email` değişince sonuç anında `idle` → ilerleme yeniden kilitlenir.
- Yarış: `seq++`, önceki `AbortController.abort()`, yalnız `seq === latest` yanıt uygulanır.
- Durumlar: `idle | checking | ok | login-required | activation-required |
  identity-conflict | unavailable | error`. Ağ hatası / 5xx / timeout / geçersiz gövde →
  **`error`**; hiçbir koşulda `ok` sayılmaz.
- Same-origin proxy route'ları: `app/api/auth/request-identity-check/route.ts`,
  `…/activate/route.ts`. Cookie forward etmez; gövdeyi aynen iletir; API status'unu döner;
  XFF'i 1.5'teki kurala göre iletir ya da iletmez.

### 2.2 `IdentityNotice` (ContactSection içinde, e-posta alanının altında)

| Durum | Metin | CTA |
|---|---|---|
| `checking` | İletişim bilgileriniz kontrol ediliyor… | — |
| `identity-conflict` | Bu telefon numarası ve e-posta iki farklı müşteri hesabına bağlı. Tek bir hesaba ait iletişim bilgileriyle devam edin. | yok |
| `login-required` | Bu iletişim bilgileriyle bir hesabınız var. Talebinizi hesabınızla devam ettirmek için giriş yapın. | **Giriş yap** |
| `activation-required` | Bu bilgilerle daha önce oluşturulmuş hesabınızı etkinleştirin. | **Etkinleştirme bağlantısı gönder** → sonrası: Bağlantıyı hesabınıza kayıtlı e-posta adresine gönderdik. Şifrenizi belirlediğinizde kaldığınız yerden devam edeceksiniz. |
| `unavailable` | Bu iletişim bilgileri müşteri talebi için kullanılamaz. Farklı bir telefon numarası veya e-posta girin. | yok |
| `error` | İletişim bilgileri doğrulanamadı, tekrar deneyin. | **Tekrar dene** |
| taslak kaydı 429/503 | Taslak şu anda kaydedilemedi. Birkaç dakika sonra tekrar deneyin. | **Tekrar dene** |
| taslak kaydı `DRAFT_EXISTS` | Yeni taslağa geçerseniz önceki taslak silinir. Devam edilsin mi? | **Evet, geç** (`replace: true`) / **Vazgeç** |
| dönüşte `wrong-account` | Bu talebe devam etmek için iletişim bilgilerine bağlı hesabınızla giriş yapın. | **Hesap değiştir** (`/logout` → `/login?redirectTo=<aynı form>`) |

CTA sırası: `saveRequestDraftAction(formData)` → başarılıysa `Giriş yap` için
`/login?redirectTo=<form yolu>`; aktivasyon için `activate` ucu. `DRAFT_NOT_CONTINUABLE`
→ notice yeniden `checking` → güncel durum. Taslak kaydı başarısızsa form içeriği
ekranda kalır (client state) ve CTA tekrar denenebilir.

### 2.3 Kilitler

- Normal form: `STEPS = İletişim → İş detayı → Konum & zaman`. Adım 1'den "Devam et"
  misafirde yalnız `ok` iken; giriş yapmış müşteride doğrudan.
- Vitrin: bölümler `İletişim → Talebiniz → İşin yapılacağı yer → Zamanlama → onay`.
  "Kod gönder" ve "Talebi gönder" misafirde yalnız `ok`; hesabı olana SMS gitmez.
- `error` dahil `ok` dışı her durumda kilitli.

### 2.4 Oturumlu müşteri

- İletişim hesaptan dolu; kimlik kontrolü çalışmaz (talep zaten oturumdaki hesaba bağlanır).
- "Farklı bir iletişim kişisi kullanacağım" **yalnız oturumluda** render edilir; alt metin:
  "Talep yine hesabınıza bağlı kalır; yalnız bu talep için iletişim kişisi değişir."
  API `resolveCustomerForCreate` CUSTOMER oturumunda `user.id` döner — yeni hesap/çatışma
  üretmez. Vitrin'de telefon kanıtı bu kişinin numarasına alınır (mevcut kural).
- Misafirde bu seçenek yoktur; kimlik gate'i her zaman açıktır.

### 2.5 Submit hataları

- `submitServiceRequestAction` 4xx'te fırlatmak yerine `{ ok:false, code, message }` döner;
  RequestForm gönderimi `onSubmit + startTransition` ile yapar (React 19 form reset'inden
  kaçınmak için; vitrin formuyla aynı) ve inline gösterir.
- `showcase-lead-errors.ts` → `lib/request-refusal-text.ts` (iki form).
  `CUSTOMER_IDENTITY_CONFLICT` → 2.2'deki conflict cümlesi; generic API mesajını gölgelemez
  (mevcut öncelik korunur).
- Başarılı gönderim: sunucu taslağı transaction içinde tüketti; web action
  `taktic_request_draft` cookie'sini `maxAge: 0` ile temizler.

### 2.6 Cookie ve dönüş

- `taktic_request_draft` **web origin'inde** yazılır: server action API'den `{ token }`
  alır, `cookies().set(name, token, { httpOnly: true, sameSite: 'lax', path: '/',
  maxAge: 86400, ...(await appCookieOptions({ maxAge: 86400 })) })` — yani `secure` kararını
  da (diğer tüm çerezlerle aynı) `appCookieOptions`/`requestIsOverHttps()` verir, doğrudan
  `NODE_ENV` okunmaz (bkz. `session-cookie.spec.ts` mimari koruması: `secure:` anahtarı ve
  `process.env.NODE_ENV` yalnızca `session-cookie.ts`'te bulunabilir — Next'in `NODE_ENV`'i
  build-time sabitine katlamasından kaynaklanan geçmiş bir hatanın regresyon testi). API
  `Set-Cookie` göndermez; kaybolacak başlık yoktur. Yerel HTTP'de çalışır; production edge'i
  `x-forwarded-proto: https` gönderdiğinden `requestIsOverHttps()` orada `true` döner ve
  Secure yine zorunlu olur.
- API cookie'yi `apiFetch`'in forward ettiği `Cookie` başlığından okur (session ile aynı).
- Form sayfaları (server component): cookie varsa `GET /request-drafts/current` →
  `200 payload` → `initialDraft`; `wrong-account` → notice + boş form (taslak yerinde);
  `204` → boş form.
- Geri yükleme: `LocationFields initialValue`, `DescriptionField / RequestField /
  UrgencySelect / BudgetFields defaultValue` (yeni proplar), vitrin `urgencyBucket`
  `defaultChecked`. Taslak yalnız ön-doldurur; otomatik gönderim yok.
- Vitrin dönüşünde kart `/showcase/cards/:id` ile yeniden yüklenir (yayında değilse 404,
  taslak açılmaz); kapsam gönderimde sunucuda doğrulanır (`AREA_NOT_SERVED` → genel
  talep CTA).
- Login sonrası kimlik uyumu: form iletişimi oturumdan türetir, gövdede iletişim taşımaz;
  `expectedUserId` eşleşmezse taslak zaten açılmaz (1.3).

---

## 3. Güvenlik özeti

- Kimlik ucu sınırlı bir oracle: throttle, beş durum, `unavailable` rol/kayıt söylemez,
  `activate` her zaman 202, alıcı yalnız DB e-postası → hesap ele geçirme yolu kapalı.
- Taslak: `expectedUserId` sunucu türetir, istemciye dönmez/gelmez, Cascade ile asla
  anonimleşmez; yanlış hesapta yalnız erişim reddi, veri korunur; anonim taslak kimseye
  otomatik bağlanmaz; yeni müşteride bağlama yalnız talep transaction'ında.
- Yazma ucu: IP throttle (5/10 dk) + tarayıcı başına tek aktif satır (güncelle / onaylı
  replace) + global tavan (503, Retry-After) + payload allow-list ≤ 32 KB + TTL sweep.
- IP kimliği yalnız API'nin mevcut `trust proxy` yolundan; web XFF üretmez; bayrak
  kapalıyken sahtelenemez paylaşımlı fallback.
- Misafirde gate atlanamaz; ağ hatası kilitler. Son savunma `resolveCustomerForCreate`.

---

## 4. Dosya etkileri

**API**
- `src/modules/auth/request-identity.controller.ts`, `request-identity.service.ts`
  (`classifyRequestIdentity`), `dto/request-identity.dto.ts`
- `src/modules/request-drafts/` — `request-drafts.module.ts`, `.controller.ts`,
  `.service.ts` (create/update/replace, current, consume, discard, `sweepExpired`),
  `request-draft.throttler.ts`, `dto/`, `request-draft-cookie.ts`
- `src/modules/customer-activation/customer-activation.service.ts` (`redirectTo`)
- `src/modules/service-requests/service-requests.service.ts` (`code`, `draftToken` tüketimi)
- `src/modules/showcase/showcase-lead.service.ts` (context geçişi)
- `prisma/schema.prisma` + `prisma/migrations/<ts>_add_request_draft/` (tablo, enum,
  FK `expectedUserId ON DELETE CASCADE`, `userId ON DELETE SET NULL`, indeksler)
- Testler: `test/request-identity.spec.ts`, `test/request-drafts.spec.ts`,
  `test/customer-activation*.spec.ts` (redirectTo), `test/service-requests*.spec.ts` ve
  `test/showcase-lead-flow.spec.ts` ekleri

**Web**
- `app/request-fields/identity-check.ts`, `identity-notice.tsx`, `contact-section.tsx`
  (notice yuvası, alt metin), `question-field.tsx` / `description-field.tsx` /
  `timing-fields.tsx` / `budget-fields.tsx` (`defaultValue`)
- `lib/request-refusal-text.ts` (eski `showcase-lead-errors.ts` yerine),
  `lib/request-drafts.ts` (save/discard server action, cookie, `forwardedForHeaders`),
  `lib/api.ts` (`forwardedForHeaders` kullanımı)
- `app/api/auth/request-identity-check/route.ts`, `…/activate/route.ts`
- `app/categories/[slug]/page.tsx`, `request-form.tsx` (adım sırası, inline hata, taslak),
  `app/categories/actions.ts` (sonuç döndürme, cookie temizliği)
- `app/vitrin/[cardId]/page.tsx`, `lead-form.tsx`, `actions.ts` (bölüm sırası, gate,
  taslak)
- `app/activate-customer/page.tsx`, `actions.ts` (`redirectTo`)
- `app/globals.css` (notice)
- Testler: `test/request-refusal-text.spec.ts`, `test/request-drafts.spec.ts`
  (`forwardedForHeaders`), `test/identity-check.spec.ts` (sıra/iptal mantığı)

**E2E**
- Yeni `tests/request-identity-gate.spec.ts`
- `tests/request-*.spec.ts`, `tests/showcase-placement-lead.spec.ts`,
  `tests/showcase-phone-bypass.spec.ts`: adım/bölüm sırası güncellemeleri

---

## 5. Test planı

### API
- Sınıflandırma matrisi (none/active/claimable/blocked × aynı/farklı satır); throttle 429;
  yanıtta yalnız `status`.
- **Saldırgan:** mağdur telefonuna ait claimable hesap + saldırganın e-postası → `activate`
  202; outbox'ta mail **yalnız** mağdurun DB e-postasına; saldırgan adresine hiçbir mail
  yok. Hesabın `email` null → 202, mail yok. `redirectTo` doğrulama; geçersizse link taşımaz.
- Taslak: `identity` saklanmaz; `expectedUserId` doğru dolar; conflict/unavailable → 409,
  satır yok; payload'da iletişim reddi; TTL; **GET yanlış hesap → `wrong-account`, satır ve
  `expectedUserId` değişmeden durur, cookie geçerli; ardından doğru oturumla GET → 200
  payload, `userId` bağlanır**; anonim taslak oturumlu kullanıcıya bağlanmaz; oturumsuz
  korumalı taslak 204; tüketim transaction içinde ve tek seferlik; uyumsuz `expectedUserId`
  ile tüketim yok ama talep oluşur.
- **FK:** `expectedUserId` sahibi silinince satır yok (Cascade) ve aynı cookie ile GET 204;
  `userId` sahibi silinince satır kalır, `userId = null`; korumalı satır hiçbir işlemle
  `expectedUserId = null` olmaz.
- **Yazma sınırı:** aynı IP'den 6. `POST` 429; aynı cookie + aynı bağlam → yeni satır yok,
  aynı `tokenHash`, payload güncel; **aynı cookie + farklı form tipi, `replace` yok → 409
  `DRAFT_EXISTS`, satır sayısı ve `tokenHash` sabit, eski cookie ile GET 200; `replace: true`
  → eski satır yok, tek yeni satır, yeni token, eski token ile GET 204**;
  `REQUEST_DRAFT_MAX_ACTIVE` düşük değerle aşılınca 503 + `Retry-After`, satır artmaz;
  sweep ≤ 200 satır ve saatte bir.
- **Sahte XFF:** `TRUST_PROXY` kapalı test uygulamasında her istekte farklı sahte
  `X-Forwarded-For` ile 6. `POST /request-drafts` yine 429; identity-check için aynı.
- `CUSTOMER_IDENTITY_CONFLICT` kodu; `resolveCustomerForCreate` davranışı aynı.

### Web birim
- `forwardedForHeaders()`: bayrak kapalıyken boş; açıkken alınan başlığı aynen; asla
  sentezlemez.
- `useIdentityCheck` sıra/iptal: geç gelen eski yanıt uygulanmaz; alan değişince `idle`.
- `request-refusal-text`: öncelik özel kod → API mesajı → generic.

### E2E — her iki form, Chromium + WebKit
1. Yeni telefon + yeni e-posta → başarı; taslak tüketilmiş, cookie temiz.
2. Aynı aktif hesabın ikilisi → `login-required`; doğru hesapla giriş → taslak eksiksiz
   (konum, açıklama, cevap, zamanlama, vitrin bucket), iletişim hesaptan, talep o hesaba.
3. **Login CTA sonrası yanlış müşteri hesabıyla giriş → `wrong-account` + Hesap değiştir;
   payload görünmez; bu oturumla kaydedilen taslak içeriğiyle talep yok; ardından doğru
   hesapla giriş → aynı taslak eksiksiz geri gelir ve gönderilir.**
4. Claimable hesap → aktivasyon maili yalnız hesabın kayıtlı e-postasına (form e-postası
   farklıysa ona gitmez); link `redirectTo` taşır; şifre sonrası oturum açık forma dönüş,
   taslakla gönderim.
5. Telefon A + e-posta B → `identity-conflict`; SMS/talep/lead/taslak yok.
6. Provider/admin/pasif → `unavailable`.
7. Lookup ağ hatası (route 500 stub) → kilit; "Kod gönder"/"Devam et" devre dışı; Tekrar
   dene ile açılır.
8. Vitrin dönüşünde kart kapanmış → 404, lead yok; kapsam değişmiş → `AREA_NOT_SERVED` +
   genel talep CTA.
9. Submit yarışı (gate `ok` sonrası çakışan hesap oluşturulur) → `CUSTOMER_IDENTITY_CONFLICT`
   inline, generic değil, kayıt yok.
10. Oturumlu + farklı iletişim kişisi → kontrol çalışmaz, talep oturumdaki hesaba, yeni
    hesap yok.
11. Misafirde farklı iletişim kişisi seçeneği DOM'da yok.
12. Taslak kaydı 429/503 → anlaşılır mesaj + Tekrar dene, form içeriği ekranda kalır.
13. **Marketplace taslağı varken vitrin formunda Giriş yap → onay diyaloğu; Vazgeç → eski
    taslak ve token korunur (marketplace formuna dönünce açılır); Evet, geç → eski satır
    silinmiş, yalnız yeni satır ve yeni cookie.**

---

## 6. Ekran metinleri (tam liste)

Bkz. 2.2 tablosu. Ek: oturumlu "farklı iletişim kişisi" alt metni (2.4) ve vitrin bölüm
başlıkları `İletişim`, `Talebiniz`, `İşin yapılacağı yer`, `Zamanlama`; normal form adım
etiketleri `İletişim`, `İş detayı`, `Konum & zaman`.

## 7. Kanıtlar (tasarım düzeyi)

- **Yanlış hesap → doğru hesap:** `wrong-account` yalnız durum döner; satır, `expectedUserId`,
  `tokenHash`, cookie değişmez (silme yolları kapalı liste). Doğru hesapla giriş aynı
  cookie ile `200 payload` alır. API testi ardışık çağrıları, E2E #3 alan alan geri gelişi
  doğrular.
- **`expectedUserId` anonimleşmez:** FK `ON DELETE CASCADE`; hiçbir kod yolu `null` yazmaz.
  API testi: kullanıcı silinince satır yok; `userId` karşılaştırma testi SetNull.
- **Sınırsız yazım kapalı:** IP throttle + tek aktif satır (güncelle/onaylı replace) +
  global tavan + payload sınırı + sweep; sahte XFF tracker'ı değiştirmez.
