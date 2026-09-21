# CMP-003 S3 — Teslim raporu: kampanya iadesi, revoke, otomatik duraklatma ve operasyon güvenliği

Tarih: 2026-09-21 · Branch: `claude/s3-campaign-refund-revoke-cbccd4` · Taban: `origin/main` @ `65c3e02a` (CMP-002 S2B2 merge; temiz
worktree doğrulandı) · Tasarım notu: `docs/superpowers/specs/2026-09-21-cmp-003-s3-refund-revoke-design.md` · Dry-run kaydı:
`docs/superpowers/plans/2026-09-21-cmp-003-s3-migration-f-dryrun.txt` · Bağlayıcı sözleşme: CMP-001 (rev. 3) §2.6, §10, §12.

PR: https://github.com/umutciftciii/taktic/pull/100 (açık; **merge edilmedi**) · CI run 35643971015 (head `9061cb1b`): **3/3 yeşil** (typecheck·lint·test·build, e2e chromium, e2e webkit).

Merge, deploy, yerel/staging eşitlemesi, gerçek `.env`, Cloudflare, Lemon ayarı veya gerçek veri işlemi **yapılmadı**. Geçici DB
`taktic_cmp003_s3_dryrun` yalnız dry-run için oluşturuldu ve düşürüldü; yerel `taktic` DB'sine ve `docker` container'larına komut
yok. Motor anahtarı (`campaignEngineEnabled`) yazıcısı/UI'ı **eklenmedi**; toggle kapsam dışı (S4).

---

## 1. Teslim edilen

