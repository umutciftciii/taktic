# CMP-002 S2A — Teslim raporu

Tarih: 2026-09-19 · Branch: `claude/cmp-002-s2a-infrastructure-d5e8ed` · Taban: `origin/main` @ `2a8c25b8` ·
Tasarım notu: `docs/superpowers/specs/2026-09-19-cmp-002-s2a-engine-infrastructure-design.md` · Dry-run kaydı:
`docs/superpowers/plans/2026-09-19-cmp-002-s2a-migration-dryrun.txt` · Bağlayıcı sözleşme: CMP-001 (rev. 3).

PR: https://github.com/umutciftciii/taktic/pull/97 · head `81c0018c` (+ bu rapor commit'i) · CI run 35470354140 **3/3 yeşil** (typecheck·lint·test·build ✅, e2e chromium ✅, e2e webkit ✅).

Merge, deploy, yerel/staging eşitlemesi, gerçek `.env`, Cloudflare, Lemon veya gerçek veri işlemi **yapılmadı**.
Geçici DB'ler (`taktic_cmp002_s2a_shadow`, `taktic_cmp002_s2a_dryrun`, `taktic_cmp002s2a_e2e`) yalnız bu iş için
oluşturuldu; ilk ikisi düşürüldü, yerel `taktic` DB'sine komut çalıştırılmadı.

---

## 1. Teslim edilen

