# CMP-006 PR-A — Paket iade politikası çekirdeği ve checkout sözleşme kabul kanıtı

Tarih: 2026-09-22 · Taban: `origin/main` @ `0af98870` (PR #105, PR-0 RBAC merge) ·
Branch: `claude/cmp-006-package-refund-terms-1fc629` · Üst tasarım:
[`2026-09-22-cmp-006-s0-refund-rbac-fraud-channel-design.md`](2026-09-22-cmp-006-s0-refund-rbac-fraud-channel-design.md)
(D0, D1, D8, D8a, D9, D10, §3.2, §4, §5, §13) · Migration: **I** `20260922210000_add_purchase_terms_acceptance`

**Kampanya motoru anahtarı bu PR'da okunmadı, yazılmadı, açılmadı.** Gerçek `.env`, Lemon, staging/yerel
checkout ve yerel/staging veri bu PR'da değişmedi.

---

## 0. Kapsam

| Var | Yok (kasıtlı) |
| --- | --- |
| Tek kanonik, saf paket iade uygunluk değerlendirmesi + tek-sorgu okuyucu | Sağlayıcının destekten iade talebi açması |
| `PurchaseTermsAcceptance` + `PackagePurchase.purchaseTermsAcceptanceId` / `termsAcceptanceRequired` | `PackageRefundRequest`, durum makinesi, maker-checker |
| DB + işlem sınırında kabul zorunluluğu (kapı açıkken) | Lemon API refund çağrısı, `PaymentProviderPort` değişikliği |
| Sürümlü belge seti + snapshot + SHA-256 altyapısı (taslak metin) | `order_refunded` webhook'u / S3 revoke davranışı değişikliği |
| Varsayılan kapalı, fail-closed release gate (`PURCHASE_TERMS_GATE`) | Kredi clawback, fraud uygunluğu, işletme kaydı, kampanya kanalı |
| Web checkout'ta ayrı, boş, zorunlu onay kutusu (yalnız kapı açıkken) | `/sozlesmeler/*` sayfalarının yayını (RG-1'e kadar) |
| `readRequestMeta` (IP/UA/kanal tek okuyucu) | Admin kanıt okuma yüzeyi / `PURCHASE_EVIDENCE_READ` izni (rotası yok) |

## 1. Ad alanı (D0)

Bu depoda `refund-policy` **teklif kredisi** iadesidir (`offers/refund-policy.ts`, `GET /refund-policy`,
`OfferRefundSettlement`, `ManualOfferRefundAudit`). Bu PR'ın hiçbir satırı onlara dokunmaz. Yeni kod:

- `apps/api/src/modules/package-refunds/` — `PackageRefundEligibilityService`, `evaluatePackageRefundEligibility`,
  `PackageRefund*` tipleri, `PackageRefundsModule`.
- `apps/api/src/modules/purchase-terms/` — kabul kanıtı ve release gate (`PurchaseTerms*`; kullanıcının istediği
  model adı). Para iadesiyle ilgili hiçbir şey burada değildir; yalnız satın alma anındaki sözleşme kanıtıdır.

## 2. Paket iade uygunluğu (D1a–c, §3.2)

### 2.1 Saf fonksiyon

`evaluatePackageRefundEligibility(facts, now)` yalnız argümanlarını okur; saat bir **girdidir**. Aynı olgular ve
aynı an her zaman aynı sonucu, aynı sırada verir.

