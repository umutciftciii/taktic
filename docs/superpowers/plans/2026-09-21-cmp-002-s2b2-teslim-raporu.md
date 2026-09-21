# CMP-002 S2B2 — Teslim raporu (rev. 3: hata-izolasyonu + faz-A dayanıklılık düzeltmesi dâhil)

Tarih: 2026-09-21 · Branch: `claude/cmp-002-s2b2-lifecycle-hooks-3f7a2c` · Taban: `origin/main` @ `1cc6c6ca` (temiz worktree
doğrulandı) · Tasarım notu: `docs/superpowers/specs/2026-09-21-cmp-002-s2b2-lifecycle-hooks-design.md` (rev. 2) · Dry-run kayıtları:
`…-s2b2-migration-dryrun.txt` (Migration D), `…-s2b2-migration-e-dryrun.txt` (Migration E) · Bağlayıcı sözleşme: CMP-001 (rev. 3).

PR: https://github.com/umutciftciii/taktic/pull/99 (açık; **merge önerilmez** — nihai head CI'ı §6'da) · rev. 1 head `e00b87c9`
(CI 35588381023 3/3) · rev. 2 kod head'i `5c21fd31` (CI 35597614424 3/3) · **rev. 3 kod head'i `232146c0`** · Rev. 1'in "ENGINE_ERROR → 409
`CAMPAIGN_ENGINE_FAILED` → ana transaction rollback" davranışı **kaldırıldı** (rev. 2, iki aşamalı akış); rev. 2'nin faz-A "JS hatası →
savepoint geri + iş commit" fallback'i **kaldırıldı** (rev. 3): PENDING event durable olmadan iş tx'i commit edemez.

Merge, deploy, yerel/staging eşitlemesi, gerçek `.env`, Cloudflare, Lemon ayarı veya gerçek veri işlemi **yapılmadı**. Geçici DB'ler
(`taktic_cmp002_s2b2_dryrun`, `taktic_cmp002_s2b2r2_dryrun`, `taktic_cmp002s2b2_e2e`) yalnız bu iş için oluşturuldu ve düşürüldü; yerel
`taktic` DB'sine komut yok.

---

## 1. Teslim edilen