| Katman | Dosya | İçerik |
| --- | --- | --- |
| **Migration F** | `prisma/migrations/20260921200000_add_campaign_revoke_operations/` + `schema.prisma` | `CampaignAuditAction += AUTO_PAUSED, REDEMPTION_REVOKED, EVENT_RETRY_REQUESTED` (3 `ALTER TYPE … ADD VALUE`); `CampaignVersion.maxRevokesPerDay INT NULL` + CHECK 1–1000; `CampaignRedemption.revokeNote TEXT NULL` (CHECK 1–500) + `revokedByWebhookEventId TEXT NULL` FK → `PaymentWebhookEvent` (Restrict) + index; yeni tablo `CampaignRevokeDailyCounter(campaignId FK Restrict, day DATE [UTC], revokeCount ≥ 0)` unique `(campaignId, day)`. **Sınıflandırma: yalnız additive** — DML/backfill/DROP/ALTER COLUMN yok; `CreditTransactionType` değişmedi (mevcut `CAMPAIGN_REVOKE` kullanılır). |
| Revoke domain servisi | `campaigns/engine/campaign-revoke.service.ts`, `campaign-engine.module.ts` (export) | `CampaignRevokeService.revokeForRefundedPurchase(tx, {purchaseId, webhookEventId, now})` ve `.revokeRedemption(tx, {redemptionId, actorId, note, now})` → tek çekirdek: S2B1 `revokePromoCreditLot` → provenance (`revokedByWebhookEventId` / `revokeNote`, koşullu) → UTC günlük sayaç (`upsert + increment`, P2002 → P2034 replay) → eşik (`revokeCount > activeVersion.maxRevokesPerDay`) → koşullu `ACTIVE → PAUSED` + `AUTO_PAUSED` audit (yalnız `count === 1`). Motor anahtarı **okunmaz**. |
| Webhook | `payments/payments-webhook.service.ts` | `flagForManualReview(event, storeId)`: bugünkü bayrak + `MANUAL_REVIEW_REQUIRED` kaydı **bire bir**; aynı tx'te, `recordAttempt`'ten sonra, yalnız **ilgili** teslimde (`testMode`, store eşleşmesi, purchase `PAID`, `providerOrderId === event.objectId`) `revokeForRefundedPurchase`. Yanıt gövdesi değişmedi (`manual_review_required` / `duplicate`). |
| DSL / doğrulama | `packages/shared/campaign-rules.json`, `rules/validator.ts`, `rules/types.ts`, `campaigns.service.ts` (`writeVersion`, `versionSelect`, `changedFields`) | `limits.maxRevokesPerDay` opsiyonel (1–1000, `required:false`), normalize `null`; sürüm satırına yazılır ve okunur; `changedFields` önceki JSON'u validator'dan geçirip karşılaştırır (eski sürümlerde anahtar yok → yanlış "limits değişti" yok). |
| Admin API | `admin-campaigns.controller.ts`, `campaigns.service.ts` | `GET :id/redemptions`, `GET :id/evaluation-events` (cursor sayfalı, `ListCampaignsDto`), `POST :id/redemptions/:rid/revoke {reason 3–500}` (`CampaignTransitionDto`), `POST :id/evaluation-events/:eid/retry`. Hata kodları: `CAMPAIGN_REDEMPTION_NOT_FOUND` 404, `CAMPAIGN_REDEMPTION_NOT_REVOCABLE` 409, `CAMPAIGN_EVENT_NOT_FOUND` 404, `CAMPAIGN_EVENT_NOT_RETRYABLE` 409, `CAMPAIGN_ENGINE_DISABLED` 409 (retry). SUPER_ADMIN guard mevcut controller'dan. |
| Admin UI | `apps/admin/app/campaigns/[id]/page.tsx`, `operations-panels.tsx`, `actions.ts`, `campaign-definition-form.tsx`, `lib/api.ts`, `lib/campaign-rules.ts`, `globals.css` | Detayda "Hak edişler" ve "Değerlendirme kuyruğu" tabloları (`rcursor`/`ecursor` sayfalama, `.table-scroll`), satır içi gerekçeli **Geri al** formu (yalnız GRANTED), **Kuyruğa al** düğmesi (yalnız `retryable` ∧ motor açık), audit etiketleri (+ `AUTO_PAUSED` için "Sistem (ödeme iadesi)"), builder'da "Günlük geri alma eşiği" alanı, sürüm tablosu/limit satırında eşik. |
| Testler | `test/campaign-refund-revoke.spec.ts` (11), `test/admin-campaign-operations.spec.ts` (10), `test/campaign-engine-schema.spec.ts` (+4), `test/campaign-rules-validator.spec.ts` (+1), `test/admin-campaigns.spec.ts` (+1), `admin/test/campaign-rules.spec.ts` (+1), `e2e/tests/admin-campaign-operations.spec.ts` (2), `test/lemon-squeezy-fixtures.ts` (paylaşılan webhook fixture'ları) | §4 |

**Değiştirilmeyen sözleşmeler (git diff kanıtı):** `credits/promo-credit-ledger.ts` (grant/consume/refund/expiry/revoke primitive'leri
dokunulmadı), `campaign-engine.service.ts`, `campaign-engine.repository.ts`, `campaign-engine.hooks.ts`, `campaign-evaluation.worker.ts`,
`condition-evaluator.ts`, `campaign-fact-reader.ts` (`NO_PRIOR_REVOCATION` = mevcut `hasRevokedRedemption`), `operations-settings`
(toggle yazıcısı yok), Lemon payload okuyucusu (`lemon-squeezy.webhook.ts`), settle yolu, offer spend/refund yolu, compose/.env.

## 2. Revoke muhasebe tablosu (testle kanıtlı)

| Durum | Ledger | Lot | Redemption | Sayaç | Bakiye | Test |
| --- | --- | --- | --- | --- | --- | --- |
| Tam kullanılmamış lot (10/10), `order_refunded` | `CAMPAIGN_REVOKE −10` (`PROMO_LOT_REVOKED:PAYMENT_REVERSED`, ref lot, `createdById` null) | `REVOKED, remaining 0, revokeTransactionId` | `REVOKED, PAYMENT_REVERSED, spentAtRevoke 0, revokedById null, revokeNote null, revokedByWebhookEventId = MANUAL_REVIEW_REQUIRED satırı` | 1 | 35 → 25 | refund-revoke #1 |
| Kısmen harcanmış (gerçek teklif, 4 kredi promo lotundan) | `CAMPAIGN_REVOKE −6` | `REVOKED, remaining 0` | `spentAtRevoke 4` | 1 | 31 → 25; `paid = 25`, promo 0; borç yok | #2 |
| Tamamen harcanmış (`EXHAUSTED`) | satır yok (sıfır tutar yazılmaz — primitive sözleşmesi) | `REVOKED` | `spentAtRevoke = granted` | 1 | değişmez | primitive (S2B1 spec) |
| Duplicate teslim / `subscription_payment_refunded` / 3 eşzamanlı teslim | tek `CAMPAIGN_REVOKE` | değişmez | değişmez | 1 | değişmez | #3 |
| Motor kapalıyken (lot önce verilmiş) | `CAMPAIGN_REVOKE −10` | `REVOKED` | `REVOKED` | 1 | 25 | #4 |
| Promo lotu olmayan paket iadesi | yalnız `PACKAGE_PURCHASE` | — | — | 0 (tablo boş) | 25 | #5 (`engineWriteSnapshot` eşit) |
| Geçersiz imza / başka mağaza / live-mode / başka sipariş / bilinmeyen referans | yok | `ACTIVE` | `GRANTED` | 0 | 35 | #6 (bayrak yanıtı yine `manual_review_required`, imza 401) |
| Admin revoke (SUPER_ADMIN, gerekçe) | `CAMPAIGN_REVOKE −10` (`…:ADMIN_REVOKED`, `createdById` = admin) | `REVOKED` | `ADMIN_REVOKED, revokedById, revokeNote (trim), revokedByWebhookEventId null` + audit `REDEMPTION_REVOKED{redemptionId, revokedCredits, spentAtRevoke, reason, versionNumber}` | 1 | 10 → 0 | operations #3 |
| Revoke sonrası aynı lotla verilmiş teklifin iadesi | `OFFER_REFUND +cost` + `CAMPAIGN_REVOKE −pay` (forfeit) | değişmez | değişmez | 0 | yalnız ücretli pay | S2B1 `promo-credit-ledger.spec` (değişmedi) |

Her senaryodan sonra `walletInvariant`: `Σ amount = son balanceAfter`, `paid ≥ 0`, `balance = paid + Σ remaining(ACTIVE/EXHAUSTED)`.

## 3. Idempotency ve yarış kanıtı

| Yol | Mekanizma | Test |
| --- | --- | --- |
| Webhook duplicate | aynı `eventKey` → `MANUAL_REVIEW_REQUIRED` kısa devresi (tx'e girmez); farklı key → `revoke()` yalnız `GRANTED` satır arar, S2B1 koşullu `updateMany` + `revokeTransactionId` unique; 3 eşzamanlı teslim → `runSerializable` replay | refund-revoke #3: 1 ledger, sayaç 1, audit 0, 2 webhook event satırı |
| Admin duplicate | ikinci istek 409 `CAMPAIGN_REDEMPTION_NOT_REVOCABLE`, `engineWriteSnapshot` eşit, audit sayısı eşit, sayaç 1 | operations #4 |
| Auto-pause tekilliği | eşik `revokeCount > maxRevokesPerDay`; `campaign.updateMany WHERE status = ACTIVE` → `count === 1` ise tek audit; 4 eşzamanlı iade (eşik 2) → sayaç 4, 4 revoke, 1 `AUTO_PAUSED`, kampanya `PAUSED` | refund-revoke #8/#9; admin kaynaklı: operations #5 (`actorKind: ADMIN`) |
| Pause sonrası | yeni ödeme olayı → worker `EVALUATED`, log `CAMPAIGN_PAUSED`, grant yok; üçüncü iade yine revoke eder, sayaç 3, ikinci pause yok | refund-revoke #8 |
| Manual retry | koşullu `updateMany WHERE (RETRY_WAIT) OR (PROCESSING ∧ leaseUntil < now)`; SETTLED/EVALUATED/PENDING/canlı lease 409 ve satır **aynen** (`toEqual` önce/sonra); motor kapalı 409; request grant yazmaz (`engineWriteSnapshot` yalnız event alanı değişir); worker sonraki `runOnce` → `SETTLED` | operations #8–#10 |
| Yetki | anon 401, CUSTOMER/PROVIDER 403 dört uçta; snapshot eşit; E2E'de provider oturumu `/login`'e | operations #1, E2E #2 |
| PII | ledger/lot/redemption/sayaç/audit JSON'unda alıcı adı, e-posta, referans, secret yok; admin sayfalarında `email`/`phone`/`rulesSnapshot` yok; E2E HTML'de sağlayıcı e-posta/telefon yok | refund-revoke #7, operations #6/#7, E2E #1 |

## 4. Motor kapalıyken reversal neden çalışır

`CampaignRevokeService` `OperationsSettings`'i okumaz. Anahtar S2A/S2B2 sözleşmesinde **yeni hak edişin** kapısıdır (stage A event
yazımı, stage B claim/evaluate, activate/resume). Geri alma ise var olan bir lotun muhasebe/güvenlik işlemidir: iade edilmiş bir ödemeye
karşılık verilen promosyonun cüzdanda kalması, anahtar ne olursa olsun yanlıştır. Test #4: lot motor açıkken verilir, anahtar kapatılır,
`order_refunded` → `CAMPAIGN_REVOKE`, lot `REVOKED`, bakiye 25; aynı anda `worker.runOnce()` → `skipped: ENGINE_DISABLED` (yeni hak ediş
kapısı yerinde). Sıfır-etki matrisi (`campaign-engine-isolation.spec.ts`) değişmedi ve geçer: promo lotu olmayan iade motor kapalıyken
kampanya tablolarına hiçbir satır yazmaz (#5 `engineWriteSnapshot` eşit, `CampaignRevokeDailyCounter` 0).

## 5. Kararlar ve bilinen ödünler

- **AUTO_PAUSED aktörü (D9):** `CampaignAuditLog.actorId` NOT NULL ve migration kuralı `ALTER COLUMN`'ı yasaklıyor. Webhook kaynaklı
  auto-pause satırında nominal aktör = `campaign.createdById`, `summary.actorKind = 'SYSTEM'`, `summary.source = 'PAYMENT_REVERSED'`;
  admin kaynaklıda aktör = admin (`actorKind: 'ADMIN'`). UI SYSTEM satırında "Sistem (ödeme iadesi)" gösterir. **S4 önerisi:** kolonu
  nullable yapan ayrı bir (ALTER COLUMN DROP NOT NULL, metadata-only) migration ile nominal aktörü kaldırmak.
- **Eşik eşitlikte aşılmış sayılmaz** (`max=1` → 1 revoke tolerans, 2. duraklatır). Eşik **çalışan sürümden** okunur; DRAFT/ENDED ya da
  zaten PAUSED kampanyada pause yazılmaz, revoke yine çalışır.
- **Revoke sayacı UTC günü**, hak ediş gün sayacı Istanbul günü (S2A) — görev tanımı gereği; iki tablo, iki anlam (`utcDay` /
  `istanbulDay`).
- **Retry motor kapalıyken 409:** worker claim etmeyeceğinden kuyruğa alma etkisiz olurdu; sıfır-etki sözleşmesi korunur. Revoke ise
  motor kapalıyken çalışır (yukarıda).
- **Event kuyruğu kampanya ekranında "bu kuralın adayı olan olaylar"** (`trigger` + `factSetKey` eşleşmesi; `activeVersion ??
  currentVersion`); kuyruk global, retry audit'i bu kampanyaya bağlanır (`campaignId` NOT NULL).
- **İlgililik kapısı:** bayrak yolu bugüne kadar store/test-mode kontrolü yapmıyordu ve yapmamaya devam eder (byte düzeyinde koruma);
  yalnız revoke için settle yolunun kapıları + `providerOrderId === objectId` şartı eklendi.

## 6. Kalite kapıları

| Kapı | Sonuç |
| --- | --- |
| `pnpm typecheck` | 5/5 ✓ |
| `pnpm lint` | 4/4 ✓ |
| `pnpm build` | 3/3 ✓ |
| API `vitest run` (tam) | 147 dosya / **3288** test ✓ (yeni 27 test; RED → GREEN her dilimde önce kırmızı görüldü: şema 4, validator 2, admin-campaigns 1, refund-revoke 8/11 — 3'ü mevcut davranışı koruma bekçisi, operations 10, admin lib 2) |
| web / admin / shared | 338 / 65 / 168 ✓ |
| E2E Chromium `admin-campaign-operations` | 2/2 ✓ (320/768/1024/1440 taşma yok; ekran görüntüleri `e2e/.artifacts/admin-campaign-operations/`) |
| E2E WebKit `--project=webkit` (drafts, lifecycle, operations) | 5/5 ✓ (taze DB; not: Chromium+WebKit'i aynı DB'de art arda koşmak eski spec'lerin global `CAMPAIGN_*` sayımlarını kirletir — CI iki ayrı iş) |
| Migration F dry-run | geçici `taktic_cmp003_s3_dryrun`: `migrate deploy` 71 ✓, `migrate diff` "No difference detected", enum sırası ve CHECK/FK tanımları kayıtta; DB düşürüldü |
| CI (GitHub Actions run 35643971015, head `9061cb1b`) | 3/3 ✓ — typecheck·lint·test·build, e2e (chromium), e2e (webkit) |

## 7. Kapsam dışı / S4'e kalanlar

- Promo içeren teklif iadesinde e-posta ve kullanıcı arayüzünde net tutarın gösterimi.
- Admin ledger'da `CAMPAIGN_*` etiketlerinin kullanıcı dostu görünümü.
- Sağlayıcı panelinde promo lot/kredi görünürlüğü.
- Engine toggle'ın güvenli yazıcısı, UI'ı ve kontrollü açılış kararı.
- `CampaignAuditLog.actorId` nullable (D9 nominal aktörünün kaldırılması).
- Ücretli kredinin paket iadesinde geri alınması (bugün de yok: bayrak + insan kararı).
- Yerel Docker eşitlemesi ve DB 70→71 migration'ı (merge sonrası; bu PR'da yapılmadı).