| Sıra | Kural | Geçerse | Geçmezse |
| --- | --- | --- | --- |
| 0 | Uygulanabilirlik: `status = PAID`, `paidAt` dolu, ters ibraz/iade bayrağı (`manualReviewAt`) yok | — | `PURCHASE_NOT_PAID` / `PURCHASE_ALREADY_REFUNDED` / `PAYMENT_REVERSAL_RECORDED` → **NOT_APPLICABLE** |
| 1 | Kapsam: `OFFER_PACKAGE` + `ONE_TIME_CREDITS` | — | `PURCHASE_KIND_NOT_COVERED` (vitrin) / `PACKAGE_TYPE_NOT_COVERED` (dönemsel) |
| 2 | Pencere: `now − paidAt ≤ 14 gün` (milisaniyeye kadar kapsayıcı) | `WITHIN_REFUND_WINDOW` | `REFUND_WINDOW_EXPIRED` |
| 3 | `paidAt` anı **dahil** sonrasında sağlayıcı hesabında hiç `OFFER_SPEND` yok | `NO_CREDIT_SPENT_SINCE_PAYMENT` | `CREDIT_SPENT_SINCE_PAYMENT` |
| 4 | Bu satın almanın `CampaignRedemption` → `PromoCreditLot` zincirinde hiç `PromoCreditLotConsumption` yok | `NO_LINKED_PROMO_CONSUMED` | `LINKED_PROMO_CONSUMED` |

Sonuç: `REFUNDABLE` (hiç engel yok) · `EXCEPTION_ONLY` (ödenmiş ama en az bir engel var; yalnız gerekçeli istisna)
· `NOT_APPLICABLE` (iade edilecek geçerli ödeme yok). Her neden `{ code, blocking, explanation }` taşır;
`explanation` operatör için Türkçedir. `blockingCodes` makine okunur listedir. `summary` her `REFUNDABLE`
sonucunda "yalnız bir tavsiyedir; iade otomatik yapılmaz" der.

**Tasarımdan sapma/ek kararlar (gerekçeli):**

- **Eşitlik anı engeldir.** `createdAt = paidAt` olan bir harcama sayılır (`>=`). Aynı milisaniyede yazılmış bir
  harcamanın "önce" olduğunu kanıtlamanın yolu yok; belirsizlikte iade değil istisna incelemesi tarafı seçildi.
- **Harcama iadesi harcamayı silmez.** Sonradan `OFFER_REFUND` ile geri dönen bir teklif harcaması da `OFFER_SPEND`
  satırıdır ve engeldir — D1b "herhangi bir harcama" der.
- **Dönemsel paketler kapsam dışı.** `MONTHLY_QUOTA` / `CATEGORY_UNLIMITED` kullanımı kredi harcamasıyla
  ölçülmez (kota); bu kurallarla "kullanılmamış" denemez. `EXCEPTION_ONLY` + `PACKAGE_TYPE_NOT_COVERED`.
- **Ters ibraz bayrağı iadeyi uygulanamaz yapar.** `order_refunded` / chargeback webhook'u `manualReviewAt` yazmışsa
  para zaten dönmüştür; ikinci iade çift ödeme olur.
- **Kullanılmamış bağlı promosyon uygunluğu bozmaz** (kural 4 yalnız tüketimi sayar). İptali PR-B'nin settle
  anındaki S3 revoke'udur; bu PR hiçbir şeyi iptal etmez.

### 2.2 Okuyucu ve belirlenimcilik

`PackageRefundEligibilityService.readFacts` **tek bir SELECT** ile tüm olguları okur (alt sorgular dahil).
PostgreSQL tek bir ifadeyi tek bir snapshot'a karşı değerlendirir — READ COMMITTED'da bile. Eşzamanlı commit
eden bir harcama veya promosyon tüketimi bir değerlendirmeye **ya tamamen görünür ya hiç görünmez**; "harcama
görünür ama tüketim görünmez" gibi yarım bir durum oluşamaz. Test: 8 paralel + 1 tekrar değerlendirme aynı `now`
ile birebir eşit.

