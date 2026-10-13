# CAMPAIGN-ENTITLEMENT-001 — Sınırlı vitrin teklif hakkı

Durum: uygulandı (PR `CAMPAIGN-ENTITLEMENT-001: add bounded showcase offer allowances`).
Baz: main `274d47a2`. Migration: 100 → 101 (`20261015090000_add_offer_allowances`).

## 1. Ürün kuralı

Vitrin yerleşimi (placement) ücretli bir görünürlük ürünüdür. Her yayın dönemi
(`ShowcasePlacement`) sağlayıcıya **3 ücretsiz vitrin kaynaklı teklif** hakkı verir.

- Hak yalnızca **o placement üzerinden gelen** doğrudan lead'lerde kullanılır.
- Yenileme ya da yeni satın alma yeni bir placement doğurur ve taze 3 hak getirir. Eski hak devretmez, kullanılmayan hak bir sonraki döneme aktarılmaz.
- 3 hak bittikten sonraki teklif, normal kategori kredi maliyetiyle ücretlendirilir.
- Tarihsel sıfır kredili vitrin teklifleri geriye dönük ücretlendirilmez ve değiştirilmez.
- Vitrin yaşam döngüsü değişmedi: lead yalnızca kart sahibine gider; SLA → BREACHED → RELEASE / KEEP_CLOSED akışı, RELEASE sonrasındaki moderasyon ve auto-publish, REL-002 R2+ pazaryeri turları eskisi gibi çalışır.

