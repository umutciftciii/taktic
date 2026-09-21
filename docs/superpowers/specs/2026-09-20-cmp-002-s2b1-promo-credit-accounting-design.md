# CMP-002 S2B1 — Promosyon kredi muhasebesi: ledger türleri, lot tüketimi, iade, süre dolumu

Tarih: 2026-09-20 · Taban: `origin/main` @ `e801443a` (CMP-002 S2A merge, temiz worktree doğrulandı) ·
Branch: `claude/cmp-002-s2b1-promo-credits-7c88bd` · Bağlayıcı sözleşme: CMP-001 (rev. 3) §2.4–2.6 ·
Önceki dilim: `2026-09-19-cmp-002-s2a-engine-infrastructure-design.md`.

Bu dilim **yalnız muhasebe** getirir: promosyon kredisinin ledger'daki üç yeni türü, lot tüketimi (teklif
harcaması), teklif iadesinde kaynak dağılımına göre geri yazım ve lot süre dolumu. Motor kapalı kalır
(`campaignEngineEnabled=false`, açan uç yok), hook bağlanmaz, kampanya aktive edilmez, scheduler/public uç yok.
Üretimde hiçbir `PromoCreditLot` var olmadığından mevcut kullanıcı davranışı **bire bir** korunur.

---

## 1. Koddan doğrulanan mevcut sözleşme (tahmin yok)

| Konu | Koddaki kanonik ilişki | Yer |
| --- | --- | --- |
| Teklif debit'i | `EntitlementResolverService.consume` (`ONE_TIME_CREDIT` dalı) `OFFER_SPEND (−creditCost, referenceType='Offer', referenceId=offerId)` yazar; teklif tx'i sonra `Offer.creditSpentTransactionId = transaction.id` yazar. Bu kolon **düz string**, FK yok. | `entitlement-resolver.service.ts:220-231`, `providers.service.ts:1410-1413` |
| Debit ↔ refund bağı | `refundOfferCreditInTransaction` koşullu `Offer.updateMany WHERE creditSpentTransactionId IS NOT NULL AND creditRefundedTransactionId IS NULL …` ile **teklif satırı üzerinden** bağlanır; ledger'da `OFFER_REFUND (+creditCost, referenceType='Offer', referenceId=offerId)` + partial unique `ProviderCreditTransaction_one_refund_per_offer`. Refund, debit satırını **id ile aramaz**; "en eski debit" seçimi yoktur. | `offers.service.ts:893-985` |
| Refund çağıranları | 48s worker (`unviewed-offer-refund.service.ts:182`), manuel admin iadesi (`offers.service.ts:262`), talep kaldırma (`service-requests.service.ts:1007`). Üçü de `creditSpentTransactionId`'yi zaten seçmiş durumdadır. | — |
| Bakiye | Son ledger satırının `balanceAfter`'ı; tek kanonik hesap. Yazım kapısı `balanceAfter < 0` → 400. | `credits.service.ts:321-355` |
| Lot şeması | S2A `PromoCreditLot{grantedCredits, remainingCredits, expiresAt, status, expiryTransactionId?, revokeTransactionId?}`; `CampaignRedemption.grantTransactionId` **zaten** nullable + unique + FK(Restrict) → `ProviderCreditTransaction`. | Migration B |

**Sonuç:** tüketim kaydı `OFFER_SPEND` debit satırının **id'sine** bağlanır (`creditTransactionId` FK); refund,
`offer.creditSpentTransactionId` üzerinden o debit'in tüketim satırlarını bulur. Bu, mevcut debit↔refund ilişkisinin
(teklif satırı) doğal uzantısıdır.

## 2. Kararlar

