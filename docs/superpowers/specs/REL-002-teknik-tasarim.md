# REL-002 — Provider Reliability / Match Round — Teknik Tasarım ve Fazlandırma

- Baseline: `main@ad96b1360b3602510d63cd7e3efe6ddc486a8a0f` (doğrulandı), yerel DB 94 migration (doğrulandı), release `v0.1.0`
- Durum (2026-10-11): §29'daki 9 ürün kararı **kesinleşti** ve bu dokümana işlendi. **Faz 1 uygulandı** (match-round şeması, backfill, lifecycle dual-write; davranış değişikliği yok) — gerçek şema adları, uygulama sonucu ve runbook §30'da. Faz 2–5 hâlâ tasarım.
- Faz 1 öncesi yerel DB'ye yalnızca salt-okunur sorgu atıldı (`BEGIN READ ONLY`). Sonuçlar:
  - ServiceRequest: SUBMITTED 6 (3'ü direct lead), APPROVED 9 (2'sinde `approvedAt` NULL), REJECTED 1, MATCHED 2, COMPLETED 5.
  - Offer: 14 satır, 7 ACCEPTED. 14 tekliften yalnız 7'sinde `estimatedStartDate` / `estimatedCompletionDate` dolu.
  - Diğer: ContactRevealEvent 4, MessageThread 1, ProviderReview 1.

Dosya yolları `apps/api/src/modules/` göreli verilmiştir. Aksi belirtilmişse kök dizine göredir.

---

## 1. Mevcut model envanteri ve REL-002 blokerleri

### 1.1 Envanter

**`ServiceRequest.status`** (schema:130)
- Bugün: 9 değer. MATCHED'i yalnız accept cascade yazar, COMPLETED/CANCELLED'ı lifecycle endpoint'leri yazar.
- REL-002 etkisi: MATCHED → APPROVED geri geçişi gerekiyor (yeni tur). Tur 3 başarısız olursa yeni bir status gerekiyor (§21).

**`ServiceRequest.matchedOfferId`**
- Bugün: `@unique`, nullable. Yalnız accept yazar, cancel bunu tarih olarak tutar.
- REL-002 etkisi: **Current-round projeksiyonu** olarak kalır. Başarısızlıkta NULL'a çekilir; tarihsel doğruluk round tablosunda yaşar (§4).

**`ServiceRequest.matchedAt` / `completedAt`**
- Bugün: request seviyesinde, tek değer.
- REL-002 etkisi: `matchedAt` projeksiyon olur (başarısızlıkta NULL). `completedAt` aynen kalır; review penceresinin saatidir.

**`ServiceRequest.approvedAt`**
- Bugün: "bir kez yazılır". Expiry ve reminder'ın **tek saati**.
- REL-002 etkisi: Tur 2'de yeniden başlaması gerekiyor, ama tarihsel değer bozulmamalı. Saat round'a taşınır (`round.publishedAt`), §18.

**`ServiceRequest.reminderSentAt`**
- Bugün: istek başına bir claim, hiç temizlenmez.
- REL-002 etkisi: Round'a taşınır.

**`ServiceRequest.directShowcaseProviderId`**
- Bugün: görünürlük kapısı. Accept sonrası da set kalır.
- REL-002 etkisi: Başarısızlıkta NULL'a çekilir; tur 2 marketplace turu olur (§20).

**`Offer.estimatedStartDate` / `estimatedCompletionDate`**
- Bugün: **ikisi de VAR** ama opsiyonel. Geçmiş tarih kontrolü yok. `new Date(string)` ile parse ediliyor (providers.service.ts:2977-3017). Web formunda `type="date"` kullanılıyor.
- REL-002 etkisi: Yeni alan **gerekmiyor**. Yeni tekliflerde zorunlu hale gelir ve ISO-day doğrulaması eklenir (§6).

**`Offer @@unique([providerId, requestId])`** (`Offer_providerId_requestId_key`)
- Bugün: sağlayıcı başına istek başına tek teklif.
- REL-002 etkisi: **BLOKER.** Tur 1'de reddedilen bir rakip, tur 2'de teklif veremez. `(providerId, matchRoundId)` ile değiştirilmeli.

**`Offer_one_accepted_per_request`** (partial unique, `WHERE status='ACCEPTED'`)
- Bugün: istek başına tek ACCEPTED.
- REL-002 etkisi: **BLOKER.** Başarısız turun kazanan teklifi ACCEPTED kalır (§3.3), bu yüzden tur 2'de accept imkânsız olur. Per-round index ile değiştirilmeli.

**Offer kredi alanları** (`creditRefunded*`, `creditRecharge*`, `refundBlocked*`)
- Bugün: Teklif başına iki kez charge, iki kez refund. Ledger partial unique'leri bunu destekliyor.
- REL-002 etkisi: Değişmez. Başarısız kazanana iade yollarının hepsi kapatılır (§10).

**`ContactRevealEvent`**
- Bugün: `requestId @unique` ve `offerId @unique`.
- REL-002 etkisi: **BLOKER.** Tur 2 accept, P2002 → 409 `CONTACT_REVEAL_ALREADY_EXISTS` alır. `roundId @unique` olmalı (§11).

**`MessageThread`**
- Bugün: `requestId @unique` ve `offerId @unique`. `resolveThreadForRequest` istek bazlı get-or-create yapıyor.
- REL-002 etkisi: **BLOKER.** Tur 2'de B için thread açılamaz. `roundId @unique` olmalı (§12).

**`ProviderReview`**
- Bugün: `offerId @unique` ve `@@unique([requestId, providerId])`. COMPLETED + `matchedOffer` gerektiriyor.
- REL-002 etkisi: Blok değil. A ve B farklı sağlayıcı olduğu için şema zaten izin veriyor (§12).

**`ShowcaseLead`**
- Bugün: request ile 1-1. ANSWERED lead MATCHED/COMPLETED'da değişmez.
- REL-002 etkisi: Değişmez. Tarihsel kayıt olarak kalır (§20).

**Expiry / reminder**
- Bugün: `approvedAt`'e göre 14 / 7 gün. Reminder dedupe'u `reminderSentAt` claim'i ile.
- REL-002 etkisi: Round saatine taşınır (§19).

**Publish fan-out** (`request-publish-outbox.service.ts:72-145`)
- Bugün: `request-available:<reqId>:<providerId>`. Bu anahtar **approvedAt içermiyor**.
- REL-002 etkisi: **BLOKER.** Tur 2 bildirimini bastırır. Round-aware anahtar gerekli (§18).

**Marketplace sorgusu** (providers.service.ts:1280)
- Bugün: `offers: { none: { providerId } }`.
- REL-002 etkisi: **BLOKER.** Tur 1 rakipleri tur 2'yi göremez. Current-round filtresi ve exclusion anti-join gerekli (§9).

**Teklif oluşturma** (`createOfferRecord`, :1415)
- Bugün: Status ve sağlayıcı kontrolü **tx dışında** (`ensureProviderCanSeeRequest`). Tx içinde `status` okunuyor ama yalnız direct-lead geçişi için kullanılıyor.
- REL-002 etkisi: **Mevcut TOCTOU açığı**: guard ile tx arasında MATCHED olmuş bir isteğe teklif yazılabilir. REL-002 exclusion'ı tx içinde zorlamak zorunda; bu açık da aynı fazda kapanır (§9.2).

**Cancel** (`cancelServiceRequest`, SR:1444)
- Bugün: Talebin **tüm** tekliflerini dolaşıyor. REJECTED rakipleri de iade ediyor.
- REL-002 etkisi: Current round'a daraltılmazsa tur 2 iptali tur 1'in COMPETITOR_ACCEPTED kredilerini geriye dönük iade eder. Tur 1 kazananı ACCEPTED-loser kuralıyla korunuyor ama bu örtük (§10).

**Reject (moderasyon)** (SR:1207)
- Bugün: SUBMITTED/VIEWED/SHORTLISTED teklifleri iptal ve iade ediyor.
- REL-002 etkisi: Current round'a daraltılır.

**Complete** (SR:1375)
- Bugün: `updateMany {MATCHED}` → COMPLETED, review-invitation `review-invitation:<reqId>`.
- REL-002 etkisi: Round COMPLETED ile aynı tx'te yazılır. Dedupe güvenli (complete istek başına bir kez).

**Contact erişimi** (contact-sharing.service.ts:194-224)
- Bugün: `MATCHED && matchedOfferId && reveal.offerId === matchedOfferId`.
- REL-002 etkisi: matchedOfferId NULL'a çekilince A'nın erişimi **otomatik kapanır**. Lookup round'a geçer.

**Mesaj erişimi** (`assertChainStillHolds`, messaging.service.ts:521)
- Bugün: `MATCHED && matchedOfferId === thread.offerId`.
- REL-002 etkisi: Aynı şekilde A için otomatik kapanır. Inbox listesi chain'i kontrol etmiyor; UI'da "kapandı" etiketi gerekir.

**Provider panel kabul kapsamı** (`loadAcceptedWorkScope`, :1775)
- Bugün: offer ACCEPTED ise görünür; request status'una bakmıyor.
- REL-002 etkisi: Başarısız tur kazananı açıklamayı ve cevapları görmeye devam eder. Round-aware gizleme gerekli (§12).

**Sağlayıcı risk alanı**
- Bugün: **Yok.** En yakın desen `PromotionEligibilityHold/Review`.
- REL-002 etkisi: Yeni model (§14, §15).

**Request status history**
- Bugün: yok, ama `ServiceRequestCancellation` var.
- REL-002 etkisi: Round tablosu talep yaşam döngüsünün tarihsel kaydı olur.

### 1.2 Özet: kesin blokerler

1. `Offer_providerId_requestId_key`
2. `Offer_one_accepted_per_request`
3. `ContactRevealEvent_requestId_key`
4. `MessageThread_requestId_key`
5. `request-available` dedupe anahtarı
6. Marketplace'in `offers: none` filtresi
7. Request-level expiry/reminder saati
8. Teklif oluşturmada tx-içi status/round/exclusion kontrolünün olmaması

Bunların hepsi **Faz 2 tamamlanmadan** issue-report (Faz 3) açılamaz.

---

## 2. Önerilen Prisma modelleri

### 2.1 Yeni enum'lar

```prisma
// M1'de (Faz 1) yalnız tek-turlu yaşam döngüsünün ulaşabildiği değerler var.
// FAILED (M3, Faz 3), SERVICE_ISSUE (M3) ve ADMIN (M5, Faz 5) ilk kullanıldıkları
// migration'da `ALTER TYPE ... ADD VALUE` ile eklenir.
enum MatchRoundStatus {
  OPEN       // teklif dönemi (moderasyon öncesi de dahil — bkz. 2.2 notu)
  MATCHED    // bir teklif kabul edildi, iş sürüyor
  FAILED     // müşteri hizmet aksaklığı bildirdi — terminal            [M3]
  COMPLETED  // müşteri tamamlandı dedi — terminal
  CANCELLED  // talep iptal edildi — terminal
  EXPIRED    // teklif dönemi kabul olmadan doldu — terminal
}

enum MatchRoundSource {
  MARKETPLACE
  DIRECT_SHOWCASE
}

enum MatchRoundOpenedBy {
  REQUEST_CREATED      // Round 1
  SERVICE_ISSUE        // otomatik yeniden açılış (yalnız R2, R3)       [M3]
  ADMIN                // MATCH_REVIEW sonrası personel kararı (R4+, §21) [M5]
}

enum ServiceIssueReason {
  PROVIDER_NO_SHOW
  WORK_NOT_STARTED
  WORK_NOT_COMPLETED
  PROVIDER_STOPPED_WORK
  PROVIDER_CANCELLED_BEFORE_START  // sağlayıcı işi yapmayacağını açıkça bildirdi; tarih beklemez, not zorunlu (§6.3)
  OTHER
}

// CONFIRMED / DISMISSED, ilk admin kararıdır ve **immutable**dır. Sonraki
// düzeltmeler incident'ı mutate etmez; ProviderIncidentAdjudication'a
// append-only yazılır (§14.1).
enum ProviderIncidentStatus {
  REPORTED
  PROVIDER_RESPONDED
  CONFIRMED
  DISMISSED
}

enum ProviderIncidentOutcome {
  CONFIRMED
  DISMISSED
}

enum ProviderReliabilityDecision {
  KEEP_ACTIVE          // incelendi, aksiyon yok
  SUSPENDED            // mevcut PROVIDERS_MODERATE akışıyla askıya alındı (referans)
}

// ServiceRequestStatus'a eklenecek değer:
//   MATCH_REVIEW — 3. tur da başarısız; otomatik tur yok, personel kararı bekliyor (§21)
```

Neden `IN_REVIEW` reuse edilmiyor? `IN_REVIEW` moderasyon kuyruğu anlamına geliyor (`reviewSourceStatuses`). Bir moderatör bunu "içerik onayı" sanıp APPROVE ederse, round açılmadan istek yeniden yayınlanır. Ayrı değer, ayrı kuyruk ve ayrı izin gerektirir.

### 2.2 `ServiceRequestMatchRound`

Faz 1'de (M1, `20261011120000_add_service_request_match_rounds`) uygulanan model — `prisma/schema.prisma`'daki hâliyle:

```prisma
model ServiceRequestMatchRound {
  id                String             @id @default(cuid())   // Round 1: 'mr1_' || requestId (deterministik)
  requestId         String
  roundNumber       Int                                       // CHECK >= 1
  status            MatchRoundStatus   @default(OPEN)
  source            MatchRoundSource
  openedBy          MatchRoundOpenedBy
  openedAt          DateTime                                  // Round 1: request.submittedAt
  /// Teklif döneminin başladığı an — Faz 2'den itibaren expiry/reminder saati.
  /// Round 1: request moderasyondan çıktıysa request.approvedAt; moderasyondayken
  /// NULL; tarihi kaydedilmemiş legacy onayda NULL (uydurulmaz).
  publishedAt       DateTime?
  expiresAt         DateTime?                                 // publishedAt + REQUEST_EXPIRY_DAYS, snapshot
  reminderSentAt    DateTime?
  matchedAt         DateTime?
  matchedOfferId    String?            @unique
  matchedProviderId String?
  failedAt          DateTime?                                 // Faz 1'de hep NULL; FAILED ile M3'te yazılır
  completedAt       DateTime?
  cancelledAt       DateTime?
  expiredAt         DateTime?
  createdAt         DateTime           @default(now())
  updatedAt         DateTime           @updatedAt

  request           ServiceRequest      @relation("ServiceRequestMatchRounds", fields: [requestId], references: [id], onDelete: Restrict)
  currentForRequest ServiceRequest?     @relation("ServiceRequestCurrentRound")
  matchedOffer      Offer?              @relation("MatchRoundMatchedOffer", fields: [matchedOfferId], references: [id], onDelete: Restrict)
  matchedProvider   ProviderProfile?    @relation("MatchRoundMatchedProvider", fields: [matchedProviderId], references: [id], onDelete: Restrict)
  offers            Offer[]             @relation("OfferMatchRound")
  contactReveal     ContactRevealEvent?
  messageThread     MessageThread?

  @@unique([requestId, roundNumber])
  @@index([matchedProviderId])
}
```

Sonraki migration'larda eklenecekler (Faz 1'de bilerek yok):
- **M2:** `@@unique([id, requestId])` (Offer composite FK hedefi), composite FK `(matchedOfferId, id) → Offer(id, matchRoundId)`, scheduler index'leri `@@index([status, publishedAt])` ve `@@index([status, reminderSentAt, publishedAt])` (okuyucular round'a geçtiği an).
- **M3:** `failureIncidentId String? @unique` + `failureIncident` ilişkisi, `incidents` ilişkisi, `FAILED` değeri ve FAILED shape CHECK'i.

