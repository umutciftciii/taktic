# CMP-001 — Kampanya motoru envanteri + çekirdek tasarım — Teslim Raporu

Tarih: 2026-09-19 · Branch `claude/cmp-001-campaign-engine-inventory-1dea0c` (taban `origin/main` @
`89ba7f22`, temiz worktree doğrulandı) · PR/head/CI §14 · Tasarım notu:
`docs/superpowers/specs/2026-09-19-cmp-001-campaign-engine-design.md`.

Docs-only. Üretim kodu, API, şema/migration, ödeme, kredi, webhook, admin UI, gerçek `.env`, Cloudflare,
deploy, yerel/staging container veya DB verisi **değişmedi**; salt-okunur inceleme dışında veri işlemi
yapılmadı. Merge/deploy/yerel eşitleme yapılmadı.

Ön çalışma belgesi `taktick-kampanya-modulu-on-calismasi.md` repoda, ana checkout'ta, worktree'lerde ve
Spotlight'ta **bulunamadı**; repo dışında olması kararları geçersiz kılmaz — CMP-001 brief'i ve güvenli katalog
yaklaşımı bağlayıcıdır.

**Revizyon 2 (aynı gün, docs-only):** K1 zamanlama hatası düzeltildi (§8), `AUTH-PROVIDER-CONTACT-001`
bağımlılığı tanımlandı (§9), limit/bütçe modeli genelleştirildi (§10), dilimler ve release sırası
güncellendi (§11). Değişen kararlar §12'de. **Revizyon 3 (aynı gün, docs-only):** olay kimliği ↔ redemption
tekilliği ayrımı ve `EXCLUSIVE_CREDIT_BONUS` stack/conflict sözleşmesi (§13).

---

## 1. Mevcut kredi/ödeme akış haritası (özet; kanıtlar tasarım notu §1)

| Akış | Bugün | Kanıt |
| --- | --- | --- |
| Bakiye | Tek koşulu bakiye = son `ProviderCreditTransaction.balanceAfter`; lot/son-kullanma yok; `balanceAfter<0` yasak | `credits.service.ts:303-355` |
| Defter yazıcıları (5) | `OFFER_SPEND` (resolver), `PACKAGE_PURCHASE` (Lemon webhook + mock), `OFFER_REFUND` (48s worker + manuel admin), `ADMIN_GRANT/DEDUCT` | `entitlement-resolver.service.ts:220`, `payments-webhook.service.ts:554`, `package-purchases.service.ts:290`, `offers.service.ts:956`, `credits.service.ts:277-301` |
| Harcama sırası | vitrin ücretsiz → CATEGORY_UNLIMITED → MONTHLY_QUOTA (koşullu decrement) → bakiye → 402; tamamı `runSerializable` | `entitlement-resolver.service.ts:94-230`, `providers.service.ts:1181-1362` |
| Checkout | PROVIDER rolü, `PackagePurchase` PENDING + unique `paymentReference` → Lemon; adapter hatası → FAILED | `payments.service.ts:88-197` |
| Webhook | HMAC ham byte; `order_created(paid)` → tek Serializable tx: kontroller (store/ref/tam tutar/para birimi/variant/`providerOrderId` unique) → PAID → ledger/entitlement; `PROCESSED` terminal, tekrar → duplicate | `lemon-squeezy.webhook.ts:87-107`, `payments-webhook.service.ts:236-308, 346-592` |
| İade/chargeback | `order_refunded` → yalnız `manualReviewReason` bayrağı; kredi/para hareketi yok; `REFUNDED` yazan kod yok; admin yalnız PENDING→CANCELLED/EXPIRED | `payments-webhook.service.ts:652-712`, `package-purchases.service.ts:443-480` |
| Onay | `updateProviderStatus` düz `$transaction`, `approvedAt` üzerine yazılır, onay geçmişi yok | `providers.service.ts:947-1031` |
| Kanıt | `emailVerifiedAt`/`phoneVerifiedAt` yalnız CUSTOMER yollarında yazılır; **sağlayıcı hesabı kanıt kazanamaz** | `email-verification.service.ts:165`, `phone-verification.service.ts:210` |
| Altyapı | Event bus/outbox yok; genel audit log yok (konuya özel tablolar); `@Cron` + `OperationsSettings` anahtarı + in-process kilit; `runSerializable` (3 deneme) | tasarım notu §1.5 |

