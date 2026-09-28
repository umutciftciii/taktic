# ADMIN-ACTIONS-005 — Eşleşmiş talepte CANCELLED: risk ve ürün kararı raporu

**Tarih:** 2026-09-28 · **Durum:** karar bekliyor · **Kapsam:** yalnız analiz — bu rapor davranış değiştirmez.

> **Karar ve uygulama (2026-09-28, PR #118):** K1–K5 kararlandı ve uygulandı; ayrıntılar `2026-09-28-request-cancellation-contract.md` belgesinde.
> - **K1:** Müşteri kabul edilene kadar iptal edebilir. Operasyonda iptal `REQUESTS_CANCEL` izniyle yapılır, eşleşmiş talep dahil.
> - **K2:** Kabul edilmiş teklif CANCELLED olur; `acceptedAt` ve `matchedOfferId` iz olarak kalır.
> - **K3:** Kazananın kredisi varsayılan olarak iade edilir. İadesiz iptal ayrı izin ve gerekçe ister.
> - **K4:** Kazanamayan tekliflerden açık olanlar kapanır; reddedilmiş olanlar (elle ret dahil) REJECTED kalır. Hepsinin harcanmış ve henüz iade edilmemiş kredisi iade edilir. Kural kabul öncesi ve eşleşmiş talepte aynıdır, kazanan kararından bağımsızdır. WITHDRAWN ve EXPIRED değişmez.
> - **K5:** Müşteriye, kazanana ve etkilenen diğer teklif sahiplerine bildirim gider.
>
> Bu raporun §1–§3 tabloları **tarihsel kanıttır** (PR #118 öncesi davranış).

> **Güncelleme (2026-09-28, main@4e1d1c98):** §1'deki moderasyon kapısı (`PATCH …/status {CANCELLED}`) ve §5'teki DRAFT/SUBMITTED açığı PR #120 (API-GUARD-REQUEST-002) ile kapandı; bu satırlar **tarihsel kanıttır**. K1 ve K6 böylece "tek kapı: `POST /:id/cancel`" yönünde çözüldü. `/cancel` kapısının davranışı (§1 ikinci satır, §2, §3) değişmedi; **K2–K5 açık**. Admin "İptal et" diyaloğu bugünkü davranışı anlatır ve bu kararlar verilmeden farklı bir sonuç vaat etmez (PR #118).
**İlgili PR:** API-GUARD-OFFER-001 / API-GUARD-REQUEST-001 (bu raporla aynı dal). O PR CANCELLED hedefine **dokunmaz**.

## 1. Bugün CANCELLED'a giden üç kapı

| Kapı | Kim | Kaynak durum koşulu | Teklifler | Krediler | Vitrin lead'i | Bildirim |
|---|---|---|---|---|---|---|
| `PATCH /service-requests/:id/status` `{status: CANCELLED}` (moderasyon) | `REQUESTS_STATUS` izni olan admin | **Yok** — DRAFT, MATCHED, COMPLETED, REJECTED, EXPIRED dahil her durumdan yazar | Dokunmaz | Dokunmaz | **Kapatmaz** | Yok |
| `POST /service-requests/:id/cancel` (yaşam döngüsü) | Talep sahibi müşteri veya SUPER_ADMIN | COMPLETED/CANCELLED/EXPIRED/REJECTED dışı (MATCHED **dahil**) — koşullu UPDATE, Serializable | Dokunmaz | Dokunmaz | Kapatır (`CUSTOMER_CANCELLED`) | Yok |
| Vitrin lead'i SLA/ret akışları (`showcase-lead*.service.ts`) | Sistem | Kendi koşulları | — | — | Kendisi | Kendi |

Kaynak: `service-requests.service.ts` → `updateServiceRequestStatus` (CANCELLED dalı koşulsuz `update`), `cancelServiceRequest` (`terminalStatuses` dışı koşullu `updateMany`).

## 2. MATCHED bir talep CANCELLED olduğunda ne kalıyor (kanıtlanmış davranış)

1. **Kabul edilmiş teklif ACCEPTED kalır**, `ServiceRequest.matchedOfferId` ve `matchedAt` yerinde durur. `Offer_one_accepted_per_request` indeksi ve raporlar bu teklifi "kazanan" saymaya devam eder.
2. **Kazanan sağlayıcının kredisi geri gelmez.** Müşteri kabulü `viewedAt` damgalar, admin kabulü `refundBlockedAt` yazar; görülmemiş-teklif iade kuralı ikisinde de iadeyi kapatır. Manuel iade (`OFFER_REFUND_MANUAL`) tek yol.
3. **İletişim bilgileri ve mesajlaşma kapanır** — bu kısım tutarlı: `contact-sharing.service.ts:158` ve `messaging.service.ts:455` durumun MATCHED olmasını şart koşuyor. `ContactRevealEvent` satırı ise denetim kaydı olarak kalır (doğru).
4. **Hiç kimseye haber verilmez.** Sağlayıcı, kabul edilen işinin iptal edildiğini ne e-postayla ne panel bildirimiyle öğrenir; panelinde teklif hâlâ "kabul edildi" görünür, talep "iptal".
5. **Değerlendirme daveti yolu kapanır**: `completeServiceRequest` yalnız MATCHED'dan çalışır; iptal edilen işe yorum istenmez (muhtemelen doğru).
6. **Moderasyon kapısında ek risk:** COMPLETED → CANCELLED da yazılabiliyor; `completedAt` kalır, gönderilmiş değerlendirme daveti ve yorum iptal edilmiş bir işe bağlı kalır. REJECTED/EXPIRED → CANCELLED da serbest (zararı düşük ama anlamsız bir kayıt üretir).

## 3. MATCHED olmayan açık talepte (APPROVED) CANCELLED

Canlı teklifler (SUBMITTED/VIEWED/SHORTLISTED) **canlı kalır**. REJECTED kaskadı (`rejectRequestInTransaction`) bunları CANCELLED yapıp tek-seferlik kredilerini tam iade ederken, iki iptal kapısı da hiçbirini yapmaz:
- Görülmemiş teklif 48 saat penceresi dolunca işçi tarafından iade edilir (kural teklif durumuna bakmıyor).
- **Görülmüş teklif hiç iade edilmez** — müşteri talebi iptal etti diye sağlayıcı krediyi kaybeder; aynı talep "Reddet" ile kaldırılsaydı tam iade alacaktı. Bu, aynı sonucun iki kapıda farklı para etkisi demek.
- Müşteri iptal edilmiş talebin tekliflerini hâlâ ret/kısa liste yapabilir (kabul, talep APPROVED olmadığı için 409).

## 4. Karar gerektiren sorular

| # | Soru | Seçenekler | Öneri |
|---|---|---|---|
| K1 | Eşleşmiş talebi kim iptal edebilir? | (a) müşteri + admin (bugün) (b) yalnız admin (c) kimse; önce "eşleşmeyi çöz" | (a) kalsın ama **tek kapıdan**: moderasyon PATCH'inden CANCELLED hedefi kaldırılsın, iptal yalnız `/cancel` olsun |
| K2 | Kabul edilmiş teklif ne olur? | (a) ACCEPTED kalır (bugün) (b) CANCELLED'a çekilir | (b) — ACCEPTED + CANCELLED talep, "kazanan" sayan her raporu yanıltır; iz `acceptedAt` ile korunur |
| K3 | Kazanan sağlayıcının kredisi? | (a) iade yok (bugün) (b) her zaman tam iade (c) kim iptal etti/ne zaman'a göre (müşteri X saat içinde iptal ederse iade) | Ürün kararı; (c) en adil ama politika metni ister. Karar verilene kadar (a) + manuel iade |
| K4 | Açık talep iptalinde canlı teklifler? | (a) canlı kalır (bugün) (b) REJECTED kaskadıyla aynı: CANCELLED + tam iade | (b) — aynı "pazardan çekme" sonucuna aynı para etkisi |
| K5 | Bildirim | Sağlayıcıya "talep iptal edildi" e-postası, müşteriye makbuz | Kazanan sağlayıcıya zorunlu; kaybedenlere gerek yok (zaten "seçilmedi" aldılar) |
| K6 | Moderasyon PATCH'in CANCELLED/DRAFT/SUBMITTED hedefleri | (a) serbest (bugün) (b) kaldır/kısıtla | (b) — bkz. §5 |

## 5. Bu PR'ın bıraktığı, CANCELLED dışındaki komşu açık (API-GUARD-REQUEST-002 adayı)

Moderasyon PATCH'i **DRAFT** ve **SUBMITTED** hedeflerini de her durumdan koşulsuz yazıyor. Bu PR, IN_REVIEW/APPROVED yazımına `matchedOfferId IS NULL` koşulunu eklediği için "MATCHED → SUBMITTED → APPROVED" zinciri artık APPROVED adımında 409 alıyor; ancak:
- MATCHED/COMPLETED bir talep DRAFT veya SUBMITTED'a çekilebiliyor (eşleşme bağlıyken; iletişim/mesajlaşma kapanır, yan etki sessiz).
- REJECTED veya EXPIRED bir talep SUBMITTED üzerinden tekrar APPROVED yapılabiliyor (REJECTED için `reopenAfterRemoval`'ın rapor koşulunu atlar; EXPIRED için yeni yayın penceresi açar).

Admin arayüzü bu hedefleri göndermiyor (yalnız IN_REVIEW, APPROVED, REJECTED); risk doğrudan API çağrısıyla sınırlı. Öneri: moderasyon PATCH'inin kabul ettiği hedefleri `IN_REVIEW | APPROVED | REJECTED` ile sınırlamak — ayrı PR, çünkü DTO sözleşmesini değiştirir.

## 6. Uygulama notları (karar verildiğinde)

- K2/K4 için migration gerekmez: `Offer.cancelledAt`, `OfferStatus.CANCELLED` ve `refundOfferCreditInTransaction` zaten var; `rejectRequestInTransaction`'ın canlı-teklif kapatma bloğu yeniden kullanılabilir.
- K3 (c) seçilirse iade nedeni için yeni bir `REFUND_REASON` sabiti yeterli; ledger şeması değişmez.
- K5 yeni bir e-posta şablonu + `NotificationLog` dedupe anahtarı (`request-cancelled:<requestId>:<providerId>`) ister.
- Her durumda iptal, bu PR'daki kalıbı izlemeli: kaynak durum koşulu yazımın kendi `where`'inde, teklif/kredi/lead değişiklikleri aynı Serializable işlemde, bildirimler commit sonrası.
