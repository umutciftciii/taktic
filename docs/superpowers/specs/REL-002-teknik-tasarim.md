# REL-002 — Provider Reliability / Match Round — Teknik Tasarım ve Fazlandırma

- Baseline: `main@ad96b1360b3602510d63cd7e3efe6ddc486a8a0f` (doğrulandı), yerel DB 94 migration (doğrulandı), release `v0.1.0`
- Durum (2026-10-11): §29'daki 9 ürün kararı **kesinleşti** ve bu dokümana işlendi. **Faz 1 uygulandı** (match-round şeması, backfill, lifecycle dual-write; davranış değişikliği yok) — gerçek şema adları, uygulama sonucu ve runbook §30'da. **Faz 2 uygulandı** (round matching core'un otoritesi, M2 enforce, teklif takvimi zorunlu) — gerçek şema, kısıtlar, hata kodları, ölçümler ve runbook §31'de; §2.2, §2.6, §5.1 (M2), §6.1 ve §19 Faz 2'nin gerçek hâline göre güncellendi. **Faz 3 uygulandı** (müşteri hizmet aksaklığı bildirimi, FAILED/MATCH_REVIEW, Round N+1, sağlayıcı dışlama, M3; bayrak arkasında, varsayılan kapalı) — gerçek şema, API, kararlar, ölçümler ve runbook §32'de; §2.1–2.4, §5.1 (M3), §5.3, §7, §10, §12 ve §27 Faz 3'ün gerçek hâline göre güncellendi. **Faz 4 uygulandı** (sağlayıcı yanıtı, append-only karar + SUPER_ADMIN düzeltmesi, hesaplanan güvenilirlik, review akışı, M4; bayrak hâlâ kapalı) — gerçek şema, kararlar, ölçümler ve runbook §33'te; §2.4.1, §2.5, §14.1, §15–§17'deki taslaktan farklar §33.1'de. Faz 5 hâlâ tasarım.
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
// M1'de (Faz 1) yalnız tek-turlu yaşam döngüsünün ulaşabildiği değerler vardı.
// FAILED, SERVICE_ISSUE ve ADMIN M3'te (Faz 3) `ALTER TYPE ... ADD VALUE IF NOT
// EXISTS` ile eklendi (ADMIN yalnız Faz 5 kontratı için; henüz yazan yok).
// ServiceIssueReason, ProviderIncidentStatus ve ServiceIssueEligibilityBasis
// M3'te oluşturuldu; ProviderIncidentOutcome ve ProviderReliabilityDecision Faz 4.
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
  ADMIN                // MATCH_REVIEW sonrası personel kararı (R4+, §21) [M3'te eklendi, ilk yazıcı Faz 5]
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

// M3'te ServiceRequestStatus'a eklendi:
//   MATCH_REVIEW — 3. tur da başarısız; otomatik tur yok, personel kararı bekliyor (§21)
// M3'te eklendi (Faz 3):
enum ServiceIssueEligibilityBasis {
  OFFER_DATES            // taahhüt edilen start/end günü geçti
  PROVIDER_CANCELLATION  // PROVIDER_CANCELLED_BEFORE_START — tarih beklemez
}
// NumberedEntityType += SERVICE_INCIDENT (INC-YYYY-NNNNNN),
// AdminPermission += SERVICE_ISSUE_SETTING_WRITE (bayrağın tek yazma izni).
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

M2'de (Faz 2, `20261011180000_enforce_round_matching_core`) eklenenler: `@@unique([id, requestId])` (composite FK hedefi), `matchedOffer` ilişkisi composite FK `(matchedOfferId, id) → Offer(id, matchRoundId)`, scheduler index'leri `@@index([status, expiresAt])` ve `@@index([status, reminderSentAt, publishedAt])`. `currentForRequest` ilişki listesi oldu (composite FK; `currentRoundId @unique` yine en fazla bir talep demek). Ayrıntı §31.1.

M3'te (Faz 3, `20261012090000_add_service_issue_reopen_core`) eklenenler — uygulandı:
- `failureIncidentId String? @unique` + composite FK `(failureIncidentId, id) → ProviderServiceIncident(id, roundId)` (`failureIncident`), `incidents` (liste; `incident.roundId @unique` tek tutar), `exclusionsSourced`, `FAILED` değeri, `MatchRound_failed_shape` ve `MatchRound_failure_incident_only_when_failed` CHECK'leri; terminal trigger FAILED'ı ve `failureIncidentId`'nin değişmezliğini kapsar (§32.1).

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

M2 (Faz 2) bu CHECK'i status başına tam şekille değiştirdi (`MatchRound_open_has_no_outcome`, `_matched_shape`, `_completed_shape`, `_cancelled_shape`, `_expired_shape`, `_publication_pair`; §31.1). `MatchRound_failed_shape` M3'e kaldı.

Diğer invariant'lar (M2'de uygulandı):
- **Matched offer ↔ round uyumu**: composite FK `(matchedOfferId, id) → Offer(id, matchRoundId)`; Offer'da `@@unique([id, matchRoundId])`.
- **"Round başına en fazla bir kabul edilmiş teklif"**: `matchedOfferId @unique` (M1) ve `Offer_one_accepted_per_round` (M2).

### 2.3 `ServiceRequestProviderExclusion` (§9) — M3'te uygulandı

```prisma
model ServiceRequestProviderExclusion {
  id            String             @id @default(cuid())
  requestId     String
  providerId    String
  sourceRoundId String
  incidentId    String             @unique
  reason        ServiceIssueReason
  createdAt     DateTime           @default(now())

  request     ServiceRequest           @relation(fields: [requestId], references: [id], onDelete: Restrict)
  provider    ProviderProfile          @relation(fields: [providerId], references: [id], onDelete: Restrict)
  sourceRound ServiceRequestMatchRound @relation(fields: [sourceRoundId, requestId], references: [id, requestId], onDelete: Restrict)
  incident    ProviderServiceIncident  @relation(fields: [incidentId, requestId, providerId], references: [id, requestId, providerId], onDelete: Restrict)

  @@unique([requestId, providerId])   // fan-out anti-join + tekil probe (isProviderExcluded)
  @@index([providerId])               // keşif listesinin anti-join'i + provider FK restrict kontrolü
}
```