**Aksiyon yok.** Servis yazmaz, ödeme sağlayıcısı çağırmaz, bakiye değiştirmez, webhook'a tepki vermez; rotası
yoktur (PR-B'nin izinli inceleme yüzeyi tüketecek). Test: değerlendirme sonrası satın alma satırı ve defter
bit-bit aynı.

## 3. Satın alma sözleşme kanıtı

### 3.1 Model

```prisma
model PurchaseTermsAcceptance {
  id String @id                         purchaseId String @unique      userId String
  documentKey String   // yalnız 'PACKAGE_PURCHASE_TERMS' (CHECK)
  documentVersion String                // CHECK ^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$
  documentSha256 String                 // CHECK: = sha256(documentTextSnapshot)
  documentTextSnapshot String           // üç belgenin TAM metni (CHECK: başlık + üç bölüm)
  acceptedAt DateTime                   // tetikleyici: işlem saati, çağıranın değeri yok sayılır
  clientIp String?  userAgent String?   // ≤64 / ≤500 (CHECK)
  sourceChannel SourceChannel           // WEB | MOBILE | UNKNOWN — değişmez (append-only)
  purchase PackagePurchase @relation(fields: [purchaseId, id], references: [id, purchaseTermsAcceptanceId])
}
model PackagePurchase { … termsAcceptanceRequired Boolean @default(false)
                          purchaseTermsAcceptanceId String? @unique … }
```

`providerId` kopyalanmadı (satın almada var); S0 §4.1'deki `providerId` indeksi PR-B'nin liste yüzeyi gelince
eklenebilir.

### 3.2 Veritabanının kendi başına tuttuğu garantiler

| # | Garanti | Mekanizma |
| --- | --- | --- |
| G1 | Zorunlu (`termsAcceptanceRequired = true`) satın alma kabulsüz **doğamaz**; zorunlu olmayan kabul **taşıyamaz** | CHECK `PackagePurchase_terms_acceptance_matches_requirement`: `(acceptanceId IS NOT NULL) = required` |
| G2 | Kabul yalnız kendi satın almasına bağlanır; başka satın almaya **yeniden bağlanamaz** | `purchaseId @unique` + `purchaseTermsAcceptanceId @unique` + bileşik FK `(purchaseId, id) → PackagePurchase(id, purchaseTermsAcceptanceId)` |
| G3 | Kabul ve satın alma **ya birlikte ya hiç** | Bileşik FK `DEFERRABLE INITIALLY DEFERRED`: kabul önce yazılır, COMMIT'te çift doğrulanır |
| G4 | Zorunluluk ve bağ insert'ten sonra **değişmez** (eski satır sonradan "zorunlu" etiketlenemez, zorunlu satır kanıtını kaybedemez) | Tetikleyici `PackagePurchase_terms_evidence_immutable` |
| G5 | Kabul satırı **append-only**; `sourceChannel` dahil hiçbir kolon güncellenemez, silinemez | Tetikleyici `PurchaseTermsAcceptance_append_only` (UPDATE/DELETE → hata) |
| G6 | `acceptedAt` **kullanıcı girdisi olamaz** | Aynı tetikleyici INSERT'te `acceptedAt := now()` |
| G7 | Digest metne bağlı; metin tam, sürümlü, üç bölümlü | CHECK `sha256_matches_snapshot` (DB kendisi hesaplar), `snapshot_shape` (başlık satırı satırın sürümünü içerir, üç bölüm sırayla, ≥600 karakter) |
| G8 | Zorunluluk yalnız kredi paketi için | CHECK `PackagePurchase_terms_acceptance_offer_only` |

Bu depodaki **ilk iki tetikleyici** bunlardır. Test harness'leri `TRUNCATE` kullandığından (satır tetikleyicisi
çalışmaz) test temizliği etkilenmez; `resetDatabase` listelerine yeni tablo eklendi.

### 3.3 Neden zaman eşikli CHECK değil (S0 D9'dan bilinçli sapma)