| Katman | Dosya | İçerik |
| --- | --- | --- |
| Migration B | `prisma/migrations/20260919180000_add_campaign_engine_infrastructure/migration.sql` (+ `schema.prisma`) | 4 enum (`CampaignRedemptionStatus`, `CampaignRevokeReason`, `PromoCreditLotStatus`, `CampaignEvaluationOutcome`), 6 tablo (`CampaignTriggerEvent`, `CampaignRedemption`, `CampaignEvaluationLog`, `PromoCreditLot`, `CampaignProviderCounter`, `CampaignDailyCounter`), `Campaign.activeVersionId` (nullable unique, FK Restrict) + `redemptionCount`/`budgetConsumedCredits` (default 0), 12 CHECK, tüm FK'ler Restrict. **Yalnız additive:** DROP/ALTER COLUMN/DML yok, `CreditTransactionType` aynı |
| Saf yardımcılar | `apps/api/src/modules/campaigns/engine/trigger-event-key.ts`, `condition-evaluator.ts` | Üç olay anahtarı biçimi + `factSetKey`; 10 v1 koşulunun saf değerlendirmesi (`all`/tek seviye `any`), katalog dışı koşul → hata |
| Olgu kaynağı | `engine/fact-source-registry.ts`, `engine/campaign-fact-reader.ts` | 3 olgunun kanonik okuması (`ProviderProfile.status`, `User.emailVerifiedAt/phoneVerifiedAt`; `userId=null` → false); **yazıcı kaydı boş** (`hasProviderWriter` → false); koşul olguları (onay tarihi, önceki onay redemption'ı, REVOKED, purchase slug/tür/kind/tutar, ilk başarılı ödeme) |
| Repository | `engine/campaign-engine.repository.ts` | Motorun **tüm** yazıları: olay upsert (SAVEPOINT + P2002 → yeniden oku → görünmüyorsa P2034-uyumlu `CampaignEngineWriteConflict`), aday yükleme, koşullu sayaç tüketimi (provider → gün → global/bütçe), redemption + lot, olay settle, log; `ProviderCreditTransaction` bu dosyada **anılmaz** |
| Motor | `engine/campaign-engine.service.ts` | `evaluate(tx, input)` ve `onProviderFact(tx, providerId, fact)`; adım 0 kill switch (caller tx içinde okunur, kapalıysa **sıfır yazı**); CMP-001 §12.4 boru hattı; savepoint ile hata sınırlama (`ENGINE_ERROR`, caller tx yaşar; P2034 yeniden fırlatılır) |
| Modül | `campaigns.module.ts` | 4 yeni provider; **export yok**, domain import yok → hiçbir mevcut akış motoru çağıramaz |
| Testler | `apps/api/test/campaign-engine-schema.spec.ts` (21), `campaign-trigger-event-key.spec.ts` (6), `campaign-condition-evaluator.spec.ts` (11), `campaign-engine-disabled.spec.ts` (7), `campaign-engine.spec.ts` (30), `campaign-engine-isolation.spec.ts` (5, genişletildi), `campaign-fixtures.ts`, `harness.ts` (truncate listesi) | §4–5 |

**Dokunulmayanlar (git diff kanıtı):** `providers/`, `payments/`, `entitlements/`, `offers/`, `credits/`, `email-verification/`,
`phone-verification/`, `operations-settings/`, admin/web uygulamaları, `.env`/compose, `// CMP-002 fact callback` yorumlu
üç nokta. Public/admin yeni uç **yok**; toggle ucu **yok**; seed/başlangıç kampanyası/lot **yok**.

## 2. Migration SQL özeti

```
CREATE TYPE CampaignRedemptionStatus / CampaignRevokeReason / PromoCreditLotStatus / CampaignEvaluationOutcome
ALTER TABLE Campaign ADD activeVersionId TEXT, budgetConsumedCredits INT NOT NULL DEFAULT 0, redemptionCount INT NOT NULL DEFAULT 0
CREATE TABLE CampaignTriggerEvent   (triggerEventKey UNIQUE, settledRedemptionId UNIQUE, idx providerId+firstSeenAt, purchaseId, settledByCampaignId)
CREATE TABLE CampaignRedemption     (UNIQUE (campaignId, triggerEventKey), grantTransactionId UNIQUE nullable, 8 index)
CREATE TABLE CampaignEvaluationLog  (unique yok; idx event+at, campaign+at, provider+at, version, winner)
CREATE TABLE PromoCreditLot         (redemptionId UNIQUE, expiryTransactionId UNIQUE, revokeTransactionId UNIQUE; idx provider+status+expiresAt, status+expiresAt)
CREATE TABLE CampaignProviderCounter (UNIQUE (campaignId, providerId))
CREATE TABLE CampaignDailyCounter    (day DATE, UNIQUE (campaignId, day))
25 FK … ON DELETE RESTRICT
12 CHECK: Campaign_counters_nonnegative · CampaignTriggerEvent_{evaluationCount_nonnegative, settlement_complete,
  factSetKey_matches_trigger, purchase_matches_trigger} · CampaignRedemption_{grantedCredits_bounded (1–1000),
  revocation_complete, spentAtRevoke_bounded} · PromoCreditLot_{credits_bounded (granted≥1, 0≤remaining≤granted),
  exhausted_means_empty} · CampaignProviderCounter/CampaignDailyCounter_redemptionCount_nonnegative
```

**İzole dry-run** (`taktic_cmp002_s2a_dryrun`, sonra düşürüldü): `migrate deploy` tüm zincir → **67 migration**;
`migrate diff --from-url --to-schema-datamodel` → **"No difference detected"**; `CreditTransactionType` = 6 eski değer;
6 yeni tablo 0 satır; 12 CHECK ve `\d` çıktıları dry-run kaydında.

## 3. Transaction / idempotency tasarımı (kodda: `campaign-engine.service.ts` § pipeline)

```
evaluate(tx, input)
  0  campaignEngineEnabled (caller tx, fail-closed) → false ⇒ CAMPAIGN_ENGINE_DISABLED, sıfır yazı
  SAVEPOINT cmp_eval
  1  ensureTriggerEvent: SELECT by key → yoksa SAVEPOINT cmp_event + INSERT (P2002 → ROLLBACK TO + SELECT → yoksa P2034 fırlat) ; evaluationCount+1, lastSeenAt
  2  event.settled ⇒ kazanan ALREADY_REDEEMED, diğer ACTIVE adaylar EVENT_ALREADY_SETTLED(winner) ; dön
  3  adaylar = ACTIVE|PAUSED ∧ activeVersion.trigger (∧ factSetKey) ; yok ⇒ NO_CANDIDATE ; PAUSED ⇒ CAMPAIGN_PAUSED (tüketim yok)
  4  definition → validator (ret ⇒ hata ⇒ ENGINE_ERROR) ; window ⇒ WINDOW_CLOSED ; koşullar (kanonik okuma) ⇒ CONDITIONS_FAILED(reasonCode=type|any)
  5  sıra: benefitCredits desc, priority asc, campaignId asc
  6  her uygun aday: redemption(campaignId,key) var ⇒ ALREADY_REDEEMED
       SAVEPOINT cmp_candidate
         ProviderCounter upsert + updateMany WHERE count < maxPerProvider   (0 ⇒ PER_PROVIDER_LIMIT)
         DailyCounter    upsert + updateMany WHERE count < maxPerDay        (0 ⇒ DAILY_LIMIT)   [limit null ise koşulsuz +1]
         Campaign updateMany WHERE count < global ∧ consumed ≤ budget−credits (0 ⇒ GLOBAL_LIMIT|BUDGET_EXHAUSTED, teşhis SELECT)
         INSERT Redemption(rulesSnapshot=definition, grantedCredits, grantTransactionId=NULL) ; INSERT Lot(remaining=granted, expiresAt=now+days)
         UPDATE Event settledBy*, RELEASE
       ret ⇒ ROLLBACK TO cmp_candidate + log ; P2002 ⇒ ROLLBACK TO + ALREADY_REDEEMED
       başarı ⇒ GRANTED, kalanlar STACK_CONFLICT(winner) ; break
  RELEASE cmp_eval ; beklenmeyen hata ⇒ ROLLBACK TO cmp_eval ⇒ ENGINE_ERROR (caller tx yaşar) ; P2034 ⇒ yeniden fırlat
onProviderFact(tx, providerId, fact)
  0  kill switch ; SAVEPOINT cmp_fact
  1  bu olguyu içeren ACTIVE sürümlerin factSetKey kümeleri ; yok ⇒ NO_FACT_SET (yazı yok)
  2  her küme: registry.readAll (çağırana güvenilmez) ; eksik ⇒ küme atlanır (olay yaratılmaz) ; tam ⇒ evaluate(ELIGIBILITY, facts, raisedByFact)
  ⇒ EVALUATED{evaluations, incompleteFactSetKeys} | ELIGIBILITY_INCOMPLETE{factSetKeys}
```

Tasarım notu D1–D11'deki sapmalar: kapalılık kontrolü olay kaydının **önünde** (CMP-001 §12.4 adım 1–2 ters);
`ENGINE_DISABLED` log'u yazılmaz; `ELIGIBILITY_INCOMPLETE` için olay/log yazılmaz (log `triggerEventId` zorunlu).

## 4. Kapalı-motor sıfır-etki matrisi (kanıt: testler)

| Giriş | DB durumu | Yazı | Test |
| --- | --- | --- | --- |
| `evaluate` × 3 tetikleyici | her tetikleyici için ACTIVE kampanya, uygun sağlayıcı, PAID purchase, 1 ADMIN_GRANT | 0 (event/redemption/log/lot/counter/Campaign sayaçları/ledger aynı) | `campaign-engine-disabled` (satır yok **ve** satır var+false) |
| `onProviderFact` × 3 olgu | ACTIVE uygunluk kampanyası, üç olgu true | 0 | aynı |
| `evaluate` var olmayan provider/purchase | — | 0, okuma da yok | aynı |
| bayrak tx başladıktan sonra açılır | Serializable | 0 (snapshot) | aynı |
| PATCH `/providers/:id/status` APPROVED | 3 DRAFT + 3 ACTIVE kampanya | yalnız profil | `campaign-engine-isolation` |
| e-posta confirm + telefon OTP verify (sağlayıcı) | aynı | yalnız `User.*VerifiedAt` | aynı |
| Lemon webhook `order_created` (ONE_TIME 25) | aynı | PAID + tek `PACKAGE_PURCHASE` | aynı |
| mock settle (MONTHLY_QUOTA) | aynı | yalnız entitlement | aynı |
| teklif oluşturma (kredi 2) | aynı | yalnız `OFFER_SPEND` | aynı |

Ledger tür kümesi her satırda eski 6 tür; `campaignEngineEnabled` false; 6 kampanyanın `redemptionCount/budgetConsumedCredits` 0.

## 5. Model bütünlüğü ve açık-motor kanıtı

- **Şema (21):** event key global unique (P2002); aynı campaign+event ikinci redemption P2002; **farklı campaign + aynı
  event kabul** (2 satır); `settledRedemptionId` unique; event CHECK'leri (purchase↔trigger, factSetKey↔trigger,
  settlement tamlığı, evaluationCount ≥ 0); redemption `grantTransactionId` NULL kabul, `grantedCredits` 1–1000,
  REVOKED tamlığı; lot redemption unique, negatif/aşan/sıfır granted ret, EXHAUSTED ⇒ 0; counter unique + ≥ 0; Campaign
  sayaç ≥ 0; log unique'siz; `CreditTransactionType` pg_enum = 6 eski değer.
