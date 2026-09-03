# Teklif paketleri: aylık kota ve kategori limitsiz

Bu doküman, tek seferlik kredi paketlerinin yanına eklenen iki dönemsel ürünün
operasyonunu anlatır. Mevcut tek seferlik kredi akışı hiçbir noktada
değiştirilmedi; bu yapı onun **yanına** geldi.

## Ürün türleri

| Tür | Ne satar | Süre | Kredi bakiyesine etkisi |
| --- | --- | --- | --- |
| `ONE_TIME_CREDITS` | Kredi paketi (mevcut ürün) | Süresiz | Ödeme sonrası bakiyeye eklenir |
| `MONTHLY_QUOTA` | Dönem içinde harcanabilir kredi kotası | 30 gün | Yok — kota ayrı sayaçtan düşer |
| `CATEGORY_UNLIMITED` | Belirli kategori kapsamında sınırsız teklif | 30 gün | Yok |

### Dönem kuralı

- `startAt` = başarılı ödeme anı, `endAt` = `startAt + 30 × 24 saat`.
- **Takvim ayı kullanılmaz.** 27 Eylül 12:00'de alınan paket 27 Ekim 12:00'de biter;
  31 Ocak'ta alınan paket 2 Mart'ta biter.
- Kota devretmez. Yenilemede kalan kota **sıfırlanır**, üzerine eklenmez.
- Aynı paket dönem bitmeden tekrar alınırsa yeni dönem mevcut dönemin `endAt`
  anında başlar (boşluk da yok, üst üste binme de yok). Ödeme dönem bittikten
  sonra gerçekleşirse yeni dönem gerçek ödeme anında başlar.

## Veri modeli

Migration: `prisma/migrations/20260830140000_add_offer_package_entitlements`
(tamamen additive; hiçbir mevcut sütun düşürülmedi veya yeniden adlandırılmadı).

**Genişletilen tablolar**

- `OfferCreditPackage`: `type`, `quotaCredits`, `periodDays`, `dailyOfferLimit`.
  Tür bazlı geçerlilik bir DB CHECK ile zorlanır
  (`OfferCreditPackage_type_fields_check`).
- `ServiceCategory`: `unlimitedPackageEligible` (varsayılan `false`).
- `Offer`: `entitlementSource`, `entitlementId`. Mevcut teklifler migration'da
  `ONE_TIME_CREDIT` olarak backfill edildi.

**Yeni tablolar**

- `OfferPackageScopeCategory` — paket **tanımının** kategori kapsamı.
- `ProviderPackageEntitlement` — satın alınmış dönem. Fiyat, kota, günlük limit,
  paket adı ve dönem uzunluğu satın alma anında snapshot'lanır; paket sonradan
  değişse bile bu satır değişmez.
- `ProviderPackageEntitlementScope` — o döneme ait **dondurulmuş** kapsam.
  Seçilen düğümler (`selected = true`) ve satın alma anındaki alt kategorileri
  (`selected = false`) birlikte yazılır. Gruba sonradan eklenen kategori,
  satılmış dönemin kapsamını genişletmez.
- `PackageRenewalAttempt` — her yenileme denemesi.

**Çift tahsilat / çift hak koruması**

1. `ProviderPackageEntitlement.purchaseId` UNIQUE — bir ödeme en fazla bir dönem
   üretir.
2. `PackagePurchase.providerOrderId` ve `paymentReference` UNIQUE (mevcut) — bir
   sağlayıcı siparişi bir kez yerleşir.
3. Kısmi UNIQUE index `PackageRenewalAttempt_one_success_per_period`
   (`WHERE status = 'SUCCEEDED'`) — bir dönem en fazla bir kez satın alınabilir.
4. Yerleşim ve yenileme yazımları Serializable transaction içinde yapılır.

## Teklif verirken hak sırası

Tek merkezî çözümleyici: `apps/api/src/modules/entitlements/entitlement-resolver.service.ts`.

1. Kapsamı bu kategoriyi içeren **aktif limitsiz dönem**
2. Yeterli kotası olan **aktif aylık kota dönemi**
3. **Tek seferlik kredi bakiyesi** (mevcut davranış)
4. Hiçbiri yoksa mevcut `402 Yetersiz teklif kredisi.` yanıtı

Önemli davranışlar:

- Limitsiz paket **hiçbir kuralı esnetmez**: kategori durumu (`INACTIVE` → 409
  `CATEGORY_INACTIVE`), provider'ın kategoriye bağlı olması, hizmet alanı
  eşleşmesi, talep başına tek teklif kuralı ve spam kuralları aynen çalışır.
- Limitsiz paketin günlük teklif limiti dolduğunda istek **409
  `UNLIMITED_DAILY_LIMIT_REACHED`** ile reddedilir; sessizce krediye düşmez.
  Gün sınırı Europe/Istanbul gününe göre sayılır.