Composite FK'ler: kaynak tur talebin kendi turu; incident aynı talep ve aynı sağlayıcının incident'ı. Satırlar kalıcıdır: `ServiceRequestProviderExclusion_append_only` trigger'ı UPDATE/DELETE'i reddeder (TRUNCATE tetiklemez — test reset'i). Taslaktaki `@@unique([providerId, requestId])` yerine düz `@@index([providerId])` seçildi: tekillik zaten `(requestId, providerId)` unique'inde; ölçüm §32.10.

### 2.4 `ProviderServiceIncident` (§14)

**M3'te uygulanan hâli §32.1'dedir**; aşağıdaki taslaktan farkları: `incidentNumber` zorunlu (`INC-YYYY-NNNNNN`, aynı tx'te numaralandırılır), `eligibilityBasis` bir enum (`ServiceIssueEligibilityBasis`), `providerRespondedBy` → `providerRespondedById` (User FK), round ve teklif composite FK ile bağlı (`(roundId, requestId) → round(id, requestId)`, `(offerId, roundId) → Offer(id, matchRoundId)`), composite FK hedefleri `@@unique([id, roundId])` ve `@@unique([id, requestId, providerId])`, ek `@@index([requestId])`; `Incident_confirmed_by_provider_idx` partial index'i ve `ProviderIncidentAdjudication` Faz 4'e (M4) kaldı. Satır silinemez (`ProviderServiceIncident_no_delete` trigger'ı).

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

### 2.4.1 `ProviderIncidentAdjudication` (§14.1, karar 5) — Faz 4 (M4)

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

M1'de eklendi, M2'de (Faz 2) enforce edildi — `prisma/schema.prisma`'daki hâliyle:

```prisma
model ServiceRequest {
  currentRoundId  String                     @unique @default(dbgenerated())   // NOT NULL; doğum trigger'ı doldurur
  currentRound    ServiceRequestMatchRound   @relation("ServiceRequestCurrentRound", fields: [currentRoundId, id], references: [id, requestId], onDelete: Restrict)
  matchRounds     ServiceRequestMatchRound[] @relation("ServiceRequestMatchRounds")
  contactRevealEvents ContactRevealEvent[]   // M2: requestId artık unique değil
  messageThreads      MessageThread[]
  // + Faz 3: providerExclusions, serviceIncidents
}

model Offer {
  matchRoundId    String                     @default(dbgenerated())   // NOT NULL
  matchRound      ServiceRequestMatchRound   @relation("OfferMatchRound", fields: [matchRoundId, requestId], references: [id, requestId], onDelete: Restrict)
  matchedForRound ServiceRequestMatchRound[] @relation("MatchRoundMatchedOffer")
  @@unique([providerId, matchRoundId])   // Offer_providerId_requestId_key'in yerine
  @@unique([id, matchRoundId])           // composite FK hedefi
  @@index([matchRoundId, status])
}

model ContactRevealEvent { requestId String  roundId String @unique @default(dbgenerated())  @@index([requestId]) }
model MessageThread      { requestId String  roundId String @unique @default(dbgenerated())  @@index([requestId]) }
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

**M2 — enforce (Faz 2) — UYGULANDI**

Migration: `prisma/migrations/20261011180000_enforce_round_matching_core/migration.sql` (yerel 95 → 96). Tek transaction; adımlar:

0. **Yeniden backfill** — M1'in kendi SQL'i, `WHERE ... IS NULL` / `ON CONFLICT DO NOTHING`: M1 ile yeni kodun canlıya çıkışı arasında eski kodun yazmış olabileceği round'suz request ve bağsız offer/reveal/thread satırları. Tam backfill'de no-op.
1. **Doğrulama bloğu** (`DO $$ … RAISE EXCEPTION`): her request'te tam bir round ve `currentRoundId` kendi round'u; offer/reveal/thread kendi request'inin (ve teklifinin) round'unda; `(providerId, matchRoundId)` ve round başına ACCEPTED tekrarı yok; kazanan kendi round'unun teklifi; status başına round şekli. Biri kırılırsa migration bütünüyle geri alınır.
2. **NOT NULL**: dört kolon için `CHECK … NOT VALID` → `VALIDATE` → `SET NOT NULL` → yardımcı CHECK'in düşürülmesi.
3. **Unique swap**: `Offer_providerId_requestId_key` → `Offer_providerId_matchRoundId_key`; `Offer_one_accepted_per_request` → `Offer_one_accepted_per_round` (partial, `WHERE status='ACCEPTED'`); `ContactRevealEvent_requestId_key` / `MessageThread_requestId_key` → düz `…_requestId_idx` (`roundId @unique` M1'den).
4. **Composite FK'ler**: `Offer(matchRoundId, requestId) → Round(id, requestId)`, `Round(matchedOfferId, id) → Offer(id, matchRoundId)`, `ServiceRequest(currentRoundId, id) → Round(id, requestId)`; hedef unique'ler `Offer_id_matchRoundId_key`, `ServiceRequestMatchRound_id_requestId_key`. Request ↔ round FK'leri döngüsel ve ikisi de NOT NULL olduğu için `ServiceRequestMatchRound_requestId_fkey` **DEFERRABLE INITIALLY DEFERRED** yapıldı (Prisma ifade edemez; drift görmez).
5. **Round şekli CHECK'leri** (M1'in `MatchRound_matched_has_offer`'ının yerine): §31.1.
6. **Scheduler index'leri**: `(status, expiresAt)`, `(status, reminderSentAt, publishedAt)`.
7. **Doğum trigger'ı** `ServiceRequest_round_one_at_birth` (BEFORE INSERT, `currentRoundId` boşsa): Round 1'i (`mr1_<id>`) OPEN, `publishedAt` M1 kuralıyla, `source` MARKETPLACE olarak aynı statement'ta yazar. Uygulamanın create yolu da buna dayanır (id önceden bilinmediği için; vitrin lead'i bağlanınca uygulama round'u DIRECT_SHOWCASE yapar). **Bağ varsayılanı** `round_link_default_fn` (Offer/ContactRevealEvent/MessageThread, BEFORE INSERT): round kolonu boşsa talebin current round'unu yazar — yalnız raw INSERT'ler (seed, fixture, rolling deploy'daki eski sürüm) için; uygulama her zaman açıkça yazar ve composite FK yine başka talebin round'unu reddeder.

Swap güvenliği: M2 anında her request'in tek round'u var; yeni unique'ler eskilerle **eşdeğer** başlar, hiçbir satır ihlal edemez. Doğrulama bloğu bunu yeniden kanıtlar.

**M3 — servis aksaklığı, yeniden açılış, dışlama (Faz 3) — UYGULANDI**

Migration: `prisma/migrations/20261012090000_add_service_issue_reopen_core/migration.sql` (yerel 96 → 97). Tek dosya, tek transaction; ayrıntı ve ölçümler §32.
- Enum değerleri: `MatchRoundStatus += FAILED`, `MatchRoundOpenedBy += SERVICE_ISSUE, ADMIN`, `ServiceRequestStatus += MATCH_REVIEW`, `NumberedEntityType += SERVICE_INCIDENT`, `AdminPermission += SERVICE_ISSUE_SETTING_WRITE` — hepsi `ADD VALUE IF NOT EXISTS`.
- **Neden iki dosyaya bölünmedi:** PostgreSQL ≥ 12 `ADD VALUE`'ya transaction içinde izin verir ama değeri commit'e kadar *kullandırmaz*. M3'ün CHECK'leri ve trigger gövdeleri yeni değerleri `"status"::text = 'FAILED'` biçiminde, text olarak karşılaştırır; literal enum'a cast edilmez, migration tek dosyada kalır (yerel 96 → 97, beklendiği gibi). `IF NOT EXISTS`: enum değeri düşürülemediği için M3 rollback'i değerleri bırakır; rollback sonrası yeniden deploy bunlara takılmaz (§32.8).
- Yeni enum'lar `ServiceIssueReason`, `ProviderIncidentStatus`, `ServiceIssueEligibilityBasis`; tablolar `ProviderServiceIncident`, `ServiceRequestProviderExclusion`; `ServiceRequestMatchRound.failureIncidentId`; `OperationsSettings.serviceIssueReportingEnabled` (default false, metadata-only).
- Ham SQL: incident CHECK'leri, FAILED shape, terminal trigger güncellemesi, dışlama append-only ve incident no-delete trigger'ları, `Offer_round_open_guard` INSERT backstop'u (§32.1).
- Backfill yok, mevcut satır yeniden yazılmaz.

**M4 — reliability (Faz 4):** `ProviderIncidentAdjudication`, `ProviderReliabilityReview`, confirmed partial index'i ve yeni `AdminPermission` değerleri.

**M5 — admin yeni tur (Faz 5):** `MatchRoundOpenedBy.ADMIN` M3'te eklendi; Faz 5 yalnız kodu (ve gerekirse audit tablosunu) getirir.

### 5.2 Lock ve ölçek riski

- Yerel boyut 23 request / 14 offer. Staging ve prod ölçeği bu oturumda bilinmiyor (dokunulmadı).
- M1'deki `UPDATE "Offer"` tüm satırlara row lock alır. Kolon nullable olduğu için tablo yeniden yazılmaz (PG ≥11, default'suz ADD COLUMN metadata-only), ama UPDATE her satır için yeni tuple üretir.
- Kural: Faz 1 PR'ı bir **preflight sayım scripti** taşır (`scripts/ops/rel-002-preflight.sql`, salt-okunur, `BEGIN READ ONLY … ROLLBACK`). Offer > ~100k ise backfill migration dışına alınır ve batch'lenir (`WHERE "matchRoundId" IS NULL LIMIT 5000` döngüsü). Bugünkü ölçekte tek migration yeterli (yerel ölçüm §30.4).
- M2'deki `CREATE UNIQUE INDEX`, Prisma migration tx'i içinde `CONCURRENTLY` olamaz. Ölçüm (§31.6): 200k request / 500k offer'da M2 **3,2 s** tek transaction (en ağır adım doğrulama bloğu ~1,1 s, sonra `Offer_providerId_matchRoundId_key` ~0,4 s). Bu süre boyunca Offer/ServiceRequest/round yazmaları bekler. Prod ölçeği bunun çok üstündeyse index'ler elle `CONCURRENTLY` + `prisma migrate resolve` ile önceden kurulur.
- Yerel prosedür (memory'deki desen): migrate öncesi `pg_dump` ile geri dönüş dump'ı alınır. `_prisma_migrations` sayısı 94 → 95 (M1) → 96 (M2) → 97 (M3) → 98 (M4) olur; M5 enum değeri M3'e alındığı için ayrı migration gerekmeyebilir.

### 5.3 Geri dönüş

- **M1:** Kod revert edilir. Tablo ve kolonlar nullable kalır, okuyucu yoktur; eski kod round yazmaz, yalnız yeni satırlar round'suz kalır (M2'nin 0. adımı bunları toplar). Down-migration gerekmez.
- **M2:** `scripts/ops/rel-002-m2-rollback.sql` (tek transaction; herhangi bir talepte >1 round varsa reddeder) şemayı M1 hâline döndürür ve `_prisma_migrations` kaydını siler; Faz 1 kodu (d55d92f1) bu şemayla çalışır. Prova edildi (§31.6). Faz 3 bir talepte ikinci turu açtıktan sonra geri dönüş yalnız ileri-düzeltme ile yapılır. Faz 1 kodu M2 şemasıyla da çalışır (round'ları kendisi yazar; doğum trigger'ı yalnız boş `currentRoundId`'yi doldurur), yani kodu geri alıp şemayı bırakmak da mümkündür.
- **M3:** `scripts/ops/rel-002-m3-rollback.sql` — **yalnız akış hiç kullanılmadıysa** (incident, dışlama, FAILED round, MATCH_REVIEW ve birden fazla round yok; aksi hâlde script kendini reddeder). Tabloları, kolonları, CHECK'leri ve trigger'ları kaldırır, terminal trigger'ı M1 hâline döndürür, `_prisma_migrations` kaydını siler; enum değerlerini bırakır (PostgreSQL'de DROP VALUE yok; kullanılmıyorlar). Prova §32.8. **Gerçek geri dönüş sınırı:** bayrak açılıp ilk gerçek Round 2 oluştuğu andan itibaren ne M3 ne M2 geri alınabilir; Faz 2 kodu birden fazla round'u temsil edemez. Bu noktadan sonra tek yol bayrağı kapatmak (yeni bildirim durur, açılmış turlar geçerli veri olarak kalır) ve ileri-düzeltmedir. Faz 2 kodu M3 şemasıyla çalışır (yerelde kanıtlandı, §32.8) — bayrak hiç açılmadıysa kod geri alınıp şema bırakılabilir.

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
- Kodlar (400, gövdede `field`): `OFFER_SCHEDULE_REQUIRED`, `OFFER_SCHEDULE_INVALID` (saatli ISO ya da takvimde olmayan gün), `OFFER_START_IN_PAST` (`today` ile), `OFFER_END_BEFORE_START`, `OFFER_SCHEDULE_TOO_FAR` (`latest` ile). Uygulandı (Faz 2): API `apps/api/src/common/offer-schedule.ts`, web `packages/shared/src/offer-schedule.ts` (aynı kurallar, aynı `limits.json` `offerScheduleMaxDays = 365`).
- Web: iki teklif formu da (`providers/[id]/requests/[requestId]`, `vitrin/talepler/[leadId]`) ortak `OfferScheduleFields` bileşenini kullanır (`required`, `min`/`max` İstanbul günü); server action'lar API'den önce `validateOfferSchedule` çalıştırır ve API'nin aynı kodlu reddini aynı cümleyle forma döndürür.
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
Guards: AuthGuard + RolesGuard(CUSTOMER) + ServiceIssueThrottlerGuard   // SUPER_ADMIN değil: beyan müşterinin
Rate limit (uygulandı): deneme bütçesi kullanıcı başına 10 / 10 dk (named throttler `service-issues`,
  SERVICE_ISSUE_RATE_LIMIT_MAX/_WINDOW_SECONDS ile ayarlanır) + kalıcı bütçe: başarılı bildirim
  müşteri başına 5 / 10 dk (incident sayımı, tx içinde) → 429 SERVICE_ISSUE_RATE_LIMITED
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
{ "incidentId": "...", "incidentNumber": "INC-2026-000001", "failedRoundNumber": 1,
  "outcome": "REOPENED" | "ADMIN_REVIEW", "replayed": false, "requestStatus": "APPROVED",
  "currentRound": { "id": "...", "roundNumber": 2, "status": "OPEN", "publishedAt": "...", "expiresAt": "..." } }
```

Uygulamada (§32.3): HTTP 200 (yeni bildirim ve replay); bayrak kapalıyken, sahip olmayan müşteride ve olmayan talepte 404; sağlayıcı/admin rolü 403 (RolesGuard). Sıra: sahiplik → idempotency replay/`IDEMPOTENCY_KEY_REUSED` → `ROUND_ALREADY_FAILED` → `REQUEST_NOT_MATCHED` → `ROUND_CHANGED` → `MATCH_INCONSISTENT` → takvim (`SERVICE_ISSUE_REQUIRES_SUPPORT`, `SERVICE_ISSUE_REASON_NOT_YET_AVAILABLE` + `opensOn`) → not (`SERVICE_ISSUE_NOTE_REQUIRED` 400, `SERVICE_ISSUE_NOTE_TOO_LONG` 400, normalize sonrası > 1000) → bütçe (429).

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
| Talep `MATCH_REVIEW`'da iptal edilirse | Current round FAILED, winner yok → `NOT_MATCHED`. `closedOfferIds`/`refundedOfferIds` boş. Uygulandı: iptal round'a dokunmaz (FAILED terminal kalır), FAILED turun tekliflerini sorgulamaz bile. |
| Admin incident'ı dismiss ederse | Otomatik iade yok. İstisnai telafi `ManualCreditOperation` (ADMIN_GRANT, idempotencyKey zorunlu) ile ayrı bir operasyondur. |
| Admin manuel teklif iadesi (`refundOfferCredit` / `OFFER_REFUND_*`) | Başarısız turun kazanan teklifi için **reddedilir** (uygulandı): 409 `FAILED_MATCH_NOT_REFUNDABLE`, mesaj "Bu eşleşme hizmet aksaklığı bildirimiyle kapandı; teklif bazlı iade yapılamaz. Gerekiyorsa manuel kredi telafisi (kredi yükleme) kullanın." Kontrol diğer koşullardan önce yapılır. Gerekçe: teklif bazlı iade sistemin iade politikasıdır; telafi ayrı bir ledger nedeni taşımalı ki raporlar ikisini ayırabilsin. |
| Unviewed-refund worker | **Uygulandı (Faz 3), en dar kapsam:** aday predicate'ine (`refundCandidateWhere`) `matchedForRound: { none: { status: FAILED } }` eklendi — FAILED turun **kazananı** hiçbir zaman aday olmaz (scan, run ve dashboard sayımı aynı predicate). FAILED turun **rakip** teklifleri bilinçli olarak dışlanmadı: görülmemiş bir rakibin 48 saat iadesi sağlayıcıya verilmiş bir sözdür ve başka birinin başarısızlığı onu bozmaz (OPEN/EXPIRED/CANCELLED davranışı değişmedi). Ek olarak `refundOfferCreditInTransaction` ve `refundOfferRechargeInTransaction` her çağrıda FAILED kazananı reddeder (409 `FAILED_MATCH_NOT_REFUNDABLE`) — worker, iptal ve manuel iade tek barikattan geçer. |

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
- **Salt-okunur tarihsel mod (karar 4, Faz 3) — uygulandı (§32.6):** round'u FAILED, COMPLETED veya CANCELLED olan bir thread, o thread'in **orijinal katılımcılarına** (thread'in `customerUserId` / `providerUserId`'si) salt-okunur gösterilir:
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
- **Geçiş (Faz 2) — uygulandı:**
  - Expiry adayları round'lardan seçilir (`status OPEN, publishedAt NOT NULL, expiresAt <= now`, current'ı olduğu talep APPROVED); tx'te önce request (`APPROVED, matchedOfferId NULL, currentRoundId = round`) sonra round (`transitionRoundToExpired`) — accept ile aynı yazma sırası.
  - Reminder adayları round'lardan (`OPEN, reminderSentAt NULL, publishedAt <= now-7g`, round'da hiç teklif yok, talep APPROVED). Claim `round.reminderSentAt` (`claimRoundReminder`); `request.reminderSentAt` aynı tx'te uyumluluk aynası olarak yazılır (talep artık bu round'un APPROVED sahibi değilse claim geri alınır), hiçbir karar onu okumaz. E-postadaki `expiresAt` round snapshot'ıdır.
  - Backfill, tur 1'in `publishedAt=approvedAt` ve `reminderSentAt` değerlerini taşıdığı için çalışan talepler aynı anda expire veya remind edilir; davranış farkı yoktur. `approvedAt` NULL legacy satırlar (yerelde 2) yine taranmaz.
  - Ölçek notu (§31.7): aday taraması APPROVED talepler üzerinde hash join yapar (200k/80k APPROVED'da ~35 ms/tick); saatlik cron'da kabul edilebilir.
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

### Faz 2 — Round-aware iç yapı + enforce + teklif takvimi — UYGULANDI

Gerçek sonuç, sapmalar ve runbook §31'de. Aşağıdaki kapsam metni planlandığı hâliyle duruyor; tek fark admin tarafında yalnız salt-okunur `GET /service-requests/:id/rounds` yapıldı (admin UI zaman çizelgesi Faz 3/5'e kaldı).


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

### Faz 3 — Müşteri issue + reopen + exclusion + minimal incident (flag arkasında) — UYGULANDI