Notlar:
- **Round 1, isteğin kendisiyle birlikte doğar** (`openedAt = submittedAt`). Moderasyon öncesi aşamalar (DRAFT/SUBMITTED/IN_REVIEW) request.status'ta yaşar. Round OPEN kalır ama `publishedAt` NULL'dır. Yayından sonra IN_REVIEW'a geri alınan talepte `publishedAt` yeniden NULL olur (talep piyasada değil); yeniden onayda `approvedAt` ile dolar.
- Request REJECTED olduğunda round OPEN kalır, çünkü `reopenAfterRemoval` aynı turu yeniden yayına alabilir. Görünürlüğün otoritesi her zaman **request.status**'tur. Round, eşleşme döngüsünün kaydıdır.

M1'de uygulanan raw SQL invariant'ları (Prisma ifade edemez):

```sql
-- Talep başına en fazla bir aktif tur (bugün her talepte tek tur olduğu için yapı gereği sağlanır)
CREATE UNIQUE INDEX "MatchRound_one_active_per_request"
  ON "ServiceRequestMatchRound"("requestId") WHERE "status" IN ('OPEN','MATCHED');

ALTER TABLE "ServiceRequestMatchRound" ADD CONSTRAINT "MatchRound_number_positive"
  CHECK ("roundNumber" >= 1);
ALTER TABLE "ServiceRequestMatchRound" ADD CONSTRAINT "MatchRound_matched_has_offer"
  CHECK ("status" NOT IN ('MATCHED','COMPLETED')
         OR ("matchedOfferId" IS NOT NULL AND "matchedProviderId" IS NOT NULL));

-- Terminal immutability: BEFORE UPDATE OF status trigger "MatchRound_terminal_status_immutable"
-- (fn "match_round_terminal_guard_fn"): OLD.status IN ('COMPLETED','CANCELLED','EXPIRED')
-- AND NEW.status <> OLD.status → RAISE EXCEPTION (check_violation). Diğer kolonlar yazılabilir.
```

Bu trigger Faz 1'de güvenlidir: uygulamada hiçbir yol talebi COMPLETED/CANCELLED/EXPIRED'dan çıkarmaz, round da talebin aynasıdır. M3, listeye `FAILED`'ı ekler.

Bilerek **ertelenen** CHECK'ler (Faz 1'de aşırı zorlamamak için):
- `MatchRound_open_has_no_match` (`status <> 'OPEN' OR matchedOfferId IS NULL`): projeksiyon bunu zaten sağlıyor ve tutarlılık kontrolü doğruluyor; DB CHECK'i M2'de, okuyucular round'a geçtiğinde eklenir.
- `MatchRound_failed_shape`, `MatchRound_completed_shape`: M3 / M2.

Ek invariant'lar (M2 ve sonrası):
- **Matched offer ↔ round uyumu**: composite FK `(matchedOfferId, id) → Offer(id, matchRoundId)` (M2). Bunun için Offer'da `@@unique([id, matchRoundId])` gerekir.
- **"Round başına en fazla bir kabul edilmiş teklif"**: `matchedOfferId @unique` (M1) ve `Offer_one_accepted_per_round` (M2, §5.1).

### 2.3 `ServiceRequestProviderExclusion` (§9)

```prisma
model ServiceRequestProviderExclusion {
  id            String   @id @default(cuid())
  requestId     String
  providerId    String
  sourceRoundId String
  incidentId    String   @unique
  reason        ServiceIssueReason
  createdAt     DateTime @default(now())

  request     ServiceRequest           @relation(fields: [requestId], references: [id], onDelete: Restrict)
  provider    ProviderProfile          @relation(fields: [providerId], references: [id], onDelete: Restrict)
  sourceRound ServiceRequestMatchRound @relation(fields: [sourceRoundId], references: [id], onDelete: Restrict)
  incident    ProviderServiceIncident  @relation(fields: [incidentId], references: [id], onDelete: Restrict)

  @@unique([requestId, providerId])
  @@unique([providerId, requestId])     // marketplace anti-join'i sağlayıcıdan başlar
}
```

### 2.4 `ProviderServiceIncident` (§14)

```prisma
model ProviderServiceIncident {
  id                  String                 @id @default(cuid())
  incidentNumber      String?                @unique   // NumberedEntityType'a eklenir (destek/admin arama)
  providerId          String
  requestId           String
  roundId             String                 @unique   // tur başına tek incident
  offerId             String                 @unique
  customerUserId      String
  reason              ServiceIssueReason
  customerNote        String?                // OTHER için zorunlu (CHECK)
  /// Müşterinin bu bildirimi tekrar gönderirken taşıdığı anahtar (§22).
  idempotencyKey      String                 @unique
  reportedAt          DateTime               @default(now())
  /// Kabul edilen tekliften snapshot — teklif sonradan değişmese de denetim
  /// satırı kendi başına okunabilir olsun.
  promisedStartDate   DateTime?
  promisedEndDate     DateTime?
  /// Eligibility'nin hangi kurala göre açıldığı: OFFER_DATES (taahhüt edilen
  /// start/end) | PROVIDER_CANCELLATION (PROVIDER_CANCELLED_BEFORE_START, tarih
  /// beklemez). Legacy fallback YOK (§6.4).
  eligibilityBasis    String
  status              ProviderIncidentStatus @default(REPORTED)
  providerResponse    String?
  providerRespondedAt DateTime?
  providerRespondedBy String?
  /// İlk admin kararı — yazıldıktan sonra immutable (trigger). Düzeltme
  /// ProviderIncidentAdjudication'a append-only yazılır (§14.1).
  reviewedById        String?
  reviewedAt          DateTime?
  reviewNote          String?
  createdAt           DateTime               @default(now())
  updatedAt           DateTime               @updatedAt

  provider  ProviderProfile          @relation(fields: [providerId], references: [id], onDelete: Restrict)
  request   ServiceRequest           @relation(fields: [requestId], references: [id], onDelete: Restrict)
  round     ServiceRequestMatchRound @relation("IncidentRound", fields: [roundId], references: [id], onDelete: Restrict)
  offer     Offer                    @relation(fields: [offerId], references: [id], onDelete: Restrict)
  customer  User                     @relation("IncidentCustomer", fields: [customerUserId], references: [id], onDelete: Restrict)
  reviewedBy User?                   @relation("IncidentReviewedBy", fields: [reviewedById], references: [id], onDelete: Restrict)
  failedRound ServiceRequestMatchRound? @relation("MatchRoundFailureIncident")
  exclusion   ServiceRequestProviderExclusion?

  @@index([providerId, status])                 // açık incident'lar
  @@index([providerId, reportedAt])             // 90 gün confirmed sayımı (status filtresiyle partial — aşağıda)
  @@index([status, reportedAt])                 // admin kuyruğu
  @@index([customerUserId, reportedAt])         // müşteri abuse sinyali (§22)
}
```

CHECK'ler:
- `reason NOT IN ('OTHER','PROVIDER_CANCELLED_BEFORE_START') OR length(btrim("customerNote")) >= N`
- `("providerResponse" IS NULL) = ("providerRespondedAt" IS NULL)`
- `(status IN ('CONFIRMED','DISMISSED')) = ("reviewedAt" IS NOT NULL AND "reviewedById" IS NOT NULL)`
- `status <> 'PROVIDER_RESPONDED' OR "providerResponse" IS NOT NULL`

Partial index:

```sql
CREATE INDEX "Incident_confirmed_by_provider_idx"
  ON "ProviderServiceIncident"("providerId","reportedAt") WHERE status='CONFIRMED';
```

### 2.4.1 `ProviderIncidentAdjudication` (§14.1, karar 5)

```prisma
model ProviderIncidentAdjudication {
  id               String                  @id @default(cuid())
  incidentId       String
  /// İlk karar da bir satırdır (sequence 1, kind DECISION); her düzeltme
  /// bir sonraki sequence'tir (kind CORRECTION). Satırlar hiç güncellenmez/silinmez.
  sequence         Int
  kind             String                  // DECISION | CORRECTION
  outcome          ProviderIncidentOutcome
  /// CORRECTION'ın geçersiz kıldığı önceki satır (zincir okunabilir kalsın).
  supersedesId     String?                 @unique
  note             String                  // zorunlu (>= 10), audit
  decidedById      String
  idempotencyKey   String                  @unique
  createdAt        DateTime                @default(now())

  incident   ProviderServiceIncident       @relation(fields: [incidentId], references: [id], onDelete: Restrict)
  supersedes ProviderIncidentAdjudication? @relation("AdjudicationSupersedes", fields: [supersedesId], references: [id], onDelete: Restrict)
  supersededBy ProviderIncidentAdjudication? @relation("AdjudicationSupersedes")
  decidedBy  User                          @relation(fields: [decidedById], references: [id], onDelete: Restrict)

  @@unique([incidentId, sequence])
  @@index([incidentId, createdAt])
}
```

- Append-only trigger: UPDATE/DELETE → `RAISE EXCEPTION` (SchedulerRun guard deseni).
- `kind = CORRECTION` yalnız SUPER_ADMIN tarafından yazılır (servis kontrolü + audit). İlk karar (DECISION) `PROVIDER_INCIDENTS_DECIDE` ile.
- **Effective outcome** = incident'ın en yüksek `sequence`'li satırı (süperseded edilmemiş son geçerli karar). Strike sayımı bunu okur (§15).
- `ProviderServiceIncident.status/reviewedAt/reviewedById/reviewNote` ilk kararın kopyasıdır ve bir daha değişmez; düzeltme incident satırına **yazmaz**.

### 2.5 `ProviderReliabilityReview` (§15)

```prisma
model ProviderReliabilityReview {
  id                 String                      @id @default(cuid())
  providerId         String
  /// İncelemenin kapsadığı son CONFIRMED incident — kuyruk "bundan sonra yeni
  /// confirmed geldi mi" sorusuyla tekrar açılır.
  coveredIncidentId  String
  confirmedCount90d  Int
  decision           ProviderReliabilityDecision
  note               String
  reviewedById       String
  createdAt          DateTime                    @default(now())
  @@unique([providerId, coveredIncidentId])
  @@index([providerId, createdAt])
}
```

### 2.6 Mevcut modellere ek alanlar

M1'de (Faz 1) eklenen hâlleri:

```prisma
model ServiceRequest {
  currentRoundId String?                     @unique   // Faz 2 (M2) NOT NULL
  currentRound   ServiceRequestMatchRound?   @relation("ServiceRequestCurrentRound", fields: [currentRoundId], references: [id], onDelete: Restrict)
  matchRounds    ServiceRequestMatchRound[]  @relation("ServiceRequestMatchRounds")
  // + Faz 3: providerExclusions, serviceIncidents
}

model Offer {
  matchRoundId    String?                    // Faz 2 (M2) NOT NULL
  matchRound      ServiceRequestMatchRound?  @relation("OfferMatchRound", fields: [matchRoundId], references: [id], onDelete: Restrict)
  matchedForRound ServiceRequestMatchRound?  @relation("MatchRoundMatchedOffer")
  @@index([matchRoundId, status])
  // M2: @@unique([id, matchRoundId]), @@unique([providerId, matchRoundId]) (eski
  // Offer_providerId_requestId_key'in yerine) ve ilişkinin composite FK'ye
  // dönüşmesi: fields: [matchRoundId, requestId] → references: [id, requestId].
}

model ContactRevealEvent { roundId String? @unique }   // M2: NOT NULL; requestId unique → @@index
model MessageThread      { roundId String? @unique }   // M2: aynı
model ProviderProfile    { matchedRounds ServiceRequestMatchRound[] @relation("MatchRoundMatchedProvider") }
```

- `roundId @unique` (reveal/thread) M1'de eklendi: talep başına tek tur olduğu için mevcut `requestId` unique'iyle eşdeğerdir, hiçbir satır ihlal edemez. Mevcut unique'lerin **hiçbiri** M1'de kaldırılmadı.
- Dört yeni kolon `PrismaService`'in global `omit`'inde (`MATCH_ROUND_PROJECTION_OMIT`): `select`'siz okunan hiçbir model bu kolonları taşımaz, dolayısıyla Faz 1'de hiçbir API yanıtı round id'si sızdırmaz (test: `match-round-dual-write.spec.ts`, "keeps round ids out of every API response").

## 3. Round state machine ve offer ↔ round

### 3.1 Round geçişleri

```
              accept (yalnız current OPEN round'un teklifi)
   OPEN ─────────────────────────────────────────► MATCHED
    │  │                                             │  │  │
    │  │ expiry (publishedAt+14g, kabul yok)         │  │  └─ staff cancel ─► CANCELLED
    │  └────────────────────────► EXPIRED            │  │
    │                                                │  └─ complete ───────► COMPLETED
    └─ cancel (customer/staff) ─► CANCELLED          │
                                                     └─ service issue ─────► FAILED
                                                           │
                    roundNumber < 3 ───────────────────────┴─► Round N+1 (aynı tx; §20 yayın kapısı)
                    roundNumber ≥ 3 ───────────────────────────► request MATCH_REVIEW, otomatik tur YOK
                                                                 (admin, zorunlu not + audit ile R(N+1) açabilir, §21)
```

Terminal durumlar: FAILED, COMPLETED, CANCELLED, EXPIRED.

### 3.2 Request ↔ round eşlemesi (current round projeksiyonu)

