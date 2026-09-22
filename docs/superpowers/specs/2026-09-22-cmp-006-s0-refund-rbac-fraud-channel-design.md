# CMP-006 S0 — İade politikası, checkout kanıtı, izin tabanlı RBAC, promosyon uygunluğu ve kampanya kanalı

Tarih: 2026-09-22 · Taban: `origin/main` @ `54183784` (PR #102 merge, temiz worktree doğrulandı) ·
Branch: `claude/refund-policy-campaign-design-dfb3d6` · Bağlayıcı sözleşme: CMP-001 (rev. 3) §2, §8, §10, §12 ·
Önceki dilimler: S2A/S2B1/S2B2 (`2026-09-19`…`2026-09-21`), S3 (`2026-09-21-cmp-003-s3-refund-revoke-design.md`),
S4 (`2026-09-22-cmp-004-s4-net-refund-visibility-toggle-design.md`).

**Bu belge yalnız tasarımdır.** Bu PR ile kod, migration, test, .env, container, sözleşme metni ve gerçek veri
değişmez. Uygulama dilimleri ayrı PR'lardır (§12). **Kampanya motoru (`campaignEngineEnabled`) bu dilimlerin
hiçbirinde açılmaz**; yerel ve staging DB'de kapalı kalır — açılışın ön koşulları CMP-002 S2B1 §"engine açma ön
koşulu" ve bu belgenin §13 release kapılarıdır.

---

## 0. Terim ayrımı — okumadan önce

Bu depoda **"refund" iki ayrı şey demek** ve karıştırılmaları bir üretim hatasıdır:

| Terim | Ne demek | Nerede | CMP-006 bunu değiştirir mi |
| --- | --- | --- | --- |
| **Teklif kredisi iadesi** (mevcut) | Müşteri teklifi 48 saat içinde açmazsa sağlayıcının *kredisi* geri döner | `apps/api/src/modules/offers/refund-policy.ts`, `GET /refund-policy` (public), `OFFER_REFUND` ledger türü, S4 `OfferRefundSettlement` | **Hayır.** Tek satırı değişmez. |
| **Paket para iadesi** (bu belge) | Sağlayıcının ödediği **para**nın ödeme sağlayıcısı üzerinden geri verilmesi | Bugün **yok**; yalnız `order_refunded` webhook'u bir bayrak koyuyor | **Evet.** Bu belgenin konusu. |

**Ad alanı kuralı (D0):** yeni her şey `PackageRefund*` / `package-refund` adını taşır. `RefundPolicy`,
`refund-policy.ts`, `calculateRefundEligibility`, `OfferRefundSettlement`, `ManualOfferRefundAudit` adlarına
dokunulmaz ve bunlara yeni anlam yüklenmez. `GET /refund-policy` teklif kredisi politikası olarak kalır; paket
politikası `GET /package-refund-policy` olur.

---

## 1. Mevcut kod envanteri (dosya:satır)

### 1.1 Ödeme, satın alma, iade

| Konu | Yer | Bugünkü davranış |
| --- | --- | --- |
| Checkout açma | `apps/api/src/modules/payments/payments.service.ts:88` `createCheckoutSession(providerId, user, dto)` | Controller `@Req()` **geçirmiyor** (`payments.controller.ts:42-49`); IP/UA/kanal servise ulaşmıyor |
| Satın alma satırı | `prisma/schema.prisma:1646` `PackagePurchase` | `status`, `paidAt`, `refundedAt`, `manualReviewReason/At`, `providerOrderId @unique`, `paymentReference @unique` |
| Ödeme portu | `apps/api/src/modules/payments/payment-provider.port.ts:11` | **Hiç iade/capture yeteneği yok** — "port deliberately cannot settle anything" |
| Webhook parse | `apps/api/src/modules/payments/lemon-squeezy.webhook.ts:137-160` | Yalnız `eventName`, `objectType`, `objectId`, `storeId`, `reference`; **müşteri/ödeme kimliği çıkarılmıyor** |
| Ters işlem (`order_refunded`) | `apps/api/src/modules/payments/payments-webhook.service.ts:702` `flagForManualReview` | `manualReviewReason/At` yazar; **ücretli krediyi düşürmez** (satır 683-686 gerekçesi); `isRelevantReversal` ise S3 revoke'u çalıştırır (satır 752) |
| Kampanya revoke | `apps/api/src/modules/campaigns/engine/campaign-revoke.service.ts:13` | Motor anahtarını okumaz; muhasebedir |
| Kredi defteri | `prisma/schema.prisma:1981` `ProviderCreditTransaction`, `:243` `CreditTransactionType` | `ADMIN_DEDUCT` mevcut; `referenceType/referenceId` serbest |
| Manuel kredi iadesi | `prisma/schema.prisma:2035` `ManualOfferRefundAudit` | Operatör adı zorunlu, ledger satırıyla 1-1 — **istisna iade için örnek alınacak şekil** |

### 1.2 Sözleşme / kanıt

| Konu | Yer | Bugünkü davranış |
| --- | --- | --- |
| Vitrin kart onayı | `prisma/schema.prisma:3277` `ShowcaseCardPriceTermsAcceptance` | `termsVersion`, `termsTextSnapshot`, `acceptedByUserId`, `acceptedAt`; **IP/UA yok**; `@@unique([cardId, termsVersion])` — idempotent |
| Vitrin paket onayı | `prisma/schema.prisma:3321` `ShowcasePackageTermsAcceptance` | Aynısı, `@@unique([providerId, termsVersion])` |
| Satın almaya bağlama | `prisma/schema.prisma:1684`, `:1689` | `showcasePriceTermsAcceptanceId` / `showcasePackageTermsAcceptanceId`, CHECK `PackagePurchase_showcase_card_matches_kind` — **aynı tx'te yazılır**, örnek alınacak sözleşme |
| Onay kutusu UI | `apps/web/app/providers/[id]/vitrin/paketler/package-picker.tsx:69-87` | Yalnız **vitrin** akışında |
| Teklif kredisi checkout UI | `apps/web/app/providers/[id]/credits/page.tsx:317-326` | **Hiç onay kutusu yok** |
| Web sözleşme sayfaları | `apps/web/app/sozlesmeler/iletisim-paylasimi/page.tsx` | **Tek sayfa.** Mesafeli satış, ön bilgilendirme, iade politikası, KVKK aydınlatma sayfaları **yok** |
| IP/UA okuma örüntüsü | `apps/api/src/modules/phone-verification/phone-verification.controller.ts:65-72`, `showcase-public.controller.ts:141-145`, `turnstile.guard.ts:108` | Hepsi `req.ip` (TRUST_PROXY'ye saygılı) + `headers['user-agent']`; **üç ayrı kopya** |
| IP/UA saklama örneği | `prisma/schema.prisma:653` `Session.ipAddress/userAgent` | Zaten saklanıyor; retention kuralı yazılı değil |

### 1.3 Yetki (RBAC)

| Konu | Yer | Bugünkü davranış |
| --- | --- | --- |
| Rol kümesi | `prisma/schema.prisma:10` `enum UserRole { SUPER_ADMIN, CUSTOMER, PROVIDER }` | Üç değer; hesap başına tek rol |
| Rol guard'ı | `apps/api/src/modules/auth/roles.guard.ts:11-23` | `reflector.getAllAndOverride<UserRole[]>` → `roles.includes(request.user.role)`. **İzin okuması yok** |
| Dekoratör | `apps/api/src/modules/auth/auth.decorators.ts:6` | `Roles(...roles: UserRole[])` |
| Kapsam | `@Roles(UserRole.SUPER_ADMIN)`: **72 kullanım, 28 controller** | Tümü statik |
| Admin hesabı üretimi | `apps/api/src/modules/users/users.service.ts:79,153`, `admin-invite.service.ts:169` | Yalnız `SUPER_ADMIN` üretilebiliyor |
| Admin menüsü | `apps/admin/lib/nav.ts:12` `navGroups` | Statik dizi; izin filtresi yok |

**Kanıt (talep edilen):** mevcut RBAC **dinamik izin atamasını desteklemiyor.** Ne izin tablosu, ne rol tablosu,
ne de rol→izin bağı var; `RolesGuard` yalnız `request.user.role` enum değerini karşılaştırıyor. Bu yüzden PR-0
bağımsız bir temel dilimdir.

### 1.4 Destek talebi

| Konu | Yer | Bugünkü davranış |
| --- | --- | --- |
| Model | `prisma/schema.prisma:2404` `SupportTicket` | `requesterId`, `requesterRole`, **serbest metin `subject`**, `status`; konu/kategori alanı **yok**, paket bağı **yok** |
| Oluşturma DTO | `apps/api/src/modules/support-tickets/dto/create-support-ticket.dto.ts:23` | `subject`, `message`; sahibi oturumdan |
| Durum makinesi | `apps/api/src/modules/support-tickets/support-ticket.rules.ts:27` | `OPEN ↔ IN_PROGRESS → RESOLVED → CLOSED` (terminal) |
| Web formu | `apps/web/app/destek/yeni/page.tsx` | Konu seçimi yok |

### 1.5 İşletme kaydı

| Konu | Yer | Bugünkü davranış |
| --- | --- | --- |
| Alanlar | `prisma/schema.prisma:1219-1220` `ProviderProfile.taxType/taxNumber` | **Serbest metin**, nullable |
| Doğrulama | `apps/api/src/modules/providers/dto/create-provider.dto.ts:52-56` | Yalnız `@IsOptional() @IsString()` — biçim, uzunluk, tür kontrolü yok |
| Toplandığı yer | `providers.service.ts:322,857,1679` | Admin ve davet yolu |
| Web başvuru formu | `apps/web/app/providers/provider-application-fields.tsx` | **Hiç toplanmıyor** (alanlar: businessName, contactName, description, phone, email, addressNote) |
| Admin görünümü | `apps/admin/app/providers/[id]/page.tsx:553-555` | Ham değer, maskesiz, audit'siz |

### 1.6 Kampanya motoru

| Konu | Yer | Bugünkü davranış |
| --- | --- | --- |
| Katalog (DSL) | `packages/shared/campaign-rules.json`, `rules/catalog.ts:33` | 3 tetikleyici, 3 fact, 10 koşul, 1 fayda, 5 limit, 1 stack politikası |
| Faz A hook'ları | `engine/campaign-engine.hooks.ts:96,118,133` | `providerApproved`, `accountFactProven`, `packagePaymentSucceeded` — yalnız PENDING event yazar |
| Hook çağrı yerleri | `providers.service.ts:1043`; `email-verification.service.ts:183`; `phone-verification.service.ts:435`; `payments-webhook.service.ts:562,619`; `package-purchases.service.ts:297,353` | **6 yer** |
| Olay kimliği | `engine/trigger-event-key.ts` | `PROVIDER_APPROVED:<providerId>` · `PACKAGE_PAYMENT_SUCCEEDED:<purchaseId>` · `PROVIDER_ELIGIBILITY_REACHED:<factSetKey>:<providerId>` |
| Faz B boru hattı | `engine/campaign-engine.service.ts:158-290` | 1 event → 2 settled kısa devre → 3 aday → **4 pencere + koşul** → 5 sıralama → 6 savepoint/grant |
| Fact okuma | `engine/campaign-fact-reader.ts:16` | `ProviderFacts` / `PurchaseFacts` |
| Event satırı | `prisma/schema.prisma:4046` `CampaignTriggerEvent` | `status`, `leaseUntil`, `nextAttemptAt`; **kanal alanı yok** |
| Sürüm satırı | `prisma/schema.prisma:3909` `CampaignVersion` | Değişmez; **kanal alanı yok** |
| Motor anahtarı | `operations-settings/campaign-engine-settings.service.ts`, `hooks.ts:208`, `worker.ts:263` | Fail-closed, varsayılan `false` |
| Kaynak kaydı örneği | `engine/fact-source-registry.ts` + aktivasyon reddi `FACT_SOURCE_UNAVAILABLE` | **Kanal kaynağı kaydı için birebir örnek** |

---

## 2. Kararlar (gerekçeli)

| # | Karar | Gerekçe |
| --- | --- | --- |
| **D0** | **Ad alanı ayrımı.** Yeni her şey `PackageRefund*`. Mevcut teklif kredisi iadesi adları ve `GET /refund-policy` dokunulmaz; paket politikası `GET /package-refund-policy`. | §0. İki farklı "iade" aynı adı taşırsa bir gün biri diğerinin testini geçer. |
| **D1** | **Paket iadesi politikası.** (a) Satın alma tarihinden itibaren **14 gün** içindeki talep değerlendirilebilir. (b) Satın alma `paidAt`'inden sonra hesapta **herhangi bir teklif kredisi harcandıysa iade yoktur** — ücretli/promosyon/önceki bakiye **ayrımı yapılmaz**. (c) Pakete bağlı promosyonun **tek kredisi** kullanıldıysa iade yoktur. (d) Kullanılmamış paket iadesinde o pakete bağlı **kullanılmamış promosyon revoke edilir**. (e) İstisnalar (§3.4) otomatik değil, **yetkili incelemesiyle**. | Bağlayıcı ürün kararı. (b)'nin "ayrım yapılmaz" hâli kasıtlı: harcanan kredinin hangi kaynaktan geldiğini iade anında tartışmak, her iade talebini bir muhasebe davasına çevirir. |
| **D2** | **Self-service para iadesi yoktur.** Sağlayıcının tek yazma yüzeyi destek talebidir (D14) ve o da yalnız **inceleme kaydı** doğurur. Para iadesini yalnız yetkili operatör, maker-checker ile başlatır. | Bağlayıcı karar. Ayrıca `PaymentProviderPort`'un iade yeteneği olmaması (1.1) self-service'i teknik olarak da imkânsız kılıyor. |
| **D3** | **Para hareketi TakTic dışında, mutabakat webhook'la.** Onaylanan talep `APPROVED_PENDING_SETTLEMENT` olur; operatör parayı Lemon panelinde iade eder; gelen `order_refunded` olayı talebi `SETTLED` yapar. `PaymentProviderPort`'a **iade metodu eklenmez**. | Yeni bir giden yazma yüzeyi (kimlik, timeout, çift-çağrı, webhook ile yarış) açmadan aynı sonucu verir. Mevcut `providerOrderId @unique` + `PaymentWebhookEvent.eventKey` idempotency'si hazır. |
| **D4** | **`SETTLED`'a yalnız webhook geçirir.** Operatörün "ödendi işaretle" düğmesi **yoktur**; hiçbir admin rotası `SETTLED` yazmaz. DB yarısı: CHECK `status <> 'SETTLED' OR "settledByWebhookEventId" IS NOT NULL`. | Düzeltme 1. "İade yaptım" beyanı ile "iade gerçekten oldu" iki farklı olgudur; sistemin sakladığı ikincisi olmalıdır. |
| **D5** | **Maker-checker DB'de, NULL kaçağı kapalı.** CHECK: `status NOT IN ('APPROVED_PENDING_SETTLEMENT','SETTLED','SETTLEMENT_ABANDONED') OR ("approvedById" IS NOT NULL AND "approvedById" <> "createdById")`. `IS NOT NULL` konjunktı **`<>`'ın NULL'da UNKNOWN dönüp CHECK'i geçmesini** engeller. | Düzeltme 1. Yalnız `approvedById <> createdById` yazılsaydı `approvedById = NULL` olan bir satır CHECK'i geçerdi. |
| **D6** | **Bir webhook olayı en fazla bir talebi settle eder.** `PackageRefundRequest.settledByWebhookEventId String? @unique` (FK → `PaymentWebhookEvent`). Ayrıca paket başına en fazla bir `SETTLED` talep: partial unique index. | Düzeltme 2. |
| **D7** | **Talebi olmayan dış iade mevcut yolu aynen çalıştırır.** `flagForManualReview`: bayrak + `isRelevantReversal` ise S3 revoke — **bugünküyle bire bir**. Yalnızca `APPROVED_PENDING_SETTLEMENT` bir talep varsa ek olarak o talep `SETTLED` olur. Talep yoksa hiçbir talep settle edilmez, hata da üretilmez. | Düzeltme 2. Geriye dönük davranış korunur; yeni yol yalnız ekler. |
| **D8** | **Checkout kanıtı ayrı, boş varsayılanlı, zorunlu tek kutu.** Yeni `PurchaseTermsAcceptance`: `documentKey`, `documentVersion`, `documentSha256`, `documentTextSnapshot`, `acceptedAt`, `clientIp`, `userAgent`, `userId`, `providerId`, `purchaseId`, `sourceChannel`. Vitrin kabullerinden farkı: **idempotent değil** — satın alma başına bir satır. | Bağlayıcı karar. Sürüm + hash birlikte: sürüm dizgesi elle değiştirilebilir, hash metnin kendisine bağlıdır. |
| **D9** | **Kanıtsız yeni satın alma DB'de imkânsız.** `PackagePurchase.purchaseTermsAcceptanceId String?` + CHECK `"createdAt" < TIMESTAMP '<migration anı>' OR "purchaseTermsAcceptanceId" IS NOT NULL`. Kabul, satın alma ile **aynı transaction'da** yazılır (vitrin örüntüsü, `schema.prisma:1684` yorumu). | Backfill yapılamaz (kimseye o metin gösterilmedi); NOT NULL da konulamaz. Zaman eşikli CHECK ikisini de çözer ve eski satırın NULL'ı dürüst kalır. |
| **D10** | **IP/UA okuması tek yere toplanır:** `apps/api/src/common/request-meta.ts` → `readRequestMeta(req): { ipAddress, userAgent, sourceChannel }`. Üç mevcut kopya (1.2) bu dilimde **değiştirilmez**, yeni kod bunu kullanır. | Dört numaralı kopyayı yazmamak için; mevcut üçünü dokunmamak kapsam disiplini için. |
| **D11** | **RBAC: rol dinamik, izin kataloğu sabit.** `AdminRole` (admin oluşturur/düzenler) + `AdminRolePermission` + `AdminRoleAssignment`; `AdminPermission` bir **Prisma enum**'dur — yeni izin adı ancak migration + kod ile gelir, panelden **üretilemez**. | Düzeltme 3. Enum olması, "izin adı" ile "guard'da gerçekten kontrol edilen şey" arasındaki boşluğu (panelden yazılan ama hiçbir rotayı korumayan izin) imkânsız kılar. |
| **D12** | **`SUPER_ADMIN` rol ataması olmadan da tüm izinlere sahiptir.** `UserRole` enum'una **`ADMIN`** eklenir: yetkisi *yalnız* atanmış rollerden gelen personel hesabı. Admin paneline erişim = `SUPER_ADMIN` **veya** (`ADMIN` ve en az bir aktif rol ataması). Bunu **API zorlar** (`AdminAccessGuard`), UI değil. | Düzeltme 3. `ADMIN` bir yetenek adı değil, hesap türü işaretidir; yetenekler rol atamasından gelir — bu yüzden "sabit rol adı" itirazına girmez. Hesap başına tek rol kuralı (`User.email @unique` + `UserRole`) yeni bir değer gerektiriyor. |
| **D13** | **İzin kaynağı tek:** `GET /admin/me/permissions` → `{ isSuperAdmin, permissions[] }`. Menü, liste, detay, aksiyon ve rota **aynı** kümeyi okur. UI'da gizlenen her şey API'de de 403'tür; API'de serbest olan hiçbir şey UI'da gizlenmez. | Düzeltme 3. İki kaynak olursa biri er geç diğerinden geniş olur. |
| **D14** | **Destek talebi girişi PR-B'nin bağlayıcı parçası.** `SupportTicketTopic { GENERAL, PACKAGE_AND_CREDIT_REFUND }` (mevcut satırlar `GENERAL` — gerçek backfill) + `SupportTicket.packagePurchaseId`. Sağlayıcı konuyu seçer, **yalnız kendi** PAID paketlerinden birini bağlar; aynı tx'te `PackageRefundRequest` **DRAFT** doğar. Para iadesi ve uygunluk onayı vermez. | Düzeltme 5. |
| **D15** | **Paket başına açık talep tekildir.** Partial unique index: `purchaseId` WHERE `status IN ('DRAFT','SUBMITTED','UNDER_REVIEW','APPROVED_PENDING_SETTLEMENT')`. İkinci deneme 409 `PACKAGE_REFUND_REQUEST_ALREADY_OPEN`. | Düzeltme 5. |
| **D16** | **Paket sahipliği 404 ile korunur, 403 ile değil.** Başkasının `purchaseId`'si → 404 (var/yok ayrımı sızdırmaz). CMP-004 D7'nin id-yoklama kararıyla aynı. | Mevcut sözleşme. |
| **D17** | **Fraud DSL'e girmez.** Kampanya katalogu (`campaign-rules.json`) **değişmez**: cihaz/IP/sicil koşulu eklenmez. Motorun önünde kanonik karar: `PROVIDER_PROMOTION_ELIGIBLE = ELIGIBLE \| REVIEW \| INELIGIBLE`. | Bağlayıcı karar. Risk kuralı operatörün düzenlediği bir kampanya alanı olursa, her kampanya kendi fraud politikasını yazar. |
| **D18** | **Aynı IP/cihaz tek başına engel değildir.** Hiçbir zaman `INELIGIBLE` üretmez; yalnız `REVIEW`'a katkıda bulunan bir sinyaldir. | Bağlayıcı karar. |
| **D19** | **Kanonik işletme kaydı ham numara taşımaz (sayaçta).** `ProviderBusinessRegistration` ham `numberCanonical`'ı tutan **tek** satırdır; `CampaignRegistrationCounter` yalnız `registrationType` + **sürümlü HMAC** `fingerprint`/`fingerprintVersion` taşır. Ham numara yalnız izinli detay ekranında, listelerde `numberMasked`, her ham okuma `SensitiveDataAccessLog`'a yazılır. | Düzeltme 4. |
| **D20** | **Eski `taxType/taxNumber` otomatik dönüştürülmez.** Migration hiçbir satırı kanonik kayda çevirmez; operatör tek tek doğrular ve girer. Eski kolonlar tarihsel kayıt olarak kalır, okuyan ekranlar değişmez. | Düzeltme 4. Serbest metin alanını (1.5) kanonik sicil kaydı saymak, doğrulanmamış veriye doğrulanmış muamelesi yapmaktır. |
| **D21** | **`HELD_FOR_REVIEW` otomatik yeniden denenmez.** Yeni `CampaignTriggerEventStatus.HELD_FOR_REVIEW`; worker bu satırı **asla claim etmez** (`nextAttemptAt` filtresi dışında kalır). Yetkili kişi `ELIGIBLE` veya `INELIGIBLE` kararı verir; **gerekçe zorunlu** ve **hold anındaki risk snapshot'ı** saklanır. | Düzeltme 6. |
| **D22** | **Snapshot hold anında donar.** Motor hold ederken `CampaignTriggerEvent.eligibilitySignals` (kapalı kodlar, PII yok) + `eligibilityHeldAt` yazar; karar satırı bunu **kopyalar** (`PromotionEligibilityReview.signalSnapshot`). İkinci bir hold geçmiş kararın dayanağını değiştiremez. | Düzeltme 6. |
| **D23** | **Kanal, hak edişi doğuran işlemin değişmez kaynağıdır.** `CampaignVersion.channel: WEB\|MOBILE\|ALL` (mevcut satırlar `ALL`); `CampaignTriggerEvent.sourceChannel: WEB\|MOBILE\|UNKNOWN`, **insert'ten sonra değişmez**. | Bağlayıcı karar. |
| **D24** | **Kanal `triggerEventKey`'e girmez.** Anahtar bugünkü üç biçimini aynen korur. | Girseydi bir olayın kanalının farklı türetilmesi **ikinci anahtar → ikinci grant** üretirdi. Bu, tekrar-grant riskine karşı tek en önemli invariant. |
| **D25** | **Fail-closed kanal eşleşmesi.** `WEB` veya `MOBILE` hedefleyen sürüm `UNKNOWN` kaynaklı olayla **asla** eşleşmez. `ALL` "kanal koşulu yok" demektir ve `UNKNOWN` dahil her şeyle eşleşir. | Ayrımcılık yapan sürüm, kaynağını bilmediği olaya hak ediş veremez. `ALL`'ın `UNKNOWN`'ı kabulü geriye dönük davranışı korur: bugünkü her kampanya `ALL`'dır ve bugünkü her olay `UNKNOWN`'dır. |
| **D26** | **Mobil istemci yokken sessiz kampanya olmaz.** `FactSourceRegistry` ikizi `ChannelSourceRegistry`; hiçbir modül `MOBILE` kaynağı kaydetmemişken `channel = MOBILE` sürümünün aktivasyonu **reddedilir**: yeni aktivasyon hata kodu `CHANNEL_SOURCE_UNAVAILABLE` (katalogun `activationErrorCodes`'una eklenir). Admin builder'da sürüm kaydederken uyarı. | Bağlayıcı karar. `FACT_SOURCE_UNAVAILABLE` ile birebir aynı sözleşme. |
| **D27** | **Kredi geri alımı otomatik değil, onaylı ve borçsuz.** Onay anında `creditClawbackCredits` kararlaştırılır; **settle anında** sistem aktörüyle tek `ADMIN_DEDUCT` satırı yazılır (`clawbackTransactionId @unique` ile idempotent). Bakiye yetmezse eldeki kadarı düşülür, kalanı `clawbackShortfallCredits` olarak **kayıt** edilir; **negatif bakiye ve borç yoktur** (CMP-001 §2.6). | `payments-webhook.service.ts:683-686` "otomatik düşme" itirazı korunur: düşen şey artık otomatik değil, maker-checker'dan geçmiş bir insan kararıdır. O yorum bu dilimde güncellenir. |

---

## 3. Paket iade durum makinesi

### 3.1 Durumlar

```
                    (sağlayıcı, destek talebi)          (operatör)
                             │                              │
                             ▼                              ▼
  ┌────────┐  submit  ┌───────────┐  take  ┌──────────────┐
  │ DRAFT  │─────────▶│ SUBMITTED │───────▶│ UNDER_REVIEW │
  └────────┘          └───────────┘        └──────┬───────┘
      │                     │                     │
      │ withdraw            │ withdraw            ├──── reject ────▶ ┌──────────┐
      ▼                     ▼                     │                  │ REJECTED │ (terminal)
  ┌───────────┐                                   │                  └──────────┘
  │ WITHDRAWN │ (terminal)                        │
  └───────────┘                                   │ approve (checker ≠ maker)
                                                  ▼
                                    ┌──────────────────────────────┐
                                    │ APPROVED_PENDING_SETTLEMENT  │
                                    └───────────┬──────────────────┘
                        order_refunded webhook  │        │ operatör: vazgeç
                                                ▼        ▼
                                          ┌──────────┐  ┌──────────────────────┐
                                          │ SETTLED  │  │ SETTLEMENT_ABANDONED │
                                          └──────────┘  └──────────────────────┘
                                           (terminal)          (terminal)
```

| Geçiş | Kim | Zorunlu | DB garantisi |
| --- | --- | --- | --- |
| `→ DRAFT` | Sağlayıcı (destek talebi) | Kendi PAID paketi | D15 partial unique |
| `DRAFT → SUBMITTED` | Sağlayıcı veya operatör | — | — |
| `SUBMITTED → UNDER_REVIEW` | `PACKAGE_REFUND_REQUEST_CREATE` | `createdById` (maker) | `createdById` NOT NULL |
| `UNDER_REVIEW → REJECTED` | `PACKAGE_REFUND_APPROVE` | `rejectedById`, gerekçe (1–500) | CHECK: `status <> 'REJECTED' OR ("rejectedById" IS NOT NULL AND "rejectionReason" IS NOT NULL)` |
| `UNDER_REVIEW → APPROVED_PENDING_SETTLEMENT` | `PACKAGE_REFUND_APPROVE` | `approvedById ≠ createdById`, istisna gerekçesi, `creditClawbackCredits` | **D5 CHECK** |
| `APPROVED_PENDING_SETTLEMENT → SETTLED` | **yalnız webhook** | `settledByWebhookEventId` | **D4 + D6 CHECK/unique** |
| `APPROVED_PENDING_SETTLEMENT → SETTLEMENT_ABANDONED` | `PACKAGE_REFUND_APPROVE` | gerekçe | — |
| `* → WITHDRAWN` | Sağlayıcı (yalnız DRAFT/SUBMITTED) | — | — |

**Terminal durumlar geri alınmaz.** Yeni bir olay yeni bir talep açar (destek talebi `CLOSED` kuralıyla aynı felsefe).

### 3.2 Uygunluk değerlendirmesi — **tavsiyedir, aksiyon değildir**

`PackageRefundEligibility` saf fonksiyon; ekrana ve karar kaydına yazılır, hiçbir geçişi kendiliğinden yapmaz.

| Kod | Predicate | Kaynak |
| --- | --- | --- |
| `WINDOW_OPEN` | `now − purchase.paidAt ≤ 14 gün` | `PackagePurchase.paidAt` |
| `WINDOW_EXPIRED` | tersi | — |
| `NO_CREDIT_SPENT` | `paidAt`'ten sonra bu sağlayıcıya ait **hiç** `OFFER_SPEND` satırı yok | `ProviderCreditTransaction` (`type = OFFER_SPEND`, `createdAt > paidAt`) |
| `CREDIT_SPENT` | tersi — ücretli/promo/önceki bakiye **ayrımı yok** (D1b) | aynı |
| `NO_LINKED_PROMO_CONSUMED` | bu satın almanın doğurduğu `CampaignRedemption`'ların lotlarında **hiç** `PromoCreditLotConsumption` yok | `CampaignRedemption.purchaseId` → `PromoCreditLot` → `PromoCreditLotConsumption` |
| `LINKED_PROMO_CONSUMED` | tersi (D1c) | aynı |

**Tavsiye:** `REFUNDABLE` = `WINDOW_OPEN ∧ NO_CREDIT_SPENT ∧ NO_LINKED_PROMO_CONSUMED`. Aksi hâlde
`EXCEPTION_ONLY` ve engelleyen kodların listesi. Sonuç **her zaman** operatöre gösterilir; `EXCEPTION_ONLY` bir
onayı engellemez — yalnız istisna gerekçesini (§3.4) zorunlu kılar.

### 3.3 Kullanılmamış promosyonun revoke'u (D1d)

Kullanılmamış paket iadesi `SETTLED` olduğunda o satın almaya bağlı **kullanılmamış** promosyon iptal edilir.
Yeni kod **yazılmaz**: webhook zaten `isRelevantReversal` ise `CampaignRevokeService.revokeForRefundedPurchase`
çağırıyor (`payments-webhook.service.ts:752`) ve o servis motor anahtarını okumuyor. Kullanılmışsa zaten iade
yoktur (D1c); istisna iadesinde kullanılmış pay `spentAtRevoke` olarak kayda geçer, geri alınmaz — S3 sözleşmesi
aynen.

### 3.4 İstisna gerekçeleri (kapalı küme)

| Kod | Anlamı | Not |
| --- | --- | --- |
| `STATUTORY_RIGHT` | Zorunlu kanuni hak | RG-1 hukuk kapısına bağlı |
| `UNAUTHORIZED_TRANSACTION` | Doğrulanmış yetkisiz işlem | Doğrulama kanıtı gerekçe metninde |
| `DUPLICATE_CHARGE` | Çift tahsilat | İkinci `providerOrderId` referansı gerekçede |
| `PLATFORM_SERVICE_FAULT` | TakTic kaynaklı hizmet kusuru | — |

`APPROVED_PENDING_SETTLEMENT` için gerekçe **zorunlu**: CHECK `status NOT IN ('APPROVED_PENDING_SETTLEMENT','SETTLED','SETTLEMENT_ABANDONED') OR "exceptionGround" IS NOT NULL`.

### 3.5 Mevcut mekanizmaların yeni politikadaki yeri

| Mekanizma | Yeni politikadaki rolü | Değişiklik |
| --- | --- | --- |
| `order_refunded` → `flagForManualReview` | **Tek mutabakat kapısı.** Bayrak + S3 revoke aynen; ek olarak varsa `APPROVED_PENDING_SETTLEMENT` talebi `SETTLED` yapar ve `creditClawbackCredits`'i uygular | **Ekleme**; mevcut davranış korunur (D7) |
| `CampaignRevokeService` | Kullanılmamış promosyonun iptali (D1d) | **Değişiklik yok** |
| S4 `OfferRefundSettlement` | **Teklif kredisi** iadesinin net sonucu | **Değişiklik yok** — paket iadesiyle ilgisi yok |
| `ManualOfferRefundAudit` | Teklif kredisi manuel iadesi | **Değişiklik yok** |
| `PackagePurchaseStatus.REFUNDED` | `SETTLED` anında yazılır (bugün hiçbir yol yazmıyor) | **Yeni yazıcı** |

---

## 4. Checkout kanıtı ve sözleşme

### 4.1 Kanıt kaydı

```prisma
model PurchaseTermsAcceptance {
  id                  String   @id @default(cuid())
  providerId          String
  userId              String
  purchaseId          String   @unique   // satın alma başına tam bir kanıt
  documentKey         String             // PR-A'da tek değer: 'PACKAGE_PURCHASE_TERMS' (§4.1 sonu)
  documentVersion     String             // boş olamaz (CHECK)
  documentSha256      String             // metnin değişmez özeti (64 hex, CHECK)
  documentTextSnapshot String            // gösterilen metnin kendisi
  acceptedAt          DateTime @default(now())
  clientIp            String?            // §5 sınıflandırma
  userAgent           String?            // ≤500 karakter
  sourceChannel       SourceChannel      // WEB | MOBILE | UNKNOWN
  // ilişkiler: provider, user (Restrict), purchase (Restrict)
  @@index([providerId, acceptedAt])
  @@index([documentKey, documentVersion, acceptedAt])
}
```

Vitrin kabullerinden (`ShowcasePackageTermsAcceptance`) **üç fark**: (1) idempotent değil — her satın alma kendi
kanıtını taşır, çünkü kanıt "bu kişi bir kez kabul etmişti" değil "bu satın alma şu metin gösterilerek yapıldı"
demektir; (2) IP/UA/kanal taşır; (3) `documentSha256` metnin kendisine bağlıdır.

**Neden tek belge, üç sayfa.** Kabul edilen şey **tek birleşik metindir** (`documentKey = 'PACKAGE_PURCHASE_TERMS'`);
mesafeli satış, ön bilgilendirme ve iade politikası ayrı sayfalar olarak yayımlanır ve birleşik metin onlara atıf
yapar. Alternatif — belge başına bir kabul satırı (`@@unique([purchaseId, documentKey])`) — D9'un CHECK'ini
imkânsız kılardı: `PackagePurchase` tek bir FK ile "kanıt var" diyemez, "üç belgenin üçü de kabul edildi" ise bir
CHECK'in ifade edebileceği bir şey değildir. `documentKey` kolonu yine de durur, çünkü birleşik metnin bir gün
bölünmesi bir migration olmalı, bir kolon eklemesi değil. `purchaseId @unique` bu kararın DB yarısıdır.

### 4.2 Onay kutusu

- **Ayrı** kutu: başka hiçbir onayla (iletişim paylaşımı, vitrin fiyat sorumluluğu, pazarlama) birleştirilmez.
- **Boş varsayılan**: `defaultChecked` yok, `checked` state'i sunucudan gelmiyor.
- **Zorunlu**: işaretlenmeden checkout açılmaz; sunucu `termsAccepted !== true` ise 400 `PURCHASE_TERMS_NOT_ACCEPTED`.
- Gizli alan olarak `documentVersion` gönderilir; sunucu **kendi yürürlükteki sürümüyle** karşılaştırır, uyuşmazsa
  400 `PURCHASE_TERMS_VERSION_STALE` (sayfa açıkken sürüm değişmişse yeniden gösterilir).
- Metin sunucudan gelir; istemcinin gönderdiği metin **asla** saklanmaz.

### 4.3 Sözleşmeye eklenecek maddeler (taslak — bu aşamada uygulanmaz)

> **Madde — Kredi paketlerinin iadesi.** Satın alma tarihinden itibaren on dört (14) gün içinde iade talebinde
> bulunulabilir. Satın alma sonrasında hesapta herhangi bir teklif kredisi kullanılmışsa iade yapılmaz; bu kural,
> kullanılan kredinin satın alınan paketten, bir promosyondan veya önceki bakiyeden gelmiş olmasına bakılmaksızın
> uygulanır.
>
> **Madde — Promosyon kredileri.** Satın almaya bağlı promosyon kredilerinden tek bir kredinin dahi kullanılmış
> olması hâlinde iade yapılmaz. Kullanılmamış paketin iadesinde, o paketle birlikte verilmiş kullanılmamış
> promosyon kredileri iptal edilir.
>
> **Madde — İstisnalar.** Zorunlu kanuni haklar, doğrulanmış yetkisiz işlem, çift tahsilat ve TakTic kaynaklı
> hizmet kusuru hâlleri yukarıdaki sınırlamalardan istisnadır. Bu hâllerde iade, otomatik olarak değil, TakTic'in
> yetkili incelemesi sonucunda yapılır.
>
> **Madde — [RG-1: HUKUK ONAYI BEKLİYOR] Anında ifa ve cayma hakkı.** ⟨Kredilerin hesaba anında tanımlanması ve
> kullanıma açılmasının cayma hakkına etkisine ilişkin metin.⟩

**RG-1 (release kapısı, §13):** Son madde **avukat onayı olmadan yayımlanmaz.** Mesafeli Sözleşmeler Yönetmeliği
kapsamında "anında ifa edilen hizmet / elektronik ortamda anında ifa edilen gayrimaddi mal" istisnasının bu ürüne
uygulanıp uygulanmayacağı, uygulanıyorsa **ayrı ve açık onay** metninin ne olması gerektiği hukuk kontrolü
konusudur. Bu belge hukuki görüş vermez ve mühendislik tarafı bu metni kendisi yazmaz.

### 4.4 Yayımlanacak sayfalar (PR-A kapsamı; metinler hukuk onayından sonra)

| Yol | Belge | Bugün |
| --- | --- | --- |
| `/sozlesmeler/mesafeli-satis` | Mesafeli satış sözleşmesi | **yok** |
| `/sozlesmeler/on-bilgilendirme` | Ön bilgilendirme formu | **yok** |
| `/sozlesmeler/iade-politikasi` | Paket iade politikası (D1) | **yok** |
| `/sozlesmeler/iletisim-paylasimi` | Mevcut | var, dokunulmaz |

SEO: bu sayfalar `indexEligible` sözleşmesine (SEO-003) göre işaretlenir; allowlist testi yeni `page.tsx`'leri
kırdığı için (SEO-001 notu) aynı PR'da allowlist güncellenir.

---

## 5. Veri sınıflandırması ve KVKK/operasyon notları

| Alan | Sınıf | Saklama | Erişim | Maskeleme | Audit |
| --- | --- | --- | --- | --- | --- |
| `PurchaseTermsAcceptance.clientIp` | Kişisel veri (dolaylı kimlik) | **24 ay**, sonra `NULL`'a süpürülür (sözleşmenin ispat ihtiyacı kadar) | `PACKAGE_REFUND_APPROVE` **veya** `PURCHASE_EVIDENCE_READ` | Listede **yok**; yalnız detayda | Ham okuma `SensitiveDataAccessLog` |
| `PurchaseTermsAcceptance.userAgent` | Kişisel veri (düşük) | 24 ay | aynı | Listede yok | aynı |
| `Session.ipAddress/userAgent` | Mevcut | **bu dilimde değişmez** | — | — | — |
| `ProviderBusinessRegistration.numberCanonical` | **Ticari/kişisel tanımlayıcı** (şahıs işletmesinde TCKN'ye denk) | Kayıt yaşadıkça | **yalnız** `PROVIDER_REGISTRATION_READ_SENSITIVE` | Listelerde **her zaman** `numberMasked` | **Her ham okuma** `SensitiveDataAccessLog` |
| `ProviderBusinessRegistration.fingerprint` | Türetilmiş, geri döndürülemez | Kayıt yaşadıkça | Sistem içi | — | — |
| `CampaignRegistrationCounter` | **Ham numara taşımaz** (D19) | Süresiz | Sistem içi + sayaç görüntüsü | — | — |
| `ProviderProfile.taxType/taxNumber` (eski) | Doğrulanmamış serbest metin | Aynen | Mevcut admin ekranı | **Bu dilimde değişmez** | — |
| `CampaignTriggerEvent.eligibilitySignals` | Kapalı kod listesi, **PII yok** | Event yaşadıkça | `PROMOTION_ELIGIBILITY_REVIEW` | — | — |
| `PackageRefundRequest.*Reason/Note` | İç operasyon metni | Süresiz | İlgili izin | Sağlayıcıya **gösterilmez** | — |

**Kurallar.**
1. **PII admin listelerine yayılmaz.** Liste projeksiyonları IP, UA ve ham sicil/vergi numarası **taşımaz**;
   bunlar yalnız tek kayıt detayında ve izinle döner.
2. **HMAC peppera'sı sürümlüdür.** `fingerprintVersion` kolonu, pepper rotasyonunu bir migration'a bağlar:
   rotasyon, `ProviderBusinessRegistration`'daki ham numaralardan `CampaignRegistrationCounter` satırlarının
   **yeniden hesaplanmasıyla** yapılır. Pepper'ı `.env`'de sessizce değiştirmek, aynı işletmeye ikinci bir ilk-bonus
   açar — bu **yasak** ve §13 RG-4'te release kapısıdır.
3. **IP saklama gerekçesi tek:** sözleşme kabulünün ispatı. Başka hiçbir amaçla (analitik, hedefleme, eşleştirme)
   okunmaz; `PROVIDER_PROMOTION_ELIGIBLE` bile IP'yi **ham** okumaz (§7.2).
4. `SensitiveDataAccessLog { id, actorId, subjectType, subjectId, field, purpose, readAt }` — PR-0'da doğar,
   PR-C'de sicil numarası için kullanılır.

---

## 6. RBAC: izin tabanlı yetki (PR-0, bağımsız temel dilim)

### 6.1 Model

```prisma
enum AdminPermission {          // SABİT KATALOG — panelden üretilemez (D11)
  DASHBOARD_READ
  REQUESTS_READ            REQUESTS_MANAGE          REQUEST_REPORTS_MANAGE
  CUSTOMERS_READ           CUSTOMERS_MANAGE
  PROVIDERS_READ           PROVIDERS_MANAGE         PROVIDERS_MODERATE
  PROVIDER_REGISTRATION_READ_SENSITIVE
  OFFERS_READ
  PROVIDER_REVIEWS_MODERATE
  SUPPORT_READ             SUPPORT_RESPOND
  SHOWCASE_READ            SHOWCASE_REVIEW          SHOWCASE_PLACEMENTS_MANAGE   SHOWCASE_PACKAGES_MANAGE
  CATEGORIES_READ          CATEGORIES_MANAGE
  CREDIT_PACKAGES_MANAGE
  FINANCE_READ             CREDITS_ADJUST
  PACKAGE_PURCHASES_READ
  PACKAGE_REFUND_REQUEST_CREATE
  PACKAGE_REFUND_APPROVE
  PURCHASE_EVIDENCE_READ
  CAMPAIGNS_READ           CAMPAIGNS_MANAGE         CAMPAIGN_REDEMPTIONS_REVOKE
  PROMOTION_ELIGIBILITY_REVIEW
  NOTIFICATIONS_READ
  OPERATIONS_SETTINGS_READ OPERATIONS_SETTINGS_MANAGE
  COMPANY_SETTINGS_MANAGE
  ADMIN_USERS_MANAGE       ADMIN_ROLES_MANAGE
}

model AdminRole {            // DİNAMİK — admin oluşturur/düzenler
  id String @id @default(cuid())
  key String @unique         // slug; asla yeniden kullanılmaz
  name String
  description String?
  isActive Boolean @default(true)
  createdById String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  permissions AdminRolePermission[]
  assignments AdminRoleAssignment[]
}

model AdminRolePermission { id String @id @default(cuid()) roleId String permission AdminPermission
  @@unique([roleId, permission]) }

model AdminRoleAssignment {
  id String @id @default(cuid())
  userId String  roleId String
  assignedById String  assignedAt DateTime @default(now())
  revokedAt DateTime?  revokedById String?
  // partial unique: (userId, roleId) WHERE "revokedAt" IS NULL
  @@index([userId, revokedAt])
}

model AdminRoleAuditLog { id String @id @default(cuid()) roleId String? targetUserId String?
  action AdminRoleAuditAction actorId String summary Json createdAt DateTime @default(now()) }
```

`UserRole` enum'una **`ADMIN`** eklenir (D12). Mevcut üç değerin anlamı değişmez; hiçbir satır dönüştürülmez.

### 6.2 Zorlama

| Katman | Nasıl |
| --- | --- |
| `AdminAccessGuard` | `SUPER_ADMIN` → geç. `ADMIN` → en az bir aktif atama (`revokedAt IS NULL` ∧ `role.isActive`) varsa geç, yoksa **403**. `CUSTOMER`/`PROVIDER` → 403. |
| `@RequiresPermission(P...)` + `PermissionsGuard` | `SUPER_ADMIN` → geç (örtük tüm izinler, **atama gerekmez**). Diğeri → `P ⊆ resolvedPermissions` ise geç. |
| İzin çözümü | `AuthService.getUserForSession` içinde, oturum okumasının aynı sorgusuna eklenir; `AuthUser.permissions: AdminPermission[]`. Aktif olmayan rol ve revoke edilmiş atama **sayılmaz**. |
| UI | `GET /admin/me/permissions` → nav (`nav.ts` `navGroups` filtrelenir), liste kolonları, detay blokları, aksiyon düğmeleri. **Tek kaynak** (D13). |

**Geçiş.** 72 `@Roles(UserRole.SUPER_ADMIN)` kullanımı `@UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)`
+ `@RequiresPermission(...)`'a çevrilir. `RolesGuard` ve `Roles` **silinmez** — sağlayıcı/müşteri rotalarında
kullanılmaya devam eder (`@Roles(UserRole.PROVIDER)` vb.).

### 6.3 Yetki matrisi (controller → izin)

| Controller / alan | Okuma izni | Yazma izni |
| --- | --- | --- |
| Dashboard | `DASHBOARD_READ` | — |
| Talepler, talep bildirimleri | `REQUESTS_READ` | `REQUESTS_MANAGE`, `REQUEST_REPORTS_MANAGE` |
| Hizmet alanlar | `CUSTOMERS_READ` | `CUSTOMERS_MANAGE` |
| Hizmet verenler | `PROVIDERS_READ` | `PROVIDERS_MANAGE` (profil), `PROVIDERS_MODERATE` (onay/ret/askı) |
| İşletme kaydı ham numara | `PROVIDER_REGISTRATION_READ_SENSITIVE` | `PROVIDERS_MANAGE` |
| Teklifler | `OFFERS_READ` | — |
| Değerlendirme moderasyonu | `PROVIDERS_READ` | `PROVIDER_REVIEWS_MODERATE` |
| Destek | `SUPPORT_READ` | `SUPPORT_RESPOND` |
| Vitrin | `SHOWCASE_READ` | `SHOWCASE_REVIEW`, `SHOWCASE_PLACEMENTS_MANAGE`, `SHOWCASE_PACKAGES_MANAGE` |
| Kategoriler | `CATEGORIES_READ` | `CATEGORIES_MANAGE` |
| Kredi paketleri | `PACKAGE_PURCHASES_READ` | `CREDIT_PACKAGES_MANAGE` |
| Finans / ledger | `FINANCE_READ` | `CREDITS_ADJUST` |
| Paket satın almalar | `PACKAGE_PURCHASES_READ` | — |
| **Paket iade talebi** | `PACKAGE_PURCHASES_READ` | **`PACKAGE_REFUND_REQUEST_CREATE`** |
| **Paket iade onayı/reddi** | — | **`PACKAGE_REFUND_APPROVE`** |
| Checkout kanıtı (IP/UA) | `PURCHASE_EVIDENCE_READ` | — |
| Kampanyalar | `CAMPAIGNS_READ` | `CAMPAIGNS_MANAGE`, `CAMPAIGN_REDEMPTIONS_REVOKE` |
| **Uygunluk incelemesi** | `CAMPAIGNS_READ` | **`PROMOTION_ELIGIBILITY_REVIEW`** |
| Bildirim logları | `NOTIFICATIONS_READ` | — |
| Operasyon ayarları (motor anahtarı dahil) | `OPERATIONS_SETTINGS_READ` | `OPERATIONS_SETTINGS_MANAGE` |
| Şirket ayarları | — | `COMPANY_SETTINGS_MANAGE` |
| Admin kullanıcılar / roller | `ADMIN_USERS_MANAGE` | `ADMIN_USERS_MANAGE`, `ADMIN_ROLES_MANAGE` |

**Maker-checker matris kuralı:** `PACKAGE_REFUND_REQUEST_CREATE` ve `PACKAGE_REFUND_APPROVE` **aynı role
verilebilir** (küçük ekipte kaçınılmaz), ama **aynı kayıt üzerinde aynı kişi** iki rolü oynayamaz — bu, izin
değil **satır düzeyi** kuraldır ve D5 CHECK'i ile DB'de durur.

### 6.4 API yüzeyleri (PR-0)

| Rota | İzin |
| --- | --- |
| `GET /admin/me/permissions` | `AdminAccessGuard` (izin yok) |
| `GET /admin/roles`, `GET /admin/roles/:id` | `ADMIN_ROLES_MANAGE` |
| `POST /admin/roles`, `PATCH /admin/roles/:id` | `ADMIN_ROLES_MANAGE` |
| `PUT /admin/roles/:id/permissions` | `ADMIN_ROLES_MANAGE` |
| `POST /admin/users/:id/roles`, `DELETE /admin/users/:id/roles/:roleId` | `ADMIN_USERS_MANAGE` |
| `GET /admin/permissions` (katalog) | `ADMIN_ROLES_MANAGE` |

**Yasak:** izin adı üreten/ silen rota yoktur (D11). Rol **silinmez**, `isActive = false` olur (kampanya `ENDED`
felsefesi). `SUPER_ADMIN`'ın izinleri hiçbir rotadan kısılamaz.

---

## 7. Promosyon uygunluğu ve fraud

### 7.1 Kanonik karar

```
PROVIDER_PROMOTION_ELIGIBLE = ELIGIBLE | REVIEW | INELIGIBLE
```

Motorun **önünde**, boru hattının 4. adımından sonra / 5. adımdan önce çalışır — yani **pencere, kanal ve koşul
filtrelerini geçen en az bir aday varken**. Aday yoksa karar hesaplanmaz ve event hold edilmez (boşuna operatör işi
üretmemek için).

| Karar | Motorun davranışı | Event durumu | Log |
| --- | --- | --- | --- |
| `ELIGIBLE` | 5. adıma devam (sıralama + grant) | değişmez | normal |
| `REVIEW` | Grant **yok**, hiçbir sayaç tüketilmez | **`HELD_FOR_REVIEW`** | her aday için `PROMOTION_REVIEW_HELD` |
| `INELIGIBLE` | Grant **yok**, sayaç tüketilmez | `EVALUATED` | her aday için `PROMOTION_INELIGIBLE` |

`CampaignEvaluationOutcome` enum'una üç yeni değer: `CHANNEL_MISMATCH`, `PROMOTION_REVIEW_HELD`,
`PROMOTION_INELIGIBLE`.

### 7.2 Sinyaller (ilk sürüm)

| Sinyal | Kaynak | Bugün var mı |
| --- | --- | --- |
| `PHONE_VERIFIED` | `User.phoneVerifiedAt` | ✅ |
| `PAYMENT_IDENTITY` | **yeni**: Lemon `order.customer_id`'nin HMAC'i → `PackagePurchase.paymentIdentityHash` | ❌ (`lemon-squeezy.webhook.ts:137` hiç çıkarmıyor) — PR-C'de eklenir, **ham değer asla saklanmaz** |
| `PRIOR_REFUND_OR_CHARGEBACK` | `PackagePurchase.manualReviewAt` / `status = REFUNDED` / `PackageRefundRequest.status = SETTLED` | Kısmen ✅ |
| `PRIOR_PROMO_REDEMPTION` | `CampaignRedemption` (bu sağlayıcı), `CampaignRegistrationCounter` (bu işletme) | ✅ / **yeni** |
| `BUSINESS_REGISTRATION` | `ProviderBusinessRegistration` | ❌ — PR-C |
| `SHARED_IP` / `SHARED_DEVICE` | `Session.ipAddress`, `PurchaseTermsAcceptance.clientIp` (**yalnız eşitlik karşılaştırması**, ham değer karara yazılmaz) | Kısmen ✅ |

### 7.3 Fraud karar matrisi

| Koşul | Karar | Not |
| --- | --- | --- |
| `User.phoneVerifiedAt IS NULL` | **INELIGIBLE** | `PHONE_UNVERIFIED` |
| Aynı kanonik işletme kaydı (aynı `type` + `fingerprint`) ilk-bonusu **zaten almış** | **INELIGIBLE** | `REGISTRATION_BONUS_CONSUMED` |
| Bu hesapta **SETTLED** paket iadesi veya doğrulanmış chargeback var | **INELIGIBLE** | `PRIOR_REFUND` |
| İşletme kaydı **yok** veya `NONE_DECLARED` | **REVIEW** | `REGISTRATION_MISSING` — şahıs/esnaf dışlanmaz |
| Aynı doğrulanmış telefon başka bir sağlayıcıda kullanılmış | **REVIEW** | `PHONE_SHARED` |
| `paymentIdentityHash` başka bir sağlayıcının satın almasıyla aynı | **REVIEW** | `PAYMENT_IDENTITY_SHARED` |
| Aynı IP veya cihaz kümesi | **REVIEW'a katkı** | `SHARED_IP` / `SHARED_DEVICE` — **tek başına asla engel değil (D18)** |
| Hiçbiri | **ELIGIBLE** | — |

**Öncelik:** herhangi bir `INELIGIBLE` koşulu diğerlerini ezer. `INELIGIBLE` yoksa ve en az bir `REVIEW` sinyali
varsa karar `REVIEW`. `SHARED_IP`/`SHARED_DEVICE` **tek başına** `REVIEW` üretmez — en az bir başka `REVIEW`
sinyaliyle birlikte üretir. Bu, D18'in mekanik hâlidir.

### 7.4 Yanlış pozitif ve manuel inceleme (D21, D22)

```prisma
model PromotionEligibilityReview {
  id String @id @default(cuid())
  triggerEventId String @unique          // bir event, bir karar
  providerId String
  decision PromotionEligibilityDecision  // ELIGIBLE | INELIGIBLE
  reason String                          // 1–500 (CHECK), zorunlu
  signalSnapshot Json                    // hold anındaki kapalı kod listesi (kopya, D22)
  decidedById String
  decidedAt DateTime @default(now())
}
```

- Rota: `POST /admin/campaigns/events/:id/eligibility-decision` — izin `PROMOTION_ELIGIBILITY_REVIEW`.
- `ELIGIBLE` → event `HELD_FOR_REVIEW → PENDING`; worker alır, motor karar satırını görür ve kapıyı **yeniden
  hesaplamaz** (karar yetkilinindir, sinyallerin değil).
- `INELIGIBLE` → event `EVALUATED`, `PROMOTION_INELIGIBLE` logu, grant yok, **otomatik yeniden deneme yok**.
- Satır **değiştirilemez** (update yolu yok); ikinci karar `@unique(triggerEventId)` ile reddedilir.
- Karar satırının kendisi audit kaydıdır: aktör, gerekçe, an ve dayanak snapshot'ı birlikte.
- **Tipo/şube yanlış pozitifi:** aynı sicil numarasını iki farklı gerçek işletme taşımaz, ama yanlış girilmiş bir
  numara taşır. Bu yüzden `REGISTRATION_BONUS_CONSUMED` hariç her sinyal `REVIEW` üretir ve `REVIEW`'da karar
  insanındır. `REGISTRATION_BONUS_CONSUMED`'in `INELIGIBLE` olması kasıtlıdır: sayaç, doğrulanmış bir kayda bağlıdır.

### 7.5 Kanonik işletme kaydı (D19, D20)

```prisma
enum BusinessRegistrationType {
  TRADE_REGISTRY          // Ticaret sicil numarası
  MERSIS                  // MERSİS numarası
  TAX_NUMBER              // Vergi kimlik numarası (tüzel kişi)
  CRAFTSMAN_REGISTRY      // Esnaf ve sanatkâr sicil numarası
  SOLE_PROPRIETOR_TR_ID   // Şahıs işletmesi (vergi no = TCKN)
  NONE_DECLARED           // Beyan edilmedi — REVIEW üretir, INELIGIBLE değil
}

model ProviderBusinessRegistration {
  id String @id @default(cuid())
  providerId String @unique
  type BusinessRegistrationType
  numberCanonical String?        // normalize (trim, büyük harf, yalnız izinli karakter) — HAM, tek yer
  numberMasked String?           // listeler için: son 2 hane dışında '*'
  fingerprint String?            // HMAC-SHA256(pepper_v, type + ':' + numberCanonical)
  fingerprintVersion Int?
  verifiedAt DateTime?  verifiedById String?
  createdAt DateTime @default(now())  updatedAt DateTime @updatedAt
  // CHECK: type = 'NONE_DECLARED' XOR (numberCanonical IS NOT NULL AND fingerprint IS NOT NULL)
  @@index([type, fingerprint])
}

model CampaignRegistrationCounter {     // HAM NUMARA TAŞIMAZ (D19)
  id String @id @default(cuid())
  registrationType BusinessRegistrationType
  fingerprint String
  fingerprintVersion Int
  firstBonusRedemptionId String? @unique
  redemptionCount Int @default(0)
  createdAt DateTime @default(now())  updatedAt DateTime @updatedAt
  @@unique([registrationType, fingerprint, fingerprintVersion])
}
```

- **Benzersizlik `ProviderProfile` üzerinde zorlanmaz.** İki sağlayıcı aynı numarayı taşıyabilir (tipo, şube);
  bunu DB reddederse başvuru akışı kırılır. Kural sayaçtadır: **kanonik kayıt başına bir ilk-bonus**.
- Aynı doğrulanmış telefon: `User.phone @unique` zaten var; farklı hesapta aynı numara **imkânsız**. `PHONE_SHARED`
  sinyali bu yüzden *geçmişte* o numarayı taşımış bir hesabı (telefon değişikliği) yakalar.
- **Eski `taxType/taxNumber` dönüştürülmez (D20).** Migration DML içermez. Admin ekranı eski alanları
  "doğrulanmamış beyan" etiketiyle göstermeye devam eder; kanonik kayıt ayrı bir bloktur.
- **Pepper rotasyonu = migration** (§5 kural 2, RG-4).

### 7.6 Başvuru ve şirket bilgisi yüzeyi

- Web sağlayıcı başvuru formuna (`provider-application-fields.tsx`) **tür seçimi + numara** alanı eklenir;
  `NONE_DECLARED` seçilebilir ve başvuruyu engellemez.
- Admin sağlayıcı detayında kanonik kayıt bloğu: tür + **maskeli** numara; "ham değeri göster" aksiyonu
  `PROVIDER_REGISTRATION_READ_SENSITIVE` ister ve her tıklama `SensitiveDataAccessLog`'a yazar.
- Sağlayıcı kendi numarasını kendi panelinde görür (kendi verisi), maskesiz — audit yazılmaz.

---

## 8. Kampanya kanalı

### 8.1 Model

```prisma
enum CampaignChannel { WEB MOBILE ALL }   // CampaignVersion.channel, varsayılan ALL
enum SourceChannel   { WEB MOBILE UNKNOWN } // olay/işlem kaynağı
```

- `CampaignVersion.channel CampaignChannel @default(ALL)` — sürüm değişmez olduğundan mevcut satırların `ALL`
  olması gerçek backfill'dir: bugüne kadar hiçbir kampanya kanal ayrımı yapmadı.
- `CampaignTriggerEvent.sourceChannel SourceChannel @default(UNKNOWN)` — **insert'ten sonra değişmez** (D23).
- `PackagePurchase.sourceChannel SourceChannel @default(UNKNOWN)` — checkout açılırken yazılır.
- `ProviderProfile.applicationSourceChannel SourceChannel @default(UNKNOWN)` — başvuru alınırken yazılır.
- `packages/shared/campaign-rules.json`: `channels: ["WEB","MOBILE","ALL"]` + `activationErrorCodes`'a
  `CHANNEL_SOURCE_UNAVAILABLE`. **Koşul (condition) eklenmez** — kanal bir DSL koşulu değil, sürüm alanıdır.

### 8.2 Kanal olay matrisi

| Tetikleyici | Kanal nereden türer | Kalıcılık | `UNKNOWN` ne zaman |
| --- | --- | --- | --- |
| `PACKAGE_PAYMENT_SUCCEEDED` | `PackagePurchase.sourceChannel` — **checkout'u açan HTTP isteğinden** (`payments.controller.ts` → `readRequestMeta`) | Satın alma satırında; webhook asenkron olduğu için istekten okunamaz | Bu migration'dan önceki satın almalar; mock/admin yolu |
| `PROVIDER_APPROVED` | `ProviderProfile.applicationSourceChannel` — **başvurunun** alındığı kanal | Profil satırında | Admin'in elle oluşturduğu profil; eski satırlar |
| `PROVIDER_ELIGIBILITY_REACHED` | Seti **tamamlayan son kanıtın** kanalı (e-posta doğrulama isteği veya telefon OTP isteği) | `CampaignTriggerEvent.sourceChannel`, hook çağrısında verilir | Kanalı bilinmeyen yollar; eski satırlar |

**Neden onay için başvurunun kanalı:** `PROVIDER_APPROVED` olayını yazan HTTP isteği **operatörün** isteğidir
(`providers.service.ts:1043`). Operatörün tarayıcısı hak edişi doğuran işlemin kanalı değildir; sağlayıcının
işletmeyle TakTic'e girdiği kanal odur.

### 8.3 Eşleşme kuralı (D25)

| Sürüm `channel` | Olay `sourceChannel` | Sonuç |
| --- | --- | --- |
| `ALL` | `WEB` / `MOBILE` / `UNKNOWN` | **eşleşir** |
| `WEB` | `WEB` | eşleşir |
| `WEB` | `MOBILE` | `CHANNEL_MISMATCH` |
| `WEB` | `UNKNOWN` | `CHANNEL_MISMATCH` — **fail-closed** |
| `MOBILE` | `MOBILE` | eşleşir |
| `MOBILE` | `WEB` / `UNKNOWN` | `CHANNEL_MISMATCH` |

Filtre, boru hattının **4. adımında** pencere kontrolünün hemen ardından, koşullardan **önce** çalışır
(`campaign-engine.service.ts:243` civarı) — ucuz ve I/O gerektirmeyen bir eleme, pahalı fact okumasının önüne geçer.

### 8.4 Mobil istemci yokken (D26)

`ChannelSourceRegistry`, `FactSourceRegistry`'nin (`engine/fact-source-registry.ts`) birebir ikizi:

- Bir modül boot'ta `registerChannelSource('WEB', { module: 'payments' })` der.
- Aktivasyon kapısı: `channel = MOBILE` olan bir sürüm, kayıtlı `MOBILE` kaynağı yokken **aktive edilemez** →
  409 `CHANNEL_SOURCE_UNAVAILABLE` (`FACT_SOURCE_UNAVAILABLE` ile aynı sözleşme).
- Admin kampanya builder'ı `MOBILE` seçildiğinde uyarı gösterir: *"Mobil istemci henüz yayında değil; bu kampanya
  hiçbir hak ediş üretmez."* Uyarı kaydetmeyi engellemez (taslak yazılabilir), **aktivasyonu** engelleyen sunucudur.

### 8.5 Değişmezler (invariant)

| # | Invariant | Nasıl durur |
| --- | --- | --- |
| **I1** | `triggerEventKey` kanal içermez | `trigger-event-key.ts` değişmez; test anahtarın üç biçimini aynen doğrular |
| **I2** | `CampaignTriggerEvent.sourceChannel` insert'ten sonra değişmez | `ensurePendingEvent` yalnız `create`'te yazar; `update` yolunda alan **yoktur**; test: aynı anahtar ikinci kez farklı kanalla raise edilir → satır değişmez |
| **I3** | Kanal değişimi ikinci grant üretemez | I1 + I2 + mevcut `@@unique([campaignId, triggerEventKey])` |
| **I4** | `ALL` bugünkü davranıştır | Mevcut tüm sürümler `ALL`; `ALL` + `UNKNOWN` eşleşir → hiçbir mevcut senaryo değişmez |
| **I5** | Ayrımcı sürüm bilinmeyen kaynağa hak ediş vermez | D25 tablosu; test: `WEB` sürüm + `UNKNOWN` olay → `CHANNEL_MISMATCH`, grant yok |
| **I6** | Stack politikası kanaldan etkilenmez | `EXCLUSIVE_CREDIT_BONUS` sıralaması (kredi → priority → id) değişmez; kanal yalnız aday **elemesidir** |
| **I7** | Idempotency değişmez | `PromoCreditLot`, `CampaignRedemption`, sayaçlar ve savepoint akışı dokunulmaz |

---

## 9. Önerilen migration'lar

| # | Ad | İçerik | DML |
| --- | --- | --- | --- |
| **H** (PR-0) | `add_admin_rbac` | `UserRole` += `ADMIN`; `AdminPermission` enum; `AdminRole`, `AdminRolePermission`, `AdminRoleAssignment` (partial unique), `AdminRoleAuditLog`, `SensitiveDataAccessLog` | **Yok** — mevcut `SUPER_ADMIN` hesapları aynen kalır ve örtük tüm izinlere sahiptir |
| **I** (PR-A) | `add_purchase_terms_acceptance` | `SourceChannel` enum; `PurchaseTermsAcceptance`; `PackagePurchase.purchaseTermsAcceptanceId` + `sourceChannel`; CHECK `PackagePurchase_terms_acceptance_required` (zaman eşikli, D9) | **Yok** |
| **J** (PR-B) | `add_package_refund_requests` | `SupportTicketTopic` enum + `SupportTicket.topic` (`@default(GENERAL)`) + `packagePurchaseId` + 2 CHECK; `PackageRefundRequest*` enum'ları; `PackageRefundRequest` + D5/D4/§3.4 CHECK'leri + `settledByWebhookEventId @unique` + 2 partial unique | **Yok** (`topic` varsayılanı gerçek backfill) |
| **K** (PR-C) | `add_business_registration_and_eligibility` | `BusinessRegistrationType`, `PromotionEligibilityDecision` enum'ları; `ProviderBusinessRegistration`; `CampaignRegistrationCounter`; `PackagePurchase.paymentIdentityHash`; `CampaignTriggerEventStatus` += `HELD_FOR_REVIEW`; `CampaignEvaluationOutcome` += `PROMOTION_REVIEW_HELD`, `PROMOTION_INELIGIBLE`; `CampaignTriggerEvent.eligibilitySignals/eligibilityHeldAt`; `PromotionEligibilityReview` | **Yok** — `taxType/taxNumber` dönüştürülmez (D20) |
| **L** (PR-D) | `add_campaign_channel` | `CampaignChannel` enum; `CampaignVersion.channel @default(ALL)`; `CampaignTriggerEvent.sourceChannel @default(UNKNOWN)`; `ProviderProfile.applicationSourceChannel @default(UNKNOWN)`; `CampaignEvaluationOutcome` += `CHANNEL_MISMATCH` | **Yok** — varsayılanlar gerçek backfill (D23, I4) |

**Kural:** hiçbiri `ALTER COLUMN ... SET NOT NULL` ve hiçbiri DML içermez. Her biri izole geçici DB'de
`migrate deploy` + `migrate diff` dry-run ile doğrulanır ve çıktısı `docs/superpowers/plans/` altına yazılır
(CMP-004 G örüntüsü). **Gerçek yerel/staging DB'ye dokunulmaz.**

---

## 10. API ve UI yüzeyleri

### 10.1 API (dilim başına)

| PR | Rota | İzin / guard |
| --- | --- | --- |
| 0 | `GET /admin/me/permissions` | `AdminAccessGuard` |
| 0 | `GET/POST/PATCH /admin/roles*`, `PUT /admin/roles/:id/permissions`, `GET /admin/permissions` | `ADMIN_ROLES_MANAGE` |
| 0 | `POST/DELETE /admin/users/:id/roles*` | `ADMIN_USERS_MANAGE` |
| A | `GET /package-refund-policy` (public) | — |
| A | `POST /providers/:providerId/checkout-sessions` **gövdeye `termsAccepted` + `termsVersion` ekler** | mevcut `ProviderAccessGuard` + PROVIDER |
| A | `GET /admin/package-purchases/:id/terms-acceptance` | `PURCHASE_EVIDENCE_READ` |
| B | `POST /support-tickets` **gövdeye `topic` + `packagePurchaseId` ekler** | mevcut (PROVIDER) |
| B | `GET /providers/me/package-purchases/refundable` (kendi paket listesi, form için) | PROVIDER, oturumdan |
| B | `GET /admin/package-refund-requests`, `GET /admin/package-refund-requests/:id` | `PACKAGE_PURCHASES_READ` |
| B | `POST /admin/package-refund-requests/:id/take` | `PACKAGE_REFUND_REQUEST_CREATE` |
| B | `POST /admin/package-refund-requests/:id/approve` / `/reject` / `/abandon` | `PACKAGE_REFUND_APPROVE` |
| C | `PUT /admin/providers/:id/business-registration` | `PROVIDERS_MANAGE` |
| C | `GET /admin/providers/:id/business-registration/raw` | `PROVIDER_REGISTRATION_READ_SENSITIVE` (+ audit) |
| C | `GET /admin/campaigns/events?status=HELD_FOR_REVIEW` | `CAMPAIGNS_READ` |
| C | `POST /admin/campaigns/events/:id/eligibility-decision` | `PROMOTION_ELIGIBILITY_REVIEW` |
| D | `POST /admin/campaigns/:id/versions` **`definition.channel` kabul eder** | `CAMPAIGNS_MANAGE` |

**`SETTLED` yazan bir rota yoktur** (D4).

### 10.2 UI

| PR | Yüzey |
| --- | --- |
| 0 | Admin: Roller listesi/detayı (izin matrisi onay kutuları), kullanıcı detayında rol atama; `nav.ts` izinle filtrelenir; her liste/detay/aksiyon izin kontrollü |
| A | Web: teklif kredisi checkout'unda **ayrı, boş, zorunlu** onay kutusu + üç sözleşme bağlantısı; `/sozlesmeler/mesafeli-satis`, `/on-bilgilendirme`, `/iade-politikasi` sayfaları; Admin: satın alma detayında "Sözleşme kanıtı" bloğu (sürüm, hash, an; IP/UA izinliyse) |
| B | Web: destek formunda konu seçimi + kendi paket seçimi; Admin: "Paket iade talepleri" kuyruğu, detayda uygunluk tavsiyesi + maker/checker şeridi + istisna gerekçesi + kredi geri alım alanı |
| C | Web: başvuruda işletme kaydı türü + numara; Admin: sağlayıcı detayında kanonik kayıt bloğu (maskeli + "göster" aksiyonu), "Uygunluk incelemesi" kuyruğu (snapshot + gerekçe formu) |
| D | Admin: kampanya builder'ında kanal seçimi + `MOBILE` uyarısı; kampanya detayında kanal rozeti; event listesinde kaynak kanal kolonu |

---

## 11. Test planı

### 11.1 Birim / entegre (api)

| # | Test | Kapsadığı karar |
| --- | --- | --- |
| T1 | `approvedById = NULL` ile `APPROVED_PENDING_SETTLEMENT` yazımı **DB tarafından** reddedilir | D5 (NULL kaçağı) |
| T2 | `approvedById = createdById` reddedilir | D5 |
| T3 | Hiçbir admin rotası `SETTLED` yazamaz; `settledByWebhookEventId = NULL` ile `SETTLED` DB'de reddedilir | D4 |
| T4 | Aynı `order_refunded` olayının ikinci teslimi ikinci settle/clawback üretmez | D6, D27 |
| T5 | Bir webhook olayı iki talebi settle edemez (`@unique`) | D6 |
| T6 | Talebi olmayan iade: bayrak + S3 revoke **bugünküyle bire bir**, hiçbir talep settle edilmez | D7 |
| T7 | Aynı paket için ikinci açık talep 409 | D15 |
| T8 | Başkasının `purchaseId`'si → 404 (403 değil) | D16 |
| T9 | Kanıtsız satın alma yazımı CHECK ile reddedilir; kabul + satın alma **aynı tx**, biri yoksa ikisi de yok | D9 |
| T10 | `termsVersion` bayat → 400, satır yazılmaz | §4.2 |
| T11 | `SUPER_ADMIN` **hiç rol ataması olmadan** tüm izinli rotaları geçer | D12 |
| T12 | `ADMIN` + atama yok → admin rotalarında 403 (UI'a değil API'ye) | D12 |
| T13 | Rol `isActive = false` / atama `revokedAt` dolu → izin sayılmaz | §6.2 |
| T14 | `GET /admin/me/permissions` ile guard'ların kabul ettiği küme **aynıdır** (her izin için tablo testi) | D13 |
| T15 | İzin adı üreten rota yoktur; bilinmeyen izin adı 400 | D11 |
| T16 | `CampaignRegistrationCounter` satırında ham numara **hiçbir kolonda geçmez** (string araması) | D19 |
| T17 | Migration K sonrası hiçbir `ProviderBusinessRegistration` satırı doğmaz (DML yok) | D20 |
| T18 | Telefonsuz sağlayıcı → `INELIGIBLE`; yalnız `SHARED_IP` → `ELIGIBLE` (tek başına engel değil) | D18, §7.3 |
| T19 | `REVIEW` → event `HELD_FOR_REVIEW`, **hiçbir sayaç/bütçe tüketilmez**, worker onu **claim etmez** | D21 |
| T20 | `HELD_FOR_REVIEW` kararı gerekçesiz reddedilir; ikinci karar `@unique` ile reddedilir | D21 |
| T21 | Karar sonrası hold anındaki snapshot değişmez (ikinci hold eski kararı etkilemez) | D22 |
| T22 | `triggerEventKey` üç biçimini aynen korur — kanal **girmez** | I1 |
| T23 | Aynı anahtar farklı kanalla yeniden raise → satırın `sourceChannel`'ı değişmez, ikinci redemption yok | I2, I3 |
| T24 | D25 tablosunun altı satırı (özellikle `WEB` + `UNKNOWN` → `CHANNEL_MISMATCH`) | D25, I5 |
| T25 | Kayıtlı `MOBILE` kaynağı yokken `channel = MOBILE` aktivasyonu 409 `CHANNEL_SOURCE_UNAVAILABLE` | D26 |
| T26 | Motor **kapalıyken**: PR-A…PR-D hiçbir yeni tablo satırı doğurmaz (kampanya tarafında sıfır yazı) | §13 |
| T27 | Clawback bakiyeyi negatife düşürmez; eksik `clawbackShortfallCredits`'e yazılır, borç yok | D27 |
| T28 | Teklif kredisi iadesi (`OfferRefundSettlement`, `GET /refund-policy`) **bire bir korunur** | D0 |

### 11.2 E2E (Playwright)

| # | Senaryo |
| --- | --- |
| E1 | Yeni rol oluştur → izin ata → kullanıcıya ata → o kullanıcının menüsünde yalnız izinli bölümler; izinsiz URL'e doğrudan gidiş 403 sayfası |
| E2 | `SUPER_ADMIN` her şeyi görür, rol atanmamışken bile |
| E3 | Checkout: kutu işaretlenmeden düğme pasif; işaretlenip ödeme → admin satın alma detayında kanıt bloğu |
| E4 | Sağlayıcı destek formu: "Paket ve kredi iadesi" + kendi paketi → admin kuyruğunda DRAFT talep; aynı paket için ikinci deneme engellenir |
| E5 | Maker onaylayamaz (düğme yok + API 403/409); ikinci yetkili onaylar → `APPROVED_PENDING_SETTLEMENT` |
| E6 | Lemon stub'dan `order_refunded` → talep `SETTLED`, promosyon revoke, ikinci teslim etkisiz |
| E7 | `HELD_FOR_REVIEW` kuyruğu: snapshot görünür, gerekçesiz karar reddedilir, `INELIGIBLE` sonrası grant yok |
| E8 | Kampanya builder'da `MOBILE` seçimi uyarı gösterir; aktivasyon reddedilir |

**E2E tuzakları (mevcut notlar):** `pnpm e2e <filtre>` (`--` yok); WebKit taze DB; aynı param'a yönlendiren
action yarışı; fixture adı/HTML assertion çakışması; `DATABASE_URL` export + `pnpm db:generate` (worktree'de
`.env` yok).

---

## 12. Uygulama PR'ları (en küçük bağımsız dilimler)

| PR | Ad | Bağımlılık | İçerik | Migration |
| --- | --- | --- | --- | --- |
| **PR-0** | RBAC temeli — izin tabanlı admin yetkisi | — | `AdminPermission` katalogu, `AdminRole`/`AdminRolePermission`/`AdminRoleAssignment`, `AdminAccessGuard` + `PermissionsGuard`, 72 rotanın izne çevrilmesi, `GET /admin/me/permissions`, `nav.ts` filtresi, rol yönetim ekranları, `SensitiveDataAccessLog` | **H** |
| **PR-A** | Paket iade politikası + checkout kanıtı | **PR-0** (kanıt okuma yüzeyi `PURCHASE_EVIDENCE_READ` iznine bağlı) | `PurchaseTermsAcceptance`, checkout onay kutusu, üç sözleşme sayfası, `GET /package-refund-policy`, `readRequestMeta`, admin kanıt bloğu | **I** |
| **PR-B** | İstisna iade: destek girişi + maker-checker + webhook mutabakatı | **PR-0**, **PR-A** | `SupportTicket.topic`/`packagePurchaseId`, sağlayıcı formu, `PackageRefundRequest` + durum makinesi, admin kuyruğu, `flagForManualReview` içinde settle + clawback | **J** |
| **PR-C** | İşletme kaydı + promosyon uygunluk kararı | **PR-0**, **PR-B** | `ProviderBusinessRegistration`, `CampaignRegistrationCounter`, `paymentIdentityHash`, uygunluk servisi, `HELD_FOR_REVIEW`, `PromotionEligibilityReview`, inceleme kuyruğu | **K** |
| **PR-D** | Kampanya kanalı | **PR-C** (yeni outcome değerleri aynı enum'da) | `CampaignChannel`, `sourceChannel` üç kaynağı, eşleşme filtresi, `ChannelSourceRegistry`, aktivasyon kapısı, builder UI | **L** |

Her PR: kendi tasarım/teslim notu, izole migration dry-run çıktısı, CI 3/3, motor anahtarı kapalı.

---

## 13. Release kapıları

| # | Kapı | Neyi engeller | Kim açar |
| --- | --- | --- | --- |
| **RG-1** | **Hukuk onayı — anında ifa ve cayma hakkı.** §4.3'ün son maddesi ve "anında ifa" onayının biçimi avukat onayı almadan yayımlanmaz. Mühendislik metni kendisi yazmaz. | PR-A'nın **üretime** çıkışı (kod merge edilebilir, sözleşme metni placeholder kalır) | Hukuk |
| **RG-2** | **KVKK — IP/UA ve sicil numarası.** Saklama süresi (24 ay), erişim kısıtı, maskeleme ve audit §5'e uygun; aydınlatma metni güncellenmiş | PR-A ve PR-C'nin üretime çıkışı | KVKK sorumlusu |
| **RG-3** | **Mutabakat prosedürü.** Lemon panelinde iade yapan operatörün adımları, `APPROVED_PENDING_SETTLEMENT`'ta bekleyen talebin SLA'sı ve webhook gelmezse ne olacağı (→ `SETTLEMENT_ABANDONED`) yazılı | PR-B üretimi | Operasyon |
| **RG-4** | **HMAC pepper yönetimi.** Pepper üretilmiş, gizli tutulmuş ve **rotasyonun bir migration olduğu** yazılı; `.env`'de sessiz değişim yasak | PR-C üretimi | Operasyon + mühendislik |
| **RG-5** | **Motor anahtarı kapalı kalır.** PR-0…PR-D'nin hiçbiri `campaignEngineEnabled`'ı açmaz; yerel ve staging'de kapalı doğrulanır. Motorun açılması ayrı bir karardır ve CMP-002 S2B1 ön koşullarına ek olarak RG-1…RG-4'e bağlıdır | Motorun açılması | Ürün sahibi |
| **RG-6** | **`ADMIN` hesabı üretimi.** `UserRole.ADMIN` hesapları yalnız mevcut davet akışıyla ve en az bir rol atamasıyla doğar; atamasız `ADMIN` hesabı panele giremez (T12) | PR-0 üretimi | Mühendislik |

---

## 14. Kapsam dışı (bu belgede kasıtlı olarak yok)

- Ödeme sağlayıcısına sunucudan iade çağrısı (`PaymentProviderPort` değişmez) — D3.
- Sağlayıcıya self-service para iadesi — D2.
- Kısmi (partial) iade; yalnız tam iade modellenir.
- Teklif kredisi iade politikasının, S4 net-iade sözleşmesinin veya S3 revoke'un değiştirilmesi — D0, §3.5.
- Kampanya DSL'ine yeni koşul türü — D17.
- Mevcut `taxType/taxNumber` alanlarının taşınması/silinmesi — D20.
- Mobil istemci — yalnız kanal sözleşmesi hazırlanır.
- `Session.ipAddress/userAgent` retention'ının değiştirilmesi.