- Kota düşümü koşullu `UPDATE` ile atomiktir; paralel iki teklif aynı son
  krediyi harcayamaz.
- Teklif yaratımı başarısız olursa aynı transaction geri alınır — kota/kredi
  tüketilmez.

### İade kuralı

Ürün kuralı — kullanıcıya duyurulan tek iade vaadi: **teklif oluşturulduktan
sonraki 48 saat içinde yetkili müşteri tarafından hiç görüntülenmeyen teklifin
kredisi otomatik iade edilir** (`UNVIEWED_OFFER_48H`). Görüntülenmiş teklifte
kabul, red, süre dolumu veya geri çekme fark etmez — iade yoktur.
Görüntülenmemiş teklifte de teklifin durumu tek başına iadeyi engellemez.

Krediyi kapatan ikinci bir olay daha var ve ayrı bir alanda tutulur: **admin'in
müşteri adına kabul/red kararı** (`Offer.refundBlockedAt` +
`refundBlockedReason = ADMIN_CUSTOMER_DECISION`). Kredinin satın aldığı sonuç
admin panelinden de olsa teslim edilmiştir. Bu, sahte bir `viewedAt` yazılarak
değil kendi alanıyla kaydedilir — müşteri teklifi açmadı ve veritabanı bunu
doğru söylemeye devam etmeli. Admin'in yalnızca ekranı okuması ise hiçbir şeyi
değiştirmez.

Sağlayıcı ekranındaki metin bu ayrımı korur: görüntülenmede
`Görüntülendi — iade uygun değil`, admin kararında
`Müşteri kararı kaydedildi — iade uygun değil`.

Kural yalnız `Offer.unviewedRefundPolicy = true` olan teklifler için işler. Bu
kolon, kuralla birlikte deploy edilen teklif oluşturma yolunda yazılır; daha
önce gönderilmiş her teklif migration'ın `false` varsayılanını taşır ve kural
kapsamı dışındadır. Geçmişe dönük iade veya backfill yapılmaz.

Dönemsel paketle gönderilen teklifler için **hiçbir koşulda** teklif başına iade
yapılmaz (`PERIOD_PACKAGE_NOT_REFUNDABLE`). Dönemsel ürün teklif başına değil
dönem başına satılır; kota iadesi satın alınandan fazla kota yaratırdı. Otomatik
iade yalnızca tek seferlik kredi harcamalarını görür
(`creditSpentTransactionId IS NOT NULL` filtresi).

İdempotency veritabanı düzeyindedir: `ProviderCreditTransaction_one_refund_per_offer`
kısmi UNIQUE index'i aynı teklif için ikinci bir `OFFER_REFUND` satırını
imkânsız kılar.

### Manuel kredi iadesi (operasyon aracı)

`POST /offers/:id/refund-credit` yalnız SUPER_ADMIN'e açıktır ve otomatik
kuralın göremediği durumlar içindir (geçersiz talep, ulaşılamayan müşteri,
platform hatası). **Ürünün iade politikası değildir**: sağlayıcıya ve müşteriye
görünen hiçbir metinde yer almaz, vaat edilmez.

- Ledger sebebi `MANUAL_ADMIN_REFUND:<KOD>`; `UNVIEWED_OFFER_48H` yalnız
  otomatik worker'a aittir. Finans raporu politikanın maliyetini operasyonun
  kararından her zaman ayırabilir.
- Aynı transaction'da zorunlu `ManualOfferRefundAudit` satırı yazılır: işlemi
  yapan yönetici, zaman, teklif, kredi miktarı, operasyon gerekçesi ve not.
  `performedById` NOT NULL — imzasız bir iade oluşamaz.
- Operasyon gerekçesi admin yüzeylerinden dışarı çıkmaz; sağlayıcı yalnız
  `Kredi iade edildi` ve tarihi görür.
- Manuel ve otomatik iade hiçbir sırada çift kredi üretemez: ikisi de aynı
  koşullu `UPDATE`'ten geçer, ikisi de aynı kısmi UNIQUE index'e düşer, ve audit
  tablosunun `offerId` UNIQUE'i manuel yola özgü üçüncü bariyerdir.

## Otomatik yenileme — gerçek durum

**Bu build'de otomatik yenileme kullanılamaz ve açılamaz.**

Mevcut entegrasyon araştırıldı (`apps/api/src/modules/payments/`):

- Ödeme sağlayıcısı Lemon Squeezy ve yalnızca **sandbox** modunda
  (`PAYMENT_PROVIDER=lemon-squeezy-test`). `payment-provider.config.ts` canlı
  moda işaret eden her ortam değişkeninde **boot'u düşürür**; canlı mod bu
  build'de kapalı değil, hiç yok.