- **Açık motor (30, yalnız testten erişilir):** tek grant (event/redemption/lot/sayaçlar/log; `rulesSnapshot = definition`;
  `expiresAt = now+30g`; **ledger 0**); tekrar ⇒ ALREADY_REDEEMED + evaluationCount 2, başka yazı yok; purchase anahtarı;
  perProvider>1 farklı olay ⇒ ikinci grant; NO_CANDIDATE; PAUSED log/DRAFT-ENDED sessiz; WINDOW_CLOSED; CONDITIONS_FAILED
  reasonCode (MIN_PAID_AMOUNT, FIRST_SUCCESSFUL_PAID_PURCHASE, FIRST_PROVIDER_APPROVAL); stack sırası kredi→priority→
  campaignId + STACK_CONFLICT + kaybeden sayaçları 0; **bütçe reddi ⇒ savepoint geri ⇒ sıradaki kazanır**, reddedilenin
  counter satırı yok; settled sonrası EVENT_ALREADY_SETTLED/ALREADY_REDEEMED; K1+K2 farklı olay ⇒ 2 lot; PER_PROVIDER/
  DAILY/GLOBAL/BUDGET limitleri; **barrier'lı 4 eşzamanlı tx son slot ⇒ tek grant**; **barrier'lı 2 tx aynı olay ⇒ tek
  redemption, kaybeden P2034 ile yeniden denendi (kayıtlı logger ile kanıt)**; uygunluk **6 permütasyon ⇒ tam bir**
  redemption, eksikte olay yok, son olgu tekrar ⇒ ek grant yok; NO_FACT_SET; misafir (userId=null) ⇒ INCOMPLETE; iki küme
  aynı olguyu paylaşır ⇒ iki ayrı olay; **ENGINE_ERROR** (bozuk definition) ⇒ motor yazıları geri, caller'ın önceki ve
  sonraki yazıları commit. Her grant senaryosunda değişmezler: `redemptionCount = COUNT`, `budgetConsumed = Σ granted`,
  `Σ providerCounter = Σ dailyCounter = redemptionCount`, lot `remaining = granted = redemption.grantedCredits`, ledger 0.

