# AUTH-PROVIDER-CONTACT-001 — Sağlayıcı hesabı iletişim kanıtı (e-posta + telefon)

Tarih: 2026-09-19 · Taban: `origin/main@3c564de1` · Bağlam: CMP-001 §9 (`2026-09-19-cmp-001-campaign-engine-design.md`)

## 1. Amaç ve sınır

Sağlayıcı (PROVIDER) hesabı, müşteriyle **aynı kanonik kaynak** olan `User.emailVerifiedAt` ve
`User.phoneVerifiedAt` üzerinde, gerçek e-posta teslimi ve SMS OTP ile kanıt kazanabilsin. Kanıt hiçbir
mevcut kapıya girmez: başvuru, onay, profil, teklif, satın alma kanıtsız da aynen çalışır. Tek etkisi
ileride K1 kampanya uygunluğunun (`PROVIDER_ELIGIBILITY_REACHED`) güvenilir olmasıdır. Bu PR kampanya
modülü, `FactSourceRegistry`, kampanya tablosu veya kredi grant'i **eklemez**; yalnız fact callback
noktalarını dosya:satır ile belgeler (§6).

## 2. Envanter — bugünkü durum (`3c564de1`)

### 2.1 E-posta kanıtı (CUSTOMER-only)

| Nokta | Davranış |
| --- | --- |
| `apps/api/src/modules/auth/email-verification.controller.ts:32-36` | `POST /auth/email-verification/resend` — AuthGuard, rol kısıtı yok → `service.resend(user.id)` |
| `…/email-verification.service.ts:165` | `issue()`: `user.role !== CUSTOMER` → sessiz `return` (**PROVIDER için token üretilmez**) |
| `…/email-verification.service.ts:132-133` | **tek yazıcı**: `tx.user.updateMany WHERE id, email = emailSnapshot, emailVerifiedAt IS NULL` |
| `…/email-verification.controller.ts:48-50` | `POST /auth/email-verification/confirm` — oturumsuz, token kanıt |
| `apps/api/src/modules/auth/auth.controller.ts:98` | yalnız `register-customer` `issueForNewCustomer` çağırır; `register-provider` (`:107`) başlatmaz |
| `…/customer-activation/customer-activation.service.ts:440-441` | `delivery = EMAIL_DELIVERY` aktivasyon tüketimi → `emailVerifiedAt` (müşteri; ADMIN_LINK yazmaz — AUTH-EMAIL-001) |
| `…/notifications/templates/transactional-templates.ts:528-568` | `email-verification` şablonu müşteri kopyası ("HİZMET ALAN", "ilk talebiniz") |
| `apps/web/app/e-posta-dogrula/page.tsx` | oturumsuz confirm sayfası; başarıda `/requests/my`'a yönlendirir (müşteri varsayımı) |

### 2.2 Telefon kanıtı (CUSTOMER-only)

| Nokta | Davranış |
| --- | --- |
| `…/phone-verification/phone-verification.controller.ts:28-52` | `POST /service-requests/:id/phone-verification` (TurnstileGuard→AuthGuard→RolesGuard, `@Roles(CUSTOMER, SUPER_ADMIN)`) ve `/verify` |
| `…/phone-verification.service.ts:210-218` | **tek hesap yazıcısı**: `user.role === CUSTOMER && customerId === user.id` ve `sameNumber(account.phone, normalizedPhone)` → `updateMany WHERE id, phone = account.phone, phoneVerifiedAt IS NULL` |
| `…/phone-verification.service.ts:255-411` | vitrin standalone akışı: `requestId: null` satırlar, `findRedeemableVerification` bunları lead'e bağlar |
| `prisma/schema.prisma:1042-1075` `PhoneVerification` | `requestId String?`; **`userId` yok** — hesap amaçlı satırı vitrin satırından ayıracak alan bulunmuyor |

### 2.3 Sağlayıcı yüzeyleri ve `User.phone/email` yazma yolları

| Nokta | Davranış |
| --- | --- |
| `auth.service.ts:254-296` `register()` | `register-provider`: `User{email (zorunlu), phone (opsiyonel, E.164)}` |
| `provider-claim.service.ts:386-410` | claim ile açılan sağlayıcı hesabı: `User.email` yazılır, **`User.phone` NULL** |
| `providers.service.ts:793-900` `updateProvider` | yalnız `ProviderProfile.phone/email` yazar; `User.email/phone`'a dokunmaz |
| `account.controller.ts:40-42` + `account.service.ts:121` | `PATCH /account/profile` **CUSTOMER** rolü; numara değişince aynı statement'ta `phoneVerifiedAt: null` |
| `apps/web/app/providers/[id]/page.tsx` | sağlayıcı paneli "İşletme profili" — `provider.phone/email` (işletme iletişimi) gösterir; hesap iletişimi/rozet yok |
| `apps/web/app/account/profile/page.tsx:230-252` | müşteri rozet bileşeni (`contactVerification`, `tag tag-ink/tag-neutral`) |

