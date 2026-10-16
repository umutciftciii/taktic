# SHOWCASE-ALLOWANCE-002: ücretsiz vitrin teklif hakları finans raporu

Vitrin paketleriyle verilen ücretsiz teklif haklarını salt-okunur olarak raporlar:
`GET /finance/offer-allowances` (FINANCE_READ) ve admin ekranı `/finance/offer-allowances`
(Finans → Ücretsiz vitrin hakları).

Migration yok. Hak tüketimi, iade davranışı, kredi ledger'ı ve finans özetindeki gelir
KPI'ları değişmedi.

## Veri kaynakları

| Kaynak | Rapordaki rolü |
|---|---|
| `OfferAllowanceGrant` | Tanımlanan (`quotaTotal`), kullanılan (`quotaUsed`), durum (`ACTIVE`/`VOID`) |
| `OfferAllowanceUsage` | İzlenen kullanım; `listCreditCostSnapshot` = kullanım anındaki kategori kredisi |
| `ShowcasePlacement` | Paket ve vitrin kategorisi, yaşam döngüsü (`status`, `endAt`), `freeOfferCountSnapshot` |
| `ShowcaseLead` + `ServiceRequest` + round | Biten yayında cevap bekleyen talepler (kalan hakkın kullanılabilirliği) |
| `ShowcaseEntitlement` (+ PAID satın alma) | Satılmış, henüz yerleşmemiş haklar |
| `PackagePurchase` (OFFER_PACKAGE, PAID) | TL/kredi oranı: `Σ priceAmountSnapshot / Σ creditAmountSnapshot` |
| `OfferCreditPackage` (aktif, ONE_TIME_CREDITS) | Yalnız liste fiyatı referansı |

## Zaman ölçüleri

Aynı `from`/`to` penceresi (İstanbul günleri) dört farklı saate uygulanır ve yanıt bunu
`timeBases` ile söyler:

- **Kohort:** `OfferAllowanceGrant.validFrom` (yayın başlangıcı). Tanımlanan, kullanılan ve
  kalan haklar.
- **Kullanım:** `OfferAllowanceUsage.consumedAt`. Dönemde kullanım, kredi ve TL.
- **Yerleşmemiş:** `ShowcaseEntitlement.grantedAt`.
- **Değerleme:** kullanımın İstanbul ayı.

Kohortun "kullanılan" rakamı hakkın tüm kullanımlarını sayar (pencere dışında olsalar da);
dönem kullanımı ise yalnız penceredeki kullanımları. İkisi bilinçli olarak farklıdır.

## Hesaplama

Her hak tam olarak şöyle bölünür:
`defined = usedTracked + usedLegacy + remainingUsable + remainingUnusable`.

- **usedTracked:** usage satırı olan slotlar.
- **usedLegacy:** `quotaUsed − usage satırı`. Rollout'ta eski sınırsız kuralla sayılmış
  cevaplardır. Kategori snapshot'ları yok, bu yüzden kredi ve TL karşılığı hesaplanmaz.
- **remainingUsable:**
  - ACTIVE hak, yayın PENDING_ACTIVATION/ACTIVE (bitişten önce) ya da SUSPENDED ise kalanın
    tamamı;
  - yayın bittiyse sahibinin ücretsiz cevabını bekleyen her talep için en fazla bir slot.
    Talep OPEN/BREACHED olmalı, sahibine gate'li ve SUBMITTED/APPROVED durumunda olmalı,
    güncel round DIRECT_SHOWCASE olmalı. Bu, harcama yolunun kendi bağıdır. Bu ikinci parça
    `remainingUsableViaOpenLeads` olarak ayrıca verilir.
- **remainingUnusable:** geri kalan; VOID hakkın kalanının tamamı da buraya girer.
- **0 haklı yayın:** grant'siz doğar. `integrity.zeroAllowancePlacements` alanında beklenen
  durum olarak sayılır, eksik kayıt sayılmaz.
- **Yerleşmemiş haklar:** tanımlanan toplama eklenmez. Kategori filtresinde `null` döner,
  çünkü hakkın henüz kategorisi yoktur.

**Gösterge niteliğindeki TL karşılığı:**

- Her kullanım, kendi İstanbul ayındaki PAID tek seferlik kredi paketi satışlarının ağırlıklı
  kredi başı fiyatıyla değerlenir ve kuruşa bir kez yuvarlanır. Bu yüzden paket, kategori,
  işletme ve dönem kırılımları toplamla birebir tutar.
- O ay satış yoksa değer `N/A` olur (`indicativeValueMinor: null`). Geçmiş, güncel fiyatla
  yeniden değerlenmez.
- REFUNDED, PENDING ve TRY dışı satın almalar orana girmez.

**Liste fiyatı referansı:** bugünkü aktif paketlerin kredi başı min–max aralığıyla ayrı
gösterilir. Tahsilat ya da gelir kaybı değildir.

Tüm sorgular tek bir REPEATABLE READ anlık görüntüsünde okunur. Rapor çalışırken gelen bir
teklif, rakamların ya hepsinde ya hiçbirinde görünür.

## Filtreler ve sayfalama

- `packageId`, `providerId`, `categoryId`:
  - kohort kategorisi = yayının vitrin kategorisi;
  - kullanım kategorisi = `OfferAllowanceUsage.categoryId`.
- `groupBy`: `day` / `month` (varsayılan) / `year`. `day` için `from` zorunlu ve pencere en
  fazla 370 gün.
- `page` / `pageSize` (≤100) yalnız işletme kırılımını sayfalar. Sıralama tamdır:
  kullanılan kredi, tanımlanan, ad, id.

## Ops

`scripts/ops/showcase-allowance-002-report-consistency.sql` salt-okunur ve tek SELECT'tir.
API testleri her rapor senaryosundan sonra bu dosyayı koşar.

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/ops/showcase-allowance-002-report-consistency.sql
```

Slot muhasebesinin kendisi için `campaign-entitlement-001-consistency.sql` ve
`showcase-allowance-001-consistency.sql` geçerli kalır.
