# CMP-002 S2A — Olay / hak ediş / promosyon lotu / sayaç veri altyapısı ve saf motor sınırı

Tarih: 2026-09-19 · Taban: `origin/main` @ `2a8c25b8` (CMP-002 S0/S1 merge, temiz worktree doğrulandı) ·
Branch: `claude/cmp-002-s2a-infrastructure-d5e8ed` · Bağlayıcı sözleşme: CMP-001 (rev. 3) ·
Önceki dilim: `2026-09-19-cmp-002-s0-s1-campaign-drafts-design.md` · Callback noktaları: AUTH-PROVIDER-CONTACT-001 §6.

Bu dilim **veri altyapısı + saf motor sınırı** getirir. Motor varsayılan kapalıdır, hiçbir mevcut iş akışına
bağlanmaz, ledger'a yazmaz ve onu açan bir uç yoktur. Sağlayıcı onayı, e-posta/telefon kanıtı, Lemon
webhook/mock settle, paket satın alma ve teklif kredi harcaması **bu PR'da davranış değiştirmez** ve hiçbir
kampanya tablosuna yazmaz.

---

## 1. Kararlar (çelişki çözümleri, gerekçeli)

| # | Karar | Gerekçe |
| --- | --- | --- |
| D1 | **Motor kapalıyken sıfır yazı.** `campaignEngineEnabled !== true` ise `evaluate()` ilk adımda `CAMPAIGN_ENGINE_DISABLED` döner; `CampaignTriggerEvent`, `CampaignEvaluationLog` dâhil hiçbir satır yazılmaz. CMP-001 §12.4 adım 1–2 (önce olay kaydı, sonra `ENGINE_DISABLED` log'u) sırası **değişti**: kapalılık kontrolü olay kaydının önüne alındı. | Kill switch'in depolama üzerinde gerçek bir no-op olması gerekir; varsayılan kapalı motor her onay/ödeme/kanıt yazımında bir olay + bir log satırı üretmeli değildir. Görev tanımı bunu açıkça ister. `ENGINE_DISABLED` enum değeri şemada kalır (S2B+ bir gözlem modu isterse hazır), S2A'da yazılmaz. |
| D2 | **`Campaign.activeVersionId` eklendi** (nullable, unique, FK Restrict), yazıcısı **yok**. Aday seçimi `status = ACTIVE AND activeVersionId IS NOT NULL` okur. `redemptionCount`, `budgetConsumedCredits` (default 0, CHECK ≥ 0) eklendi. `revokeAlertThreshold`, `activatedAt/pausedAt/endedAt` **eklenmedi** (revoke S3, yaşam döngüsü uçları S2B). | Motorun aday kümesi hangi sürümün geçerli olduğunu bilmek zorundadır; kolon additive'dir. Aktivasyon ucu olmadığından üretimde hiçbir kampanya ACTIVE olamaz → bayrak yanlışlıkla açılsa bile aday kümesi boştur. |
| D3 | **Ledger'a dokunulmadı.** `CreditTransactionType` enum'u aynı; motor **hiçbir modda** `ProviderCreditTransaction` yazmaz (grep kanıtı). `CampaignRedemption.grantTransactionId` nullable + unique + FK olarak açıldı; S2A'da her zaman NULL. S2B `CAMPAIGN_GRANT` türünü ekleyip aynı statement grubunda doldurur. | Görev tanımı enum'u kesin kapsam dışı sayar. Lot ↔ bakiye değişmezi (`balance = paid + Σ lot.remaining`) S2A'da hiçbir okuyucu tarafından kullanılmaz; lot yalnız testlerden üretilebilir (üretimde motoru çağıran yol yok). |
| D4 | Fayda adı S0/S1 kararını izler: `PROMO_CREDITS`, `benefitCredits`, `benefitExpiresInDays`. Lot `expiresAt = grantedAt + benefitExpiresInDays gün`. | S1 migration'ı bu adları kalıcılaştırdı; CMP-001'deki `PROMO_CREDIT_LOT/validityDays` aynı mekanizmadır. |
| D5 | `CampaignDailyCounter.day` `DATE` kolonu; gün Europe/Istanbul'da kodda hesaplanır (`Intl.DateTimeFormat`), DB saat dilimine bağlı değildir. | CMP-001 §3.2 "day (date, Europe/Istanbul)". |
| D6 | Olay ↔ hak ediş ayrımı CMP-001 §12 ile birebir: `CampaignTriggerEvent.triggerEventKey` **global unique**; `CampaignRedemption @@unique([campaignId, triggerEventKey])` + `triggerEventId` FK; `CampaignTriggerEvent.settledRedemptionId` unique. Aynı olay birden çok kampanyanın adayı olabilir; `EXCLUSIVE_CREDIT_BONUS` runtime'da tek kazananı settle eder. | Görev tanımı ve CMP-001 §12.2. |
| D7 | `CampaignEvaluationLog` **unique'siz**, append-only; `outcome` kapalı enum + `winnerCampaignId?`. | CMP-001 §12.2. |
| D8 | `CampaignRedemptionStatus { GRANTED REVOKED EXPIRED }`, `CampaignRevokeReason`, `PromoCreditLotStatus { ACTIVE EXHAUSTED EXPIRED REVOKED }` şemada açıldı; S2A yalnız `GRANTED` / `ACTIVE` yazar. `CampaignAuditAction` genişletilmedi (aktivasyon S2B). | Enum genişletme tek satırlık migration'dır ama S2B/S3 kolon ekleyeceğine enum'u burada tamamlamak revoke/expiry kolonlarının (`revokedAt, revokeReason, spentAtRevoke, expiryTransactionId, revokeTransactionId`) nullable olarak şimdi açılmasına izin verir. |
| D9 | `PromoCreditLotConsumption` **yok** (S2B, teklif harcamasına bağlanır). | Görev tanımı. |
| D10 | `FactSourceRegistry` `read(tx, providerId, fact)` ile üç olgunun kanonik okumasını içerir; **yazıcı kaydı boştur** (PROVIDER-rol yazıcı yok). `hasProviderWriter(fact)` her olgu için `false` → S2B aktivasyon kapısı (`FACT_SOURCE_UNAVAILABLE`) mekanik olarak kapalı kalır. | Kapsam dışı: "FactSourceRegistry'nin gerçek business-writer entegrasyonu". |
| D11 | `onProviderFact(tx, providerId, fact)` ve `evaluate(tx, input)` **uygulanmış ama çağrılmamıştır**. `// CMP-002 fact callback` yorumlu noktalar (providers/email/phone) **dokunulmadı**. Webhook/mock settle/teklif yolu dokunulmadı. | Görev tanımı §2: hook bağlama yok. |

## 2. Migration B (`20260919180000_add_campaign_engine_infrastructure`) — yalnız additive

```
enum CampaignRedemptionStatus  { GRANTED REVOKED EXPIRED }
enum CampaignRevokeReason      { PAYMENT_REVERSED ADMIN_REVOKED }
enum PromoCreditLotStatus      { ACTIVE EXHAUSTED EXPIRED REVOKED }
enum CampaignEvaluationOutcome { GRANTED NO_CANDIDATE CONDITIONS_FAILED WINDOW_CLOSED ELIGIBILITY_INCOMPLETE
                                 STACK_CONFLICT EVENT_ALREADY_SETTLED ALREADY_REDEEMED CAMPAIGN_PAUSED
                                 PER_PROVIDER_LIMIT GLOBAL_LIMIT DAILY_LIMIT BUDGET_EXHAUSTED
                                 ENGINE_DISABLED ENGINE_ERROR }

Campaign            + activeVersionId String? @unique → CampaignVersion (Restrict)
                    + redemptionCount Int @default(0), budgetConsumedCredits Int @default(0)
                      CHECK redemptionCount >= 0 AND budgetConsumedCredits >= 0

CampaignTriggerEvent   id, triggerEventKey @unique, trigger, providerId → ProviderProfile, purchaseId? → PackagePurchase,
                       factSetKey?, firstSeenAt, lastSeenAt, evaluationCount Int @default(0),
                       settledByCampaignId? → Campaign, settledRedemptionId? @unique → CampaignRedemption, settledAt?
                       @@index([providerId, firstSeenAt]) @@index([purchaseId])
                       CHECK evaluationCount >= 0
                       CHECK (settledByCampaignId IS NULL) = (settledRedemptionId IS NULL) AND (settledRedemptionId IS NULL) = (settledAt IS NULL)
                       CHECK (trigger = 'PROVIDER_ELIGIBILITY_REACHED') = (factSetKey IS NOT NULL)
                       CHECK (trigger = 'PACKAGE_PAYMENT_SUCCEEDED') = (purchaseId IS NOT NULL)

CampaignRedemption     id, campaignId → Campaign, campaignVersionId → CampaignVersion, providerId → ProviderProfile, userId? → User,
                       trigger, triggerEventId → CampaignTriggerEvent, triggerEventKey, purchaseId? → PackagePurchase,
                       status @default(GRANTED), rulesSnapshot Json, grantedCredits Int,
                       grantTransactionId? @unique → ProviderCreditTransaction (S2A: NULL),
                       grantedAt, revokedAt?, revokeReason?, spentAtRevoke?, revokedById? → User
                       @@unique([campaignId, triggerEventKey]) @@index([triggerEventKey]) @@index([campaignId, providerId])
                       @@index([providerId, status]) @@index([campaignVersionId]) @@index([purchaseId]) @@index([triggerEventId])
                       CHECK grantedCredits BETWEEN 1 AND 1000
                       CHECK (status = 'REVOKED') = (revokedAt IS NOT NULL) AND (status = 'REVOKED') = (revokeReason IS NOT NULL)
                       CHECK spentAtRevoke IS NULL OR spentAtRevoke BETWEEN 0 AND grantedCredits

CampaignEvaluationLog  id, triggerEventId → CampaignTriggerEvent, campaignId? → Campaign, campaignVersionId? → CampaignVersion,
                       providerId → ProviderProfile, fact CampaignEligibilityFact?, outcome, reasonCode String?,
                       winnerCampaignId? → Campaign, evaluatedAt
                       @@index([triggerEventId, evaluatedAt]) @@index([campaignId, evaluatedAt]) @@index([providerId, evaluatedAt])
                       (unique yok)

PromoCreditLot         id, providerId → ProviderProfile, redemptionId @unique → CampaignRedemption,
                       grantedCredits, remainingCredits, expiresAt, status @default(ACTIVE),
                       expiryTransactionId? @unique → ProviderCreditTransaction, revokeTransactionId? @unique → ProviderCreditTransaction,
                       createdAt, updatedAt
                       @@index([providerId, status, expiresAt]) @@index([status, expiresAt])
                       CHECK grantedCredits >= 1 AND remainingCredits >= 0 AND remainingCredits <= grantedCredits
                       CHECK (status = 'EXHAUSTED') → remainingCredits = 0

CampaignProviderCounter id, campaignId → Campaign, providerId → ProviderProfile, redemptionCount Int @default(0), updatedAt
                       @@unique([campaignId, providerId]) CHECK redemptionCount >= 0
CampaignDailyCounter    id, campaignId → Campaign, day DATE, redemptionCount Int @default(0), updatedAt
                       @@unique([campaignId, day]) CHECK redemptionCount >= 0
```

Silme yok (`onDelete: Restrict`/varsayılan), DML yok, backfill yok, mevcut kolon türü değişmez, `CreditTransactionType`
aynı. Prisma `DATE` için `@db.Date`.

## 3. Motor sınırı (`apps/api/src/modules/campaigns/engine/`)

```
trigger-event-key.ts        saf: buildTriggerEventKey(input) → 'PROVIDER_APPROVED:<providerId>' | 'PACKAGE_PAYMENT_SUCCEEDED:<purchaseId>'
                                 | 'PROVIDER_ELIGIBILITY_REACHED:<factSetKey>:<providerId>'; buildFactSetKey(facts) (sıralı, '+')
condition-evaluator.ts      saf: evaluateConditions(definition, facts) → { passed } | { passed:false, failed: type }
                            10 koşulun her biri ProviderFacts/PurchaseFacts üzerinden; all/any tablosu
fact-source-registry.ts     3 olgunun kanonik okuması (tx içinde tek okuma): ProviderProfile.status, User.emailVerifiedAt/phoneVerifiedAt
                            (userId null → false); writers boş; hasProviderWriter() → false
campaign-fact-reader.ts     tx içinde ProviderFacts (approvedAt, kanıtlar, önceki PROVIDER_APPROVED redemption, REVOKED redemption)
                            ve PurchaseFacts (slug/type/kind/tutar/para birimi, ilk başarılı ödeme) okur
campaign-engine.repository.ts  DB adımları: ensureTriggerEvent (SAVEPOINT altında insert, P2002 → yeniden oku, evaluationCount+1),
                            loadCandidates (ACTIVE + activeVersion + trigger[+factSetKey]; PAUSED bilgi için), consume*Counter (koşullu
                            updateMany), createRedemptionAndLot, settleEvent, appendLog, SAVEPOINT/ROLLBACK TO/RELEASE
campaign-engine.service.ts  evaluate(tx, input) ve onProviderFact(tx, providerId, fact) — §4 akışı
```

`CampaignsModule` hâlâ hiçbir domain modülünü import etmez ve motoru **export etmez**: bu PR'da `CampaignEngineService`'i
çağıran tek yer testlerdir.

## 4. Transaction ve idempotency tasarımı (tetikleyici tx'i içinde; S2A'da yalnız test çağırır)

```
evaluate(tx, input):
  0. engine = tx.operationsSettings(singleton).campaignEngineEnabled  → false/yok → return CAMPAIGN_ENGINE_DISABLED  (sıfır yazı, D1)
  1. key = buildTriggerEventKey(input)
     SAVEPOINT cmp_event; INSERT CampaignTriggerEvent; P2002 → ROLLBACK TO cmp_event, SELECT by key; RELEASE
     UPDATE event SET lastSeenAt = now, evaluationCount + 1
  2. event.settledRedemptionId != null → kazanan kampanya için ALREADY_REDEEMED, tetikleyiciyi eşleyen diğer ACTIVE adaylar
     için EVENT_ALREADY_SETTLED log'u; return
  3. adaylar: Campaign ACTIVE + activeVersion.trigger = input.trigger (+ factSetKey); PAUSED eşleşenler → CAMPAIGN_PAUSED log
     aday yok → NO_CANDIDATE log; return
  4. her aday için: window (WINDOW_CLOSED) → koşullar (kanonik okuma, CONDITIONS_FAILED) → uygun adaylar listesi
  5. sıralama: benefitCredits desc, priority asc, campaignId asc
  6. her uygun aday için:
       redemption(campaignId, key) var → ALREADY_REDEEMED, sonraki
       SAVEPOINT cmp_candidate
         CampaignProviderCounter upsert + updateMany WHERE redemptionCount < maxPerProvider → +1  (0 → PER_PROVIDER_LIMIT)
         CampaignDailyCounter   upsert + updateMany WHERE redemptionCount < maxPerDay → +1        (0 → DAILY_LIMIT)
         Campaign updateMany WHERE (global IS NULL OR redemptionCount < global) AND (budget IS NULL OR consumed + credits <= budget)
                             → redemptionCount+1, budgetConsumedCredits+credits                  (0 → GLOBAL_LIMIT / BUDGET_EXHAUSTED, teşhis SELECT ile)
         INSERT CampaignRedemption (rulesSnapshot = version.definition, grantedCredits = version.benefitCredits)
         INSERT PromoCreditLot (granted = remaining = credits, expiresAt = now + expiresInDays)
         UPDATE event SET settledByCampaignId, settledRedemptionId, settledAt
       ret → ROLLBACK TO SAVEPOINT cmp_candidate + log, sonraki aday
       P2002 (aynı campaign+key) → ROLLBACK TO + ALREADY_REDEEMED, sonraki
       başarı → RELEASE; log GRANTED; kalan uygun adaylar STACK_CONFLICT(winner); break
  7. dön (commit çağıranın tx'inde)
onProviderFact(tx, providerId, fact):
  0. engine kapalı → CAMPAIGN_ENGINE_DISABLED (sıfır yazı)
  1. bu olguyu içeren ACTIVE kampanyaların factSetKey kümeleri; her küme için tüm olgular registry.read ile yeniden okunur
  2. eksik → (olay yaratılmaz) ELIGIBILITY_INCOMPLETE sonucu; hepsi true → evaluate(PROVIDER_ELIGIBILITY_REACHED, factSetKey)
```

Savepoint'ler `$executeRawUnsafe('SAVEPOINT …')` ile aynı bağlantıdadır (Prisma interactive tx tek bağlantı). Birincil
idempotency yolu **okuma**dır; P2002 backstop'tur. Motorun iş sonuçları HTTP hatası üretmez; beklenmeyen hata
`ENGINE_ERROR` log'u ile çağırana `{ outcome: 'ENGINE_ERROR' }` döner ve tetikleyici tx'ini geri almaz (hook'lar S2B'de
`try/catch` içinde bağlanır). **Ledger yazımı adım 6'da yoktur** (D3) — S2B `CAMPAIGN_GRANT` satırını redemption
insert'inin hemen önüne ekler ve `grantTransactionId`'yi doldurur.

`ELIGIBILITY_INCOMPLETE` için olay yaratılmaz: olay anahtarı "olguların ilk kez birlikte true olması"nı temsil
eder; eksikken olay yoktur. Bu, CMP-001 §8.3 (2)'deki "log yazar" ifadesinden küçük bir sapmadır — log satırı
`triggerEventId` zorunlu olduğundan olaysız yazılamaz; sonuç çağırana döner, S2B gözlem isterse nullable'a çevirir.

## 5. Kapalı-motor sıfır-etki matrisi (test kanıtı: `campaign-engine-disabled.spec.ts`, `campaign-engine-isolation.spec.ts`)

| Giriş | Kampanya durumu | Yazılan satır |
| --- | --- | --- |
| `evaluate(PROVIDER_APPROVED)` | DRAFT / (test-only) ACTIVE | 0 |
| `evaluate(PACKAGE_PAYMENT_SUCCEEDED)` | DRAFT / ACTIVE | 0 |
| `evaluate(PROVIDER_ELIGIBILITY_REACHED)` | DRAFT / ACTIVE | 0 |
| `onProviderFact(× 3 olgu)` | ACTIVE, üç olgu true | 0 |
| Sağlayıcı onayı (PATCH status) | DRAFT'lar mevcut | profil dışı 0 |
| E-posta + telefon kanıtı | DRAFT'lar mevcut | hesap kolonları dışı 0 |
| Lemon webhook settle (ONE_TIME) | DRAFT'lar mevcut | PAID + PACKAGE_PURCHASE dışı 0 |
| Mock settle (dönem) | DRAFT'lar mevcut | entitlement dışı 0 |
| Teklif kredi harcaması | DRAFT'lar mevcut | OFFER_SPEND dışı 0 |

"Satır" = `CampaignTriggerEvent, CampaignRedemption, CampaignEvaluationLog, PromoCreditLot, CampaignProviderCounter,
CampaignDailyCounter` sayıları + `Campaign.redemptionCount/budgetConsumedCredits` + `ProviderCreditTransaction`
sayısı ve tür kümesi (altı eski tür).

## 6. Test planı

| Katman | Kapsam |
| --- | --- |
| Şema (`campaign-engine-schema.spec.ts`) | event key global unique (P2002); aynı campaign+key ikinci redemption P2002; farklı campaign + aynı key kabul; `settledRedemptionId` unique; lot CHECK (negatif, remaining > granted, EXHAUSTED ≠ 0); counter unique + CHECK; Campaign sayaç CHECK; event settled/trigger CHECK'leri; `grantTransactionId` NULL kabul |
| Saf (`campaign-trigger-event-key.spec.ts`, `campaign-condition-evaluator.spec.ts`) | üç anahtar biçimi, factSetKey sıralaması; 10 koşul × geçti/kaldı, `any` doğruluk tablosu, boş kök |
| Motor kapalı (`campaign-engine-disabled.spec.ts`) | §5 matrisi ilk 4 satır; test-only ACTIVE kampanya doğrudan Prisma ile yazılır |
| Motor açık (`campaign-engine.spec.ts`; bayrak testte doğrudan DB'ye yazılır) | olay idempotency (evaluationCount), aynı campaign+event → ALREADY_REDEEMED, iki kampanya aynı olay → kredi/priority/campaignId sırası + STACK_CONFLICT + kaybeden sayaçları 0, kazanan limitte → savepoint geri + sıradaki kazanır, perProvider/daily/global/budget sınırları, settled olay yeniden → EVENT_ALREADY_SETTLED, PAUSED → CAMPAIGN_PAUSED, NO_CANDIDATE, window, koşul kaçırma, uygunluk 6 permütasyon → tek redemption; **ledger sayısı her senaryoda 0**; değişmezler `redemptionCount = COUNT`, `budgetConsumed = Σ granted`, Σ sayaçlar |
| İzolasyon (`campaign-engine-isolation.spec.ts`, genişletildi) | §5 matrisi son 5 satır, yeni tabloların sayıları dâhil |
| Migration | geçici DB'de `migrate deploy` (tüm zincir) + `migrate diff` boş + `\d` çıktısı; gerçek yerel/staging DB'ye komut yok |

## 7. S2B'ye kalanlar

`CreditTransactionType += CAMPAIGN_GRANT/EXPIRY/REVOKE` + grant ledger satırı (adım 6) + `grantTransactionId` doldurma;
hook'lar (`updateProviderStatus` → `runSerializable` + evaluate + onProviderFact; webhook/mock settle; kanıt yazıcıları);
`PromoCreditLotConsumption` + resolver lot tüketimi (en erken dolacak önce) + iade geri yazımı; expiry süpürücü +
`campaignLotExpirySchedulerEnabled`; aktivasyon/pause/end uçları + `activeVersionId` yazıcısı + `FACT_SOURCE_UNAVAILABLE`
/ `LIMIT_BELOW_CONSUMED` + `CampaignAuditAction` genişletme; engine anahtarı toggle ucu; K1/K2; sağlayıcı yüzeyi;
`FactSourceRegistry` yazıcı kayıtları; `ELIGIBILITY_INCOMPLETE` gözlem log'u (nullable `triggerEventId` gerekirse).