| # | Karar | Gerekçe |
| --- | --- | --- |
| D1 | Enum adı **`CAMPAIGN_EXPIRE`** (görev tanımı); CMP-001 §2.4'teki `CAMPAIGN_EXPIRY` ile aynı anlam. | Görev tanımı belirleyicidir; rapor sapmayı kayda geçirir. |
| D2 | `OFFER_REFUND` satırı **değişmez** (+creditCost, partial unique, `Offer.creditRefundedTransactionId`). Promo kaynağı canlanamıyorsa aynı tx'te **ayrı negatif satır** (`CAMPAIGN_EXPIRE` / `CAMPAIGN_REVOKE`, −tüketilen) yazılır; net etki = yalnız ücretli kısım + canlanan promo. | CMP-001 §2.6 birebir. Mevcut refund sözleşmesi (`ManualOfferRefundAudit.creditAmount = creditCost`, refund maili, üç çağıran) dokunulmadan kalır; "promo ile teklif ver, süre dolsun, iade al" ücretli krediye dönüşemez ve dönüşmediği ledger'da görünür. |
| D3 | Lot seçim sırası `expiresAt ASC, id ASC`; yalnız `ACTIVE`, `remainingCredits > 0`, `expiresAt > now`. | Görev tanımı. `createdAt` gerekmez; `id` (cuid) deterministik tie-break. |
| D4 | `resolve()` ONE_TIME_CREDIT dalında harcanabilir = `balance − Σ remaining(süresi dolmuş ama süpürülmemiş lot)`. `consume()` debit'i **önce** yazar, sonra lot koşullu decrement + tüketim satırı. | Süpürücü gecikirse dolmuş lot bakiyede görünür ama harcanamaz olmalı; refund/consume içinde inline expiry yazılmaz (tek expiry yazıcısı süpürücüdür). Debit başarısızsa tüketim satırı hiç oluşmaz. |
| D5 | Tüketim tam olarak ya canlanır ya düşer (kısmi yok): iade tam `creditCost` olduğundan her tüketim satırı tek statüye gider. Lot `ACTIVE`/`EXHAUSTED` ve `expiresAt > now` → canlanır (`remaining += consumed`, `EXHAUSTED → ACTIVE`); aksi halde (`EXPIRED`, `REVOKED` ya da süresi geçmiş) düşer. | Görev tanımı: "son kullanmış/revoke edilmiş promo kredi tekrar canlanmayacak". |
| D6 | Tüketimde lot `remaining` 0'a inerse `EXHAUSTED` yazılır (S2A CHECK'iyle uyumlu). Süpürücü `ACTIVE` ve `EXHAUSTED` lotları `EXPIRED` yapar; ledger satırı yalnız `remaining > 0` iken yazılır (sıfır tutarlı satır yok). Redemption `GRANTED → EXPIRED` aynı tx'te (koşullu). | CMP-001 §10.3 (`EXPIRED` sayılır), §2.6. |
| D7 | Promo muhasebesi `apps/api/src/modules/credits/promo-credit-ledger.ts` içinde **tx alan saf fonksiyonlar**; DI yok. Süpürücü seam'i `PromoCreditLotExpiryService` (credits modülü; lot başına `runSerializable`; cron/scheduler anahtarı **yok**). | Refund yolu sınıf değil modül fonksiyonudur; resolver ise DI sınıfıdır — ikisinden de çağrılabilen tek yüzey. `CampaignsModule` hâlâ domain import/export yapmaz; S2B2 motor grant'i buradan çağırır. |
| D8 | `CAMPAIGN_GRANT` / `CAMPAIGN_REVOKE` primitive'leri hazır, **çağıran yok** (yalnız test). Motorun S2A adım 6'sı dokunulmadı: S2B2 `createRedemptionAndLot`'ı `grantPromoCreditLot` ile değiştirir. | Görev tanımı §3. |
| D9 | Ledger satırı `referenceType/referenceId`: grant → `CampaignRedemption/redemptionId`; expiry (lot) → `PromoCreditLot/lotId`; revoke → `PromoCreditLot/lotId`; iade düşümü → `PromoCreditLotConsumption/consumptionId`. `reason` sabit kodlu kısa etiketler (`CAMPAIGN_GRANT`, `PROMO_LOT_EXPIRED`, `PROMO_LOT_REVOKED:<reason>`, `PROMO_FORFEIT_ON_REFUND:EXPIRED|REVOKED`). | Denetlenebilirlik; admin ledger görünümü S4. |

## 3. Yeni ledger türlerinin anlamı (mevcut altı tür değişmez)

