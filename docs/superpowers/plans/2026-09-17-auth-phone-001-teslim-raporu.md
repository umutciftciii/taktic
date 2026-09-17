# AUTH-PHONE-001 + REQ-UX-010 revizyonu — Hesap düzeyinde telefon kanıtı — Teslim Raporu

Tarih: 2026-09-17 · PR #88 üzerinde (branch `claude/phone-verification-pending-request-df3d9c`, taban `main` @ `efda3e09`, main ilerlemedi — rebase gerekmedi) · Merge: **yapılmadı**

REQ-UX-010'un doğrulama-bekliyor yüzeyleri (makbuz `verify`, zorunlu kart, çizelge adımı, boş kutu,
istemci adresi iletimi) **aynen korundu**; bu revizyon onların üstüne hesap kuralını ekler.
`.env`, compose/Dockerfile, Turnstile, SMS/e-posta sağlayıcısı, ödeme, outbox/dedupe, OTP rate limit,
identity gate, kredi kuralları ve admin/provider ekranları değişmedi. Staging, yerel container/DB,
Cloudflare ve dış servislere dokunulmadı. Tasarım: `docs/superpowers/specs/2026-09-17-auth-phone-001-account-phone-proof-design.md`.

---

## 1. Migration ve dry-run

`prisma/migrations/20260917120000_add_user_phone_verified_at/migration.sql` — tek additive ifade:

```sql
ALTER TABLE "User" ADD COLUMN "phoneVerifiedAt" TIMESTAMP(3);
```

