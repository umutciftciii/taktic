# CMP-002 S2B2 — Kampanya yaşam döngüsü, gerçek tetikleyici noktaları, idempotent değerlendirme ve grant

Tarih: 2026-09-21 · Taban: `origin/main` @ `1cc6c6ca` (CMP-002 S2B1 merge, temiz worktree doğrulandı) ·
Branch: `claude/cmp-002-s2b2-lifecycle-hooks-3f7a2c` · Bağlayıcı sözleşme: CMP-001 (rev. 3) §2.1, §2.3, §3.5–3.6, §8, §10, §12 ·
Önceki dilimler: S0/S1 (`2026-09-19-cmp-002-s0-s1-campaign-drafts-design.md`), S2A (`…-s2a-engine-infrastructure-design.md`),
S2B1 (`2026-09-20-cmp-002-s2b1-promo-credit-accounting-design.md`) ·
**Revizyon 2 (aynı gün, aynı PR):** hata-izolasyonu düzeltmesi — ilk revizyonun "ENGINE_ERROR → 409 → ana transaction rollback"
kararı (eski D2) **kaldırıldı**; hook'lar iki aşamaya ayrıldı (§1a, §4a–4c), Migration E (§4b). **Revizyon 3 (aynı PR):** faz-A
dayanıklılık kuralı düzeltildi — rev. 2'nin "JS hatası → savepoint geri + iş commit" fallback'i **kaldırıldı** (D2a, §4a, §4d).

Bu dilim motoru **gerçek olaylara bağlar** ve kampanyaya **yaşam döngüsü** verir. Motor anahtarını (`campaignEngineEnabled`)
açan hiçbir uç, UI ya da seed **yoktur**; anahtar kapalıyken (bugün her gerçek ortam) hiçbir gerçek yol kampanya/hak ediş/lot/
ledger satırı yazmaz ve hiçbir kampanya ACTIVE'e geçirilemez. Motor açmanın S4'e (net iade bildirimi) kadar teknik olarak
mümkün olmadığı §8'de gösterilir.

---

## 1. Kararlar (çelişki çözümleri, gerekçeli)