Gerçek sonuç, sapmalar ve runbook §32'de. Aşağıdaki kapsam metni planlandığı hâliyle duruyor; farklar: admin tur zaman çizelgesi UI'ı yok (API verisi `GET /service-requests/:id/rounds`'ta, §32.9), sağlayıcı teklif detayında FAILED bandı var, bayrağın admin toggle'ı `SERVICE_ISSUE_SETTING_WRITE` izniyle.

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
- **Migration:** evet (M3, 96 → 97, uygulandı).
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
- **Migration:** evet (M4, 97 → 98; `ProviderIncidentAdjudication` dahil).
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

### 30.6 Faz 2 için kalan gerçek blocker'lar — Faz 2'de kapandı (§31)

Aşağıdaki yedi maddenin hepsi Faz 2'de kapandı; Faz 3'ün ön koşulları §31.10'da.


1. Okuyucular hâlâ request kolonlarında: discovery `offers: none` filtresi, accept'in `OFFER_ROUND_CLOSED` kontrolü, contact/messaging lookup, review, admin projeksiyonları (§24 "Değişen", Faz 2 satırları).
2. Per-request unique'ler (`Offer_providerId_requestId_key`, `Offer_one_accepted_per_request`, reveal/thread `requestId` unique) — M2 swap'ı.
3. NOT NULL ve composite FK'ler (M2) — önce deploy penceresinin round'suz satırları için 0. adım backfill.
4. `createOfferRecord` tx-içi status/round kontrolü (mevcut TOCTOU).
5. Scheduler'lar (expiry/reminder) ve publish fan-out dedupe anahtarı round saatine/turuna geçmeli; retry parser `:r<N>`.
6. Teklif start/end tarihlerinin zorunlu hale gelmesi (API + web formları aynı deploy'da).
7. Dual-write'ın yerini açık round geçişleri almalı (`syncCurrentMatchRound` yalnız Round 1'i bilir); `MatchRound_open_has_no_match` CHECK'i ve scheduler index'leri M2'de.

---

## 31. Faz 2 uygulama sonucu ve runbook

Baseline `main@d55d92f1`, yerel DB 95 migration, release `v0.1.0`. PR: „REL-002 Faz 2: make matching core round-aware and enforce per-round invariants".

### 31.1 Gerçek M2 şeması ve kısıtlar

Migration `20261011180000_enforce_round_matching_core` (§5.1). Kısıtların tamamı:

| Nesne | Tür | Anlamı |
|---|---|---|
| `ServiceRequest.currentRoundId`, `Offer.matchRoundId`, `ContactRevealEvent.roundId`, `MessageThread.roundId` | NOT NULL | Her talep/teklif/reveal/thread bir round'a ait |
| `Offer_providerId_matchRoundId_key` | UNIQUE | Sağlayıcı başına round başına bir teklif |
| `Offer_one_accepted_per_round` | partial UNIQUE (`matchRoundId`) `WHERE status='ACCEPTED'` | Round başına bir kabul |
| `ContactRevealEvent_roundId_key`, `MessageThread_roundId_key` (M1) + `offerId` unique'leri | UNIQUE | Round başına bir reveal / bir thread |
| `ContactRevealEvent_requestId_idx`, `MessageThread_requestId_idx` | INDEX | Talep kapsamlı okuyucular |
| `Offer_id_matchRoundId_key`, `ServiceRequestMatchRound_id_requestId_key` | UNIQUE | Composite FK hedefleri |
| `Offer_matchRoundId_requestId_fkey` | FK | Teklifin round'u kendi talebinin round'u |
| `ServiceRequestMatchRound_matchedOfferId_id_fkey` | FK | Round'un kazananı o round'un teklifi |
| `ServiceRequest_currentRoundId_id_fkey` | FK | Current round talebin kendi round'u |
| `ServiceRequestMatchRound_requestId_fkey` | FK, DEFERRABLE INITIALLY DEFERRED | Talep + Round 1 aynı tx'te yazılabilsin |
| `MatchRound_open_has_no_outcome` | CHECK | OPEN: kazanan/tamam/iptal/expire/failed damgası yok |
| `MatchRound_matched_shape` | CHECK | MATCHED: offer + provider + matchedAt; terminal damga yok |
| `MatchRound_completed_shape` | CHECK | COMPLETED: kazanan + matchedAt + completedAt |
| `MatchRound_cancelled_shape` | CHECK | CANCELLED: cancelledAt; eşleşme kaydı ya tam ya yok |
| `MatchRound_expired_shape` | CHECK | EXPIRED: expiredAt; eşleşme yok |
| `MatchRound_publication_pair` | CHECK | `publishedAt` ve `expiresAt` birlikte |
| `ServiceRequestMatchRound_status_expiresAt_idx`, `…_status_reminderSentAt_publishedAt_idx` | INDEX | Scheduler |
| `ServiceRequest_round_one_at_birth` | trigger | Talep Round 1 ile doğar |
| `Offer_/ContactRevealEvent_/MessageThread_round_link_default` | trigger | Raw INSERT'te boş round bağını doldurur |
| `MatchRound_terminal_status_immutable` (M1) | trigger | Değişmedi; FAILED M3'te eklenir |

`FAILED` enum değeri eklenmedi (M3).

### 31.2 Round geçiş mimarisi

`apps/api/src/modules/match-rounds/`:
- `match-round-transitions.ts` — tek iş kuralı kaynağı. `getCurrentRound(OrThrow)`, `isOfferRoundCurrentAndOpen` / `assertOfferRoundCurrentAndOpen`, `roundPublicationFor`, `publishRound`, `setRoundSource`, `transitionRoundToMatched/Completed/Cancelled/Expired`, `claimRoundReminder`. Her geçiş round'un kendi status'una koşullu `updateMany`; eşleşmezse 409 `MATCH_ROUND_STATE_CHANGED` ve tx geri alınır.
- `match-round-chain.ts` — „current match" okuması (`MATCH_CHAIN_REQUEST_SELECT`, `currentMatchedOfferId`, `findCurrentRoundReveal`): contact, messaging ve match mail'inin iletişim satırları aynı tanımı kullanır.
- `match-round-dedupe.ts` — §31.8.
- Faz 1'in `syncCurrentMatchRound` ve `projectMatchRound`'u uygulamadan kaldırıldı; projeksiyon yalnız test fixture'larında yaşıyor (`apps/api/test/match-round-fixtures.ts` `alignRoundWithRequest`, e2e `alignRoundWithRequest`): uygulamayı atlayıp talebi doğrudan MATCHED/COMPLETED yazan fixture'lar round'u bununla hizalar.

Yazıcı → geçiş (hepsi request projeksiyonuyla aynı tx'te):

| Yazıcı | Round |
|---|---|
| Talep oluşturma | Doğum trigger'ı (Round 1 OPEN); vitrin lead hook'u `setRoundSource(DIRECT_SHOWCASE)` |
| Yayın (`publishRequestInTransaction`), moderasyon APPROVED/IN_REVIEW, reopen | `publishRound(roundPublicationFor(status, approvedAt))` |
| Direct lead'e sahibin teklifi (SUBMITTED→APPROVED) | `publishRound(submittedAt)` |
| Vitrin RELEASE | `setRoundSource(MARKETPLACE)` |
| Accept | `transitionRoundToMatched` |
| Complete | `transitionRoundToCompleted` |
| Cancel (müşteri/personel), KEEP_CLOSED, terk edilmiş lead | `transitionRoundToCancelled` |
| Expiry | `transitionRoundToExpired` |
| Reminder | `claimRoundReminder` (+ request aynası) |
| Reddetme/rapor kaldırma | Round OPEN kalır; yalnız current round'un teklifleri kapanır |

### 31.3 Teklif oluşturma (TOCTOU kapandı)

`createOfferRecord`: dışarıdaki `ensureProviderCanSeeRequest` yalnız hızlı cevap. Serializable tx içinde tek predicate (`canProviderActOnRequest`: sağlayıcı APPROVED + kategori + bölge, doğrulama ve vitrin kapısı, APPROVED ya da kendi SUBMITTED direct lead'i) tx'te okunan satırlarla yeniden uygulanır; current round OPEN değilse 409 `OFFER_ROUND_CLOSED`; `(providerId, currentRoundId)` teklifi varsa 409; teklif `matchRoundId = currentRoundId` ile yazılır. Accept da Serializable olduğundan „offer vs accept" yarışında ya teklif önce commit olur ve accept onu rakip olarak REJECTED yapar ya da teklif yeniden denemede talebi göremez (404, kredi düşmez). DB backstop: `(providerId, matchRoundId)` unique + composite FK.

### 31.4 Takvim, accept, stale-round, keşif, contact, messaging, review, cancel

- **Takvim:** §6.1 (kodlar, `field`, 365 gün, saatli ISO reddi, NULL legacy okunur, backfill yok).
- **Accept:** tx'te current round + teklif okunur; talep APPROVED ve eşleşmesizken teklif current OPEN round'da değilse 409 `OFFER_ROUND_CLOSED`. Request `updateMany` (`APPROVED, matchedOfferId NULL, currentRoundId`) → `transitionRoundToMatched` → teklif ACCEPTED → recharge (değişmedi) → yalnız **bu round'un** rakipleri `COMPETITOR_ACCEPTED` → reveal `roundId = current`.
- **Shortlist/reject:** Serializable tx'te teklif zaten kararlıysa eski sınıflandırma (OFFER_ACTION_NOT_ALLOWED / idempotent reject); değilse round current OPEN değilse 409 `OFFER_ROUND_CLOSED`. **Withdraw:** talep APPROVED değilse eski 409, round kapalıysa `OFFER_ROUND_CLOSED`. Tek-round'daki tek görünür fark: EXPIRED talebin hâlâ SUBMITTED teklifine shortlist/reject artık 409.
- **Müşteri teklif listesi:** current round'un teklifleri (tek round'da hepsi).
- **Keşif:** `currentRoundOpenForProviderFilter` (liste) ve `isCurrentRoundOpen` (detay + teklif yolu): current round OPEN ve sağlayıcının **bu round'da** teklifi yok; detaydaki „teklifiniz" current round'unki. Önceki round teklifi görünürlüğü engellemez (exclusion Faz 3).
- **Contact:** `currentMatchedOfferId` (talep ve current round aynı teklife MATCHED) + current round'un reveal'i; admin görünümü de current round reveal'i. Eski round reveal'i silinmez, current olmayan sağlayıcıya 404.
- **Messaging:** thread current round için get-or-create (`roundId` unique); bir thread yalnız `roundId = currentRoundId` ve current match onun teklifiyken aktif — okuma/yazma/okundu dâhil her istek bunu yeniden türetir (değilse 403). Inbox yanıtına `active` eklendi; okunmamış sayısı ve rozet yalnız aktif thread'leri sayar (tek-round'da da: tamamlanmış/iptal edilmiş eşleşmenin thread'i artık rozeti büyütmez).
- **Work scope:** ACCEPTED yetmez; teklif current round'un kazananı, round MATCHED/COMPLETED ve talep projeksiyonu uyumlu olmalı.
- **Review:** current round COMPLETED, kazananı talebin matched teklifi, teklif ACCEPTED ve o round'un. `(requestId, providerId)` unique'i korundu.
- **Cancel / reject (kaldırma):** teklif işlemleri `matchRoundId = currentRoundId` ile sınırlı; tek round'da birebir aynı, ikinci round'da önceki round'un kredilerine geriye dönük dokunulmaz.

### 31.5 Hata kodları

| Kod | HTTP | Nerede |
|---|---|---|
| `OFFER_ROUND_CLOSED` | 409 | accept / shortlist / reject / withdraw (kapalı ya da eski round teklifi); teklif oluşturma (APPROVED talep ama round OPEN değil) |
| `MATCH_ROUND_STATE_CHANGED` | 409 | Bir round geçişi beklenen durumu bulamadı (yarış savunması; normalde talebin kendi guard'ı önce reddeder) |
| `OFFER_SCHEDULE_REQUIRED` / `OFFER_SCHEDULE_INVALID` / `OFFER_START_IN_PAST` / `OFFER_END_BEFORE_START` / `OFFER_SCHEDULE_TOO_FAR` | 400 | Teklif oluşturma |

### 31.6 Migration provası, uygulama ve ölçümler

**Preflight** (aktif yerel DB, salt-okunur; `rel-002-preflight.sql` M2 bölümü + ek sayımlar): 95 migration; ServiceRequest 23, MatchRound 23, Offer 14, ContactRevealEvent 4, MessageThread 1, ACCEPTED 7, MATCHED/COMPLETED 7; null round alanı 0; round başına aday tekrarı 0 (provider×round, ACCEPTED×round, reveal, thread); her talepte tam 1 round; kazanan başka round'da 0; round şekli ihlali 0; tutarlılık 0 satır. Round dağılımı: OPEN/MARKETPLACE 13 (8 yayında), OPEN/DIRECT_SHOWCASE 3, MATCHED 2, COMPLETED 5.

**Yedek** (API durdurulmuşken): `~/Backups/taktic/db/taktic-db-20261011T125945Z-pre-rel002-m2-d55d92f1.dump`, sha256 `61802b97592135edf40d11d164160c92dfd36e043f1e8f84bc8600958bba73da` (1124 TOC, 99 tablo, 95 migration). `restore-rehearsal.sh` geçti (izole network, tmpfs; 99 tablo / 1222 satır manifest ile birebir).

**Deploy provası** (dump ayrı, atılabilir PostgreSQL 16.6'ya `pg_restore`): preflight 0 → `migrate deploy` M2 **34 ms** (wall 1,18 s) → ikinci deploy „No pending" → drift 0 → tutarlılık 0 → tablo veri hash'leri (round kolonları hariç) birebir aynı. **Rollback provası** aynı kopyada: `rel-002-m2-rollback.sql` → Faz 1 şemasına drift 0 ve index/constraint/trigger fingerprint'leri M2 öncesiyle **birebir** aynı → `migrate deploy` M2'yi yeniden uyguladı.

**Aktif yerel DB 95 → 96**: M2 **77 ms**, ikinci deploy „No pending", `migrate status` güncel, drift 0, tutarlılık 0 satır, veri hash'leri değişmedi. Fingerprint: tablo 99 → 99, index 525 → 529 (+8 / −4), constraint 520 → 525 (+6 CHECK, 3 FK composite'e döndü, −1 CHECK), trigger 32 → 36; DB 22 655 459 → 22 786 531 bayt (+128 KB). Yerel API (main'deki Faz 1 kodu) M2 şemasıyla yeniden başlatıldı: `/health` 200, public uçlar 200, log'da hata yok — Faz 1 kodunun M2 ile çalıştığının (kod geri dönüşü) canlı kanıtı.

**Ölçek provası** (atılabilir PostgreSQL 16.6, tmpfs; Faz 1'in sentetik verisi: 200k request, 500k offer, 50k reveal, 20k thread; M1 backfill'i uygulanmış hâlde): preflight 0 → `migrate deploy` M2 **3,18 s** (wall 5,4 s); adım adım (BEGIN…ROLLBACK provası) toplam 2,9 s: doğrulama bloğu 1,08 s, `Offer_providerId_matchRoundId_key` 0,41 s, `Offer_id_matchRoundId_key` 0,30 s, round `id_requestId` 0,23 s, composite FK doğrulamaları 0,08–0,17 s, NOT NULL VALIDATE'ler ≤ 0,04 s. Tüm adımlar tek tx'te; ALTER/CREATE INDEX kilitleri commit'e kadar tutulur (≈3 s yazma kesintisi bu ölçekte). İkinci deploy „No pending", drift 0, tutarlılık 0, tablo veri hash'leri (round kolonları hariç) önce/sonra **birebir aynı**. Fingerprint: index 525 → 529, constraint 520 → 525, trigger 32 → 36. DB +29,5 MB (688 → 716 MB). Yeni index boyutları: `Offer_providerId_matchRoundId_key` 19 MB, `Offer_id_matchRoundId_key` 19 MB, round `id_requestId` 7,7 MB, scheduler index'leri 5,1 / 6,5 MB, `Offer_one_accepted_per_round` 1,5 MB, reveal/thread `requestId_idx` 1,1 MB / 456 kB.

**Rollback provası** (aynı ölçek DB'si): `rel-002-m2-rollback.sql` 1,2 s → `_prisma_migrations` 95, Faz 1 şemasına (`d55d92f1:prisma/schema.prisma`) drift **0** → `migrate deploy` M2'yi yeniden 4,0 s'de uyguladı, drift 0.

### 31.7 Performans (EXPLAIN ANALYZE, BUFFERS — ölçek DB'si, Prisma'nın ürettiği gerçek SQL)

| Sorgu | Plan | Süre |
|---|---|---|
| Keşif listesi, gerçekçi seçicilik (500 aday) | `ServiceRequest_categoryId_idx` → round'a `requestId_roundNumber` ile nested loop → `Offer_providerId_matchRoundId_key` anti-join; N+1 yok | 2,8 ms (eski `offers none` 0,8 ms) |
| Keşif listesi, kötü durum (80k APPROVED tek kategoride) | iki hash join + anti-join | 94 ms (eski 53 ms) |
| Sağlayıcı detayı (round + kendi teklifi) | PK + `ServiceRequestMatchRound_id_requestId_key` + `Offer_providerId_matchRoundId_key` | < 0,02 ms/sorgu |
| Teklif oluşturma tx okumaları | aynı üç index | < 0,02 ms/sorgu |
| Accept: current round + round rakipleri | PK / `id_requestId_key` / `Offer_matchRoundId_status_idx` ∧ `Offer_requestId_idx` | ≤ 0,02 ms |
| Contact reveal (current round) | `ContactRevealEvent_roundId_key` | 0,01 ms |
| Messaging: current thread / 50 thread'lik inbox zinciri | `MessageThread_roundId_key`; tek sorguda BitmapOr (50 × `requestId_roundNumber`) | 0,015 / 0,07 ms |
| Expiry taraması (150 vadesi gelmiş round, kararlı durum) | round ↔ APPROVED talep hash join | 38 ms (eski request index'iyle 0,13 ms) |
| Reminder taraması (kararlı durum) | aynı + `Offer_requestId_idx` anti-join | 34 ms |

Not: scheduler taramalarında planner, terminal round'ların geçmiş `expiresAt`'leri yüzünden „OPEN ∧ vadesi gelmiş" kümesini olduğundan büyük tahmin ediyor (bağımsızlık varsayımı) ve APPROVED talepleri hash'liyor; `(status, expiresAt, id)` ve partial index denemeleri planı değiştirmedi. Saatlik cron'da tick başına ~35 ms kabul edildi; APPROVED talep sayısı milyonlara çıkarsa aday taraması raw SQL'e (round index'inden LIMIT'li nested loop) alınır — Faz 3 öncesi zorunlu değil.

### 31.8 Bildirim dedupe

`roundDedupeSuffix(n)`: Round 1 → `''` (anahtar birebir eskisi), Round N ≥ 2 → `:r<N>`. Uygulandığı anahtarlar: `request-available:<req>:<provider>`, `request-expired-customer:<req>`, `request-expired-provider:<req>:<provider>`. `request-published` zaten `publishedAt` taşıyor. Retry parser (`parseRetrySource`): round-kapsamlı şablonlarda id'lerden sonra ya hiçbir şey (Round 1) ya da tek bir `r<N>` (N ≥ 2) kabul eder; `r1`, `r0`, `r01`, fazla segment reddedilir. Yeniden kurulum anahtarın round'una göre yapılır (`keyedRound`): available yalnız o round current ve OPEN iken, expired yalnız o round current ve EXPIRED iken; expired-provider teklifi `(providerId, matchRoundId)` ile bulunur. Reminder dedupe'u round claim'idir.

### 31.9 Direct showcase eşdeğerliği

Akış değişmedi: lead bağlanınca round DIRECT_SHOWCASE; sahibin teklifi talebi APPROVED yapar ve round yayınlanır (kapı açık kalır); RELEASE round'u MARKETPLACE yapar; KEEP_CLOSED ve terk edilmiş lead taraması round'u iptal eder. Accept/contact/message round-aware. `directShowcaseProviderId` kapısı korunur; başarısız direct → marketplace release yok (Faz 3).

### 31.10 Faz 3 ön koşulları ve kalan borçlar

Madde 1–5 Faz 3'te kapandı (§32); 6'nın müşteri tarafı kapandı (admin UI Faz 4/5); 7 borç olarak duruyor (§32.10); 8 staging/prod runbook'unda (§32.11).

1. `MatchRoundStatus += FAILED` (+ shape CHECK, terminal trigger listesi), `MatchRoundOpenedBy += SERVICE_ISSUE`, `MATCH_REVIEW` (M3) ve Round N+1'i açan geçiş (`openNextRound`): `matchedOfferId/matchedAt` NULL, `publishedAt` kapısı (§20), birth trigger'ın yerine açık insert.
2. Exclusion modeli ve `isProviderExcluded` — keşif filtresine, teklif tx'ine, accept'e ve fan-out'a aynı helper (bugün önceki round'un sağlayıcısı yeni round'u görür).
3. Tutarlılık scripti: Round ≥ 2'de talep projeksiyonu kontrolleri (zaman alanları zaten yalnız Round 1'de) FAILED/`MATCH_REVIEW` için genişletilmeli.
4. Unviewed-refund worker'ın FAILED round'a ait teklifleri iade etmemesi (§10 notu) — Faz 2'de değişmedi.
5. Tarihsel thread'lerin salt-okunur modu (`mode: READ_ONLY`, karar 4): bugün eski round thread'i 403 alır (yazma reddi sağlandı); okunabilir hâli Faz 3/5 UI'sıyla.
6. Müşteri teklif listesinde geçmiş round'lar bölümü ve admin round zaman çizelgesi UI'ı (API: `GET /service-requests/:id/rounds` hazır).
7. Scheduler aday taraması ölçek borcu (§31.7).
8. Staging/production: preflight (M2 bölümü 0) → backup → restore-rehearsal → `migrate deploy` (96) → drift → tutarlılık; API/web/admin **aynı deploy'da** (web formu tarihleri göndermeden API 400 verir).

### 31.11 Test kapısı (yerel)

- API tam suite (`vitest run`, 214 dosya): 4676/4683 geçti; kalan 7 hata Faz 2'nin bilinçli sonuçlarıydı (fixture'ların round'u hizalamaması, tarihsiz teklif gövdesi, yeni route'un RBAC haritası, index adı, retry sonrası hata kodu sınıflandırması) ve düzeltildi; düzeltilen + ilgili 17 dosya yeniden: 293/293.
- Yeni: `match-round-faz2.spec.ts` 31 test (ikinci tur güvenliği, stale-round 409'ları, takvim kodları, eşzamanlılık: aynı sağlayıcı çift teklif, offer-vs-accept, accept-vs-cancel, accept-vs-reject, expiry-vs-accept, reminder claim, thread çift açılış, reveal çift kayıt; DB invariant'ları) — iki ayrı koşuda yeşil, sleep/retry hilesi yok. `match-round-core.spec.ts` 20 test (her case sonrası tutarlılık scripti). `match-round-migration.spec.ts` 4 test (M1 + M2 yeniden-backfill/enforce + ihlalde tam geri alma).
- Web 462, shared (takvim 9 dahil), typecheck/lint/build, `version:check`, ops scriptleri 54.
- E2E Chromium (hedefli, 14 spec dosyası): 77/77 — pazar yeri create→teklif→accept→mesaj→complete, iptal/iade, contact, mesajlaşma, vitrin direct lead, review, teklif geri çekme, admin talep/teklif ve lifecycle onayları, teklif formu takvim doğrulaması (yeni).

---

## 32. Faz 3 uygulama sonucu ve runbook

Baseline `main@1ffd4bb0`, yerel DB 96 migration, release `v0.1.0`. PR: „REL-002 Faz 3: add customer service-issue reopen and provider exclusion". Özellik bayrak arkasında, **varsayılan kapalı** (`OperationsSettings.serviceIssueReportingEnabled = false`).

### 32.1 Gerçek M3 şeması

Migration `20261012090000_add_service_issue_reopen_core` (§5.1). Tek dosya, tek transaction, backfill yok.

| Nesne | Tür | Anlamı |
|---|---|---|
| `MatchRoundStatus.FAILED`, `MatchRoundOpenedBy.SERVICE_ISSUE/ADMIN`, `ServiceRequestStatus.MATCH_REVIEW`, `NumberedEntityType.SERVICE_INCIDENT`, `AdminPermission.SERVICE_ISSUE_SETTING_WRITE` | enum değeri (`ADD VALUE IF NOT EXISTS`) | Faz 3 durumları; ADMIN Faz 5 için rezerve |
| `ServiceIssueReason`, `ProviderIncidentStatus`, `ServiceIssueEligibilityBasis` | yeni enum | §2.1 |
| `ProviderServiceIncident` | tablo | uniq: `incidentNumber`, `roundId`, `offerId`, `idempotencyKey`, `(id, roundId)`, `(id, requestId, providerId)`; index: `(providerId, status)`, `(status, reportedAt)`, `(customerUserId, reportedAt)`, `(requestId)`; FK: provider, request, `(roundId, requestId) → round`, `(offerId, roundId) → Offer(id, matchRoundId)`, customer/respondedBy/reviewedBy → User |
| `ServiceRequestProviderExclusion` | tablo | uniq `(requestId, providerId)`, `incidentId`; index `(providerId)`; FK: request, provider, `(sourceRoundId, requestId) → round`, `(incidentId, requestId, providerId) → incident` |
| `ServiceRequestMatchRound.failureIncidentId` | kolon (nullable, unique) | FK `(failureIncidentId, id) → incident(id, roundId)` |
| `OperationsSettings.serviceIssueReportingEnabled` | kolon, default false | bayrak (metadata-only `ADD COLUMN`) |
| `Incident_note_rules` | CHECK | not trim'li, ≤ 1000; OTHER ve PROVIDER_CANCELLED_BEFORE_START için ≥ 20 |
| `Incident_eligibility_shape` | CHECK | `reason = PROVIDER_CANCELLED_BEFORE_START ⇔ basis = PROVIDER_CANCELLATION`; iki taahhüt günü de dolu, end ≥ start |
| `Incident_response_shape` | CHECK | yanıt/zaman/yazar üçü birlikte; PROVIDER_RESPONDED ⇒ yanıt var |
| `Incident_decision_shape` | CHECK | CONFIRMED/DISMISSED ⇔ reviewedAt + reviewedById; karar yoksa reviewNote yok |
| `MatchRound_failed_shape` | CHECK | FAILED: kazanan (offer, provider, matchedAt) + failedAt + failureIncidentId; completed/cancelled/expired NULL |
| `MatchRound_failure_incident_only_when_failed` | CHECK | `failureIncidentId` ⇔ FAILED |
| `MatchRound_terminal_status_immutable` | trigger (güncellendi) | COMPLETED/CANCELLED/EXPIRED/**FAILED** terminal; `failureIncidentId` bir kez yazılır; artık `UPDATE OF status, failureIncidentId` |
| `ServiceRequestProviderExclusion_append_only` | trigger | UPDATE/DELETE reddedilir |
| `ProviderServiceIncident_no_delete` | trigger | DELETE reddedilir (Faz 4 yanıt/karar kolonlarını günceller) |
| `Offer_round_open_guard` | trigger (BEFORE INSERT) | dışlanan sağlayıcı → `PROVIDER_EXCLUDED: …`; teklifin round'u talebin current OPEN round'u değil → `OFFER_ROUND_CLOSED: …` (SQLSTATE 23514) |

Yeni değerler migration içinde enum literal olarak kullanılmaz (`"status"::text = 'FAILED'`), bu yüzden M3 iki dosyaya bölünmedi (§5.1).

**Trigger sırası:** PostgreSQL aynı zamanlamalı satır trigger'larını ad sırasıyla çalıştırır; `Offer_round_link_default` (M2) < `Offer_round_open_guard` (M3). Önce boş `matchRoundId` talebin current round'uyla dolar, sonra guard o round'u denetler. Test: `service-issue.spec.ts` „the database refuses an excluded provider's offer and an offer into a closed round" — raw INSERT'te round'suz teklif Round 2'ye bağlanır ve kabul edilir; dışlanan sağlayıcının ve kapalı round'un INSERT'i reddedilir. Servis katmanı trigger mesajını `offerInsertGuardException` ile 409 `PROVIDER_EXCLUDED` / `OFFER_ROUND_CLOSED`'a çevirir (uygulama zaten tx içinde önce kendisi reddeder).

### 32.2 Durum makinesi (gerçek)

```
Round:   OPEN ─accept─► MATCHED ─service issue─► FAILED (terminal)
                           ├─complete─► COMPLETED
                           └─staff cancel─► CANCELLED
Request (service issue, aynı tx):
  N < 3, round.source MARKETPLACE      → APPROVED, Round N+1 OPEN, publishedAt=now, fan-out
  N < 3, round.source DIRECT_SHOWCASE  → SUBMITTED, Round N+1 OPEN publishedAt NULL
                                         (auto-publish açık + telefon kapısı açık → publishRequestInTransaction: APPROVED)
  N ≥ 3                                → MATCH_REVIEW, currentRoundId = FAILED Round N, yeni round yok
MATCH_REVIEW → müşteri/personel iptali → CANCELLED (current round FAILED kalır; teklif/kredi hareketi yok)
```

Round N+1: id `mr<N>_<requestId>`, `source MARKETPLACE`, `openedBy SERVICE_ISSUE`, `openedAt = now`, `expiresAt = publishedAt + 14g`, `reminderSentAt NULL` (`openNextRound`, `match-round-transitions.ts`). `request.approvedAt` reopen'da yazılmaz (yalnız auto-publish yolu, kanonik `publishRequestInTransaction` olarak yazar; moderasyon onayı da her zamanki gibi yazar). `MAX_AUTO_MATCH_ROUNDS = 3` (`limits.json` `maxAutoMatchRounds`).

### 32.3 API

`POST /service-requests/:id/service-issue` (`ServiceIssuesModule`), body `{ roundId, reason, note?, idempotencyKey (uuid) }`; `forbidNonWhitelisted` tarih alanını reddeder. Yanıt §7. Hata kodları:

| Kod | HTTP |
|---|---|
| (bayrak kapalı / başkasının / olmayan talep) | 404 |
| (müşteri olmayan rol) | 403 (RolesGuard) |
| `IDEMPOTENCY_KEY_REUSED`, `ROUND_ALREADY_FAILED`, `REQUEST_NOT_MATCHED`, `ROUND_CHANGED`, `MATCH_INCONSISTENT`, `SERVICE_ISSUE_REQUIRES_SUPPORT`, `SERVICE_ISSUE_REASON_NOT_YET_AVAILABLE` (+`opensOn`), `CONCURRENT_MODIFICATION` | 409 |
| `SERVICE_ISSUE_NOTE_REQUIRED` (+`minLength`), `SERVICE_ISSUE_NOTE_TOO_LONG` | 400 |
| `SERVICE_ISSUE_RATE_LIMITED` / throttler | 429 |

`GET /service-requests/my/:id` (sahip) ek alanlar: `currentRound {id, roundNumber, status, openedAt, publishedAt, expiresAt, matchedAt, failedAt}`, `rounds[] {id, roundNumber, status, source, openedBy, isCurrent, tarihler, provider {businessName} | null, offerId, issue {incidentNumber, reason, reportedAt, status:'RECORDED'} | null, messageThreadId}`, `serviceIssue {canReport, roundId, availableReasons, reasons[{reason, available, opensOn}], nextOpensOn, unavailableReason (FEATURE_DISABLED|NOT_MATCHED|SCHEDULE_MISSING|NOT_YET_AVAILABLE), supportOnly, maxAutoRoundsReached, consequence (REOPEN|ADMIN_REVIEW)}`. Sağlayıcı yanıtı, `reviewNote`, ham not müşteriye dönmez. Round id'leri yalnız bu sahip yanıtında (stale guard için) bulunur; `match-round-core.spec.ts` başka hiçbir yanıtın round id taşımadığını doğrular.

Admin `GET /service-requests/:id/rounds` (REQUESTS_READ): round başına `failedAt`, `failureIncident {id, incidentNumber, providerId, offerId, reason, customerNote (ham), eligibilityBasis, promised*, status, reportedAt}` ve talebin `exclusions[]`. Sağlayıcı `GET /providers/:id/offers/:offerId`: `matchOutcome (ACTIVE|COMPLETED|FAILED|CANCELLED|null)`, `matchFailure {failedAt, incidentNumber, reason}`; FAILED'da `acceptedWorkScope` null. Vitrin lead (`GET /providers/:id/showcase/leads[/:leadId]`): lead'in işletmesi dışlandıysa `request.status = 'MATCH_ENDED'`, `matchEnded: true` — Round 2 durumu, yeni sağlayıcı ve teklif sayısı sızmaz.

### 32.4 Eligibility matrisi (uygulandı)

`service-issues/service-issue-eligibility.ts` (saf fonksiyon, sunucu `now`, `todayIsoDay` İstanbul). §6.3 matrisi aynen; `opensOn` = ilgili günün ertesi günü; `nextOpensOn` = açılmamış sebeplerin en erkeni. Takvimsiz (legacy) eşleşmede hiçbir sebep yok, `supportOnly`, UI destek bağlantısı (`/destek/yeni`). Birim testleri: İstanbul 23:59:59 / 00:00 (20:59:59Z / 21:00Z), 23:30Z kayması, tek günlük iş, end kapısı, legacy üç varyant.

### 32.5 Issue transaction'ı ve idempotency

`runSerializable` label `serviceRequests.reportServiceIssue`, sıra §8 ile aynı; idempotency kontrolü durum guard'larından **önce** (replay, kendi commit'inin taşıdığı talebe de cevap verir). Aynı anahtar + aynı payload (customer, request, round, reason, normalize not) → 200 `replayed: true`, bildirim yeniden kuyruğa girmez. P2002 `idempotencyKey` yarışı → işlem bir kez yeniden çalıştırılır ve replay döner; P2002 `roundId/offerId` → 409 `ROUND_ALREADY_FAILED`. Her koşullu yazım count === 1 (round `transitionRoundToFailed` → `MATCH_ROUND_STATE_CHANGED`; request `updateMany` → `ROUND_CHANGED`). **Kredi tablolarına hiç yazılmaz** — test: issue öncesi/sonrası `ProviderCreditTransaction` sayısı eşit.

### 32.6 Dışlama zorlama noktaları (tek tanım: `common/provider-request-matching.ts`)

| Yüzey | Uygulama |
|---|---|
| Keşif listesi | `notExcludedFromRequestFilter(providerId)` |
| Talep detayı | `providerExclusions` satırı → 404 |
| `ensureProviderCanSeeRequest` (teklif hızlı kontrolü + rapor yolu) | `isProviderExcluded` → 404 |
| `createOfferRecord` (Serializable tx) | `isProviderExcluded(tx, …)` → 404; trigger hatası → 409 |
| Publish fan-out + gönderim anı yeniden kurulum | `findMatchingProviders` içinde `providerNotExcludedFilter(requestId)` |
| Accept | `isProviderExcluded(tx, …)` → 409 `PROVIDER_EXCLUDED` (defense-in-depth) |
| DB | `Offer_round_open_guard` |
| Contact / mesaj | projeksiyon NULL → `currentMatchedOfferId` null → 404/salt-okunur |
| Vitrin lead inbox | `MATCH_ENDED` projeksiyonu |

**Salt-okunur tarihsel thread (karar 4):** okuma (`GET threads/:id`, `/messages`) round'u FAILED/COMPLETED/CANCELLED olan thread'de orijinal katılımcılara açık (`mode: 'READ_ONLY'`, `closedReason`, `unreadCount: 0`); yazma ve **okundu işareti** 403 `THREAD_READ_ONLY`. Okundu işaretini engelleme gerekçesi: salt-okunur semantik = mutasyon yok; rozet zaten yalnız aktif thread'leri sayıyor (Faz 2), dolayısıyla sönmeyen rozet oluşmaz. Web: thread sayfası read-only'de `markThreadRead` çağırmaz, polling yapmaz, composer yerine bilgi notu ve „Kapandı · salt okunur" etiketi; liste satırında „Kapandı". Yeni sağlayıcı eski thread'i `participantWhere` ile 404 alır. Bugünkü COMPLETED/CANCELLED thread'leri de aynı davranışa geçti (önceden okuma da 403'tü).

### 32.7 Kredi, bildirimler, bayrak, güvenlik

- **Kredi:** §10 (uygulandı). `isFailedMatchWinner` = `ServiceRequestMatchRound(matchedOfferId, status FAILED)` probe'u (unique index). Manuel iade, worker ve iptal aynı barikattan geçer; worker predicate'i FAILED kazananı listelemez; FAILED turun rakipleri normal 48 saat semantiğinde kalır (test).
- **Bildirimler (outbox, aynı tx, `ServiceIssueOutbox`, lifecycle tick süpürür):** `service-issue-recorded:<incidentId>` (müşteri), `request-reopened:<newRoundId>` (müşteri, yeni tur varsa; gönderim anında tur hâlâ current OPEN değilse üretilmez), `request-match-review:<incidentId>` (müşteri, Round 3; talep MATCH_REVIEW değilse üretilmez), `provider-incident-opened:<incidentId>` (başarısız sağlayıcı; müşteri adı/telefonu/e-postası/adresi yok, not `maskContactDetailsInNote` ile maskeli, kredi ifadesi yok), `provider-incident-new:<incidentId>` (destek kutusu; not yok). Round 2 yayını mevcut publish outbox'ı (`request-published:<req>:<ISO>`, `request-available:<req>:<provider>:r2`). Hepsi retry tablosunda (`RETRY_DEDUPE_PREFIXES`), REQ-UX-007 shell'i.
- **Bayrak:** `ServiceIssueSettingsService` (fail-closed), `GET/PUT /operations-settings/service-issues` (`OPERATIONS_SETTINGS_READ` / `SERVICE_ISSUE_SETTING_WRITE`), `OperationsSettingsChange` audit'i, admin „Operasyon ayarları" kartı (iki yön için onay kanıtı `operations.service-issues-enable/-disable`). Kapalı: endpoint 404, `serviceIssue.unavailableReason = FEATURE_DISABLED`, UI'da CTA yok. Kapatmak açılmış turları geri almaz.
- **Güvenlik/suistimal:** yalnız sahip müşteri (404 sızıntısız); istemci zamanı yok; not trim+collapse, ≤ 1000; sağlayıcı projeksiyonunda iletişim maskesi; throttler (kullanıcı başına deneme) + kalıcı başarılı-bildirim bütçesi (5/10 dk); 3 otomatik tur; idempotency; REPORTED tek başına hiçbir yaptırım üretmez (strike/askı yok).

### 32.8 Migration provası, uygulama, geri dönüş

**Preflight** (aktif yerel DB, salt-okunur, `rel-002-preflight.sql` M3 bölümü): `request_with_several_rounds = 0`, `round_with_failed_at = 0`; bilgi: MATCHED 2'nin ikisinin de kabul edilen teklifinde taahhüt günü yok (bayrak açılınca bu iki müşteri destek yoluna düşer), APPROVED 9, Offer 14. Baseline tutarlılık scripti (`1ffd4bb0`) 0 satır. (Yeni tutarlılık scripti M3 tablolarını okur; M3 öncesi DB'de baseline'ınki kullanılır.)

**Yedek** (API durdurulmuşken): `~/Backups/taktic/db/taktic-db-20261011T170945Z-pre-rel002-m3-1ffd4bb0.dump`, sha256 `d2971299cf8ba247c5bf14be459ea33e59349dc471a45f53c5da71efc71641e3`, 650 423 bayt (1134 TOC, 99 tablo, 96 migration). `restore-rehearsal.sh` geçti (izole network, tmpfs; 99 tablo / 1227 satır manifest ile birebir).

**Deploy provası** (dump atılabilir PostgreSQL 16.6'ya `pg_restore`): `migrate deploy` M3 **23 ms** (wall 0,81 s) → ikinci deploy „No pending" → drift 0 → tutarlılık 0 → tablo veri hash'leri (yeni kolonlar hariç, 98 tablo) birebir aynı. **Rollback provası** aynı kopyada: kullanılmış durumda script reddeder („forward-fix only"; ikinci round eklenerek denendi), kullanılmamışta `rel-002-m3-rollback.sql` 0,08 s → fingerprint M2 ile birebir (tablo 99, index 529, constraint 525, trigger 36, migration 96), Faz 2 şemasına drift = yalnız bırakılan 5 enum değişikliği → `migrate deploy` M3'ü yeniden uyguladı, drift 0. İlk provada `ADD VALUE` (IF NOT EXISTS'siz) rollback sonrası yeniden deploy'u 42710 ile düşürdü; migration `IF NOT EXISTS`'e çekildi ve döngü yeniden prova edildi.

**Aktif yerel DB 96 → 97**: M3 uygulandı (47 ms), ikinci deploy „No pending", `migrate status` güncel, drift 0, tutarlılık 0, veri hash'leri değişmedi, bayrak `false`. (Geliştirme sırasında dışlama tablosuna `providerId` index'i eklenince yerel M3 bir kez prova edilmiş rollback ile geri alınıp son dosyayla yeniden uygulandı — rollback'in canlı kanıtı.) Fingerprint: tablo 99 → 101, index 529 → 545 (+16), constraint 525 → 545 (+20: 4 incident CHECK + 2 round CHECK + 2 pkey + 12 FK), trigger 36 → 39 (+3; terminal trigger yeniden yaratıldı); DB +212 KB. Yerel API (main'deki Faz 2 kodu) M3 şemasıyla yeniden başlatıldı: `/health` 200, log'da hata yok — Faz 2 kodunun M3 ile çalıştığının (kod geri dönüşü) canlı kanıtı.

**Ölçek provası** (atılabilir PostgreSQL 16.6, tmpfs; 96 migration + sentetik 200k request, 500k offer, 200k round, 3000 sağlayıcı; 80k APPROVED/20k MATCHED/60k COMPLETED/20k EXPIRED/20k SUBMITTED): baseline tutarlılık 0 → `migrate deploy` M3 **196 ms** (wall 0,89 s; ilk ölçümde 102 ms) → „No pending", drift 0, tutarlılık 0, veri hash'leri önce/sonra birebir. En ağır adımlar round tablosundaki iki yeni CHECK'in doğrulaması (ACCESS EXCLUSIVE, tam tarama) ve Offer'a trigger eklenmesi (SHARE ROW EXCLUSIVE, anlık); yeni tablolar boş. Bu ölçekte yazma kesintisi ~0,2 s.

**Geri dönüş sınırı (gerçek):** bayrak açılmadan önce geri dönüş mümkün (kod revert; gerekirse `rel-002-m3-rollback.sql`, sonra gerekirse M2 rollback). Bayrak açılıp ilk gerçek Round 2 oluştuğunda **geriye şema dönüşü yoktur** — M3 ve M2 rollback'leri kendilerini reddeder; yalnız ileri-düzeltme (bayrağı kapat, kodda düzelt).

### 32.9 Admin minimum

Talep listesinde `MATCH_REVIEW` filtresi ve etiketi („Eşleşme İncelemesi"), detayda durum açıklaması; round/incident/dışlama verisi `GET /service-requests/:id/rounds`'ta (UI zaman çizelgesi Faz 4/5). „Yeni tur aç" yok (Faz 5). İzin kataloğu 87 → 88.

### 32.10 Performans (EXPLAIN ANALYZE, BUFFERS — ölçek DB'si + 2000 sentetik FAILED round/dışlama/Round 2, Prisma'nın ürettiği SQL)

| Sorgu | Plan | Süre |
|---|---|---|
| Keşif listesi, kötü durum (82k APPROVED tek kategori, take 500) | status index → round `requestId_roundNumber` → `Offer_matchRoundId_status_idx` anti-join → `ServiceRequestProviderExclusion_providerId_idx` (bitmap, provider başına bir kez) | 25–39 ms (Faz 2 kötü durum 94 ms, take'siz) |
| Fan-out kitlesi (sağlayıcı tarafı anti-join) | `…_requestId_providerId_key` index-only | < 0,01 ms |
| `isProviderExcluded` | unique probe | 0,01 ms |
| Müşteri detayı `rounds[]` (5 sorgu) | PK / `requestId_roundNumber` / `Offer_id_matchRoundId_key` / incident composite unique / `MessageThread_roundId_key` | her biri ≤ 0,02 ms |
| `MATCH_REVIEW` filtresi | `ServiceRequest_status_idx` | 0,01 ms |
| Incident idempotency / round / müşteri bütçesi | `idempotencyKey_key` / `roundId_key` / `customerUserId_reportedAt_idx` index-only | 0,008 / 0,008 / 0,14 ms (2000 satır) |
| FAILED kazanan iade barikatı | `ServiceRequestMatchRound_matchedOfferId_key` | 0,01 ms |
| Unviewed-refund aday taraması (sentetik kötü durum: 300k aday aynı anda uygun) | parallel seq scan + top-N; FAILED-kazanan anti-join 213 index probe | 85–95 ms (aynı veride Faz 3 koşulsuz 44–54 ms) |

İlk ölçümde dışlama anti-join'i provider index'i olmadığından dışlama tablosunu seq scan ediyordu (tablo büyüdükçe lineer) — `@@index([providerId])` M3'e eklendi (küçük, güvenli düzeltme). Refund taraması farkı yalnız gerçek dışı „300k uygun aday" verisinde; gerçek aday kümesi (görülmemiş + 48 saat dolmuş) küçüktür. **Faz 2 borcu** (expiry/reminder aday taraması ~35 ms/tick) bu PR'a alınmadı: küçük ve güvenli bir index değişikliği değil (planner tahmin sorunu, raw SQL aday taraması gerekir), borç olarak duruyor.

### 32.11 Staging/production runbook (bu PR'da dokunulmadı)

1. `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/ops/rel-002-preflight.sql` → M3 bölümünde integrity 0; `matched_without_schedule` destek ekibine bilgi olarak iletilir.
2. Baseline (`1ffd4bb0`) tutarlılık scripti 0 satır.
3. API durdur → `backup-db.sh` → `restore-rehearsal.sh` → `migrate deploy` (97) → ikinci deploy „No pending" → drift 0 → yeni tutarlılık scripti 0.
4. API/web/admin aynı deploy'da (bayrak kapalı; davranış farkı yalnız salt-okunur tarihsel thread'ler ve admin'deki yeni kart).
5. Bayrak açma ayrı onayla: yerel kabul testi → staging'de açılış → doğrulama. **Bayrak açıldıktan ve ilk Round 2 oluştuktan sonra geri dönüş yalnız ileri-düzeltmedir** (§32.8).

### 32.12 Test kapısı (yerel)

- Yeni: `service-issue.spec.ts` 19 entegrasyon testi (bayrak, sahiplik, matris, legacy, stale/istemci tarihi, idempotency + iki yarış, issue↔complete, issue↔staff cancel, Round 1→2 kritik akış, DB backstop/trigger sırası/kalıcılık, Round 3→MATCH_REVIEW + iptal, manuel iade bloğu, worker, vitrin → pazar (auto-publish açık/kapalı)) — her case sonunda tutarlılık scripti 0; `service-issue-eligibility.spec.ts` 13 birim testi.
- Güncellenen: `match-round-core` (sahip yanıtındaki round id istisnası), `match-round-faz2` (trigger nedeniyle fixture'lar UPDATE ile kuruluyor), `match-round-migration` (tutarlılık scripti öncesi zincir sona deploy edilir), `admin-rbac-route-map` (88 izin), e-posta render/dark-mode (5 şablon), admin `confirmation-proof` ve `system-screens`.
- E2E (Chromium, hedefli): `service-issue.spec.ts` 6/6 — pazar yeri A→Round 2→B, vitrin → moderasyon, 3 tur → MATCH_REVIEW, salt-okunur thread, takvimsiz destek yolu, bayrak kapalı. WebKit projesine eklendi.

### 32.13 Faz 4 ön koşulları ve kalan borçlar

1. M4: `ProviderIncidentAdjudication` (append-only), `ProviderReliabilityReview`, confirmed partial index, `PROVIDER_INCIDENTS_READ/DECIDE`, `PROVIDER_RELIABILITY_REVIEW` izinleri; incident kolonları (yanıt/karar) ve CHECK'leri hazır.
2. Sağlayıcı incident API/UI (yanıt penceresi 72 saat uyarısı), admin kuyruk/detay/karar (ConfirmGate + domain audit), strike sayımı (effective outcome).
3. Admin talep detayında tur zaman çizelgesi UI'ı ve incident bağlantısı (API hazır).
4. MATCH_REVIEW için admin „Yeni tur aç" (Faz 5; `MatchRoundOpenedBy.ADMIN` hazır) ve kuyruk hücresi.
5. Yerelde 2 takvimsiz MATCHED eşleşme: bayrak açılınca destek yoluna düşer (veri düzeltmesi yapılmadı, karar 1).
6. Borçlar: expiry/reminder aday taraması (§31.7); unviewed-refund taramasının gerçekçi olmayan kötü durumda 2× maliyeti (izlenecek); `request.approvedAt`'in yalnız auto-publish reopen'da tazelenmesi (legacy alan; okuyucusu yok).

---

## 33. Faz 4 uygulama sonucu ve runbook

Baseline `main@acaf9902`, yerel DB 97 migration, release `v0.1.0`. PR: „REL-002 Faz 4: add incident adjudication and provider reliability". Faz 3 bayrağı (`serviceIssueReportingEnabled`) **kapalı kaldı**; Faz 4 yalnız var olan incident'ları işler. Bu bölüm, §2.4.1, §2.5, §14.1, §15–§17'deki taslağın gerçek hâlidir; ayrıldığı yerler aşağıda belirtilmiştir (kullanıcının 2026-10-11 Faz 4 sözleşmesi taslağa üstündür: izin adları, uç noktalar, `INITIAL` adı).

### 33.1 Gerçek M4 şeması

Migration `20261012120000_add_incident_adjudication_reliability`. Tek dosya, tek transaction, backfill yok (bugün hiçbir incident karar almamış; yeni CHECK'ler mevcut satırlarda kendiliğinden doğru). İki migration'a bölünmedi: yeni `AdminPermission` değerleri migration içinde kullanılmaz (`ADD VALUE IF NOT EXISTS`, M3 deseni); üç yeni enum tipi bu transaction'da yaratılır, kısmi index yüklemleri onları doğrudan kullanabilir.

| Nesne | Tür | Anlamı |
|---|---|---|
| `ProviderIncidentDecision` (CONFIRMED, DISMISSED), `ProviderIncidentAdjudicationKind` (INITIAL, CORRECTION), `ProviderReliabilityReviewStatus` (OPEN, ACKNOWLEDGED, RESOLVED) | yeni enum | |
| `AdminPermission` += `SERVICE_INCIDENTS_READ`, `SERVICE_INCIDENTS_ADJUDICATE`, `SERVICE_INCIDENTS_CORRECT`, `PROVIDER_RELIABILITY_READ`, `PROVIDER_RELIABILITY_MANAGE` | enum değeri (`IF NOT EXISTS`) | izin kataloğu 88 → 93 |
| `ProviderIncidentAdjudication` | tablo | `id, incidentId, sequence, kind, decision, rationale, decidedByAdminId, supersedesAdjudicationId?, createdAt`; uniq `(incidentId, sequence)`, `(id, incidentId)`, `supersedesAdjudicationId`; index `decidedByAdminId`; FK incident, user, **composite** `(supersedesAdjudicationId, incidentId) → (id, incidentId)` (zincir incident dışına çıkamaz) |
| `ProviderServiceIncident.effectiveAdjudicationId` | kolon (nullable, unique) | zincirin başı; **composite** FK `(effectiveAdjudicationId, id) → adjudication(id, incidentId)` (baş, aynı incident'ın kararı) |
| `ProviderServiceIncident` ek index'ler | `(providerId, reportedAt)`, uniq `(id, providerId)` (review FK hedefi), kısmi `ProviderServiceIncident_confirmed_recent_idx (reportedAt, providerId) WHERE status = 'CONFIRMED'` | 90 gün penceresi ve güvenilirlik kuyruğu |
| `ProviderReliabilityReview` | tablo | `id, providerId, status, triggerIncidentId?, openedAt, openedBySystem, assignedAdminId?, acknowledgedAt?, acknowledgedById?, resolvedAt?, resolvedById?, note?, createdAt, updatedAt`; index `(providerId, createdAt)`, `(status, openedAt)`; FK provider, **composite** `(triggerIncidentId, providerId) → incident(id, providerId)`, üç User FK. Sayı saklamaz. |
| `ProviderReliabilityReview_one_unresolved_per_provider` | kısmi unique `(providerId) WHERE status IN ('OPEN','ACKNOWLEDGED')` | sağlayıcı başına tek çözülmemiş inceleme — idempotent açılış |
| `Adjudication_kind_shape` | CHECK | `sequence ≥ 1`; `INITIAL ⇔ sequence = 1 ⇔ supersedes IS NULL` (incident başına tek INITIAL) |
| `Adjudication_rationale_rules` | CHECK | `rationale = btrim(rationale)`, 10..2000 |
| `ProviderIncidentAdjudication_chain` | trigger (BEFORE INSERT) | INITIAL yalnız başı olmayan incident'a; CORRECTION yalnız incident'ın **güncel başını** ve `sequence = önceki + 1` ile (`INCIDENT_ALREADY_ADJUDICATED:` / `INCIDENT_ADJUDICATION_CHANGED:` mesajı) |
| `ProviderIncidentAdjudication_append_only` | trigger | UPDATE/DELETE reddedilir |
| `Incident_decided_has_head` | CHECK | `status ∈ {CONFIRMED, DISMISSED} ⇔ effectiveAdjudicationId IS NOT NULL` |
| `Incident_response_rules` | CHECK | yanıt trim'li, 10..2000; yanıtı olan karar almamış incident `REPORTED` olamaz |
| `ProviderServiceIncident_decision_projection` | trigger (BEFORE UPDATE) | baş NULL'a dönemez; ilk baş INITIAL, sonraki her baş bir öncekini supersede eder; `status`/`reviewedById`/`reviewedAt`/`reviewNote` başın kararı/yazarı/zamanı/gerekçesiyle **eşit**; yanıt bir kez yazılır ve karar sonrası yazılamaz (`INCIDENT_RESPONSE_ALREADY_SUBMITTED:` / `INCIDENT_ALREADY_ADJUDICATED:`) |
| `ReliabilityReview_shape` | CHECK | her adımın kim+ne zaman çifti; OPEN'da ack/resolve yok; ACKNOWLEDGED'da ack var; RESOLVED ⇔ resolvedAt+resolvedById+not (trim, 10..2000) |
| `ProviderReliabilityReview_lifecycle` | trigger | OPEN → ACKNOWLEDGED → RESOLVED (veya OPEN → RESOLVED), geri dönüş yok; RESOLVED final; açılış alanları ve ack damgası değişmez; DELETE yok |

Taslaktan farklar: (1) taslaktaki „incident satırı ilk kararın kopyası, bir daha değişmez" yerine incident'ın `status`/`reviewed*` kolonları **geçerli kararın** projeksiyonudur ve trigger ile başa eşit tutulur — otorite yine adjudication tablosudur, eski adjudication hiç değişmez; kuyruk ve kısmi index projeksiyonu okuyabilir. (2) „en yüksek sequence" yerine açık baş işaretçisi (`effectiveAdjudicationId`) + CAS: „latest" hiçbir yerde `createdAt` sıralaması değildir. (3) `idempotencyKey` yok: ilk karar ikinci kez 409, düzeltme `expectedEffectiveAdjudicationId` ile optimistik. (4) Review taslaktaki „karar satırı" değil, yaşam döngülü iş akışı satırıdır (kullanıcı sözleşmesi §4).

### 33.2 Effective decision (tek tanım)

`effectiveIncidentDecision(client, incidentId)` (`service-incidents/incident-reliability.ts`): adjudication yok → `PENDING`; yoksa `effectiveAdjudicationId`'nin gösterdiği satır. Zincir doğrusal ve DB'de garantili: `(incidentId, sequence)` unique + `supersedes` unique + insert trigger'ı (yalnız güncel baş supersede edilebilir) + incident trigger'ı (baş yalnız ileri ve yalnız supersede eden satıra taşınır). Tutarlılık scriptinin 11. kontrolü bunu veri üzerinde de doğrular (baş = son halka, 1..n boşluksuz, karar = projeksiyon).

### 33.3 Karar transaction'ları

`AdminServiceIncidentsService.decide` (Serializable, `runSerializable`): incident oku → plan (INITIAL: baş NULL olmalı; CORRECTION: SUPER_ADMIN, baş = `expectedEffectiveAdjudicationId`, karar farklı) → adjudication INSERT → **CAS** `updateMany WHERE id AND effectiveAdjudicationId = okunan baş` (count 1 değilse 409) → projeksiyon (`status`, `reviewed*`) → sağlayıcı bildirimi (outbox) → CONFIRMED ise `ensureReliabilityReview` → commit sonrası güvenilirlik özeti yanıta eklenir. Hiçbir yolda: round, dışlama, kredi tabloları, eski eşleşme, talebin güncel turu ve sağlayıcı durumu yazılmaz (test: `snapshot` öncesi/sonrası birebir, `ProviderCreditTransaction` sayısı sabit).

Yarışlar: iki ilk karar → biri 201, diğeri 409 `INCIDENT_ALREADY_ADJUDICATED`; aynı başa iki düzeltme → biri 201, diğeri 409 `INCIDENT_ADJUDICATION_CHANGED` (SSI 40001 → P2034 → yeniden deneme yeni başı okur; ya da `(incidentId, sequence)` P2002; ya da trigger mesajı — üçü de aynı koda çevrilir). Not: transaction içindeki her okuma/yazma model sorgusudur; ham sorgunun serileştirme hatası P2010 olarak gelir ve `runSerializable` onu (bilinçli olarak, `campaigns.service.ts` notu) yeniden denemez — bu yüzden 90 gün sayımı ve review açılışı tx içinde Prisma `count` ve `createMany({ skipDuplicates })` ile yapılır (`ON CONFLICT DO NOTHING`, kısmi unique'i de soğurur).

Düzeltme denetimi: düzeltme satırının kendisi audit'tir — yazan SUPER_ADMIN, yeni karar, zorunlu gerekçe, `supersedesAdjudicationId` (önceki geçerli karar; önceki kararın değeri zincirden okunur ve admin detayında „önceki → yeni" olarak gösterilir), zaman; satır append-only. Ek olarak servis bir log satırı yazar (`CORRECTION by SUPER_ADMIN …: CONFIRMED (id) → DISMISSED (id)`). İlk karar da aynı tablodadır. Review açılış/üstlenme/sonuçlandırma damgaları review satırındadır (her biri bir kez, trigger korumalı). Sağlayıcı yanıtı incident satırındadır (`providerRespondedById`, bir kez). PII audit'e yazılmaz (gerekçe/notlar personel metnidir).

### 33.4 Sağlayıcı yanıtı ve 72 saat

`POST /providers/:providerId/incidents/:incidentId/response` (`AuthGuard + RolesGuard(PROVIDER) + ProviderAccessGuard`; SUPER_ADMIN dahil personel yanıt veremez — yanıt sağlayıcının beyanıdır). Metin trim+collapse, 10..2000 (`INCIDENT_RESPONSE_TOO_SHORT/TOO_LONG`). Aynı metin → 200 `replayed: true`; farklı metin → 409 `INCIDENT_RESPONSE_ALREADY_SUBMITTED`; karar sonrası → 409 `INCIDENT_ALREADY_ADJUDICATED`; başkasının incident'ı → 404 (başka `providerId` → 403). Yanıt `PROVIDER_RESPONDED` yapar, hiçbir şeyi karara bağlamaz, destek kutusuna `service-incident-provider-responded:<incidentId>` yazar.

72 saat (`PROVIDER_RESPONSE_SLA_HOURS`): `responseDueAt = reportedAt + 72 saat` projeksiyonu, `responseOverdue` (karar yok + yanıt yok + süre geçti), admin `overdue` filtresi, `lateResponse`/`lateResponses` sinyali. **Teknik kilit değildir**: süre geçse de karar verilene kadar yanıt alınır; admin süre dolmadan karar verebilir (detayda engellemeyen uyarı). **Hatırlatıcı scheduler eklenmedi** (kullanıcı sözleşmesi §16'daki „scope şişiriyorsa" seçeneği): yeni bir zamanlayıcı işi, ayarı, claim kolonu ve test yüzeyi getirirdi; UI geri sayımı + admin gecikme filtresi sözleşmenin asgarisini karşılar. Faz 5 adayı.

Sağlayıcı projeksiyonu açık allowlist'tir (`PROVIDER_INCIDENT_SELECT`): talep satırının iletişim kolonları hiç seçilmez; not `maskContactDetailsInNote` ile maskelenir; personel gerekçesi, kararı veren, yeni tur/yeni sağlayıcı yoktur; karar `outcome {decision, decidedAt, corrected, message}` olarak güvenli metinle (`PROVIDER_OUTCOME_COPY`) döner. Test tam anahtar setini ve müşteri adı/telefonu/e-postası/adres notunun yanıt gövdesinde geçmediğini doğrular.

### 33.5 Güvenilirlik (hesap ve eşikler)

`service-incident-policy.ts`: `RELIABILITY_WINDOW_DAYS = 90` (`reportedAt ≥ now − 90 gün`, sunucu saati), `RELIABILITY_WARNING_AT = 2`, `RELIABILITY_REVIEW_AT = 3`: 0–1 `NORMAL`, 2 `WARNING`, 3+ `ADMIN_REVIEW_REQUIRED`. Sayaç saklanmaz; her okuma effective adjudication join'iyle hesaplanır:

- `effectiveConfirmedCount` (Prisma `count`, `effectiveAdjudication: { is: { decision: CONFIRMED } }`) — eşiklerin okuduğu sayı;
- `providerReliabilitySummary` — confirmed, dismissed, pending, total, responded, `responseRate`, `lateResponses`, `overdueResponses`, seviye;
- `confirmedCountsByProvider` — kuyruk ve risk filtresi (kısmi confirmed index + join).

`ensureReliabilityReview`: confirmed ≥ 3 ve çözülmemiş review yoksa idempotent OPEN review (`triggerIncidentId`), destek kutusuna `provider-reliability-review-opened:<reviewId>`. Düzeltme sayıyı 3'ün altına indirirse review **silinmez/kapanmaz**; seviye yeni değeri gösterir, review personelin sonuçlandırmasını bekler. RESOLVED sonrası yeni bir doğrulama (hâlâ ≥ 3) yeni review açar. Otomatik askıya alma, yasaklama, teklif engeli yok; sağlayıcı durumu değişmez (test). Müşteri/kamu profili hiçbir güvenilirlik verisi göstermez.

Review akışı: `POST /admin/provider-reliability-reviews/:id/acknowledge` (OPEN → ACKNOWLEDGED, `assignedAdminId` = üstlenen), `/resolve` (zorunlu not 10..2000) — `PROVIDER_RELIABILITY_MANAGE`. Askıya alma düğmesi yok; sağlayıcı sayfasındaki mevcut moderasyon akışına bağlantı verilir.

### 33.6 Müşteri sinyali (yalnız admin)

`customerReportSummary`: müşterinin 90 gündeki bildirimleri — total, confirmed, dismissed, pending, `dismissedRatio = dismissed / (confirmed + dismissed)`. `signal = 'HIGH_DISMISSAL_RATIO'` yalnız **karar verilmiş ≥ 3** (`CUSTOMER_SIGNAL_MIN_DECIDED`) ve oran **≥ 0,6** (`CUSTOMER_SIGNAL_DISMISSED_RATIO`) iken; altında sinyal yok. Yalnız admin incident detayında okunur; hiçbir kod yolu onunla bildirim engellemez, talep kısıtlamaz, öncelik düşürmez (test: sinyalden sonra aynı müşterinin yeni bildirimi geçer ve müşteri yanıtında sinyal yoktur).

### 33.7 İzinler

| İzin | Rota |
|---|---|
| `SERVICE_INCIDENTS_READ` | `GET /admin/service-incidents`, `GET /admin/service-incidents/:id` |
| `SERVICE_INCIDENTS_ADJUDICATE` | `POST /admin/service-incidents/:id/adjudications` |
| `SERVICE_INCIDENTS_CORRECT` | `POST /admin/service-incidents/:id/corrections` |
| `PROVIDER_RELIABILITY_READ` | `GET /admin/provider-reliability`, `GET /admin/providers/:providerId/reliability` |
| `PROVIDER_RELIABILITY_MANAGE` | `POST /admin/provider-reliability-reviews/:id/acknowledge`, `/resolve` |

`SERVICE_INCIDENTS_CORRECT` **SUPER_ADMIN'e ayrılmıştır** (`SUPER_ADMIN_RESERVED_PERMISSIONS`, `admin-permissions.ts`): katalogda bir değerdir (rota ona bağlanır, SUPER_ADMIN'in izin listesi onu içerir), ama hiçbir rol taşıyamaz — rol oluşturma/izin değiştirme 400 `PERMISSION_RESERVED_FOR_SUPER_ADMIN`, `GET /admin/permissions` onu `reservedForSuperAdmin` altında ayrı listeler, ve `hasPermission` bir ADMIN'de (bir satır editörü atlatıp yazılmış olsa bile) onu yok sayar; servis ayrıca `isSuperAdmin` ister (403 `SUPER_ADMIN_REQUIRED`). Böylece „hiçbir şeyi açmayan kutucuk" yoktur (kapalı katalog ilkesi) ve düzeltme yalnız SUPER_ADMIN'dedir. Bir rol tohumu yoktur (roller operatörce tanımlanır); „varsayılan eşleme" SUPER_ADMIN'in örtük tüm-katalog yetkisidir.

### 33.8 Bildirimler (outbox, aynı tx; `ServiceIssueOutbox`, lifecycle tick süpürür)

| Şablon | Alıcı | Anahtar | Gönderim anı kuralı |
|---|---|---|---|
| `service-incident-confirmed` / `-dismissed` | sağlayıcı | `<şablon>:<adjudicationId>` | adjudication hâlâ baş ve karar şablonla aynıysa; aksi hâlde üretilmez (düzeltmenin geçtiği eski bildirim gitmez) |
| `service-incident-provider-responded` | destek kutusu | `…:<incidentId>` | yanıt kayıtlı |
| `provider-reliability-review-opened` | destek kutusu | `…:<reviewId>` | review mevcut; sayı gönderim anında hesaplanır |

Sağlayıcı içeriği: sonuç cümlesi, bildirim/talep no, kategori, sebep, bağlantı; gerekçe, sayı, „strike" yok; düzeltmede „karar düzeltildi" notu. **Müşteriye karar maili gönderilmez**: talep zaten yeniden açıldı; karar müşteri için hiçbir şeyi değiştirmez (dışlama ve yeni tur aynen sürer), sağlayıcı yanıtı v0.2.0'da müşteriye gösterilmez — kapanmış bir eşleşme hakkında ikinci bir mail yalnız gürültü ve yanlış beklenti (iade/ceza) üretir. Hepsi retry tablosunda (`RETRY_DEDUPE_PREFIXES`), REQ-UX-007 shell'i, dark-mode/render testlerinde.

### 33.9 UI

- **Sağlayıcı paneli** (`apps/web`): „Hizmet aksaklıkları" menüsü; `/providers/[id]/aksakliklar` (açık / geçmiş), `/providers/[id]/aksakliklar/[incidentId]` (maskeli not, taahhüt günleri, yanıt süresi/„Yanıt süresi geçti", tek yanıt formu 10–2000 + sayaç, karar rozeti ve güvenli sonuç metni); teklif sayfasındaki başarısız eşleşme notundan bağlantı.
- **Admin** (`apps/admin`): `/service-incidents` (durum, sebep, sağlayıcı, tarih, yanıt durumu, gecikme, risk seviyesi filtreleri; varsayılan açık + en eski önce), `/service-incidents/[id]` (referanslar, müşteri beyanı, yanıt ve 72 saat uyarısı, taahhüt anlık görüntüsü, dışlama kalıcı, „Otomatik kredi iadesi yok", sağlayıcı 90g özeti, müşteri bildirim geçmişi/sinyal, karar zaman çizelgesi; Doğrula/Reddet zorunlu gerekçeyle; SUPER_ADMIN için „Kararı düzelt"), `/provider-reliability` (uyarı / inceleme gerekli / açık inceleme; Üstlen / Sonuçlandır), sağlayıcı detayında `#guvenilirlik` kartı.
- Etiketler: Bildirildi / Hizmet veren yanıtladı / Doğrulandı / Reddedildi; Normal / Uyarı / Yönetici incelemesi gerekli. „Strike" kelimesi hiçbir UI'da yok; admin iç terimi „doğrulanmış aksaklık".

### 33.10 Performans (EXPLAIN ANALYZE, BUFFERS — ölçek DB'si)

Atılabilir PostgreSQL 16.6 (tmpfs): M3'e kadar şema + 200k talep, 260k tur, 500k teklif, 3000 sağlayıcı, 50k müşteri, **60k incident + 60k dışlama** (70 % yanıtlı); M4 sonrası **50k INITIAL + 2k CORRECTION adjudication**, 15k CONFIRMED / 35k DISMISSED / 10k açık, 405 açık + 3000 sonuçlanmış review. Tutarlılık scripti (M4 kontrolleri dahil) 0 satır. Sorgular Prisma'nın ürettiği SQL ile (query log'dan).

| Sorgu | Plan | Süre |
|---|---|---|
| Açık kuyruk sayfası (25) | `status_reportedAt_idx` bitmap + top-N | 4,2 ms (10k açık) |
| Açık kuyruk sayımı | `status_reportedAt_idx` index-only | 0,8 ms |
| Gecikmiş yanıt filtresi | `effectiveAdjudicationId_key` (IS NULL) | 1,7 ms |
| Karar verilmiş geçmiş sayfası | parallel seq scan + top-N | 19 ms (50k karar) |
| `effectiveConfirmedCount` (eşik) | `providerId_reportedAt_idx` + adjudication PK probe | 0,35 ms |
| Sağlayıcı 90g özeti | `providerId_reportedAt_idx` + `id_incidentId_key` | 0,17 ms |
| Güvenilirlik kuyruğu / risk filtresi | `confirmed_recent_idx` (kısmi) + hash join | 14 ms (6750 confirmed 90g) |
| Müşteri sinyali | `customerUserId_reportedAt_idx` + PK probe | 0,26 ms |
| Açık review var mı | `one_unresolved_per_provider` (kısmi unique) | 0,02 ms |
| Çözülmemiş review'lar | aynı kısmi index | 0,07 ms |
| Detay karar zinciri | `incidentId_sequence_key` | 0,03 ms |
| Sağlayıcı zaman çizelgesi | `providerId_reportedAt_idx` | 0,08 ms |
| Düzeltme CAS UPDATE (+ projeksiyon trigger'ı 0,3 ms + composite FK 0,06 ms) | PK | 1,1 ms |

Ek index gerekmedi; karar geçmişi sayfası (19 ms) ve risk kuyruğu (14 ms) izlenir — gerekirse `(reportedAt) WHERE status IN ('CONFIRMED','DISMISSED')` kısmi index'i ve kuyruğun join'siz (projeksiyon üzerinden) sayımı ilk adaylardır. **Faz 2 borcu** (expiry/reminder aday taraması ~35 ms/tick) bu PR'a alınmadı: Faz 4 kapsamıyla ilgisiz ve küçük/güvenli bir index değişikliği değil (§32.10), borçta duruyor.

### 33.11 Migration provası ve uygulama

**Preflight** (aktif yerel DB, salt-okunur): 97 migration, `ProviderServiceIncident` 0, dışlama 0, FAILED round 0, MATCH_REVIEW 0, bayrak `false`, tutarlılık (M3 scripti) 0; `rel-002-preflight.sql` M4 bölümü `decided_without_adjudication = 0`, `response_breaking_rules = 0`.

**Yedek** (API durdurulmuşken): `~/Backups/taktic/db/taktic-db-20261011T202742Z-pre-rel002-m4-acaf9902.dump`, sha256 `be34f1510258a7be02e0c9061505b2a8159b079f96c0ad3572cc10a14a9925ae`, 674 109 bayt (1175 TOC, 101 tablo, 97 migration). `restore-rehearsal.sh` geçti (101 tablo / 1231 satır manifest ile birebir).

**Deploy provası** (dump atılabilir PG 16.6'ya `pg_restore`): M3 tutarlılık 0 → `migrate deploy` M4 **19 ms** (wall 0,75 s) → ikinci deploy „No pending" → drift 0 → yeni tutarlılık 0 → 100 tablonun veri hash'i (incident M3 kolonları üzerinden) birebir. Fingerprint: tablo 101 → 103, index 545 → 558 (+13), constraint 545 → 561 (+16), trigger 39 → 43 (+4), migration 97 → 98.

**Rollback provası** (aynı kopya): kullanılmamış durumda `rel-002-m4-rollback.sql` 0,04 s → fingerprint M3 ile birebir (101/545/545/39/97), M3 şemasına (`acaf9902`) drift = yalnız bırakılan 5 `AdminPermission` değeri, veri hash'leri birebir → `migrate deploy` M4'ü yeniden uyguladı, drift 0. Kullanılmış durumda (yeni izin değerini taşıyan bir rol satırı eklenerek) script reddeder ve 98'de kalır.

**Ölçek provası**: M3 baseline tutarlılık 0 → `migrate deploy` M4 **176 ms** (wall 1,04 s; 60k incident satırında iki yeni CHECK doğrulaması + üç index) → „No pending", drift 0, tutarlılık 0.

**Aktif yerel DB 97 → 98**: API durduruldu, yedek alındı (yukarıda), aktif veri hash'i dump ile birebir; M4 **40 ms**, ikinci deploy „No pending", `migrate status` güncel, drift 0, tutarlılık 0, veri hash'leri değişmedi, bayrak `false`, ledger 41 satır. Main'deki Faz 3 kodu (`acaf9902`) M4 şemasıyla yeniden başlatıldı: `/health` 200, log'da hata yok — kod geri dönüşünün canlı kanıtı.

**Geri dönüş sınırı (gerçek):** Faz 4 verisi (adjudication, review, sağlayıcı yanıtı, karar almış incident, yeni izinlerin rol ataması) oluşmadan önce: kod revert + gerekirse `rel-002-m4-rollback.sql`. İlk karar/yanıt yazıldıktan sonra **geriye şema dönüşü yoktur** — karar zinciri, bir sağlayıcı hakkında kimin neye karar verdiğinin audit'idir; yanlış karar SUPER_ADMIN düzeltmesiyle, hata kodda ileri-düzeltmeyle giderilir. Faz 3 kodu M4 şemasıyla çalışır (yukarıdaki canlı kanıt), dolayısıyla kod geri dönüşü şema geri dönüşü gerektirmez.

### 33.12 Staging/production runbook (bu PR'da dokunulmadı)

1. `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/ops/rel-002-preflight.sql` → M4 bölümü 0/0.
2. M3 tutarlılık scripti (`acaf9902`) 0 satır.
3. API durdur → `backup-db.sh` → `restore-rehearsal.sh` → `migrate deploy` (98) → ikinci deploy „No pending" → drift 0 → yeni tutarlılık scripti 0.
4. API/web/admin aynı deploy'da. Bayrak kapalıyken yeni ekranlar boştur (incident yok); izinler rollere ayrıca verilir (`SERVICE_INCIDENTS_CORRECT` verilemez).
5. Bayrak açma ayrı onayla (§32.11/5).

### 33.13 Test kapısı (yerel)

- Yeni `service-incident-adjudication.spec.ts` (30 entegrasyon testi): sağlayıcı yanıtı (sahip, replay/409/DB backstop, uzunluk, başka sağlayıcı 403/404, müşteri/ADMIN/SUPER_ADMIN 403, karar sonrası 409, 72 saat geçmişken kabul + gecikme sinyalleri, allowlist + PII yok + maske), ilk karar (confirm/dismiss + snapshot ve kredi değişmezliği, gerekçe zorunlu, izin matrisi, ikinci karar ve yarış, DB append-only/projeksiyon), düzeltme (ADMIN tüm izinlerle bile 403, rol satırına sızdırılmış izin 403, rol editörü 400, C→D→C zincir + eski satır birebir + bildirimler, ret kodları, aynı başa iki düzeltme → tek kazanan, DB çatal ve incident-dışı baş reddi), güvenilirlik (0/1/2/3 seviyeleri + tek review + 4. açmıyor + kuyruk + askı yok, 90 gün dışı ve dismissed sayılmıyor, 3'ün altına düzeltme review'u koruyor, D→C eşiği aşıyor, eşzamanlı üç onay → tek review, review yaşam döngüsü + DB final/no-delete), müşteri sinyali (örnek eşiği, kısıtlama yok), bildirimler (gerekçe sızmıyor, düzeltmenin geçtiği bildirim gitmiyor), regresyon (bayrak kapalı bildirim 404 iken karar çalışıyor, hiçbir karar kredi satırı yazmıyor). Her case sonunda tutarlılık scripti 0; yarış testleri 3 ardışık koşuda kararlı.
- Güncellenen: `admin-rbac-route-map` (93 izin, 8 yeni rota), e-posta render (60 şablon) ve dark-mode, tutarlılık scripti (11–12).
- Web: panel rota kaydı (2 yeni rota). Admin: yeni `service-incidents.spec.tsx` (14 test: metin, etiketler, „strike" yok, kapılar, rezerve izin, formlar, güvenilirlik kartı), `access-boundaries` (57 → 60 ekran), `nav`, `confirmation-proof` (4 yeni onay anahtarı: `service-incident.adjudicate`, `service-incident.correct`, `reliability-review.acknowledge`, `reliability-review.resolve`).
- E2E (Chromium, hedefli): yeni `service-incident-adjudication.spec.ts` 3/3 — (1) müşteri bildirimi → sağlayıcı incident'ı görür (müşteri adı/telefonu/e-postası sayfada yok, „strike" yok) → yanıtlar → yalnız ADJUDICATE tutan personel doğrular ve „Kararı düzelt" görmez → sağlayıcı güvenli sonuç metnini görür, gerekçeyi görmez → güvenilirlik kartı 1 → SUPER_ADMIN düzeltir (C→D) → kart 0, zaman çizelgesinde iki karar; (2) ret → dışlama ve yeniden açılmış talep aynen, dışlanan sağlayıcı talebi açamaz; (3) üç doğrulama → „Yönetici incelemesi gerekli" + bant → kuyrukta tek satır → Üstlen → Sonuçlandır (not) → sağlayıcı durumu değişmez. Faz 3 `service-issue` 6/6. Güncellenen: `admin-route-scan` (60 ekran; `/service-incidents`, `/service-incidents/[id]`, `/provider-reliability`), `admin-shell` (iki yeni menü satırı), `admin-system-screens` (rol matrisi rezerve izni göstermez). WebKit projesine eklendi; yerelde WebKit'te yeni spec + Faz 3 9/9.

### 33.14 Faz 5 ön koşulları ve kalan borçlar

1. MATCH_REVIEW için admin „Yeni tur aç" (`MatchRoundOpenedBy.ADMIN` hazır) ve Genel görünüm kuyruk hücreleri (açık incident, açık review).
2. Admin talep detayında tur zaman çizelgesi UI'ı (API hazır; incident detayına bağlantı).
3. Sağlayıcı yanıt hatırlatıcısı (48. saat, tek seferlik, claim kolonu) — Faz 4'te bilinçli olarak eklenmedi (§33.4).
4. Güvenilirlik sonucunun bir eylemi (KEEP_ACTIVE / mevcut moderasyonla askı aynı tx'te, §15 taslağı) ve 2. eşikte sağlayıcıya resmi uyarı e-postası (`provider-reliability-warning`) — ürün kararı bekliyor.
5. Müşteriye sağlayıcı yanıtının/kararın gösterilmesi (v0.2.0 sonrası ürün kararı).
6. Borçlar: karar geçmişi sayfası ve risk kuyruğu ölçekte 14–19 ms (§33.10); Faz 2 expiry/reminder taraması (§31.7); bayrak açılınca yerel 2 takvimsiz eşleşme destek yoluna düşer (§32.13/5).
