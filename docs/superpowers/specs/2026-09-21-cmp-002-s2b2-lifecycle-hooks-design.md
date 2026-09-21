# CMP-002 S2B2 — Kampanya yaşam döngüsü, gerçek tetikleyici noktaları, idempotent değerlendirme ve grant

Tarih: 2026-09-21 · Taban: `origin/main` @ `1cc6c6ca` (CMP-002 S2B1 merge, temiz worktree doğrulandı) ·
Branch: `claude/cmp-002-s2b2-lifecycle-hooks-3f7a2c` · Bağlayıcı sözleşme: CMP-001 (rev. 3) §2.1, §2.3, §3.5–3.6, §8, §10, §12 ·
Önceki dilimler: S0/S1 (`2026-09-19-cmp-002-s0-s1-campaign-drafts-design.md`), S2A (`…-s2a-engine-infrastructure-design.md`),
S2B1 (`2026-09-20-cmp-002-s2b1-promo-credit-accounting-design.md`).

Bu dilim motoru **gerçek olaylara bağlar** ve kampanyaya **yaşam döngüsü** verir. Motor anahtarını (`campaignEngineEnabled`)
açan hiçbir uç, UI ya da seed **yoktur**; anahtar kapalıyken (bugün her gerçek ortam) hiçbir gerçek yol kampanya/hak ediş/lot/
ledger satırı yazmaz ve hiçbir kampanya ACTIVE'e geçirilemez. Motor açmanın S4'e (net iade bildirimi) kadar teknik olarak
mümkün olmadığı §8'de gösterilir.

---

## 1. Kararlar (çelişki çözümleri, gerekçeli)