| Olay | request.status | request.matchedOfferId/matchedAt | currentRound |
|---|---|---|---|
| Talep oluşturma | DRAFT/SUBMITTED | NULL | R1 OPEN (`publishedAt` NULL) |
| Onay/yayın | APPROVED | NULL | R1 OPEN, `publishedAt`=now |
| Accept | MATCHED | offer / now | R1 MATCHED |
| Complete | COMPLETED | korunur | R1 COMPLETED |
| Service issue (N<3), marketplace kökenli | **APPROVED** | **NULL / NULL** | R(N) FAILED → R(N+1) OPEN, `publishedAt`=now |
| Service issue (N<3), direct-showcase kökenli | §20 yayın kapısı: auto-publish açık → APPROVED (sınıflandırıcı geçerse); kapalı → SUBMITTED (moderasyon) | **NULL / NULL** | R(N) FAILED → R(N+1) OPEN; `publishedAt` yayın anında |
| Service issue (N≥3) | **MATCH_REVIEW** | NULL / NULL | R(N) FAILED, `currentRoundId` R(N)'de kalır |
| Admin yeni tur (MATCH_REVIEW'dan, §21) | APPROVED | NULL / NULL | R(N+1) OPEN, `openedBy` ADMIN |
| Staff cancel (MATCHED) | CANCELLED | korunur (bugünkü gibi) | R CANCELLED |
| Expiry | EXPIRED | NULL | R EXPIRED |

REL-002'nin **yeni** yazıcıları (service-issue reopen, admin yeni tur) `request.approvedAt`'i **yazmaz**; saat `round.publishedAt`'tır. Bugünkü re-approval ve `reopenAfterRemoval` `approvedAt`'i tazelemeye devam eder ve Round 1'in `publishedAt`/`expiresAt`'i bunu aynen izler (Faz 1 dual-write).

### 3.3 Başarısız turun kazanan teklifi

- `Offer.status` **ACCEPTED kalır.** Kabul gerçekten oldu ve kredi o kabul için harcandı.
- Cancel bugün kazananı `CANCELLED` yapıp `acceptedAt`'i tutuyor. Burada status değiştirmeyi önermiyorum. Yeni bir `OfferStatus` değeri, iade worker'ı, admin filtreleri ve provider panel gibi tüm `ACCEPTED` okuyucularında dallanma gerektirir.
- "Başarısız" olgusu `round.status = FAILED` üzerinden okunur. Teklif projeksiyonlarına türetilmiş `matchOutcome: ACTIVE | COMPLETED | FAILED | CANCELLED` alanı eklenir (round join'i, tek satır).
- Per-round ACCEPTED unique'i sayesinde tur 2 kendi ACCEPTED'ını alabilir.

### 3.4 Eski rakip teklifler

- Tur 1'deki `REJECTED/COMPETITOR_ACCEPTED` teklifleri **diriltilmez.** `matchRoundId = R1` olarak tarihsel kalır.
- Aynı sağlayıcı (başarısız olan değilse) tur 2'de **yeni bir Offer satırı** açabilir. Unique `(providerId, matchRoundId)` bunu mümkün kılar.
- Yeni satır yeni `offerNumber`, yeni kredi charge'ı ve yeni 48 saat refund snapshot'ı alır.
- Müşteri teklif listesi (`listRequestOffers`) **varsayılan olarak current round**'u döner. Geçmiş turlar ayrı bir `rounds[]` bölümünde, salt-okunur ve fiyat/mesaj özetiyle gösterilir. Eski teklif üzerinde aksiyon yapılamaz (§3.5).

### 3.5 Accept semantiği (round-aware)

`acceptRequestOffer` Serializable kalır. Adımlar:

1. `offer = findUnique(offerId)` ve `matchRoundId` okunur. `round = findUnique(currentRoundId)`.
2. `offer.matchRoundId !== request.currentRoundId` → **409 `OFFER_ROUND_CLOSED`** (stale tur teklifi).
3. Exclusion var mı (`requestId, offer.providerId`) → **409 `PROVIDER_EXCLUDED`**. Normalde mümkün değil: dışlanan sağlayıcı yeni turda teklif veremez. Bu kontrol defense-in-depth içindir.
4. `serviceRequest.updateMany where {id, status: APPROVED, matchedOfferId: null, currentRoundId: round.id}` → MATCHED.
5. `matchRound.updateMany where {id: round.id, status: OPEN}` → MATCHED, `matchedOfferId`, `matchedProviderId`, `matchedAt`. Count ≠ 1 → 409.
6. Teklif ACCEPTED, mevcut conditional update ile.
7. `chargeRefundedOfferOnAcceptInTransaction` değişmez. Recharge teklif bazlı olduğu için zaten round-aware'dir. "Accepted offer always paid" korunur.
8. Rakipleri kapatma: `where {matchRoundId: round.id, ...}`. Request değil **round** kapsamı.
9. ContactRevealEvent `{roundId, requestId, offerId, ...}`.

---

## 4. ServiceRequest current-round projeksiyonu — karar

**Karar:** `matchedOfferId` ve `matchedAt` **kaldırılmıyor.** Current-round projeksiyonu olarak tutuluyor. Başarısızlıkta NULL'a çekiliyor. Tarihsel doğruluk `ServiceRequestMatchRound.matchedOfferId/matchedAt`'te.

Gerekçe:
- Contact (`loadRevealed`), messaging (`assertChainStillHolds`, `loadMatchChain`), cancel (`assertCancellable`, `expectedMatchedOfferId`), review (`request.matchedOffer`), admin `MatchCard` ve web `matches` sayfası, hepsi "aktif eşleşme = `request.matchedOfferId`" okuyor. Projeksiyon NULL'a çekildiğinde **A'nın erişimi bu okuyucuların hiçbirine dokunmadan kapanıyor.** Bu, en düşük riskli geçiş.
- Overwrite riski yok. Tur 2'de B kabul edilince projeksiyon B'yi gösterir, A'nın eşleşmesi R1 satırında değişmeden durur.
- `@unique` korunur. Aynı teklif iki isteği gösteremez. NULL'lar çakışmaz.
- Senkron invariant'ı:
  - `request.matchedOfferId IS NOT NULL ⇔ currentRound.status IN (MATCHED, COMPLETED, CANCELLED-with-match)`.
  - Bu invariant'ı her yazıcı aynı tx'te korur.
  - Faz 1'de tek bir **tutarlılık sorgusu** (`scripts/ops/rel-002-round-consistency.sql`, salt-okunur, tek SELECT, ihlal başına bir satır) bunu doğrular. Integration testleri aynı dosyayı çalıştırır (`apps/api/test/match-round-consistency.ts`); ops ve suite iki farklı şeyi kontrol edemez.
  - DB trigger ile zorlamak cross-table olduğu için önerilmiyor.

İleride, bütün okuyucular round'a geçtikten sonra projeksiyon kaldırılabilir. Bu REL-002 kapsamı dışında; sürüm notunda borç olarak işaretlenir.

---

## 5. Migration ve backfill

### 5.1 Fazlar

**M1 — expand + backfill (Faz 1, tek migration, transactional) — UYGULANDI**

Migration: `prisma/migrations/20261011120000_add_service_request_match_rounds/migration.sql` (yerel 94 → 95).

1. Enum'lar (`MatchRoundStatus` OPEN/MATCHED/COMPLETED/CANCELLED/EXPIRED, `MatchRoundSource`, `MatchRoundOpenedBy` REQUEST_CREATED), `ServiceRequestMatchRound`, dört nullable kolon (`ServiceRequest.currentRoundId`, `Offer.matchRoundId`, `ContactRevealEvent.roundId`, `MessageThread.roundId`). Nullable + default'suz `ADD COLUMN` metadata-only'dir, tablo yeniden yazılmaz.
2. Backfill (deterministik ve idempotent):
   - Round id = `'mr1_' || request.id`. Uygulamanın create yolu da aynı id'yi üretir (`roundOneId`).
   - `INSERT ... SELECT ... ON CONFLICT ("id") DO NOTHING`.
3. `Offer.matchRoundId`, `ContactRevealEvent.roundId`, `MessageThread.roundId` = `'mr1_' || "requestId"`; `ServiceRequest.currentRoundId = 'mr1_' || id`. Hepsi `WHERE ... IS NULL` (yeniden çalıştırılabilir).
4. Index'ler backfill'den **sonra** (satır satır bakım yok), sonra FK'ler, sonra CHECK'ler ve terminal trigger (§2.2).
5. Doğrulama bloğu (`DO $$ ... RAISE EXCEPTION`); bir invariant kırılırsa migration — tek transaction olduğu için tamamen — geri alınır.

Status eşlemesi (tarih uydurmadan):

| request.status | round.status | openedAt | publishedAt | matchedAt / matchedOfferId / matchedProviderId | completedAt / cancelledAt / expiredAt |
|---|---|---|---|---|---|
| DRAFT, SUBMITTED, IN_REVIEW | OPEN | `submittedAt` | NULL (yayından sonra IN_REVIEW'a alınmış olsa da) | NULL | NULL |
| APPROVED | OPEN | `submittedAt` | `approvedAt` (NULL ise NULL — scheduler dokunmaz, bugünkü davranış) | NULL | — |
| REJECTED | OPEN (reopen mümkün; request.status kapıyı tutar) | `submittedAt` | `approvedAt` | NULL | — |
| MATCHED | MATCHED | `submittedAt` | `approvedAt` | request'ten; provider = matched offer'ın `providerId`'si | — |
| COMPLETED | COMPLETED | `submittedAt` | `approvedAt` | aynı | `completedAt` |
| CANCELLED | CANCELLED | `submittedAt` | `approvedAt` | matchedOfferId varsa taşınır | `cancelledAt` |
| EXPIRED | EXPIRED | `submittedAt` | `approvedAt` | NULL | `expiredAt` |

Diğer kurallar:
- `expiresAt = publishedAt + 14 gün` (`REQUEST_EXPIRY_DAYS`). NULL ise NULL. Türetilmiş snapshot, uydurma değil: bugünkü scheduler kuralının ta kendisi.
- `reminderSentAt` request'ten kopyalanır. `failedAt` NULL.
- `source = DIRECT_SHOWCASE` yalnız `showcaseLeadId IS NOT NULL AND directShowcaseProviderId IS NOT NULL` (kapı hâlâ kapalı). RELEASE edilmiş lead MARKETPLACE sayılır; uygulama RELEASE anında round'u da MARKETPLACE'e çeker.
- `openedBy = REQUEST_CREATED`, `roundNumber = 1`.
- Terminal damgalar (`completedAt/cancelledAt/expiredAt`) yalnız kendi status'unda taşınır.

Doğrulama bloğunun kontrolleri: round sayısı = request sayısı; her request'in tam bir round'u var ve `currentRoundId` kendi Round 1'i; her offer/reveal/thread kendi request'inin round'unda; reveal/thread round'u teklifinin round'uyla aynı; MATCHED/COMPLETED round'da `status`, `matchedOfferId`, `matchedAt` request ile aynı; `matchedProviderId = offer.providerId`; MATCHED/COMPLETED kazananı ACCEPTED. Migration testi (`apps/api/test/match-round-migration.spec.ts`) her şekli içeren bir pre-M1 fixture'ı gerçek `prisma migrate deploy` ile geçirir, round satırlarını alan alan karşılaştırır ve bozuk bir veride migration'ın tamamen geri alındığını kanıtlar.

**M2 — enforce (Faz 2, ayrı migration, kod tüm yazıcılarda round yazar hale geldikten sonra)**

0. **Önce yeniden backfill** (M1 ile aynı SQL, `WHERE ... IS NULL`): M1 ile yeni kodun canlıya çıkışı arasındaki pencerede eski kodun yazdığı satırlar (round'suz request, `matchRoundId`'siz offer) olabilir. Uygulama bunların round'unu ilk lifecycle yazımında kendisi oluşturur (`syncCurrentMatchRound`), ama offer/reveal/thread bağları için M2 bu adımı tekrarlar ve `rel-002-round-consistency.sql` boş dönmeden ilerlemez.
1. `Offer.matchRoundId`, `ContactRevealEvent.roundId`, `MessageThread.roundId`, `ServiceRequest.currentRoundId` → NOT NULL. Önce `CHECK (... IS NOT NULL) NOT VALID` + `VALIDATE CONSTRAINT`, sonra `SET NOT NULL`.
2. Unique swap'ları:
   - `DROP INDEX "Offer_providerId_requestId_key"` → `Offer_providerId_matchRoundId_key`.
   - `DROP INDEX "Offer_one_accepted_per_request"` → `CREATE UNIQUE INDEX "Offer_one_accepted_per_round" ON "Offer"("matchRoundId") WHERE status='ACCEPTED'`.
   - `ContactRevealEvent_requestId_key` → `@@index([requestId])` (`roundId @unique` M1'de zaten var).
   - `MessageThread_requestId_key` → `@@index([requestId])` (`roundId @unique` M1'de zaten var).
3. Composite FK'ler: `Offer(matchRoundId, requestId) → Round(id, requestId)` ve `Round(matchedOfferId, id) → Offer(id, matchRoundId)`.
4. Swap güvenliği: M2 anında her request'in tek bir round'u var. Yeni unique'ler eskilerden **daha gevşek değil, eşdeğer** başlıyor; hiçbir satır ihlal edemez.

**M3 — REL-002 tabloları (Faz 3):** `ServiceRequestProviderExclusion`, `ProviderServiceIncident`, `ProviderIncidentAdjudication`, `ServiceIssueReason` (PROVIDER_CANCELLED_BEFORE_START dahil), `MatchRoundStatus += FAILED`, `MatchRoundOpenedBy += SERVICE_ISSUE`, round'a `failureIncidentId` + FAILED shape CHECK'i, terminal trigger listesine FAILED, `ServiceRequestStatus += MATCH_REVIEW`, `NumberedEntityType += SERVICE_INCIDENT`, OperationsSettings flag'i.
- `ALTER TYPE ... ADD VALUE` aynı tx'te kullanılamaz. Değer bu migration'da eklenir, ilk kullanım kodda olur. Repo'daki önceki enum eklemeleriyle aynı desen.

**M4 — reliability (Faz 4):** `ProviderReliabilityReview` ve yeni `AdminPermission` değerleri.

**M5 — admin yeni tur (Faz 5):** `MatchRoundOpenedBy += ADMIN` (ilk kullanım Faz 5 kodunda).

### 5.2 Lock ve ölçek riski

- Yerel boyut 23 request / 14 offer. Staging ve prod ölçeği bu oturumda bilinmiyor (dokunulmadı).
- M1'deki `UPDATE "Offer"` tüm satırlara row lock alır. Kolon nullable olduğu için tablo yeniden yazılmaz (PG ≥11, default'suz ADD COLUMN metadata-only), ama UPDATE her satır için yeni tuple üretir.
- Kural: Faz 1 PR'ı bir **preflight sayım scripti** taşır (`scripts/ops/rel-002-preflight.sql`, salt-okunur, `BEGIN READ ONLY … ROLLBACK`). Offer > ~100k ise backfill migration dışına alınır ve batch'lenir (`WHERE "matchRoundId" IS NULL LIMIT 5000` döngüsü). Bugünkü ölçekte tek migration yeterli (yerel ölçüm §30.4).
- M2'deki `CREATE UNIQUE INDEX`, Prisma migration tx'i içinde `CONCURRENTLY` olamaz. Bugünkü ölçekte kısa bir `SHARE` lock kabul edilebilir. Büyürse elle `CONCURRENTLY` + `prisma migrate resolve` deseni kullanılır.
- Yerel prosedür (memory'deki desen): migrate öncesi `pg_dump` ile geri dönüş dump'ı alınır. `_prisma_migrations` sayısı 94 → 95 (M1) → 96 → 97 → 98 (→ 99, M5) olur.

### 5.3 Geri dönüş

- **M1:** Kod revert edilir. Tablo ve kolonlar nullable kalır, okuyucu yoktur; eski kod round yazmaz, yalnız yeni satırlar round'suz kalır (M2'nin 0. adımı bunları toplar). Down-migration gerekmez.
- **M2:** Index swap'ı geri alınabilir, ama yalnız hiçbir request'te >1 round yokken. Faz 3 flag'i açılmadan önce M2 geri alınabilir. Açıldıktan sonra geri dönüş yalnız ileri-düzeltme ile yapılır.

---

## 6. Tarih sözleşmesi ve eligibility matrisi

### 6.1 Teklif takvimi

Yeni teklifler (Faz 2):
- `estimatedStartDate` ve `estimatedCompletionDate` **zorunlu.**
- Format `YYYY-MM-DD` (`isIsoDay`). Saat parçası reddedilir.
- `isoDayToStoredDate` ile UTC midnight olarak saklanır. `preferredDate` ile aynı temsil. Bugünkü `new Date('YYYY-MM-DD')` de UTC midnight üretiyor, yani mevcut satırlar uyumlu.
- Kurallar (sunucu saati, Europe/Istanbul, `todayIsoDay()`):
  - `start >= today`. Bugün başlamak geçerli, dün değil.
  - `end >= start`. Aynı gün iş geçerli.
  - `end <= today + OFFER_SCHEDULE_MAX_DAYS`. Öneri 365. `packages/shared/limits.json`'a girer; memory'ye göre API `@taktic/shared`'i import edemez, `limits.json` yolu kullanılır.
- Kodlar: `OFFER_SCHEDULE_REQUIRED`, `OFFER_START_IN_PAST`, `OFFER_END_BEFORE_START`, `OFFER_SCHEDULE_TOO_FAR` (400).
- Web provider formu (`providers/[id]/requests/[requestId]/page.tsx:371-375`) `required` + `min` alır. Vitrin lead formu (`vitrin/talepler/[leadId]`) da aynı.
- Müşterinin `preferredDate` aralığı ile tutarlılık **zorlanmaz.** Teklif bir karşı-öneridir. UI'da "talep edilen aralığın dışında" uyarısı gösterilir.

### 6.2 Sınır tanımı

Tarihler takvim günüdür. Bir gün, Europe/Istanbul'da 00:00'dan 24:00'e kadar sürer. "X geçti" demek: `todayIsoDay(now) > X`, yani X gününün **ertesi günü 00:00 İstanbul** itibarıyla. Taahhüt edilen gün tamamen bitmeden "gelmedi" denemez. Sağlayıcı o günün akşamına kadar gelebilir. "Keyfi bekletme" de yok: eşik, sağlayıcının kendi verdiği tarih.

```
startPassed = compareIsoDays(todayIsoDay(now), toIsoDay(promisedStart)) > 0
endPassed   = compareIsoDays(todayIsoDay(now), toIsoDay(promisedEnd))   > 0
```

`now` her zaman sunucu saatidir. Body'de tarih alanı yoktur.

### 6.3 Matris

| Durum | NO_SHOW | WORK_NOT_STARTED | WORK_NOT_COMPLETED | PROVIDER_STOPPED_WORK | OTHER | PROVIDER_CANCELLED_BEFORE_START |
|---|---|---|---|---|---|---|
| `today <= start` | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| `start < today <= end` | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ |
| `today > end` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

- `start = end` (tek günlük iş): ertesi gün tüm sebepler açılır.
- **OTHER** start geçtikten sonra açılır (değişmedi).
- **PROVIDER_CANCELLED_BEFORE_START** (karar 8): sağlayıcı işi yapmayacağını **açıkça** bildirdiyse müşteri start tarihini beklemeden kullanabilir. Eşleşme MATCHED olduğu sürece her an açıktır; **not zorunludur** (≥ 20 karakter, sağlayıcının ne dediği). Incident'a `eligibilityBasis = PROVIDER_CANCELLATION` yazılır. Ceza yine yalnız admin CONFIRMED'da işler; sağlayıcı yanıtı (§16) beyana itiraz yoludur. Diğer sebeplerin tarih kuralları **değişmez**.
- **PROVIDER_STOPPED_WORK**: Sistem işin başladığını bilemez. Müşterinin beyanı kabul edilir, doğrulanmaz. Ürün kararı B gereği yalnız end sonrasında açılır. Sağlayıcı yanıtı (§16) ve admin kararı itirazı karşılar. Ceza yalnız CONFIRMED'da işler (M), dolayısıyla doğrulanmamış beyanın maliyeti sağlayıcı için tek bir talebi kaybetmektir.
- **Sebep tutarlılığı:** Sunucu, sebebin gönderildiği an için matriste ✅ olduğunu kontrol eder. Uyumsuzsa 409 `SERVICE_ISSUE_REASON_NOT_YET_AVAILABLE` döner ve gövdede `opensOn: 'YYYY-MM-DD'` bulunur.

### 6.4 Tarihi olmayan legacy eşleşmeler (karar 1)

Yerelde 7/14 teklif tarihsiz. Tarihsiz kabul edilmiş bir teklif MATCHED durumdaysa (yerelde 2 MATCHED var):

- `acceptedAt` veya `request.preferredDate` üzerinden **otomatik eligibility TÜRETİLMEZ.** Fallback yoktur.
- Kabul edilen teklifin authoritative start **ve** end tarihi yoksa otomatik service-issue **açılmaz**: endpoint 409 `SERVICE_ISSUE_REQUIRES_SUPPORT` döner, `serviceIssue.supportOnly = true` olur ve UI müşteriyi destek/admin yoluna yönlendirir (destek talebi formu, talep numarası önceden dolu).
- Bu kural PROVIDER_CANCELLED_BEFORE_START için de geçerlidir: tarihsiz legacy eşleşmede de destek yolu kullanılır (tek, basit kural: tarihsiz = destek).
- Faz 2'den sonra yeni teklifler tarihsiz olamaz; bu küme zamanla boşalır. Faz 1 mevcut NULL tarihlere dokunmaz.

---

## 7. Müşteri issue API

```
POST /service-requests/:id/service-issue
Guards: AuthGuard + RolesGuard(CUSTOMER)      // SUPER_ADMIN değil: beyan müşterinin
Throttle: kullanıcı başına 5 / 10 dk
Body: { roundId: string, reason: ServiceIssueReason, note?: string (<= 1000), idempotencyKey: string (uuid) }
```

`roundId` müşterinin ekranda gördüğü turdur (stale guard).

Sunucu kontrolleri, sırayla. Hepsi tx içinde yeniden yapılır:

1. Flag `serviceIssueReportingEnabled` kapalıysa 404.
2. `request.customerId === user.id`, değilse 404. Varlık sızdırılmaz.
3. Guest talep (`customerId` NULL) → 404. Complete için de oturum gerekiyor.
4. `request.status === MATCHED`, değilse 409 `REQUEST_NOT_MATCHED`.
5. `request.currentRoundId === body.roundId`, değilse 409 `ROUND_CHANGED`. Ancak aynı `idempotencyKey` ile kayıt varsa replay olarak ele alınır (aşağıda).
6. `round.status === MATCHED` ve `round.matchedOfferId === request.matchedOfferId`, değilse 409 `MATCH_INCONSISTENT`.
7. Matched offer ACCEPTED ve `matchedProviderId` var.
8. Kabul edilen teklifte start/end yoksa → 409 `SERVICE_ISSUE_REQUIRES_SUPPORT` (§6.4). Varsa eligibility matrisi (§6.3) → 409 `SERVICE_ISSUE_REASON_NOT_YET_AVAILABLE`.
9. `reason ∈ {OTHER, PROVIDER_CANCELLED_BEFORE_START}` ise not zorunlu (≥ 20 karakter); eksikse 400 `SERVICE_ISSUE_NOTE_REQUIRED`. Not her durumda trim ve whitespace-collapse edilir, `contact-detection.ts` ile taranır. İletişim bilgisi içeriyorsa sağlayıcıya maskeli gösterilir (§14), müşteriye 400 dönülmez.
10. Max round kontrolü yalnız sonucu belirler (yeni tur mu, `MATCH_REVIEW` mi). Bildirimi engellemez.

**Exactly-once tercihi: idempotent replay + 409.**
- Aynı `idempotencyKey` ve aynı `(roundId, reason)` ile ikinci çağrı **200** alır ve mevcut sonucu döner (`incidentId`, `newRoundId`). Çift tık ve yanıtı kaybolmuş retry için.
- Aynı key, farklı payload → 409 `IDEMPOTENCY_KEY_REUSED`. `ManualCreditOperation` deseni.
- Farklı key ile aynı tur için ikinci bildirim → 409 `ROUND_ALREADY_FAILED`. DB backstop'u `ProviderServiceIncident.roundId @unique`.

Yanıt:

```json
{ "incidentId": "...", "failedRoundNumber": 1, "outcome": "REOPENED" | "ADMIN_REVIEW",
  "currentRound": { "id": "...", "roundNumber": 2, "status": "OPEN", "expiresAt": "..." } }
```

Okuma tarafı:
- `GET /service-requests/my/:id` yanıtına `currentRound`, `rounds[]` (numara, durum, tarihler, sağlayıcı adı ve incident sebebi; karşı tarafın yanıtı yok) ve `serviceIssue` eklenir.
- `serviceIssue` örneği: `{ availableReasons: [...], nextOpensOn: 'YYYY-MM-DD' | null, maxAutoRoundsReached: boolean, supportOnly: boolean }`. **Sunucu hesaplar**, istemci tarihe güvenmez. `supportOnly` tarihsiz legacy eşleşmede true'dur (§6.4).
- Müşteri sağlayıcının yanıtını **görmez** (karar 6): `rounds[]` ve `serviceIssue` yanıtta yalnız müşterinin kendi beyanını ve "kayıt alındı" durumunu taşır.

---

## 8. Issue transaction'ı

Tek bir `runSerializable` çağrısı, label `serviceRequests.reportServiceIssue`. Krediye **dokunmaz.**

```
 1. request  = SELECT ... FROM ServiceRequest WHERE id = :id
    round    = SELECT ... FROM ServiceRequestMatchRound WHERE id = request.currentRoundId
    offer    = SELECT ... FROM Offer WHERE id = round.matchedOfferId
    → §7 kontrolleri (tarih: sunucu now, Europe/Istanbul)
 2. idempotency: SELECT incident WHERE idempotencyKey = :key → varsa replay dön
 3. incident = INSERT ProviderServiceIncident (status REPORTED, promised* snapshot,
               eligibilityBasis, incidentNumber = numbering.generateDisplayNumber)
 4. UPDATE ServiceRequestMatchRound SET status='FAILED', failedAt=now, failureIncidentId=incident.id
    WHERE id=round.id AND status='MATCHED'                          → count≠1 ⇒ 409
 5. INSERT ServiceRequestProviderExclusion (requestId, providerId, sourceRoundId, incidentId, reason)
    ON CONFLICT (requestId, providerId) → 409 (olamaz: dışlanan sağlayıcı tekrar kazanamaz)
 6a. roundNumber < 3:
     newRound = INSERT ServiceRequestMatchRound (roundNumber+1, OPEN, source MARKETPLACE,
                openedBy SERVICE_ISSUE, publishedAt=now*, expiresAt=now+14g)
     UPDATE ServiceRequest SET status='APPROVED'*, matchedOfferId=NULL, matchedAt=NULL,
            directShowcaseProviderId=NULL, currentRoundId=newRound.id
     WHERE id=:id AND status='MATCHED' AND matchedOfferId=offer.id   → count≠1 ⇒ 409
     (* direct-showcase kökenli talep: canonical marketplace yayın kapısı, aynı tx (§20):
        auto-publish açık → publishRequestInTransaction sınıflandırıcısı, geçerse APPROVED +
        publishedAt=now; kapalı (ya da sınıflandırıcı tutarsa) → SUBMITTED, publishedAt NULL,
        normal moderasyon. Incident incelemesi yeniden açılışı BEKLETMEZ.)
 6b. roundNumber ≥ 3:
     UPDATE ServiceRequest SET status='MATCH_REVIEW', matchedOfferId=NULL, matchedAt=NULL,
            directShowcaseProviderId=NULL      (currentRoundId R3'te kalır)
     WHERE ... (aynı koşul)
 7. Outbox (aynı tx, NotificationLog PENDING; deliverSoon() commit sonrası):
    - customer: service-issue-recorded (+ request-reopened 6a'da)
    - failed provider: provider-incident-opened
    - admin: provider-incident-new (+ reliability eşik bildirimleri yalnız CONFIRMED'da, §14)
    - 6a: publishOutbox.enqueue(tx, requestId, now, round) → request-published + request-available (round-aware anahtarlar, §17)
 8. Mesajlaşma ve contact: ek yazım YOK. Projeksiyon NULL'a çekildiği için
    loadRevealed A'yı 404 ile reddeder ve thread salt-okunur tarihsel moda düşer
    (yazma/okundu-işareti 403, okuma orijinal katılımcılara açık — §12), 4. adım ile aynı commit.
    Sağlayıcı yanıtını beklemek bu tx'i ASLA geciktirmez (karar 9).
 9. Kredi: YOK. OFFER_REFUND / recharge reversal / promo restore yazılmaz.
```

Atomicity:
- Adımların hepsi aynı tx'tedir.
- Bir conditional update kaçarsa (4 veya 6) tüm tx geri alınır: incident, exclusion ve yeni tur yazılmamış olur.
- P2034 `runSerializable` tarafından retry edilir. Retry'da 2. adım replay'i yakalar.
- E-posta gönderimi tx dışında yapılır. Outbox kalıcı olduğu için gönderim hatası durumu geri almaz.

---

## 9. Provider exclusion

### 9.1 Açık model mi, türetme mi?

**Açık model** (`ServiceRequestProviderExclusion`). Gerekçeler:

- Round geçmişinden türetmek (`EXISTS round WHERE status=FAILED AND matchedProviderId=:p`) her marketplace sorgusunda round tablosuna join demek. Açık tablo, `(providerId, requestId)` unique index'iyle tek bir index probe'u.
- İleride admin kaynaklı dışlama (ör. dismiss sonrası bile müşterinin talebi) aynı tabloya `reason` ile eklenebilir. Bu fazda yalnız SERVICE_ISSUE kaynaklı satır yazılır.
- Admin incident'ı **dismiss etse bile satır silinmez** (F, §16). Dışlama talep bazında bir müşteri kararıdır, ceza değildir.

### 9.2 Zorlama noktaları (tamamı sunucu tarafı)

| Yüzey | Kural |
|---|---|
| `listMatchingRequests` | `providerExclusions: { none: { providerId } }` ve `offers: { none: { providerId, matchRound: { status: 'OPEN' } } }`. Talep başına tek OPEN round invariant'ı sayesinde "current round'da teklifim var mı" demek. |
| `getMatchingRequest` | Satır elde iken aynı iki koşul. İhlalde 404. |
| `ensureProviderCanSeeRequest` | Exclusion kontrolü, ihlalde 404. Rapor yolu da bu guard'ı kullandığı için otomatik kapsanır. |
| `createOfferRecord` (tx içinde) | **Yeni:** `request.status`, `currentRoundId`, `round.status = OPEN`, exclusion yok, provider APPROVED. Hepsi tx içinde **yeniden okunur.** Mevcut TOCTOU'yu da kapatır. Ön kontrol `findUnique providerId_requestId` → `providerId_matchRoundId`. |
| Publish fan-out (`findMatchingProviders`) | `excludedProviderIds` çıkarılır (tek sorgu, `WHERE requestId`). |
| Gönderim anında recompose (`transactional-mail` L1194-1230) | Audience kontrolü exclusion'ı da içerir. Kuyruktaki eski bir mail dışlanan sağlayıcıya gitmez. |
| Accept | §3.5 adım 3 (defense-in-depth). |
| Vitrin lead inbox (`listForProvider`) | Lead tarihsel görünür, ama talep detayı ve current round alanları dışlanan sağlayıcıya projekte edilmez (§20). |

**DB backstop:**
- `BEFORE INSERT ON "Offer"` trigger'ı: `EXISTS (SELECT 1 FROM "ServiceRequestProviderExclusion" WHERE "requestId"=NEW."requestId" AND "providerId"=NEW."providerId")` ise `RAISE EXCEPTION 'PROVIDER_EXCLUDED'`.
- İkinci trigger koşulu: `NEW."matchRoundId"` talebin OPEN round'u değilse reddedilir.
- Gerekçe: "yalnız UI filtresi olamaz" kuralı. Uygulama kodundaki her yeni teklif yazıcısı (ileride admin adına teklif vb.) otomatik kapsanır.
- Trigger hatası servis katmanında 409 `PROVIDER_EXCLUDED`'a çevrilir.

### 9.3 Yarış

Exclusion, R(N+1)'i açan tx'te yazılır. R(N+1)'e teklif ancak o tx commit edildikten sonra mümkün olur (round o tx'te doğuyor). Bu yüzden "exclusion yazılmadan yeni tura teklif" durumu oluşamaz. Trigger yine de backstop olarak durur.

---

## 10. Kredi invariant'ları

| Nesne | REL-002 davranışı |
|---|---|
| Başarısız turun kazanan teklifi | **İade yok, reversal yok, promo restore yok.** Teklif ACCEPTED kalır. Ledger'a hiçbir satır yazılmaz. |
| Tur 1'in COMPETITOR_ACCEPTED rakipleri | Bugünkü gibi iade edilmez. Tarihsel kalır. |
| Tur 2+ teklifleri | Normal kural: charge, 48 saat unviewed refund snapshot, recharge-on-accept. |
| Talep tur 2'de iptal edilirse (staff) | `cancelServiceRequest` **yalnız `currentRoundId`'nin tekliflerini** dolaşır. Winner = current round'un kazananı (varsa), bugünkü REFUND/WITHHOLD politikası uygulanır. Önceki turların teklifleri (başarısız kazanan ve eski REJECTED rakipler dahil) **sorgu kapsamına bile girmez.** |
| Talep `MATCH_REVIEW`'da iptal edilirse | Current round FAILED, winner yok → `NOT_MATCHED`. `closedOfferIds`/`refundedOfferIds` boş. |
| Admin incident'ı dismiss ederse | Otomatik iade yok. İstisnai telafi `ManualCreditOperation` (ADMIN_GRANT, idempotencyKey zorunlu) ile ayrı bir operasyondur. |
| Admin manuel teklif iadesi (`refundOfferCredit` / `OFFER_REFUND_*`) | Başarısız turun kazanan teklifi için **reddedilir**: 409 `FAILED_MATCH_NOT_REFUNDABLE`, mesaj "Manuel kredi işlemi kullanın". Gerekçe: teklif bazlı iade sistemin iade politikasıdır; telafi ayrı bir ledger nedeni taşımalı ki raporlar ikisini ayırabilsin. |
| Unviewed-refund worker | Değişiklik yok. Kazanan teklif `viewedAt` dolu ya da `refundBlockedAt` set durumda olduğundan zaten dışarıda. Ek güvence olarak worker sorgusuna `matchRound.status = OPEN` koşulu eklenir: kapanmış bir turun teklifi 48 saat kuralıyla iade edilmez. **Not:** bu bugünkü davranışı değiştirebilir. Tur 1 EXPIRED/CANCELLED olduğunda 48 saat dolmamış teklifler bugün iade alıyor mu, Faz 2'de doğrulanmalı; değiştirmeden önce mevcut test sözleşmesi okunmalı. Ben bu koşulu **yalnız FAILED round** için öneriyorum (en dar kapsam). |

Cancel ve reject'in current round'a daraltılması bugünkü tek-turlu davranışı değiştirmez (tek round var). Bu yüzden Faz 2'de güvenli.

Test gate'i: integration testi şunu doğrular. "Tur 1 FAILED, tur 2 MATCHED, staff cancel REFUND" senaryosunda ledger'a yalnız tur 2 kazananının iadesi yazılır. A'nın teklifi ve tur 1 rakipleri için **sıfır** OFFER_REFUND satırı oluşur.

---

## 11. Contact reveal

- Unique'ler: `ContactRevealEvent.roundId @unique` ve `offerId @unique`. `requestId` için unique değil, `@@index` kullanılır.
- Bu sayede A'nın R1 reveal'i kalır, B'nin R2 reveal'i ayrı satır olur. Aynı tura ikinci reveal ve aynı teklife ikinci reveal hâlâ imkânsızdır.
- Backfill: 4 satırın hepsine `roundId = 'mr1_' || requestId` (M1).
- `loadRevealed`: `findUnique({ requestId })` → `findUnique({ roundId: request.currentRoundId })`. Diğer koşullar (`MATCHED`, `reveal.offerId === matchedOfferId`) değişmez.
- A, başarısızlık commit edilince 404 alır (status APPROVED veya MATCH_REVIEW, matchedOfferId NULL). Admin `contact-reveal` görünümü round listesi döner: her turun audit event'i. `contacts` alanı yalnız current round MATCHED iken.
- Disclosure: Tur 2 accept'inde bugünkü kural aynen geçerli. Talepte aynı versiyonun kabulü varsa yeniden sorulmaz. Versiyon değiştiyse sorulur.

---

## 12. Mesajlaşma

- Thread round-aware olur: `MessageThread.roundId @unique` ve `offerId @unique`, `requestId` index.
- `resolveThreadForRequest(requestId)` → current round'un thread'ini get-or-create eder. `loadMatchChain` değişmez (MATCHED + matchedOfferId + ACCEPTED).
- **Salt-okunur tarihsel mod (karar 4, Faz 3):** round'u FAILED, COMPLETED veya CANCELLED olan bir thread, o thread'in **orijinal katılımcılarına** (thread'in `customerUserId` / `providerUserId`'si) salt-okunur gösterilir:
  - `GET threads/:id` ve `GET threads/:id/messages` açıktır; yanıt `mode: 'READ_ONLY'` ve kapanış sebebini (`closedReason: FAILED | COMPLETED | CANCELLED`) taşır.
  - **Yazma ve okundu-işaretleme mutasyonu yoktur:** `POST threads/:id/messages` ve `POST threads/:id/read` 403 `THREAD_READ_ONLY` döner. Okundu işareti tarihsel thread'de hiç değişmez.
  - Erişim kapısı `participantWhere` olarak kalır; zincir kontrolü (`assertChainStillHolds`) yalnız yazma ve read-mark yollarında çalışır. Yeni sağlayıcı (B) eski thread'i **göremez**: A'nın thread'inde katılımcı değildir, liste ve detay 404 döner.
  - Müşteriyi ve sağlayıcıyı "tıkla → 403" deneyimine mahkûm etmeyiz: liste her thread için `isActive`/`mode` taşır, UI kapalıları "Kapandı · salt okunur" etiketiyle açar ve yazma kutusunu göstermez.
  - Mesajlar silinmez. Bu mod bugünkü COMPLETED/CANCELLED thread'leri için de geçerli olur (bugün 403 alıyorlar) — Faz 3'te bilinçli bir UX iyileştirmesi olarak sürüm notuna girer.
- Inbox (`listThreads`, `unreadCount`):
  - Liste `isActive` alanı taşır (`thread.roundId === request.currentRoundId && round.status === MATCHED`).
  - `unreadCount` yalnız aktif thread'leri sayar, aksi halde A'da silinemez bir okunmamış rozeti kalır (tarihsel thread'de read-mark yok).
- İzolasyon:
  - B, A'nın thread'ini göremez: `participantWhere` `providerUserId` ile filtreliyor, A'nın thread'inde B yok.
  - Müşteri iki ayrı thread görür (A kapalı, B aktif).
  - Incident detayı ve sağlayıcı yanıtı mesaj tablosunda değil, incident tablosunda durur. B'nin hiçbir projeksiyonu incident tablosunu okumaz.
- Provider panelinde `acceptedWorkScope` (`loadAcceptedWorkScope`): `offer.status === ACCEPTED && round.status === MATCHED` olmalı. FAILED round'un kazananı açıklama ve cevapları görmez; yalnız teklif özetini ve "Eşleşme sonlandı" durumunu görür. COMPLETED'ta bugünkü davranış korunur (iş tamamlandı, kapsam görünür).

---

## 13. Değerlendirmeler (review)

- Şema değişikliği **gerekmiyor:**
  - `@@unique([requestId, providerId])`: A ve B farklı. A dışlandığı için A ikinci kez kazanamaz.
  - `offerId @unique`: B'nin teklifi farklı.
- `createForCustomer` zaten `status COMPLETED` ve `request.matchedOffer` (projeksiyon = B) okuyor. Başarısız turda yıldız değerlendirmesi açılamaz, çünkü o tur hiçbir zaman COMPLETED olmaz.
- Defense-in-depth: `matchedOffer.matchRoundId === request.currentRoundId && round.status === COMPLETED` koşulu eklenir.
- Review invitation dedupe'u `review-invitation:<reqId>`: complete istek başına bir kez olur (COMPLETED reopen yok, karar I). Değişmez.
- Başarısız turun "değerlendirmesi" incident sistemidir. Yıldız ortalamasına girmez, public profilde görünmez (§14).

---

## 14. Incident modeli ve durum makinesi

```
REPORTED ──provider yanıtı──► PROVIDER_RESPONDED
   │                              │
   ├──admin confirm──► CONFIRMED ◄┤
   └──admin dismiss──► DISMISSED ◄┘
```

- Sağlayıcı yanıtı yalnız `REPORTED` iken alınır, tek seferliktir. Conditional update: `WHERE status='REPORTED'`.
- Admin kararı `REPORTED` veya `PROVIDER_RESPONDED`'dan verilir: `WHERE status IN (...)`. Karar sonrası incident satırının status/karar alanları **immutable**dır (trigger backstop'u).
- Admin, sağlayıcı yanıtını **beklemek zorunda değildir**: 72 saat yalnız SLA/UX uyarısıdır, teknik kilit değildir; admin daha erken karar verebilir (karar 9, §16).
- Yanıt, incident'ı otomatik dismiss etmez.

### 14.1 Karar düzeltme (karar 5)

- CONFIRMED / DISMISSED ilk karar **immutable**dır; eski karar hiçbir zaman mutate edilmez.
- Düzeltme gerekiyorsa **yalnız SUPER_ADMIN**, `ProviderIncidentAdjudication`'a (§2.4.1) append-only bir `CORRECTION` satırı yazar: yeni `outcome`, zorunlu not (≥ 10), `idempotencyKey`, düzelttiği satıra `supersedesId`. İlk karar da aynı tabloda `sequence 1, kind DECISION` olarak durur.
- **Effective outcome** = en son geçerli adjudication (en yüksek `sequence`). Strike, risk seviyesi ve eşik bildirimleri effective outcome'u okur (§15).
- Düzeltme kendi domain audit kaydını yazar (ADMIN-ACTION-AUDIT-001 deseni) ve sağlayıcıya `provider-incident-decided` bildirimini düzeltilmiş sonuçla yeniden gönderir (anahtar `provider-incident-decided:<adjudicationId>`).
- Düzeltme exclusion'a, round'a, request projeksiyonuna, contact/thread'e **dokunmaz** (dismiss ile aynı ilke).
- Görünürlük:

| Alan | Müşteri | Başarısız sağlayıcı | Yeni sağlayıcı | Admin |
|---|---|---|---|---|
| reason | ✅ (kendi beyanı) | ✅ | ❌ | ✅ |
| customerNote | ✅ | maskeli (contact-detection), müşteri adı/telefonu yok | ❌ | ✅ |
| providerResponse | ❌ (karar 6: müşteri görmez, v0.2.0) | ✅ | ❌ | ✅ |
| status / karar | yalnız "kayıt alındı" | ✅ (karar + reviewNote değil, karar özeti) | ❌ | ✅ |
| reviewNote | ❌ | ❌ | ❌ | ✅ |

- Projeksiyon kuralı (memory'deki allowlist geri bildirimi): her yüzey açık `select` allowlist'i kullanır ve tam anahtar seti testi yazılır.

---

## 15. Strike ve reliability

- **Hesap:** sorgu ile, materialize edilmez. Sayılan şey **effective outcome**'dur (§14.1), ilk karar değil:

  ```sql
  SELECT count(*) FROM "ProviderServiceIncident" i
  JOIN LATERAL (
    SELECT a."outcome" FROM "ProviderIncidentAdjudication" a
    WHERE a."incidentId" = i.id ORDER BY a."sequence" DESC LIMIT 1
  ) eff ON true
  WHERE i."providerId"=$1 AND eff."outcome"='CONFIRMED' AND i."reportedAt" >= now() - interval '90 days'
  ```

  Index'ler: `Incident(providerId, reportedAt)` ve `Adjudication(incidentId, sequence)` unique'i (LIMIT 1 index probe'u). Düzeltme nadir olduğu için partial index (`WHERE status='CONFIRMED'`) ilk karara göre aday daraltmada kullanılmaz; Faz 4 EXPLAIN'i ile ölçülür.
- **Saat:** `reportedAt` (olay zamanı). Admin gecikmesi pencereyi kaydırmaz.
- **Gerekçe:** aggregate alan, confirm/dismiss/zaman akışı için üç ayrı yazıcı ve bir decay job'ı gerektirir. Sayım ucuz ve her zaman doğru. Ölçek büyürse `ProviderProfile`'a cache ve gece job'ı eklenebilir.
- **Risk seviyesi** (türetilir):

| Confirmed (90 gün) | Seviye |
|---|---|
| 0–1 | `NORMAL` |
| 2 | `WARNING` |
| ≥ 3 | `ADMIN_REVIEW_REQUIRED` |

- **Kuyruk:** `ADMIN_REVIEW_REQUIRED` olan ve en son CONFIRMED incident'ı için bir `ProviderReliabilityReview` satırı bulunmayan sağlayıcılar. Yeni bir confirm, kuyruğu tekrar açar.
- **Teklif eligibility:** bu fazda **otomatik blok yok** (ürün kararı M).
  - 3+ sağlayıcı teklif vermeye devam eder.
  - Admin panelde bloklayıcı uyarı gösterilir: sağlayıcı detayında kırmızı bant ve Genel görünümde kuyruk hücresi.
  - Admin kararı: KEEP_ACTIVE ya da mevcut `PROVIDERS_MODERATE` → SUSPENDED akışı. Mevcut akış `ProviderStatusChange` yazar ve SUSPENDED zaten discovery/offer'ı kapatıyor (`getApprovedProviderForDiscovery`).
  - `ProviderReliabilityReview` kararı ve status değişikliği aynı tx'te yazılır.
  - Gerekçe: otomatik blok, doğrulanmamış müşteri beyanlarından ve tek bir yanlış admin onayından ceza üretebilir. Ürün, admin-reviewed suspension'ı seçti.
- **Bildirimler:** eşik geçişleri (1→2, 2→3) **confirm tx'inde** tespit edilir ve admin outbox'ı yazılır (§18). Sağlayıcıya 2. eşikte resmi uyarı e-postası gider (template `provider-reliability-warning`). 3. eşikte sağlayıcıya otomatik mesaj gitmez; admin karar verir.
- Public profil ve arama sıralaması bu fazda etkilenmez.

---

## 16. Sağlayıcı yanıtı

- Bildirim: "Müşteri hizmet aksaklığı bildirdi".
  - İçerik: talep no, kategori, il/ilçe, sebep etiketi, (maskeli) not, yanıt bağlantısı.
  - Müşterinin iletişim bilgisi, adı ve adresi **yok.**
  - Yanıt penceresi metni: **72 saat** (karar 9). Bu bir SLA/UX uyarısıdır, **teknik kilit değildir**:
    - Admin 72 saat dolmadan karar verebilir; karar sonrası yanıt 409 `INCIDENT_ALREADY_DECIDED` alır.
    - Admin ekranı, pencere dolmamışken "Sağlayıcının yanıt süresi henüz dolmadı (… saat kaldı)" uyarısını gösterir; engellemez.
    - Sağlayıcı yanıtını beklemek müşterinin yeniden açılışını **asla** geciktirmez: yeni tur, issue tx'inde açılır (§8).
- Endpoint'ler:
  - `GET /providers/:providerId/incidents` (liste)
  - `GET /providers/:providerId/incidents/:id`
  - `POST /providers/:providerId/incidents/:id/response`, body `{ response (20..2000), clientToken }`
  - Guard'lar: `ProviderAccessGuard` ve `incident.providerId === providerId`.
- **Tek ve immutable** yanıt: append-only thread yok. Gerekçe: incident bir dava kaydıdır, sohbet değil. Tek yanıt admin değerlendirmesini sadeleştirir; sağlayıcıya "yanıtınız kayda geçti" garantisi verir. Ek bilgi gerekirse admin destek kanalını kullanır.
- Yanıt geldiğinde status `PROVIDER_RESPONDED` olur ve admin outbox'ına `provider-incident-responded` yazılır.
- SUSPENDED sağlayıcı da yanıt verebilir. `ProviderAccessGuard` status'a bakmıyor; bu doğru, ceza sürecinde savunma hakkı korunmalı.

---

## 17. Admin akışı

**Sağlayıcı detayı** (`/providers/[id]`): yeni "Güvenilirlik" sekmesi.
- Risk seviyesi rozeti, 90 günlük CONFIRMED sayısı, açık incident sayısı.
- Incident geçmişi tablosu (tarih, talep no, tur, sebep, durum).
- ReliabilityReview geçmişi.
- `ADMIN_REVIEW_REQUIRED` iken üstte bloklayıcı bant: "3 doğrulanmış aksaklık — inceleme gerekli". Butonlar: "İncelendi, aktif kalsın" ve "Askıya al" (mevcut status dialog'u).

**Talep detayı** (`/requests/[id]`):
- `MatchCard` yerine **tur zaman çizelgesi**: her tur için numara, kaynak, açılış/yayın, eşleşen sağlayıcı, sonuç, incident bağlantısı.
- Teklifler sekmesine tur filtresi eklenir (varsayılan: current).
- `MATCH_REVIEW` durumunda StatusCard aksiyonları: "Yeni tur aç" (`REQUESTS_REOPEN`, zorunlu not + audit, §21) ve "İptal et" (mevcut).

**Incident kuyruğu** (`/provider-incidents`):
- Filtreler: status (varsayılan REPORTED + PROVIDER_RESPONDED), sağlayıcı, tarih.
- Sayfalama mevcut `?q=` / sayfalı arama desenleriyle.
- Detayda: müşteri beyanı, taahhüt tarihleri ve eligibility dayanağı, sağlayıcı yanıtı, tur bağlamı, sağlayıcının 90 günlük sayısı.

**Aksiyonlar:**
- `POST /admin/provider-incidents/:id/confirm` ve `/dismiss`, body `{ note (zorunlu ≥ 10), idempotencyKey, expectedStatus }`. Sağlayıcı yanıt penceresi (72 saat) dolmamış olsa da kabul edilir (karar 9).
- `POST /admin/provider-incidents/:id/adjudications` — **yalnız SUPER_ADMIN**, body `{ outcome, note (≥ 10), idempotencyKey, supersedesAdjudicationId }`; append-only düzeltme (§14.1).
- ConfirmGate / ConfirmDialog deseni (ADMIN-DESTRUCTIVE-CONFIRMATION) ve domain audit (ADMIN-ACTION-AUDIT-001 deseni).
- **Confirm:** kredi yok. Strike, sayım sorgusuyla anında aktif olur. Eşik bildirimleri yazılır.
- **Dismiss:** strike yok. Dışlama **kalır**. Request ve Round 2 **olduğu gibi kalır.** Eski eşleşme geri kurulmaz. Matched projeksiyon, contact ve thread'e dokunulmaz. Sağlayıcıya "kaydınıza işlenmedi" bildirimi gider.

**İzinler** (yeni `AdminPermission`):
- `PROVIDER_INCIDENTS_READ`
- `PROVIDER_INCIDENTS_DECIDE`
- `PROVIDER_RELIABILITY_REVIEW`
- Yeni tur açmak için mevcut `REQUESTS_REOPEN` reuse edilir.
- `route-permission-map` ve rol tohumları güncellenir.

**Genel görünüm:** iki yeni kuyruk hücresi, `openProviderIncidents` ve `providerReliabilityReviews`. `DESTINATION_PERMISSIONS` ile kapılı.

---

## 18. Bildirimler ve dedupe

**Kural:**
- Tur 1 anahtarları **bugünkü formatı korur.** Yeniden gönderim ve çakışma olmaz.
- Tur ≥ 2 anahtarlarına `:r<N>` eki gelir.
- Retry parser'ı (`transactional-mail.service.ts:3204-3207`) ekli formatı tanır. Parser için birim testi yazılır.

| Template | Tur 1 anahtarı (değişmez) | Tur N ≥ 2 |
|---|---|---|
| request-published (müşteri) | `request-published:<req>:<publishedAtISO>` | aynı format. `round.publishedAt` farklı olduğu için doğal olarak ayrışır. |
| request-available (sağlayıcı) | `request-available:<req>:<provider>` | `request-available:<req>:<provider>:r<N>` |
| request-expired-customer | `request-expired-customer:<req>` | `...:<req>:r<N>` |
| request-expired-provider | `request-expired-provider:<req>:<provider>` | `...:r<N>` |
| request-expiring (reminder) | (dedupe yok, `reminderSentAt` claim) | claim `round.reminderSentAt`'e taşınır |
| offer-* / match-* / cancelled-offer | teklif id'si | değişmez (teklif tura özgü) |
| request-cancelled-customer | `request-cancelled-customer:<req>` | değişmez (iptal bir kez) |
| review-invitation | `review-invitation:<req>` | değişmez (complete bir kez) |

Yeni template'ler:

| Template | Alıcı | Anahtar |
|---|---|---|
| `service-issue-recorded` | müşteri | `service-issue-recorded:<incidentId>` |
| `request-reopened` | müşteri | `request-reopened:<newRoundId>` |
| `request-match-review` | müşteri (tur 3 başarısız) | `request-match-review:<incidentId>` |
| `provider-incident-opened` | başarısız sağlayıcı | `provider-incident-opened:<incidentId>` |
| `provider-incident-decided` | sağlayıcı | `provider-incident-decided:<incidentId>` |
| `provider-reliability-warning` | sağlayıcı (2. eşik) | `provider-reliability-warning:<providerId>:<incidentId>` |
| `provider-incident-new` | admin/destek (mevcut `request-report-new-for-support` alıcı deseni) | `provider-incident-new:<incidentId>` |
| `provider-incident-responded` | admin | `provider-incident-responded:<incidentId>` |
| `provider-reliability-review-required` | admin | `provider-reliability-review:<providerId>:<incidentId>` |

- Eşik anahtarları, eşiği tetikleyen incident'a bağlıdır. Aynı eşik yeniden geçilirse (90 günlük pencere kayıp yeniden dolarsa) yeni bildirim üretilir.
- **"New offer"** (müşteri): mevcut `offer-received:<offerId>`, tura özgü.
- E-posta HTML'i REQ-UX-007 shell'ini kullanır (tek dosya, dark mode).

---

## 19. Expiry ve reminder

- Saat `round.publishedAt`'tır. Snapshot `round.expiresAt`.
- **Expiry** taraması: `ServiceRequestMatchRound WHERE status='OPEN' AND publishedAt IS NOT NULL AND expiresAt <= now`, join `request.status = 'APPROVED'`.
  - Tek tx'te `round → EXPIRED` ve `request → EXPIRED`, iki conditional update.
  - Outbox anahtarları §18'e göre.
- **Reminder** taraması: `status='OPEN' AND reminderSentAt IS NULL AND publishedAt <= now-7g AND offers none (matchRoundId = round.id)`. Claim `round.reminderSentAt` üzerinden.
- **Tur 2:** `publishedAt=now`, `expiresAt=now+14g`, `reminderSentAt=NULL`. Pencere ve reminder sıfırdan başlar.
- **Tarihsel tur 1:** `publishedAt`, `reminderSentAt`, `expiresAt` olduğu gibi kalır. `request.approvedAt` ve `request.reminderSentAt` legacy alan olarak dokunulmaz.
- **Geçiş (Faz 2):**
  - Scheduler okuyucuları round'a geçirilir.
  - Backfill, tur 1'in `publishedAt=approvedAt` ve `reminderSentAt` değerlerini taşıdığı için çalışan talepler aynı anda expire veya remind edilir; davranış farkı yoktur.
  - `approvedAt` NULL legacy satırlar (yerelde 2) yine taranmaz.
- **Gotcha:** `reopenAfterRemoval` (SR:1330) bugün `approvedAt`'i tazeliyor. Round'da da `publishedAt`/`expiresAt` tazelenir ve `reminderSentAt` sıfırlanmaz. Bugünkü davranış: reminder bir kez; tutarlılık için korunur.

---

## 20. Vitrin direct lead

- Tur 1 kaynağı `DIRECT_SHOWCASE`. Kazanan, vitrin sahibidir (teklif `SHOWCASE_PLACEMENT`, `creditCost 0`).
- Başarısızlıkta:
  - Incident ve exclusion vitrin sağlayıcısına yazılır.
  - `directShowcaseProviderId = NULL`. Entitlement resolver artık `SHOWCASE_PLACEMENT` vermez, tur 2 teklifleri normal fiyattır.
  - Tur 2 `source = MARKETPLACE`.
  - `ShowcaseLead` **değişmez.** ANSWERED kalır; "bu yerleşim bir lead üretti" sayısı korunur. `closeForRequest` yalnız OPEN/BREACHED'ı kapattığı için çağrılmaz.
- **Kart/lead durumunda değişiklik gerekmiyor.** Opsiyonel: vitrin performans raporuna "lead → başarısız eşleşme" sayısı. Bu fazda yok.
- Vitrin sağlayıcısının lead inbox'ı (`listForProvider`, lead detayı): lead satırı görünür, ancak talep projeksiyonu tur 2'ye ait hiçbir şey göstermez. Talep durumu "Eşleşme sonlandı" olarak sabitlenir; tur 2 status'u, yeni teklif sayısı ve yeni sağlayıcı yok.
- **Yayın kapısı (karar 2):**
  - Direct lead talebi **hiç moderasyondan geçmedi**; vitrin sahibinin teklifiyle APPROVED oldu.
  - Bu yüzden direct-showcase kökenli Round 2, **canonical marketplace publish gate**'ten geçer — RELEASE'in bugün kullandığı kapının aynısı (`publishRequestInTransaction`):
    - Request `SUBMITTED`'a alınır, `directShowcaseProviderId = NULL`, Round 2 OPEN ve `publishedAt` NULL olarak açılır.
    - **Auto-publish açık:** aynı tx'te normal yayın sınıflandırıcısından geçer ve hemen yayınlanabilir (APPROVED, `publishedAt=now`, fan-out).
    - **Auto-publish kapalı:** normal moderasyon kuyruğuna (SUBMITTED) düşer; onaylandığında `publishedAt` onay anıdır.
  - Incident incelemesi yeniden açılışı **bekletmez** (karar D ile tutarlı): yeni tur issue tx'inde açılır, yalnız yayın kapısı uygulanır.
  - Marketplace kökenli tur 2 doğrudan APPROVED olur (zaten moderasyondan geçti).

---

## 21. Maksimum tur

- Otomatik yeniden açılış yalnız `roundNumber < 3` iken yapılır. Sabit `MAX_AUTO_MATCH_ROUNDS = 3` (`limits.json`). **Round 3 sonrası otomatik Round 4 YOK** (karar 3).
- Tur 3 (veya admin'in açtığı R4+) başarısız olursa:
  - Incident oluşur, round FAILED olur, exclusion yazılır.
  - `request.status = MATCH_REVIEW`, `matchedOfferId = NULL`, `currentRoundId` R3'te kalır.
- `MATCH_REVIEW`'da:
  - Marketplace'te görünmez (APPROVED değil).
  - Scheduler'lar dokunmaz.
  - Müşteri iptal edebilir (eşleşme yok, `assertCancellable` CUSTOMER'a izin verir; `terminalStatuses`'a girmez).
  - Müşteri ekranı: "Talebiniz ekibimiz tarafından inceleniyor. Size dönüş yapacağız."
- Admin kuyruğu: Genel görünüme `matchReviewRequests` hücresi ve talep listesinde status filtresi.
- Admin aksiyonları:
  - **Yeni tur aç** (`POST /admin/service-requests/:id/rounds`, `REQUESTS_REOPEN`, body `{ note (zorunlu ≥ 10), idempotencyKey, expectedRoundId }`): R(N+1) OPEN (`openedBy ADMIN`), request APPROVED, fan-out. Exclusion'lar korunur. Domain audit kaydı yazılır (ADMIN-ACTION-AUDIT-001), ConfirmGate deseni.
  - **İptal et**: mevcut akış. Winner yok, kredi hareketi yok.
- İlk sürümde admin manuel turları için **sabit hard-cap yok** (karar 3): her açılış zorunlu notlu ve audit'li bir personel kararıdır. Her manuel tur yine başarısız olursa talep tekrar `MATCH_REVIEW`'a döner.
- `MATCH_REVIEW` için SLA/otomatik kapanış bu fazda yok (borç notu).

---

## 22. Eşzamanlılık ve idempotency

Ortak desen:
- `runSerializable`, 3 deneme, P2034 retry.
- Her durum geçişi `updateMany WHERE <beklenen durum>` ile yapılır, `count === 1` kontrol edilir.
- Unique ve partial unique backstop'lar.

| Yarış | Çözüm |
|---|---|
| issue vs complete | İkisi de `request WHERE status='MATCHED'` ve `round WHERE status='MATCHED'` koşullu. Biri 0 satır görür ve 409 alır (`REQUEST_NOT_MATCHED`). Serializable rw-çakışmasında P2034, sonra retry, sonra iş kuralı. |
| issue vs staff cancel | Cancel `WHERE status=current AND matchedOfferId=current` kullanır. Issue commit ettiyse matchedOfferId NULL olmuştur ve cancel 409 `REQUEST_CANCEL_STATE_CHANGED` alır. Cancel önce commit ettiyse issue 409 alır. Cancel endpoint'inin `expectedMatchedOfferId` guard'ı admin'in eski ekranını yakalar. |
| issue vs offer accept | Kümeler ayrık: accept `APPROVED`, issue `MATCHED` ister. Tur N+1'in accept'i ancak issue commit'inden sonra mümkün. Tur N'in stale accept'i `OFFER_ROUND_CLOSED` alır. |
| duplicate issue | `idempotencyKey @unique` replay → 200. Farklı key → `roundId @unique` → 409 `ROUND_ALREADY_FAILED`. |
| admin confirm/dismiss vs provider yanıtı | Yanıt `WHERE status='REPORTED'`. Karar `WHERE status IN ('REPORTED','PROVIDER_RESPONDED')`. Karar önce gelirse yanıt 409 `INCIDENT_ALREADY_DECIDED` alır. Yanıt önce gelirse karar PROVIDER_RESPONDED'dan geçerli olur. Admin ekranı `expectedStatus` gönderir: değiştiyse 409 `INCIDENT_STATE_CHANGED`, "Sağlayıcı yanıt verdi, yeniden okuyun". |
| tur 2 accept vs tur 1 stale aksiyon | Tur 1 teklifi `matchRoundId ≠ currentRoundId` → 409 `OFFER_ROUND_CLOSED`. Tur 1 sağlayıcısının stale teklif oluşturması: tx-içi round OPEN kontrolü ve trigger. Tur 1 sağlayıcısının stale withdraw'ı: withdraw `request APPROVED` istiyor, round kontrolü eklenir. Kapanmış turdaki teklif çekilemez (zaten REJECTED/ACCEPTED). |
| iki confirm aynı anda | Conditional update, biri 409. ReliabilityReview `@@unique([providerId, coveredIncidentId])`. |
| admin "yeni tur aç" çift tık | `round one_active` partial unique ve `request WHERE status='MATCH_REVIEW'`. |
| issue vs expiry | Expiry yalnız OPEN round tarar, issue yalnız MATCHED. Ayrık. |

---

## 23. Güvenlik ve suistimal

| Tehdit | Sunucu guard'ı |
|---|---|
| Sahte no-show | Ceza yalnız CONFIRMED'da. REPORTED hiçbir sağlayıcı yaptırımı üretmez. Kaybedilen tek şey o talep. Tarih eşiği sağlayıcının kendi tarihi. |
| Sürekli sağlayıcı yakma | Talep başına en fazla 3 otomatik tur. Müşteri bazlı sinyal (karar 7): DISMISSED (effective outcome) incident **sayısı ve oranı** admin müşteri detayında **risk sinyali** olarak gösterilir (sorgu, `customerUserId, reportedAt` index'i). **Otomatik issue-ban yok**; müşterinin bildirim hakkını kısıtlamak ayrı, gelecek bir ürün kararıdır. Rate limit kullanıcı başına 5 / 10 dk. |
| Stale link ile yeni tura teklif | Tx-içi round OPEN ve exclusion kontrolü, DB trigger. |
| Dışlanan sağlayıcının doğrudan API çağrısı | Discovery, detail, create-offer, report, accept: hepsi tek bir `isProviderExcluded` helper'ı (provider-request-matching.ts'ye eklenir, "tek tanım" ilkesi) ve trigger. |
| Eşikten önce çağrı | Matris sunucu saatiyle değerlendirilir. 409 ve `opensOn`. |
| Client date spoof | Body'de zaman alanı yok. `now` sunucunun. `todayIsoDay` İstanbul. |
| Duplicate submit | `idempotencyKey`, `roundId` unique. |
| Dismiss sonrası eski sağlayıcıyı geri getirme | Exclusion silme endpoint'i **yok.** Dismiss, match/round/projeksiyona yazmaz. Round terminal trigger'ı FAILED'ı geri alamaz. |
| Başkasının talebine issue | Sahiplik kontrolü, 404. |
| Not alanından iletişim bilgisi sızdırma | `contact-detection` ile sağlayıcı projeksiyonunda maskeleme. Admin ham metni görür. |
| Admin yanlış confirm | İlk karar immutable, audit'li. Düzeltme yalnız SUPER_ADMIN'in append-only adjudication kaydıyla (§14.1); strike effective outcome'u okur. |
| PROVIDER_CANCELLED_BEFORE_START kötüye kullanımı | Not zorunlu; sağlayıcı yanıtı ve admin kararı itirazı karşılar; ceza yalnız CONFIRMED'da; DISMISSED oranı müşteri risk sinyaline girer. |

---

## 24. API envanteri

**Yeni**

| Uç | Rol / izin | Faz |
|---|---|---|
| `POST /service-requests/:id/service-issue` | CUSTOMER (sahip) | 3 |
| `GET /providers/:providerId/incidents`, `/:incidentId` | Provider (sahip) | 4 |
| `POST /providers/:providerId/incidents/:id/response` | Provider (sahip) | 4 |
| `GET /admin/provider-incidents` (sayfalı, filtreli), `/:id` | `PROVIDER_INCIDENTS_READ` | 4 |
| `POST /admin/provider-incidents/:id/confirm`, `/dismiss` | `PROVIDER_INCIDENTS_DECIDE` | 4 |
| `POST /admin/provider-incidents/:id/adjudications` (karar düzeltme, append-only) | yalnız SUPER_ADMIN | 4 |
| `GET /admin/providers/:id/reliability` | `PROVIDER_INCIDENTS_READ` | 4 |
| `POST /admin/providers/:id/reliability-reviews` | `PROVIDER_RELIABILITY_REVIEW` (+ SUSPENDED için `PROVIDERS_MODERATE`) | 4 |
| `GET /service-requests/:id/rounds` (admin) | `REQUESTS_READ` | 2 |
| `POST /admin/service-requests/:id/rounds` (MATCH_REVIEW → yeni tur) | `REQUESTS_REOPEN` | 5 |

**Değişen**

| Uç | Değişiklik | Faz |
|---|---|---|
| `GET /service-requests/my/:id` | `currentRound`, `rounds[]`, `serviceIssue` | 3 |
| `GET /service-requests/:id/offers` | Varsayılan current round, `?round=all` geçmiş (salt-okunur) | 2 |
| `POST /service-requests/:id/offers/:offerId/action` | Round-aware accept, `OFFER_ROUND_CLOSED`, `PROVIDER_EXCLUDED` | 2 |
| `POST /service-requests/:id/cancel` (+withhold) | Current-round kapsamı | 2 |
| `POST /service-requests/:id/complete` | Round COMPLETED | 1 (dual-write) |
| `GET /providers/:id/requests` (discovery), `/:requestId` | Exclusion ve current-round filtresi | 2 (filtre), 3 (exclusion) |
| `POST /providers/:id/requests/:requestId/offers` | Zorunlu tarihler, tx-içi round/exclusion/status | 2 |
| `POST .../offers/:offerId/withdraw` | Round OPEN kontrolü | 2 |
| `GET /providers/:id/offers`, `/:offerId` | `matchOutcome`, FAILED'da work scope gizli | 2/3 |
| `GET .../matched-contact` (her iki taraf), admin `contact-reveal` | Round lookup | 2 |
| `messages/threads/*` | Round-aware resolve, `isActive`, unread yalnız aktif | 2 |
| `messages/threads/:id`, `/messages` (GET) | Salt-okunur tarihsel mod: orijinal katılımcılara okuma, yazma/read-mark 403 `THREAD_READ_ONLY` | 3 |
| `GET /admin/customers/:id` | DISMISSED incident sayısı/oranı risk sinyali | 5 |
| Review oluşturma / eligibility | Current-round koşulu | 2 |
| Admin `GET /service-requests/:id`, `GET /offers?requestId=` | Round alanları, tur filtresi | 2 |
| `GET /dashboard/admin-summary` | Yeni kuyruk hücreleri | 4/5 |
| Scheduler'lar (expiry, reminder, publish outbox, retry parser) | Round saati, round-aware anahtarlar | 2 |
| `refundOfferCredit` (manuel) | `FAILED_MATCH_NOT_REFUNDABLE` | 3 |

---

## 25. UI envanteri

**Müşteri** (`apps/web/app/requests/[id]/offers/page.tsx`):
- **MATCHED, start öncesi:** "Hizmet tamamlandı" butonu ve ikincil "Sağlayıcı işi iptal etti" bağlantısı (yalnız PROVIDER_CANCELLED_BEFORE_START, not zorunlu). Altında açıklama: "Diğer sorunları taahhüt edilen başlangıç günü (12 Ekim) geçtikten sonra bildirebilirsiniz."
- **Tarihsiz legacy eşleşme** (`supportOnly`): sorun butonu yerine "Destek ile iletişime geç" bağlantısı (talep numarası dolu destek formu).
- **Start sonrası:** "Hizmet tamamlandı" ve ikincil "Hizmetle ilgili sorun bildir" butonu.
- **Modal:**
  - Radio sebep listesi. Yalnız sunucunun `availableReasons`'ı aktif; diğerleri disabled, "13 Ekim'den itibaren" notuyla.
  - Not alanı (OTHER ve PROVIDER_CANCELLED_BEFORE_START'ta zorunlu, sayaçlı).
  - Açık sonuç metni: **"Bu eşleşme kapatılır ve talebiniz yeniden teklif almaya açılır."** Tur 3'te: "...talebiniz ekibimiz tarafından incelenmek üzere beklemeye alınır."
  - Ek uyarı: "Bu işlem geri alınamaz."
  - Onay butonu çift tıklamaya kapalı. `idempotencyKey` modal açılışında üretilir.
  - Hata kodlarının Türkçe eşlemesi (409 mapping deseni).
- **Tur geçmişi:** "Önceki eşleşmeler" katlanır bölümü. Tur no, sağlayıcı adı, sonuç ("Aksaklık bildirildi"), tarih. Eski teklifler salt-okunur.
- **Mesajlar:** kapalı thread "Kapandı · salt okunur" etiketiyle açılır; mesajlar okunur, yazma kutusu yok (karar 4).
- Sağlayıcının incident yanıtı müşteriye **gösterilmez** (karar 6).
- `/requests/matches` listesi yalnız aktif eşleşmeleri gösterir.

**Sağlayıcı:**
- Teklif detayında FAILED durum bandı: "Müşteri hizmet aksaklığı bildirdi — eşleşme sonlandı" ve incident bağlantısı. Work scope ve contact gizlenir.
- `/providers/[id]/olaylar` (incident listesi) ve detay: sebep, maskeli not, yanıt formu (tek seferlik, onay dialog'u) ve karar sonrası durum.
- Teklif formunda tarih alanları zorunlu, `min=today`, end ≥ start istemci doğrulaması (sunucu otoritedir).

**Admin:**
- Incident kuyruğu ve detay sayfası (karar için ConfirmGate). Yanıt penceresi dolmamışsa uyarı (engellemez). SUPER_ADMIN için "Kararı düzelt" aksiyonu ve adjudication geçmişi.
- Müşteri detayında DISMISSED oranı risk rozeti.
- Sağlayıcı "Güvenilirlik" sekmesi ve bloklayıcı bant.
- Talep tur zaman çizelgesi ve teklif tur filtresi.
- `MATCH_REVIEW` aksiyonları.
- Genel görünüm hücreleri.

**Responsive ve erişilebilirlik:**
- 360px genişlikte modal tam ekran.
- Radio grubu `fieldset`/`legend` ile. Disabled seçenekler `aria-disabled` ve açıklama `aria-describedby` ile.
- Hata `role="alert"` (E2E memory notu).
- Sonuç metni butondan önce okunur.
- Odak dialog'a hapsedilir, kapatınca tetikleyiciye döner. WebKit `tabIndex=-1` tuzağı (memory) test edilir.
- Durum rozetleri yalnız renge dayanmaz, metinli.
- Admin bant `role="status"` değil, kalıcı uyarı bölgesi.

---

## 26. İndeks ve performans planı

| Sorgu | İndeks |
|---|---|
| Talebin aktif turu | `ServiceRequest.currentRoundId @unique` (PK lookup) ve `MatchRound_one_active_per_request` partial |
| Turun teklifleri | `Offer(matchRoundId, status)` |
| Sağlayıcının turdaki teklifi | `Offer(providerId, matchRoundId)` unique |
| Exclusion anti-join | `ServiceRequestProviderExclusion(providerId, requestId)` unique |
| Fan-out dışlama listesi | `(requestId, providerId)` unique |
| Sağlayıcının açık incident'ları | `Incident(providerId, status)` |
| 90 günlük confirmed | partial `(providerId, reportedAt) WHERE status='CONFIRMED'` |
| Admin incident kuyruğu | `Incident(status, reportedAt)` |
| Müşteri abuse sinyali | `Incident(customerUserId, reportedAt)` |
| Expiry / reminder | `MatchRound(status, publishedAt)`, `(status, reminderSentAt, publishedAt)` |
| Reliability review kuyruğu | `ProviderReliabilityReview(providerId, createdAt)`. Kuyruk sorgusu confirmed partial index üzerinden gruplanır. |

**Hot path'te ekstra join olmaması için:**
- Marketplace sorgusu round tablosuna join'lenmez. `offers: none { matchRound.status=OPEN }` alt sorgusu, `Offer(providerId, matchRoundId)` üzerinden semi-join olur. Alternatif olarak sorgu önce `currentRoundId` seçer ve teklif filtresi `matchRoundId = currentRoundId` olur (Prisma'da raw veya iki adım).
- Faz 2'de **EXPLAIN (ANALYZE, BUFFERS) zorunlu** olanlar:
  - `listMatchingRequests` (yeni filtrelerle)
  - `findMatchingProviders` (fan-out)
  - Expiry ve reminder taramaları
  - Admin incident kuyruğu (Faz 4)
  - 90 günlük sayım (Faz 4)
  - Admin talep listesinin `MATCH_REVIEW` filtresi
- Yerel ölçek küçük olduğu için seq scan normaldir. EXPLAIN, staging ölçeğinde veya `SET enable_seqscan=off` ile index kullanılabilirliğini kanıtlamak için. PR #158/#160 deseni.

---

## 27. Uygulama fazları

### Faz 1 — Şema expand + backfill + dual-write (davranış değişmez) — UYGULANDI

- **Kapsam (yapıldı):**
  - M1 migration (§5.1, §2.2, §2.6).
  - Tek eşleme, tek yazıcı: `apps/api/src/modules/match-rounds/match-round-projection.ts` (`projectMatchRound`, `roundOneId`) ve `match-round-sync.ts` (`syncCurrentMatchRound`, `currentMatchRoundId`). Her lifecycle yazıcısı, kendi request update'inden **sonra, aynı tx'te** `syncCurrentMatchRound`'u çağırır; round talepten türetilir (envanter §30.2).
  - Okuyucular değişmedi. Dört yeni kolon `PrismaService` global `omit`'inde; hiçbir API yanıtı round bilgisi taşımaz.
  - Tutarlılık scripti (`scripts/ops/rel-002-round-consistency.sql`) + preflight (`scripts/ops/rel-002-preflight.sql`), integration (`match-round-dual-write.spec.ts`) ve migration testi (`match-round-migration.spec.ts`).
- **Bilerek yapılmayanlar (Faz 2):** okuyucuların round'a geçişi, unique swap'ları, NOT NULL, composite FK, `createOfferRecord` tx-içi round/status kontrolü (TOCTOU), teklif tarihlerinin zorunlu olması, scheduler'ların round saatine geçişi, round-aware dedupe anahtarları.
- **Migration:** M1, 94 → 95.
- **Risk:** düşük. Yeni kolonlar okunmuyor; dual-write koşulsuz yazar (bir aynanın reddetmesi sıradan bir lifecycle aksiyonunu yeni bir şekilde başarısız kılardı).
- **Rollout:** geriye uyumlu. Eski kod yeni şemayla çalışır (nullable); deploy penceresinde eski kodun yazdığı satırları yeni kod ilk lifecycle yazımında tamamlar, M2'nin 0. adımı kalanları toplar.
- **Test gate'i:** hedefli API spec'leri, yeni integration + migration testi, yerel restore rehearsal + `migrate deploy`, exact-head CI.
- **Rollback:** kod revert. Şema yerinde kalır.

### Faz 2 — Round-aware iç yapı + enforce + teklif takvimi

- **Kapsam:**
  - M2 (NOT NULL, unique swap'ları, composite FK, terminal trigger).
  - Accept current-round (`OFFER_ROUND_CLOSED`).
  - Cancel ve reject current-round kapsamı.
  - `createOfferRecord` tx-içi status/round/provider kontrolü (TOCTOU fix).
  - Discovery current-round filtresi.
  - Contact ve messaging round lookup, `isActive` / unread.
  - Review current-round koşulu.
  - Scheduler'ların round saatine geçişi.
  - Round-aware dedupe anahtarları ve retry parser.
  - Teklif tarihlerinin zorunlu ve doğrulanmış olması (API ve web sağlayıcı formları). Mevcut NULL tarihlere dokunulmaz (backfill yok, §6.4).
  - M2 0. adımı: deploy penceresinden kalan round'suz satırlar için yeniden backfill (§5.1).
  - Admin talep detayında tur zaman çizelgesi (salt-okunur) ve `GET /rounds`.
- **Migration:** evet (M2, 95 → 96).
- **Risk:** orta-yüksek. Accept, cancel, scheduler ve dedupe yolları, ürünün en yarış-hassas noktaları. Teklif tarihi zorunluluğu sağlayıcı UX'ini değiştirir.
- **Rollout:** hâlâ tek tur var. Davranış eşdeğer olmalı, tek görünür fark zorunlu tarihler. API/web/admin birlikte recreate edilir (web formu önce gelmezse 400 alır, bu yüzden aynı deploy).
- **Test gate'i:**
  - Tüm mevcut accept/cancel/expiry/reminder/contact/messaging spec'leri yeşil.
  - Yeni yarış testleri (TEST-FLAKE-002 deseni: 200 ∪ 409).
  - EXPLAIN çıktıları.
  - E2E: teklif ver → kabul → mesaj → tamamla.
- **Rollback:** M2 ters migration'ı hazır tutulur. Faz 3 açılana kadar geri alınabilir (tek tur).

### Faz 3 — Müşteri issue + reopen + exclusion + minimal incident (flag arkasında)

- **Kapsam:**
  - M3 (exclusion, incident, `MATCH_REVIEW`, numbering, `OperationsSettings.serviceIssueReportingEnabled` varsayılan false).
  - Issue endpoint'i ve tx'i (§8).
  - Exclusion zorlama noktaları ve trigger.
  - Fan-out dışlama.
  - Direct-lead tur 2 canonical yayın kapısı (§20, karar 2).
  - `PROVIDER_CANCELLED_BEFORE_START` (not zorunlu, tarih beklemez) ve tarihsiz legacy eşleşmede destek yönlendirmesi (`SERVICE_ISSUE_REQUIRES_SUPPORT`, karar 1 ve 8).
  - Mesajlaşmada salt-okunur tarihsel mod (§12, karar 4).
  - Müşteri/sağlayıcı/admin outbox'ları (incident-opened, reopened, recorded, admin new).
  - Manuel teklif iadesi bloğu.
  - Müşteri UI'ı (modal, tur geçmişi), sağlayıcı teklif detayında FAILED bandı.
  - Tur 3 → `MATCH_REVIEW`, otomatik R4 yok (admin aksiyonu Faz 5; bu fazda yalnız durum ve görünürlük).
  - Admin ayarlar ekranında flag toggle'ı (Faz 3E deseni).
- **Migration:** evet (M3, 96 → 97).
- **Risk:** orta. Yeni yol, ama flag kapalıyken erişilemez.
- **Rollout:** flag kapalı deploy edilir. Yerel kabul testi sonrası açılır. Staging açılışı ayrı onayla yapılır.
- **Test gate'i:**
  - Eligibility matrisi birim testleri (gün sınırı, İstanbul 23:59/00:00, UTC 21:00 kayması).
  - Idempotency.
  - Exclusion (API + trigger).
  - Kredi invariant testi (sıfır OFFER_REFUND).
  - Tur 1 → 2 → 3 → `MATCH_REVIEW` integration testi.
  - Yarışlar (issue vs complete/cancel/accept).
  - E2E: müşteri bildirimi → yeni tur → yeni sağlayıcı teklif → kabul → A'nın contact/mesaj 403.
- **Rollback:** flag kapatılır. Açılmış turlar geçerli veridir, geri alınmaz.

### Faz 4 — Incident yaşam döngüsü, sağlayıcı yanıtı, admin kararları, reliability

- **Kapsam:**
  - M4 (`ProviderReliabilityReview`, yeni `AdminPermission`'lar, rol tohumları).
  - Sağlayıcı incident endpoint'leri ve UI.
  - Admin kuyruk, detay, confirm/dismiss (ConfirmGate, audit); 72 saat yanıt penceresi yalnız uyarı (karar 9).
  - SUPER_ADMIN-only append-only karar düzeltme (`ProviderIncidentAdjudication`, §14.1, karar 5).
  - 90 günlük sayım (effective outcome), risk seviyesi, eşik bildirimleri.
  - Sağlayıcı "Güvenilirlik" sekmesi, bloklayıcı bant, ReliabilityReview akışı.
  - Genel görünüm hücreleri.
- **Migration:** evet (M4, 97 → 98).
- **Risk:** orta. RBAC (yanıt projeksiyonu izin bazlı; PR #133/#134 deseni) ve bildirim hacmi.
- **Rollout:** Faz 3 flag'iyle uyumlu. Incident'lar Faz 3'ten beri REPORTED olarak birikir, Faz 4 bunları işler.
- **Test gate'i:**
  - Durum makinesi yarışları.
  - Projeksiyon allowlist testleri (sağlayıcı müşteri PII'sı görmüyor, B incident görmüyor).
  - İzin matrisi.
  - E2E: admin confirm → risk rozeti.
- **Rollback:** kod revert. Incident verisi kalır.

### Faz 5 — MATCH_REVIEW admin aksiyonları, sertleştirme, E2E ve temizlik

- **Kapsam:**
  - `POST /admin/service-requests/:id/rounds` (zorunlu not + audit, hard-cap yok; M5 `MatchRoundOpenedBy += ADMIN`), admin `MATCH_REVIEW` UI'ı ve kuyruğu.
  - Müşteri abuse sinyali (DISMISSED sayı/oran rozeti; otomatik kısıt yok, karar 7).
  - Tam E2E paketi (Chromium + WebKit; memory'deki CI tuzakları).
  - Erişilebilirlik denetimi.
  - Ops runbook (`docs/ops/`).
  - Legacy alanlar (`request.reminderSentAt` vb.) için okuyucu kalmadığının doğrulanması (kaldırma ayrı bir PR).
  - CHANGELOG ve `v0.2.0` release notu.
- **Migration:** M5 (yalnız enum değeri).
- **Risk:** düşük.
- **Test gate'i:** E2E yeşil, post-merge gate (CI-SPEED-001).
- **Rollback:** kod revert.

Fazlar arası bağımlılık: 1 → 2 sert (M2 dual-write'a dayanır), 2 → 3 sert (blokerler), 3 → 4 yumuşak (Faz 3 incident'ları REPORTED biriktirir), 4 → 5 yumuşak. Her faz memory'deki "ship sonrası yerel Docker eşitle" prosedürüyle kapanır: ff-pull, dump, migrate, ilgili container'ların recreate'i.

---

## 28. Release etkisi

- Yeni, geriye uyumlu bir ürün özelliği ve yeni public API yüzeyleri getiriyor. **MINOR** bump: `v0.1.x → v0.2.0`.
- Faz 2'deki zorunlu teklif tarihleri API sözleşmesini daraltıyor (opsiyonel alan zorunlu oluyor). Tek tüketici kendi web istemcimiz ve 0.x semver'de MINOR içinde kabul edilebilir. Release notunda "breaking for API clients" olarak belirtilmeli.
- Öneri: `v0.2.0` tag'i Faz 3 flag'i staging'de açılıp doğrulandıktan sonra, Faz 4–5 ile birlikte atılır. Ara fazlar `v0.1.x` patch'leri olarak kalabilir (Faz 1–2 davranış değiştirmez; Faz 2'nin tarih zorunluluğu hariç).
- Bu aşamada version veya tag değişikliği yapılmadı.

---

## 29. Kesinleşen ürün kararları (2026-10-11)

Bu dokümandaki önceki "kalan karar" önerilerinin yerine geçer; metindeki tüm ilgili bölümler bu kararlara göre düzeltildi.

1. **Legacy tarihsiz eşleşmeler.** `acceptedAt` / `preferredDate` üzerinden otomatik eligibility **türetilmez**. Authoritative offer start/end tarihi yoksa otomatik service-issue açılmaz; müşteri destek/admin yoluna yönlendirilir (§6.4, §7, §25).
2. **Direct showcase Round 2.** Canonical marketplace publish gate'ten geçer: auto-publish açık → normal yayın sınıflandırıcısıyla hemen yayınlanabilir; kapalı → normal moderasyon. Incident incelemesi reopen'i bekletmez (§8, §20).
3. **Round 3 sonrası.** Otomatik Round 4 yok; request `MATCH_REVIEW`. Admin, zorunlu not ve audit ile Round 4+'yı manuel açabilir. İlk sürümde admin manuel turları için sabit hard-cap yok (§3, §21).
4. **Tarihsel mesajlar.** FAILED/COMPLETED/CANCELLED round thread'i orijinal katılımcılara salt-okunur gösterilebilir; yazma/okundu-işareti mutasyonu yok; yeni sağlayıcı eski thread'i göremez; "tıkla → 403" UX'i yok (§12).
5. **Incident admin kararı.** CONFIRMED/DISMISSED ilk karar immutable. Düzeltme gerekiyorsa SUPER_ADMIN-only append-only adjudication/correction kaydı; eski karar mutate edilmez; effective strike en son geçerli adjudication'a göre (§2.4.1, §14.1, §15).
6. **Müşteri sağlayıcı yanıtını görmez** (v0.2.0) (§7, §14).
7. **Müşteri suistimali.** Otomatik issue-ban yok; DISMISSED sayısı/oranı admin risk sinyali; kısıtlama ayrı ve gelecek bir ürün kararı (§23).
8. **Yeni sebep `PROVIDER_CANCELLED_BEFORE_START`.** Sağlayıcı işi yapmayacağını açıkça bildirdiyse start tarihini beklemeden kullanılabilir; not zorunlu; diğer sebeplerin tarih kuralları değişmez (§2.1, §6.3).
9. **Sağlayıcı yanıtı.** 72 saat SLA/UX uyarısı; teknik kilit değil; admin daha erken karar verebilir; yanıt beklemek müşterinin reopen'ini **asla** geciktirmez (§8, §14, §16).

Diğer her nokta kilitli kararlardan (A–M) veya mevcut kod invariant'larından çıkarıldı.

---

## 30. Faz 1 uygulama sonucu ve runbook

### 30.1 Preflight (yerel, 2026-10-11, salt-okunur)

`scripts/ops/rel-002-preflight.sql` sonucu:
- ServiceRequest: SUBMITTED 6, APPROVED 9, REJECTED 1, MATCHED 2, COMPLETED 5 (23). Offer: SUBMITTED 3, ACCEPTED 7, WITHDRAWN 2, CANCELLED 2 (14). ContactRevealEvent 4, MessageThread 1.
- Integrity sayaçlarının hepsi 0: MATCHED/COMPLETED'da eksik `matchedOfferId`, ACCEPTED olmayan winner, `offer.requestId` uyuşmazlığı, açık status'ta `matchedOfferId`, reveal/thread request↔offer uyuşmazlığı.
- Bilgi: `approvedAt` NULL olan APPROVED 2 (round'da `publishedAt` NULL kalır), gate'li direct lead 3, release edilmiş lead 0.
- Faz 2/3'te değişecek unique'ler yerinde: `Offer_providerId_requestId_key`, `Offer_one_accepted_per_request`, `ContactRevealEvent_requestId_key`, `MessageThread_requestId_key`, `ServiceRequest_matchedOfferId_key`.

### 30.2 Dual-write yazıcı envanteri

Her satır: request update'i → aynı tx'te `syncCurrentMatchRound(tx, requestId)` (ya da yalnız bağ yazan yerlerde round id okuması).

| Yazıcı | Dosya | Round etkisi |
|---|---|---|
| Talep oluşturma (form, vitrin lead, auto-publish) | `service-requests.service.ts` `create` | R1 oluşturulur (`mr1_<id>`), `currentRoundId` set; onCreated hook'ları ve yayın sonrası |
| Yayın (telefon doğrulama, RELEASE + auto-publish) | `publishRequestInTransaction` | `publishedAt/expiresAt` |
| Moderasyon IN_REVIEW / APPROVED (re-approval dahil) | `updateServiceRequestStatus` | `publishedAt/expiresAt` = `approvedAt` (+14g) ya da NULL |
| Reddetme / rapor kaldırma | `rejectRequestInTransaction` | OPEN kalır |
| Rapor sonrası yeniden açma | `reopenAfterRemoval` → `updateServiceRequestStatus` | `publishedAt/expiresAt` tazelenir, `reminderSentAt` korunur |
| Teklif oluşturma | `providers.service.ts` `createOffer` | `Offer.matchRoundId = currentRoundId` (yalnız okuma; eligibility değişmedi) |
| Direct lead'e sahibin teklifi (SUBMITTED→APPROVED) | aynı | `publishedAt`, kaynak DIRECT_SHOWCASE kalır |
| Kabul | `offers.service.ts` `acceptRequestOffer` | MATCHED + `matchedOfferId/matchedProviderId/matchedAt`; reveal `roundId` = teklifin round'u |
| Tamamlama | `completeServiceRequest` | COMPLETED + aynı `completedAt` |
| İptal (müşteri, personel, iadesiz personel) | `cancelServiceRequest` | CANCELLED + aynı `cancelledAt`; eşleşme kaydı korunur |
| Vitrin RELEASE | `showcase-lead.service.ts` `decideFallback` | kaynak MARKETPLACE |
| Vitrin KEEP_CLOSED / terk edilmiş lead taraması | `decideFallback`, `showcase-lead-sla.service.ts` | CANCELLED |
| Expiry | `request-expiry.service.ts` | EXPIRED + aynı `expiredAt` |
| Reminder claim | `request-reminder.service.ts` | `reminderSentAt` (claim + kopya tek tx; request claim'i otoriter kalır) |
| Mesaj thread'i (lazy) | `messaging.service.ts` `resolveThreadForRequest` | `roundId` = eşleşen teklifin round'u |

Dokunulmayanlar (round alanı yazmayanlar): kalite skoru yeniden hesabı, telefon doğrulamanın `phoneVerifiedAt` yazımı (yayın kısmı yukarıda), disclosure kaydı, teklif shortlist/reject/withdraw/view (round'u değiştirmez; teklif kendi `matchRoundId`'sini taşır).

### 30.3 Request ↔ round invariant'ları

`scripts/ops/rel-002-round-consistency.sql` (ihlal başına bir satır; boş = tutarlı):
1. Her request'in `currentRoundId`'si var ve kendi round'unu gösteriyor.
2. Faz 1: her request'in tam bir round'u var.
3. Current round, request'in projeksiyonuyla alan alan aynı (status, source, roundNumber=1, openedAt, publishedAt, expiresAt, reminderSentAt, matched*, completed/cancelled/expiredAt; `failedAt` NULL).
4. Her offer kendi request'inin round'unda.
5–6. Reveal ve thread, teklifinin round'unda.

`match-round-dual-write.spec.ts` her case'ten sonra bu dosyayı çalıştırır (afterEach). Yerel DB'de M1 sonrası 0 satır.

### 30.4 Migration provası, uygulama ve ölçümler (yerel)

- Dump (API durdurulmuşken): `~/Backups/taktic/db/taktic-db-20261011T090635Z-pre-rel002-m1-ad96b136.dump`, sha256 `794615c1e4429e202bf79749a8f3cf04b18f34b9ffb39fc8b47736c5fe28d7c1` (1101 TOC, 98 tablo, 94 migration).
- `restore-rehearsal.sh` (izole internal network, tmpfs) geçti; `taktic-migrate:6814ded2` ile status güncel, drift yok.
- Deploy provası: dump ayrı bir atılabilir PostgreSQL 16.6'ya açıldı, `prisma migrate deploy` → M1 21 ms (wall 0,76 s); tutarlılık 0 satır; drift yok; mevcut 98 tablonun veri hash'leri (yeni kolonlar hariç) birebir aynı.
- Aktif yerel DB: 94 → 95 (M1 60 ms), ikinci deploy "No pending", `migrate status` güncel, drift yok, tutarlılık 0 satır.
- Fingerprint önce → sonra: tablo 98 → 99, index 516 → 525 (+9), constraint 510 → 520 (+10: pkey, 7 FK, 2 CHECK), trigger 31 → 32; tablo başına veri hash'leri değişmedi.
- Boyut: her yeni index 16 kB (9 × 16 kB), round tablosu 8 kB; DB boyutu +319 KB (yerel), provada +368 KB.
- Round dağılımı (yerel): OPEN/MARKETPLACE 13 (8'inde `publishedAt`), OPEN/DIRECT_SHOWCASE 3, MATCHED 2, COMPLETED 5.
- **Ölçek provası** (atılabilir PostgreSQL 16.6, sentetik veri: 200k request, 500k offer, 50k reveal, 20k thread): M1 **15,1 s** (wall 15,8 s), tutarlılık 0 satır. DB 413 MB → 686 MB (+273 MB; çoğu backfill UPDATE'inin yeni tuple'ları — VACUUM sonrası geri kazanılır). Index boyutları: `Offer_matchRoundId_status_idx` 15 MB, `ServiceRequest_currentRoundId_key` 9,2 MB, round pkey 7,6 MB, `requestId_roundNumber` 6 MB, `matchedOfferId` 4,8 MB, one-active 3 MB, reveal/thread `roundId` 2,6 / 1 MB; round tablosu 23 MB.
- Sonuç: M1 tek transaction'da `ALTER TABLE` kilitlerini commit'e kadar tutar; bu ölçekte ~15 s yazma kesintisi demektir. Prod ölçeği bunun altındaysa tek migration yeterli; üstündeyse (§5.2) backfill migration dışına alınıp batch'lenir. Staging/prod sayıları preflight ile ölçülmeden karar verilmez.
- Hot path: okuyucular değişmedi. Lifecycle yazıcıları başına +1 okuma (request + matched offer'ın providerId'si) ve +1 upsert (round); teklif oluşturmada +1 okuma (`currentRoundId`), round satırına yazma yok (eşzamanlı teklifler round'da çakışmaz).

### 30.5 Runbook (staging / production için; bu PR'da dokunulmadı)

1. `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/ops/rel-002-preflight.sql` → integrity sayaçlarının hepsi 0 olmalı. Değilse DUR (M1'in doğrulama bloğu da reddeder).
2. Offer sayısı ~100k'yı aşıyorsa backfill'i batch'lemeyi değerlendir (§5.2); aksi hâlde tek migration.
3. Normal deploy sırası: API durdur → `backup-db.sh` → `restore-rehearsal.sh` → `migrate deploy` (95) → ikinci deploy "No pending" → `migrate drift` 0.
4. `psql ... -f scripts/ops/rel-002-round-consistency.sql` → 0 satır.
5. Yeni API'yi başlat. Web/admin değişmedi (recreate gerekmez).
6. Geri dönüş: kod revert; şema kalır (nullable, okuyucusuz). Eski kodun ürettiği round'suz satırlar M2'nin 0. adımıyla toplanır.

### 30.6 Faz 2 için kalan gerçek blocker'lar

1. Okuyucular hâlâ request kolonlarında: discovery `offers: none` filtresi, accept'in `OFFER_ROUND_CLOSED` kontrolü, contact/messaging lookup, review, admin projeksiyonları (§24 "Değişen", Faz 2 satırları).
2. Per-request unique'ler (`Offer_providerId_requestId_key`, `Offer_one_accepted_per_request`, reveal/thread `requestId` unique) — M2 swap'ı.
3. NOT NULL ve composite FK'ler (M2) — önce deploy penceresinin round'suz satırları için 0. adım backfill.
4. `createOfferRecord` tx-içi status/round kontrolü (mevcut TOCTOU).
5. Scheduler'lar (expiry/reminder) ve publish fan-out dedupe anahtarı round saatine/turuna geçmeli; retry parser `:r<N>`.
6. Teklif start/end tarihlerinin zorunlu hale gelmesi (API + web formları aynı deploy'da).
7. Dual-write'ın yerini açık round geçişleri almalı (`syncCurrentMatchRound` yalnız Round 1'i bilir); `MatchRound_open_has_no_match` CHECK'i ve scheduler index'leri M2'de.
