# CMP-003 S3 — Kampanya iadesi, revoke, otomatik duraklatma ve operasyon güvenliği

Tarih: 2026-09-21 · Taban: `origin/main` @ `65c3e02a` (CMP-002 S2B2 merge, temiz worktree doğrulandı) ·
Branch: `claude/s3-campaign-refund-revoke-cbccd4` · Bağlayıcı sözleşme: CMP-001 (rev. 3) §2.6, §10, §12 ·
Önceki dilimler: S2B1 (`2026-09-20-cmp-002-s2b1-promo-credit-accounting-design.md`), S2B2
(`2026-09-21-cmp-002-s2b2-lifecycle-hooks-design.md`).

Bu dilim S2B2'nin bıraktığı lot/grant/event altyapısını **finansal olarak kapatır**: geçerli paket iadesinde promosyon
kredisinin güvenli geri alınması, SUPER_ADMIN'ın aynı kanonik yoldan gerekçeli revoke'u, olağandışı revoke yoğunluğunda
kampanyanın otomatik duraklatılması ve adminin hak ediş / değerlendirme kuyruğunu izleyip yalnız "kuyruğa yeniden alma"
yapabilmesi. Motor anahtarı (`campaignEngineEnabled`) yine **kapalı** kalır; bu dilim toggle/yazıcı/UI getirmez.

---

## 1. Kararlar (gerekçeli)

