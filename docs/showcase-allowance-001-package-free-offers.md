# SHOWCASE-ALLOWANCE-001 — Paket bazlı ücretsiz teklif hakkı

Durum: uygulandı (PR `SHOWCASE-ALLOWANCE-001: per-package free offer count`).
Baz: main `b55b4fb0`. Migration: 101 → 102 (`20261016090000_add_showcase_package_free_offer_count`).
Önceki iş: `docs/campaign-entitlement-001-offer-allowance.md` (CAMPAIGN-ENTITLEMENT-001).

## 1. Ürün kuralı

Bir vitrin yayın döneminin (placement) taşıdığı ücretsiz teklif sayısı artık sabit 3 değil,
o dönemi satın alan paketin `freeOfferCount` değeridir.

- Admin paket oluştururken ve düzenlerken belirler: **1–50**, varsayılan **3**.
- Mevcut her paket 3 ile gelir; davranış değişmez.
- Değişiklik yalnız **sonraki checkout'ları** etkiler. Satılmış hak, yayındaki dönem ve grant kendi sayısını korur.
- Tüketim, resolver sırası, ledger, iade ve REL-002 / MATCH-001 davranışı CAMPAIGN-ENTITLEMENT-001'deki gibidir.

Neden en az 1: her placement doğumunda bir grant açılır ve grant `quotaTotal > 0` CHECK'ine tabidir.
"Ücretsiz teklifsiz vitrin paketi" ürün olarak istenirse ayrı karar ve ayrı iş (grant'siz doğum + tutarlılık kontrolü değişikliği).

## 2. Snapshot zinciri

```
ShowcasePackage.freeOfferCount            (katalog, admin düzenler)
  └─ checkout → PackagePurchase.freeOfferCountSnapshot      (alıcının gördüğü sayı)
       ├─ paket-önce: ödeme → ShowcaseEntitlement.freeOfferCountSnapshot
       │                └─ onay/harcama → ShowcasePlacement.freeOfferCountSnapshot
       └─ eski kart-bağlı: ödeme → ShowcasePlacement.freeOfferCountSnapshot
                                    └─ doğum (completeBirth) → OfferAllowanceGrant.quotaTotal
```

- Hiçbir halka kataloğu geri okumaz. Ödeme ile onay arasında paket değişse de hak checkout'taki sayıyı taşır.
- Ödeme kesinleşmesi (webhook ve mock) satın almanın snapshot'ını `purchaseFreeOfferCount` ile okur.
  `NULL` = migration'dan önce ya da deploy penceresinde eski sürümün açtığı checkout → **eski 3** (o sürümün sattığı).
- `grantShowcasePlacementAllowance` grant'i placement'ın kendi snapshot'ıyla açar. `ON CONFLICT DO NOTHING` olduğu
  için tekrar oynatma ikinci grant yazmaz ve saklı grant'in kotasını döndürür (log ve dönen değer gerçeği söyler).

## 3. Veri modeli (migration 102)

| Kolon | Tip | Kural |
| --- | --- | --- |
| `ShowcasePackage.freeOfferCount` | `INT NOT NULL DEFAULT 3` | CHECK `BETWEEN 1 AND 50` |
| `PackagePurchase.freeOfferCountSnapshot` | `INT NULL` | CHECK: NULL **ya da** (`kind = SHOWCASE_PACKAGE` ve ≥ 1). Mevcut vitrin satın almaları backfill ile 3 |
| `ShowcaseEntitlement.freeOfferCountSnapshot` | `INT NOT NULL DEFAULT 3` | CHECK ≥ 1 |
| `ShowcasePlacement.freeOfferCountSnapshot` | `INT NOT NULL DEFAULT 3` | CHECK ≥ 1 |

- Sabit varsayılanlı `ADD COLUMN` PostgreSQL'de tablo yeniden yazmaz.
- Mevcut grant'lere dokunulmaz: backfill edilmiş grant'lerin `quotaTotal`'ı (`legacy + 3`) aynen kalır.
- Tek veri ifadesi `-- BEGIN/END BACKFILL` arasındadır ve ikinci çalıştırmada 0 satır günceller.

## 4. API

- `POST/PATCH /admin/showcase/packages`: `freeOfferCount` (tamsayı, 1–50). Gönderilmezse oluşturmada 3,
  düzenlemede dokunulmaz. `null`, ondalık, string ve aralık dışı → 400. Değişiklik katalog audit'ine
  (`SHOWCASE_PACKAGE` geçmişi) `freeOfferCount` alanı olarak yazılır.
- `GET /providers/:id/showcase/packages` ve admin paket okumaları: `freeOfferCount`.
- `POST /providers/:id/showcase/packages/checkout`: isteğe bağlı `expectedFreeOfferCount`. Gönderilir ve
  paketin güncel değerinden farklıysa **409 `SHOWCASE_PACKAGE_FREE_OFFERS_CHANGED`**
  (`expectedFreeOfferCount`, `actualFreeOfferCount`), satın alma açılmaz. Göndermeyen eski istemci
  güncel değerle satın alır.
- Bekleyen checkout yeniden kullanımı snapshot'a bağlı: paket değiştikten sonra eski sayılı bekleyen
  checkout devam ettirilmez, yeni checkout açılır (eskisi PENDING kalır ve süresi dolar).
- Sağlayıcı okumaları:
  - `GET …/showcase/entitlements` ve `…/publication`: hak başına `freeOfferCount`.
  - `…/publication` kart girdisi: `freeOffers: { total, used, remaining } | null` (yayındaki dönemin grant'i).
  - `GET …/showcase/placements[/:id]`: `freeOfferCount` (snapshot) ve `freeOffers: { total, used, remaining, status } | null`.
- Admin okumaları: yerleşim listesi/detayı aynı iki alanı taşır; sürüm inceleme ekranındaki rezerve hak `freeOfferCount` taşır.
- Olay: `offer_allowance_granted … quotaTotal=<grant'in gerçek kotası>`.

## 5. Ekranlar

**Admin**
- Paket listesi: "Ücretsiz teklif" sütunu. Yeni paket penceresi: alan (varsayılan 3).
- Paket detayı: özet kartı, düzenleme alanı, salt-okunur görünüm, "Bu paket ne verir" kartı.
  Sayının değişmesi ticari değişiklik sayılır ve onay diyaloğunda `3 teklif → 6 teklif` olarak gösterilir.
- Yerleşim detayı: "Paketten gelen: N teklif (satın alma anındaki paket değeri)".
- Sürüm inceleme: rezerve hakkın ücretsiz teklif sayısı.

**Sağlayıcı (web)**
- Paket seçimi: her pakette "N ücretsiz teklif hakkı"; seçilen paketin sayısı `expectedFreeOfferCount` olarak gönderilir.
- Ödeme sonucu: "Bu hak … N ücretsiz teklif hakkı içerir".
- Yeni kart / hak seçimi: hak başına sayı.
- Kart durumu: yayında "Ücretsiz teklif hakkı: kalan / toplam"; rezerve hakta "N ücretsiz teklif hakkı içerir".
- Vitrin talepleri ve talep detayı: sabit "3" metni kaldırıldı; talep detayı dönemin kendi toplamını gösterir.

## 6. Eşzamanlılık ve idempotency

- Admin düzenlemesi ile checkout aynı anda: checkout kendi Serializable transaction'ında paketi okur ve
  aynı transaction'da snapshot'lar; ya eski ya yeni değeri tutarlı olarak alır. `expectedFreeOfferCount`
  gönderen ekran farkı 409 ile öğrenir.
- Tekrarlanan ödeme kesinleşmesi: `ShowcaseEntitlement.purchaseId` / `ShowcasePlacement.purchaseId` unique (değişmedi).
- Tekrarlanan doğum: grant `showcasePlacementId` unique + `ON CONFLICT DO NOTHING`; ilk kota kalır.
- Son slot yarışı: CAMPAIGN-ENTITLEMENT-001 §5 aynen; 1 haklı pakette test edildi (bir ücretsiz, bir 409, sonra açık ücretli tekrar).

## 7. Tutarlılık kontrolü

`scripts/ops/showcase-allowance-001-consistency.sql` (salt-okunur, tek SELECT; API testleri aynı dosyayı çalıştırır):

| Kontrol | Anlamı |
| --- | --- |
| `ENTITLEMENT_SNAPSHOT_MISMATCH` | Hakkın sayısı satın almanınkine (`NULL` = 3) eşit değil |
| `PLACEMENT_PURCHASE_MISMATCH` | Kart-bağlı dönemin sayısı satın almanınkine eşit değil |
| `PLACEMENT_ENTITLEMENT_MISMATCH` | Paket-önce dönemin sayısı hakkınkine eşit değil |
| `GRANT_QUOTA_MISMATCH` | Uygulamanın açtığı grant (`oag_` backfill'i hariç) dönemin sayısını taşımıyor |
| `GRANT_QUOTA_BELOW_SNAPSHOT` | Herhangi bir grant dönemin satıldığından az slot taşıyor |
| `OFFER_PACKAGE_WITH_SNAPSHOT` | Kredi paketi satın alması ücretsiz teklif sayısı taşıyor |

## 8. Deploy ve geri dönüş

- Sıra: migrate → api → web → admin. Değişiklik additive; eski sürüm yeni kolonları okumaz, yazdıkları
  varsayılan/NULL alır ve bu eski 3 anlamına gelir.
- Geri dönüş: kod revert'i yeterli (eski kod kolonları yok sayar, grant'ler 3 ile açılır). Kolonları düşürmek
  gerekmez; düşürülürse yalnız paket ayarları ve snapshot geçmişi kaybolur, başka tablo etkilenmez.
- Kod revert'i sonrasında 3'ten farklı sayıyla satılmış ama henüz yayına girmemiş haklar 3 ile doğar —
  revert öncesi `ShowcaseEntitlement` `AVAILABLE/RESERVED` ve `freeOfferCountSnapshot <> 3` satırları kontrol edilmeli.

## 9. Testler

- API: `apps/api/test/showcase-package-free-offers.spec.ts` — doğrulama (oluşturma/düzenleme/checkout, `null` dahil),
  DB CHECK'leri, audit, sağlayıcı paket listesi, tam snapshot zinciri (checkout ile ödeme ve ödeme ile onay arasında
  paket düzenlenir), kart-bağlı yol, `NULL` snapshot = 3, eskimiş ekran 409, bekleyen checkout yeniden kullanımı,
  tekrarlanan ödeme ve doğum, 1 haklı pakette yarış + ücretli tekrar, 5 haklı pakette sıra 1..5 ve 6. teklifin ücreti,
  migration backfill'i (iki kez çalıştırma). Her testten sonra iki tutarlılık dosyası boş döner.
- Admin birim: ticari değişiklik algılama, onay kanıtı, yerleşim bölümü.
- Web birim: sabit "3" metninin kalmadığı.
- E2E: admin oluşturma (varsayılan 3) ve düzenleme (onay diyaloğu `3 teklif → 6 teklif`, liste/detay),
  sağlayıcı paket seçimi (7), talep ekranı ve kart durumu (5 haklı dönem).
