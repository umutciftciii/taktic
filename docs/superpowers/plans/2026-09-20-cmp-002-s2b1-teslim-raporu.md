# CMP-002 S2B1 — Teslim raporu

Tarih: 2026-09-20 · Branch: `claude/cmp-002-s2b1-promo-credits-7c88bd` · Taban: `origin/main` @ `e801443a` ·
Tasarım notu: `docs/superpowers/specs/2026-09-20-cmp-002-s2b1-promo-credit-accounting-design.md` · Dry-run kaydı:
`docs/superpowers/plans/2026-09-20-cmp-002-s2b1-migration-dryrun.txt` · Bağlayıcı sözleşme: CMP-001 (rev. 3) §2.4–2.6.

PR: https://github.com/umutciftciii/taktic/pull/98 · head `5922278f` (+ bu rapor güncellemesi) · CI run 35531946012 **3/3 yeşil**
(typecheck·lint·test·build ✅, e2e chromium ✅, e2e webkit ✅).

Merge, deploy, yerel/staging eşitlemesi, gerçek `.env`, Cloudflare, Lemon veya gerçek veri işlemi **yapılmadı**.
Geçici DB'ler (`taktic_cmp002_s2b1_shadow`, `taktic_cmp002_s2b1_dryrun`, `taktic_cmp002s2b1_e2e`) yalnız bu iş için
oluşturuldu ve düşürüldü; yerel `taktic` DB'sine komut çalıştırılmadı.

---

## 1. Teslim edilen