| # | Karar | Gerekçe |
| --- | --- | --- |
| D1 | **Tek domain servisi:** `CampaignRevokeService` (`CampaignEngineModule` içinde, export edilir). Webhook (`PAYMENT_REVERSED`) ve admin (`ADMIN_REVOKED`) yolları aynı `revoke()` çekirdeğinden geçer: S2B1 primitive'i `revokePromoCreditLot` → günlük revoke sayacı → eşik → auto-pause. Farklı muhasebe kuralı yok. | Görev tanımı B: "Webhook revoke ile aynı domain servisinden geçsin". Ledger yazıcısı yine yalnız S2B1 primitive'idir. |
| D2 | **Motor anahtarına bakılmaz.** `revoke()` `campaignEngineEnabled`'ı okumaz; anahtar yalnız yeni hak ediş/evaluation içindir. Geçmişte oluşmuş bir lotun geri alınması güvenlik ve muhasebe işlemidir. | Görev tanımı A. Aksi "motor kapatıldı, iade edilen paketin promosu cüzdanda kaldı" demek olurdu. |
| D3 | **Webhook entegrasyon noktası:** `PaymentsWebhookService.flagForManualReview` tx'i (HMAC doğrulanmış, `order_refunded` / `subscription_payment_refunded`). Mevcut davranış (purchase `manualReview*` bayrağı, `MANUAL_REVIEW_REQUIRED` event satırı, yanıt gövdesi) **değişmez**; revoke, aynı tx içinde, `recordAttempt` sonrasında ve yalnız **ilgili** teslimde çalışır: `testMode === true`, `storeId === config.storeId`, purchase bulunmuş, `status === PAID`, `purchase.providerOrderId === event.objectId` (iade, bu purchase'ı settle eden siparişi adlandırıyor). Koşul sağlanmıyorsa yalnız bayrak (bugünkü davranış). | Görev tanımı A: "doğrulanmış, ilgili ve idempotent". Settle yolunun LIVE_MODE/STORE kapıları revoke için de geçerli olmalı; bayrak yolu bugüne kadar bunları kontrol etmiyordu ve etmemeye devam eder (byte düzeyinde koruma). |
| D4 | **Idempotency üç katmanlı:** (1) aynı event key'in ikinci teslimi `MANUAL_REVIEW_REQUIRED` kısa devresine takılır (tx'e girmez); (2) `revoke()` yalnız `CampaignRedemption.status = GRANTED` satırlarını hedefler, koşullu `updateMany` (S2B1 primitive) ikinci yazımı P2034 → replay → "revoke edilecek yok" olarak sonlandırır; (3) `PromoCreditLot.revokeTransactionId` unique. Farklı anahtarlı ikinci iade (`subscription_payment_refunded`) da (2)'ye takılır. Sayaç ve audit yalnız `revoked === true` olduğunda yazılır. | Görev tanımı A/C: ikinci ledger satırı, ikinci düşüm, ikinci audit, ikinci sayaç artışı yok. |
| D5 | **Muhasebe:** `CAMPAIGN_REVOKE` ledger satırı yalnız `remainingCredits > 0` iken ve o kadar (`PROMO_LOT_REVOKED:<reason>`, ref `PromoCreditLot/<lotId>`, `createdById` = admin ya da null). Harcanan kısım `CampaignRedemption.spentAtRevoke` (= granted − remaining) olarak kaydedilir; borç/negatif/ücretli mahsup yok. Lot `REVOKED, remaining=0`; sonraki teklif iadesinde o lotun payı S2B1 kuralıyla `CAMPAIGN_REVOKE` forfeit satırına düşer (canlanmaz). | CMP-001 §2.6; S2B1 primitive'inin sözleşmesi değişmez. |
| D6 | **Revoke bilgisi şemada:** `CampaignRedemption += revokeNote` (admin gerekçesi, 3–500, CHECK), `revokedByWebhookEventId` (FK → `PaymentWebhookEvent`, Restrict; webhook kaynaklı revoke'un kanıtı). Mevcut `revokedAt / revokeReason / spentAtRevoke / revokedById` korunur. | Görev tanımı E: denetlenebilir alanlar; PII değil (gerekçe operatör metni, e-posta/telefon/token içermemesi UI + doğrulama ile). |
| D7 | **Günlük revoke sayacı:** yeni tablo `CampaignRevokeDailyCounter(campaignId, day @db.Date [UTC], revokeCount)`, unique `(campaignId, day)`, CHECK `>= 0`. Her başarılı revoke aynı tx'te `upsert + increment`; P2002 → `CampaignEngineWriteConflict` (P2034) → replay. | Görev tanımı C: "UTC günlük sayaç transaction içinde atomik". (Hak ediş gün sayacı Istanbul günüdür; revoke sayacı görev tanımı gereği UTC'dir — ayrı tablo, ayrı anlam.) |
| D8 | **Eşik:** `CampaignVersion.maxRevokesPerDay Int?` (CHECK 1–1000), DSL `limits.maxRevokesPerDay` (opsiyonel, katalogda `required:false`), immutable sürümün parçası. Eşik **çalışan sürümden** (`activeVersionId`) okunur; yoksa (null) kapalı. Sayaç artışından sonra `revokeCount > maxRevokesPerDay` ise ve kampanya `ACTIVE` ise koşullu `updateMany WHERE status=ACTIVE → PAUSED` + audit `AUTO_PAUSED{reason:'REVOKE_THRESHOLD_EXCEEDED', day, revokeCount, maxRevokesPerDay, versionNumber, source, redemptionId}`. `count !== 1` → zaten PAUSED/ENDED, ikinci audit yok. Eşik tam eşitlikte aşılmış sayılmaz (`max=3` → 3 revoke tolerans, 4. duraklatır). | Görev tanımı C. Koşullu update + Serializable: eşzamanlı revoke'larda sayaç doğru, tek `AUTO_PAUSED`. |
| D9 | **Auto-pause audit aktörü:** `CampaignAuditLog.actorId` NOT NULL (S1) ve bu dilim `ALTER COLUMN` yapamaz. Admin kaynaklı revoke'ta aktör = admin; webhook kaynaklı revoke'ta **nominal aktör = `campaign.createdById`**, `summary.actorKind = 'SYSTEM'`, `summary.source = 'PAYMENT_REVERSED'`. UI `actorKind=SYSTEM` satırında aktör adı yerine "Sistem (ödeme iadesi)" gösterir. | Additive-only migration kuralı ile "audit aksiyonu görünmeli" gereğinin çakışmasının en az kötü çözümü; raporda açıkça belirtilir, S4'e "actorId nullable" önerisi bırakılır. |
| D10 | **Admin revoke ucu:** `POST /admin/campaigns/:id/redemptions/:redemptionId/revoke {reason 3–500}`; SUPER_ADMIN (mevcut guard). Redemption kampanyaya ait değilse 404 `CAMPAIGN_REDEMPTION_NOT_FOUND`; `status !== GRANTED` → 409 `CAMPAIGN_REDEMPTION_NOT_REVOCABLE` (yazım yok); gerekçesiz/kısa → 400 (DTO). Başarı: audit `REDEMPTION_REVOKED{redemptionId, revokedCredits, spentAtRevoke, reason, versionNumber}` + D7/D8. | Görev tanımı B: hedef açık (redemption), keyfi bakiye düşümü yok. |
| D11 | **Operasyon yüzeyi (salt okuma):** `GET /admin/campaigns/:id/redemptions?limit&cursor` ve `GET /admin/campaigns/:id/evaluation-events?limit&cursor`. Redemption satırı: durum, sürüm no, tetikleyici, `providerId` + `businessName` (iş kimliği; e-posta/telefon yok), verilen kredi, lot durumu/kalan/son kullanma, revoke zamanı/nedeni/harcanan/aktör/not, `purchaseId`. Event satırı: kampanyanın kural sürümünün (`activeVersion ?? currentVersion`) `trigger`/`factSetKey`'iyle eşleşen olaylar: key, durum, deneme/evaluation sayıları, `nextAttemptAt`, `leaseUntil`, kapalı hata kodu/zamanı, settle eden kampanya, bu kampanya için son log sonucu (`outcome`, `reasonCode`), `retryable`. Ödeme ham verisi, token, e-posta/telefon **yok**. | Görev tanımı D. Event kuyruğu global; kampanya ekranında "bu kampanyanın adayı olan olaylar" anlamlıdır ve retry audit'ine kampanya bağlar. |
| D12 | **Manual retry:** `POST /admin/campaigns/:id/evaluation-events/:eventId/retry`. Motor kapalıysa 409 `CAMPAIGN_ENGINE_DISABLED` (yazım yok). Koşullu `updateMany WHERE id AND (status=RETRY_WAIT OR (status=PROCESSING AND leaseUntil < now)) → status=RETRY_WAIT, nextAttemptAt=now, leaseUntil=null`; `count !== 1` → 409 `CAMPAIGN_EVENT_NOT_RETRYABLE` (SETTLED/EVALUATED/PENDING/canlı lease). Event, kampanyanın tetikleyicisiyle eşleşmiyorsa 404. Audit `EVENT_RETRY_REQUESTED{triggerEventKey, previousStatus, attemptCount}`. Evaluator çalışmaz, grant yazılmaz; worker sonraki tick'te sahiplenir. | Görev tanımı D. `lastErrorCode` korunur (operatör neden retry ettiğini görür); worker başarılı olunca siler. |
| D13 | **`NO_PRIOR_REVOCATION`** mevcut `hasRevokedRedemption` (status = REVOKED sayımı) fact'i üzerinden okunur; yeni gizli global kural yok. Bu dilim yalnız gerçek revoke sonrası davranışı testle kanıtlar. | Görev tanımı A son madde. |
| D14 | **`changedFields` normalizasyonu:** önceki tanım da validator'dan geçirilerek karşılaştırılır; böylece `maxRevokesPerDay` anahtarı olmayan eski sürümlerden yapılan ilk revizyon, operatör dokunmadıysa `limits`'i "değişti" saymaz. | Yeni opsiyonel limit eski JSON'larda yok; ham karşılaştırma yanlış pozitif verirdi. |

