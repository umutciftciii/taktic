# SHOWCASE-ALLOWANCE-003 — Ücretsiz teklif hakkını kapatabilme

`ShowcasePackage.freeOfferCount` aralığı **1–50 → 0–50**. Varsayılan 3 olarak
kalır. `0`, o vitrin paketiyle satılan yayın döneminde ücretsiz teklif hakkı
bulunmadığı anlamına gelir.

## Davranış

| Adım | `freeOfferCount = 0` iken |
| --- | --- |
| Admin oluştur / düzenle | Kabul edilir (form `min=0`, DTO `@Min(0)`, DB CHECK `0..50`). Değişiklik ticari onay diyaloğundan geçer ve audit'e `3 → 0` yazılır. |
| Checkout | `freeOfferCountSnapshot = 0`. `expectedFreeOfferCount` 0 ile 3 arasında kaymışsa 409 `SHOWCASE_PACKAGE_FREE_OFFERS_CHANGED`. Bekleyen checkout yeniden kullanımı snapshot'a bağlı kalır. |
| Ödeme / hak | `ShowcaseEntitlement.freeOfferCountSnapshot = 0`. |
| Yayın doğumu (`completeBirth`) | Placement snapshot'ı 0; **OfferAllowanceGrant oluşturulmaz**. `offer_allowance_granted` log'u atılmaz. |
| Teklif | `readShowcaseAllowance` grant bulamaz → resolver normal sırayla devam eder (UNLIMITED → MONTHLY_QUOTA → kredi). Önizleme `CREDITS` / `INSUFFICIENT_CREDITS`, `allowance: null`. `expectedCreditCost: 0` ile gelen istek 409 `CREDIT_COST_CHANGED`. |
| Ekranlar | Admin ve sağlayıcı ekranları "Ücretsiz teklif hakkı yok" der. |

Grant tablosunun `quotaTotal > 0` CHECK'i bilerek değiştirilmedi: 0 haklı bir
grant tüketilemez olurdu ama "grant yok" zaten teklif yolunun "normal öde"
okumasıdır; ikinci bir temsil eklemenin faydası yok.

## Geriye uyumluluk

- Snapshot zinciri (paket → satın alma → hak / yayın → grant) aynı. Bir paketi
  0'a çekmek daha önce satılmış satın alma, hak, yayın, grant ve usage
  kayıtlarını değiştirmez; 3 ile satılmış yayın kalan haklarını kullanmaya
  devam eder.
- Vitrin önceliği, iade kuralları, resolver sırası ve diğer entitlement
  davranışları değişmedi.
- Yeni API alanları: sağlayıcı lead yanıtında `freeOfferCount` (yayının satış
  sayısı), yayın listesinde `liveFreeOfferCount` (canlı dönem yoksa `null`).

## Migration 102 → 103

`20261017090000_allow_zero_showcase_free_offer_count` — yalnız CHECK
genişletme, satır yazmaz:

- `ShowcasePackage_free_offer_count_range`: `BETWEEN 0 AND 50`
- `PackagePurchase_free_offer_count_snapshot_shape`: snapshot `>= 0`
- `ShowcaseEntitlement_free_offer_count_snapshot_positive` →
  `…_snapshot_non_negative` (`>= 0`)
- `ShowcasePlacement_free_offer_count_snapshot_positive` →
  `…_snapshot_non_negative` (`>= 0`)

Deploy sırası: migrate → api → web → admin. Rollback yalnız hiçbir satırda 0
yokken: dört CHECK'i 102'deki alt sınır 1 ve eski adlarıyla yeniden kur.

## Operasyon kontrolleri

- `scripts/ops/showcase-allowance-001-consistency.sql` yeni kontrol
  `ZERO_SNAPSHOT_WITH_GRANT`: 0 ile satılmış yayının grant'i olmamalı.
- `scripts/ops/campaign-entitlement-001-consistency.sql`
  `LIVE_PLACEMENT_WITHOUT_GRANT` artık yalnız `freeOfferCountSnapshot > 0`
  yayınlara bakar (dosya artık migration 102'yi gerektirir).

Testler: `apps/api/test/showcase-zero-free-offers.spec.ts`,
`apps/web/test/showcase-zero-free-offers.spec.tsx`,
`apps/admin/test/showcase-zero-free-offers.spec.tsx`.