| Katman | Dosya | İçerik |
| --- | --- | --- |
| Migration C | `prisma/migrations/20260920090000_add_promo_credit_consumption/migration.sql` (+ `schema.prisma`) | `CreditTransactionType += CAMPAIGN_GRANT, CAMPAIGN_EXPIRE, CAMPAIGN_REVOKE` (altı eski değer aynı sırada, anlam değişmedi); `PromoCreditLotConsumptionStatus {CONSUMED, REFUNDED, FORFEITED}`; `PromoCreditLotConsumption` (lot × OFFER_SPEND debit'i **unique**, 4 FK Restrict, 6 CHECK). **Yalnız additive:** DML/backfill/DROP/ALTER COLUMN yok. `CampaignRedemption.grantTransactionId` S2A'da zaten nullable+unique+FK(Restrict) idi; dokunulmadı |
| Muhasebe | `apps/api/src/modules/credits/promo-credit-ledger.ts` | tx-scoped saf fonksiyonlar: `readUnsweptExpiredPromoCredits`, `consumePromoCreditsForSpend`, `restorePromoConsumptionsForRefund`, `grantPromoCreditLot`, `expirePromoCreditLot`, `revokePromoCreditLot`; koşullu `updateMany` + P2034-uyumlu `PromoCreditWriteConflict` (runSerializable replay) |
| Süpürme seam'i | `credits/promo-credit-lot-expiry.service.ts`, `credits.module.ts` | `PromoCreditLotExpiryService.expireDueLots(now)` — lot başına `runSerializable`; **cron/anahtar/uç yok** |
| Resolver | `entitlements/entitlement-resolver.service.ts` | `resolve`: harcanabilir = bakiye − süpürülmemiş dolmuş lot kalanı; `consume`: `OFFER_SPEND` satırı **değişmedi**, ardından lot tüketimi aynı tx'te |
| Refund | `offers/offers.service.ts`, `service-requests.service.ts` | `refundOfferCreditInTransaction` `creditSpentTransactionId` alır (üç çağıran zaten seçiyordu), `OFFER_REFUND` satırı **değişmedi**, ardından tüketim settle; dönüşe `balanceAfter` eklendi → manuel iade yanıtı nihai bakiye |
| Finance | `finance/finance.service.ts` | `Record<CreditTransactionType, number>` toplamlarına üç yeni anahtar (0); okuyan rapor yok (S4) |
| Testler | `test/promo-credit-consumption-schema.spec.ts` (6), `test/promo-credit-ledger.spec.ts` (18), `campaign-engine-schema.spec.ts` (enum testi 6+3), `campaign-engine-isolation.spec.ts` (6, +iade akışı, +`consumptions`), `campaign-fixtures.ts` (`createPromoLotFixture`, `walletInvariant`), `harness.ts` (truncate) | §4–5 |

**Dokunulmayanlar (git diff kanıtı):** `campaigns/engine/*` (motor ve repository), `campaigns.module.ts` (hâlâ domain
import/export yok), `providers/`, `payments/`, `email-verification/`, `phone-verification/`, `operations-settings/`,
admin/web uygulamaları, `.env`/compose, `// CMP-002 fact callback` noktaları. `campaignEngineEnabled` false; toggle,
aktivasyon, `activeVersionId` yazıcısı, K1/K2, `CampaignTriggerEvent` üretimi, `FactSourceRegistry` yazıcısı, scheduler,
seed, admin grant **yok**. Mevcut ücretli geçmiş lotlara ayrılmadı; hiçbir eski debit/refund için tüketim satırı üretilmedi.

## 2. Migration C SQL özeti ve dry-run

```
CREATE TYPE PromoCreditLotConsumptionStatus ('CONSUMED','REFUNDED','FORFEITED')
ALTER TYPE CreditTransactionType ADD VALUE 'CAMPAIGN_GRANT' | 'CAMPAIGN_EXPIRE' | 'CAMPAIGN_REVOKE'   (PG16; add_request_matching emsali)
CREATE TABLE PromoCreditLotConsumption (id, lotId, creditTransactionId, consumedCredits, refundedCredits=0, forfeitedCredits=0,
  status='CONSUMED', refundTransactionId?, forfeitTransactionId? UNIQUE, consumedAt, settledAt?)
UNIQUE (lotId, creditTransactionId) · INDEX creditTransactionId, lotId, refundTransactionId · 4 FK ON DELETE RESTRICT
6 CHECK: credits_bounded · settlement_complete · consumed_untouched · refunded_whole · forfeited_whole · forfeit_row_matches_status
İfade türleri: CREATE TYPE 1 · ALTER TYPE 3 · CREATE TABLE 1 · CREATE (UNIQUE) INDEX 5 · ADD CONSTRAINT 10 — INSERT/UPDATE/DELETE/DROP/ALTER COLUMN 0
```

**İzole dry-run** (`taktic_cmp002_s2b1_dryrun`, düşürüldü): `migrate deploy` tüm zincir → **68 migration**; `migrate diff
--from-url --to-schema-datamodel` → **"No difference detected"**; pg_enum sırası `ADMIN_GRANT,ADMIN_DEDUCT,PACKAGE_PURCHASE,
OFFER_SPEND,OFFER_REFUND,ADJUSTMENT,CAMPAIGN_GRANT,CAMPAIGN_EXPIRE,CAMPAIGN_REVOKE`; yeni tablo 0 satır; `ProviderCreditTransaction`
kolonları değişmedi; `\d` ve CHECK tanımları kayıtta.

## 3. Yeni ledger türleri — hangi işlemde

| Tür | İşaret | S2B1'de yazan | Bağ (idempotency) |
| --- | --- | --- | --- |
| `CAMPAIGN_GRANT` | + | `grantPromoCreditLot` (çağıran: yalnız test; S2B2 motor adım 6) | `CampaignRedemption.grantTransactionId` unique; `PromoCreditLot.redemptionId` unique |
| `CAMPAIGN_EXPIRE` | − | (a) `expirePromoCreditLot` — dolan lotun kalanı; (b) iade anında lot dolmuş/`EXPIRED` ise tüketilen payın düşümü | (a) `PromoCreditLot.expiryTransactionId` unique; (b) `PromoCreditLotConsumption.forfeitTransactionId` unique |
| `CAMPAIGN_REVOKE` | − | (a) `revokePromoCreditLot` — lotun kalanı (çağıran: yalnız test; S3); (b) iade anında lot `REVOKED` ise düşüm | (a) `revokeTransactionId` unique; (b) `forfeitTransactionId` unique |

`referenceType/referenceId`: grant → `CampaignRedemption`; lot expiry/revoke → `PromoCreditLot`; iade düşümü →
`PromoCreditLotConsumption`. `reason`: `CAMPAIGN_GRANT`, `PROMO_LOT_EXPIRED`, `PROMO_LOT_REVOKED:<reason>`,
`PROMO_FORFEIT_ON_REFUND:EXPIRED|REVOKED`. Not: görev tanımı `CAMPAIGN_EXPIRE` dedi; CMP-001 metnindeki `CAMPAIGN_EXPIRY` aynı
mekanizmadır.

## 4. Transaction / idempotency modeli (kodda)

```
Teklif tx (providers.createOffer, Serializable, sınır değişmedi)
  resolve   balance = son balanceAfter ; unswept = Σ remaining(ACTIVE, remaining>0, expiresAt<=now)
            balance − unswept < cost → 402 (aynı mesaj/kod)
  consume   1 OFFER_SPEND (−cost)                          ← credits.service yazıcısı, değişmedi
            2 lots: ACTIVE ∧ remaining>0 ∧ expiresAt>now ORDER BY expiresAt ASC, id ASC
            3 lot başına: take=min(remaining, kalan); updateMany WHERE id ∧ ACTIVE ∧ remaining>=take ∧ expiresAt>now
                          → −take, remaining==take ⇒ EXHAUSTED ; count≠1 ⇒ P2034 (replay) ; INSERT consumption(lot, debit, take)
            promo yok ⇒ adım 2 boş; ek yazı yok
İade tx (üç çağıranın kendi Serializable tx'i)
  1 OFFER_REFUND (+cost) + Offer koşullu update + partial unique       ← değişmedi
  2 shares = consumption WHERE creditTransactionId = offer.creditSpentTransactionId ∧ status=CONSUMED
  3 canlanır (lot ACTIVE/EXHAUSTED ∧ expiresAt>now): lot updateMany (+consumed, ACTIVE) ; share → REFUNDED
    düşer  (EXPIRED | REVOKED | expiresAt<=now):     ledger −consumed (REVOKED ⇒ CAMPAIGN_REVOKE, aksi CAMPAIGN_EXPIRE) ; share → FORFEITED(forfeitTx)
  ikinci iade: adım 1'de 409 (partial unique / koşullu update) ; share `WHERE status=CONSUMED` ikinci savunma
Süpürme  expireDueLots(now): adaylar (ACTIVE|EXHAUSTED ∧ expiresAt<=now) ; lot başına runSerializable(expirePromoCreditLot)
         remaining>0 ⇒ CAMPAIGN_EXPIRE (−remaining) ; updateMany(aynı durum, expiryTransactionId IS NULL) → EXPIRED, 0 ; redemption GRANTED→EXPIRED
         ikinci çalıştırma: aday yok ⇒ sıfır yazı
```

Değişmez (her senaryoda test edildi): `Σ ledger.amount = son balanceAfter` ve `balance = paid + Σ remaining(ACTIVE|EXHAUSTED)`, `paid ≥ 0`.

## 5. Kaynak–iade matrisi (test kanıtı: `promo-credit-ledger.spec.ts`)

| Harcama kaynağı | İade anında lot | OFFER_REFUND | Ek satır | Lot | Tüketim | Test |
| --- | --- | --- | --- | --- | --- | --- |
| Yalnız ücretli | — | +cost | yok | — | yok | "byte-for-byte" (worker) + isolation iade akışı |
| Promo, lot geçerli | ACTIVE/EXHAUSTED, süresi geçmemiş | +cost | yok | `+consumed`, ACTIVE | REFUNDED | worker: EXHAUSTED→ACTIVE, bakiye 1→4 |
| Promo, lot süpürülmüş | EXPIRED | +cost | `CAMPAIGN_EXPIRE −consumed` | değişmez | FORFEITED | manuel iade; ledger `[+2,+4,−3,−1,+3,−3]` → bakiye 2; yanıt `balance=2`; audit `creditAmount=3` |
| Promo, lot dolmuş ama süpürülmemiş | ACTIVE, expiresAt<=now | +cost | `CAMPAIGN_EXPIRE −consumed` | değişmez (kalan sonradan süpürülür) | FORFEITED | manuel iade + sonraki sweep, 2 ayrı EXPIRE satırı |
| Promo, lot revoke | REVOKED | +cost | `CAMPAIGN_REVOKE −consumed` | değişmez | FORFEITED | talep kaldırma (PATCH REJECTED) |
| Karışık (2 lot + paid) | lot bazında | +cost | lot bazında | lot bazında | biri REFUNDED biri FORFEITED | manuel iade → bakiye 4 |
| Aynı teklif ikinci iade | — | 409 | yok | değişmez | değişmez | manuel 409 + worker 0 REFUNDED, ledger sayısı sabit |

Harcama tarafı: promo yok → ledger `[ADMIN_GRANT +5, OFFER_SPEND −2]`, 402 sıfır-yazı; iki lot (5 gün / 20 gün) + paid →
`[1 sooner, 2 later]` + 1 paid; promo kısmi → lot ACTIVE kalır, paid dokunulmaz; dolmuş-süpürülmemiş lot → 402 ve tüketim 0;
iki eşzamanlı teklif × son promo kredisi → tek tüketim, ikisi de 201 (biri promo, biri paid). Primitive'ler: grant (ledger+lot+link,
ikinci grant P2034, tek lot), expiry (bir kez; ikinci çağrı no-op; EXHAUSTED → EXPIRED ledger'sız; redemption EXPIRED), sweep
(2 sağlayıcı, 2 dolan + 1 canlı; ikinci sweep 0 satır), revoke (kalan düşer, `spentAtRevoke=4`, ikinci çağrı no-op).

## 6. Test ve derleme sonuçları (yerel, worktree)

| Adım | Sonuç |
| --- | --- |
| `pnpm typecheck` | ✅ exit 0 |
| `pnpm lint` | ✅ exit 0 |
| `pnpm test` | ✅ api **143 dosya / 3213 test**, web 37/338, admin 5/64, shared 6/168 |
| `pnpm build` | ✅ exit 0 |
| E2E Chromium (`pnpm e2e`, izole `taktic_cmp002s2b1_e2e`) | ✅ **285 passed, 0 failed** (8.7 dk) |
| E2E WebKit (`pnpm e2e:webkit`) | ✅ **116 passed, 0 failed** (4.1 dk) |
| Migration dry-run | ✅ 68 migration, diff boş (§2) |
| CI (run 35531946012, head `5922278f`) | ✅ 3/3: typecheck·lint·test·build, e2e chromium, e2e webkit (önceki run 35531142550 docs push'uyla iptal edildi; iki E2E job'ı orada da ✅) |

## 7. "Mevcut kredi davranışı değişmedi" kanıtı

1. Üretimde `PromoCreditLot` yoktur ve S2B1'de onu yazabilen tek yol `grantPromoCreditLot`'tur; çağıranı yalnız test
   fixture'ıdır (`grep -rn grantPromoCreditLot apps/api/src` → yalnız tanım). Motor (`campaign-engine.repository.ts`)
   dokunulmadı ve zaten kapalı/hook'suz.
2. Promo yokken spend yolu: aynı Serializable tx, aynı `OFFER_SPEND` yazıcısı, aynı 402 mesajı/kodu, aynı `balanceAfter`;
   eklenen yalnız iki boş okuma (`aggregate` + `findMany`). Refund yolu: aynı `OFFER_REFUND` satırı, aynı partial unique /
   koşullu update / 409; eklenen bir boş okuma. `credits-integrity`, `unviewed-offer-refund`, `request-removal-refund`,
   `admin-offer-status`, `offer-package-*` paketleri değişmeden geçti.
3. `campaign-engine-isolation.spec.ts`: onay, e-posta+telefon kanıtı, Lemon webhook settle, mock settle, teklif harcaması ve
   **teklif iadesi** — DRAFT + ACTIVE kampanyalar varken `CampaignTriggerEvent/Redemption/EvaluationLog/PromoCreditLot/
   PromoCreditLotConsumption/Counter` sayıları 0, `Campaign` sayaçları 0, ledger yalnız altı eski tür.
4. Enum: `pg_enum` sırası altı eski + üç yeni (`campaign-engine-schema.spec.ts`, `promo-credit-consumption-schema.spec.ts`);
   admin/web'deki tür etiket haritaları string literal'dir, typecheck kırılmadı; CAMPAIGN_* satırı üretimde yok.

## 8. Açık S2B2 (ve sonrası) sınırları

- Motor adım 6 → `grantPromoCreditLot` (ledger + `grantTransactionId`; `createRedemptionAndLot` yerine); motor açık testleri
  buna göre güncellenir (bugün S2A motoru ledger'sız lot yazar — yalnız testte).
- Hook'lar: provider onayı (`runSerializable` + evaluate + onProviderFact), e-posta/telefon kanıt yazıcıları, Lemon webhook /
  mock settle; `FactSourceRegistry` yazıcı kayıtları.
- Aktivasyon/pause/end uçları + `activeVersionId` yazıcısı + `FACT_SOURCE_UNAVAILABLE` / `LIMIT_BELOW_CONSUMED`; engine toggle ucu.
- Süpürücü scheduler anahtarı (`campaignLotExpirySchedulerEnabled`) + cron (`expireDueLots` hazır).
- S3: `order_refunded` → `revokePromoCreditLot` (primitive hazır), admin revoke ucu; `ADMIN_DEDUCT`'ın lotlara göre tanımı
  (bugün admin düşümü paid payını lotların altına indirebilir; ledger ≥ 0 korunur).
- S4: provider credits yanıtında promo satırı; refund mailinin promo düşümü olduğunda **net** tutarı göstermesi (bugün
  `OFFER_REFUND` satırının tutar/bakiyesini okur — promo yokken doğru); admin ledger etiketleri (`CAMPAIGN_*`).
