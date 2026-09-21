# CMP-002 S2B2 — Teslim raporu

Tarih: 2026-09-21 · Branch: `claude/cmp-002-s2b2-lifecycle-hooks-3f7a2c` · Taban: `origin/main` @ `1cc6c6ca` (temiz worktree
doğrulandı) · Tasarım notu: `docs/superpowers/specs/2026-09-21-cmp-002-s2b2-lifecycle-hooks-design.md` · Dry-run kaydı:
`docs/superpowers/plans/2026-09-21-cmp-002-s2b2-migration-dryrun.txt` · Bağlayıcı sözleşme: CMP-001 (rev. 3).

PR: https://github.com/umutciftciii/taktic/pull/99 (açık; merge yok) · head `e00b87c9` (+ bu rapor güncellemesi) · CI run 35588381023
**3/3 yeşil** (typecheck·lint·test·build 12m27s, e2e chromium 13m53s, e2e webkit 10m44s).

Merge, deploy, yerel/staging eşitlemesi, gerçek `.env`, Cloudflare, Lemon ayarı veya gerçek veri işlemi **yapılmadı**. Geçici DB'ler
(`taktic_cmp002_s2b2_dryrun`, `taktic_cmp002s2b2_e2e`) yalnız bu iş için oluşturuldu ve düşürüldü; yerel `taktic` DB'sine komut yok.

---

## 1. Teslim edilen

