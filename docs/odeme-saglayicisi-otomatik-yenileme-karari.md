# Otomatik yenileme için ödeme sağlayıcısı kararı

**Durum:** Karar önerisi — ticari teyit bekliyor
**Kapsam:** Taktic teklif paketlerinin (MONTHLY_QUOTA, CATEGORY_UNLIMITED) 30 günlük
dönemlerinin açık rıza ile otomatik yenilenmesi
**Bu çalışmada kod, şema, migration, runtime, compose, .env veya ödeme ayarı
değiştirilmedi.** Yalnız bu iki artefakt yazıldı.

---

## 1. Yönetici özeti

**Öneri: iyzico.**

Tek cümleyle: Taktic'in ihtiyacı bir SaaS abonelik ürünü değil, *kendi belirlediği
anda, kendi belirlediği tutarda, kart sahibi orada değilken tahsilat yapabilme*
yeteneğidir. Bu yeteneği Türkiye'de resmî dokümantasyonla doğrulanabilir biçimde,
üye işyerini ham kart verisine bulaştırmadan sunan tek aday iyzico'dur.

Belirleyici üç bulgu:

1. **iyzico saklı kartla NON3D tahsilatı belgeliyor.** Kart saklandıktan sonra dönen
   `cardUserKey` + `cardToken` ile, kart sahibini bankaya yönlendirmeden, bizim
   seçtiğimiz anda ödeme isteği gönderilebiliyor.
   ([kaynak](https://docs.iyzico.com/on-hazirliklar/api-reference-beta/kart-saklama))
   Abonelik ürünü **zorunlu değil** — yani 30 günlük dönemi iyzico'nun takvimine
   teslim etmek zorunda kalmıyoruz.
2. **PayTR aynı tahsilat yeteneğine sahip ama kart kaydını üye işyerinin kendi
   formundan istiyor.** "Yeni Kart Ekleme" akışında `card_number`, `cvv`,
   `expiry_month/year` alanları üye işyerinin sayfasından POST ediliyor.
   ([kaynak](https://dev.paytr.com/en/direkt-api/kart-saklama-api/yeni-kart-ekleme))
   Bu, Taktic'in "kart numarası, CVC veya ham ödeme verisi uygulamaya girmeyecek"
   kısıtını doğrudan ihlal eder ve PCI DSS kapsamını SAQ A'dan SAQ D'ye taşır.
   Tahsilat tarafı iyi, kayıt tarafı kabul edilemez.
3. **Lemon Squeezy bu iş için yapısal olarak uygun değil** (bkz. §2) ve zaten bu
   build'de canlı mod boot seviyesinde reddediliyor.

**Karar cümlesi:**
Manuel yenilemeli paketi **şimdi ship ediyoruz** (kod hazır, testli, `automaticRenewal`
dürüstçe `false`). Otomatik yenilemeyi **iyzico ile, Faz 2'de**, ve ancak §8'deki üç
açık sorunun yazılı cevabı alındıktan sonra açıyoruz.

---

## 2. Neden Lemon Squeezy değil

Dört bağımsız gerekçe; her biri tek başına yeterli.

| # | Gerekçe | Kaynak |
| --- | --- | --- |
| 1 | **Tahsilat takvimi bizde değil.** Tekrarlayan tahsilat, variant üzerinde tanımlı abonelik aralığına bağlıdır ve Lemon Squeezy kendi takviminde faturalar. "Ödeme başarılı olunca 30 gün uzat" kuralımızı sağlayıcının ay takvimine devretmek zorunda kalırız. | [Subscriptions](https://docs.lemonsqueezy.com/help/products/subscriptions) |
| 2 | **Saklı kartı kendi inisiyatifimizle çekebileceğimiz bir API yok.** Merchant of record modelinde kartı LS tutar; üye işyerine tahsilat için kullanılabilir bir token verilmez. Abonelik API'si plan değiştirme/iptal/duraklatma sunar, "şu kartı şimdi çek" sunmaz. | [Managing subscriptions](https://docs.lemonsqueezy.com/guides/developer-guide/managing-subscriptions) |
| 3 | **Bu build'de canlı mod yok ve olamaz.** `payment-provider.config.ts` canlı moda işaret eden her ortam değişkeninde süreci boot'ta düşürür; sandbox'ta "başarılı yenileme" hiç gerçekleşmemiş bir paraya karşılık 30 gün vermek olurdu. | `apps/api/src/modules/payments/payment-provider.config.ts` |
| 4 | **Türkiye operasyonu yok.** TL tahsilat, yerel kart taksitlendirme ve yerel ihtilaf süreci bulunmuyor; 1 milyon TL/ay hedefi için yerel bir ödeme kuruluşu gerekiyor. | mevcut entegrasyon + [pricing](https://www.lemonsqueezy.com/pricing) |

Mevcut kodda `LemonSqueezyCheckoutAdapter.capabilities.automaticRenewal = false` ve
gerekçesi `NO_LIVE_MODE`. Bu bulgular o karara uyuyor; değiştirilecek bir şey yok.

---

## 3. Sağlayıcı karşılaştırma tablosu

Satır bazlı kaynaklı tam tablo: `docs/odeme-saglayicisi-karsilastirma.csv`.
Özet:

| Kriter | iyzico | PayTR | Craftgate | Lemon Squeezy |
| --- | --- | --- | --- | --- |
| Kart saklama / token | ✅ `cardUserKey` + `cardToken` | ✅ `utoken` + `ctoken` | ⚠️ doğrulanamadı | ❌ (bize token yok) |
| Kendi 30 günlük döngümüzle tahsilat | ✅ | ✅ | ⚠️ | ❌ |
| Abonelik ürünü zorunlu mu | ❌ (opsiyonel) | ❌ | ⚠️ | ✅ (zorunlu) |
| Sonraki tahsilatlar NON3D | ✅ | ✅ | ⚠️ | sağlayıcı yönetir |
| Ham kart verisi uygulamaya girmez | ⚠️ **açık soru** (§8.1) | ❌ **girer** | ⚠️ | ✅ |
| Webhook imza doğrulama | ✅ HMAC-SHA256, `X-IYZ-SIGNATURE-V3` | ✅ HMAC-SHA256 + base64 | ⚠️ | ✅ (uygulanmış) |
| Belgelenmiş idempotency | ⚠️ yalnız `conversationId` | ✅ `merchant_oid` + mükerrer bildirim uyarısı | ⚠️ | ✅ (uygulamada) |
| Türkiye operasyonu | ✅ | ✅ | ✅ | ❌ |
| Yayınlanmış komisyon | %4,29 + 0,25 TL (kurumsal teklif %3,99 + 0,25 TL) | QUOTE_REQUIRED | QUOTE_REQUIRED | yayınlanmış |

⚠️ **Craftgate hakkında dürüst not:** Craftgate'in geliştirici portalı oturum duvarı
arkasında olduğu için resmî dokümantasyonundan tek bir teknik iddia doğrulayamadım.
Bu çalışmanın kaynak kuralı gereği (blog/forum/karşılaştırma sitesi kaynak değildir)
Craftgate **değerlendirilemedi** olarak işaretlendi, "yetersiz" olarak değil. Sandbox
hesabı açıldığında 2 saatlik bir teyit turuyla tabloya girebilir.

**Stripe neden yok:** Türkiye'de yerleşik bir işletme için ödeme kabulü desteklenen
ülkeler listesinde bulunmuyor; TL tahsilat ve yerel taksit gerektiren bu iş için
aday değil.

---

## 4. Önerilen ödeme ve abonelik akışı

Tasarım ilkesi: **iyzico'nun Abonelik ürününü kullanmıyoruz.** Onu kullanmak,
30 günlük dönem sahipliğini iyzico'nun ödeme planına devretmek olurdu; oysa bizim
entitlement modelimizde dönem, `ProviderPackageEntitlement.startAt/endAt` ile
uygulamaya ait. Bunun yerine **saklı kart + kendi zamanlayıcımız** kullanıyoruz.
Bu, mevcut `EntitlementRenewalService` iskeletiyle birebir örtüşüyor.

### 4.1 Kayıt (ilk ödeme, kart sahibi ekranda)

1. Provider paket satın alır → mevcut `PackagePurchase` açılır (değişiklik yok).
2. Ödeme, **iyzico'nun barındırdığı ödeme yüzeyinde** 3DS ile tamamlanır. Kart
   verisi Taktic sunucusuna hiç uğramaz.
3. Provider **ayrı ve açık bir onay kutusu** ile "bu kartı sakla ve dönem sonunda
   otomatik yenile" der. Onay verilmezse kart saklanmaz.
4. iyzico `cardUserKey` + `cardToken` döner. Bunlar
   `ProviderPackageEntitlement.paymentMethodReference` alanına yazılır — sütun zaten
   var ve "asla kart verisi değil, yalnız sağlayıcı referansı" diye belgelenmiş
   durumda.
5. Webhook doğrulandıktan sonra entitlement açılır: `startAt` = ödeme anı,
   `endAt` = +30 gün. **Bu kural değişmiyor.**

### 4.2 Yenileme (dönem sonu, kart sahibi yok)

`EntitlementRenewalService.runDueRenewals()` — bugün yazılı ve testli olan akış:

1. `endAt <= now` olan ACTIVE dönemler taranır.
2. `autoRenewEnabled = false` ise dönem sadece `EXPIRED` olur; deneme kaydı yazılmaz.
3. Açıksa dönem *claim* edilir (10 dk lease), sonra
   `chargeStoredPaymentMethod` çağrılır → iyzico saklı kart NON3D ödeme isteği.
4. Başarılıysa: `PackageRenewalAttempt(SUCCEEDED)` + `periodIndex++`,
   `startAt = max(önceki endAt, gerçek ödeme anı)`, `endAt = +30 gün`, kota
   snapshot'tan **sıfırlanır**.
5. Başarısızsa: `PackageRenewalAttempt(FAILED, güvenli hata kodu)`, dönem `PAST_DUE`.
   **`endAt`e dokunulmaz.**

Yani seçilen sağlayıcı `PaymentProviderPort`u gerçekten `automaticRenewal = true`
yapabiliyor; port modeli korunuyor, tek eklenecek şey `IyzicoPaymentAdapter`.

### 4.3 Neden iyzico Abonelik ürünü değil

| | Saklı kart + kendi zamanlayıcımız (önerilen) | iyzico Abonelik ürünü |
| --- | --- | --- |
| Dönem sahibi | Taktic (`endAt`) | iyzico ödeme planı |
| 30 gün kuralı | Birebir | Ay takvimine kayar (28–31 gün) |
| Kapsam snapshot'ı | Bizde | İlgisiz |
| Ödeme olmadan uzama riski | Yok (biz uzatıyoruz) | Plan/webhook senkron sorunu riski |
| Kart doğrulama | İlk gerçek ödeme | 1 TL çekim + iade ([kaynak](https://docs.iyzico.com/urunler/abonelik/abonelik-entegrasyonu/abonelik-islemleri)) |

---

## 5. Güvenlik ve hukuki kontroller

**Teknik**

- Ham kart verisi (PAN, CVC, son kullanma) Taktic sunucusuna, loglarına veya
  veritabanına **hiçbir koşulda** girmez. Bu kısıt, PayTR'yi eleyen kısıttır ve
  iyzico entegrasyonunun kabul kriteridir (§8.1 kapanmadan Faz 2 başlamaz).
- Saklanan tek şey `cardUserKey`/`cardToken` — opak sağlayıcı referansı. Şemada
  `paymentMethodReference` olarak zaten mevcut ve hiçbir API yanıtında dönmüyor;
  admin görünümü yalnız `paymentMethodOnFile: boolean` gösteriyor.
- Webhook imzası HMAC-SHA256 ile doğrulanır (`X-IYZ-SIGNATURE-V3`); imza
  doğrulanmadan **hiçbir yazma** yapılmaz. Bu, mevcut
  `payments-webhook.service.ts` mimarisiyle birebir aynı — yeniden tasarım yok.
- Sağlayıcı hata gövdesi hiçbir yere yazılmaz; yalnız kapalı kümeden kısa kodlar
  (`EntitlementRenewalFailureCode`) saklanır.

**Mevzuat**

- **Güçlü kimlik doğrulama (3DS):** Ödeme Hizmetleri ve Elektronik Para İhracı ile
  Ödeme Hizmeti Sağlayıcıları Hakkında Yönetmelik, elektronik kanaldan yapılan
  işlemlerde güçlü kimlik doğrulamayı kural, düzenli ödeme benzeri hâlleri istisna
  olarak düzenler.
  ([mevzuat.gov.tr](https://www.mevzuat.gov.tr/MevzuatMetin/yonetmelik/7.5.39080.pdf))
  Uygulama sonucu: **ilk ödeme 3DS**, sonraki yenilemeler NON3D. İstisnanın
  dayanağı, kayıt anında alınan açık rızadır — bu yüzden rıza kaydı hukuki bir
  gereklilik, ürün tercihi değil.
- **Ödeme kuruluşu lisansı:** Taktic bu akışta *kendi* yazılım kullanım bedelini
  tahsil ediyor; müşteri→hizmet veren arasında para taşımıyor. Bu hâliyle 6493
  sayılı Kanun kapsamında ödeme hizmeti sunumu yoktur. **Uyarı:** ileride müşteri
  ödemesini hizmet veren adına tahsil etme fikri gündeme gelirse bu tablo değişir
  ve lisans/aracılık analizi baştan yapılmalıdır.
- **Rıza kaydı:** `autoRenewConsentAt` bugün yazılıyor ve kapatınca temizleniyor.
  Faz 2'de bunun yanına rıza metninin sürümü ve IP/zaman damgası eklenmelidir.
- **Tüketici mevzuatı:** Alıcılar ticari faaliyet yürüten hizmet verenler olduğu
  için 6502 sayılı Kanun'un tüketici hükümleri kural olarak uygulanmaz. Şahıs
  işletmeleri için hukuk ekibinden tek sayfalık görüş alınmalı; ürün kararı buna
  bağlı değil ama sözleşme metni bağlı.
- **Faturalama:** Her başarılı yenileme için e-arşiv/e-fatura kesilmesi gerekir.
  Yenileme motoru bugün fatura tetiklemiyor — Faz 2 kapsamına alınmalı.

---

## 6. Başarısız ödeme / iptal / webhook / idempotency davranışı

Bu bölümdeki kuralların tamamı **bugün kodda uygulanmış ve testlidir**; sağlayıcı
değişikliği bunları değiştirmez.

**Başarısız ödeme**
- Erişim **uzamaz**: `endAt` güncelleme setinde yer almaz.
- Dönem `PAST_DUE` olur, `lastRenewalFailureCode` yazılır.
- Provider ekranı nötr bir cümle görür; kart bilgisi veya sağlayıcı hata gövdesi
  sızmaz.
- Dönem bittiği an entitlement resolver sıradaki hakka düşer: varsa başka bir
  dönem, yoksa **mevcut tek seferlik kredi bakiyesi**, o da yoksa mevcut 402.
- *Faz 2 eklentisi:* dönem sonundan önce 3/1 gün kala hatırlatma ve başarısızlık
  sonrası sınırlı yeniden deneme takvimi (iyzico'nun retry servisi 160 güne kadar
  yeniden deneme sunuyor — biz kendi takvimimizi kullanacağız).

**İptal**
- İptal = *sonraki tahsilatın* iptali. `endAt` değişmez, statü `ACTIVE` kalır.
- Provider ödediği 30 günü sonuna kadar kullanır. E2E testi bunu sabitliyor.

**Webhook**
- İmza doğrulanmadan hiçbir yazma yok; imzasız istek 401 ve sıfır DB yazımı.
- Her olay için tek satır (`PaymentWebhookEvent`), yalnız `PROCESSED` terminal.
- PayTR seçilseydi ek olarak "düz metin OK dön, aksi hâlde 1 dk sonra tekrar
  denenir" kuralı gerekirdi
  ([kaynak](https://dev.paytr.com/en/iframe-api/iframe-api-2-adim)); iyzico'da
  bu davranış farklı, adaptör yazılırken teyit edilecek.

**Idempotency**
- `PackagePurchase.providerOrderId` ve `paymentReference` UNIQUE.
- `ProviderPackageEntitlement.purchaseId` UNIQUE → bir ödeme en fazla bir dönem.
- Kısmi UNIQUE index `PackageRenewalAttempt_one_success_per_period`
  (`WHERE status='SUCCEEDED'`) → bir dönem en fazla bir kez satın alınır.
- 10 dakikalık claim lease + scheduler'ın kendi `isRunning` koruması.
- Sağlayıcıya `<entitlementId>:<periodIndex>` idempotency anahtarı gönderilir.
  **Uyarı:** iyzico'nun `conversationId`'si resmî olarak idempotency anahtarı
  değil, istek/yanıt eşleştirme alanıdır. Yani çift tahsilat koruması bizim
  tarafımızda kalmaya devam eder — bu, adaptör yazılırken gevşetilmemesi gereken
  bir varsayım.

---

## 7. Uygulama fazları

**Faz 0 — Ticari ve hukuki kapı (kod yok, 1–2 hafta)**
- iyzico ile kurumsal görüşme; §8'deki üç sorunun **yazılı** cevabı.
- Komisyon teklifi (hedef: 1 M TL/ay hacimde %3,99 + 0,25 TL'nin altı).
- Kart Saklama eklentisinin hesapta aktifleştirilmesi (liste fiyatı 99 TL).
- Hukuktan rıza metni + sözleşme onayı.
- **Çıkış kriteri:** üçü de olumlu. Değilse Craftgate sandbox'ı açılıp §3'teki
  boşluk kapatılır ve karar tekrar değerlendirilir.

**Faz 1 — Manuel yenilemeli ship (BUGÜN HAZIR)**
- Mevcut kod: paketler satılıyor, dönem 30 gün, kota düşüyor, kapsam çalışıyor,
  otomatik yenileme dürüstçe kapalı ve nedeni ekranda yazıyor.
- Ek iş yok. Yalnız Lemon Squeezy variant eşlemesi ve paket tanımları.

**Faz 2 — iyzico adaptörü + otomatik yenileme (Faz 0 geçerse)**
- `IyzicoPaymentAdapter implements PaymentProviderPort`:
  `createCheckoutSession`, `chargeStoredPaymentMethod`,
  `capabilities.automaticRenewal = true`.
- Webhook doğrulayıcı: `X-IYZ-SIGNATURE-V3`, HMAC-SHA256/HEX.
- Kayıt akışına ayrı rıza kutusu + rıza sürümü/zaman damgası.
- `ENTITLEMENT_RENEWAL_SCHEDULER_ENABLED=true`.
- Yenileme hatırlatma e-postaları ve fatura tetikleme.
- **Not:** `EntitlementRenewalService`, `PackageRenewalAttempt`, kısmi UNIQUE
  index ve claim lease bugün yazılı ve testli. Faz 2'nin işi motoru yazmak değil,
  motora gerçek bir tahsilat bağlamak.

**Faz 3 — Operasyonel olgunluk**
- Kart güncelleme akışı (kartı değiştir / süresi dolan kart uyarısı).
- Başarısız tahsilat için kademeli yeniden deneme.
- Çoklu sağlayıcı yedekliliği gerekirse Craftgate orkestrasyonu yeniden değerlendirilir.

---

## 8. Açık belirsizlikler ve alınması gereken ticari teklifler

**8.1 — KRİTİK: Kart, iyzico'nun barındırdığı yüzeyde saklanabiliyor mu?**
Kart saklama dokümanı, kart alanlarının iyzico'ya gönderildiği bir akış gösteriyor.
Checkout Form başlatma şemasında ise `registerCard` benzeri bir parametre
belgelenmemiş
([CF başlatma](https://docs.iyzico.com/odeme-metotlari/odeme-formu/cf-entegrasyonu/cf-baslatma)).
Sorulacak soru: *"Checkout Form / 3DS akışında, üye işyeri sunucusu PAN ve CVC'yi
hiç görmeden kart saklanabilir ve `cardUserKey`/`cardToken` dönebilir mi?"*
**Cevap hayırsa iyzico önerisi düşer** ve karar Craftgate teyidine kayar.
Bu, Taktic'in kart verisi kısıtının pazarlık konusu olmadığı anlamına gelir.

**8.2 — MIT / tekrarlayan işlem bayrağı ve NON3D uygunluğu**
Saklı kartla NON3D tahsilat, bizim MCC'miz ve iş modelimiz için hesap bazında
açılıyor mu? Kart şemalarının "merchant initiated transaction" işaretlemesi
destekleniyor mu? İhtilaf (chargeback) sorumluluğu kimde?

**8.3 — Komisyon teklifi (QUOTE_REQUIRED)**
Yayınlanmış oran %4,29 + 0,25 TL, kurumsal teklif %3,99 + 0,25 TL
([kaynak](https://www.iyzico.com/destek/yardim-merkezi/genel-bilgiler/fiyatlandirma)).
1 M TL/ay hacimde bu, kabaca **~40.000 TL/ay komisyon** demektir (işlem başı sabit
ücret hariç; 1.000 TL ortalama işlemde ~250 TL daha). Hacim taahhüdüyle indirim
istenmeli. PayTR ve Craftgate oranları yayınlanmadığı için **QUOTE_REQUIRED** —
yine de kıyas teklifi alınmalı; iyzico teklifini iyileştiren tek kaldıraç budur.

**8.4 — Idempotency garantisi**
iyzico tarafında aynı `conversationId` ile gönderilen ikinci ödeme isteği reddediliyor
mu, yoksa ikinci kez mi çekiyor? Yazılı cevap gelene kadar uygulama tarafındaki üç
katmanlı koruma (lease + UNIQUE index + partial index) gevşetilmeyecek.

**8.5 — Craftgate boşluğu**
Geliştirici portalı oturum arkasında olduğu için bu turda değerlendirilemedi.
Sandbox hesabı açılırsa kart saklama, saklı kartla ödeme, webhook imzası ve
idempotency başlıkları 2 saatlik bir turla doğrulanabilir.

---

## 9. Karar

> **Manuel yenilemeli paket bugün ship edilir. Otomatik yenileme iyzico ile,
> Faz 2'de, §8.1 ve §8.2'nin yazılı cevabı alındıktan sonra açılır.**

**Gerekçe**

- *Teknik uygunluk:* iyzico, 30 günlük dönemi bize bırakan tek doğrulanmış aday.
  Abonelik ürünü zorunlu değil; `PaymentProviderPort` gerçekten
  `automaticRenewal = true` olabilir. PayTR aynı tahsilatı yapıyor ama kart kaydı
  için ham PAN/CVC istiyor — bu bir tercih değil, kırmızı çizgi ihlali.
- *Maliyet:* 1 M TL/ay hacimde komisyon farkı yılda yüz binlerce TL'ye ulaşır;
  bu yüzden Faz 0'da teklif almadan entegrasyona başlanmaz. Faz 1'i beklemeye
  almanın maliyeti ise sıfır — manuel yenileme zaten çalışıyor.
- *Türkiye operasyonu:* TL tahsilat, yerel taksit, yerel ihtilaf süreci ve
  lisanslı ödeme kuruluşu olması; Lemon Squeezy'nin hiçbirini sağlamadığı alan.
- *Risk:* Bugünkü kod otomatik yenilemeyi sahte biçimde tamamlanmış göstermiyor;
  provider ekranda "kullanılamıyor" cümlesini ve çalışan bir elle yenileme yolunu
  görüyor. Yani otomatik yenilemeyi ertelemenin ürün maliyeti bir gecikmeden
  ibaret, bir yalan değil. Aceleyle PayTR'ye geçmenin maliyeti ise kalıcı bir PCI
  yükümlülüğü olurdu.

---

## Ek: bu çalışma sırasında çalıştırılan doğrulamalar

| Komut | Sonuç |
| --- | --- |
| `pnpm lint` | ✅ 4/4 paket başarılı (exit 0) |
| `pnpm build` | ✅ 3/3 paket başarılı (exit 0) |

Kod değiştirilmedi.
