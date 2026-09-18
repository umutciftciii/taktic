# AUTH-EMAIL-001 — Operatör aktivasyon linki e-posta kanıtı yazmasın — Teslim Raporu

Tarih: 2026-09-18 · Branch: `claude/auth-email-001-activation-proof` (taban `main` @ `558f0be7`) ·
Merge / deploy / yerel-staging DB yazımı: **yapılmadı**.

`.env`, compose/Dockerfile, lockfile, Turnstile, SMS/e-posta sağlayıcıları, ödeme, PR #88 telefon kanıtı
ve PR #89 rozet kaynakları **değişmedi**. Web/admin kodu değişmedi (rozetler hâlâ yalnız
`User.emailVerifiedAt` / `User.phoneVerifiedAt` okur). Tek migration: additive, nullable, backfill yok.

---

## 1. Kök neden (yerel kanıt: "Sude Soyan", `cmu62dd680000lp3q2sseak16`)

`customer-activation.service.ts › submit()` bir aktivasyon token'ı tüketilirken **kaynağına bakmadan**
`emailVerifiedAt: now` yazıyordu. Yerel DB'de (salt-okunur `BEGIN READ ONLY … ROLLBACK` sorgusu):

| Alan | Değer |
| --- | --- |
| Hesap oluşturma | 2026-09-17 21:51:00 (misafir talebi, `AUTO_CREATED_REQUEST`) |
| 1. token (`createdById` NULL, mail yolu) | 21:51:00 üretildi; yerelde mail çıkmaz, **hiç açılmadı**; 21:51:35'te ikinci token üretilince geçersiz kılındı |
| 2. token (`createdById` = `admin@taktic.local`) | admin ekranından "Aktivasyon linki oluştur"; `usedAt` = **21:52:10.959** |
| `User.emailVerifiedAt` | **21:52:10.959** — 2. token'ın tüketim anıyla birebir |
| `EmailVerificationToken` (tüketilmiş) | **yok** — gerçek mail doğrulaması hiç olmadı |

Yani rozet, admin ekranından kopyalanan linkin tüketilmesiyle yazılmış; posta kutusu kanıtı yok.

## 2. Token kaynak modeli

`createdById` "kim üretti"yi söyler, "nasıl ulaştı"yı değil; null-kontrolüyle türetmek istenmedi. Bu yüzden
en dar açık sözleşme eklendi:

- `enum CustomerActivationDelivery { EMAIL_DELIVERY, ADMIN_LINK }`
- `CustomerActivationToken.delivery CustomerActivationDelivery?` — **üretim anında yazılır, değişmez**.
  - `issueAndNotify` (misafir talebi, `request-identity` aktivasyonu, kayıt-claim e-posta/telefon yolları) → `EMAIL_DELIVERY`
  - `createForCustomer` (admin `POST /customers/:id/activation-link`) → `ADMIN_LINK`
  - `NULL` yalnız sütun öncesi satırlarda = **kaynağı bilinmiyor = kanıt değil** (fail-closed).
- `submit()`: şifre ve oturum her kaynakta kurulur; ardından **yalnız** `delivery === EMAIL_DELIVERY` ise
  `updateMany({ where: { id, emailVerifiedAt: null }, data: { emailVerifiedAt: now } })` — koşul SQL'de,
  mevcut kanıt asla üzerine yazılmaz. `validate` (GET), token üretimi/yenileme, başarısız tüketim
  (bilinmeyen/süresi dolmuş/tekrar) hiçbir şey yazmaz.