| Katman | Dosya | İçerik |
| --- | --- | --- |
| Migration D | `prisma/migrations/20260921120000_add_campaign_lifecycle_audit_actions/` (+ `schema.prisma`) | `CampaignAuditAction += ACTIVATED, VERSION_ACTIVATED, PAUSED, RESUMED, ENDED`. **Yalnız 5 `ALTER TYPE … ADD VALUE`**; tablo/kolon/DML yok. Dry-run: 69 migration, `migrate diff` boş, kolon listeleri değişmedi |
| Motor modülü | `campaigns/engine/campaign-engine.module.ts` (yeni), `campaign-engine.hooks.ts` (yeni), `campaigns.module.ts` | `CampaignEngineModule` yalnız Prisma import eder, `CampaignEngineHooks` + `FactSourceRegistry` export eder; `CampaignEngineService`/repository export edilmez. `CampaignsModule` artık admin API + settings okuyucu |
| Grant | `engine/campaign-engine.service.ts`, `engine/campaign-engine.repository.ts` | `createRedemptionAndLot` → `createRedemption` + S2B1 `grantPromoCreditLot`; `GrantView.grantTransactionId`; sıra: sayaçlar → redemption → CAMPAIGN_GRANT → lot → link → settled → log |
| Registry | `engine/fact-source-registry.ts` | dinamik yazıcı kaydı (`register`, `hasProviderWriter`, `writersOf`), kaynak = 3 olgu + `PACKAGE_PAYMENT_SUCCEEDED` |
| Hook'lar | `providers/providers.service.ts` (+module), `email-verification/email-verification.service.ts` (+module), `phone-verification/phone-verification.service.ts` (+module), `payments/payments-webhook.service.ts` (+module), `package-purchases/package-purchases.service.ts` (+module) | §2 matrisi; `updateProviderStatus` ve e-posta `confirm` `runSerializable`'a taşındı; her yazıcı `onModuleInit`'te kaydolur |
| Yaşam döngüsü | `campaigns/campaigns.service.ts`, `admin-campaigns.controller.ts`, `dto/campaign-transition.dto.ts`, `rules/errors.ts`, `rules/catalog.ts`, `packages/shared/campaign-rules.json` | `activateVersion/pause/resume/end`; kapı: engine anahtarı, DSL, pencere, `FACT_SOURCE_UNAVAILABLE`, `LIMIT_BELOW_CONSUMED`; `CAMPAIGN_ENGINE_DISABLED / CAMPAIGN_INVALID_TRANSITION / CAMPAIGN_ENDED / CAMPAIGN_VERSION_NOT_FOUND / CAMPAIGN_ACTIVATION_REFUSED{errors[]}`; görünümlere `activeVersion`, `activeVersionId`, `redemptionCount`, `budgetConsumedCredits` |
| Admin UI | `apps/admin/app/campaigns/lifecycle-panel.tsx` (yeni), `lifecycle-state.ts` (yeni), `actions.ts`, `[id]/page.tsx`, `page.tsx`, `engine-notice.tsx`, `campaign-definition-form.tsx`, `lib/api.ts`, `lib/campaign-rules.ts`, `globals.css` | yaşam döngüsü paneli; motor kapalıyken "**Kampanya motoru kapalı — etkinleştirme yapılamaz**" + devre dışı etkinleştir/devam ettir; çalışan kural kartı; sürüm tablosunda `(çalışan)/(son)`; audit etiketleri + gerekçe; liste kolonları. **Motoru açan düğme yok** |
| Testler | `test/campaign-engine-hooks.spec.ts` (21, yeni), `test/admin-campaign-lifecycle.spec.ts` (12, yeni), `campaign-engine.spec.ts` (30, ledger'lı), `campaign-engine-isolation.spec.ts` (7), `admin-campaigns.spec.ts`, `admin/test/campaign-rules.spec.ts`, `e2e/tests/admin-campaign-lifecycle.spec.ts` (yeni, Chromium + WebKit testMatch), `admin-campaign-drafts.spec.ts` (etiket güncellemesi) | §4–5 |

**Değiştirilmeyen sözleşmeler (git diff kanıtı):** `credits/promo-credit-ledger.ts` (grant/consume/refund/expiry/revoke primitive'leri),
`PromoCreditLotConsumption`, `CampaignRedemption.grantTransactionId` şeması, `entitlement-resolver`, `offers` refund yolu,
`operations-settings` (PATCH DTO'sunda `campaignEngineEnabled` yok), CUSTOMER telefon yolu (`verifyCode`), scheduler'lar, `.env`/compose.

## 2. Değişen hook'lar (fact-writer matrisi)

| Kaynak | Yazıcı → hook | Ne zaman | Tx |
| --- | --- | --- | --- |
| `PROVIDER_APPROVED` | `ProvidersService.updateProviderStatus` → `hooks.providerApproved(tx, id)` (= `evaluate(PROVIDER_APPROVED, transition)` + `onProviderFact`) | yalnız `existing.status !== APPROVED` geçişinde, vitrin yerleşimleri geri alındıktan sonra | `runSerializable` (**yeni**; düz `$transaction` idi) |
| `EMAIL_VERIFIED` | `EmailVerificationService.confirm` → `hooks.accountFactProven(tx, userId, EMAIL_VERIFIED)` | `proven.count === 1 && role === PROVIDER`, token kapatma sonrası, tx'in son adımı | `runSerializable` (**yeni**) |
| `PHONE_VERIFIED` | `PhoneVerificationService.verifyAccountCode` → `accountFactProven(…, PHONE_VERIFIED)` | `proven.count === 1` sonrası, son adım | `runSerializable` (mevcut) |
| `PACKAGE_PAYMENT_SUCCEEDED` | `PaymentsWebhookService.settle` → `hooks.packagePaymentSucceeded(tx, providerId, purchaseId)` | tüm doğrulamalar + PAID sonrası, `recordAttempt(PROCESSED)` **öncesi**; her iki kind | `runSerializable` (mevcut) |
| `PACKAGE_PAYMENT_SUCCEEDED` | `PackagePurchasesService.mockPayProviderPurchase` → aynı hook | PAID sonrası, her iki kind (yalnız `PAYMENT_PROVIDER=mock`) | `runSerializable` (mevcut) |

Hata semantiği: iş sonucu → log, tx commit; P2034 → tetikleyici tx yeniden oynatılır; bütçe biterse 409 `CONCURRENT_MODIFICATION`
(webhook committed-state'e bakar, PROCESSED yoksa 409 → Lemon yeniden teslim eder); `ENGINE_ERROR` → hook **fırlatır**
(`409 CAMPAIGN_ENGINE_FAILED`), tetikleyici tx geri alınır (CMP-001 §3.5'ten bilinçli sapma; tasarım notu D2).

## 3. Yaşam döngüsü tablosu

Tasarım notu §2 ile aynı; test kanıtı `admin-campaign-lifecycle.spec.ts`: motor kapalı → activate/resume 409 `CAMPAIGN_ENGINE_DISABLED`
ve **snapshot eşit** (Campaign/Version/Audit/motor tabloları), pause/end çalışır; DRAFT→ACTIVE (`VERSION_ACTIVATED`+`ACTIVATED`, motor
tabloları değişmez); ACTIVE⇄PAUSED→ENDED audit dizisi ve gerekçeler; ENDED'de pause/resume/end/activate 409, revizyon `CAMPAIGN_ENDED`;
DRAFT'ta pause/resume/end 409; ACTIVE'de resume 409; PAUSED'da pause 409; reason < 3 → 400; ACTIVE'de revizyon → `currentVersion` 2,
`activeVersion` 1, activate(2) → değişim (`previousActiveVersionNumber: 1`), PAUSED'da activate → değişim + `RESUMED`;
`FACT_SOURCE_UNAVAILABLE` (olgu ve tetikleyici; resume de kapıdan geçer); `LIMIT_BELOW_CONSUMED` (global/bütçe/provider; eşit kabul);
pencere kapanmış → `WINDOW_INVALID`; katalogdan silinmiş slug → `UNKNOWN_PACKAGE_SLUG`; 4 eşzamanlı activate → tek `ACTIVATED`.

## 4. Gerçek engine test kanıtı (`campaign-engine-hooks.spec.ts`, anahtar test DB'de true, yalnız gerçek uçlar)

| Senaryo | Sonuç |
| --- | --- |
| K1: onay (PATCH status) / e-posta (resend+confirm) / telefon (OTP) — **6 permütasyon** | ilk iki olguda 0 satır; üçüncüde tek redemption + tek lot + tek `CAMPAIGN_GRANT +5` (`grantTransactionId` bağlı), bakiye 5, olay anahtarı `PROVIDER_ELIGIBILITY_REACHED:EMAIL_VERIFIED+PHONE_VERIFIED+PROVIDER_APPROVED:<id>`, `GRANTED` log'unda `fact` = son olgu; kanıt kolonları ve profil durumu yerinde |
| Askı → yeniden onay + zaten onaylıyı yeniden kaydetme | ikinci grant yok; ikinci geçiş `ALREADY_REDEEMED` log'u; ledger 1 satır |
| Onay kanıt olmadan | profil APPROVED, olay yalnız `PROVIDER_APPROVED` (`NO_CANDIDATE`), uygunluk olayı yok |
| CUSTOMER e-posta kanıtı (K1 aktifken) | `emailVerifiedAt` yazıldı, motor snapshot'ı **eşit** |
| K2 Lemon webhook (imza/store/tutar/variant doğrulanmış) | 200 processed; ledger `[PACKAGE_PURCHASE +25, CAMPAIGN_GRANT +10]`, bakiye 35, `PaymentWebhookEvent PROCESSED`; **redelivery** → duplicate, snapshot eşit, attemptCount 2; aynı purchase'ı adlayan ikinci order → mismatched, sıfır ek yazı |
| K2 mock settle | tek grant; aynı purchase'a ikinci mock-pay 409; ikinci satın alma `CONDITIONS_FAILED:FIRST_SUCCESSFUL_PAID_PURCHASE` |
| Koşul kaçıran settle | paket kredisi yüklendi, grant yok, PROCESSED yazıldı |
| **Webhook retry:** bozuk tanım (ENGINE_ERROR) | teslim 409 `CAMPAIGN_ENGINE_FAILED`; purchase **PENDING**, ledger 0, PROCESSED 0, motor snapshot eşit → kampanya pause → yeniden teslim 200 processed, bakiye 25, `CAMPAIGN_PAUSED` log, grant yok |
| Onay retry: bozuk tanım | 409; profil PENDING_REVIEW, onay maili yok, sıfır yazı → kampanya end → onay 200, `NO_CANDIDATE` |
| Telefon kanıtı retry: bozuk tanım | 409; `phoneVerifiedAt` null, sıfır yazı → tanım düzeltilince aynı OTP akışı kanıt + grant |
| Stack: iki ACTIVE onay kampanyası (5/prio 1 vs 10/prio 100) | 10 kazanır; kaybeden `STACK_CONFLICT{winner}`, sayaçları 0 |
| Bütçesi dolu zengin aday | `BUDGET_EXHAUSTED` (savepoint geri; sayaçları değişmedi) → ikinci aday `GRANTED` |
| **4 eşzamanlı onay** (aynı sağlayıcı) | tek grant/lot/redemption; yanıtlar 200 veya 409 `CONCURRENT_MODIFICATION`; her commit'lenen onay için bir log (`GRANTED` ×1, kalanlar `ALREADY_REDEEMED`), `evaluationCount` = commit sayısı — sessiz kayıp yok |
| **4 eşzamanlı webhook teslimi** | 1 processed + grant; kalanlar duplicate/409; tek `PaymentWebhookEvent` PROCESSED |
| K1 + K2 aynı sağlayıcı | 2 redemption, 2 lot, ledger `[+25, +10, +5]`, `balance 40 = paid 25 + promo 15` |
| PAUSED/DRAFT/ENDED | yalnız `CAMPAIGN_PAUSED` log'u, grant/ledger yok |

`campaign-engine.spec.ts` (motor doğrudan, anahtar true): her senaryoda redemption sayısı = lot sayısı = `CAMPAIGN_GRANT` sayısı, başka
ledger türü 0, cüzdan değişmezi (`Σamount = balance`, `paid = 0`); önceki 30 senaryo (stack sırası, limitler, savepoint geri, settled
event, eşzamanlı aynı olay, 6 permütasyon, containment) aynen geçti.

## 5. Kapalı-motor sıfır-etki sonucu (`campaign-engine-isolation.spec.ts`, hook'lar bağlı)

İlk test registry'de dört kaynağın PROVIDER yazıcısını doğrular (hook'lar gerçekten bağlı). Ardından DRAFT + ACTIVE kampanyalar
varken, `campaignEngineEnabled=false`: sağlayıcı onayı, PROVIDER e-posta + telefon kanıtı, Lemon webhook settle (ONE_TIME), mock settle
(dönem), teklif harcaması, teklif iadesi → `CampaignTriggerEvent/Redemption/EvaluationLog/PromoCreditLot/Consumption/Counter` 0,
`Campaign.redemptionCount/budgetConsumedCredits` 0, ledger yalnız altı eski tür; iş etkileri (PAID, +25, entitlement, −2/+2) bire bir.
`admin-campaign-lifecycle.spec.ts`: activate/resume 409 ile Campaign/Audit dâhil sıfır yazı; pause/end yalnız status + audit.

## 6. Test ve derleme sonuçları

| Adım | Sonuç |
| --- | --- |
| `pnpm typecheck` | ✅ |
| `pnpm lint` | ✅ |
| `pnpm test` | ✅ api **145 dosya / 3247 test**, admin 5/64, shared 6/168 |
| `pnpm build` | ✅ |
| E2E Chromium (izole `taktic_cmp002s2b2_e2e`) | ✅ **286 passed** (9.3 dk) — `admin-campaign-lifecycle` dahil |
| E2E WebKit | ✅ **117 passed** (3.7 dk) |
| Migration dry-run | ✅ 69 migration, diff boş, yalnız 5 `ALTER TYPE` |
| CI (run 35588381023, head `e00b87c9`) | ✅ 3/3: typecheck·lint·test·build (12m27s), e2e chromium (13m53s), e2e webkit (10m44s); önceki run 35587030296 rapor push'uyla iptal edildi (webkit orada da ✅) |

## 7. Motor açmak S4'e kadar teknik olarak mümkün değil

- `campaignEngineEnabled` yazıcısı yok: `grep -rn campaignEngineEnabled apps/api/src` → yalnız üç okuyucu
  (`campaign-engine-settings.service.ts`, `campaign-engine.service.ts`, `campaigns.service.ts`); `operations-settings` PATCH DTO'sunda
  alan yok; seed yok; admin UI'da düğme yok (`engine-notice.tsx`, `lifecycle-panel.tsx` yalnız okur). Tek yazıcı test fixture'larıdır.
- Anahtar kapalıyken hiçbir kampanya ACTIVE'e geçemez (§3) ve hiçbir hook satır yazmaz (§5); üretimde `activeVersionId` dolu kampanya
  yoktur (S2A D2; bu dilim onu yalnız motor açıkken yazar) → anahtar elle açılsa bile aday kümesi boştur.
- S4 ön koşulu (promo içeren iadenin net tutarını bildirim/arayüzde göstermek) bu PR'da yok; `project_cmp_002_s2b1…` notundaki karar
  geçerli: **anahtar S4 tamamlanmadan açılmayacak.**

## 8. S3/S4 sınırları ve açık noktalar

- S3: `order_refunded` → `revokePromoCreditLot`, admin revoke ucu, otomatik PAUSE eşiği, redemption/evaluation ekranları (`ELIGIBILITY_INCOMPLETE`
  gözlem log'u hâlâ olaysız → yazılmıyor, S2A kararı).
- S4: refund mailinde net tutar, admin ledger `CAMPAIGN_*` etiketleri, sağlayıcı promo satırı, grant maili; ardından toggle ucu (ayrı karar).
- Scheduler: `PromoCreditLotExpiryService.expireDueLots` cron/anahtar olmadan durur (S2B1 gibi).
- Not: bozuk tanım/kod hatası (ENGINE_ERROR) artık ilgili akışları (onay/kanıt/settle) sorumlu kampanya duraklatılana kadar
  409 ile durdurur — brief'in "sessiz kayıp yok" gereğinin bedeli; operasyon notu tasarım D2.