- Adaptör `POST /v1/checkouts` ile tek seferlik checkout açar. Lemon Squeezy
  merchant-of-record'dur: kartı kendisi tutar ve uygulamanın kendi inisiyatifiyle
  kayıtlı bir kartı çekmesine izin veren bir uç sunmaz. Oradaki tekrarlayan
  tahsilat, Lemon Squeezy'nin kendi takviminde faturaladığı **subscription
  variant** özelliğidir — farklı ürün konfigürasyonu, farklı checkout ve bu
  build'in kabul ettiği `order_created` yerine `subscription_payment_success`
  ailesinden webhook'lar gerektirir.
- Uygulama hiçbir yerde kart numarası, CVC veya ham ödeme verisi saklamaz.
  `ProviderPackageEntitlement.paymentMethodReference` sütunu vardır ama bu
  build'de **her zaman NULL**'dur.

Sonuç olarak:

- `PaymentProviderPort.capabilities.automaticRenewal` her iki adaptörde de
  `false` (`mock` → `NO_STORED_PAYMENT_METHOD`, `lemon-squeezy-test` →
  `NO_LIVE_MODE`).
- Otomatik yenilemeyi açma isteği **409 `AUTO_RENEW_UNSUPPORTED`** ile reddedilir.
- Provider ekranında devre dışı bir anahtar veya "yakında" ifadesi **yoktur**;
  yerine durumun neden böyle olduğunu söyleyen bir cümle ve çalışan **elle
  yenileme** akışı vardır (aynı paketi tekrar satın alma; dönem mevcut dönemin
  sonundan başlar).
- Provider açıkça ve ayrı bir aksiyonla onay vermeden otomatik yenileme asla
  aktif olmaz: satın alma yolunda `autoRenewEnabled`'ı `true` yapan hiçbir kod
  yolu yoktur.

### Yenileme motoru (ileriye dönük)

Yetenek kazanan bir adaptör geldiğinde çalışacak akış hazırdır ve testlidir:

- Dönem bitiminde `EntitlementRenewalService.runDueRenewals()` çalışır.
- Otomatik yenileme kapalıysa dönem sadece `EXPIRED` olur, deneme kaydı yazılmaz.
- Tahsilat yapılamıyorsa `PackageRenewalAttempt` (`UNSUPPORTED`/`FAILED` + güvenli
  hata kodu) yazılır ve dönem `PAST_DUE` olur. **`endAt` asla uzatılmaz.**
- Başarılı tahsilatta `periodIndex` artar, yeni dönem `max(önceki endAt, ödeme
  anı)` ile başlar, kota snapshot'tan **sıfırlanır**.
- İdempotency anahtarı `<entitlementId>:<periodIndex>` olarak sağlayıcıya
  gönderilir; ayrıca 10 dakikalık claim lease + kısmi UNIQUE index vardır.

Scheduler varsayılan olarak **kapalıdır**:

```bash
ENTITLEMENT_RENEWAL_SCHEDULER_ENABLED=true
ENTITLEMENT_RENEWAL_CRON="*/15 * * * *"   # opsiyonel, varsayılan */15
```

Doğruluk buna bağlı değildir: her okuyucu `endAt`'ı kendisi kontrol eder, yani
scheduler hiç çalışmasa bile bir gün fazla erişim verilmez.

## Güvenlik ve sızıntı sınırları

- `GET /credit-packages` (anonim erişime açık, mevcut uç) **yalnızca**
  `ONE_TIME_CREDITS` döndürür ve alan listesi sabitlenmiştir; yeni sütunlar
  buraya sızmaz.
- Dönemsel paket kataloğu `GET /providers/:providerId/offer-packages`,
  entitlement listesi `GET /providers/:providerId/entitlements` — ikisi de
  `AuthGuard + ProviderAccessGuard` arkasında. CUSTOMER, anonim ve başka provider
  401/403 alır.
- Otomatik yenileme değiştirme ve iptal uçları ek olarak **yalnızca provider
  hesabının kendisine** açıktır (admin okur, değiştiremez).
- Admin paket yönetimi uçları (`/admin/offer-packages*`) `SUPER_ADMIN` ister.
- Hiçbir yanıt `paymentMethodReference` taşımaz. Admin görünümü yalnızca
  `paymentMethodOnFile: boolean` ve sağlayıcının opak işlem referansını gösterir.
- Ödeme sağlayıcısı hata gövdesi hiçbir yere yazılmaz; yalnızca kapalı kümeden
  kısa kodlar saklanır.
- Public kategori yanıtlarından `unlimitedPackageEligible` çıkarılır.
- Webhook doğrulaması değişmedi: imza doğrulanmadan hiçbir yazma yapılmaz ve
  gerçek ödeme durumunu değiştiren yeni bir webhook uç eklenmedi.

## Admin operasyonu