DML/backfill/seed/drop/truncate yok, index yok. Dry-run: geçici `taktic_auth_phone_dryrun_test`
veritabanında `prisma migrate deploy` → tüm migration'lar uygulandı; `prisma migrate diff
--from-url <geçici DB> --to-schema-datamodel` → **boş** ("This is an empty migration": şema ve
migration'lar eşzamanlı); `\d "User"` sütunu gösterdi; geçici DB silindi. Gerçek `taktic`/staging
DB'ye migration komutu çalıştırılmadı. API test paketi de kendi izole `taktic_<slug>_test` DB'sine
`migrate deploy` uygular (global-setup) — ikinci dry-run.

## 2. Kanonik telefon değişim kuralı

- `PATCH /account/profile` (`AccountService.updateProfile`): serializable işlemde mevcut `User.phone`
  okunur, yeni numarayla **E.164 karşılaştırılır** (`canonicalAccountPhone`); farklıysa aynı `update`
  ifadesinde `phoneVerifiedAt: null` yazılır. Aynı numaranın biçimsel farklı yazımı (`0555 111 22 33`
  vs `+905551112233`) değişiklik sayılmaz, kanıt korunur. Eski satırlarda kanonik olmayan yazım varsa
  (AUTH-REG-002) karşılaştırma yine canonical yapılır.
- Başka `User.phone` yazan yol yok: kayıt, admin kullanıcı oluşturma, auto-created müşteri yeni satır
  açar (kanıt NULL); aktivasyon/şifre yolları telefona dokunmaz.

## 3. Hesap terfisi koşulları (`PhoneVerificationService.verifyCode`)

Talep damgalandıktan sonra aynı serializable işlemde, **yalnız** şu koşullarda:
çağıran `CUSTOMER` ve `serviceRequest.customerId === user.id` (sahibin kendisi), hesabın mevcut
`User.phone`'u talebin doğrulanan numarasıyla E.164 eşit, hesapta kanıt yok. Yazma
`updateMany({ where: { id, phone: <okunan saklı değer>, phoneVerifiedAt: null } })` — saklı dizeye
koşullu olduğundan okuma ile yazma arasında değişen numaraya kanıt sızmaz. Operatörün müşteri adına
girdiği kod, alternatif kişi numarası, başarısız/ikinci verify (409) terfi ettirmez.

## 4. Devir (inheritance) koşulları (`createServiceRequest`, işlem içinde)

`accountProofCoversRequest(tx, user, dto, customerPhone)`: oturumlu `CUSTOMER` ∧ `useAlternateContact !== true`
∧ `User.phoneVerifiedAt != null` ∧ `normalize(User.phone) == normalize(customerPhone)`. Sağlanırsa talep
`phoneVerifiedAt = now` (= `submittedAt`) ile doğar, talebe bağlı `PhoneVerification` satırı **olmaz**
(denetim izinde doğrudan OTP'den ayrım budur). Yayın kararı (`publishAtCreate`) artık işlemin içinde:
auto AÇIK ∧ (kapı kapalı ∨ `phoneVerifiedAt`) — mevcut `publishOutbox.enqueue` yolu, ek yol yok.
Vitrin lead: aynı devir; `onCreated` `inheritedPhoneProof` görürse standalone kanıt aramaz, görmezse
mevcut 30 dk tek-kullanımlık kanıt aynen zorunlu.

## 5. Alternatif kişi ve misafir sınırları

- Alternatif kişi: devir yok (talep kendi numarası için kart ister, `awaitingPhoneVerification: true`);
  doğrulanınca talep damgalanır, hesap terfi **etmez**; sonra hesap numarasıyla açılan talep yine ister.
- Misafir: oturum yok ⇒ devir yok; verify uçları zaten auth ister; misafir makbuzu API çağrısı yapmaz.
  Aynı numarayla misafir POST'u identity gate tarafından 409 ile reddedilir (mevcut).
- `/auth/me` yalnız oturumun kendi `phoneVerifiedAt`'ini döner; admin `GET /service-requests/:id`
  `customer` nesnesinde alan yok; provider/anon mevcut 403/401.

## 6. Yarış ve fanout kanıtı (`apps/api/test/account-phone-proof.spec.ts`)

- Eşzamanlı `verify` + `PATCH /account/profile` (yeni numara): talep `APPROVED`, yeni numara
  `phoneVerifiedAt` **NULL**, bir sonraki talep yeniden ister.
- Çift verify aynı kod: bir 201, diğeri 400/409; `request-available` 1 + `request-published` 1 SENT,
  toplam 2 intent satırı; hesap kanıtı talep damgasına eşit (tek terfi).
- İspatlı hesap + auto AÇIK: iki ardışık talep `APPROVED` doğar, her biri tam bir fanout, `request-received`
  yok, kod istenemez (409).

## 7. PR #88'den korunan UX ve yeni yüzeyler

| Yüzey | Durum |
| --- | --- |
| Başarı `verify` varyantı, zorunlu kart, `#telefon-dogrulama`, boş kutu, özet cümlesi | aynen; kanıt varsa hiç görünmez (talep damgalı doğar) |
| İstemci adresi iletimi (OTP action'ları) | aynen |
| Zaman çizelgesi | **yeni**: `approvedAt != null ∧ moderatedAt == null` ⇒ adım "Yayına alındı" (tamam) — hesap kanıtıyla doğan, verify ile yayınlanan ve auto AÇIK'ta doğan talepler; operatör moderasyonu ⇒ "Ön inceleme"; eski yanıt (alan yok) ⇒ eski davranış |
| `/requests/my` | **yeni**: `awaitingPhoneVerification` ⇒ `tag tag-accent` "Telefon doğrulaması bekliyor" + "Telefonu doğrula" bağlantısı (`#telefon-dogrulama`); yalnız sahibin listesinde (uç zaten sahibe özel) |
| Vitrin formu | **yeni**: hesap yolu + `phoneVerifiedAt` ⇒ kod adımı yerine "daha önce doğrulandı" notu, gönder açık; API `SHOWCASE_LEAD_PHONE_VERIFICATION_REQUIRED` derse kod adımı geri gelir |
| `/auth/me` | `phoneVerifiedAt` (yalnız kendi hesabı) |

## 8. Test / CI

- API RED→GREEN: `account-phone-proof.spec.ts` 13 test (matris 1–8 + vitrin ×2 + operatör verify);
  tam API paketi **128 dosya / 2964 test** yeşil (REQ-UX-010'un 6 testi dahil).
- Web RED→GREEN: `request-lifecycle.spec.ts` +2 (çizelge etiketi), `requests-board.spec.tsx` 2 (rozet/CTA,
  diğer durumlarda yok); web toplam 211 yeşil; admin 49, shared 165.
- E2E `phone-verification-gate.spec.ts › account proof…` (`phoneGateRuntime` + auto AÇIK, kendi istemci
  adresi): 1. talep `verify` → pano rozeti + CTA 320/768/1440'ta taşmasız → kart → kod → `APPROVED`,
  `User.phoneVerifiedAt` dolu → 2. talep `published`, kart yok, çizelge "Yayına alındı" (ön inceleme /
  telefon adımı yok), `phoneVerifiedAt == submittedAt`, talebe bağlı OTP satırı yok, panoda rozet yok →
  vitrin formu kod istemez, lead açılır → profil telefon değişimi → kanıt NULL → 3. talep `verify`, kart
  geri. REQ-UX-010'un 3 senaryosu aynen yeşil.
- `pnpm typecheck`, `pnpm lint`, `pnpm build` yeşil; CI üçlüsü PR üzerinde (son head SHA raporun
  altında).

## 9. Açık riskler

- Eski kayıtlar: migration öncesi kendi talebinde numarasını doğrulamış hesaplar backfill'siz kaldı;
  bir sonraki meşru doğrulamada kanıt kazanırlar (kural 7).
- Kanıt hesap numarasına bağlı; numara başka bir yoldan (ör. ileride admin düzenlemesi) değiştirilirse
  aynı sıfırlama kuralı o yola da eklenmeli — bugün böyle bir yol yok.
- Zaman çizelgesi "Yayına alındı" etiketi `moderatedAt`'e dayanır; operatör auto-yayınlanan talebi
  sonradan yeniden kaydederse "Ön inceleme ✓" görünür (gerçek moderasyon olduğu için doğru).
- Landing pazarlama kopyası (REQ-UX-009'dan beri) açık.
