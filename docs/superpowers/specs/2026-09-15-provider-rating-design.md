# Hizmet veren puanlama ve müşteri değerlendirmesi — keşif ve teknik tasarım

> **Yerine geçen doküman:** `docs/superpowers/plans/2026-09-15-provider-rating-design-and-plan.md`
> (kesin kararlar: 90 gün pencere, public eşik 3, aggregate her yüzeyde). Bu taslak keşif kaydı olarak kalır.

Tarih: 2026-09-15 · Durum: **taslak (rev. 1) — kesinleştirildi, bkz. üstteki not** · Önceki iş: anında yayın +
talep bildirimi (PR #77), CI tmpfs (PR #78), kimlik gate (PR #75)

Bu doküman yalnız tasarımdır: kod, migration, PR ya da veri üretilmemiştir. Mevcut
davranışa dair her iddia dosya/satır ya da test kanıtıyla bağlanmıştır; satır numaraları
`main`'in `59c45b88` durumuna aittir.

## 0. Karar, hedef, kapsam

**Karar.** Puanlama yalnız gerçek iş ilişkisine dayanır: bir talebin sahibi olan müşteri,
talep `COMPLETED` olduktan sonra, o talepte **kabul edilmiş teklifin sahibi** hizmet vereni
1–5 yıldızla değerlendirir; kısa yorum isteğe bağlıdır. `request + provider` çifti için tek
değerlendirme vardır. Hizmet veren puan veremez, değiştiremez, silemez. Yorumlar ön onaysız
yayınlanır; hizmet veren uygunsuz yorumu bildirir, admin sonradan kaldırır (otomatik gizleme
eşiği yoktur). Kaldırma aggregate'i etkiler, geçmiş korunur. Kamuya yalnız aggregate +
anonim son yorumlar gösterilir; değerlendirme hiçbir kredi, iade, ödeme ya da vitrin hakkını
etkilemez.

**Tek cümleyle çözüm.** Mevcut `POST /service-requests/:id/complete` geçişi (tek yazıcı:
sahibi müşteri ya da SUPER_ADMIN) davetin tetiğidir; `ProviderReview` (+ `ProviderReviewReport`,
`ProviderReviewModeration`) tabloları eklenir; hizmet veren **istemciden alınmaz**, sunucuda
`ServiceRequest.matchedOfferId → Offer.providerId` zincirinden türetilir; aggregate anlık
sorguyla hesaplanır (denormalize sayaç yok); bildirimler mevcut `NotificationLog` +
`(template, dedupeKey)` modeline dört yeni şablonla bağlanır; admin kuyruğu
`ServiceRequestReport` deseninin birebir kopyasıdır.

**Kapsam dışı.** Sağlayıcının yoruma yanıt hakkı, müşteriyi puanlama, puana göre sıralama /
eşleştirme, puan eşiğiyle otomatik askıya alma, SMS bildirimi, vitrin sıralamasında puan
kullanımı. Hiçbiri bu tasarımı kilitlemez; hepsi ek (additive) olarak sonra gelebilir.

---

## 1. Keşif: bugünkü akışlar

### 1.1 `COMPLETED` geçişi — kim, hangi yetkiyle, ne zaman (Soru 1)

| Konu | Kanıt | Bugün |
|---|---|---|
| Yaşam döngüsü sözleşmesi | `prisma/schema.prisma:102-121` | `DRAFT → SUBMITTED → IN_REVIEW → APPROVED → MATCHED → COMPLETED`. Şema yorumu: "COMPLETED and CANCELLED only by the dedicated lifecycle endpoints — never by the admin moderation dropdown". |
| Moderasyon dropdown'u `COMPLETED` yazamaz | `service-requests.service.ts:186-190` (`nonModerationStatuses`) | `MATCHED`, `COMPLETED`, `EXPIRED` moderasyon uç noktasından yazılamaz. |
| Tek yazıcı | `service-requests.controller.ts:110-115` | `POST /service-requests/:id/complete`, `AuthGuard + RolesGuard`, `@Roles(CUSTOMER, SUPER_ADMIN)`. |
| Yetki predikatı | `service-requests.service.ts:1154-1176` (`getRequestForLifecycleAction`) | SUPER_ADMIN her zaman; aksi halde `role === CUSTOMER && request.customerId === user.id`, değilse 403. **Provider kendi işini tamamlayamaz** (yorum: "a provider cannot declare its own job finished"). |
| Geçiş | `service-requests.service.ts:1096-1114` | Ön kontrol `status === MATCHED`, sonra **koşullu** `updateMany({ where: { id, status: MATCHED }, data: { status: COMPLETED, completedAt: now } })`; `count !== 1` → 409. Transaction yok, **bildirim yok**, lead kapatma yok. |
| Terminal küme | `service-requests.service.ts:209-214` | `COMPLETED`, `CANCELLED`, `EXPIRED`, `REJECTED` — `COMPLETED` sonrası hiçbir geçiş yok. |
| Müşteri ekranı | `apps/web/app/requests/[id]/offers/page.tsx:106-113`, `actions.ts:12-21` | Yalnız `MATCHED` iken "Hizmet tamamlandı" düğmesi; server action `/complete` çağırıp `/requests/my` ve teklif sayfasını revalidate eder. Sayfa oturumsuz müşteriyi login'e yollar (`page.tsx:30-33`). |
| Admin ekranı | `apps/admin/app/requests/actions.ts:62-69` | Aynı uç nokta; admin müşteri adına tamamlayabilir. |
| Test kanıtı | `apps/api/test/request-lifecycle.spec.ts:146-185` | `approvedAt` `MATCHED → COMPLETED` boyunca korunur; `/complete` müşteri oturumuyla çağrılır. |

**Doğru tetik noktası.** `completeServiceRequest` içindeki koşullu `updateMany`'nin
`count === 1` döndüğü an: bu, "iş gerçekten bugün bitti" olayının tek ve idempotent yazıcısı.
Davet burada, commit sonrası, `review-invitation:<requestId>` dedupe anahtarıyla gönderilir
(§5). Ekranda ise `completeRequestAction` tamamlamadan sonra doğrudan değerlendirme sayfasına
yönlendirir; e-posta yalnız "sonra dönerse" yoludur.

### 1.2 Bağlı akışlar

| Akış | Kanıt | Tasarımı etkileyen olgu |
|---|---|---|
| Teklif kabulü → `MATCHED` | `offers.service.ts:538-689` (`acceptRequestOffer`) | Serializable tx'te `updateMany({status: APPROVED, matchedOfferId: null})` → `MATCHED`, `matchedOfferId`, `matchedAt` (`:590-605`); kazanan teklif `ACCEPTED` (`:611-626`); rakipler `REJECTED/COMPETITOR_ACCEPTED`; partial unique `Offer_one_accepted_per_request` (`schema.prisma:1343-1348`). **`matchedOfferId` unique** (`schema.prisma:882`). |
| Kabul eden kim olabilir | `controller:81-90` (`OptionalAuthGuard`), `offers.service.ts:761-777` (`ensureCustomerCanAccessRequest`) | `customerId` NULL talepte misafir link sahibi kabul edebilir; ancak **`/complete` her zaman oturum ister** — dolayısıyla değerlendirme yapabilecek herkes zaten oturumlu CUSTOMER'dır. |
| Talep hep bir müşteriye bağlanır | `service-requests.service.ts:1283-1336` (`resolveCustomerForCreate`) | Oturumsuz talep bile telefon/e-posta eşleşmesiyle mevcut CUSTOMER'a bağlanır ya da `AUTO_CREATED_REQUEST` kullanıcı açılır. `customerId` NULL yalnız eski satırlarda (backfill scripti `scripts/backfill-request-customers.ts`). |
| Contact reveal | `schema.prisma:943-973`, `offers.service.ts:672-680` | Yalnız contact sharing açıkken, kabul tx'i içinde tek satır; "Immutable by contract". Değerlendirme reveal'a **bağlı değildir** (flag kapalıyken de iş biter). |
| Mesajlaşma | `messaging.service.ts:444-455` | Yalnız `MATCHED` talepte açık; `COMPLETED` sonrası kapanır. Yorum, işten sonra tarafların tek "kanalı" olur → PII filtresi zorunlu (§7). |
| Vitrin direct lead | `providers.service.ts:1372-1389` | Kart sahibi teklif verince `SUBMITTED → APPROVED` (koşullu) + lead `ANSWERED`; sonrası **aynı** `Offer`/`ServiceRequest`/`acceptRequestOffer`/`complete` zinciri. `ServiceRequest.showcaseLeadId` asla silinmez (`schema.prisma:861-866`). Tek puan sistemi doğal olarak kapsar. |
| Talep bildirimi (moderasyon deseni) | `request-reports.service.ts:48-85, 98-170, 246-292`; `schema.prisma:3467-3495`; migration `20260914120000` | Append-only satır; `@@unique([requestId, reporterProviderId])`; günlük 20 bütçe (DB sayımı); P2002 → 409 `REPORT_ALREADY_EXISTS`; kuyruk talep başına gruplu, cursor'lu, `open/resolved`; karar serializable tx'te tüm açık raporları kapatır; CHECK `("resolvedAt" IS NULL) = ("resolution" IS NULL)`; partial index `WHERE "resolvedAt" IS NULL`; destek kutusuna `request-report-new-for-support` maili. **Otomatik gizleme yok** ("A report never hides anything by itself"). |
| Bildirim/dedupe | `schema.prisma:1015-1083` (`@@unique([template, dedupeKey])` `:1070`), `notification-dispatcher.service.ts:20-34, 118-130`, `transactional-mail.service.ts:288-330, 992-1010, 2494+` | `sendEmailOnce` + `(template, dedupeKey)` unique = "one mail per real transition"; admin retry `composeRetryMessage` → `parseRetrySource` → `rebuild` şablon başına canlı veriden yeniden kurar (`RETRY_DEDUPE_PREFIXES`). Outbox niyet satırı deseni (`notification-intents.ts:57, 121`) scheduler kaynaklı geçişler için; commit sonrası doğrudan gönderim (`offers.service.ts:301-310` `notify`) kullanıcı aksiyonları için. |
| Şablon kayıt defteri | `templates/transactional-templates.ts:76-175`; `transactional-email-render.spec.ts:520` | 41 şablon; render testi `toHaveLength(41)` ve `FULL_DATA` anahtar eşitliğini kilitler. Yorum satırı `:45`: "`provider_rating`, `provider_job_count` — **there is no rating system**". |
| Public sağlayıcı projeksiyonu | `providers.controller.ts:211-215`, `providers.service.ts:427-452, 1941-1945, 1975-1992` | `GET /providers/:id` oturumsuz → yalnız `APPROVED` (aksi 404); `toPublicProvider` **allow-list**: id, businessName, city, district, description, status, createdAt, kategoriler, alanlar. Telefon/e-posta/contactName yok. Web'de bu projeksiyonu render eden **public sayfa yok** (`apps/web/app/providers/[id]/page.tsx:27-33` public görünümü `notFound()` eder). |
| Sağlayıcı panel özeti | `providers.service.ts:743-776`; `apps/web/app/providers/[id]/page.tsx:41-47` | Dashboard: kredi, aktif teklif, toplam teklif, uygun talep sayısı. Panel yorumu: "an average response time, a rating — is not shown at all rather than filled in". |
| Teklif kartı | `apps/web/app/requests/[id]/offers/offers-view.tsx:200-204`; `offers.service.ts:327-334` | Karşılaştırma tablosunda "no experience, rating … column, because no offer records those". Müşteri teklif projeksiyonu `provider` için yalnız `businessName, city, district` — **`id` yok**. |
| PII filtresi | `service-requests.service.ts:60-86` (`assertNoContactDetails`, modül-özel), `common/contact-detection.ts:357`, `packages/shared/src/contact-detection.ts`, `apps/web/app/request-fields/description-field.tsx` | Telefon/e-posta/URL tespiti; API 400 `CONTACT_DETAILS_IN_TEXT` (`field`, `kind`); web tarafında canlı uyarı. Uzunluklar `packages/shared/limits.json` + `MaxCodeUnitLength` (`common/max-code-unit-length.validator.ts`). |
| Hız sınırı | `auth.module.ts:54-58` | Adlandırılmış throttler'lar (`auth`, `request-drafts`, `service-requests`) tek `forRoot`'ta; oturumlu yazımlarda DB sayımı deseni (raporlar). |
| Operasyon anahtarı deseni | `schema.prisma:474-524`, `marketplace-publish-settings.service.ts:28` | `OperationsSettings.*Enabled Boolean @default(false)`, fail-closed okuma, `OperationsSettingsChange` denetimi (`:536`). |
| Silme yok | `grep user.delete/providerProfile.delete/serviceRequest.delete` → boş | Kullanıcı, sağlayıcı ve talep hiçbir yoldan silinmez; `SUSPENDED` (`providers.service.ts:932-955`) tek "kapatma". FK `Restrict` güvenle kullanılabilir. |
| Müşteri liste projeksiyonu | `service-requests.service.ts:668-746` (`...withQualityLabel(request)`) | Satırın tamamı yayılır → `completedAt`, `matchedOfferId` API'de zaten var; web tipi `apps/web/lib/api.ts:147-178` bunları **beyan etmiyor**. |

### 1.3 Bulgular

1. `COMPLETED` için bugün ne müşteriye ne sağlayıcıya **hiçbir bildirim** gitmez;
   `completeServiceRequest` transaction'sızdır ve tek koşullu `UPDATE`'tir — davet tetiği
   için idempotent ve yeterlidir.
2. Değerlendirme yapabilecek herkes zorunlu olarak **oturumlu CUSTOMER ve talep sahibi**dir
   (`/complete` yetkisi + `resolveCustomerForCreate`). Misafir/anonim değerlendirme yolu
   tasarlanmasına gerek yok.
3. Hizmet veren, kabul edilmiş teklif üzerinden **sunucuda türetilebilir**
   (`matchedOfferId` unique + `Offer.providerId`); istemcinin `providerId` göndermesi gereksiz
   ve risklidir.
4. Direct lead ve pazar talebi aynı tablolarda, aynı `MATCHED → COMPLETED` zincirindedir;
   ikinci bir puan sistemi kurulmaz, tek `ProviderReview` yeterlidir.
5. Moderasyon kuyruğu, dedupe, retry-rebuild, PII filtresi, limit JSON'u ve operasyon
   anahtarı desenleri hazır; hepsi kopyalanır, hiçbiri yeniden icat edilmez.
6. Web'de public sağlayıcı sayfası yoktur; API projeksiyonu vardır. Teklif kartı
   projeksiyonuna `provider.id` eklenmeden karttan profile bağlantı verilemez.

---

## 2. Kullanıcı akışı

**Müşteri.**
1. Eşleşen talebinde "Hizmet tamamlandı" → `/complete` → sayfa **`/requests/[id]/degerlendir`**'e
   yönlenir ("İşiniz tamamlandı. <İşletme> için değerlendirmenizi bırakın").
2. 1–5 yıldız (zorunlu) + yorum (isteğe bağlı, ≤ 600 kod birimi, canlı PII uyarısı) → gönder.
3. Aynı anda e-posta `review-invitation` (sonra dönenler için). Taleplerim'de `COMPLETED`
   satırında CTA: değerlendirme yoksa ve pencere açıksa "Değerlendir"; varsa "★ 4 · Değerlendirmeniz".
4. Değerlendirme **değiştirilemez** (§12 K1). Kaldırılırsa müşteri `review-removed` maili alır
   (sabit gerekçe etiketi); Taleplerim'de "Değerlendirmeniz yönetim tarafından kaldırıldı".

**Hizmet veren.**
1. `review-received` maili (yıldız + talep no + panel linki; **yorum metni ve müşteri adı yok**).
2. Panel → "Değerlendirmeler": özet (ortalama, sayı, dağılım) + liste (yıldız, yorum, tarih,
   kategori, talep no). Her satırda "Yorumu bildir" (gerekçe + not). Bildirdiği satırda
   "Bildirildi · inceleniyor" / karar sonucu.
3. Panelim özetinde "Değerlendirme" kartı: "★ 4,7 · 12 değerlendirme" ya da "Henüz değerlendirme yok".

**Ziyaretçi / müşteri (public).** `/isletme/[id]`: işletme adı, il/ilçe, açıklama,
kategoriler, alanlar (mevcut public projeksiyon) + "★ 4,7 · 12 değerlendirme", yıldız dağılımı,
son 5 anonim yorum ("Eylül 2026 · Boya badana"). Sıfır değerlendirmede "Henüz değerlendirme
yok". Teklif karşılaştırma kartlarında ve vitrin kart sayfasında işletme adı bu sayfaya bağlanır
(§12 K2 kapsam seçeneği).

**Admin.**
1. Operasyon → "Değerlendirme bildirimleri" kuyruğu (`open/resolved`), en eski önce.
2. Satır → değerlendirme detayı: talep, müşteri (admin görür), sağlayıcı, yıldız, yorum,
   rapor gerekçesi/notu. Kararlar: **Uygun bulundu** · **Yorumu kaldır** (yıldız kalır) ·
   **Değerlendirmeyi kaldır** (aggregate'ten çıkar) · (kaldırılmışsa) **Geri getir**.
3. Sağlayıcı detayında "Değerlendirmeler" bölümü (rapor olmadan da kaldırma), talep detayında
   "Değerlendirme" kartı. Bildirim Geçmişi'nde dört yeni şablon ve retry.

---

## 3. Veri modeli

### 3.1 Prisma

```prisma
/// Bir hizmet verenin bir yorumu neden admin önüne getirdiği.
enum ProviderReviewReportReason {
  OFFENSIVE              // hakaret, tehdit, ayrımcı dil
  CONTAINS_CONTACT_INFO  // filtreyi atlatmış telefon/e-posta/link
  NOT_ABOUT_THIS_JOB     // bu işle ilgisi yok / başka işletme
  SUSPECTED_FAKE         // sahte, rakip sabotajı şüphesi
  OTHER
}

/// Admin'in bir değerlendirme üzerindeki eylemi. Append-only günlük; satır başına bir eylem.
enum ProviderReviewModerationAction {
  REMOVE_COMMENT   // yorum kamudan ve panelden kalkar, yıldız aggregate'te kalır
  REMOVE_REVIEW    // tamamı kalkar, aggregate yeniden hesaplanır
  RESTORE          // önceki kaldırma geri alınır (talep "geri aç" karşılığı)
}

/// Raporun tek kararı — moderasyon eylemiyle aynı transaction'da yazılır.
enum ProviderReviewReportResolution {
  DISMISSED
  COMMENT_REMOVED
  REVIEW_REMOVED
}

/// Bir müşterinin, tamamlanmış kendi talebindeki kabul edilmiş teklifin sahibini
/// değerlendirmesi. Oluşturulur, değiştirilmez; yalnız admin kaldırma/geri getirme
/// alanlarına yazar (ProviderReviewModeration üzerinden).
model ProviderReview {
  id             String   @id @default(cuid())
  requestId      String
  /// Kabul edilmiş teklif. Unique: bir teklif bir kez değerlendirilir. providerId
  /// bu teklifin sahibinden kopyalanır; istemciden hiçbir zaman alınmaz.
  offerId        String   @unique
  providerId     String
  /// Talebin sahibi. NOT NULL: /complete oturum ister, değerlendiren hep oturumlu CUSTOMER'dır.
  customerUserId String
  /// 1..5 — CHECK raw SQL'de.
  rating         Int
  /// Trim + boşluk sıkıştırma sonrası; boşsa NULL. ≤ limits.providerReviewCommentMaxLength.
  comment        String?
  createdAt      DateTime @default(now())

  /// Yorum kamudan kaldırıldı; metin denetim için satırda kalır, yalnız admin okur.
  commentRemovedAt DateTime?
  /// Değerlendirme tamamen kaldırıldı: aggregate ve tüm listelerden çıkar.
  removedAt        DateTime?

  request    ServiceRequest  @relation(fields: [requestId], references: [id], onDelete: Restrict)
  offer      Offer           @relation(fields: [offerId], references: [id], onDelete: Restrict)
  provider   ProviderProfile @relation(fields: [providerId], references: [id], onDelete: Restrict)
  customer   User            @relation("ProviderReviewCustomer", fields: [customerUserId], references: [id], onDelete: Restrict)
  reports    ProviderReviewReport[]
  moderation ProviderReviewModeration[]

  /// request + provider için tek değerlendirme — DB garantisi (P2002 → 409).
  /// offerId unique + Offer(providerId, requestId) unique bunu zaten ima eder;
  /// açıkça da yazılır ki kural şemada okunsun ve kaldırılmış satır yeniden açılamasın.
  @@unique([requestId, providerId])
  @@index([customerUserId, createdAt])
  @@index([providerId, createdAt])
}

/// Değerlendirilen hizmet verenin "bu yorum uygunsuz" demesi. Append-only: bir kez
/// açılır, bir kez çözülür. Raporlayan yalnız değerlendirilen işletmedir (§4), o yüzden
/// reviewId tek başına unique.
model ProviderReviewReport {
  id                 String                          @id @default(cuid())
  reviewId           String                          @unique
  reporterProviderId String
  reason             ProviderReviewReportReason
  /// ≤ 500; yalnız admin okur.
  note               String?
  createdAt          DateTime                        @default(now())
  resolvedAt         DateTime?
  resolvedByUserId   String?
  resolution         ProviderReviewReportResolution?
  resolutionNote     String?

  review     ProviderReview  @relation(fields: [reviewId], references: [id], onDelete: Restrict)
  reporter   ProviderProfile @relation(fields: [reporterProviderId], references: [id], onDelete: Restrict)
  resolvedBy User?           @relation("ProviderReviewReportResolvedBy", fields: [resolvedByUserId], references: [id], onDelete: SetNull)

  @@index([reporterProviderId, createdAt])
  @@index([resolvedAt, createdAt])
}

/// Admin'in bir değerlendirme üzerindeki her eylemi: kim, ne, neden, ne zaman.
/// ServiceRequestReport'taki "karar notu" ile ManualOfferRefundAudit'teki "operatörsüz
/// kayıt olamaz" kuralının birleşimi. Silinmez, güncellenmez.
model ProviderReviewModeration {
  id            String                         @id @default(cuid())
  reviewId      String
  action        ProviderReviewModerationAction
  /// Müşteriye giden sabit etiketin anahtarı (REMOVE_* için zorunlu, RESTORE için NULL).
  reason        ProviderReviewReportReason?
  /// Admin notu; hiçbir dış mesaja yazılmaz.
  note          String?
  performedById String
  createdAt     DateTime                       @default(now())

  review      ProviderReview @relation(fields: [reviewId], references: [id], onDelete: Restrict)
  performedBy User           @relation("ProviderReviewModerationPerformedBy", fields: [performedById], references: [id])

  @@index([reviewId, createdAt])
  @@index([performedById])
}
```

Ters ilişkiler: `ServiceRequest.review ProviderReview?`, `Offer.review ProviderReview?`,
`ProviderProfile.reviews`, `ProviderProfile.reviewReports`, `User.providerReviews`,
`User.resolvedReviewReports`, `User.reviewModerations`. `OperationsSettings` +
`providerReviewsEnabled Boolean @default(false)` (§12 kapatılan karar: anahtar).

Raw SQL ekleri (Prisma ifade edemez; `ServiceRequestReport_resolution_pair` deseni):

```sql
ALTER TABLE "ProviderReview"
  ADD CONSTRAINT "ProviderReview_rating_range" CHECK ("rating" BETWEEN 1 AND 5),
  -- Yorumu olmayan bir satırın "yorumu kaldırıldı" olamaz.
  ADD CONSTRAINT "ProviderReview_comment_removal_needs_comment"
    CHECK ("commentRemovedAt" IS NULL OR "comment" IS NOT NULL);
ALTER TABLE "ProviderReviewReport"
  ADD CONSTRAINT "ProviderReviewReport_resolution_pair"
    CHECK (("resolvedAt" IS NULL) = ("resolution" IS NULL));
ALTER TABLE "ProviderReviewModeration"
  -- Kaldırma gerekçesizdir olamaz; geri getirme gerekçe taşımaz.
  ADD CONSTRAINT "ProviderReviewModeration_reason_by_action"
    CHECK (("action" = 'RESTORE') = ("reason" IS NULL));
-- Aggregate ve kamu listesi: yalnız kaldırılmamış satırlar. Partial + INCLUDE ile
-- ortalama/sayı sorgusu index-only okunur.
CREATE INDEX "ProviderReview_live_by_provider_idx"
  ON "ProviderReview"("providerId", "createdAt" DESC) INCLUDE ("rating")
  WHERE "removedAt" IS NULL;
-- Açık rapor kuyruğu, en eski önce.
CREATE INDEX "ProviderReviewReport_open_idx"
  ON "ProviderReviewReport"("createdAt") WHERE "resolvedAt" IS NULL;
```

`commentRemovedAt`/`removedAt` satır üzerindeki **türetilmiş durum**dur; gerçek denetim
kaydı `ProviderReviewModeration`'dır. İkisi aynı transaction'da yazılır (§4.6), böylece
"kaldırıldı ama kim/neden yok" satırı olamaz. Metin **silinmez**: "geçmiş/audit korunmalı"
kararı ve admin'in raporu değerlendirebilmesi için.

### 3.2 Aggregate: anlık sorgu mu, denormalize sayaç mı? — **Karar: anlık sorgu**

| Ölçüt | Anlık `GROUP BY` (seçilen) | Denormalize `reviewCount/ratingSum` (ProviderProfile ya da 1:1 özet tablo) |
|---|---|---|
| Yarış | Yok. Her okuma o anki gerçeği verir; `unique(requestId, providerId)` tek yazıcı garantisidir. | Her ekleme/kaldırma/geri getirme serializable tx ya da atomik `increment` ister; iki yolun (rapor kararı + admin detay) tutarlı olması koda bağlıdır. |
| Kaldırma / geri getirme | `WHERE "removedAt" IS NULL` — başka hiçbir şey yok. | Decrement + sum düzeltmesi; RESTORE'da tersi; drift olursa recompute job'u gerekir. |
| Hacim | Değerlendirme ≤ tamamlanan iş sayısı; sağlayıcı başına yüzlerle sınırlı. Partial index + `INCLUDE("rating")` ile index-only. Feed/teklif listesi için **tek** `groupBy providerId in (...)` sorgusu. | Okuma en ucuz; ama bu ölçekte fark ölçülemez. |
| Şema | Sıfır sütun `ProviderProfile`'a (zaten 30+ alan, vitrin/gate sütunlarıyla yüklü). | 2–3 sütun + yazım kuralı yorumu. |
| Yanıltıcı `0,0` | `count = 0 → average: null` doğal. | `sum/count` sıfıra bölme koruması gerekir. |

Anlık sorgu, kullanıcının "yarış ve kaldırma durumlarıyla birlikte karar ver" koşulunu
sıfır ek mekanizma ile karşılar. Vitrin feed'i raw SQL'dir (`showcase-feed.service.ts:373-514`);
puan orada gösterilecekse (§12 K2) `LEFT JOIN LATERAL (SELECT count(*), avg(rating) …
WHERE "providerId" = pr.id AND "removedAt" IS NULL)` eklenir. p95 bir gün sorun olursa
1:1 `ProviderReviewSummary(providerId, reviewCount, ratingSum, updatedAt)` tablosu **ek**
olarak gelir ve her yazımda kaynak tablodan **recompute** edilir (increment değil) — bu doküman
o kapıyı kapatmaz.

Ortalama sunumu: API `average: number | null` (iki ondalık, `numeric(3,2)` cast), UI
tr-TR tek ondalık (`4,7`). Dağılım: `groupBy rating` (5 satır) profil sayfası için.

### 3.3 Yorum bildirimi ve admin kararı modeli

- **Kim bildirir:** yalnız değerlendirilen sağlayıcı (kendi paneli, `ProviderAccessGuard`).
  Public/anonim bildirim yok (spam ve sayım manipülasyonu vektörü; ayrıca hedefi olmayan bir
  "report" kuyruğu). Müşteri kendi yorumunu bildirmez — destek bileti zaten var.
- **Bir rapor / değerlendirme:** `reviewId @unique`. İkinci deneme P2002 → 409
  `REVIEW_REPORT_ALREADY_EXISTS` (`REPORT_ALREADY_EXISTS` kopyası).
- **Bütçe:** sağlayıcı başına günde 20 (`REPORT_MAX_PER_PROVIDER_PER_DAY` ile aynı sabit,
  aynı DB sayımı, `[reporterProviderId, createdAt]` indeksi).
- **Karar:** admin eylemi (`REMOVE_COMMENT | REMOVE_REVIEW | RESTORE`), varsa açık raporu
  aynı tx'te `DISMISSED | COMMENT_REMOVED | REVIEW_REMOVED` ile kapatır. Rapor olmadan da
  kaldırma mümkündür (müşteri destek bileti üzerinden istemişse). "Uygun bulundu" =
  yalnız raporu `DISMISSED` yapar, moderasyon satırı yazılmaz.
- **Otomatik gizleme yok:** rapor satırı yorumu görünmez yapmaz — `ServiceRequestReport`
  ile aynı sözleşme. Aynı işletmeye ait tek raporlayıcı olduğu için "N rapor eşiği" zaten
  anlamsızdır; rakip sabotajı yapısal olarak kapalıdır (rakip yorumu bildiremez).

---

## 4. API uçları ve yetkiler

Yeni modül: `apps/api/src/modules/provider-reviews/` (`RequestReportsModule` kalıbı:
service + üç controller + dto + constants + copy). Sabitler `provider-reviews.constants.ts`;
yorum sınırı `packages/shared/limits.json` → `providerReviewCommentMaxLength: 600`, API'de
`common/provider-review-limits.ts` (JSON import gerekçesi `service-request-limits.ts:3-16`'da).

| Uç | Guard / rol | Amaç |
|---|---|---|
| `POST /service-requests/:id/review` | `AuthGuard + RolesGuard`, `@Roles(CUSTOMER)` **(SUPER_ADMIN hariç)** | Oluşturma. Body `{ rating: 1..5, comment?: string }`. Provider türetilir. |
| `GET /service-requests/:id/review` | `AuthGuard`, `CUSTOMER` (sahip) veya `SUPER_ADMIN` | Müşterinin kendi değerlendirmesi ve **uygunluk** (`eligibility`: `ok / not-completed / window-closed / already-reviewed / disabled / removed`). Taleplerim CTA'sı bunu okur. |
| `GET /providers/:providerId/reviews?cursor&limit` | `AuthGuard + ProviderAccessGuard` (sahip veya admin) | Sağlayıcı görünümü: `removedAt IS NULL` satırlar; `commentRemoved: boolean`; `myReport: { reason, createdAt, resolution } \| null`; başlıkta `summary`. Talep no + kategori var; **müşteri adı yok**. |
| `GET /providers/:providerId/reviews/summary` | aynı | Dashboard kartı (`count`, `average`, `distribution`). `getProviderDashboardForUser` yanıtına da `reviewSummary` eklenir. |
| `POST /providers/:providerId/reviews/:reviewId/reports` | `AuthGuard + ProviderAccessGuard` | Bildirim. Body `{ reason, note? }`. Servis: `review.providerId === providerId`, `removedAt IS NULL`, `comment IS NOT NULL`, `commentRemovedAt IS NULL` (yorumsuz ya da zaten kaldırılmış yorum bildirilemez — yıldız tek başına bildirilemez, §12 K-kapalı). |
| `GET /providers/:id/reviews/public?cursor&limit` | `OptionalAuthGuard` (herkes) | Public: `isPubliclyVisibleProvider` değilse **404** (`getProviderForViewer` ile aynı gerekçe, `providers.service.ts:431-437`); `summary` + `items[{ rating, comment, createdAt (ay hassasiyetine yuvarlanmış), categoryName }]`, yalnız `comment IS NOT NULL AND commentRemovedAt IS NULL AND removedAt IS NULL`; `limit ≤ 20`. Ad, talep no, ilçe, teklif tutarı **yok**. |
| `GET /provider-reviews/reports?state=open\|resolved&cursor&limit` | `SUPER_ADMIN` | Kuyruk. Rapor başına satır (review başına en fazla bir rapor olduğundan gruplama gerekmez); `listForAdmin` cursor kalıbı. |
| `GET /provider-reviews/:reviewId` | `SUPER_ADMIN` | Detay: talep (no, kategori, il/ilçe, müşteri adı — admin), sağlayıcı, yıldız, yorum (kaldırılmış olsa da), rapor, moderasyon günlüğü. |
| `POST /provider-reviews/:reviewId/moderate` | `SUPER_ADMIN` | `{ action: REMOVE_COMMENT\|REMOVE_REVIEW\|RESTORE, reason?, note? }`. §4.6. |
| `POST /provider-reviews/:reviewId/reports/dismiss` | `SUPER_ADMIN` | Açık raporu `DISMISSED` ile kapatır (`{ resolutionNote? }`); 409 `NO_OPEN_REVIEW_REPORT`. |
| `GET /operations-settings` / `PATCH …` | mevcut | `providerReviewsEnabled` alanı + `OperationsSettingsChange` satırı. |

`/provider-reviews` ayrı prefix'tir; `ProvidersController`'ın `GET :id`'si ile çakışmaz
(`AdminRequestReportsController`'daki modül sırası hilesine gerek kalmaz, bkz. yorum
`admin-request-reports.controller.ts:11-21`).

Hiçbir uçta hizmet verenin puan vermesi, kendi puanını düzenlemesi/silmesi yoktur;
`PATCH/DELETE` tanımlanmaz. Sağlayıcı rolü müşteri uçlarında `RolesGuard` ile 403 alır.

### 4.1 Oluşturma predikatı (sırayla)

1. `providerReviewsEnabled` fail-closed okunur (`MarketplacePublishSettingsService.isAutoPublishEnabled`
   kalıbı); kapalıysa 404 `REVIEWS_DISABLED` (varlığı sızdırmamak için 404, ekran CTA'yı
   zaten göstermez).
2. Talep `select { id, status, customerId, matchedOfferId, completedAt, matchedOffer: { id, providerId, status } }`.
   Yok → 404. `customerId !== user.id` → 403 (`getRequestForLifecycleAction` sözleşmesi:
   "told the request does not exist rather than off limits" için web 404 gösterir).
3. `status !== COMPLETED` → 409 `REVIEW_NOT_ALLOWED` (`code: 'REQUEST_NOT_COMPLETED'`). Bu tek
   satır arşivlenmiş/iptal/expired/rejected talebi ve `MATCHED` ama bitmemiş işi kapatır.
4. `matchedOfferId` NULL ya da `matchedOffer.status !== ACCEPTED` → 409 `MATCH_INCONSISTENT`
   (kabul tx'i bunu imkânsız kılar; iptal edilmiş teklif `CANCELLED` yalnız `REJECTED` talepte
   yazılır — `schema.prisma:1323-1329` — o da `COMPLETED` olamaz).
5. `completedAt + REVIEW_WINDOW_DAYS` geçmişse 409 `REVIEW_WINDOW_CLOSED` (§12 K1 süre).
6. DTO: `rating` `@IsInt @Min(1) @Max(5)`; `comment` `@IsOptional @IsString
   @MaxCodeUnitLength(600)`; serviste trim + `\s+` sıkıştırma + kontrol karakteri temizliği,
   boşsa NULL; `assertNoContactDetails('comment', …)` → 400 `CONTACT_DETAILS_IN_TEXT`
   (§7.2: fonksiyon `common/contact-guard.ts`'e taşınır, davranış aynı).
7. `providerReview.create({ requestId, offerId: matchedOffer.id, providerId: matchedOffer.providerId, customerUserId: user.id, rating, comment })`.
   P2002 → 409 `REVIEW_ALREADY_EXISTS` (yarış ve çift tıklama: DB karar verir; okuma-sonra-yazma
   yerine `create` + P2002, `RequestReportsService.createForProvider:66-77` deseni).
8. Commit sonrası `notifySafely(() => mail.sendReviewReceived(review.id))`.

Sağlayıcının durumu (`SUSPENDED/REJECTED`) oluşturmayı **engellemez**: iş yapıldı, kayıt
gerçektir; kamuya görünürlüğü zaten `isPubliclyVisibleProvider` keser.

### 4.2 Müşteri görünümü (`GET /service-requests/:id/review`)

```ts
{ review: { id, rating, comment, createdAt, commentRemoved, removed } | null,
  eligibility: 'ok' | 'not-completed' | 'window-closed' | 'already-reviewed' | 'disabled' | 'removed',
  provider: { id, businessName } | null,   // matchedOffer.provider
  windowEndsAt: string | null }
```
Kaldırılmış değerlendirmede müşteri kendi metnini görmeye devam eder (kendi verisi), yanında
"Yönetim tarafından kaldırıldı — gerekçe: <sabit etiket>".

### 4.3 Sağlayıcı görünümü — projeksiyon allow-list'i

`{ id, rating, comment (commentRemovedAt IS NULL ise, aksi null), commentRemoved, createdAt,
request: { id, requestNumber, categoryName }, myReport }`. `customerUserId`, müşteri adı,
telefon, e-posta, `offerId` fiyatı **yok** — sağlayıcı zaten teklifler sayfasından talebi
tanır; burada tekrar etmenin PII getirisi yoktur.

### 4.4 Public görünüm

`toPublicProvider` kalıbında ikinci bir allow-list fonksiyonu (`toPublicReview`). `createdAt`
ay başına yuvarlanır (`2026-09-01T00:00:00Z`) ki bir talep numarası ya da tamamlanma tarihiyle
korelasyon zorlaşsın. Yalnız yorum taşıyan satırlar listelenir; sayım/ortalama tüm
kaldırılmamış satırlardan.

### 4.5 Rapor uç noktası

`createForProvider` (`request-reports.service.ts:48-85`) birebir: sahiplik → günlük bütçe
(429 `REVIEW_REPORT_RATE_LIMITED`) → `create` (P2002 → 409) → commit sonrası
`sendReviewReportNewForSupport(report.id)`.

### 4.6 Moderasyon kararı (serializable tx, `runSerializable`, label `providerReviews.moderate`)

1. `review` kilitli okunur (`findUnique`), yoksa 404.
2. Geçerlilik: `REMOVE_COMMENT` → `comment IS NOT NULL && commentRemovedAt IS NULL &&
   removedAt IS NULL`; `REMOVE_REVIEW` → `removedAt IS NULL`; `RESTORE` → `removedAt IS NOT NULL
   || commentRemovedAt IS NOT NULL`. Aksi 409 `REVIEW_MODERATION_NOOP`.
3. Koşullu `updateMany` (aynı predikat `where`'de tekrar) ile satır durumu:
   `REMOVE_COMMENT` → `commentRemovedAt = now`; `REMOVE_REVIEW` → `removedAt = now`
   (+ `commentRemovedAt` dokunulmaz); `RESTORE` → her ikisi NULL. `count !== 1` → 409.
4. `providerReviewModeration.create({ action, reason, note, performedById })`.
5. Açık rapor varsa `updateMany({ reviewId, resolvedAt: null }, { resolvedAt: now,
   resolvedByUserId, resolution: eylem eşleniği, resolutionNote: note })`. `RESTORE`
   raporu kapatmaz (zaten kapalıdır).
6. Commit sonrası: `REMOVE_*` → `sendReviewRemoved(review.id, now, reason)` müşteriye.
   `RESTORE` → mail yok (§12 kapatılan karar).

Aggregate ayrıca "yeniden hesaplanmaz": anlık sorgu olduğu için commit anında doğrudur (§3.2).

---

## 5. Bildirim akışı

Dört yeni `TransactionalEmailTemplate` (`TRANSACTIONAL_EMAIL_TEMPLATES` 41 → 45;
`transactional-email-render.spec.ts:520` ve `FULL_DATA` güncellenir). Hepsi
`sendEmailOnce` + `(template, dedupeKey)`; hepsi `RETRY_DEDUPE_PREFIXES` ve `rebuild`'e
eklenir ki `/notifications` retry'ı canlı veriden yeniden kursun.

| Şablon | Alıcı | Tetik | dedupeKey | Veri (PII yok) | `rebuild` null koşulu |
|---|---|---|---|---|---|
| `review-invitation` | müşteri (`request.customerEmail`) | `completeServiceRequest` `count === 1` sonrası, `notify` sarmalı; SUPER_ADMIN tamamlasa da gider | `review-invitation:<requestId>` | işletme adı, kategori, talep no, `windowEndsAt`, link `/requests/<id>/degerlendir` | talep `COMPLETED` değil, anahtar kapalı, pencere kapandı, değerlendirme zaten var, e-posta yok |
| `review-received` | sağlayıcı (`recipientFor(provider)`) | `create` commit sonrası | `review-received:<reviewId>` | yıldız sayısı, kategori, talep no, panel linki. **Yorum metni ve müşteri adı yok** | review `removedAt` dolu, sağlayıcı alıcısı yok |
| `review-report-new-for-support` | `readSupportInboxEmail()` | rapor commit sonrası | `review-report-new:<reportId>` | gerekçe etiketi, talep no, işletme adı, admin linki. **Raporlayan notu yok** (`request-report-new-for-support` sözleşmesi, `transactional-mail.service.ts:777-803`) | rapor yok |
| `review-removed` | müşteri | `REMOVE_COMMENT` / `REMOVE_REVIEW` commit sonrası | `review-removed:<reviewId>:<removedAt ISO>` — geri getirilip yeniden kaldırılırsa yeni geçiş, yeni mail | eylem türü ("yorumunuz" / "değerlendirmeniz"), **sabit gerekçe etiketi** (`request-report-copy.ts` kalıbı), talep no. Admin notu, raporlayan, kim kaldırdı **yok** | review kaldırılmış değil (RESTORE sonrası retry sessiz kalır) |

Neden commit sonrası doğrudan gönderim, neden outbox değil: dört tetik de bir insanın HTTP
isteğidir (`offers.service.ts:301-310`, `request-reports.service.ts:82-83` deseni), scheduler
değil; kaybolan mailin telafisi hem ekranda hazırdır (CTA, panel, kuyruk) hem admin retry
yolundan gelir. Outbox niyet satırı deseni (`request-publish-outbox`) yalnız transaction
içinde "borç" yazılması gereken toplu/zaman kaynaklı geçişler içindir.

`NotificationLog` sütunları: `requestId`, `userId` (müşteri/sağlayıcı user), `providerId`
doldurulur; bu sayede admin `/notifications/[id]` ve talep/sağlayıcı zaman çizelgeleri satırı
bulur. Hiçbir maile yorum metni yazılmaz → `escapeHtml` yolu (`email-design.ts:137+`) zaten
güvenli olsa da yüzey açılmaz.

---

## 6. Ekranlar

**Web — müşteri.**
- `/requests/my` (`requests-board.tsx:143-199` `RequestRow`): `COMPLETED` satırda
  `datarow-actions` içinde ikinci CTA. Liste uç noktasını N+1 yapmamak için
  `listCustomerServiceRequests` include'una `review: { select: { rating, removedAt } }`
  eklenir (bir sütun daha, satır zaten yayılıyor); `CustomerServiceRequest` tipine
  `completedAt`, `review` eklenir. CTA metni: "Değerlendir" (yoksa + pencere açık) /
  "★ 4 · Değerlendirmeniz" / "Değerlendirme kaldırıldı".
- **Yeni** `/requests/[id]/degerlendir`: `CustomerShell active="requests"`; başlıkta işletme
  adı + talep no; 5'li `radio` yıldız grubu (`fieldset/legend`, klavye erişimi), yorum
  `textarea` + sayaç (`description-field.tsx` deseni: `limits.json` + canlı PII uyarısı);
  server action `submitReviewAction` → 400 `CONTACT_DETAILS_IN_TEXT` alanı işaretler,
  409 `REVIEW_ALREADY_EXISTS` → mevcut değerlendirmeyi gösterir; başarı → `?review=ok`
  ve `revalidatePath('/requests/my')`.
- `completeRequestAction` (`actions.ts:12-21`) sonuna `redirect(\`/requests/${id}/degerlendir\`)`.
- `/requests/[id]/offers` `COMPLETED` özet metni (`page.tsx:311-313`) "Bu talep tamamlandı"
  + değerlendirme linki/durumu.

**Web — sağlayıcı paneli.**
- `provider-shell.tsx:116-161` menüsüne `{ key: 'reviews', label: 'Değerlendirmeler', href: /providers/[id]/degerlendirmeler }`.
- **Yeni** `/providers/[id]/degerlendirmeler`: özet kartı (ortalama, sayı, dağılım çubukları)
  + `datarow` listesi; satırda "Yorumu bildir" → `report-dialog.tsx` (`providers/[id]/requests/[requestId]/report-dialog.tsx`)
  kopyası; `?reported=1` / `?reportError=` sözleşmesi aynı (`page.tsx:34-73`).
- `/providers/me` (`providers/me/page.tsx`): "Değerlendirme" metrik kartı; `count === 0` →
  "Henüz değerlendirme yok" (rakam yok).
- `/providers/[id]` profil sayfası `page.tsx:41-47` rail'ine aynı kart.

**Web — public.**
- **Yeni** `/isletme/[id]`: `SiteHeader` + landing stilleri; `GET /providers/:id` (404 →
  `notFound()`) + `GET /providers/:id/reviews/public`. Aggregate başlığı, dağılım, son 5 yorum,
  "Daha fazla" cursor. `count === 0` → "Henüz değerlendirme yok" (yıldız simgesi boş, sayı
  yok). SEO: `robots` varsayılan; `generateMetadata` işletme adı.
- Bağlantılar: `offers-view.tsx` kart/tablo başlığındaki `businessName` → `/isletme/<id>`
  (**önkoşul:** `listRequestOffers` provider select'ine `id`, `offers.service.ts:327-334`);
  `/vitrin/[cardId]` `card.provider.businessName` (`page.tsx:141`) → link. Kart yüzünde
  aggregate rozeti §12 K2.

**Admin.**
- `lib/nav.ts` Operasyon grubuna `{ href: '/provider-reviews/reports', label: 'Değerlendirme bildirimleri' }`
  ("Talep bildirimleri"nin hemen altına).
- **Yeni** `/provider-reviews/reports`: `requests/reports/page.tsx` kopyası — `Açık/Çözülen`
  sekmeleri, en eski önce, cursor; satır: işletme, yıldız, yorum özeti (160), gerekçe,
  raporlayan (= işletme), tarih, son karar.
- **Yeni** `/provider-reviews/[reviewId]`: detay + `moderation-dialog.tsx` ile üç eylem
  (gerekçe `select` + not) ve "Uygun bulundu"; moderasyon günlüğü tablosu.
- `/providers/[id]` (`page.tsx:572` "Son teklifler" yanına) "Değerlendirmeler" `SectionCard`:
  özet + son 10 satır + her satırda kaldır/geri getir.
- `/requests/[id]` (`page.tsx:594` "Bildirimler" yanına) "Değerlendirme" kartı (varsa).
- `/operations-settings`: `providerReviewsEnabled` anahtarı, `marketplaceAutoPublishEnabled`
  ile aynı bileşen ve değişiklik günlüğü.

---

## 7. Kötüye kullanım ve güvenlik

### 7.1 Tekillik, idempotency, hız
- **DB tekilliği:** `@@unique([requestId, providerId])` + `offerId @unique`; uygulama
  `create` + P2002 → 409. İki paralel istek: biri satır yazar, diğeri 409 alır
  (`request-reports.spec.ts` yarış testi kalıbı).
- **İdempotent tetik:** davet maili `review-invitation:<requestId>` ile bir kez; `/complete`
  zaten koşullu `UPDATE` (ikinci çağrı 409, mail tetiklenmez).
- **Yapısal üst sınır:** müşteri en fazla tamamladığı iş kadar değerlendirme yazabilir;
  ayrı sayaç gerekmez. Rapor: sağlayıcı başına 20/gün (DB sayımı). IP throttler eklenmez
  (tüm uçlar oturumlu; `auth.module.ts:54-58` listesine yeni ad eklenmez).
- **Pencere:** `completedAt + N gün` (§12 K1); dışı 409.

### 7.2 XSS / HTML / PII
- Yorum her yerde React text child olarak render edilir (`destek/[ticketId]/page.tsx:147`
  sözleşmesi); `dangerouslySetInnerHTML` yok (grep: web/admin'de sıfır kullanım). HTML
  etiketleri kaçırılır, yorumlanmaz; ek "HTML strip" yapılmaz (metni bozar), yalnız kontrol
  karakterleri (`\p{Cc}` hariç `\n`) atılır ve `\n` sayısı ≤ 10'a indirgenir.
- `assertNoContactDetails` (`service-requests.service.ts:60-86`) `common/contact-guard.ts`'e
  taşınır ve iki modül aynı fonksiyonu çağırır (tek tanım; `contact-detection.ts` kalıpları
  `packages/shared/contact-patterns.json` ile web'deki canlı uyarıyla aynı). Telefon,
  e-posta, URL → 400 `CONTACT_DETAILS_IN_TEXT`, `field: 'comment'`.
- **İsim sızıntısı:** yorum içinde müşterinin kendi adını yazması engellenemez (bilinçli
  tercih; kendi verisi). Sağlayıcı adı zaten kamuya açık. Sistem alanlarında ad/telefon/e-posta
  hiçbir public/provider projeksiyonuna girmez (allow-list, §4.3–4.4); admin görür.
- **Korelasyon:** public `createdAt` ay hassasiyeti; talep no, ilçe, tutar public'te yok.
- E-postalarda yorum metni yok (§5).

### 7.3 Sınır durumları

| Durum | Davranış |
|---|---|
| Sağlayıcı `SUSPENDED/REJECTED` | Oluşturma serbest (iş gerçek); public 404 (`isPubliclyVisibleProvider`); panel erişimi sağlayıcının mevcut erişim kurallarına tabi. Tekrar `APPROVED` olunca aggregate aynen görünür. |
| Talep `CANCELLED/EXPIRED/REJECTED` (arşiv) | `status !== COMPLETED` → 409. Kaldırılmış talebin (`REJECTED`) değerlendirmesi olamaz; `COMPLETED` terminal olduğu için sonradan kaldırılamaz da (`terminalStatuses`, `rejectRequestInTransaction` MATCHED'ı bile reddeder — `request-reports.service.ts:236-240`). |
| Teklif `WITHDRAWN/CANCELLED` | Kabul edilmiş teklif bu durumlara geçemez (`withdrawProviderOffer` yalnız `APPROVED` talepte; `CANCELLED` yalnız `REJECTED` talepte). Adım 4 savunma katmanı. |
| Raporlanmış yorum | Karar gelene kadar aynen görünür (no auto-hide). Aynı sağlayıcı ikinci rapor açamaz. |
| Kaldırılmış değerlendirme | Müşteri yeniden yazamaz (unique tam, partial değil), düzenleyemez; admin `RESTORE` edebilir. Sağlayıcı listesinde görünmez; rapor satırında sonuç görünür. |
| `customerId` NULL eski talep | `/complete` zaten 403 verir (`:1170`); değerlendirme de yok. Backfill scripti çalıştırıldıysa sorun kalmaz. |
| Admin kendi adına | SUPER_ADMIN `POST …/review` 403 (`@Roles(CUSTOMER)`); admin tamamlar ama puanlamaz. |
| Anahtar kapalı | Oluşturma 404, CTA gizli, public bölümü render edilmez; mevcut satırlar dokunulmaz. |
| Kredi/iade/vitrin | Hiçbir uç `ProviderCreditTransaction`, `Offer.refund*`, `ShowcaseEntitlement`, `PackagePurchase` okumaz/yazmaz; `unviewed-offer-refund.service.ts` ve `refund-policy.ts` değişmez. Test `credits-integrity.spec.ts` kalıbıyla "değerlendirme öncesi/sonrası ledger toplamı eşit" doğrulanır. |

---

## 8. Migration etkisi

Tek, yalnız **ek** migration: `20260916120000_add_provider_reviews`
- 3 enum, 3 tablo, FK'ler (`Restrict`; admin FK'leri `SetNull`/`Restrict` — §3.1), 4 CHECK,
  2 partial index, 4 B-tree index.
- `OperationsSettings ADD COLUMN "providerReviewsEnabled" BOOLEAN NOT NULL DEFAULT false`
  (tek satırlık tablo; kilit süresi ihmal edilebilir).
- `packages/shared/limits.json` + `providerReviewCommentMaxLength`.
- Mevcut tabloya başka sütun yok; backfill yok; hiçbir satır yeniden yazılmaz.
- Geri alma: tabloları ve sütunu düşürmek yeterli (veri kaybı yalnız yeni özelliğe ait).
- Dry-run raporu repo deseninde: `docs/superpowers/plans/2026-09-16-provider-reviews-migration-dryrun.txt`
  (`prisma migrate diff` + staging kopyasında `migrate deploy`; yerel senkron için
  `compose run --rm` + `corepack enable` notu — bkz. bellek `project_auto_publish_report_local_sync`).
- `prisma generate` sonrası `apps/api` derlemesi; `@taktic/shared` TS girişi **import edilmez**
  (yalnız JSON) — `project_api_cannot_import_shared_package` kısıtı.

---

## 9. Test planı

### 9.1 API (vitest, `apps/api/test/*.spec.ts`, harness `harness.ts`)
- `provider-reviews.spec.ts`
  - sahip müşteri `COMPLETED` talepte 201; provider `matchedOffer.providerId`; `offerId` doğru.
  - `MATCHED` iken 409 `REQUEST_NOT_COMPLETED`; `CANCELLED/EXPIRED/REJECTED` 409.
  - başka müşteri 403; PROVIDER rolü 403; SUPER_ADMIN 403.
  - ikinci gönderim 409 `REVIEW_ALREADY_EXISTS`; **10 paralel** istek → tam 1 satır
    (`Promise.allSettled`, `request-lifecycle.spec.ts` kalıbı).
  - pencere dışı 409 `REVIEW_WINDOW_CLOSED` (`completedAt` geriye çekilerek).
  - `rating` 0/6/2.5 → 400; yorum 601 kod birimi → 400; emoji sayımı `MaxCodeUnitLength`.
  - yorumda `0532 123 45 67`, `ali@x.com`, `wa.me/…` → 400 `CONTACT_DETAILS_IN_TEXT`
    (`request-contact-filter.spec.ts` vektörleri yeniden kullanılır).
  - anahtar kapalı → 404; `SUSPENDED` sağlayıcıya oluşturma 201, public 404.
  - `GET /service-requests/:id/review` eligibility tüm dalları.
- `provider-reviews-direct-lead.spec.ts`: `showcase-lead-flow.spec.ts` fixture'ıyla vitrin
  lead → teklif → kabul → complete → değerlendirme; aynı tablo, aynı kurallar; lead kaydı
  değişmez.
- `provider-reviews-aggregate.spec.ts`: 3 satır (5,4,3) → `count 3, average 4.00`;
  `REMOVE_COMMENT` sonrası aynı; `REMOVE_REVIEW` sonrası `count 2, average 4.50`; `RESTORE`
  → eski değer; 0 satır → `average null`; public listede yalnız yorumlu + kaldırılmamış;
  `createdAt` ay yuvarlama; dağılım.
- `provider-reviews-reports.spec.ts`: yalnız değerlendirilen sağlayıcı (başka sağlayıcı 403),
  yorumsuz satır 409, ikinci rapor 409, 21. rapor 429, rapor sonrası yorum **hâlâ görünür**
  (no auto-hide), `dismiss` → `DISMISSED`, `moderate REMOVE_COMMENT` → rapor `COMMENT_REMOVED`
  + moderasyon satırı + `commentRemovedAt`; `REMOVE_REVIEW` → `REVIEW_REMOVED`; `RESTORE`;
  NOOP 409; CHECK'ler raw SQL ile ihlal → hata (`request-report-schema.spec.ts` kalıbı).
- `provider-reviews-notifications.spec.ts` (`transactional-email-events.spec.ts` kalıbı):
  dört şablonun dedupe anahtarı, ikinci tetik `DUPLICATE`; `review-received` data'sında
  `comment`/müşteri adı/telefon **yok**; `review-removed` data'sında admin notu yok;
  `composeRetryMessage` her biri için rebuild; RESTORE sonrası `review-removed` rebuild null;
  SUPER_ADMIN tamamlayınca davet müşteriye gider.
- `transactional-email-render.spec.ts`: 45 + `FULL_DATA` 4 anahtar.
- `credits-integrity` uzantısı: değerlendirme/kaldırma öncesi-sonrası ledger ve entitlement
  toplamları eşit.
- `operations-settings.spec.ts`: yeni anahtar + `OperationsSettingsChange`.

### 9.2 E2E (Playwright, Chromium **ve** WebKit; `pnpm e2e <filtre>`, `--` yok)
`e2e/tests/provider-review-flow.spec.ts` + `journeys.ts`'e `completeRequest`, `submitReview`,
`reportReview`, `moderateReview`:
1. `marketplace-journey` kalıbıyla talep → teklif → `acceptOffer` (`journeys.ts:380`) →
   "Hizmet tamamlandı" → değerlendirme sayfasına yönlenme (route announcer `role=alert`
   tuzağına dikkat, bellek `project_e2e_ci_pitfalls`) → 5 yıldız + yorum → başarı.
2. Taleplerim'de "★ 5 · Değerlendirmeniz"; ikinci kez sayfa açılınca form yok.
3. Sağlayıcı paneli: özet "5,0 · 1 değerlendirme", satırda yorum; "Yorumu bildir".
4. `/isletme/[id]`: aggregate + yorum; ay etiketi; ad yok (`toHaveText` negatif).
5. Admin kuyruğu → detay → "Yorumu kaldır" → public'te yorum yok, ortalama aynı; "Değerlendirmeyi
   kaldır" → "Henüz değerlendirme yok"; "Geri getir" → geri.
6. Bildirim Geçmişi'nde dört şablon satırı (`notification-history.spec.ts` kalıbı).
7. Vitrin varyantı: `showcase-package-first-flow` fixture'ı ile direct lead → aynı adımlar
   (yalnız Chromium; WebKit için 1–6 yeterli).
Ekran görüntüleri `docs/superpowers/plans/2026-09-16-provider-reviews-screens/` (WebKit
`fullPage × DPR` notu).

### 9.3 Kabul kriterleri (özet)
Tek değerlendirme/çift; provider türetimi; `COMPLETED` dışı 409; pencere; PII 400;
aggregate kaldırma/geri getirme sonrası doğru; 0 → "Henüz değerlendirme yok"; public'te PII
yok; dört mail bir kez ve retry edilebilir; kredi/iade/vitrin ledger'ı değişmez; direct lead
aynı yol; anahtar kapalıyken görünmez.

---

## 10. Riskler

| Risk | Etki | Azaltma |
|---|---|---|
| Az sayıda değerlendirme ile tek 1★'ın ortalamayı belirlemesi | Yeni sağlayıcı caydırılır | Sayı her zaman ortalamanın yanında; §12 K3 eşik seçeneği. |
| Yorum yoluyla PII/off-platform yönlendirme | Platform atlanır | `detectContactDetails` + rapor + admin kaldırma; e-postaya yorum girmez. |
| Müşteri yorumda kendi adını/adresini yazar | Kendi PII'si kamuda | Formda uyarı metni ("Adınız ve adresiniz yorumda görünmesin"); admin kaldırma. |
| Değişmezlik → yanlış yıldız düzeltilemez | Müşteri memnuniyetsizliği | Destek bileti → admin `REMOVE_REVIEW`; sonra yeniden yazılamaz (bilinçli, §12 K1 gerekçesi). |
| Public profil sayfası yeni bir keşif yüzeyi açar | İşletme id'lerinin taranması | Yalnız `APPROVED` 200, aksi 404 (mevcut kural); id `cuid`; sayfa ek PII taşımaz. |
| `listCustomerServiceRequests` include büyümesi | Liste yavaşlar | Tek `select { rating, removedAt }`; 1:1 ilişki. |
| Şablon sayısı testi (`41`) kırılır | CI | Aynı PR'da 45'e güncellenir (bilinçli kilit). |
| Feed raw SQL'e LATERAL join | Vitrin feed p95 | Yalnız K2 seçilirse; partial index index-only. |

---

## 11. Uygulanabilir görev planı

Sıra bağımlılığa göre; her görev kendi testini taşır. İki PR önerisi: **A** (1–6, API +
migration) ve **B** (7–11, web/admin + E2E); anahtar kapalı olduğu için A tek başına yayınlanabilir.

1. `limits.json` + `common/provider-review-limits.ts`; `assertNoContactDetails` →
   `common/contact-guard.ts` (davranış değişmez; mevcut `request-contact-filter.spec` geçer).
2. Prisma şeması + migration SQL + dry-run raporu; `request-report-schema.spec` kalıbıyla
   CHECK/partial index testi.
3. `OperationsSettings.providerReviewsEnabled` + `ProviderReviewSettingsService`
   (`marketplace-publish-settings.service.ts` kopyası) + admin ayar ekranı + değişiklik günlüğü.
4. `ProviderReviewsModule`: servis (create/eligibility/list/summary/public/report/moderate/dismiss),
   DTO'lar, üç controller, sabitler, `review-copy.ts` (gerekçe etiketleri); `AppModule` kaydı.
   Testler: `provider-reviews.spec`, `-aggregate.spec`, `-reports.spec`, `-direct-lead.spec`.
5. Bildirimler: 4 şablon (`transactional-templates.ts` doküman builder'ları + `transactionalSubject`),
   `sendReviewInvitation/Received/ReportNewForSupport/Removed`, `RETRY_DEDUPE_PREFIXES`,
   `rebuild`; `completeServiceRequest` commit sonrası tetik; render/events testleri.
6. `getProviderDashboardForUser` → `reviewSummary`; `listCustomerServiceRequests` → `review`;
   `listRequestOffers` provider select → `id`.
7. Web müşteri: `/requests/[id]/degerlendir`, `completeRequestAction` yönlendirmesi,
   Taleplerim CTA, `lib/api.ts` tipleri.
8. Web sağlayıcı: menü, `/providers/[id]/degerlendirmeler`, dashboard/profil kartları,
   rapor diyaloğu.
9. Web public: `/isletme/[id]`, teklif kartı ve vitrin sayfası bağlantıları (K2'ye göre rozet).
10. Admin: nav, kuyruk, detay + moderasyon diyaloğu, sağlayıcı/talep detay bölümleri,
    bildirim geçmişi etiketleri.
11. E2E `provider-review-flow.spec.ts` (Chromium + WebKit), journeys, ekran görüntüleri,
    teslim raporu (`docs/superpowers/plans/…-teslim-raporu.md`).
12. Yayın: migration deploy → anahtar kapalı doğrulama → Operasyon Ayarları'ndan açma;
    yerel Docker senkronu (bellek kuralı).

---

## 12. Kararlar

### 12.1 Açık kararlar (en fazla 3)

**K1 — Değerlendirme penceresi.** (a) sınırsız · **(b) 90 gün (öneri)** · (c) 30 gün.
Öneri gerekçesi: `completedAt` tek güvenilir saat; 90 gün hem "işin sonucunu görme" süresini
kapsar hem yıllar sonra gelen puanı keser. Sabit `REVIEW_WINDOW_DAYS`, ileride
`OperationsSettings`'e taşınabilir.

**K2 — Aggregate'in profil dışında gösterimi.** (a) yalnız `/isletme/[id]` ·
**(b) + teklif karşılaştırma kartları (öneri)** · (c) + vitrin kart yüzü ve feed.
(b): karar anında müşteriye görünür, tek ekstra `groupBy`; (c) raw feed SQL'ine LATERAL join
ve `showcase-feed.spec` etkisi — ikinci fazda.

**K3 — Ortalamanın kamuya açılması için minimum sayı.** **(a) 1 (öneri)** · (b) 3 · (c) 5.
(a): sayı her zaman yanında ("★ 5,0 · 1 değerlendirme"), gizlemek sayının kendisini
yanıltıcı kılar; (b)/(c) tek-yorum sabotajını yumuşatır ama yeni sağlayıcıyı uzun süre
"Henüz değerlendirme yok"ta tutar.

### 12.2 Kapatılan kararlar

| Karar | Seçim | Gerekçe |
|---|---|---|
| Sonradan düzenleme | **Değişmez (v1)** | Repo'daki denetim kayıtlarının tamamı append-only (`ContactRevealEvent` "Immutable by contract", `ServiceRequestReport`, `ManualOfferRefundAudit`); `NotificationLog` "one mail per real transition" — düzenleme yeni şablon + sağlayıcıya ikinci mail + `previous*` alanları ya da revizyon tablosu ister; sağlayıcıya bildirilen sayı sonradan değişemez olmalı (güven). Additive yol açık: `editedAt` + `ProviderReviewRevision`. Yanlış giriş için destek bileti → admin kaldırma. |
| Provider türetimi | Sunucu, `matchedOfferId` üzerinden | İstemci `providerId` gönderemez; yanlış işletmeyi puanlama imkânsız. |
| Aggregate | Anlık sorgu | §3.2. |
| Kim bildirir | Yalnız değerlendirilen sağlayıcı | Rakip sabotajı yapısal olarak kapalı; kuyruk küçük. |
| Yıldız-tek raporu | Yok; yalnız yorum bildirilir | "Puanı beğenmedim" bir moderasyon konusu değil; admin rapor olmadan da kaldırabilir. |
| Kaldırma seviyeleri | Yorum / tamamı + geri getir | Kullanıcı kararı; RESTORE talep "geri aç" simetrisi. |
| Kaldırmada bildirim | Müşteriye sabit etiketle mail; sağlayıcıya mail yok (panelde sonuç) | Talep-kaldırma sözleşmesi (`sendRequestRemoved`); raporlayana mail göndermek yeni şablon/PII yüzeyi. |
| Admin adına puanlama | Yok | Puan yalnız müşterinin. |
| Feature anahtarı | `OperationsSettings.providerReviewsEnabled`, default false | Repo deseni; migration ekranlardan önce yayınlanabilir; fail-closed. |
| Davet kanalı | Ekran yönlendirmesi + tek e-posta; hatırlatma yok | Scheduler yüzeyi açılmaz; CTA kalıcı. |
| SMS | Yok | Gerçek SMS transport'u yok (`notifications.module.ts`). |
| Public tarih | Ay hassasiyeti | Korelasyon riski. |
| Yorum uzunluğu | 600 kod birimi | Destek mesajı 2000, açıklama 5000; yorum kısa olmalı, `MaxCodeUnitLength`. |
