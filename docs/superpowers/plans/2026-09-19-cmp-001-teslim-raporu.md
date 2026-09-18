# CMP-001 — Kampanya motoru envanteri + çekirdek tasarım — Teslim Raporu

Tarih: 2026-09-19 · Branch `claude/cmp-001-campaign-engine-inventory-1dea0c` (taban `origin/main` @
`89ba7f22`, temiz worktree doğrulandı) · PR/head/CI §8 · Tasarım notu:
`docs/superpowers/specs/2026-09-19-cmp-001-campaign-engine-design.md`.

Docs-only. Üretim kodu, API, şema/migration, ödeme, kredi, webhook, admin UI, gerçek `.env`, Cloudflare,
deploy, yerel/staging container veya DB verisi **değişmedi**; salt-okunur inceleme dışında veri işlemi
yapılmadı. Merge/deploy/yerel eşitleme yapılmadı.

Ön çalışma belgesi `taktick-kampanya-modulu-on-calismasi.md` repoda, ana checkout'ta, worktree'lerde ve
Spotlight'ta **bulunamadı**; görev tanımındaki madde listesi bağlayıcı yön olarak alındı (tasarım notu
başındaki not).

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
3. Tetikleyiciler: `PROVIDER_APPROVED` (gerçek geçişte, aynı tx; tx `runSerializable`'a taşınır) ve
   `PACKAGE_PAYMENT_SUCCEEDED` (settle'da PAID sonrası, aynı tx). Inactivity/coupon **v1 modelinde yok**.
4. Tek fayda: süreli promosyon kredi lotu; paket bonusu aynı lotun tetikleyici varyantı.
5. Bakiye tanımı değişmez; lotlar bakiyenin içinde; `balance = paid + Σ lot.remaining` değişmezi; harcama en
   erken dolacak lot → ücretli; koşullu `updateMany` + Serializable, ek kilit yok.
6. Teklif iadesi lot'a döner; lot dolmuşsa aynı tx'te `CAMPAIGN_EXPIRY` ile net sıfır.
7. `order_refunded` → bonus lotun **harcanmamış** kısmı otomatik revoke; harcanmış kısım için borç/mahsup
   **yok** (`spentAtRevoke` + mevcut manuel inceleme bayrağı); `NO_PRIOR_REVOCATION` + `FIRST_SUCCESSFUL_PAID_PURCHASE`
   iade-tekrar-al döngüsünü keser; günlük revoke eşiği aşılırsa otomatik PAUSED.
8. Olay başına tek bonus: `triggerEventKey` global unique; deterministik seçim `priority, activatedAt, id`;
   `stackPolicy` yalnız `EXCLUSIVE`; `perProvider` sabit 1 (DB unique).
9. Bütçe **kredi** olarak; koşullu artırım ile atomik; revoke/expiry bütçeye dönmez.
10. Kill switch `OperationsSettings.campaignEngineEnabled` (varsayılan kapalı) + süpürücü anahtarı; sağlayıcı
    yalnız promo bakiye/son kullanma görür; kural, bütçe, diğer kullanıcılar gizli.

## 3. Önerilen veri modeli

Enum'lar: `CampaignStatus, CampaignTrigger, CampaignBenefitType, CampaignStackPolicy,
CampaignRedemptionStatus, CampaignRevokeReason, PromoCreditLotStatus, CampaignAuditAction`;
`CreditTransactionType += CAMPAIGN_GRANT, CAMPAIGN_EXPIRY, CAMPAIGN_REVOKE`.

Modeller: `Campaign`, `CampaignVersion` (unique `[campaignId, versionNumber]`), `CampaignRedemption` (unique
`triggerEventKey`, `[campaignId, providerId]`, `grantTransactionId`, `promoLotId`), `PromoCreditLot` (unique
`redemptionId`, CHECK `0 ≤ remaining ≤ granted`), `PromoCreditLotConsumption` (unique `[lotId,
creditTransactionId]`), `CampaignEvaluationLog` (unique `triggerEventKey`), `CampaignDailyCounter`,
`CampaignAuditLog`, `OperationsSettings` iki yeni Boolean. Cascade silme yok. Tam tablo: tasarım notu §3.

## 4. En riskli geri alma/harcama kararı

Paket iadesinde **harcanmış bonus geri alınmaz** (borç/mahsup yok). Gerekçe: `balanceAfter<0` yasak,
borç modeli yok, mevcut ürün ilkesi "iade insan kararı". Telafi: harcanmamış kısım otomatik revoke, harcanan
miktar kayıt + manuel inceleme bayrağı, `NO_PRIOR_REVOCATION` ile gelecekteki bonus kapanır, eşik aşımında
kampanya otomatik durur; K2 bu koşullar olmadan açılmaz. İkinci risk — promo ile harcanıp süre dolduktan sonra
gelen 48s iadesi — aynı tx'te expire ile kapatıldı.

## 5. CMP-002 dilimleri

| Dilim | Migration | Beta için |
| --- | --- | --- |
| S0 kural çekirdeği (saf, unit) | yok | zorunlu |
| S1 kampanya tanımı + admin API/UI | **A** | zorunlu |
| S2 hak ediş + lot + harcama + expiry süpürücü + kill switch | **B** | zorunlu |
| S3 sağlayıcı yüzeyi + grant maili | yok | hemen ardından |
| S4 reversal/revoke + denetim ekranları + otomatik PAUSE | yok | K2 için zorunlu |
| S5 E2E + fingerprint + runbook | yok | merge öncesi |

En kısa güvenli beta yolu: S0+S1+S2 (+S4 revoke). **Önkoşul (CMP-002 dışı):** sağlayıcı hesabına e-posta ve
telefon kanıtı kazandıran akış; bugün yok, K1 bu olmadan hiç hak ettirmez.

## 6. İlk iki beta kampanyası

- **K1** `PROVIDER_APPROVED`: `FIRST_PROVIDER_APPROVAL ∧ EMAIL_VERIFIED ∧ PHONE_VERIFIED ∧ NO_PRIOR_REVOCATION`
  → 10 kredi / 30 gün; perProvider 1, global 1000, perDay 100.
- **K2** `PACKAGE_PAYMENT_SUCCEEDED`: `OFFER_PACKAGE ∧ ONE_TIME_CREDITS ∧ FIRST_SUCCESSFUL_PAID_PURCHASE ∧
  MIN_PAID_AMOUNT 50000 kuruş ∧ NO_PRIOR_REVOCATION` → 5 kredi / 60 gün; global 2000; pencere 2026-10-01 →
  2026-12-31.

JSON'lar: tasarım notu §7.

## 7. Kapsam dışı

Checkout indirimi, ücretsiz vitrin, referral, müşteri indirimi, yorum/kalite ödülü, coupon, scheduled
inactivity, para bazlı bütçe, borç/mahsup, Lemon iade çağrısı, kademeli admin rolü, sağlayıcı kanıt akışı
(ayrı iş), `taxNumber` tekilleştirme, çok-instance scheduler kilidi, expiry/revoke e-postaları.

## 8. PR / head / CI

PR [#94](https://github.com/umutciftciii/taktic/pull/94) · docs head `26dba7a6` · CI **3/3 geçti**
([run 35398916651](https://github.com/umutciftciii/taktic/actions/runs/35398916651)): typecheck · lint ·
test · build (13m36s), e2e chromium (15m37s), e2e webkit (12m19s). Bu satırı ekleyen commit yalnız bu
raporu değiştirir.