S0 D9, `"createdAt" < TIMESTAMP '<migration anı>' OR acceptanceId IS NOT NULL` öneriyordu. Bu PR'ın görev tanımı
kabulü **varsayılan kapalı bir release gate** arkasına koyuyor: kapı kapalıyken migration'dan sonra doğan her
satın alma kabulsüz olmak **zorunda**. Migration anına sabitlenmiş bir eşik bu satırları reddederdi — yani ya
checkout kırılırdı ya da eşik kapı açıldığı güne ertelenecek ikinci bir migration'a bağlanırdı.

Seçilen model: zorunluluk **satır başına bir olgu**dur (`termsAcceptanceRequired`), kapı açıkken checkout
işlemi tarafından yazılır, CHECK ile kanıta bağlanır ve tetikleyiciyle dondurulur. Zaman damgası hiçbir kuralda
geçmez; bu yüzden `createdAt` sahtelemek (2000, 2099 veya varsayılan) hiçbir şeyi açmaz — test ve dry-run bunu
gösterir. `acceptedAt` ise tetikleyiciyle işlem saatine sabitlenir.

**Kalan açık (dürüstçe):** DB, kapının açık olduğunu bilmez. Kapı açıkken servis katmanını atlayıp
`termsAcceptanceRequired = false` ile satın alma yazan yeni bir kod yolu DB tarafından yakalanmaz. Bunu kapatan
fence'ler: (1) `OFFER_PACKAGE` satırı yazan **tek** yol `PackagePurchasesService.createProviderPurchase` ve her iki
rota ondan geçer; (2) kapı işlem sınırında o metodun **içinde** okunur, çağıranda değil. Bir DB "ratchet"i
(ilk zorunlu satırdan sonra zorunsuz insert'i reddetmek) değerlendirildi ve **seçilmedi**: kapıyı geri kapatmak
(örn. hukuk metni geri çekerse) checkout'u tamamen durdururdu ve bu karar ürün/hukuk kararıdır, migration değil.

### 3.4 Yazım sırası

`createProviderPurchase` içinde, mevcut `$transaction` gövdesinde: `randomUUID()` ile satın alma kimliği →
`PurchaseTermsService.recordAcceptance` (kabul satırı, `purchaseId` = bu kimlik) → `packagePurchase.create`
(`id`, `termsAcceptanceRequired: true`, `purchaseTermsAcceptanceId`). Kapı kapalıyken bu blok çalışmaz ve satır
**bugünkü `cuid()`** kimliğiyle, aynı alanlarla doğar.

## 4. Release gate (`PURCHASE_TERMS_GATE`)

| Değer | Sonuç |
| --- | --- |
| boş / tanımsız / `off` | **Kapalı, her ortamda.** `GET /payments/purchase-terms` → `{ required: false }`, metin yok; checkout bugünküyle aynı |
| `on` | Belge seti doğrulanır; geçmezse **API açılmaz** (`onModuleInit`) |
| başka değer | API açılmaz |

`on` için doğrulama (`validatePurchaseTermsDocumentSet`): anahtar, sürüm biçimi (DB CHECK ile aynı), üç belge
sabit sırada, her başlık tek satır, her metin bağlantılar çıkarıldıktan sonra ≥200 karakter (yalnız link = tam
metin değil), metinde bölüm işareti kaçakçılığı yok, **beyan edilen SHA-256 = birleşik snapshot'ın yeniden
hesaplanan SHA-256'sı**. Ek olarak: staging, production veya **beyan edilmemiş** ortamda `legalReview.status`
`APPROVED` (tarih + referans) değilse açılmaz — **RG-1'in kod yarısı**. Taslak yalnız `APP_ENVIRONMENT=local` veya
`NODE_ENV=test`'te sunulabilir ve web onu **TASLAK — onaylanmış bir sözleşme değildir** bandıyla gösterir.

Gönderilen belge seti (`purchase-terms.documents.ts`, sürüm `2026-09-22.taslak-1`) **taslaktır**: iade politikası
maddeleri S0 D1'in ürün kuralıdır; mesafeli satış ve ön bilgilendirme metinleri eksik hukuki bölümleri
`[RG-1: hukuk metni bekleniyor]` diye adlandıran iskeletlerdir. Mühendislik hukuki metni yazmaz.

## 5. Checkout akışı

| | Kapı kapalı | Kapı açık |
| --- | --- | --- |
| `GET /payments/purchase-terms` (AuthGuard) | `{ required: false }` | `{ required, documentKey, version, legalReviewStatus, documents[] }` — digest/IP/UA/kabul **yok** |
| `POST /providers/:id/checkout-sessions` | Bugünküyle aynı; `termsAccepted`/`termsVersion` gelse de yok sayılır | `termsAccepted !== true` → 400 `PURCHASE_TERMS_NOT_ACCEPTED`; sürüm ≠ sunulan → 400 `PURCHASE_TERMS_VERSION_STALE`; satır yazılmaz, sağlayıcı çağrılmaz |
| Yeniden kullanılabilir checkout | Bugünkü filtre | Yalnız **aynı sürümle** kabul edilmiş PENDING checkout geri verilir; kapıdan önce açılmış olan asla |
| `POST /providers/:id/package-purchases` (eski rota) | Bugünküyle aynı (operatör dahil) | Aynı kabul kuralları + **yalnız sağlayıcı hesabı** kabul edebilir (operatör 403) |

Metin her zaman **sunucunun** snapshot'ıdır; istemcinin gönderdiği metin, digest veya zaman hiçbir alana yazılmaz.
DTO alanları `@IsBoolean` / `@IsString @MaxLength(64)`: `"true"` dizgesi işaretli kutu değildir.

## 6. Web

- Kredi (`/providers/:id/credits`) ve Paketlerim (`/providers/:id/subscriptions`) sayfaları `GET /payments/purchase-terms`
  okur. `required: false` iken **HTML değişmez** (eski düğme dalı aynen render edilir).
- Açıkken: paket listesinin üstünde üç belgenin **tam metni** (`<details>`, kaydırmalı), taslaksa TASLAK bandı;
  her paket formunda **ayrı** (başka onayla birleşmez), **boş varsayılanlı** (`defaultChecked` yok, state `false`),
  **zorunlu** (düğme `disabled` + `required` + API) onay kutusu ve gizli `termsVersion`.
- Server action yalnız form bir sürüm taşıyorsa gövdeye `termsAccepted`/`termsVersion` ve kanıt başlıklarını ekler:
  tarayıcının `user-agent`'ı, `WEB_TRUST_PROXY` izin veriyorsa `x-forwarded-for`, `x-taktic-client-channel: web`.
- 400 kodları sayfaya `?kosullar=onay-gerekli|guncellendi` ile döner ve `role="alert"` açıklama gösterilir; dönüş
  yolu iki bilinen sayfadan biridir (açık yönlendirme yok).

## 7. Sızıntı politikası

`packagePurchaseOmit` artık `termsAcceptanceRequired` ve `purchaseTermsAcceptanceId`'yi de atar
(`purchaseTermsEvidenceOmit`); ilişki hiçbir `include`'da yok. Finans özeti (`GET /finance/summary`) aynı iki
kolonu atar. Sonuç: kapı kapalıyken tüm satın alma yanıtları **bayt bayt** eskisiyle aynıdır; kapı açıkken bile
IP, UA, digest, snapshot, kabul kimliği hiçbir sağlayıcı, admin liste/detay, finans, checkout veya public yanıtta
yoktur (test sekiz uç noktayı canary değerlerle tarar).

## 8. KVKK — RG-2 önerisi (uygulanmadı)

| Konu | Öneri | Bu PR'da |
| --- | --- | --- |
| **Amaç** | Tek amaç: belirli bir satın almada belirli bir metnin kabul edildiğinin ispatı (tüketici/ticari uyuşmazlık, ters ibraz itirazı). Analitik, hedefleme, fraud eşleştirmesi, kampanya kanalı **için okunmaz**. | Kod bu amaç dışında hiçbir yerde okumuyor |
| **Erişim yüzeyi** | Yalnız PR-B'nin tekil iade inceleme detayı; `PURCHASE_EVIDENCE_READ` (veya `PACKAGE_REFUND_APPROVE`) izni; her ham okuma `SensitiveDataAccessLog`'a (PR-0'da mevcut tablo). Listede asla. | Okuyan rota **yok**; izin eklenmedi (PR-0 kuralı: rotası olmayan izin eklenmez) |
| **Maskeleme** | Detayda varsayılan maskeli (IPv4 son oktet `x`, IPv6 son 80 bit; UA yalnız tarayıcı ailesi+sürüm); "ham göster" ayrı aksiyon + audit. | Yok |
| **Retention** | Seçenekler hukuka bırakılır: (a) S0'daki **24 ay** önerisi; (b) ilgili zamanaşımı süresi kadar; (c) iade penceresi + ters ibraz itiraz süresi + tampon. Süre dolunca `clientIp`/`userAgent` **NULL'a süpürülür**, satırın kendisi (metin, digest, zaman, kullanıcı) sözleşme kaydı olarak kalır. Süpürme append-only tetikleyicide **dar bir istisna** gerektirir (yalnız bu iki kolonu NULL'a çeviren UPDATE) — bir migration'dır. | **Uydurulmadı, uygulanmadı.** Süpürücü, tetikleyici istisnası ve süre RG-2 kararından sonra |
| **Aydınlatma** | KVKK aydınlatma metnine IP/UA'nın bu amaçla işlendiği eklenmeli | Yok (RG-1/RG-2 metin işi) |
| **Oturum IP/UA** | `Session.ipAddress/userAgent` retention'ı ayrı bir konudur | Dokunulmadı |

## 9. Açık release kapıları

- **RG-1 (açık):** Mesafeli satış, ön bilgilendirme ve iade politikası metinleri ile **anında ifa / cayma hakkı**
  değerlendirmesi avukat onayı almadan kapı hiçbir üretim/staging ortamında açılmaz. Kod bunu zorlar: onaysız set
  staging/production'da boot'u reddeder. Onay gelince: metinler `purchase-terms.documents.ts`'e yazılır, yeni sürüm
  + digest, `legalReview: { status: 'APPROVED', approvedAt, reference }`.
- **RG-2 (açık):** §8. Retention süresi, erişim yüzeyi ve aydınlatma metni KVKK kararı bekliyor. RG-2 kapanmadan
  kapı üretimde açılmamalı (kanıt satırı IP/UA ile doğar).
- **RG-5:** Kampanya motoru kapalı kalır — bu PR onu okumaz.

## 10. Bilinen sınırlamalar

1. `sourceChannel` istemci **beyanıdır** (UA ile aynı güven düzeyi); PR-D kanal eşleştirmesi için bir kanıt değildir.
2. Web arkasında gerçek istemci IP'si yalnız `WEB_TRUST_PROXY=true` + API `TRUST_PROXY` ile gelir; aksi hâlde
   kayıt web sunucusunun adresini **dürüstçe** taşır.
3. Kapı açıkken doğan satın almaların kimliği UUID'dir (kabul önce yazıldığı için kimlik uygulamada üretilir);
   diğerleri `cuid()`. Kimlik biçimine bağlı kod yok.
4. S0 §9-I'deki `PackagePurchase.sourceChannel` eklenmedi — görev tanımı istemiyor, PR-D'nin konusu.
5. `/sozlesmeler/mesafeli-satis`, `/on-bilgilendirme`, `/iade-politikasi` sayfaları yayımlanmadı: onaysız metni
   "sözleşme" diye yayımlamamak için. Checkout metni satır içinde tam gösterir; sayfalar RG-1 sonrası (SEO allowlist ile).