| Katman | Dosya | İçerik |
| --- | --- | --- |
| Migration D | `prisma/migrations/20260921120000_add_campaign_lifecycle_audit_actions/` | `CampaignAuditAction += ACTIVATED, VERSION_ACTIVATED, PAUSED, RESUMED, ENDED` — yalnız 5 `ALTER TYPE … ADD VALUE` |
| **Migration E (rev. 2)** | `prisma/migrations/20260921150000_add_campaign_event_evaluation_state/` (+ `schema.prisma`) | `CampaignTriggerEventStatus {PENDING, PROCESSING, EVALUATED, SETTLED, RETRY_WAIT}`; `CampaignTriggerEvent += status (default PENDING), attemptCount (0), lastAttemptAt?, nextAttemptAt (default now), leaseUntil?, claimedAt?, lastErrorCode?, lastErrorAt?`; index `(status, nextAttemptAt)`; CHECK `attemptCount >= 0`, `(status='SETTLED') = (settledRedemptionId IS NOT NULL)`. **Yalnız additive:** DML/backfill/DROP/ALTER COLUMN yok; `triggerEventKey` global unique ve settled alanlar değişmedi |
| Motor modülü | `campaigns/engine/campaign-engine.module.ts`, `campaign-engine.hooks.ts`, **`campaign-evaluation.worker.ts` (rev. 2)**, `campaigns.module.ts` | `CampaignEngineModule` yalnız Prisma import eder; export: `CampaignEngineHooks` (stage A), `FactSourceRegistry` (aktivasyon kapısı), `CampaignEvaluationWorker` (stage B; admin API kuyruğu salt-okunur okur). `CampaignEngineService`/repository export edilmez, public uç yok |
| Stage A hook'ları | `campaign-engine.hooks.ts` + `providers.service.ts`, `email-verification.service.ts`, `phone-verification.service.ts`, `payments-webhook.service.ts`, `package-purchases.service.ts` (+ modüller) | İş tx'inin son adımında, motor açıksa yalnız `ensurePendingEvent`; değerlendirme yok. **Rev. 3:** event durable olmadan oluşan **her** hata (JS/DB/doğrulama) → `503 CAMPAIGN_EVENT_NOT_DURABLE`, iş tx'i rollback; savepoint/fallback/`HOOK_ERROR` yok; P2034 → replay. `updateProviderStatus` ve e-posta `confirm` `runSerializable`'a taşındı |
| Stage B worker | `campaign-evaluation.worker.ts`, `common/scheduler-cron.ts` (`CAMPAIGN_EVALUATION_RETRY_CRON`, varsayılan `*/1 * * * *`), `.env.example`, `docker-compose.yml`, `test/setup-env.ts` (testte yılda bir dakika) | `@Cron` tick → `runOnce`: anahtar kapalı → claim yok; `claimDueEvent` (`UPDATE … WHERE id=(SELECT … FOR UPDATE SKIP LOCKED) → PROCESSING, lease 5 dk, attemptCount+1`) → kendi `runSerializable` tx'inde `engine.evaluate` → SETTLED/EVALUATED/RETRY_WAIT; lease token guard'lı `finishClaim`; backoff `min(60 s × 2^(n−1), 6 saat)` |
| Grant (rev. 1) | `campaign-engine.service.ts`, `campaign-engine.repository.ts` | `createRedemption` + S2B1 `grantPromoCreditLot` (CAMPAIGN_GRANT ledger → lot → `grantTransactionId`); `settleEvent` artık `status=SETTLED`'ı settled kolonlarıyla aynı statement'ta yazar |
| Registry | `fact-source-registry.ts` | dinamik yazıcı kaydı (`onModuleInit`), kaynak = 3 olgu + `PACKAGE_PAYMENT_SUCCEEDED` |
| Yaşam döngüsü | `campaigns.service.ts`, `admin-campaigns.controller.ts`, `dto/campaign-transition.dto.ts`, `rules/errors.ts`, `rules/catalog.ts`, `packages/shared/campaign-rules.json` | `activateVersion/pause/resume/end`; kapı: engine anahtarı (`CAMPAIGN_ENGINE_DISABLED`), DSL, pencere, `FACT_SOURCE_UNAVAILABLE`, `LIMIT_BELOW_CONSUMED`; `evaluationQueue` (rev. 2, salt-okunur) liste + detay yanıtlarında |
| Admin UI | `apps/admin/app/campaigns/*`, `lib/api.ts`, `lib/campaign-rules.ts`, `globals.css` | yaşam döngüsü paneli; motor kapalıyken "**Kampanya motoru kapalı — etkinleştirme yapılamaz**"; rev. 2: motor rozetinde salt-okunur kuyruk satırı (bekleyen/işlenen/yeniden deneme + son hata kodu). **Motoru açan düğme, manuel retry yok** |
| Testler | `test/campaign-engine-hooks.spec.ts` (34; rev. 3 sınıf-1 matrisi dâhil), `test/admin-campaign-lifecycle.spec.ts` (12), `campaign-engine.spec.ts` (30), `campaign-engine-schema.spec.ts` (+1 rev. 2), `campaign-engine-isolation.spec.ts` (7), `admin-campaigns.spec.ts`, `admin/test/campaign-rules.spec.ts`, `e2e/tests/admin-campaign-lifecycle.spec.ts` | §4–5 |

