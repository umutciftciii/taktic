# Pazar taleplerinde anında yayın + "Talebi bildir" — keşif ve teknik tasarım

Tarih: 2026-09-14 · Durum: **onaylı (rev. 2)** — kaldırma/iade semantiği, bildirim
dayanıklılığı ve karar tablosu revize edildi; uygulama planına hazır
· Önceki iş: kimlik gate + RequestDraft (PR #75), VIT-003 (PR #73/#74)

## 0. Karar, hedef, kapsam

**Karar.** Normal pazar talebi oluşturulduğunda insan onayı beklenmeden anında eşleşen
hizmet verenlere açılır. Ön moderasyon yerine hizmet verenin talep detayında **"Talebi
bildir"** aksiyonu olur; yalnız bildirilen talepler admin inceleme kuyruğuna düşer. İlk
sürümde karar yalnız insan admin'indir — rapor eşiğiyle otomatik gizleme yoktur.

**Korunanlar.** Mevcut veri ve geçmiş statüler aynen kalır; geriye dönük toplu güncelleme
yok. Bekleyen `SUBMITTED` talepler otomatik yayınlanmaz; admin mevcut "Onayla" ile tek tek
karar verir. Scheduler cron'ları, Lemon/ödeme, `.env`, Cloudflare ve Resend ayarları kapsam
dışı.

**Tek cümleyle çözüm.** Talep oluşturma transaction'ı içinde `status: APPROVED` +
`approvedAt` yazılır (yeni geçiş yok, mevcut `APPROVED` anlamı korunur); yayın
bildirimleri aynı transaction'da NotificationLog'a **niyet satırı** olarak kalıcılaşır ve
mevcut outbox dispatcher'ıyla teslim edilir; `ServiceRequestReport` tablosu ve admin
kuyruğu eklenir; "Talebi kaldır" mevcut `REJECTED` durumunu kullanır (yeni statü yok) ve
aynı transaction'da aktif teklifleri `CANCELLED`'a alıp harcanan kredileri iade eder;
"Talebi geri aç" mevcut `REJECTED → APPROVED` moderasyon geçişidir.

---

## 1. Keşif: bugünkü akışlar

### 1.1 Normal pazar talebi (kod okuması)

| Adım | Nerede | Bugün |
|---|---|---|
| Oluşturma | `POST /service-requests` → `ServiceRequestsService.createServiceRequest` (`apps/api/src/modules/service-requests/service-requests.service.ts:194-392`) | `runSerializable` içinde `serviceRequest.create` — `status` şema default'u `SUBMITTED`. `approvedAt` yazılmaz. Commit sonrası: aktivasyon maili + `request-received` ("Talebiniz alındı — inceleniyor"). |
| Moderasyon | `PATCH /service-requests/:id/status` (SUPER_ADMIN) → `updateServiceRequestStatus` (`:593-723`) | `APPROVED` yazılırken aynı statement'ta `approvedAt = now`, `moderatedAt = now`. Gerçek geçişte (`existing.status !== APPROVED` ve gate NULL) commit sonrası `fanOutApprovedRequest` → müşteriye `request-published`, eşleşen her provider'a `request-available` (dedupeKey `request-available:<requestId>:<providerId>`). |
| Keşif listesi | `GET /providers/:id/requests` → `listMatchingRequests` (`providers.service.ts:1017`) | `status = APPROVED` + `phoneVerifiedRequestFilter()` + `directShowcaseVisibilityFilter` + kategori bağı + `offers.none(providerId)`; alan eşleşmesi bellekte (`matchesProviderArea`). Provider `APPROVED` olmalı (`getApprovedProviderForDiscovery`). |
| Detay | `getMatchingRequest` (`:1066`) | Aynı predikat satır üzerinde. Projeksiyon: `addressNote`, `description`, cevaplar dahil; **ad/telefon/e-posta yok** (`toProviderRequestDetail`, `:2409`). |
| Teklif | `createOfferRecord` (`:1139`) | `ensureProviderCanSeeRequest` → `APPROVED` (veya kendi direct lead'i `SUBMITTED`); serializable tx'te kredi/entitlement; direct lead ise `SUBMITTED → APPROVED` koşullu `updateMany`. |
| Teklif kabulü | `OffersService.acceptRequestOffer` (`offers.service.ts:520`) | `updateMany where {status: APPROVED, matchedOfferId: null}` → `MATCHED`; rakip teklifler `REJECTED/COMPETITOR_ACCEPTED`; `ContactRevealEvent` (contact sharing açıksa). |
| Geri çekme | `withdrawProviderOffer` (`:1508`) | Talep `APPROVED` değilse 409 `OFFER_NOT_WITHDRAWABLE`. |
| Mesajlaşma | `MessagingService.loadMatchChain` (`messaging.service.ts:444`) | Yalnız `MATCHED` + `ACCEPTED` teklif + reveal kaydı. |
| Expiry | `RequestExpiryService` | `status = APPROVED AND approvedAt <= now-14g` → `EXPIRED`; outbox `request-expired-customer/-provider`. |
| Hatırlatma | `RequestReminderService` | `APPROVED`, `approvedAt <= now-7g`, `offers.none`, `reminderSentAt IS NULL` → tek `request-expiring`. |
| İade | `UnviewedOfferRefundService` / `refund-policy.ts` | Talep statüsüne bakmaz: `unviewedRefundPolicy=true`, `viewedAt IS NULL`, `refundBlockedAt IS NULL`, `unviewedRefundEligibleAt <= now` → kredi iadesi. Manuel iade: `refundOfferCredit` + `ManualOfferRefundAudit`. |
| İptal | `cancelServiceRequest` | Terminal olmayan her durumdan `CANCELLED`; lead varsa kapatır. |
| Telefon doğrulama | `POST /service-requests/:id/phone-verification[/verify]` | **Talep oluşturulduktan sonra**, yalnız talebin sahibi oturum açmış CUSTOMER (veya admin). `REQUIRE_PHONE_VERIFICATION` (env, default `false`): `true` iken doğrulanmamış talep provider'a görünmez ve `APPROVED` yazılamaz (`PHONE_NOT_VERIFIED`). |
| Hız sınırı | `AuthModule` `ThrottlerModule.forRoot([...])` (`auth`, `request-drafts`) | **`POST /service-requests` üzerinde hiçbir throttler yok.** OTP: telefon başına 3/saat, IP başına 10/saat (DB sayımı). Mesaj: 10/60 sn. `RequestDraft`: 5/10 dk IP. |
| Admin dashboard | `dashboard.service.ts:22-23` | `SUBMITTED` ve `IN_REVIEW` sayıları "bekleyen kuyruk" olarak gösterilir. |
| Müşteri panosu | `apps/web/app/requests/my/requests-board.tsx:18-22` | `APPROVED` = "Yayında"; `SUBMITTED/IN_REVIEW` = "İncelemede". Başarı sayfası: "Talebiniz ön incelemeye gönderildi". |

**Bulgular.**
- Reddedilen talep için müşteriye giden **hiçbir e-posta şablonu yok** (`TRANSACTIONAL_EMAIL_TEMPLATES` içinde `request-rejected` yok).
- Açıklama/adres notu/cevaplarda PII (telefon, e-posta, URL) tespiti **yok**; tek sınır `SERVICE_REQUEST_DESCRIPTION_MAX_LENGTH` (`packages/shared/limits.json`).
- Gerçek SMS transport'u yok: `SmsPort` yalnız `ConsoleSmsAdapter` veya `FileOutboxSmsAdapter` (`notifications.module.ts:40`). `.env.example:160`: "Keep false until a real SMS transport is configured".
- Admin'e yönelik uyarı mekanizması: destek biletlerinde `SUPPORT_INBOX_EMAIL`'e giden `support-ticket-*-new-for-support` şablonları (`readSupportInboxEmail()`), NotificationLog + dedupeKey ile. Ayrıca `/notifications` admin ekranı ve dashboard sayaçları.
- Moderasyon endpoint'i `existing.status`'u kontrol etmez: `REJECTED → APPROVED` bugün de mümkündür (yeniden onay `approvedAt`'i tazeler; `request-available` dedupeKey'i `approvedAt` taşımadığı için daha önce mail almış provider'a ikinci mail gitmez, müşteri `request-published`'i tekrar alır).
- `OperationsSettings` bool anahtar deseni (`*SchedulerEnabled`, `SchedulerSettingsService`, `OperationsSettingsChange` denetimi) hazır: "false default, her okumada fail-closed, ekrandan bir insan açar".

### 1.2 Vitrin direct lead (fark tablosu)

Kaynak: `showcase-lead.service.ts:60-110` sınıf yorumu, `createOfferRecord` direct lead dalı, `decideFallback`.

| Boyut | Normal pazar talebi (bugün) | Vitrin direct lead (bugün) |
|---|---|---|
| Oluşturma | `SUBMITTED`, gate NULL | `SUBMITTED`, `directShowcaseProviderId = kart sahibi`, `ShowcaseLead` aynı tx'te |
| Telefon doğrulama | Sonradan, isteğe bağlı (flag) | **Zorunlu, oluşturma öncesi** (`POST /showcase/lead-verification[/verify]`), flag'den bağımsız |
| Moderasyon | Admin onayı → `APPROVED` | Yok. Kart sahibi teklif verince `SUBMITTED → APPROVED` (`approvedAt = teklif anı`) |
| Fan-out | `APPROVED` geçişinde tüm eşleşen provider'lara | Hiç; yalnız `showcase-lead-received` addressee'ye |
| Görünürlük | Tüm eşleşen APPROVED provider'lar | Yalnız kart sahibi (SUBMITTED iken de) |
| Teklif kredisi | Kategori fiyatı | 0 (`SHOWCASE_PLACEMENT`), `unviewedRefundPolicy=false` |
| SLA / breach | Yok | `slaDueAt`; breach → müşteriye RELEASE / KEEP_CLOSED sorusu |
| RELEASE | — | Gate NULL'lanır, talep `SUBMITTED` kalır → **normal moderasyon kuyruğu** → admin onayı → fan-out |
| KEEP_CLOSED / zaman aşımı | — | `CANCELLED` (SLA sweeper ikinci kolu 14 gün sonra) |
| Expiry/hatırlatma | `approvedAt` saati | Ancak `APPROVED` olduktan sonra aynı makine |

---

## 2. Talep yaşam döngüsü (yeni)

### 2.1 Anahtar: `OperationsSettings.marketplaceAutoPublishEnabled`

Yeni bool sütun, default `false`, her talep oluşturma isteğinde okunur (fail-closed), süper
admin `/operations-settings` ekranından açar, değişiklik `OperationsSettingsChange`'e yazılır
(mevcut scheduler anahtarlarıyla aynı sözleşme). Gerekçe: moderasyonu kaldırmak geri
alınabilir bir operasyon kararı olmalı; migration veya env asla bu davranışı açmamalı
(repo sözleşmesi). Anahtar kapalıyken davranış bugünkü davranışın **birebir aynısıdır**.

> Alternatif (önerilmez): anahtarsız sert geçiş. Rollback deploy gerektirir; repo deseniyle
> çelişir.

### 2.2 Atomik `SUBMITTED → APPROVED`

Yeni bir ara geçiş **yoktur**: satır doğrudan `APPROVED` olarak doğar. `createServiceRequest`
transaction'ında (`runSerializable`, label `serviceRequests.create`):

```
publishAtCreate = autoPublishEnabled
               && context.directShowcaseProviderId == null        // vitrin lead değil
               && (!isPhoneVerificationRequired() || phoneVerifiedAt != null)

create({
  status:     publishAtCreate ? APPROVED : SUBMITTED,
  approvedAt: publishAtCreate ? now : null,     // now = tx başında alınan tek Date
  moderatedAt: null, moderationNote: null,      // insan dokunmadı; moderasyon alanları boş kalır
  submittedAt: now,
  ...
})
```

- **`approvedAt` tam olarak** `serviceRequest.create` statement'ının `data.approvedAt`'inde,
  `submittedAt` ile aynı `now` değeriyle yazılır. Böylece `status` ile expiry/hatırlatma
  saati asla ayrışamaz; `moderatedAt` NULL kalır ve "bu talebi bir insan onaylamadı" gerçeği
  veriden okunabilir (`approvedAt NOT NULL AND moderatedAt IS NULL`).
- `resolveCustomerForCreate`, numara üretimi, draft tüketimi, `onCreated` aynen.
- Aynı satır için ikinci bir `updateMany` yapılmaz: tek INSERT, tek durum.

**Yayınlama yardımcısı.** `publishRequestInTransaction(tx, requestId, now)`:
`updateMany where {id, status: SUBMITTED, directShowcaseProviderId: null} data {status:
APPROVED, approvedAt: now}`; `count === 1` ise çağırana "yayınlandı" döner. Kullanıcıları:
(a) `REQUIRE_PHONE_VERIFICATION=true` iken `PhoneVerificationService.verifyCode` — doğrulama
tx'inin içinde, `phoneVerifiedAt` yazılan aynı transaction'da; (b) vitrin RELEASE (2.6).
Oluşturma yolu bu yardımcıyı kullanmaz (INSERT'te doğar).

### 2.3 Commit sonrası bildirimler

| Durum | Bugün | Yeni |
|---|---|---|
| Oluşturmada `APPROVED` doğdu | — | `request-received` **gönderilmez**; aynı transaction'da `RequestPublishOutbox.enqueue(tx, requestId, approvedAt)` → müşteriye `request-published` (dedupeKey `request-published:<id>:<approvedAt>`), eşleşen her provider'a `request-available` (dedupeKey `request-available:<id>:<providerId>`) **PENDING niyet satırları**. |
| Oluşturmada `SUBMITTED` kaldı (anahtar kapalı) | `request-received` | Aynı. |
| `SUBMITTED` kaldı (anahtar açık, telefon flag'i açık, doğrulanmamış) | — | `request-received` metni `nextStep: 'verify'` verisiyle: "Telefonunuzu doğruladığınızda talebiniz yayına alınır." (şablon verisi; yeni şablon yok). |
| `verifyCode` ile yayınlandı | — | Doğrulama tx'inde `enqueue`; commit sonrası teslim. |
| Admin "Onayla" / "Talebi geri aç" | `await fanOutApprovedRequest` | Aynı `enqueue` + commit sonrası teslim; `fanOutApprovedRequest`'in senkron yolu kaldırılır, tek yazar outbox olur. |

**Yayın bildirimleri kalıcı niyet olarak yazılır, teslim yanıtı beklemez.** Mevcut
`request-expiry-outbox.service.ts` / `notification-intents.ts` mimarisi birebir
uygulanır:

1. **Enqueue (transaction içi).** `RequestPublishOutbox.enqueue(tx, requestId, approvedAt)`
   post-update satırı okur (`status = APPROVED`, gate NULL), `findMatchingProviders` ile
   hedef kitleyi çözer ve `intentRow(...)` ile `notificationLog.createMany({ data,
   skipDuplicates: true })` yazar: `status: PENDING`, `attemptCount: 0`, `lastAttemptAt:
   null`, `requestId/providerId/userId` dolu. `@@unique([template, dedupeKey])` ikinci
   yazımı sessizce düşürür — bir talep için bir müşteri niyeti, provider başına bir
   `request-available` niyeti DB garantisidir. Talep commit olmuşsa niyet de commit
   olmuştur; commit olmadıysa hiçbiri yoktur.
2. **Teslim (commit sonrası, bloklamayan).** `createServiceRequest` yanıtı döndürmeden önce
   `void this.publishOutbox.deliverPending({ limit })` başlatır; `deliverPendingIntents`
   her satırı `claimablePredicate` ile koşullu `updateMany` (lease 15 dk,
   `INTENT_CLAIM_LEASE_MS`) üzerinden kilitler, `composeRetryMessage(template, dedupeKey)`
   ile gövdeyi **dedupeKey'den yeniden üretir** (bu iki şablon için `case
   'request-published'` / `case 'request-available'` zaten var, `:1029`, `:1042`) ve
   `NotificationDispatcher` ile gönderir; sonuç SENT/FAILED aynı satıra yazılır.
3. **Süreç düşerse.** Niyet satırı PENDING kalır. Yeniden sürme, yeni scheduler olmadan üç
   mevcut yoldan: (a) sonraki her yayın teslimi (`deliverPending`) sırası gelen **tüm**
   PENDING satırları en eskiden başlayarak alır — bir sonraki talep, öncekinin kayıp
   e-postasını taşır; (b) `RequestLifecycleScheduler`'ın expiry tick'i zaten
   `RequestExpiryOutbox.deliverPending` çağırır — aynı tick `RequestPublishOutbox.
   deliverPending` de çağırır (mevcut job, yeni cron yok, `requestExpirySchedulerEnabled`
   anahtarına bağlı); (c) admin `/notifications` ekranındaki mevcut yeniden gönderme
   düğmesi (`composeRetryMessage` destekli). Lease + unique sayesinde üç yol birbirini
   ikilemez.
4. **Gözlem.** `@@index([template, status, lastAttemptAt])` bu iki şablon için de
   süpürme indeksidir; `request-available` satırları `providerId` taşıdığından admin talep
   detayında "kaça ulaştı / kaçı gönderildi" mevcut NotificationLog listesinden okunur.
   `fanOutApprovedRequest`'in log satırı (`reached=/notified=`) enqueue tarafına taşınır.

Vitrin RELEASE (2.6) aynı `enqueue`'yu kullanır. Direct lead'in kendi `APPROVED` geçişi
(addressee'nin teklifi) enqueue **etmez** — bugün olduğu gibi fan-out yoktur.

### 2.4 Diğer akışlara etki (normal talep)

| Akış | Etki | Değişiklik |
|---|---|---|
| Keşif listesi / detay | Talep commit'ten sonraki ilk sorguda görünür (`status = APPROVED`). | Yok. |
| Teklif verme | `ensureProviderCanSeeRequest` `APPROVED` ister → anında verilebilir. | Yok. |
| Teklif kabulü / eşleşme | `where status: APPROVED` → değişmez. | Yok. |
| Expiry (14 g) / hatırlatma (7 g) | Saat `approvedAt = submittedAt`'ten başlar; bugün onay gecikmesi kadar kayıyordu. | Yok. Not: acil talepte 14 gün "tazelik" aynı; ürün kararı D. |
| İade | Talep statüsünden bağımsız; değişmez. | Yok. |
| Bildirimler | `request-received` yerine `request-published`; provider `request-available`; ikisi de outbox niyeti (2.3). `request-received` şablonuna `nextStep` verisi. | Şablon metni + `sendRequestReceived` dallanması + `RequestPublishOutbox`. |
| Admin dashboard | `SUBMITTED` sayısı yalnız: legacy bekleyenler + doğrulama bekleyenler + cevaplanmamış direct lead'ler. | Etiket "Bekleyen (moderasyon)" → "Bekleyen (yayın öncesi)". |
| Müşteri panosu | Yeni talepler doğrudan "Yayında" kovasında. Başarı sayfası "Talebiniz yayında — eşleşen hizmet verenlere iletildi". | Metin. |
| Kalite puanı | Aynen hesaplanır; artık moderatör değil provider okur. | Yok. |
| Kategori `DRAFT` | `getApprovedProviderForDiscovery` DRAFT kategori bağını dışlar → yayınlansa da görünmez. | Yok. |

### 2.5 Mevcut bekleyen `SUBMITTED` talepler

Migration hiçbir satıra dokunmaz. Anahtar açıldığı anda `SUBMITTED` olanlar aynen kalır;
admin `/requests?status=SUBMITTED` listesinden mevcut "Onayla"/"Reddet" ile tek tek karar
verir (kod değişmez). Admin ekranındaki açıklama metni güncellenir: "Otomatik yayın açıkken
yeni talepler bu kuyruğa düşmez; burada yalnız eski talepler ve doğrulama bekleyenler var."

### 2.6 Vitrin direct lead'e etki

- **Oluşturma, SLA, addressee'nin teklifiyle `APPROVED` geçişi: değişmez.** Direct lead'in
  `SUBMITTED`'ı "moderasyon bekliyor" değil "addressee henüz cevaplamadı" anlamı taşır; SLA
  sweeper'ın ikinci kolu ve `showcase-lead.service.ts` sınıf sözleşmesi bu duruma bağlıdır.
  Sadeleştirme (lead'i `APPROVED` doğurmak) expiry saatini SLA'dan önce başlatır, sweeper
  kollarını ve VIT E2E'lerini yeniden yazdırır — **bu kapsamda önerilmez** (açık karar E).
- **RELEASE değişir.** Bugün RELEASE gate'i temizleyip talebi `SUBMITTED` bırakır ve
  moderasyon bekletir; gerekçesi "okunmamış metin pazara ancak operatörden sonra çıkar" idi.
  Ürün kararıyla bu gerekçe kalktı: `decideFallback` RELEASE dalında, gate NULL'landıktan
  sonra aynı tx'te `publishRequestInTransaction` (anahtar açıksa ve telefon şartı sağlıysa —
  lead zaten doğrulanmış olduğundan her zaman sağlanır) + `RequestPublishOutbox.enqueue`
  → commit sonrası teslim. Anahtar kapalıysa bugünkü davranış.
- "Talebi bildir" direct lead detayında da vardır (3.3); rapor SLA saatini durdurmaz.

### 2.7 Durum makinesi (özet)

```
                 anahtar kapalı / doğrulama bekliyor
  create ──────────────────────────────────────► SUBMITTED ──admin Onayla──► APPROVED
    │                                              │  ▲                        │
    │ anahtar açık (+ doğrulama şartı)             │  └─ verifyCode → APPROVED  │
    └──────────────────────────────────────────────┼───────────────────────────►│
                                                   │                            │
   admin Reddet / rapor "Talebi kaldır" ◄──────────┴────────────────────────────┤
          REJECTED ──rapor "Talebi geri aç" (= moderasyon APPROVED)──► APPROVED │
                                                                               ▼
                                          accept → MATCHED → complete → COMPLETED
                                          expiry → EXPIRED · cancel → CANCELLED
```

Yeni talep enum değeri yok. `nonModerationStatuses`, `terminalStatuses` setleri
değişmez. `REJECTED`'a giden iki ok (moderasyon "Reddet" ve rapor "Talebi kaldır") aynı
yardımcıdan geçer ve 3.5'teki teklif/kredi cascade'ini taşır.

---

## 3. Talep bildirme modeli

### 3.1 Prisma

```prisma
/// Neden bir hizmet veren bir talebi admin önüne getirdi.
enum ServiceRequestReportReason {
  SPAM                    // reklam, anlamsız, tekrar eden
  FAKE_OR_TEST            // gerçek iş değil / deneme
  CONTAINS_CONTACT_INFO   // metinde telefon/e-posta/link (filtreyi atlatmış)
  WRONG_CATEGORY          // bu kategoride verilemeyecek iş
  INAPPROPRIATE_CONTENT   // hakaret, yasa dışı, uygunsuz
  DUPLICATE               // aynı müşterinin aynı işi tekrar açması
  OTHER
}

/// Admin'in bildirim hakkındaki tek kararı.
enum ServiceRequestReportResolution {
  DISMISSED        // "Uygun bulundu": talep yayında kalır
  REQUEST_REMOVED  // "Talebi kaldır": talep REJECTED'a alınır
}

/// Append-only: satır yalnız oluşturulur ve tam bir kez çözülür (open → resolved).
/// UPDATE yalnız çözüm alanlarına, DELETE hiçbir yoldan yok.
model ServiceRequestReport {
  id                 String                          @id @default(cuid())
  requestId          String
  reporterProviderId String
  reason             ServiceRequestReportReason
  /// İsteğe bağlı serbest metin; DTO'da MaxCodeUnitLength(500), trim, boşsa NULL.
  /// Yalnız admin okur; hiçbir müşteri/provider yanıtına yazılmaz.
  note               String?
  createdAt          DateTime                        @default(now())
  resolvedAt         DateTime?
  resolvedByUserId   String?
  resolution         ServiceRequestReportResolution?
  /// Admin'in karar notu (≤500). Müşteriye ve provider'a gösterilmez.
  resolutionNote     String?

  request    ServiceRequest  @relation(fields: [requestId], references: [id], onDelete: Restrict)
  reporter   ProviderProfile @relation(fields: [reporterProviderId], references: [id], onDelete: Restrict)
  resolvedBy User?           @relation("ServiceRequestReportResolvedBy", fields: [resolvedByUserId], references: [id], onDelete: SetNull)

  /// Aynı hizmet veren aynı talebi bir kez bildirir — DB garantisi (P2002 → 409).
  @@unique([requestId, reporterProviderId])
  @@index([requestId])
  /// Provider başına günlük bütçe sayımı.
  @@index([reporterProviderId, createdAt])
  /// Açık kuyruk: partial index raw SQL'de (aşağıda).
  @@index([resolvedAt, createdAt])
}
```

Raw SQL ekleri (Prisma ifade edemez; `ShowcaseLead_release_needs_decision` deseni):
- `CHECK (("resolvedAt" IS NULL) = ("resolution" IS NULL))` — çözümsüz `resolvedAt` ya da
  tarihsiz çözüm yazılamaz.
- `CREATE INDEX "ServiceRequestReport_open_idx" ON "ServiceRequestReport"("createdAt") WHERE "resolvedAt" IS NULL;`

`ServiceRequest.reports ServiceRequestReport[]`, `ProviderProfile.requestReports`,
`User.resolvedRequestReports` ters ilişkileri eklenir. `OperationsSettings` +
`marketplaceAutoPublishEnabled Boolean @default(false)`.

### 3.2 Kim bildirebilir — yetki predikatı

`POST /providers/:providerId/requests/:requestId/reports` (`AuthGuard`,
`ProviderAccessGuard`). Serviste sırayla:

1. `getApprovedProviderForDiscovery(providerId)` — provider `APPROVED`, DRAFT kategori
   bağları dışarıda.
2. Talep görünürlüğü **`ensureProviderCanSeeRequest` ile aynı predikat** (tek tanım; mevcut
   private metot `RequestReportsService`'in kullanabileceği şekilde export/paylaşılır):
   `APPROVED` (veya kendi direct lead'i `SUBMITTED`), telefon filtresi, direct gate,
   kategori bağı, alan eşleşmesi. Sağlanmıyorsa **404** (var olduğunu bile söylemez —
   içerik keşfi engeli).
3. Günlük bütçe: `count(reports where reporterProviderId, createdAt >= now-24h) >= 20` →
   **429** `REPORT_RATE_LIMITED` (sabit `REPORT_MAX_PER_PROVIDER_PER_DAY = 20`, env yok).
4. `create` → P2002 → **409** `REPORT_ALREADY_EXISTS`.
5. Yanıt `201 { id, reason, createdAt }`. Commit sonrası admin bildirimi (bölüm 5).

Bildirim **hiçbir şeyi gizlemez**: talep statüsü, keşif listesi, teklif/kabul akışı
değişmez; bildiren provider dahil herkes teklif vermeye devam edebilir. Detay projeksiyonu
`myReport: { reason, createdAt } | null` alanı kazanır (yalnız kendi raporu; başkalarının
raporu veya sayısı **asla** dönmez).

### 3.3 Ekranlar

**Web — provider talep detayı** (`apps/web/app/providers/[id]/requests/[requestId]/page.tsx`):
"Teklif Ver" panelinin altında ikincil "Talebi bildir" düğmesi → `<dialog>`: neden
(select, 7 seçenek), not (textarea, 500 sayaç), "Bildir". Sunucu aksiyonu
`reportRequestAction` → 201'de `?reported=1` ile geri dön; 409'da "Bu talebi zaten
bildirdiniz"; 429'da "Günlük bildirim sınırına ulaştınız". `myReport` doluysa düğme yerine
"Bildiriminiz alındı · {tarih}" rozeti. Aynı bileşen vitrin lead detayında
(`/providers/[id]/vitrin/talepler/[leadId]`) `requestId` ile kullanılır.

**Admin — kuyruk** `/requests/reports` (nav: Operasyon › "Talep bildirimleri"):
- Sekmeler: Açık (default) · Çözülmüş.
- Satır = **talep** (aynı talebin açık raporları gruplanır): talep no, kategori, il/ilçe,
  statü rozeti, ilk bildirim zamanı, rapor sayısı, neden rozetleri, bildiren işletme(ler),
  açıklamanın ilk 160 karakteri.
- Talep detayına link; kararlar detayda verilir.

**Admin — talep detayı** `/requests/[id]`: yeni "Bildirimler" bölümü: her rapor (neden,
not, işletme adı + link, zaman, çözüm). Açık rapor varsa üç düğme:
- **Uygun bulundu** → `resolution: DISMISSED`, isteğe bağlı not.
- **Talebi kaldır** → `resolution: REQUEST_REMOVED`, **gerekçe zorunlu** (müşteriye
  gösterilecek kategori + admin notu). Yalnız `status ∈ {APPROVED, IN_REVIEW, SUBMITTED}`.
  `MATCHED` için düğme pasif, ipucu "Eşleşmiş talep için 'İptal et' kullanın."
- **Talebi geri aç** → yalnız `status = REJECTED` ve son çözüm `REQUEST_REMOVED` iken görünür.

**Admin — dashboard**: "Açık talep bildirimi" stat kartı (`dashboard.service` +1 sayım).

**Admin — operasyon ayarları**: "Pazar talepleri otomatik yayınlansın" anahtarı
(scheduler anahtarlarıyla aynı bileşen ve denetim satırı).

### 3.4 API uçları

| Uç | Guard | Gövde / yanıt |
|---|---|---|
| `POST /providers/:providerId/requests/:requestId/reports` | Auth + ProviderAccess | `{ reason, note? }` → 201 · 404 · 409 `REPORT_ALREADY_EXISTS` · 429 `REPORT_RATE_LIMITED` |
| `GET /providers/:providerId/requests/:requestId` | mevcut | `+ myReport` |
| `GET /service-requests/reports?state=open\|resolved&cursor` | SUPER_ADMIN | talep başına gruplanmış liste |
| `GET /service-requests/:id/reports` | SUPER_ADMIN | o talebin tüm raporları |
| `POST /service-requests/:id/reports/resolve` | SUPER_ADMIN | `{ resolution: 'DISMISSED'\|'REQUEST_REMOVED', resolutionNote?, removalReason? }` |
| `POST /service-requests/:id/reopen` | SUPER_ADMIN | gövde yok; `{ moderationNote? }` |
| `GET/PUT /operations-settings/marketplace-publish` | SUPER_ADMIN | `{ enabled }`; satır yoksa `false` (fail-closed); değişiklikte `OperationsSettingsChange` (scheduler toggle deseni). *Uygulama notu:* anahtar genel `/operations-settings` gövdesine değil, kendi alt ucuna kondu. |

Neden `PATCH /status` değil de `resolve`: karar ile raporların kapanması **tek transaction**
olmalı; iki ayrı admin isteği "kaldırıldı ama kuyrukta açık" ya da tersini üretebilir.

### 3.5 Karar semantiği (transaction içi)

`resolve` — `runSerializable`, label `requestReports.resolve`:
1. Talebi kilitle/oku (`status`, `showcaseLeadId`, `directShowcaseProviderId`).
2. `open = reports where requestId AND resolvedAt IS NULL`; boşsa 409 `NO_OPEN_REPORTS`.
3. **Tüm açık raporlar** aynı kararla kapanır: `updateMany where {requestId, resolvedAt: null}
   data {resolvedAt: now, resolvedByUserId, resolution, resolutionNote}`. (Rapor başına ayrı
   karar yok: karar talep hakkındadır; kuyrukta stale satır kalmaz.)
4. `REQUEST_REMOVED` ise:
   - `status ∉ {APPROVED, IN_REVIEW, SUBMITTED}` → 409 `REQUEST_NOT_REMOVABLE`
     (`MATCHED` dahil: kaldırma ve iade yolu çalışmaz; eşleşmiş talep için mevcut "İptal et").
   - Paylaşılan yardımcı `rejectRequestInTransaction(tx, {requestId, rejectionReason,
     moderationNote, actorUserId, now})` çağrılır. **Adımları sırayla ve aynı serializable
     transaction'da:**
     1. `updateMany where {id, status in [APPROVED, IN_REVIEW, SUBMITTED]} data {status:
        REJECTED, rejectionReason, moderationNote, moderatedAt: now}`; `count !== 1` → 409
        (yarış: bu arada `MATCHED` olmuş olabilir; serializable retry sonrası iş kuralına düşer).
     2. `showcaseLeadId` varsa `showcaseLeads.closeForRequest(tx, id, MODERATION_REJECTED, now)`.
     3. **Teklif cascade'i** (3.5.1).
     4. **Kredi iadesi** (3.5.2).
     Herhangi bir adım throw ederse transaction geri alınır: talep `REJECTED`'a geçmez,
     hiçbir teklif kapanmaz, hiçbir ledger satırı kalmaz.
   - Aynı yardımcı moderasyon ekranındaki "Reddet" tarafından da kullanılır: operatörün elle
     reddettiği, üzerinde aktif teklif bulunan talep aynı durumdadır (platform kapattı) ve
     aynı cascade'i alır. Bugün "Reddet" teklifleri olduğu gibi bırakıyordu; bu, v1'de
     bilinçli olarak düzeltilen bir tutarsızlıktır.
5. Commit sonrası: `REQUEST_REMOVED` → müşteriye `request-removed` e-postası (bölüm 5).
   Provider'a e-posta yok; `sendCreditRefunded` bu iade için **çağrılmaz** (karar F).

#### 3.5.1 Teklif cascade'i — hangi durum?

Kapanacak küme: `status ∈ {SUBMITTED, VIEWED, SHORTLISTED}` (kabul edilmemiş aktif
teklifler; `WITHDRAWABLE_OFFER_STATUSES` ile aynı küme). `REJECTED`, `WITHDRAWN`,
`EXPIRED`, `CANCELLED` zaten terminaldir, dokunulmaz; `ACCEPTED` yoktur çünkü talep
`MATCHED` değil.

Hedef durum: **mevcut `OfferStatus.CANCELLED`, yeni enum yok.** Gerekçe:
- `offer-transitions.ts:60-68`'e göre `SUBMITTED`, `EXPIRED`, `CANCELLED` bugün hiçbir
  yerde yazılmıyor; `CANCELLED` "platform kapattı" anlamı için ayrılmış boş yuvadır.
- `CUSTOMER_UNACTIONABLE_OFFER_STATUSES = [WITHDRAWN, CANCELLED, EXPIRED]` — müşteri
  `updateRequestOfferAction` ile `CANCELLED` teklife dokunamaz (400 "cannot be acted on");
  accept `updateMany where status notIn [...]` eşleşmez; admin `ADMIN_OFFER_ACTIONS` üç
  aksiyonu da aynı yolu kullanır → admin de dokunamaz; provider geri çekme
  `WITHDRAWABLE_OFFER_STATUSES` dışında → 409. Müşterinin "artık işlem yapamayacağı
  terminal durum" şartı mevcut guard'larla **kendiliğinden** sağlanır.
- `REJECTED` yanlış olurdu: `OfferRejectionReason` "müşteri/rakip kararı" sözlüğüdür ve
  `offer-not-selected` maili tetiklenir. `WITHDRAWN` provider'ın kararıdır. `EXPIRED`
  expiry sözcüğüne bağlıdır.
- Yazım: `updateMany where {requestId, status in [SUBMITTED, VIEWED, SHORTLISTED]} data
  {status: CANCELLED, cancelledAt: now}`. `Offer.cancelledAt DateTime?` **yeni, ek,
  nullable sütun** (`acceptedAt/rejectedAt/withdrawnAt` ile simetri; NULL = hiç
  iptal edilmedi, mevcut satırların tamamı). `offer-transitions.ts` yorumu "CANCELLED'ın tek
  yazarı `rejectRequestInTransaction`" olarak güncellenir.

#### 3.5.2 Kredi iadesi — kural, idempotency, çakışmalar

**Kural.** 3.5.1'de kapatılan her teklif için, `entitlementSource = ONE_TIME_CREDIT`,
`creditSpentTransactionId IS NOT NULL`, `creditCost > 0` ve `creditRefundedTransactionId
IS NULL` ise **tam kredi iadesi** (`creditCost` kadar), görüntülenmiş/görüntülenmemiş,
`refundBlockedAt` ve `unviewedRefundPolicy` **ayrımı yapılmadan** — talep platform
tarafından kaldırıldı, sağlayıcı zarara uğramaz.

- Direct showcase lead teklifi (`SHOWCASE_PLACEMENT`, `creditCost = 0`,
  `creditSpentTransactionId NULL`): iade satırı üretilmez, yalnız teklif `CANCELLED` olur.
- `MONTHLY_QUOTA` / `UNLIMITED` teklifleri (`creditSpentTransactionId NULL`): ledger
  hareketi yok, teklif `CANCELLED` olur. Mevcut ürün kuralı `PERIOD_PACKAGE_NOT_REFUNDABLE`
  (`refund-policy.ts:260-276`: dönem satın alınmıştır, kota geri yazmak `remainingQuota <=
  quotaCreditsSnapshot` CHECK'iyle çelişebilir ve dönem yenilenmiş olabilir) burada da
  geçerlidir; v1'in kesin davranışıdır, açık karar değildir. Panel metni bu tekliflerde
  yalnız "Talep yayından kaldırıldı."

**Mekanizma.** Mevcut `refundOfferCreditInTransaction(tx, offer, storedReason, {
enforceUnviewedPolicy: false, createdById: adminUserId })` (`offers.service.ts:864`)
aynen kullanılır; yeni ledger kodu yazılmaz. Yeni sabit `REQUEST_REMOVED_REFUND_REASON =
'REQUEST_REMOVED'` (`refund-policy.ts`, `REFUND_REASON_LABELS`'a etiketi "Talep yayından
kaldırıldı — kredi iadesi"). `enforceUnviewedPolicy: false` tam olarak manuel iadenin
kullandığı moddur: `viewedAt`, `refundBlockedAt`, `unviewedRefundPolicy` sorgulanmaz;
parayı koruyan dört koşul (`creditRefundedTransactionId: null`, `creditRefundedAt: null`,
`creditSpentTransactionId: not null`, `creditCost > 0`) korunur. Ledger satırı
`OFFER_REFUND`, `referenceType 'Offer'`, `referenceId offerId`, `createdById = admin`.

**İdempotency — üç bağımsız kat.**
1. **Ledger, DB:** partial unique index `ProviderCreditTransaction_one_refund_per_offer`
   (`UNIQUE(referenceId) WHERE type='OFFER_REFUND' AND referenceType='Offer'`) — aynı
   teklif için ikinci `OFFER_REFUND` satırı **temsil edilemez**; P2002 → 409, tx rollback.
2. **Teklif satırı, koşullu UPDATE:** `creditRefundedTransactionId: null AND
   creditRefundedAt: null` şartı; `count !== 1` → throw.
3. **Cascade'in kendisi:** aday seçimi `where {requestId, status in [aktif],
   creditRefundedTransactionId: null, ...}` olduğundan zaten iade edilmiş bir teklif adaya
   girmez (throw değil, doğal atlama). `resolve`'un ikinci çağrısı zaten adım 2/4.1'de 409
   alır (`NO_OPEN_REPORTS` / `REQUEST_NOT_REMOVABLE`): talep `REJECTED`, aktif teklif yok,
   cascade tekrar koşamaz. Bakiye `balanceAfter` tx içinde okunur; ikinci artış mümkün değil.

**Çakışmalar.**
- *Unviewed sweeper (48 s):* aday sorgusu `inPolicyUnrefundedWhere`
  (`creditRefundedTransactionId: null, creditRefundedAt: null`) — kaldırma iadesi bu iki
  alanı doldurduğu için teklif sweeper'ın adayı olmaktan çıkar; sweeper tx'i aynı anda
  koşuyorsa serializable yarış: kazanan yazar, kaybeden replay'de `SKIPPED` (sweeper) ya da
  adaydan düşme (cascade) görür; ikisi de kazansa bile kat 1 ikinci ledger satırını
  reddeder. `refundBlockedAt` yazılmaz — o sütun "admin müşteri adına karar verdi"
  anlamındadır ve burada yalan olurdu.
- *Manuel iade:* `refundOfferCredit` aynı `creditRefundedTransactionId: null` şartını ve
  `ManualOfferRefundAudit.offerId UNIQUE`'i taşır → 409 "already refunded". Ters yön: manuel
  iade önce yapılmışsa cascade adaydan düşürür.
- *Reopen sonrası:* "Talebi geri aç" `CANCELLED` teklifleri geri açmaz ve iadeyi geri
  almaz (kredi provider'a döndü; isterse yeniden teklif verir — `@@unique([providerId,
  requestId])` nedeniyle **aynı provider yeniden teklif veremez**; bu v1'in kabul edilen
  sınırıdır ve reopen ekranında operatöre yazılır: "Kapatılan teklifler geri açılmaz").

**Provider ekranı metni** (`withRefundEligibility` / teklif detayı ve listesi, `status =
CANCELLED` ve talep `REJECTED` iken):
- `creditRefundReason = 'REQUEST_REMOVED'` → **"Talep yayından kaldırıldı. Harcanan teklif
  krediniz iade edildi."** (+ iade tutarı ve ledger tarihi).
- `creditCost = 0` (vitrin lead) ve dönem paketi teklifleri → **"Talep yayından kaldırıldı."**

`reopen`:
- Ön koşul: `status = REJECTED` **ve** en az bir rapor `resolution = REQUEST_REMOVED`
  (moderatörün elle reddettiği talep bu uçtan açılmaz; onun için mevcut "Onayla" durur).
- Yazım: mevcut `updateServiceRequestStatus(id, {status: APPROVED, moderationNote})` ile aynı
  yol (telefon gate'i dahil) → `approvedAt = now` (14 gün yeniden başlar, kod yorumundaki
  "re-approval refreshes the window" sözleşmesi), `rejectionReason: null`, commit sonrası
  fan-out (dedupe: daha önce mail alan provider'a ikinci mail gitmez).
- Rapor satırlarına dokunulmaz (append-only). "Geri açıldı" bilgisi türetilir:
  `report.resolution = REQUEST_REMOVED && request.status ≠ REJECTED` → kuyrukta "Kaldırıldı →
  geri açıldı" etiketi.

### 3.6 Kaldırılmış talepte davranış (`REJECTED`)

| Akış | Davranış | Kaynak |
|---|---|---|
| Keşif listesi/detay | Görünmez (`status = APPROVED` filtresi). | mevcut |
| Yeni teklif | 404 `Request not found` (`ensureProviderCanSeeRequest`). | mevcut |
| Teklif kabulü | 409 (`updateMany where APPROVED` eşleşmez). | mevcut |
| Mevcut aktif teklifler | Kaldırma tx'inde `CANCELLED` + `cancelledAt` (3.5.1). Müşteri shortlist/reject/accept: `CUSTOMER_UNACTIONABLE_OFFER_STATUSES` → 400/409. Müşteri ekranı `CANCELLED` teklifi "Talep kaldırıldığı için kapatıldı" olarak salt okunur gösterir. | 3.5.1 + küçük UI |
| Geri çekme | 409 `OFFER_NOT_WITHDRAWABLE` (talep APPROVED değil; teklif zaten CANCELLED). | mevcut |
| Mesajlaşma | Zaten yalnız `MATCHED`; kaldırma MATCHED'a uygulanmadığı için etkilenmez. | mevcut |
| Expiry / hatırlatma | Yalnız `APPROVED` tarar → kaldırılmış talep asla `EXPIRED` olmaz, hatırlatma gitmez. | mevcut |
| Harcanan krediler | Kaldırma tx'inde `ONE_TIME_CREDIT` teklifleri için tam iade, `REQUEST_REMOVED` gerekçesiyle (3.5.2); unviewed sweeper ve manuel iade aynı teklifi ikinci kez ödeyemez. | 3.5.2 |
| Müşteri panosu | `REJECTED` → mevcut "Reddedildi" rozeti; açıklama metni + e-posta (bölüm 5). | metin |
| Provider'ın teklif listesi/detayı | Teklif `CANCELLED`; metin "Talep yayından kaldırıldı. Harcanan teklif krediniz iade edildi." / kredi 0 ise "Talep yayından kaldırıldı." Provider'a e-posta **yok**. | karar F (kesin) |

---

## 4. Kötüye kullanım ve gizlilik

### 4.1 Telefon doğrulaması zorunlu olmalı mı? — **Öneri: v1'de hayır, mimari hazır**

Değerlendirme:
- Gerçek SMS transport'u yok (`ConsoleSms`/`FileOutboxSms`); `REQUIRE_PHONE_VERIFICATION=true`
  bugün "her yeni talebi doğrulanamaz durumda bırakır" (`.env.example:160`). Zorunlu kılmak =
  anında yayın hedefini SMS entegrasyonuna kadar ertelemek.
- Telefon doğrulaması provider'ı "ulaşılamayan müşteri"den korur; müşteri iletişim bilgisi
  ise **zaten** eşleşmeden önce açılmıyor (`toProviderRequestDetail` ad/telefon/e-posta
  taşımaz; reveal yalnız accept tx'inde). Teklif kabulü hesabı etkinleştirmiş (e-posta
  kanıtlı) müşteriye aittir. Görüntülenmemiş teklif 48 saatte iade edilir. Yani sahte
  numaranın maliyeti sınırlı ve mevcut mekanizmalarla karşılanır.
- Vitrin lead'de zorunluluk "operatör yok + tek işletmeye direkt" gerekçesiyle konmuştu; bu
  gerekçe artık pazar için de geçerli, fakat transport yokken uygulanabilir değil.

Karar: `createServiceRequest` kuralı `REQUIRE_PHONE_VERIFICATION` flag'ini **okur** (2.2):
flag `false` iken oluşturmada yayın; flag `true` iken `SUBMITTED` doğar, müşteri talep
ekranından kodu doğruladığı anda `verifyCode` tx'i yayınlar (admin dokunmaz). SMS transport'u
geldiğinde tek yapılacak flag'i açmaktır — kod değişmez. Vitrin formundaki oluşturma-öncesi
OTP adımının normal forma taşınması v2 (açık karar B).

### 4.2 Hız sınırları

| Katman | Bugün | Öneri |
|---|---|---|
| `POST /service-requests` IP | **Yok** | `AuthModule` `forRoot` listesine `service-requests` adlı throttler: **5 / 10 dk / IP** (`RequestDraftThrottlerGuard` deseniyle `ServiceRequestThrottlerGuard`, `throttlerName` override; `req.ip` → `TRUST_PROXY`). Sabitler `service-requests.constants.ts`. *Uygulama notu:* limit/pencere `SERVICE_REQUEST_RATE_LIMIT_MAX` / `SERVICE_REQUEST_RATE_LIMIT_WINDOW_SECONDS` ile geçersiz kılınabilir (varsayılan 5 / 600; `auth` throttler emsali; E2E `1000` verir). Telefon ve açık talep sınırları env'siz sabit. |
| Telefon başına | Yok | Tx içinde sayım: son 24 saatte aynı `customerPhone` ile `status ∈ {SUBMITTED, APPROVED}` talep ≥ **5** → 429 `REQUEST_RATE_LIMITED`. Mevcut `@@index([phoneVerifiedAt])` yetmez; `@@index([customerPhone, submittedAt])` eklenir. |
| Kullanıcı başına | Yok | Aynı sayım `customerId` ile (oturumlu müşteri); misafirde telefon sayımı zaten kapsar. |
| Açık talep tavanı | Yok | Aynı telefonla **açık (`APPROVED`) talep ≥ 10** → 429. Acil talep senaryosunu bozmaz. |
| Rapor | — | Provider başına 20/24 s (3.2). |
| OTP | 3/saat telefon, 10/saat IP | Değişmez. |

### 4.3 PII engeli — açıklama, adres notu, serbest metin cevaplar

Tek kural, iki okuyucu: `packages/shared/contact-patterns.json` (regex kaynakları) →
`packages/shared/src/contact-detection.ts` (form, anlık uyarı) ve
`apps/api/src/common/contact-detection.ts` (DTO/servis, **asıl kural**; `limits.json`
gerekçesiyle JSON okunur, TS paketi import edilmez).

Tespit (Türkçe odaklı, yanlış pozitifi sınırlı):
- **Telefon:** `[\s.\-()]` ayraçları atılmış rakam dizisi 10–13 haneli **ve** `0`, `90`,
  `+90` ya da `5` ile başlıyorsa. "15000 TL", "12.03.2026", "34000" gibi değerler yakalanmaz;
  "0532 123 45 67", "+90 (532) 123-45-67", "5321234567" yakalanır.
- **E-posta:** `[^\s@]+@[^\s@]+\.[^\s@]{2,}` + `[at]`, `(at)`, ` at ` + `[dot]`/`(nokta)`
  varyantları.
- **URL / mesajlaşma:** `https?://`, `www.`, `wa.me`, `t.me`, `\b[\w-]+\.(com|net|org|
  tr|io|me|co)\b`, `instagram.com/`, `@kullanıcı` **hariç** (yanlış pozitif riski).
- Uygulama noktaları: `description`, `addressNote`, `TEXT`/`TEXTAREA` tipli cevap değerleri
  (`validateAnswerValue`), vitrin lead açıklaması (aynı DTO yolu). Teklif `message`'ı
  **kapsam dışı** (açık karar G).
- Yanıt: `400 { code: 'CONTACT_DETAILS_IN_TEXT', field, kind: 'phone'|'email'|'url' }`.
  Form ilgili alanın altında: "İletişim bilgisi (telefon, e-posta, bağlantı) paylaşılamaz;
  bilgiler teklif kabul edildiğinde otomatik paylaşılır." Mevcut satırlar yeniden
  doğrulanmaz.
- Sınır kabulü: regex bir engel, garanti değil ("sıfır beş üç iki…" gibi yazımlar geçer);
  insan raporu (`CONTAINS_CONTACT_INFO`) yedek katmandır.

### 4.4 Rapor uç noktası riskleri

| Risk | Karşılık |
|---|---|
| Rakip sabote (rapor yağmuru ile talebi kapattırma) | Otomatik gizleme **yok**; tek sonuç admin kuyruğu. Provider başına 20/gün. Unique (talep, provider). Kuyrukta bildiren işletme adı görünür; tekrarlayan asılsız raporlar admin için desen olur (v2: provider başına "asılsız rapor" sayacı — açık karar H). |
| Spam / kuyruk şişirme | Günlük bütçe + unique + 404 görünürlük kuralı: göremediği talebi bildiremez. |
| Sahte rapor (yanıltıcı neden) | Karar insanın; not ≤500, HTML olarak render edilmez. |
| İçerik keşfi (rapor uç noktasıyla id tarama) | Görünmeyen talep → 404, var/yok ayrımı sızmaz; yanıt yalnız kendi raporunu taşır; başka raporların varlığı/sayısı hiçbir provider yanıtında yok. |
| Karar oracle'ı | Provider karar sonucunu görmez (bölüm 5). |
| ProviderAccessGuard atlatma | Aynı guard, aynı `providerId` sahiplik kontrolü. |

---

## 5. Bildirimler ve admin operasyonu

**Admin'e yeni rapor.** Mevcut `support-ticket-*-new-for-support` deseni: yeni şablon
`request-report-new-for-support` → alıcı `readSupportInboxEmail()` (`SUPPORT_INBOX_EMAIL`;
ayar değişikliği yok), dedupeKey `request-report:<reportId>`, veri: talep no, kategori, neden
etiketi, admin detay linki (`adminRequestUrl`). Not metni e-postaya **yazılmaz** (NotificationLog
ilkesi: gövde yok, panel linki var). İkinci kanal: dashboard sayacı + nav rozeti. Yeni
NotificationLog alanı yok; `requestId` ve `providerId` (bildiren) mevcut sütunlara yazılır.

**Müşteriye talep kaldırıldığında.** Yeni şablon `request-removed` (müşteri), konu
"Talebiniz yayından kaldırıldı". Gövde:

> Merhaba {ad}, {kategori} için açtığınız #{talepNo} numaralı talep, platform kurallarına
> uygunluk incelemesi sonucunda yayından kaldırıldı. Gerekçe: **{gerekçe etiketi}**.
> Talep artık hizmet verenlere gösterilmiyor. Mevcut teklifler artık işleme alınamaz.
> Bilgileri düzelterek yeni bir talep açabilir ya da itiraz için destek ekibine
> yazabilirsiniz.
> {Destek linki} · {Yeni talep linki}

"Mevcut teklifler artık işleme alınamaz" cümlesi 3.5.1'in gerçek davranışıdır: teklifler
aynı transaction'da `CANCELLED` olur ve müşteri hiçbirine aksiyon alamaz. Şablon bu cümleyi
yalnız `rejectRequestInTransaction`'ın cascade'i koştuğu yoldan gönderildiğinde taşır —
başka bir yol talebi kapatmadan bu şablonu kullanamaz (tek çağıran).
`{gerekçe etiketi}` müşteriye dönük sabit sözlüktür (örn. `CONTAINS_CONTACT_INFO` → "Talep
metninde iletişim bilgisi paylaşımı"); admin notu ve bildiren işletme **asla** yazılmaz.
dedupeKey `request-removed:<requestId>:<resolvedAt>`. `admin-triggered retry` listesine
eklenir (mevcut `composeRetryMessage` switch'i).

**Provider'a e-posta gönderilmez** — ne "talep kaldırıldı" ne de `credit-refunded`
(`sendCreditRefunded` bu iade gerekçesi için çağrılmaz). İade ve kapanma durumu provider
panelinde teklif satırında ve kredi hareketlerinde (`REQUEST_REMOVED` etiketiyle) görünür.

**Provider'a karar gösterimi — öneri: gösterilmesin.** Detayda yalnız "Bildiriminiz alındı"
(açık) / "Bildiriminiz incelendi" (çözülmüş) durumu; karar (uygun/kaldırıldı) yok. Gerekçe:
karar oracle'ı olmasın, rakip taciz aracına dönüşmesin, itiraz yükü admin'e binmesin.
Kaldırılan talep zaten provider listesinden düşer.

**Kapsam dışı:** scheduler cron'ları, Lemon/ödeme, `.env`, Cloudflare, Resend ayarları.
Yeni env değişkeni **yok**.

---

## 6. Migration etkisi

Tek migration `20260914xxxxxx_add_request_reports_and_auto_publish`:
1. `CREATE TYPE ServiceRequestReportReason`, `ServiceRequestReportResolution`.
2. `CREATE TABLE ServiceRequestReport` + unique + indexler + FK'ler (Restrict/Restrict/SetNull)
   + CHECK + partial index (raw).
3. `ALTER TABLE OperationsSettings ADD COLUMN marketplaceAutoPublishEnabled BOOLEAN NOT NULL DEFAULT false`.
4. `CREATE INDEX ServiceRequest_customerPhone_submittedAt_idx` (4.2).
5. `ALTER TABLE Offer ADD COLUMN cancelledAt TIMESTAMP(3)` (nullable, default yok; mevcut
   satırlar NULL = hiç iptal edilmedi).

**DML yok.** `ServiceRequest` ve `Offer` satırlarına, `status`/`approvedAt`/`moderatedAt`
sütunlarına dokunulmaz. Yeni ledger/iade davranışı yalnız migration sonrası verilen
kaldırma kararlarında koşar; mevcut ledger satırları ve partial unique index
`ProviderCreditTransaction_one_refund_per_offer` aynen kalır (yeni index gerekmez — iade
kaydı aynı `OFFER_REFUND/Offer` şeklindedir). Mevcut `SUBMITTED / APPROVED / MATCHED / EXPIRED / REJECTED / CANCELLED /
COMPLETED / IN_REVIEW` kayıtları migration öncesi ve sonrası birebir aynıdır; kanıt yöntemi
bölüm 7.6.

Geri alma: `DROP TABLE`, `DROP TYPE ×2`, `ALTER TABLE … DROP COLUMN` ×2, `DROP INDEX` —
veri kaybı yalnız rapor satırlarında ve `Offer.cancelledAt` değerlerinde (yeni veri);
`CANCELLED` statüsü ve ledger satırları geri almada da kalır (enum mevcut).

---

## 7. Doğrulama planı

### 7.1 Birim / API (vitest, `apps/api/test/*.spec.ts`)
- `request-auto-publish.spec.ts`: anahtar kapalı → `SUBMITTED`, `approvedAt NULL`,
  `request-received` gönderildi; anahtar açık + flag kapalı → `APPROVED`, `approvedAt ===
  submittedAt`, `moderatedAt NULL`, `request-received` **yok**, fan-out çağrıldı; anahtar
  açık + flag açık + doğrulanmamış → `SUBMITTED`, `verifyCode` sonrası `APPROVED` + fan-out;
  direct lead → daima `SUBMITTED` (gate set); RELEASE + anahtar açık → `APPROVED`.
- `request-reports.spec.ts`: 201; ikinci rapor 409; provider `PENDING_REVIEW` → 403;
  kategori/alan dışı → 404; başka provider'a ayrılmış lead → 404; 21. rapor 429; `myReport`
  yalnız kendi; `resolve DISMISSED` talep `APPROVED` kalır ve tüm açık raporlar kapanır;
  `resolve REQUEST_REMOVED` → `REJECTED`, `rejectionReason`, lead kapanır, `request-removed`
  maili; `MATCHED` talepte 409; `reopen` → `APPROVED`, `approvedAt` yeni, elle reddedilende 409.
- `request-removal-refund.spec.ts` (kaldırma cascade'i ve iade):
  - **Görüntülenmiş normal teklif** (`viewedAt` dolu) → kaldırmada teklif `CANCELLED`,
    `cancelledAt` dolu, tam `creditCost` iadesi: bir `OFFER_REFUND` ledger satırı
    (`reason = 'REQUEST_REMOVED'`, `createdById = admin`), bakiye `+creditCost`,
    `creditRefundedTransactionId/At/Reason` dolu.
  - **Görüntülenmemiş normal teklif** → kaldırmada tam iade; ardından
    `UnviewedOfferRefundService.execute` ve `previewCandidates` bu teklifi **adaya almaz**
    (`SKIPPED`/yok), ledger satır sayısı ve bakiye değişmez.
  - **Birden çok teklif** (görüntülenmiş + görüntülenmemiş + shortlisted) → her biri için
    tam bir iade; ikinci `resolve` çağrısı 409 ve ledger/bakiye değişmez; partial unique
    index doğrudan denemede P2002 → 409.
  - **Direct lead / 0 kredi teklif** (`SHOWCASE_PLACEMENT`) → teklif `CANCELLED`, ledger
    satırı yok, bakiye aynı; `MONTHLY_QUOTA` teklifi → `CANCELLED`, `remainingQuota` aynı.
  - **`MATCHED` talep** → `resolve REQUEST_REMOVED` 409 `REQUEST_NOT_REMOVABLE`; teklif
    durumu, ledger ve bakiye değişmez.
  - **Atomiklik:** iade adımı yapay olarak throw ettirildiğinde (`refundOfferCreditInTransaction`
    mock) talep `APPROVED` kalır, hiçbir teklif `CANCELLED` olmaz, ledger boş.
  - **Manuel iade çakışması:** kaldırma sonrası `refundOfferCredit` 409 "already refunded";
    önce manuel iade yapılmış teklif kaldırmada adaya girmez.
  - **Moderasyon "Reddet"** aktif teklifli `APPROVED` talepte aynı cascade'i koşar.
  - **Reopen** sonrası `CANCELLED` teklifler ve iadeler değişmez.
- `request-publish-outbox.spec.ts`: oluşturma tx'i sonrası `request-published` (1) +
  `request-available` (provider başına 1) PENDING satırları; `deliverPending` SENT'e
  çevirir; ikinci `enqueue` `skipDuplicates` ile 0 satır; `deliverPending` iki kez
  çalıştığında tek gönderim (lease); teslim atlanmışsa (dispatcher mock'u düşürülünce)
  sonraki `deliverPending` eski satırı alır; expiry tick'i `RequestPublishOutbox.
  deliverPending`'i çağırır.
- `contact-detection.spec.ts` (shared + api paritesi): pozitif/negatif örnek tablosu
  (bütçe, tarih, posta kodu, IBAN parçası negatif; TR mobil/sabit, e-posta obfuscation, URL
  pozitif).
- `service-request-rate-limit.spec.ts`: IP 6. istek 429; aynı telefon 24 s içinde 6. talep
  429; açık talep tavanı.
- Kaldırılmış talepte: teklif 404, accept 409, withdraw 409, mesaj 404, expiry taraması
  atlar.

### 7.2 E2E (Playwright, Chromium **ve** WebKit; `pnpm e2e <filtre>`, `--` yok)
- `request-auto-publish.spec.ts`: admin anahtarı açar → müşteri talep açar → başarı sayfası
  "yayında" → **admin'e dokunmadan** eşleşen provider listesinde görünür → provider teklif
  verir → müşteri teklifi görür. Acil (`urgency`) varyantı aynı akış.
- `request-report-flow.spec.ts`: provider "Talebi bildir" → rozet "Bildiriminiz alındı" →
  ikinci deneme yok/409 → admin kuyruğunda satır → "Uygun bulundu" → provider listede hâlâ
  var; ikinci senaryo: iki provider teklif verir → "Talebi kaldır" → provider listesinde
  yok, teklif sayfası 404, provider teklif detayında "Talep yayından kaldırıldı. Harcanan
  teklif krediniz iade edildi." ve kredi bakiyesi eski değerine döndü, müşteri panosu
  "Reddedildi" ve teklifler kapalı, müşteri e-postası outbox'ta → "Talebi geri aç" →
  provider listesinde yeniden, kapatılan teklifler kapalı kalır.
- `request-contact-filter.spec.ts`: açıklamada telefon → form hatası, talep oluşmaz; temiz
  metin → oluşur.
- Mevcut `marketplace-journey.spec.ts`, `phone-verification-gate.spec.ts`,
  `hero-request-demo.spec.ts` gözden geçirilir: admin onay adımı anahtar durumuna göre
  koşullu hale gelir (anahtar default kapalı olduğundan mevcut testler kırılmaz).
- WebKit notu (hafıza): fullPage×DPR, route announcer `role=alert` çakışması — yeni
  hata/rozet metinleri `data-testid` ile seçilir.

### 7.3 Migration dry-run (repo deseni: `docs/superpowers/plans/*-migration-dryrun.txt`)
Aktif DB'nin `pg_dump` kopyasına (`taktic_autopublish_dryrun`) `prisma migrate deploy`;
öncesi/sonrası tablo parmak izi (`count + md5(string_agg(id|status|approvedAt|moderatedAt
ORDER BY id))`) `ServiceRequest`, `Offer`, `ShowcaseLead`, `NotificationLog`,
`OperationsSettings` için; dry-run DB iş sonunda DROP.

### 7.4 Kabul kriterleri (özet)
1. Yeni normal talep, oluşturma yanıtından hemen sonra eşleşen provider listesinde ve teklif
   verilebilir; hiçbir admin aksiyonu yok.
2. Bildirim oluşturma / unique / yetkisiz provider reddi / üç admin kararı / kaldırılmış
   talepte teklif-mesaj-accept engelleri testlerle kanıtlı.
3. PII içeren açıklama reddi (API 400 + form mesajı).
4. Migration sonrası `SELECT status, count(*) FROM "ServiceRequest" GROUP BY 1` ve parmak
   izleri değişmemiş; bekleyen `SUBMITTED` talepler admin listesinde ve "Onayla" çalışıyor.

---

## 8. Ürün kararları (rev. 2 — kesinleşti)

Bu tablo artık açık soru listesi değil, v1'in kabul edilmiş kararlarıdır.

| # | Karar | v1 davranışı |
|---|---|---|
| A | Otomatik yayın anahtarı | `OperationsSettings.marketplaceAutoPublishEnabled`, default kapalı, ekrandan açılır, `OperationsSettingsChange` denetimli. Sert geçiş yok. |
| B | Telefon doğrulaması | Gerçek SMS transport'u gelene kadar normal pazar talebinde **zorunlu değil**. `REQUIRE_PHONE_VERIFICATION=true` olduğunda talep `SUBMITTED` doğar ve doğrulama transaction'ında otomatik yayınlanır (2.2, 4.1). Oluşturma-öncesi OTP adımı v2. |
| C | Yayın bildirimlerinin dayanıklılığı | Salt fire-and-forget **yok**. `request-published` / `request-available` niyetleri yayın transaction'ında NotificationLog PENDING satırı olarak kalıcılaşır (`@@unique([template, dedupeKey])`), `RequestPublishOutbox.deliverPending` commit sonrası bloklamadan teslim eder; kaçanlar sonraki teslim, expiry tick'inin mevcut outbox süpürmesi ve admin yeniden gönderme ile taşınır. Yeni scheduler yok (2.3). |
| D | Expiry 14 g / hatırlatma 7 g | Aynı sabitler; saat `approvedAt = submittedAt`. |
| E | Direct lead'in `SUBMITTED` doğuşu | Değişmez; yalnız RELEASE otomatik yayına ve outbox'a bağlanır. |
| F | Kaldırılan talepte teklif veren hizmet sağlayıcıya bildirim | **E-posta gönderilmez** (ne "kaldırıldı" ne `credit-refunded`); panelde teklif satırında iade/kapanma durumu ve kredi hareketlerinde `REQUEST_REMOVED` etiketi görünür. |
| K | Kaldırmada teklif ve kredi | **Kesin v1 davranışı, açık karar değil:** aktif teklifler (`SUBMITTED/VIEWED/SHORTLISTED`) aynı serializable transaction'da `CANCELLED` + `cancelledAt`; `ONE_TIME_CREDIT` teklifleri görüntülenme ayrımı olmadan tam iade (`REQUEST_REMOVED` gerekçesi, `refundOfferCreditInTransaction`, `enforceUnviewedPolicy: false`); direct lead (0 kredi) ve dönem paketi tekliflerinde ledger hareketi yok; idempotency partial unique index + koşullu UPDATE + aday filtresiyle üç katlı; iade başarısızsa talep `REJECTED`'a geçmez; `MATCHED` talepte yol çalışmaz (3.5.1, 3.5.2). Moderasyon "Reddet" aynı cascade'i koşar. |
| G | Teklif `message` alanında PII filtresi | v1 hayır (yön ters: provider→müşteri; ayrı iş). |
| H | Asılsız rapor sayacı / provider itibar etkisi | v1 hayır; kuyrukta bildiren adı görünür, admin gözlemler. |
| I | Müşteriye dönük gerekçe sözlüğü metinleri | Bölüm 5 taslağı esas alınır; metinler uygulama planında son hâlini alır. |
| J | Rapor günlük bütçesi 20; talep hız sınırları 5/10 dk IP, 5/24 s telefon, 10 açık talep | Kodda sabit. *Uygulama notu:* yalnız IP bütçesi `SERVICE_REQUEST_RATE_LIMIT_MAX` / `SERVICE_REQUEST_RATE_LIMIT_WINDOW_SECONDS` ile geçersiz kılınabilir (varsayılan 5 / 600; E2E `1000`); diğerleri env'siz. |

Sonraki adım: `superpowers:writing-plans` ile uygulama planı; sıralama
(1) migration + Prisma + anahtar, (2) oluşturma/yayın yolu + `RequestPublishOutbox`,
(3) `rejectRequestInTransaction` cascade + iade, (4) rapor API + admin kuyruğu,
(5) PII + hız sınırı, (6) web/admin ekranları ve metinler, (7) E2E + dry-run.