## 6. Test ve derleme sonuçları (yerel, worktree)

| Adım | Sonuç |
| --- | --- |
| `pnpm typecheck` | ✅ 5/5 (api + test tsconfig, admin, web, shared, e2e) |
| `pnpm lint` | ✅ 4/4 |
| `pnpm build` | ✅ 3/3 |
| `pnpm test` | ✅ api **141 dosya / 3188 test**, web 338, admin 64, shared 168 |
| E2E Chromium (`pnpm e2e`, izole `taktic_cmp002s2a_e2e`) | ✅ **285 passed, 0 failed** (8.5 dk) |
| E2E WebKit (`pnpm e2e:webkit`) | ✅ **116 passed, 0 failed** (3.8 dk) |
| Migration dry-run | ✅ 67 migration, diff boş (§2) |

Flaky/ilgisiz gözlemler: yerelde yok. **İlk CI koşusu** (run 35469454765, head `20770301`): iki E2E job'ı ✅, test
job'ında yalnız **kendi yazdığım** `campaign-engine.spec.ts › the last slot under concurrency` düştü — dört gerçekten
çakışan Serializable tx'te kaybedenler yeniden denemede birbirleriyle tekrar çakışıp `runSerializable` bütçesini (3)
tüketti → 409 `CONCURRENT_MODIFICATION`. Bu motor hatası değil, CMP-001 §10.3'ün belgelediği çağıran-tarafı sonucu; test
`81c0018c` ile bunu kaybeden için yasal sonuç sayar (kazanan tek, redemption 1, değişmezler korunur). İkinci koşu 3/3 ✅.
Mevcut suite'lerde flaky gözlenmedi.

## 7. "Mevcut kredi davranışı değişmedi" kanıtı

1. `CreditTransactionType` enum'u değişmedi (migration SQL'de `ALTER TYPE` yok; pg_enum testi; dry-run çıktısı).
2. `apps/api/src/modules/campaigns/` altında `providerCreditTransaction` çağrısı **yok** (grep: yalnız bir yorum satırı);
   `CampaignRedemption.grantTransactionId` her testte NULL.
3. `credits/`, `entitlements/`, `offers/`, `payments/`, `providers/`, kanıt servisleri `git diff 2a8c25b8..HEAD`'de yok.
4. `campaign-engine-isolation.spec.ts`: beş akış, ACTIVE adaylar varken, ledger yalnız akışın kendi satırını yazar.
5. Tam API suite'i (mevcut `credits-integrity`, `lemon-squeezy-webhook`, `unviewed-offer-refund`, `provider-claim`… dâhil) yeşil.

## 8. Açıkta kalan S2B maddeleri

`CreditTransactionType += CAMPAIGN_GRANT/EXPIRY/REVOKE` + grant ledger satırı (repository `createRedemptionAndLot` öncesi)
+ `grantTransactionId` NOT NULL'a çekme; hook'lar: `updateProviderStatus` → `runSerializable` + `evaluate` +
`onProviderFact(PROVIDER_APPROVED)`, webhook/mock settle → `evaluate(PACKAGE_PAYMENT_SUCCEEDED)`, e-posta/telefon PROVIDER
yazıcıları → `onProviderFact` (`// CMP-002 fact callback` noktaları) ve `FactSourceRegistry.writers` kayıtları; `CampaignsModule`
export'u; `PromoCreditLotConsumption` + resolver lot tüketimi (en erken dolacak önce) + iade geri yazımı; expiry süpürücü +
`campaignLotExpirySchedulerEnabled`; aktivasyon/pause/end uçları + `activeVersionId` yazıcısı + `FACT_SOURCE_UNAVAILABLE` /
`LIMIT_BELOW_CONSUMED` + `CampaignAuditAction` genişletme; `campaignEngineEnabled` toggle ucu; K1/K2; sağlayıcı yüzeyi;
`ELIGIBILITY_INCOMPLETE` gözlem log'u (nullable `triggerEventId` gerekirse); admin evaluation/redemption ekranları (S3).