Kaldırılan davranış: `ServiceRequest.directShowcaseProviderId == providerId` koşulu sağlanan her teklifin koşulsuz `creditCost: 0` olması (resolver'ın ilk dalı).

## 2. Kimlik: yayın dönemi = `ShowcasePlacement.id`

Her ödeme en fazla bir placement doğurur (`purchaseId @unique`). Uzatma endpoint'i yok; yenileme her zaman yeni bir placement demektir. Bu yüzden hakkın kapsamı placement'tır. Placement iki yoldan doğar ve ikisi de aynı `completeBirth` adımında biter:

| Yol | Fonksiyon |
| --- | --- |
| Eski kart-bağlı satın alma (webhook / mock ödeme kesinleşmesi) | `ShowcasePlacementService.createForPurchase` |
| Paket-önce akış (hakkın onaylı karta harcanması / ilk onay) | `ShowcasePlacementService.createForEntitlement` |

`completeBirth` placement'ı ACTIVE yapar ve grant'i **aynı transaction'da** yazar (`grantShowcasePlacementAllowance`, `INSERT … ON CONFLICT DO NOTHING`).

## 3. Veri modeli

```
OfferAllowanceGrant   (placement başına 1; UNIQUE showcasePlacementId)
  providerId, source=SHOWCASE_PLACEMENT, benefit=FREE_OFFER,
  quotaTotal (snapshot, >0), quotaUsed (0..quotaTotal), validFrom=placement.startAt,
  status ACTIVE|VOID, voidedAt/voidReason/voidedById (üçü birlikte), grantedAt, updatedAt

OfferAllowanceUsage   (append-only; teklif başına 1)
  grantId, ordinal (1..quotaUsed), offerId UNIQUE, providerId, requestId,
  matchRoundId, showcaseLeadId UNIQUE, categoryId, listCreditCostSnapshot, consumedAt
  UNIQUE (grantId, ordinal)
```

Veritabanı değişmezleri:
- `OfferAllowanceGrant_quota_total_positive` ve `_quota_used_bounded` CHECK'leri, `_source_scope` (SHOWCASE_PLACEMENT ⇔ `showcasePlacementId` NOT NULL) ve `_void_shape`.
- `OfferAllowanceUsage_insert_guard` trigger'ı: usage satırının sağlayıcısı grant'in sağlayıcısıyla aynı olmalı ve `ordinal` grant'in zaten talep edilmiş bir slotu olmalı (`ordinal ≤ quotaUsed`).
- `OfferAllowanceUsage_append_only` trigger'ı: UPDATE ve DELETE reddedilir.
- Tüm FK'lar `ON DELETE RESTRICT`.

`Offer` tablosu değişmedi. Ücretsiz bir hak teklifi yine `entitlementSource = SHOWCASE_PLACEMENT` ve `creditCost = 0` yazar. Usage satırı **varsa** teklif sınırlı haktan ödenmiştir, **yoksa** eski (sınırsız) dönemden kalan bir tekliftir.

Kota v1'de sabittir: `SHOWCASE_FREE_OFFER_QUOTA = 3` (`offer-allowances/offer-allowance-ledger.ts`), grant üzerinde snapshot'lanır. Paket bazında ayarlanabilir kota yoktur.

## 4. Resolver sırası

`EntitlementResolverService.resolve`:

1. **CATEGORY_UNLIMITED** (kapsam kategoriyi kapsıyorsa). Limitsiz dönem sınırlı vitrin hakkını yakmasın diye en başta.
   - İstisna: limitsiz dönem günlük sınırına ulaştıysa ve bu lead'e bağlı boş bir vitrin slotu varsa, sınır reddetmek yerine slot öder. Bu bir ücrete düşme değildir; slot ücretsizdir.
2. **Vitrin hakkı:** sağlayıcının kendi gate'li doğrudan lead'i, placement'ının ACTIVE grant'i ve boş bir slot.
3. **MONTHLY_QUOTA.**
4. **Tek seferlik kredi** (değişmedi, 402 dahil).

Uygunluk (`readShowcaseAllowance`) şu koşulların **hepsini** ister:
- `request.directShowcaseProviderId == providerId`
- `showcaseLeadId` mevcut ve `lead.providerId == providerId`
- Grant `showcasePlacementId == lead.placementId` ve grant sağlayıcısı aynı
- Mevcut tur `DIRECT_SHOWCASE` (REL-002 R2+ ve RELEASE edilmiş talep MARKETPLACE olduğu için hak kullanamaz)
- `status = ACTIVE` ve `quotaUsed < quotaTotal`

Okumada saat kontrolü yoktur; neden §8'de.

## 5. Atomik tüketim

Teklifin kendi Serializable transaction'ı içinde (`createOfferRecord` → `consume`) iki adım atılır:

1. Slot alınır:
   ```sql
   UPDATE "OfferAllowanceGrant" SET "quotaUsed" = "quotaUsed" + 1
    WHERE "id" = $1 AND "status" = 'ACTIVE' AND "quotaUsed" < "quotaTotal"
   RETURNING "quotaUsed"   -- = ordinal
   ```
2. Ardından `OfferAllowanceUsage` satırı eklenir.

Satır dönmezse `ShowcaseAllowanceUnavailable` atılır ve istemciye 409 `CREDIT_COST_CHANGED` döner; teklif asla sessizce ücretlenmez.

Eşzamanlılık (1 hak kalmış, 2 teklif):
- Postgres ikinci UPDATE'i bekletir ve serileştirme hatası verir; `runSerializable` işlemi yeniden oynatır.
- Tekrar oynatmada grant tükenmiş okunur, karar ücretli olur ve beklenen maliyet 0 olduğu için 409 döner.
- Sonuç: tam olarak bir ücretsiz teklif ve bir 409. Çift tüketim ya da negatif kalan oluşmaz; CHECK ve `(grantId, ordinal)` unique'i bunu ayrıca garanti eder.

Hak tüketilmeyen durumlar: doğrulama hatası, 402, 409, rollback, kapalı tur, aynı turda ikinci teklif (409, `(providerId, matchRoundId)` unique'i).

## 6. Beklenen maliyet sözleşmesi

- `GET /providers/:providerId/requests/:requestId/offer-cost` salt okunurdur. Dönen alanlar:
  - `kind`: `SHOWCASE_ALLOWANCE | UNLIMITED | MONTHLY_QUOTA | CREDITS | INSUFFICIENT_CREDITS | DAILY_LIMIT`
  - `creditCost`, `categoryCreditCost`
  - `allowance: { quotaTotal, quotaUsed, remaining } | null`
- Doğrudan lead formu bu bilgiyi gösterir ("Bu teklif vitrin hakkınızdan düşecek — 0 kredi" ya da "Bu teklif X kredi", artı "2 / 3 kaldı") ve `expectedCreditCost = creditCost` gönderir.
- Doğrudan lead'de API bu değeri resolver'ın kararıyla karşılaştırır. Aşağıdaki durumların hepsi 409 `CREDIT_COST_CHANGED` (`expectedCreditCost`, `actualCreditCost` ile) döndürür:
  - Değerler uyuşmuyorsa.
  - Beklenti hiç yoksa ve karar ücretliyse.
  - Teklif ücretsiz gösterilmiş ama bakiye yetersizse. Burada önce 409 döner; 402 yalnızca onaylanmış ücretli denemenin cevabıdır.
- Pazaryeri talebinde davranış öncekiyle aynı: kategori fiyatıyla eşitlik kontrolü yapılır, beklenti göndermek zorunlu değildir.
- DTO'da `expectedCreditCost` artık `@Min(0)`.

## 7. Ücretsiz teklif ve ücretli fallback

**Ücretsiz teklif:**
- `creditCost = 0`, ledger satırı yok, bakiye ve promo lot hareketi yok, `creditSpentTransactionId = null`.
- `unviewedRefundPolicy = false`, iade de yok.
- Kayıt `OfferAllowanceUsage` satırıdır; `listCreditCostSnapshot` sübvansiyon analitiği içindir.

**Ücretli fallback (kota bittikten sonra):**
- Normal ücretli teklif semantiği geçerlidir: kategori maliyeti, promo/ücretli kredi şelalesi, `OFFER_SPEND`, bakiye kontrolü ve 402, 48 saatlik görülmeme iadesi politikası, recharge/refund kuralları, normal REL-002 davranışı.
- Teklif yine **doğrudan lead cevabıdır**.

**Doğrudan lead kimliği düzeltmesi:** `isDirectLeadOffer` artık `request.directShowcaseProviderId === providerId` ifadesinden, yani gate'ten türetiliyor. Eskiden ödeme kaynağından türetiliyordu. Böylece ücretli bir cevap da lead'i ANSWERED yapar ve SUBMITTED → APPROVED geçişini (round publish) yapar; SLA sweeper cevaplanmış bir lead'i BREACHED yapamaz.

**Hak hiçbir koşulda geri verilmez:** withdraw, reject, talep iptali, müşterinin hiç kabul etmemesi, REL-002 hata turu, sağlayıcı hatası, lead breach. Usage append-only'dir ve `quotaUsed` asla azalmaz.

## 8. Süre sonu ve yenileme

- Hak süre sonu için sweeper yoktur. Kapsamı placement'ın kendisi sınırlar.
- Lead yalnızca placement canlıyken açılabilir. Dönem içinde gelmiş bir lead, placement'ın `endAt`'i geçmiş olsa bile çözülene kadar (gate kalkana kadar) o placement'ın hakkını kullanabilir.
- Kullanılmayan hak başka bir placement'a ya da yenilemeye taşınmaz.
- Askıya alma kotayı etkilemez.
- Admin iptali mevcut meşru lead'lerin hakkını otomatik VOID etmez. VOID değeri ileride ayrı bir cezai admin özelliği için var; bu PR'da ona yazan bir endpoint yok.

## 9. REL-002 ve MATCH-001

- **REL-002:** R1'de hakla verilmiş bir teklifin sağlayıcısı başarısız olursa usage tüketilmiş kalır; kota geri gelmez, otomatik kredi iadesi olmaz (mevcut REL-002 kuralı) ve sağlayıcı hariç tutulur. R2+ MARKETPLACE turudur; gate `null` olduğu için eski vitrin hakkı kullanılamaz ve teklifler normal paket/kredi zincirinden ödenir.
- **MATCH-001:** Hak yalnızca teklifin efektif maliyetini belirler. REMOTE / ON_SITE / HYBRID, bölge eşleşmesi, görünürlük, hariç tutma ve bildirim değişmedi.

## 10. Kötüye kullanım ve güvenlik

- Uygulanan bağlar:
  - Grant sağlayıcısı = lead sağlayıcısı
  - Placement = lead placement'ı
  - Gate sağlayıcısı = teklif veren
  - Tur DIRECT_SHOWCASE
- Kart, placement ya da sağlayıcı arası taşınma yok; DB trigger'ı usage tarafında da sağlayıcı eşliğini zorlar.
- v1'de admin'in serbest grant yazdığı bir endpoint yok.
- Sahte lead riski bu PR'ın konusu değil. Mevcut SMS doğrulaması ve rate-limit aynen geçerli; sınırlı kota önceki sınırsız sübvansiyonu da daraltıyor.

## 11. Gözlemlenebilirlik

Tek satırlık, aranabilir olaylar yazılır: `offer_allowance_event event=<ad> k=v …` (`offer-allowances/offer-allowance-events.ts`). Yalnızca id, sayı ve enum içerir; PII yoktur. Hepsi **commit sonrasında** yazılır, bu yüzden yeniden oynatılan ya da reddedilen denemeler sayılmaz.

| Olay | Ne zaman |
| --- | --- |
| `offer_allowance_granted` | Placement doğumu commit olduğunda; 4 post-commit noktası: webhook, mock ödeme, hak harcama, ilk onay |
| `offer_allowance_consumed` | Ücretsiz teklif commit olduğunda (`grantId`, `placementId`, `offerId`, `ordinal`, `quotaTotal`) |
| `offer_allowance_exhausted_fallback` | Doğrudan lead'e ücretli (ya da paketle ödenen) teklif commit olduğunda; teklif başına 1 kez |

## 12. Admin

- **Yerleşim detayı** (`SHOWCASE_PLACEMENTS_READ`): "Ücretsiz teklif hakkı" bölümünde kullanılan/toplam, kalan, sübvanse edilen kredi (normal kategori bedeli toplamı), geçişte sayılan eski sınırsız teklifler ve durum yer alır. Kullanım listesi (teklif no, slot, normal bedel, zaman) yalnızca `OFFERS_READ` ile gelir; izin yoksa `usages` anahtarı hiç gönderilmez (cross-domain projeksiyon kuralı).
- **Teklif detayı:** "Ödeme kaynağı" satırı gösterilir: `Vitrin ücretsiz teklif hakkı · 2 / 3` ve normal bedel. Kredi hareketiyle karıştırılmaz. Eski sıfır kredili teklifler "Eski sınırsız vitrin hakkı" olarak etiketlenir.

## 13. Geçiş (migration 101) ve backfill

Migration enum'ları, iki tabloyu, indeksleri, CHECK'leri ve iki trigger'ı ekler; ardından tek bir backfill ifadesi çalıştırır (`-- BEGIN/END BACKFILL`).

Grant alan placement'lar:
- `PENDING_ACTIVATION` / `ACTIVE` ve `endAt > now` olanlar,
- `SUSPENDED` olanlar (saati durduran bir resume `endAt`'i yeniden ileri alabilir),
- durumu ne olursa olsun, lead'lerinden biri hâlâ sahibinin cevabını bekleyenler (lead OPEN / BREACHED, talep sahibine gate'li ve SUBMITTED / APPROVED). Bu, §8'deki "lead çözülene kadar" kuralının geçişteki karşılığıdır.

Kota ataması: `quotaTotal = (o placement'ın lead'lerine verilmiş eski SHOWCASE_PLACEMENT teklif sayısı) + 3` ve `quotaUsed = o sayı`. Eski teklifler yalnızca sayılır; hiçbir Offer satırı değişmez ve usage satırı uydurulmaz. Grant id'si deterministiktir: `oag_<placementId>`. İfade `ON CONFLICT DO NOTHING` olduğu için ikinci çalıştırmada etkisizdir.

Testler: `apps/api/test/offer-allowance-migration.spec.ts` (0 / 2 / 5 eski teklif → 3/0, 5/2, 8/5; bitmiş, süresi geçmiş ACTIVE, askıda, açık lead'li bitmiş placement; Offer satırları birebir aynı kalır; usage = 0; ikinci çalıştırma 0).

## 14. Geri dönüş sınırı

- **Usage = 0 iken:** `scripts/ops/campaign-entitlement-001-rollback.sql` iki tabloyu, trigger'ları ve enum'ları siler, migration kaydını kaldırır. Tek transaction'dır ve usage varsa çalışmayı reddeder.
- **Usage > 0 iken:** Tablolar finansal denetim kaydı olduğu için **DROP edilmez**. Kod revert'i eski sınırsız ücretsiz davranışa döner, tablolar okunmadan kalır. Tercih edilen yol forward-fix'tir.
- Eski uygulama kodu yeni tabloları görmez (değişiklik additive). Deploy sırası: migrate → api → web → admin.

## 15. Gelecekte yeniden kullanım (bugün uygulanmadı)

Model, aşağıdakileri engellemeyecek kadar geneldir:

| Senaryo | Nasıl genişler |
| --- | --- |
| Pro: ayda N ücretsiz teklif | `source = SUBSCRIPTION` + kendi kapsam kolonu |
| Lansman: ilk 5 teklif ücretsiz | `source = CAMPAIGN` + `campaignVersionId` |
| Kategoriye özel promo | Kapsam kolonu |
| Goodwill | `source = GOODWILL` + `voidedBy` deseni |
| Yüzde indirim / sabit sübvansiyon | Yeni `OfferAllowanceBenefit` değeri |

Her yeni kaynak kendi kapsam kolonunu ve CHECK'ini getirir. Mevcut değerler yeniden yorumlanmaz. Resolver'daki yeri (sıra) her kaynak için ayrı bir ürün kararıdır.

## 16. Bilinen borçlar

- Paket bazında ayarlanabilir kota (`ShowcasePackage.includedFreeOffers` + satın alma snapshot'ı) yok.
- Cezai VOID için admin aksiyonu yok.
- Finans analitiğinde toplam sübvansiyon kartı yok; veri `OfferAllowanceUsage.listCreditCostSnapshot` üzerinden hazır.