**Sonuç:** Sağlayıcı hesabının `User.email` veya `User.phone`'unu değiştiren **hiçbir mevcut yol yok**.
Bu PR yeni bir değiştirme akışı **eklemez** (kapsam dışı); §5.

## 3. Karar: yaklaşım

Üç seçenek değerlendirildi:

- **A (seçilen):** e-posta için mevcut `resend/confirm` yolunu PROVIDER'a açmak; telefon için mevcut
  `PhoneVerification` tablosuna **additive** `userId` sütunu ekleyip dar `providers/me/phone-verification`
  uçlarını mevcut servise eklemek.
- **B:** telefon için `requestId: null` satırlarını `normalizedPhone` ile paylaşmak (migration yok). Reddedildi:
  hesap OTP'si tüketildikten sonra `findRedeemableVerification` (`phone-verification.service.ts:377-396`)
  aynı numarayla gelen bir vitrin lead'ini **OTP'siz** kanıtlı sayar (çapraz akış sızıntısı); ayrıca iki
  akışın "tek canlı kod" kuralı birbirini iptal eder.
- **C:** ayrı `AccountPhoneVerification` tablosu. Reddedildi: OTP hash/deneme/kilit/IP bütçesi kodunun
  ikinci kopyası; CMP-001 §9.2.2 "mevcut tablo + `userId`" sözleşmesine aykırı.

## 4. Tasarım

### 4.1 Şema (tek additive migration)

`prisma/migrations/20260919120000_add_phone_verification_user_id/migration.sql`

```sql
ALTER TABLE "PhoneVerification" ADD COLUMN "userId" TEXT;
ALTER TABLE "PhoneVerification" ADD CONSTRAINT "PhoneVerification_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "PhoneVerification_userId_createdAt_idx" ON "PhoneVerification"("userId", "createdAt");
```

- Nullable, default yok, backfill yok: mevcut satırlar (talep satırları ve vitrin satırları) `userId = NULL`
  okunur — ki zaten öyleydiler. Kör backfill yapılmaz.
- Satır sınıfları: **talep** (`requestId ≠ NULL`), **vitrin** (`requestId = NULL ∧ userId = NULL`),
  **hesap** (`requestId = NULL ∧ userId ≠ NULL`). Vitrin akışının üç sorgusu `userId: null` ile daraltılır,
  böylece hesap satırı lead kanıtı olarak harcanamaz.
