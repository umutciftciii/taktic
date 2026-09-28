# Talep iptali sözleşmesi (PR #118)

**Tarih:** 2026-09-28 · **Durum:** uygulandı (PR #118, merge bekliyor) · **Önceki analiz:** `2026-09-28-admin-actions-005-cancelled-risk-report.md` (K1–K6)

Bu belge `POST /service-requests/:id/cancel` ve `POST /service-requests/:id/cancel/withhold-winner-refund` uçlarının davranışını sabitler. Kod: `ServiceRequestsService.cancelServiceRequest` ve `cancelLoserOfferRule`. Test: `apps/api/test/request-cancellation.spec.ts`.

## 1. Kim iptal edebilir

| Aktör | Eşleşmemiş talep (SUBMITTED, IN_REVIEW, APPROVED, DRAFT) | Eşleşmiş talep (MATCHED ya da `matchedOfferId` dolu) | Kapanmış talep |
| --- | --- | --- | --- |
| Talebin sahibi müşteri | ✅ | ❌ 409 `REQUEST_MATCHED_NOT_CANCELLABLE_BY_CUSTOMER`; ekranda iptal sunulmaz | ❌ 409 `REQUEST_NOT_CANCELLABLE` |
| `REQUESTS_CANCEL` izinli personel | ✅ | ✅ kazanan kredisi iade edilir | ❌ 409 |
| + `REQUESTS_CANCEL_WITHOUT_REFUND` | ✅ | ✅ ayrı uçtan, gerekçeyle iadesiz | ❌ 409 |
| SUPER_ADMIN | ✅ | ✅ (her iki uç) | ❌ 409 |
| Diğer müşteri, hizmet veren, izinsiz personel | ❌ 403 | ❌ 403 | ❌ 403 |

- İzin, rota koruyucusunda (`@RequiresPermissionFromStaff`) ve serviste ayrıca denetlenir.
- İki izin de yönetilebilir rollere atanabilir. Migration hiçbir role izin vermez.

## 2. Atomiklik ve yarış

- Tek bir Serializable işlem. Talep yazımı, işlemin okuduğu durum ve `matchedOfferId` koşuluyla yapılır. Müşteri için ayrıca `matchedOfferId IS NULL` koşulu var.
- Kabul ile müşteri iptali yarışırsa yalnız biri başarılı olur, kaybeden 409 alır. Kabul tarafında kaybeden, kapanmış teklif için `OFFER_CLOSED` ya da talep durum çakışması alır. Kısmi yan etki kalmaz; bu, 12 denemelik yarış testiyle doğrulandı.
- Personel formu gördüğü eşleşmeyi `expectedMatchedOfferId` ile gönderir. Durum değişmişse 409 `REQUEST_CANCEL_STATE_CHANGED` döner.

## 3. Kredi

**Kazanan (kabul edilmiş) teklif:**
- Varsayılan olarak tam iade edilir: `REQUEST_CANCELLED`, görülmüş olsa da.
- İadesiz iptal yalnız `/cancel/withhold-winner-refund` ucundan yapılır. Bu uç `REQUESTS_CANCEL_WITHOUT_REFUND` + `REQUESTS_CANCEL` izinlerini ve en az 10 karakter gerekçe ister.
- `/cancel` gövdesinde iade anahtarı yoktur. `forbidNonWhitelisted` nedeniyle `refundWinner` gibi bir alan 400 alır. Eksik alan hiçbir zaman "iadesiz" sayılmaz.

**Kazanamayan teklifler (K4)** — `cancelLoserOfferRule`. Kural kabul öncesi ve eşleşmiş talepte aynıdır; kazanan için verilen karardan (iade ya da iadesiz) bağımsızdır.

| Teklif durumu | Kapatılır (CANCELLED) | Kredi iade edilir |
| --- | --- | --- |
| SUBMITTED, VIEWED, SHORTLISTED | ✅ | ✅ |
| REJECTED, ret gerekçesi fark etmez: `COMPETITOR_ACCEPTED`, müşterinin elle reddi ya da personelin müşteri adına reddi (otomatik iadesi engellenmiş olsa da) | ❌ (REJECTED kalır, ret kaydı korunur) | ✅ |
| WITHDRAWN, EXPIRED | ❌ | ❌ (kendi politikaları; bu karar değiştirmez) |
| CANCELLED (önceki bir kaskadla kapanmış) | ❌ | ❌ |

- "İade edilir", tek seferlik kredi harcanmış ve henüz iade edilmemiş demektir. Dönemsel paket ya da vitrin teklifi kapanır, ledger satırı yazılmaz.
- Çift ödeme engellenir. Bunu sağlayan üç katman: aday filtresi, `refundOfferCreditInTransaction`'ın koşullu güncellemesi ve ledger'daki teklif başına tek iade indeksi. Testlerde kapsanan durumlar: tekrar iptal, sonradan koşan otomatik iade ve otomatik iadeyle eşzamanlı yarış.

## 4. Kayıtlar (K2)

- Kabul edilmiş teklif CANCELLED olur (`cancelledAt`). `acceptedAt` kabulün izi olarak kalır, `ServiceRequest.matchedOfferId` ve `matchedAt` eşleşmenin izi olarak kalır.
- **Ürün sonucu:** Kazanan hizmet veren teklifini "Kapatıldı" olarak görür, kazanılanlar sekmesinden çıkar ve iş kapsamı gizlenir. Müşteri eşleşme kartını ve iletişim bilgisini görmez. Admin "Eşleşme" kartı "Sona erdi · talep iptal edildi" rozetini gösterir. Kabul edilmiş teklif sayımlarına artık girmez; müşteri listesindeki "kabul edilen teklif" sayısı ve hizmet veren kazanma oranı buna dahildir.
- **Tarihsel `matchedOfferId` aktif eşleşme sayılmaz:**
  - API: iletişim paylaşımı, mesajlaşma, eşleşme bildirimi ve değerlendirme daveti durumun MATCHED ya da COMPLETED olmasını şart koşar.
  - Müşteri web: süreç adımı ve eşleşme kartı durumdan hesaplanır.
  - Hizmet veren: teklif durumundan hesaplanır.
  - Admin: eşleşme kartı durumdan hesaplanır.
- `Offer_one_accepted_per_request` yuvası boşalır. Talep terminal olduğu için yeniden eşleşme mümkün değildir.
- İletişim paylaşımı ve mesajlaşma, talep MATCHED olmadığı için kapanır. `ContactRevealEvent` denetim kaydı olarak kalır.
- `ServiceRequestCancellation` satırında şunlar tutulur:
  - aktör türü ve kullanıcı;
  - önceki durum;
  - kabul edilmiş teklif;
  - kazanan kararı: `NOT_MATCHED`, `REFUNDED`, `WITHHELD` ya da `NOTHING_TO_REFUND`;
  - gerekçe (yalnız WITHHELD'de, CHECK kısıtıyla);
  - kapatılan ve iade edilen teklif listeleri.

  `requestId` UNIQUE'tir.

## 5. Bildirimler (K5)

Bildirimler iptal işleminin içinde niyet (`NotificationLog` PENDING) olarak yazılır ve commit'ten sonra gönderilir. Teslim edilemeyenleri lifecycle tick'i süpürür. Tekilleştirme `(template, dedupeKey)` ile yapılır.

| Şablon | Alıcı | Anahtar |
| --- | --- | --- |
| `request-cancelled-customer` | müşteri (`customerEmail`) | `request-cancelled-customer:<requestId>` |
| `request-cancelled-winner` | kazanan hizmet veren | `request-cancelled-winner:<offerId>` |
| `request-cancelled-offer` | iptalin kapattığı ya da kredisini iade ettiği her diğer teklifin sahibi (elle reddedilmiş, yeni iade edilen teklif dahil) | `request-cancelled-offer:<offerId>` |

**Kime gitmez:**
- WITHDRAWN ve EXPIRED teklif sahipleri.
- Önceden kapanmış teklif sahipleri.
- Kredisi daha önce iade edilmiş ve iptalin hiçbir şey değiştirmediği reddedilmiş teklif sahipleri.
- E-posta adresi olmayan müşteri.

- Hizmet veren bildirimlerinde müşteri adı, e-postası ya da telefonu yer almaz.
- Diğer hizmet verenlerden, kazanan olup olmadığından söz edilmez.
- Operatör gerekçesi hiçbir bildirime girmez.

## 6. Veri etkisi ve bilinen sınırlar

- Migration `20260928160000_add_request_cancellation_contract` yalnız ekleme yapar: 2 izin değeri, 2 enum, 1 tablo. DML ve backfill yok.
- Bu sözleşmeden önce iptal edilmiş talepler dokunulmadan kalır. Ortak yerel veritabanında (2026-09-28, salt okunur sayım) iptal edilmiş talep sayısı 0; CANCELLED talep + ACCEPTED teklif sayısı 0. Staging ve üretim sayımı bilinmiyor; deploy öncesi aynı sorgu çalıştırılmalı. Bunlarda denetim satırı yoktur ve kabul edilmiş teklifler ACCEPTED görünebilir.
  - Sayım için salt okunur sorgu:

    ```sql
    SELECT count(*) FROM "Offer" o JOIN "ServiceRequest" r ON r."matchedOfferId" = o.id
    WHERE r.status = 'CANCELLED' AND o.status = 'ACCEPTED';
    ```

  - Düzeltme ayrı bir karar ve ayrı bir iştir.
- Müşteri, iptal ettiği talep için yeni teklif almaz. İptal geri alınamaz.