Akış diyagramı ve altı bağlanma noktası: tasarım notu §1.6.

## 2. Kesin tasarım kararları

1. `Campaign` (durum: DRAFT/ACTIVE/PAUSED/ENDED) + **immutable** `CampaignVersion`; değişiklik = yeni versiyon +
   `activeVersionId` değişimi + audit; redemption versiyon + `rulesSnapshot` taşır.
2. Kural DSL: `schemaVersion:1`, kök `all`, en fazla bir seviye `any` (derinlik ≤ 2, boyut sınırlı), 10 allowlist
   koşul türü + sabit argüman şeması, kapalı hata kodu kümesi; serbest expression **yok**, ham JSON alanı UI'da yok.
3. Tetikleyiciler: olay tetikleyicileri `PROVIDER_APPROVED` (gerçek geçişte, aynı tx; tx `runSerializable`'a
   taşınır) ve `PACKAGE_PAYMENT_SUCCEEDED` (settle'da PAID sonrası, aynı tx) + **uygunluk geçişi**
   `PROVIDER_ELIGIBILITY_REACHED` (allowlist olgu kümesi ilk kez birlikte true olduğunda, sıradan bağımsız,
   ömür boyu bir kez; §8). Inactivity/coupon **v1 modelinde yok**.
4. Tek fayda: süreli promosyon kredi lotu; paket bonusu aynı lotun tetikleyici varyantı.
5. Bakiye tanımı değişmez; lotlar bakiyenin içinde; `balance = paid + Σ lot.remaining` değişmezi; harcama en
   erken dolacak lot → ücretli; koşullu `updateMany` + Serializable, ek kilit yok.
6. Teklif iadesi lot'a döner; lot dolmuşsa aynı tx'te `CAMPAIGN_EXPIRY` ile net sıfır.
7. `order_refunded` → bonus lotun **harcanmamış** kısmı otomatik revoke; harcanmış kısım için borç/mahsup
   **yok** (`spentAtRevoke` + mevcut manuel inceleme bayrağı); `NO_PRIOR_REVOCATION` + `FIRST_SUCCESSFUL_PAID_PURCHASE`
   iade-tekrar-al döngüsünü keser; günlük revoke eşiği aşılırsa otomatik PAUSED.
8. Olay kimliği `triggerEventKey` kampanyadan bağımsız ve yalnız `CampaignTriggerEvent`'te global unique;
   redemption tekilliği `(campaignId, triggerEventKey)`; `EXCLUSIVE_CREDIT_BONUS` (v1 tek politika): aynı
   olayda en yüksek kredi → küçük `priority` → `campaignId`; kaybeden `STACK_CONFLICT`, sayaçları değişmez;
   limit reddinde (savepoint geri) sıradaki aday; farklı olaylar birbirini engellemez (§13).
9. Limitler versiyonda doğrulanmış konfigürasyon (`maxRedemptionsPerProvider` 1–100 zorunlu,
   `maxRedemptionsGlobal`, `maxRedemptionsPerDay`, `budgetCredits`), sayaçlar kampanyada kümülatif, tümü
   koşullu `updateMany` ile aynı tx'te; bütçe **kredi**; revoke/expiry sayaçlara dönmez (§10).
10. Kill switch `OperationsSettings.campaignEngineEnabled` (varsayılan kapalı) + süpürücü anahtarı; sağlayıcı
    yalnız promo bakiye/son kullanma görür; kural, bütçe, diğer kullanıcılar gizli.

## 3. Önerilen veri modeli

Enum'lar: `CampaignStatus, CampaignTrigger, CampaignEligibilityFact, CampaignBenefitType, CampaignStackPolicy,
CampaignRedemptionStatus, CampaignRevokeReason, PromoCreditLotStatus, CampaignEvaluationOutcome,
CampaignAuditAction`;
`CreditTransactionType += CAMPAIGN_GRANT, CAMPAIGN_EXPIRY, CAMPAIGN_REVOKE`.

Modeller: `Campaign` (kümülatif sayaçlar), `CampaignVersion` (unique `[campaignId, versionNumber]`; limit
alanları, `eligibilityFacts` + `factSetKey`), `CampaignTriggerEvent` (unique `triggerEventKey`, immutable olay kaydı, `settledBy*`),
`CampaignRedemption` (unique `[campaignId, triggerEventKey]`, `grantTransactionId`, `promoLotId`; `triggerEventId` FK), `CampaignProviderCounter` (unique `[campaignId, providerId]`),
`CampaignDailyCounter` (unique `[campaignId, day]`), `PromoCreditLot` (unique `redemptionId`, CHECK
`0 ≤ remaining ≤ granted`), `PromoCreditLotConsumption` (unique `[lotId, creditTransactionId]`),
`CampaignEvaluationLog` (unique **değil**; olay × aday × değerlendirme), `CampaignAuditLog`, `OperationsSettings`
iki yeni Boolean. Cascade silme yok. Tam tablo: tasarım notu §3.

## 4. En riskli geri alma/harcama kararı

Paket iadesinde **harcanmış bonus geri alınmaz** (borç/mahsup yok). Gerekçe: `balanceAfter<0` yasak,
borç modeli yok, mevcut ürün ilkesi "iade insan kararı". Telafi: harcanmamış kısım otomatik revoke, harcanan
miktar kayıt + manuel inceleme bayrağı, `NO_PRIOR_REVOCATION` ile gelecekteki bonus kapanır, eşik aşımında
kampanya otomatik durur; K2 bu koşullar olmadan açılmaz. İkinci risk — promo ile harcanıp süre dolduktan sonra
gelen 48s iadesi — aynı tx'te expire ile kapatıldı.

## 5. CMP-002 dilimleri

Güncel tablo ve release sırası §11; özet: S0 kural çekirdeği → S1 tanım (**migration A**) → S2 hak ediş/lot/
sayaç/harcama/expiry (**migration B**) → S3 reversal/revoke + denetim → S4 sağlayıcı yüzeyi → S5 E2E +
fingerprint; paralelde **AUTH-PROVIDER-CONTACT-001** (CMP-002 dışı).

## 6. İlk iki beta kampanyası

- **K1** uygunluk geçişi `PROVIDER_ELIGIBILITY_REACHED{PROVIDER_APPROVED, EMAIL_VERIFIED, PHONE_VERIFIED}` +
  `NO_PRIOR_REVOCATION` → 10 kredi / 30 gün; `maxRedemptionsPerProvider 1, maxRedemptionsGlobal 1000,
  maxRedemptionsPerDay 100, budgetCredits 10000`; `stackPolicy EXCLUSIVE_CREDIT_BONUS, priority 10`. Release
  kapısı: AUTH-PROVIDER-CONTACT-001 (§9).
- **K2** `PACKAGE_PAYMENT_SUCCEEDED`: `OFFER_PACKAGE ∧ ONE_TIME_CREDITS ∧ FIRST_SUCCESSFUL_PAID_PURCHASE ∧
  MIN_PAID_AMOUNT 50000 kuruş ∧ NO_PRIOR_REVOCATION` → 5 kredi / 60 gün; `maxRedemptionsPerProvider 1,
  maxRedemptionsGlobal 2000, budgetCredits 10000`; `stackPolicy EXCLUSIVE_CREDIT_BONUS, priority 20`; pencere
  2026-10-01 → 2026-12-31. Kapı: S3 revoke.

JSON'lar: tasarım notu §7.

## 7. Kapsam dışı

Checkout indirimi, ücretsiz vitrin, referral, müşteri indirimi, yorum/kalite ödülü, coupon, scheduled
inactivity, para bazlı bütçe, borç/mahsup, Lemon iade çağrısı, kademeli admin rolü,
`maxRedemptionsPerBusiness` (kanonik işletme kimliği yok), `taxNumber` tekilleştirme, çok-instance scheduler
kilidi, expiry/revoke e-postaları, geriye dönük uygunluk taraması. Sağlayıcı kanıt akışı ayrı iş:
AUTH-PROVIDER-CONTACT-001 (§9).

## 8. Düzeltilen K1 zamanlama hatası

İlk taslak K1'i `PROVIDER_APPROVED` **olayı** + anlık `EMAIL_VERIFIED ∧ PHONE_VERIFIED` koşulu olarak
yazmıştı: onay anında kanıt eksikse olay bir daha üretilmez ve kampanya hiç hak edilmez. Düzeltme (tasarım
notu §8): genel bir **uygunluk geçişi** tetikleyicisi `PROVIDER_ELIGIBILITY_REACHED` + allowlist
`CampaignEligibilityFact {PROVIDER_APPROVED, EMAIL_VERIFIED, PHONE_VERIFIED}` + `FactSourceRegistry` (olgu →
kanonik `read` + kayıtlı yazıcılar). Her olgu yazıcısı kendi tx'inin son adımında `onProviderFact` çağırır;
motor tüm olguları kanonik kaynaktan yeniden okur; hepsi true ise
`triggerEventKey = PROVIDER_ELIGIBILITY_REACHED:<factSetKey>:<providerId>` (zaman damgasız → ömür boyu
bir kez) ile `CampaignRedemption` unique'ine yazar. Aynı kanıtın tekrar yazımı (guard'lı `updateMany`),
askı→yeniden onay, admin retry, webhook tekrarı → aynı campaign+event için `ALREADY_REDEEMED` (okuma; P2002
savepoint'li backstop), tetikleyici tx commit eder (§13).
Onay kanıta bağlı **değildir**; eksiklik yalnız uygunluğu (`ELIGIBILITY_INCOMPLETE`) engeller. Geriye dönük
tarama yok. Validator `PROVIDER_APPROVED` + `EMAIL/PHONE_VERIFIED` bileşimini `USE_ELIGIBILITY_TRIGGER` ile
reddeder. K1 JSON'u buna göre güncellendi (§6).

## 9. `AUTH-PROVIDER-CONTACT-001` bağımlılığı

Bağımsız iş; CMP-002'nin parçası değil. Kaynak yalnız `User.emailVerifiedAt` / `User.phoneVerifiedAt` (ikinci
alan yok). Bugünkü CUSTOMER-only noktalar: `auth.controller.ts:98/107` (yalnız register-customer doğrulama
başlatır), `auth/email-verification.controller.ts:32-36` → `email-verification.service.ts:165`
(`role !== CUSTOMER` → sessiz return), yazıcı `:132-133`, `customer-activation.service.ts:440-441`,
`phone-verification.service.ts:210-218` (CUSTOMER + kendi talebi), `account.controller.ts:40-42` +
`account.service.ts:121` (numara değişiminde atomik sıfırlama, CUSTOMER), `providers.service.ts:1624,1629`
(profil iletişimi; `User`'a dokunmaz). Sözleşme (tasarım notu §9.2): sağlayıcı kendi e-postasını gerçek
teslimle, telefonunu SMS OTP ile (mevcut `PhoneVerification` kuralları, talebe bağlı olmayan yeni amaç)
doğrular; admin link/token/claim/invite/onay kanıt yaratmaz; `User.email/phone` değişince ilgili kanıt aynı
statement'ta `NULL`; CUSTOMER akışları ve telefon gate'i gerilemez; kanıtsız sağlayıcı hesabı tam
kullanılır, yalnız K1 uygun olmaz. **Release kapısı mekaniktir:** `activate`, olguların her biri için
`FactSourceRegistry`'de `role=PROVIDER` yazıcısı yoksa `FACT_SOURCE_UNAVAILABLE` ile reddeder; K1 bu iş
main'e girip yazıcılarını kaydedene kadar ACTIVE edilemez. Altyapı (S0–S5) bundan bağımsız kurulur.

## 10. Genelleştirilmiş limit/bütçe sözleşmesi

`perProvider=1` sabiti kaldırıldı. `CampaignVersion`: `maxRedemptionsPerProvider` (1–100, zorunlu),
`maxRedemptionsGlobal?` (≤1M), `maxRedemptionsPerDay?` (≤100k), `budgetCredits?` (≤10M);
`maxRedemptionsPerBusiness` v1'de yok (kanonik işletme kimliği yok). Sayaçlar kampanya düzeyinde kümülatif
(`Campaign.redemptionCount/budgetConsumedCredits`, `CampaignProviderCounter`, `CampaignDailyCounter`);
versiyon değişimi sayaç sıfırlamaz. Tüketim sırası, hepsi tetikleyici tx'inde koşullu `updateMany`:
per-provider → günlük → global+bütçe → grant; tx dışı ön kontrol yok. Yarışta Serializable retry + koşullu
`WHERE`; limit reddi HTTP hatası değil `EvaluationLog` sonucu (`PER_PROVIDER_LIMIT/DAILY_LIMIT/GLOBAL_LIMIT/
BUDGET_EXHAUSTED`), sonraki aday denenir; çağırana `CONCURRENT_MODIFICATION` yalnız mevcut yolların
davrandığı gibi. PAUSED/ENDED aday değildir, sayaç değişmez. Muhasebe: `budgetConsumedCredits =
Σ redemption.grantedCredits` (her durumda); `grantedCredits` grant anındaki versiyonun `benefitCredits`'i,
redemption `campaignVersionId + rulesSnapshot` ile değişmez; lot `remaining` bütçeyi etkilemez. Düşük limitli
yeni versiyon `LIMIT_BELOW_CONSUMED` uyarısıyla kabul edilir (yeni grant üretmez).

## 11. Güncel CMP-002 dilimleri ve release sırası

| Dilim | Migration | Kapı |
| --- | --- | --- |
| S0 kural çekirdeği + `FactSourceRegistry` arayüzü | yok | — |
| S1 tanım tabloları + admin API/UI (activate kapıları) | **A** | — |
| S2 hak ediş + sayaçlar + lot + harcama + expiry süpürücü + kill switch | **B** | — |
| S3 reversal/revoke + denetim ekranları + otomatik PAUSE | yok | **K2 ≥ S3** |
| S4 sağlayıcı yüzeyi + grant maili | yok | — |
| S5 E2E + fingerprint + runbook | yok | merge öncesi |
| AUTH-PROVIDER-CONTACT-001 (paralel, CMP-002 dışı) | yok | **K1 ≥ S3 + bu iş** |

## 12. Bu revizyonda değişen kararlar

1. Üçüncü tetikleyici sınıfı `PROVIDER_ELIGIBILITY_REACHED` + `CampaignEligibilityFact` + `FactSourceRegistry`;
   `PROVIDER_APPROVED` + kanıt koşulu bileşimi validasyonda reddedilir.
2. `AUTH-PROVIDER-CONTACT-001` tanımlandı; K1 için mekanik release kapısı (`FACT_SOURCE_UNAVAILABLE`).
3. `perProvider` sabiti → dört doğrulanmış limit + kümülatif sayaçlar; `CampaignRedemption
   @@unique([campaignId, providerId])` kaldırıldı, yerine `CampaignProviderCounter` koşullu artırım.
4. `CampaignEvaluationLog.triggerEventKey` artık unique değil (olgu başına değerlendirme).
5. Limit reddinde sonraki aday kampanya denenir (önce: değerlendirme biterdi).
6. Dilim sırası: reversal (S3) sağlayıcı yüzeyinden (S4) önce; K2 kapısı S3.
7. K1 JSON'u uygunluk geçişi modeline uyarlandı; `FIRST_PROVIDER_APPROVAL` K1'den çıktı (anahtar zaten tekil).

## 13. Revizyon 3 — olay kimliği, redemption tekilliği, stack/conflict

**Hata:** revizyon 2 `CampaignRedemption.triggerEventKey`'i global unique yapmıştı; anahtar bir olaydır ve
aynı olay birden çok kampanyanın adayı olabilir — ilk değerlendirilen kampanya diğerlerini sıralamaya bakmadan
engellerdi.

**Kimlikler (tasarım notu §12.2):** olay = immutable `CampaignTriggerEvent{triggerEventKey @unique, trigger,
providerId, purchaseId?, factSetKey?, firstSeenAt, lastSeenAt, evaluationCount, settledByCampaignId?,
settledRedemptionId? @unique, settledAt?}`; anahtar kampanyadan bağımsız, global idempotent
(`PROVIDER_ELIGIBILITY_REACHED:<factSetKey>:<providerId>` vb.). Hak ediş = `CampaignRedemption
@@unique([campaignId, triggerEventKey])` + `triggerEventId` FK + `campaignVersionId/rulesSnapshot/grantedCredits`
snapshot; versiyon değişimi aynı campaign+event için ikinci satır üretmez. K1 ömür boyu tek = sağlayıcı
başına tek uygunluk olayı + campaign+event unique + `maxRedemptionsPerProvider=1`. Aynı sağlayıcı, farklı
olay, aynı kampanya → per-provider limit izin verirse yeni redemption.

**Stack/conflict (§12.3):** `CampaignVersion.stackPolicy = EXCLUSIVE_CREDIT_BONUS` (v1 tek değer) +
`CampaignVersion.priority` (int 1–1000; validator `STACK_POLICY_INVALID`, `PRIORITY_INVALID`; serbest ifade
yok). Aynı olayın adayları: en yüksek `benefit.credits` → küçük `priority` → `campaignId`. Kaybedenler
`EvaluationLog{STACK_CONFLICT, winnerCampaignId}`, sayaç/bütçeleri değişmez. Kazanan limitte reddedilirse
sıradaki aday kazanır. Farklı olaylar bağımsız. ADDITIVE stack v1'de yok (gerekenler listelendi, ertelendi).

**Transaction (§12.4):** tek Serializable tetikleyici tx'i: olay kaydı (oku/insert) → engine anahtarı → olay
settled mi (kazanan `ALREADY_REDEEMED`, diğerleri `EVENT_ALREADY_SETTLED`) → adaylar + koşullar (kanonik
okuma) → sıralama → aday başına `SAVEPOINT`: redemption var mı → sayaçlar (per-provider → günlük →
global+bütçe, koşullu) → grant + lot + redemption + `settledBy` → kalanlara `STACK_CONFLICT`. Ret →
`ROLLBACK TO SAVEPOINT`, sıradaki aday. Sayaç/bütçe/lot yalnız kazanan için ve yalnız bu tx'te değişir;
kaybeden/limit/paused değerlendirmeleri yalnız log. Birincil idempotency okuma; P2002 savepoint'li backstop
ve **yalnız aynı campaign+event** için `ALREADY_REDEEMED`. `PROVIDER_ELIGIBILITY_REACHED` düzeltmesi ve
AUTH-PROVIDER-CONTACT-001 kapısı aynen.

**Örnekler (§12.6):** aynı olayda K1 (10 kredi) ve K3 (5 kredi, aynı olgu kümesi) → K1 kazanır, K3
`STACK_CONFLICT`; K1 bütçesi doluysa K1 `BUDGET_EXHAUSTED` (savepoint geri) → K3 kazanır. Farklı olaylarda
K1 (uygunluk) + K2 (ödeme) aynı sağlayıcıya iki ayrı grant; K2 ikinci satın alma `maxRedemptionsPerProvider=1`
ile `PER_PROVIDER_LIMIT`, 3 olsaydı grant.

## 14. PR / head / CI

PR [#94](https://github.com/umutciftciii/taktic/pull/94) · revizyon 1 head `26dba7a6` CI 3/3
([run 35398916651](https://github.com/umutciftciii/taktic/actions/runs/35398916651)) · revizyon 2 head
`5db4a398` CI 3/3 ([run 35440525199](https://github.com/umutciftciii/taktic/actions/runs/35440525199)) ·
**revizyon 3 tasarım head `60f6c7c9` CI 3/3** ([run](https://github.com/umutciftciii/taktic/actions/runs/35443255039): typecheck · lint · test · build, e2e chromium,
e2e webkit). Bu satırı ekleyen rapor commit'i PR'ın nihai head'idir; CI sonucu PR'da.