- Admin kullanıcı davetleri (`admin-invite.service.ts`) zaten yalnız `passwordHash` yazıyordu; değişmedi.
- E-posta değişimi: API'de `User.email`'i yazan hiçbir yol yok (`account.updateProfile` yalnız name/phone/city;
  users modülünde e-posta PATCH'i yok; grep ile doğrulandı). Mevcut `email-verification.confirm` zaten
  `emailSnapshot` + `emailVerifiedAt: null` koşuluyla yazar. Bir e-posta değiştirme yolu eklendiğinde aynı
  ifadede `emailVerifiedAt: null` yazması gerektiği şema yorumunda belirtildi; bugün test edilecek yol yok.

## 3. Migration

`prisma/migrations/20260918090000_add_customer_activation_token_delivery/migration.sql`:
```sql
CREATE TYPE "CustomerActivationDelivery" AS ENUM ('EMAIL_DELIVERY', 'ADMIN_LINK');
ALTER TABLE "CustomerActivationToken" ADD COLUMN "delivery" "CustomerActivationDelivery";
```
Additive, nullable, DML/backfill/index yok. Dry-run: API test paketinin izole `taktic_b7492a66d3_test` DB'sine
`migrate deploy` (global-setup) → 64 migration; `prisma migrate diff --from-url <test DB> --to-schema-datamodel`
→ **boş** ("This is an empty migration"); `\d "CustomerActivationToken"` sütunu gösterdi. Yerel `taktic` DB'ye
(63 migration) ve staging'e **dokunulmadı**.

Dağıtım notu: migration öncesi üretilmiş, henüz açılmamış mailli linkler (TTL 72 saat) `delivery` NULL kaldığı
için tüketildiklerinde kanıt yazmaz — bilinçli fail-closed; müşteri sonraki gerçek mail akışında kanıt kazanır.

## 4. Eski sahte marker'lar — neden otomatik temizlenmedi

Eski satırlarda kaynak bilgisi yok; "admin token'ının `usedAt`'i = `emailVerifiedAt`" eşitliği **ipucu**,
kaynak kaydı değil (aynı saniyede gerçek mail doğrulaması da olmuş olabilir; ya da timestamp eşitliği tesadüf).
Toplu UPDATE bu yüzden yapılmadı. Bunun yerine salt-okunur rapor sorgusu eklendi:
`docs/auth-email-001-suspect-email-markers.sql` (şüpheli hesapları, admin linkini üreten operatörü ve gerçek mail
doğrulaması olup olmadığını listeler; `delivery` sütunu olan DB'de çalışır).

**Onay bekleyen öneri (uygulanmadı):** yerelde tek şüpheli kayıt `cmu62dd680000lp3q2sseak16`; gerçek mail
doğrulaması yok. Onaylanırsa hedefli tek satır: `UPDATE "User" SET "emailVerifiedAt" = NULL WHERE id = 'cmu62dd680000lp3q2sseak16' AND "emailVerifiedAt" = '2026-09-17 21:52:10.959'`.
Staging/prod için önce aynı sorgu çalıştırılıp liste insan tarafından değerlendirilmeli.

## 5. Testler

- **API** `customer-activation-email-proof.spec.ts` (9, RED→GREEN: 7 düştü → geçti): admin linki `ADMIN_LINK`,
  üretim/validate yazmaz, tüketim şifre+oturum kurar ve `emailVerifiedAt` NULL kalır (`/auth/me`,
  `/account/profile`, `/customers`, `/customers/:id`); mailli link üstüne admin yeniden üretimi (mailli 400, admin
  token kanıt yazmaz); misafir talebi ve kayıt-claim yolu `EMAIL_DELIVERY` + yalnız tüketimde kanıt
  (`usedAt === emailVerifiedAt`); bilinmeyen/süresi dolmuş/tekrar token yazmaz; mevcut kanıt üzerine
  yazılmaz; `delivery` NULL token aktive eder, kanıt yazmaz; telefon kanıtı iki yolda da NULL.
- Mevcut `customer-activation` (9), `email-verification` (≈17, "consumed activation link counts as proof" mailli yol
  için aynen geçer), `account-verification-badges` (6), `account-phone-proof` (13) yeşil.
- **E2E** `customer-activation-proof.spec.ts` (2): admin UI'dan link → müşteri açar, şifre kurar → profil ve admin
  detay "Doğrulanmadı", liste `data-verified=""`, token `ADMIN_LINK`; kayıt-claim ile mail → outbox'tan link → şifre
  → profil/admin "Doğrulandı", token `EMAIL_DELIVERY`. WebKit projesine eklendi.
- Kapılar: `pnpm typecheck` 5/5 · `pnpm lint` 4/4 · `pnpm build` 3/3 (E2E koşuları içinde) · API **130 dosya / 2981 test** · web 249 · admin 55 · shared 168 · E2E Chromium `customer-activation-proof account-recovery request-identity-gate` **27/27** · WebKit `customer-activation-proof` **2/2**.

## 6. CI

PR #90, run 35337022326 @ `1a3c1aac` **3/3 geçti**: `typecheck · lint · test · build` 8m38s, `e2e (chromium)` 15m47s, `e2e (webkit · sign-in and mobile shells)` 12m16s. Bu satırı ekleyen commit docs-only; kod ağacı `1a3c1aac` ile aynıdır.