## 2. Revoke muhasebe tablosu

| Durum (iade anında) | Ledger | Lot | Redemption | Sayaç | Bakiye |
| --- | --- | --- | --- | --- | --- |
| Lot tam kullanılmamış (`remaining = granted`) | `CAMPAIGN_REVOKE −granted` (ref lot) | `REVOKED, remaining 0, revokeTransactionId` | `REVOKED, spentAtRevoke 0, revokedAt, revokeReason, revokedById?, revokedByWebhookEventId?/revokeNote?` | +1 | −granted |
| Kısmen harcanmış (`0 < remaining < granted`) | `CAMPAIGN_REVOKE −remaining` | aynı | `spentAtRevoke = granted − remaining` | +1 | −remaining (harcanan kısım için borç yok) |
| Tamamen harcanmış (`EXHAUSTED`, remaining 0) | **satır yok** (sıfır tutarlı satır yazılmaz) | `REVOKED, revokeTransactionId null` | `spentAtRevoke = granted` | +1 | değişmez |
| Lot `EXPIRED` (redemption `EXPIRED`) | yok | değişmez | değişmez | 0 | değişmez |
| Zaten `REVOKED` | yok | değişmez | değişmez | 0 | değişmez |
| Promo lotu yok (normal paket) | yok | — | — | 0 | değişmez (bugünkü bayrak davranışı bire bir) |
| Revoke sonrası o lotla verilen teklif iade edilirse | `OFFER_REFUND +cost` + `CAMPAIGN_REVOKE −pay` (forfeit, S2B1) | değişmez | değişmez | 0 | yalnız ücretli pay |

Değişmez: `balance = paid + Σ remaining(lot ∈ {ACTIVE, EXHAUSTED})` her adımda korunur (`walletInvariant`).

## 3. Migration F (`20260921200000_add_campaign_revoke_operations`) — yalnız additive