### 1. Kategoriyi limitsiz paket kapsamına uygun hale getirme

Kategori yönetimi → kategori detayı → **"Limitsiz paket uygunluğu"**.

Varsayılan **kapalıdır** ve her yeni/ithal edilen kategori kapalı doğar. Regüle
veya yüksek değerli kategoriler böylece bir liste bakımı gerektirmeden dışarıda
kalır. `INACTIVE` kategorilerde kutucuk devre dışıdır.

### 2. Paket tanımlama

Kredi Paketleri → **Yeni**:

- **Paket türü** seçilir (sonradan değiştirilemez).
- `MONTHLY_QUOTA` için **Aylık kota (kredi)** zorunludur.
- `CATEGORY_UNLIMITED` için **kapsam** zorunludur ve yalnızca yukarıda uygun
  işaretlenmiş kategoriler listelenir. **Günlük teklif limiti** 0 ise sınır yoktur.
- Süre alanı yoktur; dönemsel paketlerde 30 gün sunucu tarafından yazılır.

Paket fiyatını/kapsamını değiştirmek **yalnızca sonraki satın almaları** etkiler.

### 3. Provider aboneliğini görme

Hizmet Verenler → provider → **Krediler** → "Dönemsel paketler" bölümü: aktif ve
geçmiş dönemler, kalan kota / kapsam, otomatik yenileme durumu, son yenileme
denemesi ve sağlayıcının güvenli işlem referansı.

### 4. Lemon Squeezy variant eşlemesi

Dönemsel paketler de aynı checkout hattını kullanır, yani sandbox'ta satın
alınabilmeleri için slug'larının `LEMON_SQUEEZY_VARIANT_MAP` içinde bir variant'a
eşlenmesi gerekir. Eşlenmemiş paket `PACKAGE_NOT_MAPPED` ile reddedilir ve satın
alma `FAILED` olur.

## Prod'a geçiş adımları

1. `pnpm db:migrate` (veya `prisma migrate deploy`) ile
   `20260830140000_add_offer_package_entitlements` uygulanır. Migration additive
   ve backfill'li; downtime gerektirmez.
2. Kategori yönetiminden limitsiz paket kapsamına açılacak kategoriler
   işaretlenir. **Hiçbir kategori otomatik açılmaz.**
3. Paketler admin ekranından tanımlanır (bu repoda paket seed'i yoktur ve
   çalıştırılmamıştır).
4. Lemon Squeezy tarafında her yeni paket slug'ı için variant açılır ve
   `LEMON_SQUEEZY_VARIANT_MAP` güncellenir.
5. Yenileme scheduler'ı isteğe bağlı olarak
   `ENTITLEMENT_RENEWAL_SCHEDULER_ENABLED=true` ile açılır. Bu build'de her dönem
   sonunda `UNSUPPORTED` deneme kaydı yazıp dönemi `PAST_DUE` yapacaktır; bu
   davranış istenmiyorsa kapalı bırakılır ve dönemler `EXPIRED` olarak süzülür.
6. Otomatik yenilemenin gerçekten çalışması için önce ödeme sağlayıcısı tarafında
   canlı mod + tekrarlayan tahsilat yeteneği açılmalı, sonra adaptöre
   `chargeStoredPaymentMethod` implementasyonu ve `capabilities.automaticRenewal
   = true` eklenmelidir. Bu iki adım yapılmadan hiçbir ekran otomatik yenilemeyi
   açık göstermez.

## Testler

- `apps/api/test/offer-package-entitlements.spec.ts` — 30 gün aritmetiği, hak
  önceliği, kota tüketimi ve paralel tüketim, kapsam içi/dışı, kapsam
  dondurulması, INACTIVE kategori, günlük limit.
- `apps/api/test/offer-package-settlement.spec.ts` — webhook ile dönem verilmesi,
  grup genişletmesi, snapshot değişmezliği, tekrarlı/yarışan webhook
  idempotency'si, imzasız/ödenmemiş olayda hak verilmemesi, elle yenileme
  zincirlemesi, kapsam çakışması, mock ödeme yolu.
- `apps/api/test/offer-package-renewal.spec.ts` — yenileme başarılı/başarısız/
  desteklenmiyor, başarısız ödemede erişimin uzamaması, çift tahsilat koruması,
  otomatik yenilemenin açılamaması, iptal sonrası dönem sonuna kadar kullanım.
- `apps/api/test/offer-package-access.spec.ts` — rol matrisi, public sızıntı,
  admin paket yönetimi ve kapsam doğrulaması, fiyat/kapsam snapshot değişmezliği.
- `e2e/tests/offer-packages.spec.ts` — kota ile teklif ve kotanın düşmesi,
  kapsam içi/dışı kredi davranışı, otomatik yenileme mesajı ve iptal, müşteri/
  public sızıntısı, admin görünürlüğü.
