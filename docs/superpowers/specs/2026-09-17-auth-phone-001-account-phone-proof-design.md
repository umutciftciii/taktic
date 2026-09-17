# AUTH-PHONE-001 — Hesap düzeyinde telefon kanıtı (REQ-UX-010 revizyonu)

Tarih: 2026-09-17 · PR #88 üzerinde · Öncülü: REQ-UX-010 (talep-bazlı doğrulama-bekliyor UX'i, korunur).

## Sorun

Kanıt yalnız talebin üzerinde (`ServiceRequest.phoneVerifiedAt`): kapı açıkken aynı hesap
numarasıyla açılan her yeni talep yeniden OTP ister. Hesabın numarayı bir kez ispatladığı
bilgisi hiçbir yerde tutulmuyor.

## Veri modeli

Tek additive migration: `User.phoneVerifiedAt DateTime?` (nullable, backfill yok, index yok).
Kanıt hangi numaraya aitse o `User.phone`'dur (her yazma yolunda E.164 — AUTH-REG-001); ayrı bir
"doğrulanan numara" sütunu tutulmaz, çünkü numara değişince kanıt aynı ifadede sıfırlanır.

`ServiceRequest.phoneVerifiedAt` anlamı genişler: "bu talebin numarası şu anda ispatlıydı".
Doğrudan OTP'de damga = doğrulama anı ve talebe bağlı tüketilmiş `PhoneVerification` satırı
vardır; **hesaptan devralınan** kanıtta damga = talebin oluşturulma anı (`submittedAt`) ve talebe
bağlı `PhoneVerification` satırı **yoktur** — denetim izinde ikisi böyle ayrılır.

## Kurallar ve yazma yolları

| Yol | Kural |
| --- | --- |
| Normal talep (`createServiceRequest`) | Oturumlu CUSTOMER, `useAlternateContact !== true`, ve **işlem içinde** okunan `User.phone` (E.164) == talebin `customerPhone` (E.164) ve `User.phoneVerifiedAt != null` ⇒ talep `phoneVerifiedAt = now` ile doğar; auto AÇIK + kapı açık ⇒ mevcut `publishAtCreate` yoluyla `APPROVED`. Yayın kararı artık işlemin içinde (kullanıcı satırı aynı serializable işlemde okunur). Alternatif kişi / misafir / eşleşmeyen numara ⇒ devir yok, mevcut davranış. |
| Vitrin lead (`createShowcaseLead`) | Aynı devir `createServiceRequest` içinde gerçekleşir; `onCreated` devralınmış kanıt görürse standalone satır aramaz. Kanıt yoksa mevcut tek-kullanımlık 30 dk kanıtı aynen. |
| OTP doğrulama (`verifyCode`) | Talep damgalandıktan sonra aynı işlemde `user.updateMany({ where: { id: request.customerId, phone: <talebin E.164 numarası>, phoneVerifiedAt: null }, data: { phoneVerifiedAt: now } })` — yalnız çağıran sahibin kendisiyse (`user.id === customerId`). WHERE'deki `phone` eşitliği: alternatif kişi numarası ve yarışta değişmiş numara terfi ettiremez; ikinci verify zaten 409. |
| Profil telefon değişikliği (`updateProfile`) | Tek ifade: `updateMany({ where: { id, NOT: { phone: yeni } }, data: { …, phoneVerifiedAt: null } })`; 0 satır ⇒ numara aynı (E.164 eşit, biçim farkı değişiklik değil) ⇒ kanıt korunarak güncelle. |
| Kayıt / admin kullanıcı oluşturma / auto-created müşteri | Yeni satır, kanıt yok. Kayıtta gerçek OTP adımı yok; eklenmedi. |
| `/auth/me` | Oturumun kendi kullanıcısına `phoneVerifiedAt` eklenir (yalnız kendi hesabı). Web formları bunu yalnız görünüm için kullanır; karar API'de. |

Değişmeyen: OTP rate limit, Turnstile, identity gate, outbox/dedupe, kredi kuralları, provider
görünürlüğü (`phoneVerifiedAt` talepte olduğu için `isRequestVisibleToProviders` aynen çalışır),
`awaitingPhoneVerification` projeksiyonu (talep damgası dolu doğduğu için doğal olarak `false`).

## Yarışlar

- Telefon değişimi ↔ talep: devir işlem içinde güncel satırdan okunur; değişiklik önce commit olduysa
  `phoneVerifiedAt` NULL ⇒ devir yok; sonra commit olduysa talep eski numarayı ispatlı taşır (o anın
  tutarlı görüntüsü) ve kullanıcı kanıtı değişiklikle sıfırlanır.
- Telefon değişimi ↔ verify: terfi `WHERE phone = <talep numarası>` ile koşullu; yeni numaraya sızmaz.
- Çift verify: ikincisi 409 (talep zaten damgalı); tek publish (`publishRequestInTransaction`
  `SUBMITTED` koşullu) ve tek enqueue (unique dedupe) aynen.

## Web

- Kanıt geçerli ⇒ talep `phoneVerifiedAt` dolu doğar ⇒ PR #88 makbuzu `published`/`review`, kart yok.
- Zaman çizelgesi: `approvedAt != null && moderatedAt == null` ⇒ adım 2 **"Yayına alındı"** (tamam);
  moderasyon görmüş ⇒ "Ön inceleme" (tamam); `SUBMITTED` ⇒ "Ön inceleme" (bekliyor); doğrulama
  bekleyen ⇒ REQ-UX-010'daki gibi.
- `/requests/my` kartı: `awaitingPhoneVerification` ⇒ "Telefon doğrulaması bekliyor" rozeti +
  "Telefonu doğrula" bağlantısı (`/requests/:id/offers#telefon-dogrulama`), sarmalanabilir.
- Vitrin formu: hesap yolu + `phoneVerifiedAt` ⇒ kod adımı gizli, gönder açık; API
  `SHOWCASE_LEAD_PHONE_VERIFICATION_REQUIRED` derse kod adımı geri gelir.

## Test matrisi

API `account-phone-proof.spec.ts`: (1) ispatlı hesap + auto AÇIK + kapı ⇒ 1. ve 2. talep OTP'siz
`APPROVED`, tek fanout; (2) ispatsız ⇒ `SUBMITTED` + `awaiting`, verify ⇒ talep + kullanıcı damgası;
(3) aynı kullanıcı 2. talep OTP'siz; (4) telefon değişimi ⇒ kullanıcı kanıtı NULL, yeni talep
`awaiting`; (5) aynı numaranın farklı biçimi ⇒ kanıt korunur; (6) alternatif kişi ⇒ devir yok,
verify hesabı terfi ettirmez; (7) misafir/yabancı/provider/admin sızıntı yok; (8) eşzamanlı telefon
güncelleme + verify ⇒ yeni numara ispatsız; çift verify ⇒ tek publish. Vitrin: ispatlı hesap
standalone kod olmadan lead açar; alternatif kişi ⇒ kod ister. Profil: değişiklik sıfırlar.

Web: zaman çizelgesi etiketi; pano rozeti; E2E: ispatlı kullanıcı 2. talep kartsız `published`,
telefon değişimi sonrası kart geri gelir, pano rozeti, 320/768/1440 taşma yok.