**Değiştirilmeyen sözleşmeler (git diff kanıtı):** `credits/promo-credit-ledger.ts` (grant/consume/refund/expiry/revoke primitive'leri),
`PromoCreditLotConsumption`, `CampaignRedemption.grantTransactionId` ve `@@unique([campaignId, triggerEventKey])`, `entitlement-resolver`,
`offers` refund yolu, `operations-settings` (PATCH DTO'sunda `campaignEngineEnabled` yok; `SCHEDULER_JOB_KEYS` değişmedi), CUSTOMER telefon
yolu (`verifyCode`), mevcut scheduler'lar, gerçek `.env`/compose değerleri (compose'a yalnız `CAMPAIGN_EVALUATION_RETRY_CRON` default'u eklendi).

## 2. İki aşamalı akış ve değişen hook'lar

```
Stage A — iş tx'i (runSerializable), guard'lı yazım count===1 sonrası, son adım
  motor kapalı → settings SELECT'i dışında hiçbir şey (event bile yok)
  motor açık   → ensurePendingEvent(<deterministic key>) : yeni → PENDING insert (savepoint; P2002 → re-read)
                                                            EVALUATED → PENDING (yeniden değerlendir) · SETTLED/PROCESSING/RETRY_WAIT → yalnız lastSeenAt
  hata (her tür, event durable olmadan) → 503 CAMPAIGN_EVENT_NOT_DURABLE, iş rollback · P2034 → replay   (savepoint/fallback yok — rev. 3)
Stage B — CampaignEvaluationWorker (cron tick; testte runOnce)
  motor kapalı → skipped ENGINE_DISABLED, claim yok
  claim (SKIP LOCKED + lease) → tx: lease bizde mi? → eligibility olgularını yeniden oku → engine.evaluate
    granted → SETTLED (settleEvent) · değil → EVALUATED · ENGINE_ERROR → log{ENGINE_ERROR}, RETRY_WAIT(backoff, lastErrorCode)
    catch: P2034 tükendi → RETRY_WAIT{CONCURRENT_MODIFICATION} · diğer → RETRY_WAIT{WORKER_ERROR} · lease kaybı → LEASE_LOST (hiç yazı yok)
```

| Kaynak | Yazıcı → hook (stage A) | Ne zaman | Tx |
| --- | --- | --- | --- |
| `PROVIDER_APPROVED` | `updateProviderStatus` → `providerApproved` → PENDING `PROVIDER_APPROVED:<p>` + tamamlanan fact-set'ler için PENDING eligibility | yalnız gerçek geçişte, vitrin yerleşimleri sonrası | `runSerializable` (**yeni**) |
| `EMAIL_VERIFIED` | `EmailVerificationService.confirm` → `accountFactProven` | `proven.count===1 && role===PROVIDER`, token kapatma sonrası | `runSerializable` (**yeni**) |
| `PHONE_VERIFIED` | `verifyAccountCode` → `accountFactProven` | `proven.count===1` sonrası | `runSerializable` (mevcut) |
| `PACKAGE_PAYMENT_SUCCEEDED` | webhook `settle` → `packagePaymentSucceeded` | PAID sonrası, `recordAttempt(PROCESSED)` **öncesi**; her iki kind | `runSerializable` (mevcut) |
| `PACKAGE_PAYMENT_SUCCEEDED` | mock settle → aynı hook | PAID sonrası (yalnız `PAYMENT_PROVIDER=mock`) | `runSerializable` (mevcut) |

**Commit/rollback matrisi (rev. 3):**

| Sınıf | Hata nerede | İş yazımı | Event | Yanıt | Sonra |
| --- | --- | --- | --- | --- | --- |
| Motor kapalı | — | commit | yok | normal | — |
| **1 — event durable değil** | ensure öncesi/sırası (fact okuma, insert…); JS/DB/doğrulama ayrımı yok | **rollback** | 0 | `503 CAMPAIGN_EVENT_NOT_DURABLE` / webhook non-2xx, purchase PENDING, PROCESSED 0 | aynı istek tekrar → tek PENDING event → worker tek grant |
| 1' — P2034 | ensure sırasında | replay | — | replay / 409 | — |
| **2 — event durable** | worker: evaluator/config/stack/bütçe/grant | **commit, dokunulmaz** | `RETRY_WAIT{kod}` + PII'siz log | (verilmiş) | lease/backoff ile aynı event, hata kalkınca tek grant |

**Event state tablosu:** `PENDING` (raise edildi) → `PROCESSING` (lease'li claim) → `SETTLED` (grant; terminal, re-raise dokunmaz) |
`EVALUATED` (grant yok; re-raise → PENDING) | `RETRY_WAIT` (`nextAttemptAt`, `lastErrorCode` ∈ {ENGINE_ERROR, CONCURRENT_MODIFICATION,
WORKER_ERROR}; süresi gelince yeniden claim; asla terminal-unutulmuş olmaz; lease süresi dolan PROCESSING yeniden claim edilir).

## 3. Webhook garantisi ve yaşam döngüsü

Webhook **2xx** ⇔ ödeme (PAID + ledger) ve **PENDING event aynı transaction'da** commit'lendi; `PROCESSED` işareti değerlendirme hatasıyla
asla geri alınmaz (event RETRY_WAIT kalır, worker retry eder). Duplicate teslim PROCESSED kısa devresine takılır; aynı `triggerEventKey`
iki kez üretilemez. DB hatasıyla event yazılamazsa 503 → PAID/PROCESSED yok → Lemon yeniden teslim eder.

Yaşam döngüsü tablosu ve kapı (tasarım notu §2) rev. 1 ile aynı; kanıt `admin-campaign-lifecycle.spec.ts` (12 test, değişmedi).

## 4. Hata-izolasyonu ve gerçek engine kanıtı (`campaign-engine-hooks.spec.ts`, 34 test; anahtar yalnız test DB'de true)

| Senaryo | Sonuç |
| --- | --- |
| K1 — onay/e-posta/telefon **6 permütasyon** | ilk iki olguda K1 event'i yok; üçüncüde yalnız PENDING event(ler) — redemption/lot/log/CAMPAIGN_* ledger/counter 0; `runOnce` → SETTLED, tek redemption + lot + `CAMPAIGN_GRANT +5`, bakiye 5; ikinci `runOnce` claim 0 |
| Askı → yeniden onay + tekrar kaydetme | motor snapshot'ı **eşit** (yeni satır yok), K1 event'i SETTLED kaldı; worker sonrası hâlâ 1 redemption/lot/ledger |
| Onay kanıt olmadan | profil APPROVED; yalnız `PROVIDER_APPROVED` event'i → worker EVALUATED, `NO_CANDIDATE` |
| CUSTOMER e-posta kanıtı | `emailVerifiedAt` yazıldı, snapshot eşit (event yok) |
| **Webhook** | 200 processed; PAID + PROCESSED + PENDING event birlikte; grant öncesi redelivery → duplicate, event 1; worker SETTLED, ledger `[+25, +10]`; grant sonrası redelivery → duplicate, snapshot eşit; ikinci order → mismatched |
| Mock settle | PENDING → worker tek grant; aynı purchase'a ikinci mock-pay 409; ikinci satın alma EVALUATED `CONDITIONS_FAILED` |
| **Sınıf 1 matrisi (rev. 3) — 5 yol × `ensurePendingEvent` içinde zorlanan TypeError:** onay, e-posta kanıtı, telefon kanıtı, webhook, mock settle | her yolda 503 `CAMPAIGN_EVENT_NOT_DURABLE`; iş yazımı **rollback** (profil PENDING_REVIEW + onay maili yok / `emailVerifiedAt` null + token tüketilmedi / `phoneVerifiedAt` null + kod tüketilmedi / purchase PENDING + PROCESSED 0 + ledger 0); event/log/redemption/lot/grant 0; aynı istek tekrar (aynı token/kod, yeniden teslim) → iş yazımı + **tek PENDING event** → worker **tek grant** |
| Sınıf 1 — ensure öncesi hata (`readAll` TypeError, telefon kanıtı) | 503, `phoneVerifiedAt` null, event 0 → aynı kodla tekrar → PENDING → grant |
| Sınıf 1 — DB hatası (P2003 simülasyonu, webhook) | 503, purchase PENDING, PROCESSED 0, event 0 → yeniden teslim 200 + PENDING |
| **Onay + evaluator hatası** | profil APPROVED, onay maili gitti; worker → `ENGINE_ERROR`, event RETRY_WAIT{attempt 1, ENGINE_ERROR}, `nextAttemptAt` > +30 s, EvaluationLog `{ENGINE_ERROR, reasonCode ENGINE_ERROR}`; grant/lot/ledger/counter 0; vadesi gelmeden claim 0; 2. deneme yine ENGINE_ERROR (attempt 2); tanım düzeltilince 3. deneme SETTLED, tam grant, loglar `[ENGINE_ERROR, ENGINE_ERROR, GRANTED]` |
| **E-posta + telefon kanıtı + evaluator hatası** | kanıtlar yerinde, event RETRY_WAIT; düzeltme sonrası SETTLED |
| **Webhook + mock + evaluator hatası** | PAID/PROCESSED yerinde, bakiye 25, event RETRY_WAIT; duplicate teslim → duplicate, event 1, grant 0; retry SETTLED tek grant; mock aynı |
| Bir adaydaki hata diğer adaya kazandırmaz | zengin aday bozuk → ENGINE_ERROR, fakir adayın sayaçları 0; düzeltilince zengin kazanır, fakir `STACK_CONFLICT` |
| Worker'da P2034 tükenmesi / düz hata | RETRY_WAIT{CONCURRENT_MODIFICATION} / {WORKER_ERROR}, log 0, grant 0; sonra SETTLED |
| **4 eşzamanlı worker** (4 ayrı instance) | toplam claim 1, tek SETTLED, attemptCount 1 |
| **4 eşzamanlı onay** | tek PENDING event, profil APPROVED, 200/409 `CONCURRENT_MODIFICATION`; worker tek grant |
| **4 eşzamanlı webhook** | 1 processed, 1 `PaymentWebhookEvent`, 1 event, 1 grant |
| Lease | canlı lease atlanır (claim 0); dolan lease yeniden claim (attempt 2) ve SETTLED |
| Lease devralınırsa | `LEASE_LOST`, hiçbir yazı yok |
| **Restart** | PENDING + RETRY_WAIT event'ler ikinci uygulama instance'ında `runOnce` ile 2 SETTLED |
| Stack / bütçe reddi / K1+K2 bağımsız / PAUSED | rev. 1 ile aynı sonuçlar, worker üzerinden |
| **Anahtar kapalı** | önceki açık dönemden kalan PENDING event varken: onay + kanıtlar + mock settle → event yok, `runOnce` = `{skipped: ENGINE_DISABLED, claimed 0}`, snapshot yalnız PACKAGE_PURCHASE ledger satırı kadar değişti, eski event PENDING/attempt 0 kaldı |

`campaign-engine.spec.ts` (motor doğrudan, 30): grant sonrası event SETTLED; ledger/lot/redemption eşitlikleri; önceki senaryolar aynen.
`campaign-engine-schema.spec.ts` (+1): yeni CHECK'ler (`settled_status_matches` iki yönlü, `attemptCount_nonnegative`), varsayılanlar.

## 5. Kapalı-motor sıfır-etki matrisi (`campaign-engine-isolation.spec.ts`, hook'lar bağlı)

| Gerçek yol | Yazılan | Kampanya/event/log/lot/sayaç/CAMPAIGN_* ledger |
| --- | --- | --- |
| Sağlayıcı onayı | profil | 0 |
| PROVIDER e-posta + telefon kanıtı | `User.*VerifiedAt` | 0 |
| Lemon webhook settle (ONE_TIME) | PAID + PACKAGE_PURCHASE + PROCESSED | 0 |
| Mock settle (dönem) | entitlement | 0 |
| Teklif harcaması / iadesi | OFFER_SPEND / OFFER_REFUND | 0 |
| activate / resume | — (409) | 0 |
| pause / end | Campaign.status + Audit | 0 |
| Worker tick (kalan PENDING event varken bile) | — (`ENGINE_DISABLED`) | 0 |

## 6. Test ve derleme sonuçları

| Adım | Sonuç |
| --- | --- |
| `pnpm typecheck` / `pnpm lint` / `pnpm build` | ✅ |
| `pnpm test` | ✅ api **145 dosya / 3261 test**, admin 5/64, shared 6/168 |
| E2E Chromium (izole `taktic_cmp002s2b2_e2e`) | ✅ **286 passed** (8.0 dk) — `admin-campaign-lifecycle` dahil |
| E2E WebKit | ✅ **117 passed** (3.9 dk) |
| Migration D dry-run | ✅ 69 migration, diff boş, yalnız 5 `ALTER TYPE` |
| **Migration E dry-run** | ✅ 70 migration, diff boş; `CampaignTriggerEvent` eski 12 kolon tür/default aynı + 8 yeni kolon; ifade türleri: 1 CREATE TYPE, 3 ALTER TABLE (8 ADD COLUMN, 2 CHECK), 1 CREATE INDEX — DML/DROP/ALTER COLUMN 0 |
| CI (rev. 2 kod head'i `5c21fd31`, run 35597614424) | ✅ 3/3 |
| CI (rev. 3 kod head'i `232146c0`) | rapor push'undan sonra başlayan run; nihai sonuç PR'da ve bu satırda güncellenir |

## 7. Motor açmak S4'e kadar teknik olarak mümkün değil (değişmedi)

`campaignEngineEnabled` yazıcısı yok (`grep -rn campaignEngineEnabled apps/api/src` → yalnız okuyucular: settings servisi, motor, hooks,
worker, campaigns servisi); `operations-settings` PATCH DTO'sunda alan yok; seed yok; admin UI'da düğme yok. Anahtar kapalıyken kampanya
ACTIVE olamaz, hook event bile yazmaz, worker claim yapmaz; üretimde `activeVersionId` dolu kampanya yok. Karar: **anahtar S4 tamamlanmadan
açılmayacak.**

## 8. S3/S4 sınırları ve açık noktalar

- S3: `order_refunded` → `revokePromoCreditLot`, admin revoke ucu, otomatik PAUSE eşiği, redemption/evaluation ekranları; kuyruk için
  manuel retry ucu (bu PR'da yok, yalnız salt-okunur sayaç).
- S4: refund mailinde net tutar, admin ledger `CAMPAIGN_*` etiketleri, sağlayıcı promo satırı, grant maili; ardından toggle ucu (ayrı karar).
- Lot expiry süpürücüsü (`PromoCreditLotExpiryService`) hâlâ cron/anahtar olmadan durur (S2B1 gibi); bu PR'daki worker yalnız kampanya
  değerlendirme retry'ıdır.
- Hak ediş gecikmesi ≤ bir worker tick'i (varsayılan 1 dk); commit sonrası anlık "kick" bilinçli olarak yok (determinist test, çok-instance).
- `ELIGIBILITY_INCOMPLETE` artık worker'da (olay varken) loglanabilir; stage A'da eksik küme için olay üretilmez (S2A kararı korunur).
