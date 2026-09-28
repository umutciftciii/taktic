# Faz 3A — talep iptali sözleşmesi (PR #118)

Bu klasördeki görüntüler, iptal sözleşmesinin uygulandığı head'e aittir (`docs/superpowers/specs/2026-09-28-request-cancellation-contract.md`). `../pre-merge-409/` klasöründeki iptal diyaloğu ve "reddedilemez" görüntüleri eski head `08ab7c86`'nın metnini gösterir; iptal sözleşmesi o metnin yerini aldı.

- **Kaynak:** `e2e/tests/admin-requests-offers.spec.ts`, E2E fixture verisi ve izole `_e2e` veritabanı.
- **Boyutlar:** Chromium 1440px, WebKit 320px. Görüntüler viewport'tur, tam sayfa değil.

| Dosya | Ne gösteriyor |
| --- | --- |
| `*-request-cancel-dialog-matched-*` | Süper yönetici, eşleşmiş talep. Kutu işaretli, kazanan kredisi iade edilir. Diyalogda açık, rakip ve elle reddedilmiş teklif sayıları görünür; K4 gereği elle reddedilenin kredisi de iade edilir. |
| `*-request-cancel-dialog-withhold-*` | İadesiz iptal izinli personel. Kutunun işareti kaldırıldı ve gerekçe girildi; kazanan kredisi iade edilmez. |
| `*-request-cancel-dialog-open-*` | Eşleşmemiş talep. Kutu yok; açık teklifler kapanır ve kredileri iade edilir. |
| `*-request-cancellation-record-*` | İptalden sonra "İptal kaydı" kartı: aktör, karar, kapatılan ve iade edilen teklifler. |
| `*-customer-cancel-dialog-*` | Müşteri web ekranı, açık talepte iptal onayı. |
| `*-customer-cancel-dialog-no-offers-*` | Teklifsiz talepte müşteri iptal onayı: “şu anda açık teklif yok; iptalden sonra da yeni teklif gelmez”. |
| `*-customer-cancelled-*` | Müşterinin iptal sonrası bildirimi; iptal düğmesi artık yok. |
| `*-customer-cancel-refused-matched-*` | Sayfa açıkken eşleşen talep: 409 açıklanır, iptal sunulmaz. |
| `*-request-409-*`, `*-offer-409-*` | 409 bantları, güncel metinlerle. |