```
ALTER TYPE "CampaignAuditAction" ADD VALUE 'AUTO_PAUSED' / 'REDEMPTION_REVOKED' / 'EVENT_RETRY_REQUESTED'
ALTER TABLE "CampaignVersion" ADD COLUMN "maxRevokesPerDay" INTEGER;           -- NULL = kapalı
  CHECK ("maxRevokesPerDay" IS NULL OR ("maxRevokesPerDay" BETWEEN 1 AND 1000))
ALTER TABLE "CampaignRedemption" ADD COLUMN "revokeNote" TEXT, ADD COLUMN "revokedByWebhookEventId" TEXT;
  CHECK ("revokeNote" IS NULL OR char_length("revokeNote") BETWEEN 1 AND 500)
  FK revokedByWebhookEventId → PaymentWebhookEvent(id) ON DELETE RESTRICT; INDEX
CREATE TABLE "CampaignRevokeDailyCounter" (id, campaignId FK Restrict, day DATE, revokeCount INT DEFAULT 0, updatedAt)
  UNIQUE (campaignId, day); CHECK (revokeCount >= 0)
```

DML/backfill/DROP/ALTER COLUMN yok. `CreditTransactionType` değişmez (mevcut `CAMPAIGN_REVOKE` kullanılır).
İzole geçici DB'de `migrate deploy` + `migrate diff` dry-run raporda; gerçek yerel/staging DB'ye komut yok.

## 4. Akışlar

```
Webhook (order_refunded, HMAC OK) → flagForManualReview → runSerializable:
  existing MANUAL_REVIEW_REQUIRED → duplicate (tx salt okuma)          ← aynı event'in her sonraki teslimi
  purchase (reference | providerOrderId) → manualReview bayrağı (bugünkü)
  recordAttempt(MANUAL_REVIEW_REQUIRED) → webhookEvent.id
  ilgili mi? (testMode ∧ store ∧ purchase PAID ∧ providerOrderId === objectId) → revokeService.revokeForRefundedPurchase(tx, purchaseId, webhookEventId, now)
      GRANTED redemption'lar (purchaseId) → her biri revoke(PAYMENT_REVERSED) → sayaç → eşik → auto-pause
  commit → { status: 'manual_review_required' }
  P2034 → replay; motor anahtarı okunmaz

Admin revoke → runSerializable: lockCampaign → redemption (kampanyaya ait, GRANTED) → revoke(ADMIN_REVOKED, actor, note)
  → audit REDEMPTION_REVOKED → sayaç → eşik → auto-pause → commit → getForAdmin

Manual retry → runSerializable: requireEngineEnabled → lockCampaign → event (trigger eşleşir) → koşullu updateMany → audit EVENT_RETRY_REQUESTED
```

## 5. Test planı (zorunlu matris → dosya)

| # | Senaryo | Dosya |
| --- | --- | --- |
| 1–6 | Webhook iadesi: tam/kısmi/duplicate/motor kapalı/promosuz/uyuşmayan | `test/campaign-refund-revoke.spec.ts` (webhook fixture'ları `lemon-squeezy-webhook.spec.ts`'den) |
| 7 | Admin revoke: 401/403, gerekçesiz 400, yanlış kampanya 404, bitmiş 409, geçerli = webhook ile aynı satırlar | `test/admin-campaign-operations.spec.ts` |
| 8 | Eşik: altında ACTIVE, aşınca tek AUTO_PAUSED + audit; 4 eşzamanlı revoke → sayaç 4, tek pause | `test/campaign-refund-revoke.spec.ts` |
| 9 | `NO_PRIOR_REVOCATION` gerçek revoke sonrası CONDITIONS_FAILED; koşulsuz kampanya grant | `test/campaign-refund-revoke.spec.ts` |
| 10 | Retry: RETRY_WAIT → nextAttemptAt now + audit; SETTLED/PENDING/canlı lease 409, motor kapalı 409; grant yok; worker sonra sahiplenir | `test/admin-campaign-operations.spec.ts` |
| 11 | Regresyonlar: mevcut webhook/engine/hooks/worker/lifecycle/ledger/isolation spec'leri değişmeden geçer; şema spec'i Migration F | `campaign-engine-schema.spec.ts` (+), mevcutlar |
| 12 | Admin UI E2E: revoke + retry akışı, yetki (PROVIDER çerezi 403), PII sızıntısı (e-posta/telefon HTML'de yok), 320/768/1024/1440 taşma yok | `e2e/tests/admin-campaign-operations.spec.ts` |

## 6. Kapsam dışı / S4'e bırakılan

Promo içeren teklif iadesinde e-posta ve UI'da net tutar; admin ledger'da `CAMPAIGN_*` etiketleri; sağlayıcı panelinde promo lot
görünürlüğü; engine toggle yazıcısı/UI/açılış kararı; `CampaignAuditLog.actorId` nullable (D9'daki nominal aktörün kaldırılması);
ücretli kredinin paket iadesinde geri alınması (bugün de yok: bayrak + insan kararı).
