# AUTH-REG-001 — aynı telefon/e-posta ile ikinci müşteri hesabı — teslim raporu

Tarih: 2026-09-16 · Dal: `claude/auth-reg-001-customer-uniqueness-af74b3` · Taban: `main@71ec4c6d` (PR #80 merge)
· Durum: **PR açıldı, merge edilmedi.** Migration **yok** (DB 61'de kalır); `.env`/compose/container/staging dokunulmadı.

## 1. Kök neden ve by-pass eden yollar

`User.phone` ilk migration'dan beri UNIQUE, ama indeks bayt-bazlı; yazma yolları aynı numarayı üç farklı
biçimde saklıyordu:

| Yol | Eski saklama biçimi | Örnek |
|---|---|---|
| `POST /auth/register-customer` / `register-provider` (`auth.service.ts` `normalizeOptionalPhone`) | yalnız `trim()` | `0532 123 45 67`, `+90 532…`, `0532-123…` |
| Misafir talep + vitrin direct lead (`resolveCustomerForCreate`, `normalizePhone`) | rakam dışı silinir | `05321234567` / `+905321234567` |
| Admin `POST /users` (`users.service.ts`) | yalnız `trim()` | `0532 123 45 67` |
| Profil güncelleme (`account.service.ts`) | E.164 | `+905321234567` |

Sonuç: `05321234567`, `+905321234567`, `0532 123 45 67` üç ayrı `User` satırı açabiliyordu; ön sorgular da
kendi biçimini arıyordu. Ayrıca misafir yolu yarışta (`runSerializable` retry) kaybeden isteği kazananın hesabına
**sessizce bağlıyordu** — ikinci `ServiceRequest` yazılıyordu. Kanıt: yeni test paketi ilk (RED) koşuda iki eşdeğer
eşzamanlı kayıt/talep için `[201, 201]` döndü (`customer-uniqueness.spec.ts` yarış testleri).

**Aktif yerel DB'de kanıt** (salt-okunur, `docs/user-phone-canonical-preflight.sql`): 15 `User`, 12 telefonlu satır,
**0 tanesi E.164**; 11'i `0XXXXXXXXXX`, 1'i `XXXXXXXXXX`. Bir gerçek çakışma grubu: `AUTO_CREATED_REQUEST`
müşteri (2026-08-27, şifreli, 6 talep) ile `REGISTERED` müşteri (2026-09-09, 1 talep) — aynı numara, iki hesap.
E-posta: `User_email_normalized_check` mevcut; normalize edilmemiş satır **0**.

## 2. Tekillik davranışı — eski / yeni

| | Eski | Yeni |
|---|---|---|
| Şema | `User.email` UNIQUE + CHECK `lower(btrim)`; `User.phone` UNIQUE (bayt) | **aynı** — migration eklenmedi (bkz. §4) |
| `User.phone` saklama | yola göre değişir | her yolda `normalizePhoneNumber` çıktısı (E.164, `+90…`) — `apps/api/src/common/account-identity.ts` `canonicalAccountPhone` |
| Telefon ön sorgusu | kendi biçimi | `findAccountByPhone`: `equivalentPhoneSpellings` ile eski satır biçimleri (`0…`, `…`, `90…`) de bulunur |
| Yarış | pre-check geçer, P2002 → yolda farklı mesaj / misafirde retry+attach | P2002 (`uniqueViolationField`) → `CUSTOMER_IDENTITY_CONFLICT`; hiçbir yan kayıt yok |
| Misafir talebinde mevcut hesap | isteği hesaba bağlar | **409 `CUSTOMER_IDENTITY_CONFLICT`**, hiçbir kayıt yazılmaz (User/ServiceRequest/ShowcaseLead/PhoneVerification/RequestDraft/NotificationLog/aktivasyon) |
| Kayıtta çakışma mesajı | `Phone already registered` / `Email already registered` (alanı ele verir) | tek kod + tek Türkçe cümle: *"Bu telefon numarası veya e-posta adresi kayıtlı bir hesapla eşleşiyor. Giriş yapın ya da daha önce talep oluşturduysanız hesabınızı etkinleştirin."* |
| Rol | sağlayıcı/admin telefonu müşteri kaydını engellerdi (indeks) ama mesaj ayrıydı | tüm roller, aynı gövde (rol/alan sızmaz) |

Korunanlar: `EMAIL_ROLE_CONFLICT` (e-posta çapraz rol, bilinçli sözleşme), `ACTIVATION_REQUIRED` (claimable hesap),
identity-check durum tablosu (`request-identity.service.ts` — davranış aynı, yalnız yorum güncellendi),
`ServiceRequest.customerPhone` biçimi (talep satırı olduğu gibi), Turnstile/SMS bypass/RequestDraft/review/
auto-publish/ödeme kodu.

## 3. Kanonik kurallar

- **E-posta:** `trim().toLowerCase()` (`normalizeAccountEmail`), DB CHECK ile güvence — değişmedi.
- **Telefon:** `normalizePhoneNumber` E.164 (`0532…`, `532…`, `90532…`, `+90 532…`, tireli/boşluklu → `+905321234567`).
  Desteklenmeyen biçim → 400 *"Telefon numarası geçerli görünmüyor. Örnek: 0555 123 45 67"* (profil ekranıyla aynı cümle).
- **Alternatif iletişim kişisi:** oturumlu müşteride `useAlternateContact` alanları `User` yaratmaz, `customerId`
  oturumdaki müşteride kalır (başka bir hesabın telefonu/e-postası yazılsa bile) — test var.
- **Claimable hesap aktivasyonu:** kayıt formunda telefon claimable hesapla eşleşirse (`requestActivationForPhone`)
  bağlantı **DB'deki `User.email`**'e gider; formdaki e-posta alıcı olamaz — test var. Telefon A'ya, e-posta başka B'ye
  aitse aktivasyon yok, düz conflict.

## 4. Migration kararı — **durduruldu, raporlanıyor**

Şema niyeti (e-posta gibi CHECK) telefon için uygulanamadı:

- `CHECK (phone ~ '^\+[1-9]\d{7,14}$')` → yerel/staging verisinde **12/12** telefonlu satır kanonik değil; eklenemez.
- `CHECK … NOT VALID` → PostgreSQL sonraki her UPDATE'te uygular; `lastLoginAt` yazan bir giriş eski satırda patlar. **Güvensiz.**
- Kanonik ifade üzerine UNIQUE index → **1 çakışma grubu** (2 CUSTOMER satırı, ikisi de şifreli, 6+1 talep) inşayı engeller.

Veri düzeltmesi yazılmadı (yasak). Uygulama katmanı tüm yeni yazımları kanonik yaptığı için mevcut `User_phone_key`
yeni satırlar arasında yarış dâhil güvenceyi verir; eski biçimli satırlar için `equivalentPhoneSpellings` ile deterministik
ön sorgu (yarış yok: satır zaten commit'li). Sonraki adım ayrı bir iş: kanıt sorgusuyla veri kararı (hangi hesap kalır),
ardından e-posta muadili CHECK — preflight `docs/user-phone-canonical-preflight.sql`.

## 5. Yarış kanıtı

`customer-uniqueness.spec.ts`: `Promise.all` ile iki eşdeğer istek (`0532 123 45 67` / `+905321234567`,
`race@` / `RACE@`):
- kayıt: `[201, 409]`, 1 `User`, 1 `Session`;
- misafir talep: `[201, 409]`, 1 `User`, 1 `ServiceRequest`, kaybeden `CUSTOMER_IDENTITY_CONFLICT`.
RED koşuda aynı testler `[201, 201]` vermişti.

## 6. Değişen dosyalar (3 commit + rapor)

- **Yeni** `apps/api/src/common/account-identity.ts` — kod/mesaj/exception, `canonicalAccountPhone`, `findAccountByPhone`, `uniqueViolationField`.
- `auth.errors.ts` (`AccountIdentityConflictException`, alan yalnız sunucu içi), `auth.service.ts` (`assertContactFree`, P2002 haritası),
  `auth.controller.ts` (telefon eşleşmesinde de aktivasyon; nötr mesaj), `customer-activation.service.ts` (`requestActivationForPhone`),
  `service-requests.service.ts` (`resolveCustomerForCreate`: reddeder, bağlamaz; kod sabiti ortak modüle taşındı),
  `users.service.ts`, `account.service.ts` (ortak yardımcı), `request-identity.service.ts` (yorum).
- Testler: **yeni** `apps/api/test/customer-uniqueness.spec.ts` (20); uyarlanan `customer-activation`, `showcase-lead-flow`
  (ikinci lead artık oturumlu müşteri/alternatif kişi ile), `service-request-rate-limit` (6 talep oturumlu + alternatif kişi),
  `request-contact-autofill` (E.164), `request-identity` (yorum).
- Web: `lib/request-refusal-text.ts` (nötr cümle), `app/register/customer/page.tsx` (bildirim metni), `test/request-refusal-text.spec.ts`.
- E2E: `request-identity-gate.spec.ts` (`SUBMIT_CONFLICT_SENTENCE`), `showcase-placement-lead.spec.ts`.
- Docs: `docs/user-phone-canonical-preflight.sql`.
- Dokunulmadı: `apps/api/src/scripts/backfill-request-customers.ts` (tek seferlik, 2026-08'de uygulanmış tarihsel script;
  yeniden çalıştırılırsa kanonik olmayan biçimle `User` yazar — envanter notu).

## 7. Doğrulama (worktree; yerel Docker verisi dokunulmadı)

| Kontrol | Sonuç |
|---|---|
| `pnpm typecheck` | geçti |
| `pnpm lint` | geçti |
| `customer-uniqueness.spec.ts` | RED 18/20 fail → GREEN 20/20 |
| API tam paket | **116 dosya / 2413 test geçti** (ilk koşuda `provider-invite-links` 300 ms zamanlama testi yük altında düştü, izole ve ikinci tam koşuda geçti — ilgisiz) |
| Web unit / admin unit | 120/120, 49/49 |
| `pnpm build` | geçti |
| E2E Chromium | `request-identity-gate` 22/22; `showcase-placement-lead`, `marketplace-journey`, `account-email-role-conflict`, `customer-panel`, `hero-request-demo`, `request-contact-autofill`, `phone-verification-gate`, `account-recovery`, `login-screen` 35/35 |
| E2E WebKit | 84/84 (`request-identity-gate`, `showcase-*`, `login-screen` dâhil) |
| CI | PR'da üç iş bekleniyor (bkz. PR) |

## 8. Merge / deploy gerekleri

- Migration yok, env yok; API + web deploy yeterli. Admin değişmedi.
- Davranış değişikliği: misafir formundan mevcut hesabın iletişim bilgisiyle gelen POST artık 409; web'de kimlik kapısı
  zaten bu kullanıcıyı giriş/aktivasyona yönlendirdiğinden kullanıcı deneyimi değişmiyor, yalnız doğrudan API çağrıları etkilenir.
- Takip işi (ayrı): eski biçimli 12 satır + 1 çakışma grubu için veri kararı, ardından `User_phone_canonical_check` migration'ı.

## 9. Backlog satırı için kısa sonuç

`AUTH-REG-001` — **Tamamlandı (PR açık).** Tüm `User` yaratma yolları telefonu E.164'e kanonikleştirip eski biçimleri de
arıyor; çakışma her yolda ve yarışta `409 CUSTOMER_IDENTITY_CONFLICT` (alan/rol sızdırmayan tek cümle), hiçbir yan kayıt yok,
sessiz bağlama kaldırıldı. DB CHECK migration'ı staging verisindeki 12 kanonik olmayan satır + 1 gerçek çakışma nedeniyle
ertelendi (preflight SQL eklendi; veri kararı ayrı iş).
