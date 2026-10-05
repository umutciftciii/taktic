# CAMPAIGN-CREDIT-POLICY-001 — Teslim raporu

- Taban: `main` `c942fc2d` (#144), DB 86 migration
- Dal: `claude/campaign-credit-policy-001`
- Migration: **1** — `20261005120000_add_campaign_credit_policy` (DB 86 → 87), additive + açık demo backfill
- Staging / production: **dokunulmadı**. Yerel aktif DB'ye migration **uygulanmadı** (aşağıda §6).

## 1. Domain modeli

Bonus kredi üreten her `CampaignVersion` iki bağımsız eksen taşır:

| Eksen | Değerler | Anlam |
|---|---|---|
| `spendPriority` | `PROMO_FIRST` / `PAID_FIRST` | Lot, şelalede ücretli havuzun önünde mi arkasında mı |
| `adminDeductPolicy` | `PAID_ONLY` / `ALLOW_PROMO` | `ADMIN_DEDUCT` bu lota dokunabilir mi |

- Politika JSON'da (`definition.benefit.creditPolicy`, şema **v2**) ve denormalize kolonlarda aynı anlık görüntüdür; DB CHECK ikisinin eşitliğini zorlar.
- Kredi üretmeyen fayda tipi için kolonlar NULL, JSON'da alan yasak (validator `CREDIT_POLICY_NOT_APPLICABLE`).
- `PromoCreditLot` grant anında version politikasını kopyalar (NOT NULL, BEFORE INSERT trigger version ile eşitliği doğrular, UPDATE trigger değişikliği reddeder). Sonraki version'lar eski lotun anlamını değiştiremez.
- `PromoCreditLotConsumption.source` (`OFFER_SPEND` / `ADMIN_DEDUCT`): ledger satır tipine eşit (trigger), değişmez (trigger); `ADMIN_DEDUCT` payı hiçbir zaman REFUNDED/FORFEITED olamaz (CHECK).

## 2. Kanonik cüzdan borçlandırma şelalesi

`apps/api/src/modules/credits/promo-credit-ledger.ts` — `planWalletDebit` (saf) + `debitWallet` (yazıcı):

1. son `balanceAfter` + ACTIVE/EXHAUSTED lotlar okunur; `paid = balance − Σ remaining`; `paid < 0` → `WalletInvariantViolation`, hiçbir yazma yok.
2. Uygun lot: `ACTIVE ∧ remaining > 0 ∧ expiresAt > now` (+ ADMIN_DEDUCT için `ALLOW_PROMO`).
3. Sıra: **PROMO_FIRST lotlar (expiresAt ↑, id ↑) → ücretli havuz → PAID_FIRST lotlar (expiresAt ↑, id ↑)**; id karşılaştırması kod birimi (collation bağımsız).
4. Yetersizse hep-ya-hiç red (`WalletDebitRefused`), hiçbir yazma yok.
5. Tek ledger satırı + her pay için koşullu lot UPDATE + `source`'lu consumption satırı; koşul tutmazsa P2034 → `runSerializable` tüm transaction'ı yeniden oynatır.

Taşınan yollar: teklif gönderimi (`entitlement-resolver`), iade edilmiş teklifin kabulde yeniden tahsili (`offers.service`), `ADMIN_DEDUCT` (`credits.service`). İade/revoke/expiry kaynak seçmez; gerçek consumption satırlarını ve lot kalanlarını okur (değişmedi). PAID_FIRST lotun ücretli kredi varken süresinin dolması beklenen davranıştır.

## 3. ADMIN_DEDUCT

- Kesilebilir = ücretli + `ALLOW_PROMO` uygun lotlar; `PAID_ONLY` lotlar korunur.
- `amount > balance` → 400 `CREDIT_BALANCE_INSUFFICIENT` (mesaj "Credit balance cannot go below zero" korunur).
- `balance ≥ amount > deductible` → 400 `CREDIT_DEDUCT_EXCEEDS_DEDUCTIBLE` `{ requestedCredits, deductibleCredits, paidCredits, protectedPromoCredits, balance }`; hiçbir ledger/lot/consumption/idempotency yazımı yok.
- Bozuk cüzdan → 500 `WALLET_INVARIANT_VIOLATION`, hiçbir yazma yok.
- `ADMIN_GRANT` ücretli kredi olarak kalır.
- Önceki açık kapandı: eski `ADMIN_DEDUCT` lotlara dokunmadan toplam bakiyeyi düşürdüğü için ücretli havuz negatife inebiliyor, sonra lotun expiry/revoke'u "bakiye eksiye düşer" çakışmasıyla sonsuza kadar SKIPPED/409'da kalıyordu.

## 4. ADMIN_DEDUCT idempotency

**Soru:** ADMIN_DEDUCT commit edildi, istemci cevabı alamadı, aynı işlem yeniden gönderildi — ikinci kez kesilebilir mi?

**Önceki durum: evet.** Onay kanıtı (`apps/admin/lib/confirmation-proof-server.ts`) yalnız admin sürecinin belleğindedir, ilk gönderimde harcanır, işlem payload'ına bağlı değildir ve API onu hiç görmez. Cevabı kaybolan operatör yeniden onaylar (yeni kanıt) ve gönderir → ikinci kesinti. Ayrıca API'yi doğrudan çağıran her istemci için hiçbir koruma yoktu; admin ekranı belirsiz hatada "kredi hareketi oluşmadı" diyordu.

**Bu PR:** kalıcı idempotency (`ManualCreditOperation`, hem grant hem deduct):

- Form, işlem başına bir `idempotencyKey` (UUID) üretir (hidrasyondan sonra), her yeniden denemede aynısını gönderir, yalnız başarıda yeniler. API'de zorunlu (`^[A-Za-z0-9_-]{16,128}$`).
- Aynı Serializable transaction'da: anahtar varsa ve (provider, tip, tutar, gerekçe, aktör) aynıysa **orijinal ledger satırı döner, hiçbir şey yazılmaz**; farklıysa 409 `IDEMPOTENCY_KEY_REUSED`. Eşzamanlı ilk denemeler unique anahtarda buluşur; kaybeden kazananın satırını döner.
- DB: unique anahtar, tip CHECK'i, ledger satırıyla eşleşme trigger'ı, append-only trigger.
- Admin mesajı: belirsiz hatada "İşlemin sonucu doğrulanamadı… kredi iki kez hareket etmez".
- Kanıt: `apps/api/test/campaign-credit-policy.spec.ts` › "the scenario: a deduct commits, its answer is lost…" ve eşzamanlı/aynı-anahtar/farklı-payload testleri.

## 5. Şema v2

- `packages/shared/campaign-rules.json` `schemaVersion: 2`; `benefit.creditPolicy` zorunlu, enum doğrulama, bilinmeyen alan reddi; v1 artık `UNSUPPORTED_SCHEMA_VERSION`.
- Migration tüm demo version JSON'larını açıkça v2'ye yazar (`schemaVersion: 2`, `benefit.creditPolicy = {PROMO_FIRST, PAID_ONLY}`, `channel` yoksa kolondan açık).
- Audit: `VERSION_CREATED` ve `VERSION_ACTIVATED` özetinde `creditPolicy`; politika değişikliği `changedFields`'ta ayrıca `creditPolicy` olarak görünür.

## 6. Migration güvenliği

- Aktif DB yedeği: `~/Backups/taktic/db/taktic-db-20261005T183954Z-pre-cp001.dump` (+ `.sha256`, `ada35a28…a177`).
- Yalıtılmış doğrulama: dump → `cp001_verify` DB'sine restore; kopya parmak izi aktif DB ile **birebir** aynı; yalnız `prisma migrate deploy` (reset/dev/db push/aktif DB shadow kullanılmadı).
- Önce/sonra parmak izi (kopya üzerinde):

| Ölçü | Önce | Sonra |
|---|---|---|
| tablo satır toplamı | 1081 | 1082 (+1 `_prisma_migrations`, yeni boş `ManualCreditOperation`) |
| ledger md5 (41 satır) | `1a2f2eb5…` | aynı |
| lot çekirdeği md5 (6) | `085e57f9…` | aynı |
| consumption çekirdeği md5 (2) | `f2470db2…` | aynı |
| redemption md5 (6, rulesSnapshot dahil) | `2b00caf4…` | aynı |
| version çekirdeği md5 (8) | `7af44a53…` | aynı |
| definition − (schemaVersion, creditPolicy, channel) md5 | `1bf0ef5a…` | aynı |
| kampanya md5 (8) | `12f23b6f…` | aynı |
| cüzdan bakiyeleri md5 (9) | `8a409d57…` | aynı |

- Sonra: 8/8 version `PROMO_FIRST`+`PAID_ONLY`, 8/8 JSON v2 + creditPolicy + açık channel, 8/8 v2 validator'dan geçer; 6/6 lot version politikasına eşit; 2/2 consumption `OFFER_SPEND`; negatif ücretli havuzlu cüzdan 0; ikinci `migrate deploy` "No pending"; şema drift'i yok.
- Aktif `taktic` DB 86'da bırakıldı: yerel stack `main` kodunu çalıştırıyor ve bu kod v2 JSON'u okuyamaz, yeni NOT NULL lot kolonlarını yazmaz. Uygulama merge sonrası yerel eşitlemede, aynı dump yolu ve `migrate deploy` ile yapılır.

## 7. Testler

Yeni hedefli testler:

- `apps/api/test/campaign-credit-policy.spec.ts` — planlayıcı: 4 kombinasyon × promo-only / paid-only / mixed, çoklu kampanya lotu, PROMO_FIRST + PAID_FIRST birlikte, farklı expiry, eşit expiry'de id tie-break, süresi dolmuş/revoke/exhausted dışlama, `paid < 0` fail-closed; HTTP üzerinden OFFER_SPEND (kısmi lot), iade, kabulde yeniden tahsil; ADMIN_DEDUCT (şelale, PAID_ONLY koruması, iki hata sözleşmesi, hiçbir yazma olmaması, deduct sonrası revoke/expiry, kesilen payın iadeye girmemesi); idempotency (cevabı kaybolan tekrar, eşzamanlı aynı anahtar, farklı payload 409, anahtarsız 400, grant); yarışlar (paralel spend, paralel deduct, spend↔revoke, deduct↔revoke/expiry); DB garantileri (policy değişmezliği, lot snapshot, JSON↔kolon CHECK, source↔tip trigger); admin projeksiyonları.
- `apps/admin/test/campaign-credit-policy.spec.tsx`, `apps/admin/test/credit-amount.spec.ts` (anahtar, yeni hata mesajları, belirsiz hata metni), `apps/web/test/promo-spend-priority.spec.ts`, `e2e/tests/campaign-credit-policy.spec.ts`.
- Validator, aktivasyon audit'i, paket iadesi uygunluğu ve promo görünürlük spec'leri güncellendi.

Son yerel regresyon (tek sefer):

| Kapı | Sonuç |
|---|---|
| `pnpm typecheck` | 5/5 |
| `pnpm lint` | temiz |
| `turbo test` | API 195 dosya / 4331 test, admin 36 / 996, web 46 / 385, shared 7 / 176 — hepsi geçti |
| `pnpm e2e` (build + chromium tam suite) | 492 passed, 0 failed |
