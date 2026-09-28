# Faz 3A — 409 bantları ve iptal diyaloğu (merge öncesi, head `08ab7c86`)

> **Yerini aldı:** iptal diyaloğu ve `request-409-not-removable` görüntüleri iptal sözleşmesinden önceki metni gösterir. Güncel hâlleri `../cancellation-contract/` klasöründe.

Bu klasördeki görüntüler, PR #118'in main@4e1d1c98 ile birleştirilmiş ve 409 eşlemesi eklenmiş hâline aittir; üst klasördeki görüntüler daha eski head `b79f968a`'nındır ve bu ekranları içermez.

- Kaynak: `e2e/tests/admin-requests-offers.spec.ts` → "Faz 3A: API refusals land on the screen, not the error boundary" (E2E fixture verisi).
- Chromium 1440px, WebKit 320px (viewport, tam sayfa değil).

| Dosya | Ne gösteriyor |
| --- | --- |
| `*-offer-409-decided-*` | Sayfa açıkken reddedilmiş teklife "Kısa listeye al" → `OFFER_ACTION_NOT_ALLOWED` bandı |
| `*-offer-409-disclosure-*` | İletişim paylaşımı açık, müşteri onayı yok → `CONTACT_DISCLOSURE_REQUIRED` bandı |
| `*-request-409-transition-*` | Sayfa açıkken iptal edilen talebe "Onayla" → `REQUEST_STATUS_TRANSITION_NOT_ALLOWED` |
| `*-request-409-not-cancellable-*` | Sayfa açıkken tamamlanan talebe "İptal et" → kodsuz 409 |
| `*-request-409-not-removable-*` | Sayfa açıkken eşleşen talebe "Talebi reddet" → `REQUEST_NOT_REMOVABLE` + durum nedeni |
| `*-request-cancel-dialog-matched-*` | Eşleşmiş talep iptal diyaloğu: kalan açık ve reddedilmiş teklif sayıları |
| `*-request-cancel-dialog-open-*` | Açık talep iptal diyaloğu |