| # | Karar | Gerekçe |
| --- | --- | --- |
| D1 | **Modül ayrımı:** motor `CampaignEngineModule` (yalnız `PrismaModule` import eder; `CampaignEngineHooks` + `FactSourceRegistry` export eder), admin API `CampaignsModule` (AuthModule + CampaignEngineModule). Domain modülleri (providers, email-verification, phone-verification, payments, package-purchases) **yalnız** `CampaignEngineModule` import eder. | `AuthModule → EmailVerificationModule` bağı var; `CampaignsModule` AuthModule'e bağımlı olduğundan e-posta modülü onu import etseydi döngü oluşurdu. Dar facade "kampanya modülünü yalnız gerekli internal servislerin kullanabileceği biçimde dışa aç" gereğini yapısal kılar: `CampaignEngineService`/repository export edilmez, public uç yok. |
| D2 (rev. 2) | **İki aşamalı hook; motor hatası ana işlemi asla geri almaz.** Stage A (iş tx'i içinde): motor açıksa yalnız deterministik `CampaignTriggerEvent`'i **PENDING** olarak ensure et — kural, bütçe, stack, grant değerlendirilmez. Stage B (`CampaignEvaluationWorker`, cron tick, kendi Serializable tx'i): lease'li claim → `engine.evaluate` → SETTLED / EVALUATED / RETRY_WAIT. ENGINE_ERROR: EvaluationLog `{ENGINE_ERROR, reasonCode}` (PII'siz), `lastErrorCode`, backoff; onay/kanıt/ödeme çoktan commit'lenmiştir. Rev. 1'in `409 CAMPAIGN_ENGINE_FAILED` + rollback kararı kaldırıldı. | Görev tanımı (rev. 2): "değerlendirme hatası hiçbir zaman onay/kanıt/ödeme/mock settle'ı 409 ile geri almayacak; hak ediş olayı da kaybolmayacak". Dayanıklı PENDING satırı ikisini birden sağlar. |
| D2a (rev. 3) | **Stage A dayanıklılık kuralı:** motor açıkken iş tx'i **yalnız** deterministik PENDING event aynı tx'te ensure edilmişse commit edebilir. PENDING event durable olmadan oluşan **her** hata — JS/TypeError, doğrulama, serialization, DB — ayrım yapılmadan yayılır → iş tx'i geri alınır, `503 CAMPAIGN_EVENT_NOT_DURABLE` (webhook non-2xx → yeniden teslim; onay/kanıt tekrar denenir, aynı token/kod geçerli kalır). P2034 yayılır → `runSerializable` yeniden oynatır. Savepoint fallback'i, genel `catch`, `HOOK_ERROR` sonucu **yok**. Motor kapalıyken önceki sıfır-etki (event bile yok). | Rev. 2'deki "JS hatası → iş commit" yolu, hata event yazılmadan oluşursa "iş işlendi ama hak ediş olayı kesin kayıp" demekti (worker'ın alacağı satır yok) — sessiz-kayıp yasağını ihlal ediyordu. Faz A kampanya kuralı/stack/limit/bütçe/grant çalıştırmadığından kampanya tanımı kaynaklı hata faz A'ya taşınamaz; faz A'daki tek hata sınıfı "event yazılamadı"dır ve doğru yanıt rollback + retry'dır. |
| D3 | **Çakışma/retry (stage A):** `CampaignEngineWriteConflict` (P2034) hook'tan geçer, çağıranın `runSerializable`'ı iş tx'ini yeniden oynatır; bütçe biterse 409 `CONCURRENT_MODIFICATION`. `updateProviderStatus` ve `EmailVerificationService.confirm` bu yüzden `runSerializable`'a taşındı. Webhook committed-state'ten karar verir. **Stage B:** P2034 tükenirse event `RETRY_WAIT{CONCURRENT_MODIFICATION}`; başka hata `RETRY_WAIT{WORKER_ERROR}`; hiçbir hata event'i terminal-unutulmuş yapmaz. | CMP-001 §2.3, §10.3; rev. 2 "transient conflict retryable, event kalıcı kaybolmaz". |
| D4 | **Grant sırası** (aday savepoint'i altında): sayaçlar (provider/gün/global+bütçe, koşullu `updateMany`) → `CampaignRedemption` → S2B1 `grantPromoCreditLot` (CAMPAIGN_GRANT ledger → `PromoCreditLot` → `grantTransactionId`) → `CampaignTriggerEvent.settled*` → log satırları. `createRedemptionAndLot` kaldırıldı, `createRedemption` + primitive; `grantPromoCreditLot` sözleşmesi **değişmedi**. | Görev tanımı sırası; tek ledger yazıcısı S2B1 primitive'i. |
| D5 | **FactSourceRegistry dinamik kayıt:** yazıcı servisler `onModuleInit`'te `hooks.registerFactWriter(source, {module, role: PROVIDER})` çağırır. Kaynak kümesi olgular + `PACKAGE_PAYMENT_SUCCEEDED`. Aktivasyon kapısı `hasProviderWriter` okur. | "Kayıtlı yazıcı" = boot etmiş ve hook'u çağıran modül; statik liste bir yorumdan farksız olurdu. Tetikleyici de kapıdan geçer ("kullanılan trigger/fact koşullarının yazıcıları kayıtlı"). |
| D6 | **Aktivasyon kapısı reddeder, uyarmaz:** `LIMIT_BELOW_CONSUMED` (global/bütçe/provider-max/bugünkü gün sayacı < tüketilen) ve `FACT_SOURCE_UNAVAILABLE` 400 `CAMPAIGN_ACTIVATION_REFUSED{errors[]}` ile reddeder; eşit değer kabul edilir (yeni grant üretmez, sayaç kümülatif). Pencere sonu geçmişse `WINDOW_INVALID`; tanım bugünkü validator+katalogdan yeniden geçirilir (`UNKNOWN_PACKAGE_SLUG` vb.). Hepsi yazımdan önce, aynı Serializable tx içinde. | Görev tanımı CMP-001 §10.4'teki "uyarı" yerine doğrulama ister. |
| D7 | **Revizyon ACTIVE/PAUSED kampanyada da kaydedilir** (`currentVersionId` ilerler, `activeVersionId` değişmez); ENDED'de `409 CAMPAIGN_ENDED` (S1'deki `CAMPAIGN_NOT_DRAFT` kodu bu koda dönüştü). Çalışan kural yalnız `activate` ile değişir. | CMP-001 §2.1 "değişiklik yeni versiyon ile ilerler". |
| D8 | `activate(:versionNumber)`: DRAFT→ACTIVE (`VERSION_ACTIVATED`+`ACTIVATED`), ACTIVE'de sürüm değişimi (`VERSION_ACTIVATED`), PAUSED'da değişim+devam (`VERSION_ACTIVATED`+`RESUMED`). `resume` mevcut `activeVersionId` ile aynı kapıdan geçer. `pause`/`end` motor anahtarına bakmaz, gerekçe (3–500) zorunlu, audit `summary.reason`. `activatedAt/pausedAt/endedAt` kolonu eklenmedi; zaman damgası audit satırında. | Tek additive migration (enum), kolon yok. |
| D9 | Paket olayı **her iki kind** (OFFER_PACKAGE ve SHOWCASE_PACKAGE) için, purchase PAID yazıldıktan sonra, webhook `settle()` ve mock settle'ın aynı noktasında üretilir; kind filtresi DSL koşuludur (`PURCHASE_KIND_IN`). | Katalog `PURCHASE_KIND_IN`'i açıkça sunar; motor kind'a göre olay gizlemez. |
| D10 | E-posta hook'u yalnız `proven.count === 1 && user.role === PROVIDER` iken, tokenları kapatan `updateMany`'den **sonra** (tx'in son adımı) çağrılır; hook profil yoksa `NOT_A_PROVIDER_FACT` döner. CUSTOMER telefon yolu (`verifyCode`) dokunulmadı. | Görev: "CUSTOMER veya admin kanıtı provider fact'i üretmez"; AUTH-PROVIDER-CONTACT-001 §6. |
| D11 (rev. 2) | **Event durumu = son raise'in işlenme durumu.** Re-raise (askı→yeniden onay, aynı kanıt) `EVALUATED` event'i **PENDING**'e döndürür (yeniden değerlendirilir), `SETTLED`'a dokunmaz (grant var, anahtar ömür boyu tek), `PROCESSING/RETRY_WAIT/PENDING`'de yalnız `lastSeenAt`. `settleEvent` `status=SETTLED`'ı settled kolonlarıyla **aynı statement**'ta yazar (CHECK `settled_status_matches`). | Rev. 1'deki "re-raise → ALREADY_REDEEMED logu" stage A'da yazı yasağıyla çelişir; settled event için yeniden değerlendirme gereksizdir. Motorun `ALREADY_REDEEMED`/`EVENT_ALREADY_SETTLED` semantiği doğrudan `evaluate` çağrısı için korunur. |
| D12 (rev. 2) | **Worker tetiklemesi yalnız cron** (`CAMPAIGN_EVALUATION_RETRY_CRON`, varsayılan `*/1 * * * *`; testte yılda bir dakikaya sabitlenir). Commit sonrası in-process "kick" yok. Operations toggle yok: worker `campaignEngineEnabled` false ise **claim bile yapmaz**. `SCHEDULER_JOB_KEYS`'e eklenmedi (admin scheduler ekranına satır/kolon eklememek için). | Determinist test (kick yarışı yok), çok-instance güvenliği claim'de; üretimde anahtar false → worker fiilen etkisiz. Hak ediş gecikmesi ≤ bir tick. |

## 2. Yaşam döngüsü tablosu

| Kaynak → Hedef | Uç | Motor anahtarı | Kapı | Audit |
| --- | --- | --- | --- | --- |
| DRAFT → ACTIVE | `POST /admin/campaigns/:id/versions/:n/activate` | **açık şart** (`409 CAMPAIGN_ENGINE_DISABLED`) | DSL + pencere + fact-writer + limit | `VERSION_ACTIVATED`, `ACTIVATED` |
| ACTIVE → ACTIVE (sürüm değişimi) | aynı uç | açık şart | aynı | `VERSION_ACTIVATED` (`previousActiveVersionNumber`) |
| ACTIVE → PAUSED | `POST …/pause {reason}` | bakmaz | — | `PAUSED{reason}` |
| PAUSED → ACTIVE | `POST …/resume {reason}` | açık şart | aynı kapı, mevcut `activeVersionId` | `RESUMED{reason}` |
| PAUSED → ACTIVE (sürüm değişimi) | activate | açık şart | aynı | `VERSION_ACTIVATED`, `RESUMED` |
| ACTIVE/PAUSED → ENDED | `POST …/end {reason}` | bakmaz | — | `ENDED{reason}` |
| ENDED → * | — | — | `409 CAMPAIGN_INVALID_TRANSITION`; revizyon `409 CAMPAIGN_ENDED` | — |
| DRAFT → PAUSED/ENDED, ACTIVE → resume, PAUSED → pause | — | — | `409 CAMPAIGN_INVALID_TRANSITION` | — |

Kampanya satırı kilidi (`update updatedAt`) + `runSerializable`: eşzamanlı iki operatör serileşir; ikinci, yeniden oynatılınca güncel durumu görür (4 eşzamanlı activate → tek `ACTIVATED`).

## 3. Fact-writer matrisi

| Kaynak | Kanonik yazıcı (guard'lı `updateMany`/geçiş) | Hook | Tx | Kayıt (`onModuleInit`) |
| --- | --- | --- | --- | --- |
| `PROVIDER_APPROVED` | `ProvidersService.updateProviderStatus`, `dto.status===APPROVED && existing.status!==APPROVED` | `providerApproved(tx, id)` → PENDING `PROVIDER_APPROVED:<p>` + tamamlanan her fact-set için PENDING eligibility event (rev. 2: yalnız event, değerlendirme worker'da) | `runSerializable` (yeni) | `providers` / PROVIDER |
| `EMAIL_VERIFIED` | `EmailVerificationService.confirm` (`WHERE id, email=snapshot, emailVerifiedAt IS NULL`), rolden bağımsız tek yazıcı | `accountFactProven(tx, userId, EMAIL_VERIFIED)` yalnız `count===1 && role===PROVIDER` | `runSerializable` (yeni) | `email-verification` / PROVIDER |
| `PHONE_VERIFIED` | `PhoneVerificationService.verifyAccountCode` (`WHERE id, phone, phoneVerifiedAt IS NULL`) | `accountFactProven(tx, user.id, PHONE_VERIFIED)` `count===1` sonrası | `runSerializable` (mevcut) | `phone-verification` / PROVIDER |
| `PHONE_VERIFIED` (CUSTOMER, `verifyCode`) | — | **yok** | — | — |
| `PACKAGE_PAYMENT_SUCCEEDED` | `PaymentsWebhookService.settle` (HMAC, store, referans, tutar, para birimi, variant, PENDING, providerOrderId sonrası PAID) | `packagePaymentSucceeded(tx, providerId, purchaseId)` PAID'den sonra, `recordAttempt(PROCESSED)`'den **önce** | `runSerializable` (mevcut) | `payments-webhook` / PROVIDER |
| `PACKAGE_PAYMENT_SUCCEEDED` | `PackagePurchasesService.mockPayProviderPurchase` (yalnız `PAYMENT_PROVIDER=mock`) | aynı, PAID'den sonra | `runSerializable` (mevcut) | `package-purchases-mock` / PROVIDER |

Her callback olguları DB'den yeniden okur (`FactSourceRegistry.readAll`); üçü ilk kez birlikte doğruysa tek olay
`PROVIDER_ELIGIBILITY_REACHED:<factSetKey>:<providerId>` PENDING yazılır (zaman damgasız → ömür boyu bir kez); worker değerlendirmeden
önce olguları bir kez daha okur (eksikse `ELIGIBILITY_INCOMPLETE` log'u, EVALUATED).

## 4. Webhook garantisi (rev. 2)

```
teslim → HMAC (401, 0 yazı) → runSerializable:
  PROCESSED? → duplicate (salt okuma)                       ← aynı olayın her sonraki teslimi; hook çalışmaz, event key zaten var
  settle: kontroller → PAID + PACKAGE_PURCHASE ledger → [stage A: ensurePendingEvent(PACKAGE_PAYMENT_SUCCEEDED:<purchaseId>)]
        motor kapalı → hiçbir şey (settings SELECT'i dışında)
        P2034 → tüm tx yeniden oynatılır (3 deneme)
        DB hatası (event yazılamadı) → 503 CAMPAIGN_EVENT_NOT_DURABLE → tx geri alınır (PAID yok, PROCESSED yok) → Lemon yeniden teslim eder
  recordAttempt(PROCESSED) → commit → makbuz
catch: P2002 → committed state'ten yanıt; CONCURRENT_MODIFICATION → PROCESSED yoksa 409 yeniden fırlat
sonra (cron tick): worker event'i claim eder → evaluate → SETTLED (grant) | EVALUATED | RETRY_WAIT
```

Garanti: webhook **2xx** döner ⇔ ödeme (PAID, ledger) ve **PENDING event aynı transaction'da** commit'lendi. Değerlendirme
hatası ödemeyi ve PROCESSED'ı asla geri almaz (event RETRY_WAIT kalır, retry eder). Duplicate teslim PROCESSED kısa devresine
takılır; aynı `triggerEventKey` iki kez üretilemez (global unique + `ensurePendingEvent` re-read). Test kanıtı: (a) bozuk tanım →
teslim 200 processed, worker `ENGINE_ERROR` → event RETRY_WAIT, PAID/PROCESSED yerinde, duplicate teslim → duplicate, event 1, grant 0
→ düzeltme → retry SETTLED, tek grant; (b) `ensurePendingEvent` DB hatası → 503, purchase PENDING, PROCESSED 0, event 0 → yeniden
teslim 200 + PENDING event ("ödeme işlendi ama olay kayboldu" imkânsız); (c) 4 eşzamanlı teslim → 1 processed, 1 event, 1 grant.

### 4a. İki aşamalı akış

```
Stage A (iş tx'i, runSerializable; her kanonik yazıcının son adımı, guard'lı updateMany count===1 sonrası)
  isEnabled(tx)? hayır → dön (sıfır yazı)
  PROVIDER_APPROVED  : ensurePendingEvent(PROVIDER_APPROVED:<p>) + her ACTIVE fact-set için olguları yeniden oku → tamamsa ensurePendingEvent(ELIGIBILITY:<set>:<p>)
  EMAIL/PHONE_VERIFIED: profil PROVIDER değilse NOT_A_PROVIDER_FACT; fact-set'ler → tamamsa ensurePendingEvent
  PACKAGE_PAYMENT    : ensurePendingEvent(PACKAGE_PAYMENT_SUCCEEDED:<purchase>)
  herhangi bir hata (JS/DB/doğrulama) → 503 CAMPAIGN_EVENT_NOT_DURABLE, iş tx'i rollback | P2034 → replay   (savepoint/fallback yok)
Stage B (CampaignEvaluationWorker.runOnce, cron)
  isEnabled()? hayır → skipped ENGINE_DISABLED (claim yok)
  döngü: claimDueEvent (UPDATE … WHERE id=(SELECT … FOR UPDATE SKIP LOCKED) → PROCESSING, leaseUntil=now+5dk, attemptCount+1)
    runSerializable:
      lease hâlâ bizde mi? (status=PROCESSING ∧ leaseUntil=token) değilse LEASE_LOST (hiçbir şey commit etmez)
      ELIGIBILITY: olguları yeniden oku → eksikse log ELIGIBILITY_INCOMPLETE, EVALUATED
      engine.evaluate → CAMPAIGN_ENGINE_DISABLED → PENDING'e bırak | ENGINE_ERROR → log{ENGINE_ERROR}, RETRY_WAIT(backoff) | granted → SETTLED (settleEvent yazdı) | değil → EVALUATED
    catch: P2034 tükendi → RETRY_WAIT{CONCURRENT_MODIFICATION}; diğer → RETRY_WAIT{WORKER_ERROR} (finishClaim lease guard'lı)
```

### 4b. Event state tablosu (Migration E, yalnız additive)

| Durum | Anlam | Giriş | Çıkış |
| --- | --- | --- | --- |
| `PENDING` | raise edildi, değerlendirilmedi | stage A insert; `EVALUATED` re-raise; worker anahtar kapalı görürse | claim → PROCESSING |
| `PROCESSING` | bir worker lease'li çalışıyor (`leaseUntil`, `claimedAt`, `attemptCount+1`) | claim | SETTLED / EVALUATED / RETRY_WAIT / PENDING; lease dolarsa yeniden claim |
| `SETTLED` | grant var (`settledByCampaignId/settledRedemptionId/settledAt` ile aynı statement; CHECK) | `settleEvent` | terminal (re-raise dokunmaz) |
| `EVALUATED` | değerlendirildi, grant yok (NO_CANDIDATE, CONDITIONS_FAILED, limit, PAUSED, ELIGIBILITY_INCOMPLETE…) | worker | re-raise → PENDING |
| `RETRY_WAIT` | deneme başarısız; `nextAttemptAt`, `lastErrorCode` (ENGINE_ERROR / CONCURRENT_MODIFICATION / WORKER_ERROR), `lastErrorAt` | worker | `nextAttemptAt` gelince claim; asla terminal-unutulmuş olmaz |

Kolonlar: `status`, `attemptCount`, `lastAttemptAt`, `nextAttemptAt` (default now), `leaseUntil`, `claimedAt`, `lastErrorCode`, `lastErrorAt`;
index `(status, nextAttemptAt)`; CHECK `attemptCount >= 0`, `(status='SETTLED') = (settledRedemptionId IS NOT NULL)`.
`triggerEventKey` global unique, `CampaignRedemption @@unique([campaignId, triggerEventKey])`, settled alanlar değişmedi. DML/backfill/DROP/ALTER COLUMN yok.

### 4d. Faz-A hata tablosu — commit/rollback matrisi (rev. 3)

| Sınıf | Ne zaman | Örnek | İş yazımı (onay/kanıt/PAID+PROCESSED) | Event | Yanıt | Sonraki adım |
| --- | --- | --- | --- | --- | --- | --- |
| Motor kapalı | her zaman | — | **commit** | yok (sıfır etki) | normal | — |
| **1 — event durable değil** | ensure öncesi/sırası: fact-set okuma, olgu okuma, anahtar üretimi, insert | TypeError, Prisma P2003, doğrulama | **rollback** | 0 | `503 CAMPAIGN_EVENT_NOT_DURABLE` (webhook non-2xx) | aynı istek tekrar: yeniden teslim / tekrar onay / aynı token-kod → tek PENDING event → worker tek grant |
| 1' — serialization | ensure sırasında P2034 | eşzamanlı aynı key | replay (`runSerializable`) | — | replay sonrası normal / 409 `CONCURRENT_MODIFICATION` | replay aynı key'i okur/yazar |
| **2 — event durable** | PENDING commit'lendikten sonra: worker/evaluator/config/stack/bütçe/grant | bozuk tanım, P2034 tükenmesi, worker hatası | **commit (dokunulmaz)** | `RETRY_WAIT{ENGINE_ERROR / CONCURRENT_MODIFICATION / WORKER_ERROR}` + PII'siz log | (iş yanıtı çoktan verildi) | lease/backoff ile sonraki denemede aynı event; hata kalkınca tek grant |

Faz A'da kampanya kuralı, stack, limit, bütçe ya da grant **çalışmaz**; dolayısıyla kampanya tanımı kaynaklı hiçbir hata sınıf 1'e düşemez.

### 4c. Retry/lease algoritması

Backoff `min(60 s × 2^(attemptCount−1), 6 saat)`; lease 5 dk; batch 50/tick; claim SQL tek statement (`FOR UPDATE SKIP LOCKED`) → çok instance
güvenli; süresi dolan lease (`PROCESSING ∧ leaseUntil < now`) yeniden claim edilir (ölen worker); lease token guard'ı (`finishClaim WHERE
leaseUntil = token`) + Serializable, devralınan denemenin sonucunun üstüne yazmayı engeller. Uygulama yeniden başlayınca durum DB'de olduğundan
ilk tick kaldığı yerden devam eder. Aynı event iki kez grant üretemez: `settled` kısa devresi + `(campaignId, key)` unique + `settledRedemptionId`
unique + savepoint'li aday döngüsü (S2A). Bir adaydaki hata diğer adaya kazandırmaz: deneme bütünüyle geri alınır, stack sırası sonraki
denemede yeniden hesaplanır.

## 5. Stack ve limit sırası (motor, değişmedi; artık ledger'lı)

Aday sırası `benefitCredits desc, priority asc, campaignId asc`. Her aday `SAVEPOINT cmp_candidate`: provider sayacı → gün sayacı →
global+bütçe (koşullu `updateMany`) → redemption → CAMPAIGN_GRANT → lot → link → settled. Ret → `ROLLBACK TO` + log (`PER_PROVIDER_LIMIT/
DAILY_LIMIT/GLOBAL_LIMIT/BUDGET_EXHAUSTED`), sıradaki aday. Kazanan sonrası kalanlar `STACK_CONFLICT{winner}`; sayaç/bütçe/redemption/
lot/ledger yazmazlar. Aynı campaign+event → `ALREADY_REDEEMED`; settled event'te diğer adaylar → `EVENT_ALREADY_SETTLED`. Ön kontrol yok.

## 6. Kapalı motor sıfır-etki matrisi (`campaign-engine-isolation.spec.ts`, hook'lar bağlı, DRAFT+ACTIVE kampanyalar varken)

| Gerçek yol | Yazılan | Kampanya/olay/log/lot/sayaç/ledger CAMPAIGN_* |
| --- | --- | --- |
| Sağlayıcı onayı (PATCH status) | profil | 0 |
| E-posta + telefon kanıtı (PROVIDER) | `User.*VerifiedAt` | 0 |
| Lemon webhook settle (ONE_TIME) | PAID + PACKAGE_PURCHASE | 0 |
| Mock settle (dönem paketi) | entitlement | 0 |
| Teklif harcaması / iadesi | OFFER_SPEND / OFFER_REFUND | 0 |
| `activate` / `resume` | — (409 `CAMPAIGN_ENGINE_DISABLED`) | 0 (Campaign/Audit dâhil) |
| `pause` / `end` | Campaign.status + Audit | 0 |
| Worker tick (`runOnce`) — motor açıkken kalmış PENDING event'ler varken bile | — (`skipped: ENGINE_DISABLED`, claim yok) | 0 |

Motor kapalıyken hook'ların tek maliyeti `OperationsSettings` satırının tek bir SELECT'idir (S2A D1 korunur); event satırı dahi yazılmaz.

## 7. Admin UI

Motor rozeti (liste + detay) salt-okunur değerlendirme kuyruğu satırı taşır: bekleyen/işlenen/yeniden deneme sayıları ve son kapalı hata
kodu (`evaluationQueue`); manuel retry ya da toggle düğmesi yok.
Detay: "Çalışan kural — sürüm N" kartı (sayaçlar), "Son kayıtlı tanım / Bekleyen revizyon" kartı, sürüm tablosunda `(çalışan)`/`(son)`
ve `data-active`, yaşam döngüsü paneli (`campaign-lifecycle-panel`): motor kapalıyken **"Kampanya motoru kapalı — etkinleştirme
yapılamaz"** metni + `Etkinleştir`/`Devam ettir` devre dışı; `Duraklat`/`Sonlandır` gerekçeyle her zaman; ENDED'de düğme ve revizyon
formu yok. Audit etiketleri beş yeni aksiyon + gerekçe. Liste: durum, çalışan/son sürüm, hak ediş sayısı. Motor rozeti: kapalı →
"etkinleştirme yapılamaz"; açık → "değerlendirilir ve … yazılır". **Motoru açan düğme yok.**

## 8. Motor açmanın S4'e kadar teknik olarak mümkün olmaması

`OperationsSettings.campaignEngineEnabled` yazıcısı: `operations-settings` PATCH DTO'sunda alan yok, kampanya modülünde yazıcı yok,
seed yok (`grep -rn campaignEngineEnabled apps/api/src` → yalnız okuyucular: `campaign-engine-settings.service.ts`,
`campaign-engine.service.ts`, `campaigns.service.ts`). Tek yazım yolu test fixture'ı (`setEngineEnabled`) ve E2E fixture'ıdır.
Anahtar kapalıyken: hiçbir kampanya ACTIVE'e geçemez (§2), motor hiçbir satır yazmaz (§6). Anahtar sonradan elle açılsa bile üretimde
`activeVersionId` dolu kampanya yoktur (S2A D2; bu dilim onu yalnız motor açıkken yazar) → aday kümesi boştur.

## 9. S3/S4 sınırları (bu dilimde yok)

`order_refunded` → revoke ve admin revoke ucu, otomatik PAUSE eşiği, redemption/evaluation ekranları (S3); refund mailinde net tutar,
admin ledger `CAMPAIGN_*` etiketleri, sağlayıcı promo satırı (S4); scheduler/cron ile expiry (`PromoCreditLotExpiryService` olduğu
gibi), engine toggle ucu/UI, seed, K1/K2 gerçek veri.