| # | Karar | Gerekçe |
| --- | --- | --- |
| D1 | **Modül ayrımı:** motor `CampaignEngineModule` (yalnız `PrismaModule` import eder; `CampaignEngineHooks` + `FactSourceRegistry` export eder), admin API `CampaignsModule` (AuthModule + CampaignEngineModule). Domain modülleri (providers, email-verification, phone-verification, payments, package-purchases) **yalnız** `CampaignEngineModule` import eder. | `AuthModule → EmailVerificationModule` bağı var; `CampaignsModule` AuthModule'e bağımlı olduğundan e-posta modülü onu import etseydi döngü oluşurdu. Dar facade "kampanya modülünü yalnız gerekli internal servislerin kullanabileceği biçimde dışa aç" gereğini yapısal kılar: `CampaignEngineService`/repository export edilmez, public uç yok. |
| D2 | **ENGINE_ERROR yutulmaz (CMP-001 §3.5'ten bilinçli sapma).** Motor beklenmeyen hatayı kendi savepoint'ine geri alıp `ENGINE_ERROR` döndürmeye devam eder; ama hook bu yanıtı **fırlatılan** `409 CAMPAIGN_ENGINE_FAILED`'a çevirir → tetikleyici tx geri alınır. Webhook `PROCESSED` yazamaz, Lemon yeniden teslim eder; onay/kanıt yazılmaz, operatör/sahip tekrar dener. Sorumlu kampanyayı duraklatmak/sonlandırmak her zaman mümkündür ve akışı açar (PAUSED aday `parseDefinition` öncesi elenir, ENDED hiç yüklenmez). | Görev tanımı: "ödeme kaydedildi ama kampanya olayı kayboldu / kanıt yazıldı ama hak ediş sessizce atlandı kabul edilmez". ENGINE_ERROR pratikte yalnız DB'ye elle yazılmış bozuk tanım ya da kod hatasıdır; iş sonuçları (koşul, limit, pause) hâlâ HTTP hatası üretmez. |
| D3 | **Çakışma/retry:** `CampaignEngineWriteConflict`/`PromoCreditWriteConflict` (P2034 kodlu) hook'tan geçer, çağıranın `runSerializable`'ı tüm tetikleyici tx'ini (değerlendirme dâhil) yeniden oynatır; bütçe biterse 409 `CONCURRENT_MODIFICATION`. Bunun için `updateProviderStatus` (düz `$transaction` idi) ve `EmailVerificationService.confirm` (düz `$transaction` idi) `runSerializable`'a taşındı; iş kuralı değişmedi. Webhook committed-state'ten karar verir (`reportSettledOrRethrow`): PROCESSED yoksa 409 → yeniden teslim. | CMP-001 §2.3, §10.3; görev tanımı "rollback/retry edilebilir hata". |
| D4 | **Grant sırası** (aday savepoint'i altında): sayaçlar (provider/gün/global+bütçe, koşullu `updateMany`) → `CampaignRedemption` → S2B1 `grantPromoCreditLot` (CAMPAIGN_GRANT ledger → `PromoCreditLot` → `grantTransactionId`) → `CampaignTriggerEvent.settled*` → log satırları. `createRedemptionAndLot` kaldırıldı, `createRedemption` + primitive; `grantPromoCreditLot` sözleşmesi **değişmedi**. | Görev tanımı sırası; tek ledger yazıcısı S2B1 primitive'i. |
| D5 | **FactSourceRegistry dinamik kayıt:** yazıcı servisler `onModuleInit`'te `hooks.registerFactWriter(source, {module, role: PROVIDER})` çağırır. Kaynak kümesi olgular + `PACKAGE_PAYMENT_SUCCEEDED`. Aktivasyon kapısı `hasProviderWriter` okur. | "Kayıtlı yazıcı" = boot etmiş ve hook'u çağıran modül; statik liste bir yorumdan farksız olurdu. Tetikleyici de kapıdan geçer ("kullanılan trigger/fact koşullarının yazıcıları kayıtlı"). |
| D6 | **Aktivasyon kapısı reddeder, uyarmaz:** `LIMIT_BELOW_CONSUMED` (global/bütçe/provider-max/bugünkü gün sayacı < tüketilen) ve `FACT_SOURCE_UNAVAILABLE` 400 `CAMPAIGN_ACTIVATION_REFUSED{errors[]}` ile reddeder; eşit değer kabul edilir (yeni grant üretmez, sayaç kümülatif). Pencere sonu geçmişse `WINDOW_INVALID`; tanım bugünkü validator+katalogdan yeniden geçirilir (`UNKNOWN_PACKAGE_SLUG` vb.). Hepsi yazımdan önce, aynı Serializable tx içinde. | Görev tanımı CMP-001 §10.4'teki "uyarı" yerine doğrulama ister. |
| D7 | **Revizyon ACTIVE/PAUSED kampanyada da kaydedilir** (`currentVersionId` ilerler, `activeVersionId` değişmez); ENDED'de `409 CAMPAIGN_ENDED` (S1'deki `CAMPAIGN_NOT_DRAFT` kodu bu koda dönüştü). Çalışan kural yalnız `activate` ile değişir. | CMP-001 §2.1 "değişiklik yeni versiyon ile ilerler". |
| D8 | `activate(:versionNumber)`: DRAFT→ACTIVE (`VERSION_ACTIVATED`+`ACTIVATED`), ACTIVE'de sürüm değişimi (`VERSION_ACTIVATED`), PAUSED'da değişim+devam (`VERSION_ACTIVATED`+`RESUMED`). `resume` mevcut `activeVersionId` ile aynı kapıdan geçer. `pause`/`end` motor anahtarına bakmaz, gerekçe (3–500) zorunlu, audit `summary.reason`. `activatedAt/pausedAt/endedAt` kolonu eklenmedi; zaman damgası audit satırında. | Tek additive migration (enum), kolon yok. |
| D9 | Paket olayı **her iki kind** (OFFER_PACKAGE ve SHOWCASE_PACKAGE) için, purchase PAID yazıldıktan sonra, webhook `settle()` ve mock settle'ın aynı noktasında üretilir; kind filtresi DSL koşuludur (`PURCHASE_KIND_IN`). | Katalog `PURCHASE_KIND_IN`'i açıkça sunar; motor kind'a göre olay gizlemez. |
| D10 | E-posta hook'u yalnız `proven.count === 1 && user.role === PROVIDER` iken, tokenları kapatan `updateMany`'den **sonra** (tx'in son adımı) çağrılır; hook profil yoksa `NOT_A_PROVIDER_FACT` döner. CUSTOMER telefon yolu (`verifyCode`) dokunulmadı. | Görev: "CUSTOMER veya admin kanıtı provider fact'i üretmez"; AUTH-PROVIDER-CONTACT-001 §6. |

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
| `PROVIDER_APPROVED` | `ProvidersService.updateProviderStatus`, `dto.status===APPROVED && existing.status!==APPROVED` | `providerApproved(tx, id)` → `evaluate(PROVIDER_APPROVED, transition)` + `onProviderFact(PROVIDER_APPROVED)` | `runSerializable` (yeni) | `providers` / PROVIDER |
| `EMAIL_VERIFIED` | `EmailVerificationService.confirm` (`WHERE id, email=snapshot, emailVerifiedAt IS NULL`), rolden bağımsız tek yazıcı | `accountFactProven(tx, userId, EMAIL_VERIFIED)` yalnız `count===1 && role===PROVIDER` | `runSerializable` (yeni) | `email-verification` / PROVIDER |
| `PHONE_VERIFIED` | `PhoneVerificationService.verifyAccountCode` (`WHERE id, phone, phoneVerifiedAt IS NULL`) | `accountFactProven(tx, user.id, PHONE_VERIFIED)` `count===1` sonrası | `runSerializable` (mevcut) | `phone-verification` / PROVIDER |
| `PHONE_VERIFIED` (CUSTOMER, `verifyCode`) | — | **yok** | — | — |
| `PACKAGE_PAYMENT_SUCCEEDED` | `PaymentsWebhookService.settle` (HMAC, store, referans, tutar, para birimi, variant, PENDING, providerOrderId sonrası PAID) | `packagePaymentSucceeded(tx, providerId, purchaseId)` PAID'den sonra, `recordAttempt(PROCESSED)`'den **önce** | `runSerializable` (mevcut) | `payments-webhook` / PROVIDER |
| `PACKAGE_PAYMENT_SUCCEEDED` | `PackagePurchasesService.mockPayProviderPurchase` (yalnız `PAYMENT_PROVIDER=mock`) | aynı, PAID'den sonra | `runSerializable` (mevcut) | `package-purchases-mock` / PROVIDER |

Her callback olguları DB'den yeniden okur (`FactSourceRegistry.readAll`); üçü ilk kez birlikte doğruysa tek olay
`PROVIDER_ELIGIBILITY_REACHED:<factSetKey>:<providerId>` değerlendirilir (zaman damgasız → ömür boyu bir kez).

## 4. Webhook retry semantiği

```
teslim → HMAC (401, 0 yazı) → runSerializable:
  PROCESSED? → duplicate (salt okuma)                       ← aynı olayın 2. teslimi, motor çalışmaz
  settle: kontroller → PAID + PACKAGE_PURCHASE ledger → [hook: evaluate(PACKAGE_PAYMENT_SUCCEEDED:<purchaseId>)]
        iş sonucu (NO_CANDIDATE/CONDITIONS_FAILED/limit/PAUSED/ALREADY_REDEEMED) → log, devam
        P2034 (motor sayaç/ledger çakışması) → tüm tx yeniden oynatılır (3 deneme)
        ENGINE_ERROR → 409 CAMPAIGN_ENGINE_FAILED fırlatılır → tx geri alınır (PAID yok, ledger yok, PROCESSED yok)
  recordAttempt(PROCESSED) → commit → makbuz
catch: P2002 → committed state'ten yanıt; CONCURRENT_MODIFICATION → PROCESSED yoksa 409 yeniden fırlat (Lemon yeniden teslim eder)
```

Sonuç: `PaymentWebhookEvent.status=PROCESSED` **yalnız** kampanya değerlendirmesi aynı tx'te başarıyla tamamlanmışsa yazılır; PROCESSED
görülen olay için motor bir daha çalışmaz; PROCESSED olmayan her yeniden teslim baştan yargılanır ve `(campaignId, triggerEventKey)`
unique'i + settled event ikinci hak edişi engeller. Test: bozuk tanımla 409 → purchase PENDING, sıfır yazı → kampanya pause →
yeniden teslim 200 processed, `CAMPAIGN_PAUSED` log, grant yok. 4 eşzamanlı teslim → 1 processed, 1 grant; kalanlar duplicate/409.

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

Motor kapalıyken hook'ların tek maliyeti `OperationsSettings` satırının tek bir SELECT'idir (S2A D1 korunur).

## 7. Admin UI

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