- Dry-run: `prisma migrate diff --from-migrations --to-schema-datamodel` boş fark; test DB'sinde
  `migrate deploy` (API suite + E2E `prepare-database`) ve E2E veri hazırlığı bunu her koşuda uygular.
  Veri fingerprint planı (staging/prod uygulaması bu PR'ın dışında): öncesi/sonrası
  `SELECT count(*), count(requestId), count(consumedAt) FROM "PhoneVerification"` ve
  `count(*) WHERE "userId" IS NOT NULL = 0` beklentisi.

### 4.2 E-posta

- `EmailVerificationService.issue()` (`email-verification.service.ts:165`): rol kapısı
  `role ∈ {CUSTOMER, PROVIDER}` olur; diğer roller (SUPER_ADMIN) için sessiz `return` **korunur**
  (`resend` yanıtı `accepted`, yan etki yok — mevcut enumerasyon-yok sözleşmesi).
- Şablon role göre seçilir: CUSTOMER → `email-verification` (değişmez); PROVIDER → **yeni**
  `provider-email-verification` (audience "HİZMET VEREN", panel kopyası, aynı 7 gün TTL, aynı
  `actionUrl = /e-posta-dogrula?token=…`). Kod/bağlantı yalnız mail gövdesindedir; NotificationLog
  `actionUrl` saklamaz (mevcut kural).
- `confirm()` yazıcısı **değişmez** (`updateMany WHERE id, email = emailSnapshot, emailVerifiedAt IS NULL`).
  Yanıta `accountKind: 'CUSTOMER' | 'PROVIDER'` eklenir; web confirm sayfası buna göre `/providers/me`
  ya da `/requests/my`'a yönlendirir. (Token sahibi zaten hesabın sahibidir; rol sızıntısı değildir.)
- `register-provider` (`auth.controller.ts:107`) kayıt sonrası `issueForNewAccount(userId)` çağırır
  (CMP-001 §9.2.1); best-effort, kayıt sonucunu etkilemez.
- Cooldown 5 dk / pencere 24 saatte 5 — aynen. Doğrulanmış hesaba tekrar istek: sessiz no-op (`accepted`).
- Yazmayanlar (değişmez): admin activation linki (`delivery = ADMIN_LINK`), `delivery = NULL` eski token,
  `ProviderClaimToken`/`ProviderInviteToken` tüketimi, admin onayı. Sağlayıcı için ayrıca **hiçbir**
  yeni yazıcı yoktur.

### 4.3 Telefon

Yeni denetleyici `apps/api/src/modules/phone-verification/provider-phone-verification.controller.ts`:

| Uç | Guard sırası | Rol | Sonuç |
| --- | --- | --- | --- |
| `POST /providers/me/phone-verification` | `TurnstileGuard(phone-code-send)` → `AuthGuard` → `RolesGuard` | PROVIDER | 201 `{status:'sent', delivery, maskedPhone, expiresAt}` |
| `POST /providers/me/phone-verification/verify` | `AuthGuard` → `RolesGuard` | PROVIDER | 201 `{status:'verified', phoneVerifiedAt}` |

Guard sırası `service-requests/:id/phone-verification` ile birebir (Turnstile önce: token oturumdan bağımsız
zorunlu; verify tokensiz, kendi deneme bütçesi var). Token yalnız `x-turnstile-token` başlığında taşınır.

`PhoneVerificationService.sendAccountCode(user, meta)`:
1. Taze `User{phone, phoneVerifiedAt, isActive}` okunur. `phoneVerifiedAt ≠ NULL` → **409**
   `ACCOUNT_PHONE_ALREADY_VERIFIED`. `phone = NULL` veya ayrıştırılamıyor → **409** `ACCOUNT_PHONE_MISSING`
   (UI bu durumda CTA göstermez).
2. `normalizedPhone = normalizePhoneNumber(user.phone)` (E.164).
3. Bütçe: aynı iki sayaç (`normalizedPhone`/saat, `ipAddress`/saat), aynı pencere, tek 429 metni.
4. Tx: `updateMany WHERE userId = user.id, consumedAt IS NULL → consumedAt = now` (tek canlı hesap kodu);
   `create {normalizedPhone, codeHash(bcrypt), expiresAt, requestId: null, userId: user.id, ip, ua}`.
5. Tx dışında `sendSms(phone-verification-code, {userId})`. Kod hiçbir yanıtta/logda yoktur.

`PhoneVerificationService.verifyAccountCode(user, code, meta)` — `runSerializable`:
1. Taze `User{phone, phoneVerifiedAt}`; `phoneVerifiedAt ≠ NULL` → 409.
2. Aday: `findFirst WHERE userId = user.id, requestId IS NULL, consumedAt IS NULL ORDER BY createdAt DESC`.
   Yok/expired/kilitli → 400 `PHONE_VERIFICATION_INVALID` (tek metin).
3. **Numara bağlılığı:** `candidate.normalizedPhone !== normalizePhoneNumber(user.phone)` → 400 (kod
   başka numara içindir; hesap numarası bu arada değişmişse eski kod yeni numarayı kanıtlayamaz).
4. Yanlış kod → `attemptCount+1`, limitte `lockedUntil`; sayaç commit edilir, sonra 400.
5. Doğru kod (gönderilen ya da yalnız yerel/E2E test bypass sözleşmesi) → satır `consumedAt`,
   `verifiedByTestBypass`; **yazıcı**: `tx.user.updateMany WHERE id = user.id, phone = <okunan ham
   değer>, phoneVerifiedAt IS NULL → phoneVerifiedAt = now`. `count ≠ 1` → yarışta başkası yazdı → 409.
6. Talep yayını, outbox vb. **yok** — bu yol yalnız hesabı damgalar.

Vitrin standalone akışı (`sendStandaloneCode`, `verifyStandaloneCode`, `findRedeemableVerification`)
`userId: null` ile daraltılır; davranışı başka türlü değişmez. Talep akışı (`sendCode`/`verifyCode`)
değişmez.

### 4.4 Rol/yetki matrisi

| Çağıran | `POST /auth/email-verification/resend` | `POST /providers/me/phone-verification[/verify]` |
| --- | --- | --- |
| anon | 401 | 403 `TURNSTILE_REQUIRED` (tokensiz) → 401 (tokenli, send); 401 (verify) |
| CUSTOMER | 202 `accepted` (müşteri şablonu, mevcut) | 403 |
| SUPER_ADMIN | 202 `accepted`, **yan etki yok** | 403 |
| PROVIDER, profili yok | 202, kendi adresine sağlayıcı şablonu | 201 — kanıt hesaba aittir, profil şartı yok |
| PROVIDER, başka sağlayıcı | — (uçlar `me`; id parametresi yok) | — |
| PROVIDER, telefonu NULL | 202 | 409 `ACCOUNT_PHONE_MISSING` |
| PROVIDER, zaten doğrulanmış | 202, sessiz no-op | 409 `ACCOUNT_PHONE_ALREADY_VERIFIED` |

Uçlar hesap kimliğini yalnız oturumdan alır; başka kullanıcı/telefon/e-posta adlandırılamaz, bu yüzden
enumerasyon yüzeyi yoktur. Turnstile `required/failed/unavailable` yanıtları mevcut kodlarla aynıdır ve
servis çağrılmadan önce döner (sıfır yan etki).

### 4.5 Web (sağlayıcı paneli)

`apps/web/app/providers/[id]/page.tsx` (İşletme profili) ana sütuna **"Hesap iletişimi"** kartı eklenir
(`account-contact-card.tsx`, client). Kaynak: `getCurrentUser()` (`/auth/me` → `emailVerifiedAt`,
`phoneVerifiedAt`, `email`, `phone`). İki bağımsız satır:

- **E-posta** — adres + rozet (`contactVerification`; `Doğrulandı`/`Doğrulanmadı`). Doğrulanmışsa
  `formatDateTime(at)`; değilse "Doğrulama bağlantısı gönder" (server action → `resend`), sonuç
  `?email=sent|failed` sözcüğüyle döner.
- **Telefon** — numara + rozet. Doğrulanmışsa tarih; numara yoksa "Hesabınızda kayıtlı telefon yok"
  (CTA yok); değilse `otp-row` (REQ-UX-012 ile aynı düzen): "Doğrulama kodu gönder" (Turnstile
  `acquire(phoneCodeSend)` → server action → başlık) + 6 haneli kod + "Doğrula". Sonuç
  `?phone=sent|verified|invalid|rate-limited|already-verified|challenge-failed|challenge-unavailable|failed`.
- Turnstile token: yalnız server action argümanı → `x-turnstile-token`. URL'ye, HTML'ye, storage'a, loga
  girmez (mevcut `PhoneVerificationCard` ile aynı sözleşme).
- Doğrulanmış kanalda CTA render edilmez. Kart açıklaması işletme iletişiminin (profil formu) ayrı olduğunu
  ve doğrulamanın hesap numarası/adresi için yapıldığını söyler.
- `e-posta-dogrula` sayfası `accountKind` ile sağlayıcıyı `/providers/me`'ye yönlendirir.
- Mevcut profil kartları, teklif/başvuru ekranları değişmez. 320/768/1024/1440'ta taşma yok
  (`.pdash-main` çocuğuna genişlik verilmez; `otp-row` zaten katlanır).

## 5. İletişim değişimi

Sağlayıcının `User.phone`/`User.email` değiştirebildiği **mevcut yol yok** (§2.3). Bu PR yeni geniş
profil/ayar düzenleme özelliği **eklemez**. Gelecekte böyle bir yol açılırsa kural: kanıt aynı `UPDATE`
statement'ında NULL yapılır (kalıp `account.service.ts:121`), E.164 eşitliği değişim sayılmaz.
`ProviderProfile.phone/email` değişimi hesap kanıtını etkilemez (kanıt hesabın numarasına/adresine aittir).
Müşteri tarafı (`PATCH /account/profile`) aynen korunur; regresyon testi mevcut spec'lerdedir.

## 6. Kampanya bağlantı sözleşmesi (CMP-002 için; bu PR'da runtime yok)

Bu PR `FactSourceRegistry`, kampanya tablosu, `onProviderFact` veya credit grant **içermez**. K1 yalnız
üç olgu **ilk kez birlikte** doğru olduğunda `PROVIDER_ELIGIBILITY_REACHED:<factSetKey>:<providerId>`
üretecektir (CMP-001 §8.3); bu PR'da hiçbir kampanya/credit yazımı olmadığı testle gösterilir
(`CreditTransaction` sayısı ve ledger değişmez).

Sağlayıcı yazıcıları ve **idempotent fact callback noktaları** (kanıtı kalıcılaştıran guard'lı
`updateMany`'nin `count === 1` olduğu, aynı transaction içinde, commit'ten hemen önce):

| Olgu | Yazıcı (guard'lı `updateMany`) | Callback noktası (`// CMP-002 fact callback: …` yorumu) |
| --- | --- | --- |
| `EMAIL_VERIFIED` | `EmailVerificationService.confirm` — `email-verification.service.ts:149-152` (`WHERE id, email = emailSnapshot, emailVerifiedAt IS NULL`), rolden bağımsız **tek** yazıcı | `apps/api/src/modules/email-verification/email-verification.service.ts:154-160` — `proven.count === 1` iken, aynı tx içinde, token'ları kapatan `updateMany`'den önce |
| `PHONE_VERIFIED` (PROVIDER) | `PhoneVerificationService.verifyAccountCode` — `phone-verification.service.ts:409-412` (`WHERE id, phone = <okunan>, phoneVerifiedAt IS NULL`) | `apps/api/src/modules/phone-verification/phone-verification.service.ts:421-425` — `proven.count === 1` iken, `runSerializable` tx'inin son adımı |
| `PHONE_VERIFIED` (CUSTOMER, mevcut) | `verifyCode` — `phone-verification.service.ts:214-217` | Callback **yok** (`:218-220` yorumu): müşterinin sağlayıcı profili olmadığından olgu anlamsızdır |
| `PROVIDER_APPROVED` | `ProvidersService.updateProviderStatus` — `providers.service.ts:960-970` (`status: APPROVED, approvedAt: now`) | `apps/api/src/modules/providers/providers.service.ts:1016-1020` — yalnız `dto.status === APPROVED && existing.status !== APPROVED` dalında, vitrin yerleşimleri geri alındıktan sonra, tx commit'inden önce |

Callback imzası (CMP-001 §8.3): `campaignEngine.onProviderFact(tx, providerId, fact)`; e-posta/telefon
için `providerId`, `ProviderProfile.userId = user.id` ile çözülür (profil yoksa olgu yazılır ama uygunluk
okuması `false` döner — §8.2 `read`). Tekrar yazım (`count === 0`) callback'i çağırmaz; motor ayrıca
`triggerEventKey` tekilliğiyle korunur. Hook `try/catch` içinde olacak ve olgu yazımını geri almayacaktır.

## 7. Testler

**API** (`apps/api/test/provider-contact-proof.spec.ts` + mevcut spec güncellemeleri):
- e-posta: provider `resend` → `provider-email-verification` maili, token tüketimi → yalnız kendi
  `emailVerifiedAt`; tekrar tüketim 400; admin-link aktivasyon ve `delivery = NULL` token yazmaz
  (`customer-activation-email-proof.spec.ts` mevcut); SUPER_ADMIN resend yan etkisiz; register-provider
  otomatik gönderim (`email-verification.spec.ts` güncellenir).
- telefon: doğru OTP → yalnız kendi `phoneVerifiedAt`, satır `consumedAt`, `userId`; yanlış/tekrar/
  süresi geçmiş/kilit; başka kullanıcının kodu; CUSTOMER/SUPER_ADMIN/anon 403/401; telefonu NULL 409;
  doğrulanmış 409; rate limit 429; Turnstile required/failed/unavailable sıfır yan etki
  (`turnstile-protection.spec.ts` ROUTES tablosuna eklenir); vitrin standalone akışı hesap satırını
  redeem edemez; hiçbir kampanya/credit yazımı yok.
- customer regresyon: mevcut `email-verification`, `phone-verification`, `account-phone-proof`,
  `customer-activation-email-proof`, `request-phone-verification-pending` spec'leri yeşil.

**Web unit** (`apps/web/test/provider-account-contact.spec.ts`): kartın üç durumu (doğrulanmadı / doğrulandı
+ tarih / telefon yok), doğrulanmışta CTA yok, HTML'de token yok. `transactional-email-render.spec.ts`
yeni şablon tablosu.

**E2E** (`e2e/tests/provider-contact-proof.spec.ts`): sağlayıcı profilinde iki rozet "Doğrulanmadı" →
e-posta bağlantısı gönder → outbox'tan `provider-email-verification` URL'si → doğrula → rozet
"Doğrulandı" + tarih, CTA yok; telefon kodu gönder → SMS outbox → doğrula → rozet; URL/HTML/
localStorage/sessionStorage'da `turnstile-test:` yok; 320/768/1024/1440 taşma yok; müşteri
`account-settings` ve `phone-verification-gate` spec'leri regresyon.

## 8. Kapsam dışı

Kampanya tanımı, kredi lotu, K1 aktivasyonu, `FactSourceRegistry`, admin ekranında rozet/doğrulama,
referral, sağlayıcı için e-posta/telefon **değiştirme** akışı, provider onboarding'i bloklama, staging/prod
testi, gerçek dış sağlayıcıya gönderim, Cloudflare/Lemon/.env değişikliği.