| Tür | İşaret | Ne zaman | Bağ |
| --- | --- | --- | --- |
| `CAMPAIGN_GRANT` | + | Redemption için lot açılırken (S2B2 motor; S2B1'de yalnız primitive/test) | `CampaignRedemption.grantTransactionId` (unique) |
| `CAMPAIGN_EXPIRE` | − | (a) süpürücü: dolan lotun kalanı; (b) iade anında lot dolmuş/`EXPIRED` ise iade edilen promo payının düşümü | (a) `PromoCreditLot.expiryTransactionId` (unique); (b) `PromoCreditLotConsumption.forfeitTransactionId` (unique) |
| `CAMPAIGN_REVOKE` | − | (a) revoke primitive'i: lotun kalanı (S3 çağırır); (b) iade anında lot `REVOKED` ise promo payının düşümü | (a) `PromoCreditLot.revokeTransactionId`; (b) `forfeitTransactionId` |

## 4. Migration C (`20260920090000_add_promo_credit_consumption`) — yalnız additive

```
ALTER TYPE "CreditTransactionType" ADD VALUE 'CAMPAIGN_GRANT' / 'CAMPAIGN_EXPIRE' / 'CAMPAIGN_REVOKE'
CREATE TYPE "PromoCreditLotConsumptionStatus" AS ENUM ('CONSUMED', 'REFUNDED', 'FORFEITED')
CREATE TABLE "PromoCreditLotConsumption" (
  id, lotId → PromoCreditLot (Restrict), creditTransactionId → ProviderCreditTransaction (Restrict)  -- OFFER_SPEND debit
  consumedCredits INT, refundedCredits INT DEFAULT 0, forfeitedCredits INT DEFAULT 0,
  status DEFAULT 'CONSUMED', refundTransactionId? → ProviderCreditTransaction (Restrict)  -- OFFER_REFUND, unique DEĞİL
  forfeitTransactionId? UNIQUE → ProviderCreditTransaction (Restrict), consumedAt, settledAt?
)
UNIQUE (lotId, creditTransactionId); INDEX creditTransactionId; INDEX lotId; INDEX refundTransactionId
CHECK consumedCredits >= 1 AND refundedCredits >= 0 AND forfeitedCredits >= 0 AND refundedCredits + forfeitedCredits <= consumedCredits
CHECK (status='CONSUMED') = (settledAt IS NULL) AND (status='CONSUMED') = (refundTransactionId IS NULL)
CHECK (status='FORFEITED') = (forfeitTransactionId IS NOT NULL)
CHECK status<>'REFUNDED'  OR (refundedCredits = consumedCredits AND forfeitedCredits = 0)
CHECK status<>'FORFEITED' OR (forfeitedCredits = consumedCredits AND refundedCredits = 0)
CHECK status<>'CONSUMED'  OR (refundedCredits = 0 AND forfeitedCredits = 0)
```

DML/backfill/DROP/ALTER COLUMN yok. `CampaignRedemption.grantTransactionId` zaten S2A'da bağlıydı; değişmez.
Eski debit/refund satırları için tüketim kaydı **üretilmez** (eski kayıtlar promo dışıdır).

## 5. Transaction ve idempotency modeli

```
Teklif tx (providers.createOffer, Serializable, mevcut sınır):
  resolve:  balance = son balanceAfter;  spendable = balance − Σ remaining(lot ACTIVE, remaining>0, expiresAt<=now)
            spendable < cost → 402 (mevcut mesaj/kod)
  consume:  1 OFFER_SPEND (−cost)  ← mevcut yazıcı, değişmedi
            2 lots = ACTIVE ∧ remaining>0 ∧ expiresAt>now ORDER BY expiresAt, id
            3 her lot: take = min(remaining, kalan); updateMany WHERE id ∧ ACTIVE ∧ remaining>=take ∧ expiresAt>now
                       → remaining−take, status = (remaining==take ? EXHAUSTED : ACTIVE); count≠1 → P2034-uyumlu hata (replay)
                       INSERT PromoCreditLotConsumption{lot, debit, consumed=take}
            promo yok → adım 2 boş sonuç; ek yazı yok; hata kodu/bakiye/tx sayısı aynı

İade tx (refundOfferCreditInTransaction, çağıranın Serializable tx'i):
  1 OFFER_REFUND (+cost) + Offer koşullu update            ← mevcut, değişmedi
  2 consumptions = WHERE creditTransactionId = offer.creditSpentTransactionId ∧ status=CONSUMED, lot ile
  3 her satır:  canlanır  → lot updateMany WHERE id ∧ status∈{ACTIVE,EXHAUSTED} ∧ expiresAt>now → remaining+consumed, ACTIVE
                            consumption updateMany WHERE status=CONSUMED → REFUNDED, refunded=consumed, refundTx, settledAt
                düşer    → ledger (lot REVOKED ? CAMPAIGN_REVOKE : CAMPAIGN_EXPIRE) −consumed, ref=consumption
                            consumption updateMany WHERE status=CONSUMED → FORFEITED, forfeited=consumed, refundTx, forfeitTx, settledAt
  ikinci iade: partial unique + Offer koşullu update adım 1'de durdurur; consumption status koşulu ikinci savunma
  dönüş: { refundTransaction, balanceAfter = son satır }   (manuel iade yanıtı gerçek bakiyeyi verir)

Süpürme (PromoCreditLotExpiryService.expireDueLots(now)): aday id'leri okunur; lot başına runSerializable:
  lot WHERE id ∧ status∈{ACTIVE,EXHAUSTED} ∧ expiresAt<=now (tx içinde yeniden okunur)
  remaining>0 → CAMPAIGN_EXPIRE (−remaining, ref=lot) ; updateMany (aynı koşul) → EXPIRED, remaining=0, expiryTransactionId
  count≠1 → başka koşucu aldı; yazılan ledger satırı tx ile geri alınır (atomik) ; redemption GRANTED→EXPIRED koşullu
  ikinci çalıştırma: aday yok → sıfır yazı

Grant primitive (grantPromoCreditLot): redemption WHERE grantTransactionId IS NULL → CAMPAIGN_GRANT (+credits, ref=redemption)
  → PromoCreditLot{granted=remaining=credits, expiresAt} (redemptionId unique) → redemption updateMany WHERE grantTransactionId IS NULL
Revoke primitive (revokePromoCreditLot): lot status∈{ACTIVE,EXHAUSTED} → remaining>0 ise CAMPAIGN_REVOKE (−remaining, ref=lot)
  → lot REVOKED, remaining=0, revokeTransactionId ; redemption GRANTED→REVOKED{revokedAt, revokeReason, spentAtRevoke=granted−remaining, revokedById}
```

Değişmez: `balance = paidBalance + Σ remaining(lot.status ∈ {ACTIVE, EXHAUSTED})` — her yazıcı bunu korur; testler her
senaryodan sonra `Σ ledger.amount = son balanceAfter` ve lot/tüketim toplamlarını doğrular.

## 6. Kaynak–iade matrisi

| Harcama kaynağı | İade anında lot durumu | OFFER_REFUND | Ek ledger satırı | Lot | Tüketim |
| --- | --- | --- | --- | --- | --- |
| Yalnız ücretli (tüketim yok) | — | +cost | yok | — | — (mevcut davranış bire bir) |
| Promo (lot ACTIVE/EXHAUSTED, süresi geçmemiş) | canlanabilir | +cost | yok | `remaining += consumed`, `ACTIVE` | `REFUNDED` |
| Promo (lot `EXPIRED` ya da `expiresAt <= now`) | dolmuş | +cost | `CAMPAIGN_EXPIRE −consumed` | değişmez | `FORFEITED` |
| Promo (lot `REVOKED`) | geri alınmış | +cost | `CAMPAIGN_REVOKE −consumed` | değişmez | `FORFEITED` |
| Promo + ücretli karışık | lot bazında | +cost | lot bazında yukarıdaki | lot bazında | lot bazında |
| Aynı teklif ikinci iade | — | 409 (partial unique / koşullu update) | yok | değişmez | değişmez |

## 7. Kesin sınırlar (dokunulmayanlar)

`campaignEngineEnabled` false, toggle ucu yok; activate/pause/end, `activeVersionId` yazıcısı, K1/K2, gerçek
`CampaignTriggerEvent` üretimi yok; `FactSourceRegistry` yazıcısı, provider onayı / e-posta / telefon / Lemon webhook /
mock settle hook'u yok; scheduler/cron/dış çağrı/seed/admin grant yok; mevcut ücretli geçmiş lotlara ayrılmaz; gerçek
veride kampanya satırı üretilmez. `campaign-engine.service.ts` ve `campaign-engine.repository.ts` dokunulmaz.

## 8. Test planı

| Katman | Kapsam |
| --- | --- |
| Şema (`promo-credit-consumption-schema.spec.ts`) | enum'da 9 değer (6 eski + 3 yeni, sırayla); `(lotId, creditTransactionId)` unique; CHECK'ler (consumed 0, refunded>consumed, FORFEITED forfeitTx'siz, CONSUMED settledAt'lı); FK Restrict |
| Muhasebe (`promo-credit-ledger.spec.ts`) | promo yok → spend/refund ledger/bakiye/hata kodu bire bir; iki lot → en erken expiry önce; promo+paid dağılımı; refund aktif → canlanır, EXHAUSTED→ACTIVE; refund dolmuş/EXPIRED/REVOKED → düşer; expiry bir kez, ikinci sweep sıfır; grant/revoke primitive; çift refund 409, çift consume P2002; barrier ile iki eşzamanlı teklif → son promo kredisi bir kez; değişmez kontrolü |
| Regresyon | `credits-integrity`, `unviewed-offer-refund`, `request-removal-refund`, `offer-package-*`, `admin-offer-status`, tüm campaign spec'leri |
| Sıfır etki | `campaign-engine-isolation.spec.ts` snapshot'ına `consumptions` sayısı ve ledger tür kümesi (yalnız altı eski tür) eklenir |
| Migration | geçici DB'de `migrate deploy` + `migrate diff` boş + pg_enum sırası + `\d`; gerçek yerel/staging DB'ye komut yok |

## 9. S2B2'ye kalanlar

Motor adım 6 → `grantPromoCreditLot` (ledger + `grantTransactionId`); hook'lar (provider onayı, kanıtlar, webhook/mock
settle); aktivasyon/pause/end + `activeVersionId` yazıcısı + `FACT_SOURCE_UNAVAILABLE`; engine toggle ucu; süpürücü
scheduler anahtarı (`campaignLotExpirySchedulerEnabled`) + cron; `order_refunded` → revoke (S3); provider credits
yanıtında promo satırı ve refund mailinde net tutar (S4); `ADMIN_DEDUCT`'ın lotlara göre tanımı (S3/S4).
