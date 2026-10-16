# SHOWCASE-ALLOWANCE-004 — Ücretsiz vitrin hakkı iptali (VOID)

- **Taban:** main `8a46f0ce`
- **Migration:** **103 → 104** (`20261018090000_add_offer_allowance_void`)
- **Yeni izin:** `SHOWCASE_ALLOWANCE_VOID`. Yalnız SUPER_ADMIN kullanabilir (`SUPER_ADMIN_RESERVED_PERMISSIONS`), hiçbir rol taşıyamaz. Katalogda 94 olan izin sayısı 95 oldu.
- **Uç nokta:** `POST /admin/showcase/placements/:placementId/allowance/void`

## 1. Ürün kararları

| Karar | Uygulama |
| --- | --- |
| Hakkı yalnız SUPER_ADMIN iptal edebilir | Reserved izin, DB trigger'ı `voidedById` için `role = SUPER_ADMIN` kontrolü yapar |
| Kısmi iptal yok | Gövdede miktar alanı yok; kalan hakların tamamı VOID olur |
| Kullanılmış haklar ve geçmiş korunur | Usage satırları append-only, `quotaUsed` asla azalmaz, VOID satır dondurulur |
| Sağlayıcıya idempotent outbox e-postası gider | `showcase-allowance-voided` şablonu, dedupe anahtarı `showcase-allowance-voided:<grantId>` |
| Sağlayıcı panelinde iptal gösterilir | Kart sayfası, lead teklif paneli ve 409 metni |
| Otomatik iade, kredi hareketi ya da yerleşim iptali yok | Servis yalnız grant satırına ve outbox'a yazar |

## 2. Veritabanı (migration 104)

- `voidReason TEXT` sütunu `OfferAllowanceVoidReason` enum'una çevrildi (FRAUD, ABUSE, TERMS_VIOLATION, OPERATOR_ERROR, OTHER). Ön koşul: hiçbir satırda void verisi yoksa migration çalışır, varsa durur.
- Yeni `voidNote TEXT` sütunu eklendi. `_void_shape` kuralı genişletildi: dört void sütunu ya birlikte dolu ya birlikte boştur ve yalnız VOID satırda dolu olabilir. `_void_note_length` kuralı: kırpılmış hâliyle 10–1000 karakter.
- `OfferAllowanceGrant_guard` trigger'ı:
  - Grant ACTIVE doğmak zorundadır.
  - `id`, `providerId`, `source`, `benefit`, `showcasePlacementId` ve `quotaTotal` değiştirilemez.
  - `quotaUsed` azalamaz.
  - ACTIVE → VOID geçişi:
    - aynı ifadede slot alamaz;
    - iptal edilecek hak kalmış olmalıdır;
    - aktör SUPER_ADMIN olmalıdır.
  - VOID satır bir daha güncellenemez ve silinemez.
- Geri dönüş: `scripts/ops/showcase-allowance-004-rollback.sql`. Yalnız hiçbir VOID grant yoksa ve hiçbir rol yeni izni taşımıyorsa çalışır; aksi hâlde ileri-düzeltme gerekir. Enum değeri PostgreSQL'de silinemediği için kalır.

## 3. API sözleşmesi

Gövde: `{ reasonCode, note, expectedQuotaTotal, expectedQuotaUsed, expectedOpenLeads }`. Üç `expected*` alanı zorunludur. Bunlar onay diyaloğunda gösterilen değerlerdir ve compare-and-set olarak geri gönderilir.

| Durum | Yanıt |
| --- | --- |
| Başarı | 200, güncel yerleşim detayı (`offerAllowance.status = VOID`) |
| Gerekçe kodu eksik ya da geçersiz, beklenen değer eksik, not 1000 karakterden uzun | 400 (DTO) |
| Kırpılmış not 10 karakterden kısa | 400 `OFFER_ALLOWANCE_VOID_NOTE_REQUIRED` |
| Yerleşim yok | 404 `SHOWCASE_PLACEMENT_NOT_FOUND` |
| Yerleşim 0 ücretsiz teklifle satılmış | 409 `OFFER_ALLOWANCE_ZERO_PACKAGE` |
| Grant yok (hak sisteminden önce bitmiş yayın) | 409 `OFFER_ALLOWANCE_NOT_FOUND` |
| Grant zaten VOID | 409 `OFFER_ALLOWANCE_ALREADY_VOID` |
| Kalan hak yok | 409 `OFFER_ALLOWANCE_NOTHING_TO_VOID` |
| Onaydan sonra değerler değişmiş | 409 `OFFER_ALLOWANCE_CHANGED`, gövdede `current: { quotaTotal, quotaUsed, openLeads }` |
| Eşzamanlı çakışma | 409 `CONCURRENT_MODIFICATION` |

İşlem tek bir Serializable transaction içinde yürür:

1. Yerleşim ve grant okunur, ret koşulları kontrol edilir.
2. Açık lead'ler model sorgusuyla sayılır; ham SQL kullanılmaz, çünkü ham sorgunun serileştirme hatası (P2010) yeniden denenmez.
3. Beklenen değerler karşılaştırılır.
4. `updateMany WHERE status = ACTIVE AND quotaTotal AND quotaUsed` ile grant VOID yapılır.
5. Outbox intent'i aynı transaction içinde yazılır.

Commit'ten sonra `offer_allowance_voided` olayı loglanır ve `deliverSoon()` çağrılır. Gönderilemeyen bildirimleri istek yaşam döngüsü tick'i süpürür.

**Açık lead sayısı:** Harcama yolunun kullandığı bağlayıcı koşulun aynısıdır:

- lead OPEN ya da BREACHED;
- talep sahibine gate'li ve SUBMITTED ya da APPROVED;
- talebin güncel turu DIRECT_SHOWCASE.

Finans raporundaki `openLeads` aynı koşulun SQL karşılığıdır.

## 4. Dokunulmayanlar

Usage satırları, kredi ledger'ı, cüzdan, `PackagePurchase`, `ShowcaseEntitlement`, `ProviderPackageEntitlement`, yerleşim, lead'ler ve teklifler. Testler bu satırların void öncesi ve sonrası birebir aynı kaldığını doğrular. Açık lead'ler kapanmaz; sağlayıcı bu lead'lere kategori kredisiyle teklif verir.

Yerleşim iptali ve paket iadesi grant'a dokunmaz. VOID'u yalnız void servisi yazar ve bir kaynak tarama testi bunu doğrular.

## 5. Teklif yolu

- **Önizleme:** `allowance: null`, `allowanceVoided: true`, `kind` değeri CREDITS ya da INSUFFICIENT_CREDITS.
- **Eski ücretsiz beklenti** (`expectedCreditCost: 0`): 409 `CREDIT_COST_CHANGED` döner. Gövdede `allowanceVoided: true` vardır, metin "ücretsiz teklif hakkı iptal edildi" der. Kredi yoksa da önce 409 döner, 402 değil. Sessizce ücret kesilmez.
- **Yarış:** VOID ve teklif aynı anda gelirse ikisi birlikte başarılı olamaz. VOID önce kazanırsa teklif 409 alır. Teklif önce kazanırsa VOID `OFFER_ALLOWANCE_CHANGED` ya da `CONCURRENT_MODIFICATION` alır.

## 6. Bildirim

Şablon: `showcase-allowance-voided`. İçerik: kart, paket, iptal edilen hak sayısı, iptal zamanı ve neyin değişmediği. **Gerekçe kodu, iç not ve aktör e-postada yoktur.** Compose bu alanları hiç seçmez.

Kayıt grant'tan yeniden üretilir; VOID satır kalıcı olduğu için tekrar denemede de aynı içerik çıkar. Grant başına tek intent yazılır, tekrar yazılmaya çalışılırsa benzersiz index çakışır ve satır eklenmez.

## 7. Ekranlar

- **Admin yerleşim detayı:**
  - VOID bildirimi, durum rozeti, iptal eden, gerekçe etiketi, iç açıklama ve "Kalan: 0 (N hak iptal edildi)";
  - hak geçmişi tablosu (tanım, her kullanım, iptal; yeniden eskiye);
  - SUPER_ADMIN için, kalan hak varsa, gerekçe seçimi, iç açıklama ve `ConfirmDialog` (`showcase.allowance-void`). Diyalog kalan, kullanılmış ve açık lead sayılarını ve olmayacakları listeler.
- **Finans raporu:** `remainingVoided`, `remainingUnusable`'ın bir alt kümesidir; toplam eşitliği (`defined = tracked + legacy + usable + unusable`) değişmez. KPI satırında, kırılım tablolarında ("İçinden iptal edilen" sütunu) ve yöntem bölümünde gösterilir.
- **Sağlayıcı paneli:**
  - kart sayfasında "Ücretsiz teklif hakkınız iptal edildi";
  - lead teklif panelinde "ücretsiz teklif hakkı iptal edildi; bu teklif N kredi";
  - formda VOID'a özel 409 uyarısı.

  Sağlayıcı projeksiyonları `status` ve `remaining: 0` taşır; gerekçe, not ve aktör taşımaz.

## 8. Tutarlılık kontrolü

`scripts/ops/campaign-entitlement-001-consistency.sql` dosyasına iki kontrol eklendi:

- 10 `USAGE_AFTER_VOID`
- 11 `VOID_BY_NON_SUPER_ADMIN`

İkisi de migration 101'den beri var olan sütunları okur.

## 9. Staging ve production

Bu PR staging ya da production'a dokunmaz. Dağıtım sırası: migrate (104) → api → admin → web, ardından iki consistency SQL. Yerel bir VOID kaydı yalnız SUPER_ADMIN oturumuyla ve bilinçli olarak yazılmalıdır, çünkü geri alınamaz.
