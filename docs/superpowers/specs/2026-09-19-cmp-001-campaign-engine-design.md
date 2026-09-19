# CMP-001 — Yapılandırılabilir Kampanya Motoru: Envanter + Çekirdek Tasarım

Tarih: 2026-09-19 · Taban: `origin/main` @ `89ba7f22` (SEO-003 merge, temiz worktree doğrulandı) · Docs-only ·
Revizyon 2 (aynı gün): K1 zamanlama düzeltmesi (§8), AUTH-PROVIDER-CONTACT-001 (§9), genelleştirilmiş limit/bütçe (§10), güncel dilimler (§11) ·
Revizyon 3 (aynı gün): olay kimliği ↔ redemption tekilliği ayrımı, `EXCLUSIVE_CREDIT_BONUS` stack/conflict sözleşmesi (§12).

Bu belge CMP-002'nin uygulayacağı sözleşmedir. Üretim kodu, API davranışı, şema/migration, ödeme, kredi,
webhook, admin UI, gerçek `.env`, Cloudflare, deploy, yerel/staging container veya DB verisi **değişmedi**;
salt-okunur inceleme dışında veri işlemi yapılmadı.

Bağlayıcı karar yönü (ön çalışma özeti): kampanya = adminin oluşturduğu **tetikleyici + allowlist koşul +
fayda + limit** bileşimi; kampanya başına kod yazılmaz. Serbest JS/SQL/expression, webhook URL'si veya
istemci tarafı hak ediş kararı yok. Ödeme otoritesi doğrulanmış Lemon Squeezy webhook'u; kredi/geri alma
otoritesi TakTic API'si. İlk beta: yalnız sağlayıcı edinimi + paket bonusu; ilk fayda türü **süreli
promosyon kredi lotu**. Kanıt kaynağı yalnız `User.emailVerifiedAt` / `User.phoneVerifiedAt`.

> Not: `taktick-kampanya-modulu-on-calismasi.md` repoda, ana checkout'ta, worktree'lerde ve Spotlight'ta
> bulunamadı. Belgenin repo dışında olması kararları geçersiz kılmaz: CMP-001 brief'i ve bu belgedeki güvenli
> katalog (allowlist) yaklaşımı bağlayıcıdır.

---

## 1. Mevcut sistem envanteri (dosya:satır kanıtlı)

### 1.1 Kredi defteri (`ProviderCreditTransaction`)

| Konu | Bugün | Kanıt |
| --- | --- | --- |
| Şema | `providerId, type, amount (±), balanceAfter, reason, referenceType/referenceId, createdById`; append-only, güncelleme/silme yolu yok | `prisma/schema.prisma:1930-1957` |
| Tür enum'u | `ADMIN_GRANT, ADMIN_DEDUCT, PACKAGE_PURCHASE, OFFER_SPEND, OFFER_REFUND, ADJUSTMENT` (`ADJUSTMENT` yazan kod yok) | `prisma/schema.prisma:243-250` |
| Bakiye | Tek koşulu bakiye; **son satırın `balanceAfter`'ı** (`createdAt desc, id desc`). Lot/segment/son-kullanma kavramı **yok** | `credits.service.ts:303-312`, `entitlement-resolver.service.ts:322-330`, `offers.service.ts:1059-1069` |
| Yazım kapısı | Tek yazıcı fonksiyon `createProviderCreditTransactionInTransaction`: provider varlığı, son satırı oku, `balanceAfter<0` → 400 (**negatif bakiye yasak**) | `credits.service.ts:321-355` |
| İzolasyon | Tek başına çağrıda `Serializable` (`$transaction` + isolationLevel); çağıranlar `runSerializable` (P2034 → 3 deneme, sonra 409 `CONCURRENT_MODIFICATION`) | `credits.service.ts:314-319`, `common/serializable-transaction.ts:62-103` |
| Satır kilidi | `SELECT … FOR UPDATE`/advisory lock **yok**; eşzamanlılık yalnız Serializable çakışmasına dayanır | (grep: `FOR UPDATE`, `$queryRaw` yok) |
| Idempotency | Genel anahtar **yok**. Tek DB garantisi: `OFFER_REFUND` için partial unique `("referenceId") WHERE type='OFFER_REFUND' AND referenceType='Offer'` | `prisma/schema.prisma:1949-1955` |
| Admin manuel | `POST /providers/:id/credits/grant|deduct` (SUPER_ADMIN, zorunlu reason≥3) | `credits.controller.ts:114-135`, `credits.service.ts:277-301` |
| Okuma | Sağlayıcı: `GET /providers/:id/credits` (bakiye + son 20 satır), admin finance ledger | `credits.controller.ts:95-112`, `finance.controller.ts:29-34` |

**Bugün doğrudan defter yazan noktalar (tam liste):**

1. `entitlement-resolver.service.ts:220-227` — `OFFER_SPEND` (−creditCost), teklif oluşturma tx'i içinde.
2. `payments-webhook.service.ts:554-561` — `PACKAGE_PURCHASE` (+creditAmountSnapshot), yalnız ONE_TIME_CREDITS.
3. `package-purchases.service.ts:290-296` — `PACKAGE_PURCHASE`, mock adapter (PAYMENT_PROVIDER=mock).
4. `offers.service.ts:956-985` — `OFFER_REFUND` (+creditCost), otomatik 48s worker + manuel admin iadesi.
5. `credits.service.ts:277-301` — `ADMIN_GRANT` / `ADMIN_DEDUCT`.

### 1.2 Teklifte kredi düşümü ve geri alma

| Konu | Bugün | Kanıt |
| --- | --- | --- |
| Sıra | `resolve()`: (0) direkt vitrin lead'i ücretsiz → (1) aktif CATEGORY_UNLIMITED dönem → (2) MONTHLY_QUOTA (`endAt asc`) → (3) tek seferlik bakiye → 402 | `entitlement-resolver.service.ts:94-165` |
| Kota düşümü | Koşullu `updateMany … remainingQuota >= cost` → `decrement`; `count!==1` → 402 (**yarış-güvenli örüntü**) | `entitlement-resolver.service.ts:197-216` |
| Tx sınırı | Teklif oluşturma tamamı `runSerializable`; fiyat, karar, `Offer` insert, `consume` aynı tx | `providers.service.ts:1181-1362` |
| Snapshot | `Offer.creditCost`, `entitlementSource`, `entitlementId`, `unviewedRefundWindowHours/EligibleAt` teklife dondurulur | `providers.service.ts:1318-1352`, `schema.prisma:1320-1400` |
| Otomatik iade | 48s görülmemiş teklif: worker teklif başına `runSerializable`; koşullu `updateMany` (viewedAt null, refundBlockedAt null, eligibleAt ≤ now, refund kolonları null) + partial unique | `offers.service.ts:893-954`, `unviewed-offer-refund.service.ts:145-200`, scheduler `unviewed-offer-refund.scheduler.ts:49-70` |
| Manuel iade | `POST /offers/:id/refund-credit` (SUPER_ADMIN), `ManualOfferRefundAudit` zorunlu, `offerId` UNIQUE + `creditTransactionId` UNIQUE | `offers.controller.ts:100`, `schema.prisma:1972-2002` |
| Geri alma tutarı | Tam `creditCost`; kısmi iade yok; iade **hangi kaynaktan harcandığına bakmaz** (tek bakiye) | `offers.service.ts:906-912` |
| Negatif bakiye | Yasak (400) | `credits.service.ts:339-341` |

### 1.3 Paket / SKU / variant / checkout / webhook / iade

| Konu | Bugün | Kanıt |
| --- | --- | --- |
| Katalog | `OfferCreditPackage` (`slug` unique, `type`: ONE_TIME_CREDITS / MONTHLY_QUOTA / CATEGORY_UNLIMITED, `creditAmount`, `priceAmount` kuruş, `isActive`) | `schema.prisma:1524-1560` |
| Variant eşlemesi | `LEMON_SQUEEZY_VARIANT_MAP` env: slug → variant id (allowlist) | `lemon-squeezy.config.ts:57-69` |
| Checkout | `POST /providers/:id/checkout-sessions` yalnız PROVIDER rolü; `PackagePurchase` PENDING + `paymentReference` (uygulamanın opak token'ı, unique) → Lemon checkout; adapter hatası → FAILED | `payments.service.ts:88-197`, `payments.controller.ts:42-50`, `schema.prisma:1662` |
| Yeniden kullanım | Aynı paket için süresi geçmemiş PENDING checkout tekrar sunulur | `payments.service.ts:187-208` |
| Webhook doğrulama | Ham byte üzerinde HMAC-SHA256 `x-signature`, sabit zamanlı karşılaştırma; başarısız → 401, sıfır yazım | `lemon-squeezy.webhook.ts:87-107`, `lemon-squeezy-webhook.controller.ts:30-37` |
| Kabul edilen olaylar | `order_created` + `status='paid'` → yükleme; `order_refunded`, `subscription_payment_refunded` → **yalnız bayrak** | `lemon-squeezy.webhook.ts:25-43` |
| Olay anahtarı | `eventKey = eventName:objectType:objectId` (Lemon olay id'si sağlamaz) → `PaymentWebhookEvent @@unique([provider,eventKey])` | `lemon-squeezy.webhook.ts:149`, `schema.prisma:1913` |
| Settle kontrolleri | test-mode, store id, reference, purchase PENDING, **tam tutar eşitliği** (`chargedMinor == priceAmountSnapshot`), para birimi, variant, `providerOrderId` unique | `payments-webhook.service.ts:346-455`, `schema.prisma:1669` |
| Settle yazımı | Tek Serializable tx: PAID + `paidAt` + `providerOrderId` + ledger (ONE_TIME) veya entitlement; `PROCESSED` terminal, tekrar teslim → `duplicate` | `payments-webhook.service.ts:236-308, 536-592` |
| Tekrar webhook | `MISMATCHED/IGNORED` yeniden yargılanır; `PROCESSED/MANUAL_REVIEW_REQUIRED` terminal; attemptCount sayılır | `payments-webhook.service.ts:106-118, 780-810` |
| İade/chargeback | `manualReviewReason='PAYMENT_REVERSAL_REPORTED'` + `manualReviewAt`; **kredi/para hareketi yok** | `payments-webhook.service.ts:652-712`, `schema.prisma:1675-1676` |
| `REFUNDED` durumu | Enum'da var, **yazan kod yok** (yalnız finance sayımı) | `schema.prisma:252-259`, `finance.service.ts:176` |
| Admin müdahale | Yalnız PENDING → CANCELLED/EXPIRED; PAID satıra dokunulamaz; iade endpoint'i **yok** | `package-purchases.service.ts:443-480, 607-612` |
| Lemon iade API'si | `POST /v1/orders/:id/refund` (kısmi `amount` desteği); `order_refunded` hem tam hem kısmi iadede tetiklenir; non-2xx → 3 tekrar (5s/25s/125s) | Resmî doküman: <https://docs.lemonsqueezy.com/api/orders/issue-refund>, <https://docs.lemonsqueezy.com/help/webhooks/event-types>, <https://docs.lemonsqueezy.com/help/webhooks/webhook-requests> |

### 1.4 Sağlayıcı kimliği, onay, kanıt

| Konu | Bugün | Kanıt |
| --- | --- | --- |
| Kanonik kimlik | `ProviderProfile.id` = işletme; `userId` nullable **unique** (bir hesap ≤ 1 profil; misafir başvuru `userId=null`) | `schema.prisma:1176` |
| İşletme tekilleştirme | `taxNumber` nullable, **unique değil**; `phone`/`email` yalnız index; `businessName` serbest | `schema.prisma:1177-1182` |
| Hesap tekilleştirme | `User.email` ve `User.phone` global unique (rol bağımsız), E.164 (AUTH-REG-001) | `schema.prisma:359-360`, `auth.service.ts:254-300` |
| Onay | `updateProviderStatus`: **düz `$transaction`** (Serializable değil, retry yok); `approvedAt` her APPROVED yazımında **üzerine yazılır**; geçiş tespiti `existing.status !== APPROVED`; onay geçmişi/audit tablosu **yok** | `providers.service.ts:947-1031` |
| Onay bildirimi | Yalnız gerçek geçişte; dedupe `NotificationLog(template, dedupeKey)` | `providers.service.ts:1020-1027`, `schema.prisma:1137` |
| E-posta kanıtı | `emailVerifiedAt` yazıcıları: `email-verification.service.ts:132` (yalnız `role === CUSTOMER`, satır 165) ve `customer-activation.service.ts:440` | — |
| Telefon kanıtı | `phoneVerifiedAt` yazıcısı: `phone-verification.service.ts:210-218` (yalnız CUSTOMER + kendi talebi); profil numara değişince sıfırlanır `account.service.ts:121` | — |
| **Sağlayıcı kanıtı** | PROVIDER kaydı (`auth.service.ts:56-57, 254-300`) e-posta doğrulama göndermez, OTP yok; claim akışı `emailVerifiedAt` yazmaz → **sağlayıcı hesabının e-posta/telefon kanıtı kazanma yolu YOK** | (grep: provider-claim/provider-invites/auth'ta `emailVerifiedAt` yazımı yok) |
| Kanıt uçları | `register-customer` doğrulama başlatır (`auth.controller.ts:98`), `register-provider` (`:107`) başlatmaz; `POST /auth/email-verification/resend` (`auth/email-verification.controller.ts:32-36`) → `issue()` PROVIDER için sessiz döner (`email-verification.service.ts:165`); `PATCH /account/profile` yalnız CUSTOMER (`account.controller.ts:40-42`); sağlayıcı profil düzenlemesi `User.email/phone`'a dokunmaz (`providers.service.ts:1624,1629`) | — |
| RBAC | Roller yalnız `SUPER_ADMIN, CUSTOMER, PROVIDER`; admin uçları `@Roles(SUPER_ADMIN)`; kademeli admin rolü **yok** | `schema.prisma:10-14`, `credits.controller.ts:47-49` |

### 1.5 Audit, outbox, bildirim, scheduler, izolasyon kalıpları

| Kalıp | Var mı | Kanıt / not |
| --- | --- | --- |
| Genel admin audit log | **Yok** — konuya özel tablolar: `OperationsSettingsChange` (setting, previous/new text, changedById), `ManualOfferRefundAudit`, `ShowcaseCardAutoPublishAudit` | `schema.prisma:588-606, 1972-2002` |
| Domain event bus / transactional outbox | **Yok**. `EventEmitter2`, kuyruk (BullMQ) yok. Tek "outbox": `NotificationLog` PENDING satırlarını süpüren mail outbox (`request-expiry-outbox.service.ts`, `file-outbox-notification.adapter.ts`) | `apps/api/src/modules/notifications/` |
| Bildirim dedupe | `NotificationLog @@unique([template, dedupeKey])` | `schema.prisma:1137` |
| Scheduler | `@nestjs/schedule` `@Cron`; cron env'den (`scheduler-cron.ts:33-50`), açma/kapama `OperationsSettings.*SchedulerEnabled` (varsayılan false); in-process `isRunning` kilidi (**çok-instance kilidi yok**); `SchedulerRunRegistry` bellek içi | `scheduler-cron.ts`, `unviewed-offer-refund.scheduler.ts:30-70`, `scheduler-run-registry.service.ts:35-38` |
| Süre dolumu süpürme örneği | `expireDuePeriods`: `updateMany endAt<=now → EXPIRED`; okuyucular `endAt`'e de bakar (süpürücü durursa ekstra gün yok) | `entitlements.service.ts:191-197`, `schema.prisma:1468-1480` |
| Serializable + retry | `runSerializable` (3 deneme, P2034) ve webhook için `isConcurrentModificationError` ile committed-state'ten karar | `common/serializable-transaction.ts:62-161` |
| Feature switch | `OperationsSettings` singleton (`id="singleton"`), SUPER_ADMIN ekranı; env değil | `schema.prisma:518-540` |
| Migration | 65 klasör, `YYYYMMDDHHMMSS_snake` adı; partial index/CHECK'ler ham SQL ile | `prisma/migrations/` |

### 1.6 Akış haritası — bugün ve kampanya motorunun bağlanacağı noktalar

```
[Lemon] order_created(paid)                        [Admin] PATCH /providers/:id/status=APPROVED
   │ HMAC (401 ⇢ 0 yazım)                              │ düz $transaction (providers.service.ts:957)
   ▼                                                   ▼
PaymentsWebhookService.loadCredits  (runSerializable)  providerProfile.update{status, approvedAt}
   ├─ PROCESSED? → duplicate                           ├─ claim token iptali / vitrin askı-devam
   ├─ settle(): store/ref/amount/currency/variant       ├─ [CMP hook ②] PROVIDER_APPROVED (yalnız existing.status !== APPROVED)
   ├─ purchase → PAID + providerOrderId                  └─ [CMP hook ⑦] onProviderFact(PROVIDER_APPROVED) → uygunluk geçişi (§8)
   ├─ ONE_TIME: ledger PACKAGE_PURCHASE (+N)  ◄── (1)
   ├─ dönem paketi: grantEntitlementForPurchase
   └─ [CMP hook ①] PACKAGE_PAYMENT_SUCCEEDED
        (aynı tx, purchase PAID olduktan sonra)

[Provider] POST /providers/:id/requests/:req/offers  (runSerializable, providers.service.ts:1181)
   ├─ fiyat/kategori/alan/spam kuralları
   ├─ resolve(): vitrin ücretsiz → UNLIMITED → QUOTA → bakiye → 402
   ├─ offer.create (snapshot)
   └─ consume(): OFFER_SPEND (−cost) ◄── (2)   [CMP hook ③: promo lot önce tüketilir]

[Worker/Admin] iade: OFFER_REFUND (+cost) ◄── (4)  [CMP hook ④: lot'a geri yaz / süresi dolduysa aynı tx'te expire]
[Admin] grant/deduct ◄── (5)
[Lemon] order_refunded → manualReviewReason bayrağı  [CMP hook ⑤: bonus lotun harcanmamış kısmını geri al]
[Cron] (yeni) campaign-lot-expiry → CAMPAIGN_EXPIRY (−remaining)  [CMP hook ⑥]
[User] emailVerifiedAt / phoneVerifiedAt yazımı (bugün yalnız CUSTOMER yolları, §9.1)
   └─ [CMP hook ⑦] onProviderFact(EMAIL_VERIFIED | PHONE_VERIFIED) — PROVIDER yazıcıları AUTH-PROVIDER-CONTACT-001 ile (§9)
```

Numaralar §1.1'deki beş defter yazıcısıdır. Kampanya motoru **yeni bir yazıcı** ekler (`CAMPAIGN_GRANT`,
`CAMPAIGN_EXPIRY`, `CAMPAIGN_REVOKE`) ve mevcut `OFFER_SPEND`/`OFFER_REFUND` satırlarına lot ilişkisi bağlar;
mevcut beş yazıcının davranışı değişmez.

### 1.7 "Yok" listesi (varsayım yapılmadı)

- Sağlayıcı hesabı için e-posta/telefon kanıtı akışı — **yok** (§1.4; ayrı iş AUTH-PROVIDER-CONTACT-001, §9).
- Genel domain event bus / outbox — **yok**; kampanya değerlendirmesi tetikleyici tx'i içinde senkron olmalı.
- Paket iadesi otomasyonu / `REFUNDED` yazıcısı / admin iade endpoint'i — **yok**.
- Negatif bakiye / borç modeli — **yok** ve yasak.
- Lot bazlı kredi (son kullanma) — **yok**; bakiye tek sayı.
- Sağlayıcı onay geçmişi — **yok**; `approvedAt` üzerine yazılır.
- Kademeli admin rolü (ör. CAMPAIGN_MANAGER) — **yok**.
- Çok-instance scheduler kilidi — **yok** (in-process bayrak).
- Genel idempotency-key tablosu — **yok**.
- Lemon iade çağrısı yapan kod — **yok**.

---

## 2. CMP-002 sözleşmesi — kesin kararlar

### 2.1 Yaşam döngüsü ve immutable versiyonlama

- `Campaign` (kimlik + durum) ve `CampaignVersion` (kural/fayda/limit, **immutable**) ayrılır.
- Durumlar: `DRAFT → ACTIVE ⇄ PAUSED → ENDED`. `ENDED` terminal. `DRAFT`'tan yalnız `ACTIVE`'e geçilir; `ACTIVE`
  olmak için en az bir doğrulanmış versiyon ve `activeVersionId` şarttır.
- **Aktif kural sessizce değişmez:** `CampaignVersion` satırı yazıldıktan sonra güncellenmez. Değişiklik = yeni
  `versionNumber` (DRAFT versiyon) → admin "yayınla" → `activeVersionId` tek bir UPDATE ile döner ve
  `CampaignAuditLog(VERSION_ACTIVATED)` yazılır. Eski versiyon üzerinden hak edilmiş redemption'lar
  `campaignVersionId` + `rulesSnapshot` ile kendi versiyonlarına bağlı kalır.
- `PAUSED`: yeni redemption üretmez, mevcut lotlar **çalışmaya devam eder** (harcanır, süresi dolar).
- `ENDED`: `endedAt` yazılır, geri açılamaz; lotlar etkilenmez. Global bütçe tükenince kampanya otomatik
  `ENDED` **olmaz**; değerlendirme `CampaignEvaluationLog{outcome: BUDGET_EXHAUSTED}` yazar ve sonraki aday denenir (§10).

Gerekçe: mevcut ürün her ticari terimi teklife/entitlement'a snapshot'lar (`Offer.unviewedRefundWindowHours`,
`ProviderPackageEntitlement.*Snapshot`); kampanya için aynı ilke "kural = versiyon satırı, redemption =
versiyon referansı + snapshot"dır.

### 2.2 Güvenli kural DSL'i

Tek JSON belge, `schemaVersion: 1`, tamamı allowlist. Serbest expression, string interpolasyon, referans
çözümleme, fonksiyon çağrısı **yok**. Kod tarafında `zod`/elle yazılmış ayrıştırıcı ile discriminated union;
DB'ye yalnız ayrıştırıcıdan geçen JSON yazılır.

```jsonc
{
  "schemaVersion": 1,
  "trigger": "PROVIDER_APPROVED" | "PACKAGE_PAYMENT_SUCCEEDED" | "PROVIDER_ELIGIBILITY_REACHED",
  "eligibility": { "facts": ["PROVIDER_APPROVED", "EMAIL_VERIFIED", "PHONE_VERIFIED"] },   // yalnız PROVIDER_ELIGIBILITY_REACHED
  "conditions": {                       // kök: AND grubu
    "all": [ <Condition> | { "any": [ <Condition>, ... ] } ]
  },
  "benefit": { "type": "PROMO_CREDIT_LOT", "credits": 10, "validityDays": 30 },
  "limits": {
    "maxRedemptionsPerProvider": 1,      // 1–100, zorunlu
    "maxRedemptionsGlobal": 1000 | null, // 1–1_000_000
    "maxRedemptionsPerDay": 100 | null,  // 1–100_000
    "budgetCredits": 10000 | null        // 1–10_000_000, global promosyon kredi bütçesi
  },
  "window": { "startAt": "2026-10-01T00:00:00Z" | null, "endAt": null },
  "stackPolicy": "EXCLUSIVE_CREDIT_BONUS",   // v1 tek değer (§12.3)
  "priority": 100                            // 1–1000, aynı olayda eşit kredide küçük kazanır
}
```

**Üç tetikleyici sınıfı:** (a) **olay tetikleyicileri** `PROVIDER_APPROVED`, `PACKAGE_PAYMENT_SUCCEEDED` —
tek bir yazımın gerçekleştiği anda değerlendirilir; (b) **uygunluk geçişi** `PROVIDER_ELIGIBILITY_REACHED` —
allowlist'ten seçilmiş 2–5 **durum olgusunun** (`eligibility.facts`) bir sağlayıcı için **ilk kez birlikte
true** olduğu anda, olguların hangi sırayla tamamlandığından bağımsız, bir kez değerlendirilir (§2.3, §8).
`eligibility` yalnız (b) için zorunlu, (a) için yasaktır (`ELIGIBILITY_NOT_ALLOWED`).

**Grup sınırı:** kök `all` zorunlu (boş olabilir); içinde en fazla bir seviye `any`; `any` içinde `any`/`all`
**yasak** (derinlik ≤ 2). `all` ≤ 16 koşul, `any` ≤ 8 koşul. `NOT` yok (her koşulun olumsuz karşılığı ayrı
koşul türü olarak tanımlanır; ör. `NO_PRIOR_REVOCATION`).

**Durum olgusu allowlist'i (v1, yalnız `eligibility.facts`)** — her olgunun tek kanonik kaynağı ve kayıtlı
yazıcıları vardır (§8.2 `FactSourceRegistry`):

| Olgu | Kaynak | Bugünkü yazıcılar (rol) |
| --- | --- | --- |
| `PROVIDER_APPROVED` | `ProviderProfile.status = APPROVED` | `providers.service.ts:947` (admin) |
| `EMAIL_VERIFIED` | `User.emailVerifiedAt != null` (profilin `userId`'si; `userId=null` → false) | `email-verification.service.ts:132`, `customer-activation.service.ts:440` (**yalnız CUSTOMER**) |
| `PHONE_VERIFIED` | `User.phoneVerifiedAt != null` | `phone-verification.service.ts:215` (**yalnız CUSTOMER**) |

**Koşul allowlist'i (v1)** — her koşulun `type` ve sabit argüman şeması vardır; tetikleyiciyle uyumsuz
koşul validasyonda reddedilir:

| `type` | Argüman | Tetikleyici | Kaynak (sunucu) |
| --- | --- | --- | --- |
| `FIRST_PROVIDER_APPROVAL` | — | PROVIDER_APPROVED | Bu sağlayıcı için daha önce `PROVIDER_APPROVED` tetikleyicili **hiçbir** redemption (her durumda) yok **ve** `existing.status !== APPROVED` geçişi |
| `EMAIL_VERIFIED` | — | hepsi | `User.emailVerifiedAt != null` — anlık koşul; olguyla aynı kaynak |
| `PHONE_VERIFIED` | — | hepsi | `User.phoneVerifiedAt != null` — anlık koşul |
| `FIRST_SUCCESSFUL_PAID_PURCHASE` | — | PACKAGE_PAYMENT_SUCCEEDED | Sağlayıcının bu purchase dışında `status=PAID` **ve** `kind=OFFER_PACKAGE` purchase'ı yok (mock dahil) |
| `PACKAGE_SLUG_IN` | `slugs: string[]` (1–20) | PACKAGE_PAYMENT_SUCCEEDED | `purchase.package.slug` — variant id değil, slug (variant eşlemesi env'de yaşar, katalog kimliği slug'dır) |
| `PACKAGE_TYPE_IN` | `types: OfferPackageType[]` | PACKAGE_PAYMENT_SUCCEEDED | `purchase.package.type` |
| `MIN_PAID_AMOUNT` | `minor: int ≥ 100, currency: "TRY"` | PACKAGE_PAYMENT_SUCCEEDED | `purchase.priceAmountSnapshot` ve `currencySnapshot` (webhook zaten tutar eşitliğini doğruladı) |
| `PURCHASE_KIND_IN` | `kinds: PackagePurchaseKind[]` | PACKAGE_PAYMENT_SUCCEEDED | v1'de yalnız `OFFER_PACKAGE` kabul edilir; `SHOWCASE_PACKAGE` validasyonda reddedilir |
| `NO_PRIOR_REVOCATION` | — | hepsi | Sağlayıcının `CampaignRedemption.status=REVOKED` satırı yok |
| `PROVIDER_APPROVED_WITHIN_DAYS` | `days: 1–365` | PACKAGE_PAYMENT_SUCCEEDED, PROVIDER_ELIGIBILITY_REACHED | `approvedAt >= now − days` |

Anlık `EMAIL_VERIFIED`/`PHONE_VERIFIED` **koşulu** ile `PROVIDER_APPROVED` **olay** tetikleyicisini birleştirmek
K1'in ilk taslağındaki zamanlama hatasıdır (§8): kanıt onaydan sonra gelirse kampanya hiç hak edilmez.
Validator bu bileşimi **reddeder** (`USE_ELIGIBILITY_TRIGGER`): `PROVIDER_APPROVED` tetikleyicisinde
`EMAIL_VERIFIED`/`PHONE_VERIFIED` koşulu yazılamaz; bileşik şart için `PROVIDER_ELIGIBILITY_REACHED` kullanılır.

Zaman penceresi ve limitler koşul değil, versiyonun `window`/`limits` alanlarıdır (motor her zaman
uygular; sözleşme §10).

**Validation error modeli:** `{ errors: [{ path: "conditions.all[2].slugs", code: "UNKNOWN_PACKAGE_SLUG", message }] }`,
HTTP 400, kodlar kapalı küme: `UNSUPPORTED_SCHEMA_VERSION, UNKNOWN_TRIGGER, UNKNOWN_CONDITION,
CONDITION_TRIGGER_MISMATCH, USE_ELIGIBILITY_TRIGGER, ELIGIBILITY_REQUIRED, ELIGIBILITY_NOT_ALLOWED,
UNKNOWN_FACT, FACT_SET_SIZE, FACT_SOURCE_UNAVAILABLE, GROUP_DEPTH_EXCEEDED, GROUP_SIZE_EXCEEDED,
ARGUMENT_INVALID, UNKNOWN_PACKAGE_SLUG, BENEFIT_INVALID, LIMIT_INVALID, LIMIT_BELOW_CONSUMED, WINDOW_INVALID,
STACK_POLICY_INVALID, PRIORITY_INVALID, DUPLICATE_CONDITION`. Slug'lar validasyonda katalogda **var olmalı** (pasif olabilir);
referans slug'la tutulur, id ile değil, böylece katalog satırı yeniden oluşturulsa bile kural okunabilir
kalır. `FACT_SOURCE_UNAVAILABLE` versiyon **oluşturmada** uyarı, **aktive etmede** hatadır (§8.4);
`LIMIT_BELOW_CONSUMED` her ikisinde uyarıdır, bloklamaz (§10.4).

**Versiyonlama:** `schemaVersion` yükselirse eski versiyonlar okunmaya devam eder (motor v1 ayrıştırıcısını
korur); yeni versiyon oluşturma yalnız güncel şemayla. Kural JSON'u DB'de `Json` kolonu; okuma her zaman
ayrıştırıcıdan geçer (ham JSON'a güvenilmez).

### 2.3 Tetikleyiciler

- `PROVIDER_APPROVED` (olay): `updateProviderStatus` içinde, `dto.status===APPROVED && existing.status!==APPROVED`
  geçişinde, **aynı transaction**da. Bu tx CMP-002'de `runSerializable`'a taşınır (bugün düz tx,
  `providers.service.ts:957`); değişiklik yalnız izolasyon/retry'dır, iş kuralı aynı. **Onay hiçbir kampanya
  koşuluna bağlı değildir**: kanıt eksikliği onayı değil, yalnız kampanya uygunluğunu engeller.
- `PACKAGE_PAYMENT_SUCCEEDED` (olay): `settle()` içinde purchase `PAID` yazıldıktan **sonra**, aynı Serializable
  tx'te; yalnız gerçek Lemon webhook'u ve mock adapter settle yolu (mock, yalnız `PAYMENT_PROVIDER=mock`
  ortamda çalışır; prod'da yok). Admin manuel `ADMIN_GRANT` **tetikleyici değildir**.
- `PROVIDER_ELIGIBILITY_REACHED` (uygunluk geçişi): `eligibility.facts` kümesindeki olguların **her** kayıtlı
  yazıcısı, olguyu yazan transaction'ın son adımında `campaignEngine.onProviderFact(tx, providerId, fact)`
  çağırır; motor aynı tx'te kümedeki tüm olguları **kanonik kaynaktan** yeniden okur, hepsi true ise
  `triggerEventKey = PROVIDER_ELIGIBILITY_REACHED:<factSetKey>:<providerId>` ile hak ediş dener
  (`factSetKey` = olguların sıralı, `+` ile birleştirilmiş adı; ör. `EMAIL_VERIFIED+PHONE_VERIFIED+PROVIDER_APPROVED`).
  Anahtar zaman damgası taşımaz: aynı küme aynı sağlayıcı için **ömür boyu bir kez** hak edilir. Geriye dönük
  tarama **yok** — kampanya aktive edildiğinde zaten uygun olan sağlayıcılar için olay üretilmez (§8.3).
  Tam sözleşme §8.
- Scheduled inactivity ve coupon: **v1 veri modeline girmez.** `CampaignTrigger` enum'u üç değerle açılır;
  sonraki sürümde enum genişletme tek satırlık migration'dır ve "boş tetikleyici" taşımak bugün ne validasyon
  ne UI sağlar. Coupon ayrıca istemci girdisi gerektirir (kod alanı) — ön çalışmanın "istemci tarafı hak
  ediş yok" ilkesine yeni bir yüzey açar; ayrı karar ister.

### 2.4 Fayda: tek mekanizma, süreli promosyon kredi lotu

`benefit.type = PROMO_CREDIT_LOT { credits: 1–1000, validityDays: 1–365 }`. "Paket bonusu" **ayrı kod
değildir**: aynı lot, `PACKAGE_PAYMENT_SUCCEEDED` tetikleyicisiyle üretilir. Fark yalnız tetikleyici ve
koşullardır (§7 örnekleri).

Lot ↔ defter ilişkisi:

- Grant: `ProviderCreditTransaction{type: CAMPAIGN_GRANT, amount:+N, referenceType:'CampaignRedemption',
  referenceId}` + `PromoCreditLot{grantedCredits:N, remainingCredits:N, expiresAt}` aynı tx.
- **Bakiye tanımı değişmez:** çalışan bakiye = son `balanceAfter`; promo lotlar bu bakiyenin **içindedir**.
  Değişmez eşitlik: `balance = paidBalance + Σ(lot.remainingCredits WHERE status=ACTIVE)`; `paidBalance`
  türetilir, saklanmaz. Sağlayıcıya gösterilen "harcanabilir" bakiye = `balance − Σ(süresi dolmuş ama
  süpürülmemiş remaining)`; süpürücü gecikse de sağlayıcı harcayamayacağı krediyi görmez.
- Expiry: `CAMPAIGN_EXPIRY` (−remaining), lot `EXPIRED`, `expiryTransactionId` set.
- Revoke: `CAMPAIGN_REVOKE` (−remaining), lot `REVOKED`.

### 2.5 Harcama sırası ve kilitleme

`consume()` ONE_TIME_CREDIT dalı (`entitlement-resolver.service.ts:220`) şöyle genişler:

1. Aynı tx'te `PromoCreditLot` satırları: `providerId, status=ACTIVE, expiresAt > now, remainingCredits > 0`,
   sıra `expiresAt asc, createdAt asc, id asc` (**en erken dolacak önce**).
2. Sırayla `take = min(lot.remaining, kalan cost)`; her lot için koşullu
   `updateMany WHERE id AND remainingCredits >= take AND status=ACTIVE AND expiresAt > now → decrement`;
   `count!==1` → tx **abort** (`ConflictException`, `runSerializable` yeniden dener). Kalan ≤ 0 olunca `EXHAUSTED`.
3. Tek `OFFER_SPEND` satırı yazılır (mevcut şekil; `Offer.creditSpentTransactionId` tek kalır). Lot payları
   `PromoCreditLotConsumption{lotId, creditTransactionId, amount}` satırlarıyla bağlanır; toplam
   `Σ amount ≤ cost`, artan kısım ücretli bakiyeden düşer (zaten `balanceAfter` üzerinden).
4. 402 kararı `resolve()`'da bakiye toplamına göre verilir; promo/ücretli ayrımı 402'yi değiştirmez.

Eşzamanlılık: iki teklif aynı sağlayıcı için yarışırsa (a) ikisi de son ledger satırını okur → Serializable
çakışma, biri yeniden dener; (b) lot `updateMany` koşulu ikinci yazımı reddeder. Ek satır kilidi gerekmez;
mevcut MONTHLY_QUOTA örüntüsünün aynısı. Grant (webhook tx) ile spend (teklif tx) da aynı ledger satırında
çakışır → biri retry'a düşer; webhook tarafı `isConcurrentModificationError` yolunu zaten kullanır.

### 2.6 Expiry, iade ve reversal (en riskli karar)

**Teklif iadesi (OFFER_REFUND) promo lot'a nasıl döner:** iade, teklifin `creditSpentTransactionId` üzerinden
`PromoCreditLotConsumption` satırlarını bulur; her lot payı için:

- lot `ACTIVE` ve `expiresAt > now` → `remainingCredits += amount` (koşullu update), lot `EXHAUSTED` ise `ACTIVE`'e döner;
- lot süresi dolmuş/`EXPIRED`/`REVOKED` → iade satırı yine yazılır (+cost, mevcut davranış) **ve aynı tx'te**
  `CAMPAIGN_EXPIRY` (−amount) yazılır; net etki sıfır. Gerekçe: aksi halde "promo ile teklif ver, süre
  dolsun, iade al" promosyonu kalıcı ücretli krediye çevirir.

**Paket iadesi (`order_refunded`) ve bonus lot:** mevcut kod yalnız bayrak koyar; para/kredi geri alma
otomasyonu yoktur ve negatif bakiye yasaktır. Karar:

- Bonus lotun **harcanmamış kısmı otomatik geri alınır**: `order_refunded` işleyicisi (bugünkü
  `flagForManualReview`) aynı tx'te `CampaignRedemption(purchaseId)` bulur; lot `ACTIVE/EXHAUSTED` ise
  `CAMPAIGN_REVOKE` (−remaining) yazar, lot `REVOKED`, redemption `REVOKED{reason: PAYMENT_REVERSED}`.
  Kısmi iade de aynı sonucu verir (Lemon `order_refunded` tam/kısmi ayırt etmez, tutar yalnız payload'da;
  bonus için "herhangi bir iade = bonus geri" deterministiktir).
- **Harcanmış kısım için borç/mahsup yok.** `balanceAfter<0` yasağı korunur, gelecek krediden otomatik
  mahsup **uygulanmaz** (borç modeli yok, mevcut ürün ilkesine aykırı, sağlayıcı iletişimi yok). Harcanan
  miktar `CampaignRedemption.spentAtRevoke` alanına yazılır ve purchase zaten `MANUAL_REVIEW_REQUIRED`
  olduğundan admin aynı ekranda görür; isterse `ADMIN_DEDUCT` ile (zorunlu gerekçe) müdahale eder.
- Suistimal freni kod değil kural: `NO_PRIOR_REVOCATION` koşulu + `FIRST_SUCCESSFUL_PAID_PURCHASE` (iade
  edilen purchase `PAID` kalmaya devam ettiğinden — `REFUNDED` yazan kod yok — ikinci alım "ilk" sayılmaz).
  Bonus kampanyasının beta konfigürasyonu her ikisini **zorunlu** taşır (§7).
- Kampanyayı durduracak olay: bir versiyonda `REVOKED` sayısı `revokeAlertThreshold` (varsayılan 3/gün)
  aşınca motor otomatik `PAUSED` yapar ve `CampaignAuditLog(AUTO_PAUSED_REVOCATIONS)` yazar; admin bilinçli
  olarak devam ettirir. Bu, "uygulanabilir değilse durdur" gereğinin karşılığıdır.

**Kill switch:** `OperationsSettings.campaignEngineEnabled` (varsayılan **false**; `OperationsSettingsChange`
audit'i mevcut). Kapalıyken tetikleyiciler değerlendirme yapmaz (redemption yazılmaz; tetikleyici tx
etkilenmez), mevcut lotlar harcanmaya ve süresi dolmaya devam eder (kazanılmış hak). Süpürücü
`campaign-lot-expiry` ayrı scheduler anahtarı (`SCHEDULER_JOB_KEYS`'e eklenir, varsayılan kapalı, cron env
`CAMPAIGN_LOT_EXPIRY_CRON` fallback `30 * * * *`).

### 2.7 Olay kimliği, redemption tekilliği ve stack/conflict (tam sözleşme §12)

- **Olay kimliği kampanyadan bağımsız ve global idempotenttir:** `triggerEventKey` =
  `PACKAGE_PAYMENT_SUCCEEDED:<purchaseId>` · `PROVIDER_APPROVED:<providerId>` ·
  `PROVIDER_ELIGIBILITY_REACHED:<factSetKey>:<providerId>`. Bir olay **birden çok** aktif kampanyanın adayı
  olabilir; bu yüzden anahtar `CampaignRedemption` üzerinde **global unique değildir**. Olay, immutable
  `CampaignTriggerEvent` kaydında tutulur (`triggerEventKey` orada global unique) ve her değerlendirme ona
  bağlanır.
- **Redemption tekilliği:** `CampaignRedemption @@unique([campaignId, triggerEventKey])` — bir kampanya aynı
  olaya iki kez hak ediş yaratamaz; versiyon değişimi aynı campaign+event için ikinci redemption üretmez
  (redemption `campaignVersionId` + `rulesSnapshot` + `grantedCredits` snapshot'ını taşır). Aynı sağlayıcının
  **farklı** olaylarda aynı kampanyaya hak edişi, `maxRedemptionsPerProvider` izin veriyorsa mümkündür.
  K1'in ömür boyu tek hak edişi = uygunluk olayının sağlayıcı başına tekil anahtarı + campaign+event unique +
  `maxRedemptionsPerProvider=1` birlikte.
- **Stack/conflict:** v1'de tek politika `EXCLUSIVE_CREDIT_BONUS` — bir olay en fazla **bir** kampanyadan
  bonus üretir. Aynı olayın adayları arasında sıra: en yüksek `benefit.credits`, eşitlikte küçük `priority`
  (versiyonda açık integer), sonra `campaignId` sabit sırası. Kazanan seçilir; kaybedenler
  `CampaignEvaluationLog{STACK_CONFLICT}` alır ve **hiçbir sayaç/bütçeleri değişmez**. Kazanan bir limitte
  reddedilirse (savepoint'e geri alınır) sıradaki aday denenir. Farklı olaylardaki kampanyalar (K1 uygunluk
  olayı, K2 ödeme olayı) birbirini **engellemez**.
- `CampaignEvaluationLog`: her değerlendirmede (olay, aday) başına bir satır; olay anahtarı unique değildir
  (uygunluk geçişinde her olgu yazımı bir değerlendirmedir).

### 2.8 Limitler ve bütçe (genelleştirilmiş; tam sözleşme §10)

- Limit **tanımları** `CampaignVersion` üzerinde doğrulanmış, sınırlı konfigürasyondur:
  `maxRedemptionsPerProvider` (zorunlu, 1–100), `maxRedemptionsGlobal?`, `maxRedemptionsPerDay?`,
  `budgetCredits?`. Motorun sabiti **yoktur**; beta K1/K2 için değer 1'dir, kural olarak değil, konfigürasyon
  olarak. `maxRedemptionsPerBusiness` v1 modelinde **yok**: kanonik işletme kimliği yok (`taxNumber` unique
  değil, §1.4); kimlik geldiğinde eklenir.
- Limit **sayaçları** `Campaign` (kümülatif, versiyonlar arası), `CampaignDailyCounter` ve
  `CampaignProviderCounter` üzerindedir; hepsi aynı Serializable tx'te **koşullu `updateMany`** ile tüketilir.
- Bütçe **kredi** olarak tutulur; `budgetConsumedCredits = Σ CampaignRedemption.grantedCredits` (GRANTED +
  REVOKED + EXPIRED; revoke/expiry bütçeye dönmez). Versiyon değişince eski redemption snapshot'ı değişmez.

### 2.9 Görünürlük

- Admin: kampanya listesi (durum, aktif versiyon, bütçe kullanımı, son 7 gün grant/revoke), versiyon
  geçmişi, redemption denetimi (filtre: kampanya, sağlayıcı, durum, tarih), audit log.
- Sağlayıcı (`/providers/:id/credits`): toplam bakiye (değişmez), **"Promosyon kredisi: X (son kullanma:
  tarih)"** satırı (lot bazında, en yakın son kullanma önce), defterde `CAMPAIGN_GRANT/EXPIRY/REVOKE` satırları
  nötr etiketlerle ("Promosyon kredisi", "Promosyon süresi doldu", "Promosyon geri alındı"). Gizli: kural
  içeriği, kampanya adı dışındaki tanım, bütçe, diğer sağlayıcılar, değerlendirme nedenleri.
- E-posta: grant'te tek transactional mail (`NotificationLog` dedupe `campaign-grant:<redemptionId>`);
  expiry/revoke maili v1'de yok (süre bilgisi panelde).

---

## 3. Veri modeli (CMP-002; migration SQL burada yazılmaz)

### 3.1 Enum'lar

```
enum CampaignStatus        { DRAFT ACTIVE PAUSED ENDED }
enum CampaignTrigger       { PROVIDER_APPROVED PACKAGE_PAYMENT_SUCCEEDED PROVIDER_ELIGIBILITY_REACHED }
enum CampaignEligibilityFact { PROVIDER_APPROVED EMAIL_VERIFIED PHONE_VERIFIED }
enum CampaignBenefitType   { PROMO_CREDIT_LOT }
enum CampaignStackPolicy   { EXCLUSIVE_CREDIT_BONUS }
enum CampaignRedemptionStatus { GRANTED REVOKED EXPIRED }
enum CampaignRevokeReason  { PAYMENT_REVERSED ADMIN_REVOKED }
enum PromoCreditLotStatus  { ACTIVE EXHAUSTED EXPIRED REVOKED }
enum CampaignEvaluationOutcome { GRANTED NO_CANDIDATE CONDITIONS_FAILED WINDOW_CLOSED ELIGIBILITY_INCOMPLETE
                             STACK_CONFLICT EVENT_ALREADY_SETTLED ALREADY_REDEEMED CAMPAIGN_PAUSED
                             PER_PROVIDER_LIMIT GLOBAL_LIMIT DAILY_LIMIT BUDGET_EXHAUSTED
                             ENGINE_DISABLED ENGINE_ERROR }
enum CampaignAuditAction   { CREATED VERSION_CREATED VERSION_ACTIVATED ACTIVATED PAUSED RESUMED ENDED
                             AUTO_PAUSED_REVOCATIONS REDEMPTION_REVOKED_BY_ADMIN }
enum CreditTransactionType += CAMPAIGN_GRANT CAMPAIGN_EXPIRY CAMPAIGN_REVOKE
```

### 3.2 Modeller (kritik kısıtlar)

| Model | Alanlar (özet) | Unique / index / FK |
| --- | --- | --- |
| `Campaign` | `id, key (slug), name, status, activeVersionId?, redemptionCount=0, budgetConsumedCredits=0, revokeAlertThreshold=3, createdById, activatedAt?, pausedAt?, endedAt?, createdAt, updatedAt` | `@@unique([key])`; `activeVersionId` → `CampaignVersion` (Restrict); `@@index([status])`; CHECK `redemptionCount >= 0 AND budgetConsumedCredits >= 0` (üst sınır versiyonda yaşar, sayaç kümülatiftir — §10.2) |
| `CampaignVersion` | `id, campaignId, versionNumber, trigger, eligibilityFacts CampaignEligibilityFact[]` (yalnız uygunluk geçişinde, sıralı, boş değil), `factSetKey String?`, `rules Json, benefitType, benefitCredits, benefitValidityDays, maxRedemptionsPerProvider, maxRedemptionsGlobal?, maxRedemptionsPerDay?, budgetCredits?, windowStartAt?, windowEndAt?, stackPolicy, priority=100, createdById, createdAt` (güncelleme yok) | `@@unique([campaignId, versionNumber])`; `@@index([trigger, factSetKey])`; CHECK `benefitCredits BETWEEN 1 AND 1000`, `benefitValidityDays BETWEEN 1 AND 365`, `maxRedemptionsPerProvider BETWEEN 1 AND 100`, `maxRedemptionsGlobal IS NULL OR BETWEEN 1 AND 1000000`, `maxRedemptionsPerDay IS NULL OR BETWEEN 1 AND 100000`, `budgetCredits IS NULL OR BETWEEN 1 AND 10000000`, `priority BETWEEN 1 AND 1000`, `(trigger = 'PROVIDER_ELIGIBILITY_REACHED') = (factSetKey IS NOT NULL)` |
| `CampaignTriggerEvent` | `id, triggerEventKey, trigger, providerId, purchaseId?, factSetKey?, firstSeenAt, lastSeenAt, evaluationCount, settledByCampaignId?, settledRedemptionId?, settledAt?` | `@@unique([triggerEventKey])` (**olay** kimliği, global); `@@unique([settledRedemptionId])`; `@@index([providerId, firstSeenAt])`; immutable (yalnız `lastSeenAt/evaluationCount` ve bir kez `settled*`) |
| `CampaignRedemption` | `id, campaignId, campaignVersionId, providerId, userId?, trigger, triggerEventId, triggerEventKey, purchaseId?, status, rulesSnapshot Json, grantedCredits, grantTransactionId, promoLotId, grantedAt, revokedAt?, revokeReason?, spentAtRevoke?, revokedById?` | `@@unique([campaignId, triggerEventKey])` (bir kampanya aynı olaya bir kez; versiyon değişimi ikinci satır üretmez); `triggerEventId` → `CampaignTriggerEvent` (Restrict); `@@index([triggerEventKey])`; `@@unique([grantTransactionId])`; `@@unique([promoLotId])`; `purchaseId` → `PackagePurchase` (Restrict), `@@index([purchaseId])`, `@@index([campaignId, providerId])`, `@@index([providerId, status])`, `@@index([campaignVersionId])` |
| `CampaignProviderCounter` | `campaignId, providerId, redemptionCount` | `@@unique([campaignId, providerId])`; CHECK `redemptionCount >= 0`; koşullu artırım `maxRedemptionsPerProvider`'ın DB yarısı (§10.3) |
| `CampaignDailyCounter` | `campaignId, day (date, Europe/Istanbul), redemptionCount` | `@@unique([campaignId, day])` |
| `PromoCreditLot` | `id, providerId, redemptionId, grantedCredits, remainingCredits, expiresAt, status, expiryTransactionId?, revokeTransactionId?, createdAt, updatedAt` | `@@unique([redemptionId])`; `@@unique([expiryTransactionId])`; `@@unique([revokeTransactionId])`; `@@index([providerId, status, expiresAt])`; `@@index([status, expiresAt])` (süpürücü); CHECK `0 <= remainingCredits <= grantedCredits` |
| `PromoCreditLotConsumption` | `id, lotId, creditTransactionId, amount, createdAt` | `@@unique([lotId, creditTransactionId])`; `creditTransactionId` → `ProviderCreditTransaction` (Restrict); CHECK `amount > 0` |
| `CampaignEvaluationLog` | `id, triggerEventId, campaignId?, campaignVersionId?, providerId, fact?` (uygunluk geçişinde tetikleyen olgu), `outcome CampaignEvaluationOutcome, reasonCode?, winnerCampaignId?, evaluatedAt` | `@@index([triggerEventId, evaluatedAt])`, `@@index([campaignId, evaluatedAt])`, `@@index([providerId, evaluatedAt])` (**unique yok**, olay×aday×değerlendirme) |
| `CampaignAuditLog` | `id, campaignId, action, campaignVersionId?, redemptionId?, actorId?, detail String?` (kısa kod/not, payload değil), `createdAt` | `@@index([campaignId, createdAt])`, `actorId` → `User` |
| `OperationsSettings` | `+ campaignEngineEnabled Boolean @default(false)`, `+ campaignLotExpirySchedulerEnabled Boolean @default(false)` | mevcut singleton |

Silme yok: hiçbir kampanya modeli `onDelete: Cascade` taşımaz; kampanya "silinmez", `ENDED` olur.
`(campaignId, providerId)` unique'i **kaldırıldı** (perProvider artık konfigürasyon); DB teminatı
`CampaignProviderCounter` koşullu artırımı + `(campaignId, triggerEventKey)` unique'idir. `triggerEventKey`
**yalnız** `CampaignTriggerEvent` üzerinde global unique'tir (§12).

### 3.3 Admin API sözleşmesi (SUPER_ADMIN)

| Uç | Amaç |
| --- | --- |
| `GET /admin/campaigns` | liste + özet sayaçlar |
| `POST /admin/campaigns` | `{key, name}` → DRAFT (limit/priority/stack versiyonda) |
| `GET /admin/campaigns/:id` | detay + versiyonlar + audit |
| `POST /admin/campaigns/:id/versions` | kural JSON'u doğrula + immutable versiyon yaz (`201 {version}` / `400 {errors[]}`) |
| `POST /admin/campaigns/:id/versions/validate` | yalnız doğrula (kurucu ekranı canlı hata için) |
| `POST /admin/campaigns/:id/versions/:v/activate` | `activeVersionId` değiştir (+ DRAFT ise ACTIVE); `FACT_SOURCE_UNAVAILABLE` kapısı (§8.4), `LIMIT_BELOW_CONSUMED` uyarısı (§10.4) |
| `POST /admin/campaigns/:id/pause|resume|end` | durum geçişleri, gerekçe zorunlu |
| `GET /admin/campaigns/:id/redemptions` | filtreli liste |
| `GET /admin/campaign-evaluations?providerId=&campaignId=&triggerEventKey=` | "neden hak etmedi" — olay × aday satırları, `STACK_CONFLICT`/limit sonuçları |
| `POST /admin/campaign-redemptions/:id/revoke` | harcanmamış kısmı geri al, gerekçe zorunlu, audit |
| `GET/PATCH /operations-settings` | `campaignEngineEnabled`, `campaignLotExpirySchedulerEnabled` (mevcut ekran) |

Admin UI minimumu: `apps/admin/app/campaigns` (liste), `/campaigns/new`, `/campaigns/[id]` (versiyon
kurucu = form → JSON önizleme → validate → kaydet; tetikleyici seçince koşul seçenekleri daralır),
`/campaigns/[id]/redemptions`. Kurucu formu allowlist'ten seçim yapar; ham JSON alanı **yoktur**.

### 3.4 Sağlayıcı API

- `GET /providers/:id/credits` yanıtına ek alanlar: `promoCredits: { spendable, lots: [{remaining, expiresAt}] }`;
  defter satırlarında yeni türler. Başka uç yok.

### 3.5 Sıralama garantisi

```
webhook tx:  HMAC → PROCESSED? → settle: PAID → PACKAGE_PURCHASE ledger → [evaluate(PACKAGE_PAYMENT_SUCCEEDED, purchase)]
             → olay kaydı → aday sıralama → (savepoint) sayaçlar → CAMPAIGN_GRANT ledger + lot + redemption + settledBy → recordAttempt(PROCESSED) → commit → receipt mail
approve tx:  status/approvedAt → claim/vitrin yan etkileri → [evaluate(PROVIDER_APPROVED)] → [onProviderFact(PROVIDER_APPROVED)] → commit → mail
proof tx:    emailVerifiedAt / phoneVerifiedAt yazımı (guard'lı updateMany, count=1 ise) → [onProviderFact(EMAIL_VERIFIED | PHONE_VERIFIED)] → commit
offer tx:    rules → resolve → offer.create → consume: lots(en erken dolacak) → OFFER_SPEND → consumptions → commit
```

`onProviderFact` aynı tx'te kümedeki tüm olguları kanonik kaynaktan okur (`ProviderProfile.status`,
`User.emailVerifiedAt`, `User.phoneVerifiedAt`); eksik varsa `ELIGIBILITY_INCOMPLETE` log'u yazar ve döner.

Değerlendirme tetikleyici tx'inin **son** adımıdır ve **yalnız beklenen iş sonuçları** (koşul sağlanmadı,
uygunluk eksik, limit/bütçe) `EvaluationLog` yazar; beklenmeyen hata (kural JSON ayrıştırılamadı vb.)
tetikleyici tx'ini **geri almaz**: motor `try/catch` ile `outcome=ENGINE_ERROR` yazar ve loglar. Gerekçe:
bir kampanya hatası ödeme settle'ını, sağlayıcı onayını veya bir kanıt yazımını engelleyemez (ödeme
otoritesi webhook; kampanya ikincil). Ancak grant yazımı başladıysa (sayaç + ledger + lot) ve ortada hata
olursa tx'in tamamı geri alınır — kısmi grant yoktur; webhook örneğinde `PROCESSED` de yazılmamış olur ve
Lemon tekrar teslim eder (mevcut davranış); kanıt örneğinde kanıt da yazılmamış olur ve kullanıcı kodu
yeniden girer (kabul edilebilir: `runSerializable` önce 3 kez dener).

### 3.6 Tekrar olay / webhook tekrarında tek hak ediş

1. Webhook: `PaymentWebhookEvent.status=PROCESSED` kısa devresi (`payments-webhook.service.ts:265`) →
   settle çalışmaz → değerlendirme çalışmaz.
2. `CampaignRedemption @@unique([campaignId, triggerEventKey])` → bir kampanya aynı purchase / aynı sağlayıcı
   onayı / aynı olgu kümesi olayına ikinci kez hak edemez, hangi yoldan gelirse gelsin (yeniden yargılanan
   `MISMATCHED` olay, askı sonrası ikinci onay geçişi, admin retry, aynı kanıtın tekrar yazılması). Birincil
   yol Serializable altında **okuma** (`ALREADY_REDEEMED`); P2002 savepoint'li backstop'tur ve yalnız aynı
   campaign+event için `ALREADY_REDEEMED` üretir. `EXCLUSIVE_CREDIT_BONUS` altında olay zaten başka kampanya
   tarafından settle edilmişse sonuç `EVENT_ALREADY_SETTLED`'dır (§12.4). Tetikleyici tx **commit** eder.
3. Kanıt yazıcıları zaten `WHERE … VerifiedAt IS NULL` guard'lıdır (`email-verification.service.ts:132`,
   `phone-verification.service.ts:215`) → aynı kanıt ikinci kez yazılmaz; yazılsa bile (2) tutar.
4. `CampaignProviderCounter` koşullu artırım → `maxRedemptionsPerProvider` DB'de aşılmaz.
5. `PromoCreditLot.redemptionId` unique, `grantTransactionId` unique → tek redemption tek lot tek ledger satırı.
6. Süresi dolmuş lot süpürücüsü koşullu `updateMany status IN (ACTIVE, EXHAUSTED) AND expiresAt<=now` → çift
   `CAMPAIGN_EXPIRY` yok; `expiryTransactionId` unique.

### 3.7 Suistimal senaryoları

| Senaryo | Açık kapı bugün | v1 önlemi | Kalan risk |
| --- | --- | --- | --- |
| Aynı kişi ikinci sağlayıcı hesabı | `User.email/phone` global unique; ancak yeni e-posta+yeni telefonla ikinci hesap açılabilir | `EMAIL_VERIFIED + PHONE_VERIFIED` (gerçek kanal kanıtı), `FIRST_PROVIDER_APPROVAL` (onay insan kararı) | Çok numaralı kişi; maliyeti 10 süreli kredi ile sınırlı, bütçe/günlük limit tavan koyar |
| Aynı işletme, farklı hesap | `taxNumber` unique değil | v1 kural yok (kanıt kaynağı yok) | Açık; admin onayında görünür; sonraki sürüm `taxNumber` normalizasyonu + `BUSINESS_UNIQUE` koşulu |
| İade sonrası yeniden satın alma | `REFUNDED` yazılmaz, purchase `PAID` kalır | `FIRST_SUCCESSFUL_PAID_PURCHASE` iade edileni sayar → ikinci alım "ilk" değil; `NO_PRIOR_REVOCATION` | Yok (bonus tekrar üretilemez) |
| Promo ile teklif → iade → kalıcı kredi | 48s iade lot bilmez | §2.6: lot'a geri; süresi dolmuşsa aynı tx'te expire | Yok |
| Süre dolmadan hızlı harcama + paket iadesi | Bonus harcanmış | Harcanan kısım geri alınmaz; admin görür; `NO_PRIOR_REVOCATION` gelecek bonusu keser; otomatik PAUSE eşiği | Sınırlı, tek seferlik |
| Admin tekrar denemesi / çift tık | — | `(campaignId, triggerEventKey)` unique + `CampaignTriggerEvent.settledBy` + `CampaignProviderCounter` koşullu artırım; pause/resume idempotent | Yok |
| Askı → yeniden onay (ikinci "geçiş") | `approvedAt` üzerine yazılır, geçmiş yok | `triggerEventKey` sabit (`PROVIDER_APPROVED:<providerId>` / `PROVIDER_ELIGIBILITY_REACHED:<set>:<providerId>`), `FIRST_PROVIDER_APPROVAL` redemption varlığına bakar | Yok |
| Kanıt sıfırlanıp yeniden kazanılması (numara değişimi) | kanıt `NULL`→tekrar set | uygunluk anahtarı zaman damgasız → ikinci hak ediş yok (§8.3) | Yok |
| Onay + kanıt farklı sırada tamamlanır | ilk taslakta olay kaçıyordu | uygunluk geçişi: son olgu yazımında hak ediş (§8) | Yok |
| Misafir başvuru (`userId=null`) onayı | Kanıt hesaba bağlı | olgular false → `ELIGIBILITY_INCOMPLETE`; claim sonrası sağlayıcı kanıtlarını tamamlayınca **o yazımda** hak eder (onay olgusu zaten true) | Yok |
| Webhook sahteciliği | HMAC, store, tutar, variant kontrolü | Değişmez; kampanya yalnız settle sonrası | Yok |

---

## 4. CMP-002 dilimleri ve release sırası

| Dilim | İçerik | Migration | Bağımlılık |
| --- | --- | --- | --- |
| **S0** Kural çekirdeği | `apps/api/src/modules/campaigns/rules/`: şema tipleri, ayrıştırıcı, validator (hata modeli), saf `evaluate(rules, facts)`, `FactSourceRegistry` iskeleti; unit testler; wiring yok | Yok | — |
| **S1** Kampanya tanımı | Enum'lar + `Campaign, CampaignVersion, CampaignAuditLog`; admin CRUD/validate/activate/pause API; admin UI liste+kurucu (limit alanları, uygunluk olgu seçici); motor **kapalı** (redemption yok); activate'te `FACT_SOURCE_UNAVAILABLE` kapısı, `LIMIT_BELOW_CONSUMED` uyarısı | **A** (tanım tabloları) | S0 |
| **S2** Hak ediş + lot + harcama | `CreditTransactionType` genişletme, `CampaignTriggerEvent, CampaignRedemption, CampaignProviderCounter, CampaignDailyCounter, PromoCreditLot, PromoCreditLotConsumption, CampaignEvaluationLog`, `OperationsSettings` anahtarları; `updateProviderStatus`→`runSerializable` + `evaluate(PROVIDER_APPROVED)` + `onProviderFact(PROVIDER_APPROVED)`; webhook/mock settle hook'u; **mevcut CUSTOMER kanıt yazıcılarına `onProviderFact` bağlanmaz** (CUSTOMER'ın provider profili yok — hook `role=PROVIDER` için anlamlıdır ve AUTH-PROVIDER-CONTACT-001 yazıcılarıyla gelir); resolver lot tüketimi; iade lot geri yazımı; expiry süpürücü + scheduler anahtarı | **B** (ledger enum + lot/sayaç tabloları + settings) | S1 |
| **S3** Reversal + denetim | `order_refunded` → revoke; admin revoke ucu; otomatik PAUSE eşiği; redemption/evaluation ekranları | Yok (kolonlar B'de) | S2 |
| **S4** Sağlayıcı yüzeyi + bildirim | credits sayfası promo satırı/etiketler; grant maili + dedupe; admin ledger etiketleri | Yok | S2 |
| **S5** E2E + fingerprint + runbook | Playwright akışları; migration A/B dry-run fingerprint; docs | Yok | S1–S4 |
| **AUTH-PROVIDER-CONTACT-001** (CMP-002 **dışı**, paralel iş) | Sağlayıcı e-posta/telefon kanıtı (§9); `EMAIL_VERIFIED`/`PHONE_VERIFIED` için PROVIDER-rol yazıcılarını `FactSourceRegistry`'ye kaydeder ve `onProviderFact` çağırır | Yok (mevcut `User.*VerifiedAt`) | S0 (registry arayüzü) |

**Release sırası:** S0 → S1 → S2 → S3 → S4 → S5; K2 (paket bonusu) **S3 merge'ünden sonra** aktive edilebilir
(revoke olmadan açılmaz). K1 için ek kapı: **AUTH-PROVIDER-CONTACT-001 main'de + PROVIDER yazıcıları
registry'de** — aksi halde `activate` `FACT_SOURCE_UNAVAILABLE` ile reddeder (§8.4). Kampanya altyapısı
(S0–S5) bu işten bağımsız kurulur; K1 ise ancak gerçek sağlayıcı kanıt olayları bağlandığında ACTIVE olur.

**Kapalı beta için en kısa güvenli yol:** S0 + S1 + S2 + S3 → K2 açılabilir; S4 hemen ardından (sağlayıcı
promo ayrımını görür). K1 yolu: aynı + AUTH-PROVIDER-CONTACT-001.

## 5. Test planı

| Alan | Testler |
| --- | --- |
| Kural DSL (S0, vitest) | şema kabul/ret matrisi (her hata kodu ≥1 vaka), derinlik/boyut sınırları, tetikleyici-koşul uyumsuzluğu, `any` doğruluk tablosu, deterministik sıralama |
| API (S1) | RBAC: CUSTOMER/PROVIDER 403; versiyon immutability (PATCH yok, 405/404); activate akışı; audit satırı her geçişte |
| Transaction (S2) | sayaçlar + grant + lot + redemption tek tx; grant yazımında hata → purchase PAID **yazılmamış** (rollback) ve webhook redelivery ile tek grant; değerlendirme iş hatası → tetikleyici tx commit |
| Webhook | `order_created` tekrar teslim → tek redemption; `MISMATCHED→PROCESSED` yeniden yargılama → tek grant; `order_refunded` → revoke harcanmamış, `spentAtRevoke` doğru; kısmi iade aynı davranış |
| Concurrency | iki teklif aynı sağlayıcı, 1 promo kredi: biri promo biri ücretli/402; grant vs spend yarışı: bakiye eşitliği (`balance = paid + Σremaining`) her senaryoda; bütçe son kredi için iki webhook |
| Uygunluk geçişi (S2 + AUTH-PROVIDER-CONTACT-001) | üç olgunun 6 permütasyonunda tam olarak **bir** redemption; son olgu yazımı tx'inde grant; eksik olguda `ELIGIBILITY_INCOMPLETE`; askı→yeniden onay, kanıt tekrar yazımı, admin retry → `ALREADY_REDEEMED`; iki olgu eşzamanlı → biri retry, tek grant; kampanya sonradan aktive → geriye dönük grant **yok**; onay kanıt eksikken de başarılı (bloklanmaz) |
| Olay/stack (S2) | aynı olayda iki kampanya: kredi→priority→campaignId sırası, kaybeden `STACK_CONFLICT` ve sayaçları değişmez; kazanan limitte reddedilince (savepoint geri) sıradaki kazanır; olay settle sonrası tekrar → kazanan `ALREADY_REDEEMED`, diğeri `EVENT_ALREADY_SETTLED`; farklı olaylarda K1+K2 her ikisi grant; aynı kampanya farklı olay + perProvider>1 → ikinci grant; versiyon değişimi aynı campaign+event → ikinci redemption yok; `CampaignTriggerEvent.evaluationCount` artar, `settledRedemptionId` unique |
| Limitler (S2) | `maxRedemptionsPerProvider=2` ile 3 olay → 2 grant + `PER_PROVIDER_LIMIT`; global/günlük/bütçe için son slot iki eşzamanlı olay → tek grant; limit reddinde sonraki aday kampanya kazanır; yeni versiyonla limit düşürme → `LIMIT_BELOW_CONSUMED` (activate) ve düşük limitte yeni grant yok; sayaç değişmezi `Campaign.redemptionCount = count(redemption)`, `budgetConsumedCredits = Σ grantedCredits`; PAUSED/ENDED'de sayaç ve redemption değişmez |
| Kanıt regresyonu (AUTH-PROVIDER-CONTACT-001) | CUSTOMER e-posta/OTP akışları ve talep telefon gate'i birebir korunur (mevcut spec'ler yeşil); admin/link/ekran token'ı `emailVerifiedAt` yazmaz; sağlayıcı `User.email`/`phone` değişiminde ilgili kanıt aynı statement'ta sıfırlanır |
| Expiration | süpürücü: dolan lot → `CAMPAIGN_EXPIRY`, tekrar çalıştırma no-op; süpürücü kapalıyken harcanabilir bakiye doğru; expiry sonrası teklif iadesi net sıfır |
| Reversal | revoke iki kez → tek `CAMPAIGN_REVOKE`; revoke sonrası `NO_PRIOR_REVOCATION` false; otomatik PAUSE eşiği |
| Audit | her admin aksiyonu `CampaignAuditLog`; ledger satırlarında `referenceType/Id` dolu; `EvaluationLog` her tetikleyicide tek satır |
| Admin RBAC / UI (vitest + E2E) | kurucu ekranı ham JSON kabul etmez; validate hataları alan bazlı gösterilir |
| E2E (Playwright, chromium) | admin kampanya kurar → mock ödeme settle → sağlayıcı credits sayfası promo satırı → teklif verir → ledger sırası; `pnpm e2e <filtre>` |
| Mali veri fingerprint | Migration A/B dry-run: geçici DB'de `main` şeması + seed, `count` + `md5(string_agg(id ORDER BY id))` `ProviderCreditTransaction`, `PackagePurchase`, `ProviderPackageEntitlement`, `Offer` için; migration sonrası aynı fingerprint (kolon ekleme veri değiştirmez); `balanceAfter` toplam tutarlılığı sorgusu öncesi/sonrası eşit |
| Dış sözleşme | Lemon: `order_refunded` payload'ında `refunded_amount`; test store'da tam ve kısmi iade ile sandbox smoke (staging), CI'da fixture |

---

## 6. Kapsam dışı (CMP-002'de yok)

Checkout fiyat indirimi, ücretsiz vitrin, referral, müşteri indirimi, yorum/kalite ödülü, coupon/kod girişi,
scheduled inactivity tetikleyicisi, para bazlı bütçe, negatif bakiye/borç/mahsup, Lemon iade çağrısı,
kademeli admin rolü, `maxRedemptionsPerBusiness` (kanonik işletme kimliği yok), `taxNumber` tekilleştirme,
çok-instance scheduler kilidi, expiry/revoke e-postaları, A/B veya segment hedefleme, geriye dönük uygunluk
taraması. Sağlayıcı iletişim kanıtı **AUTH-PROVIDER-CONTACT-001** olarak ayrı iştir (§9); CMP-002 onu
kapsamaz ama K1 ona kapılıdır.

## 7. İlk iki beta kampanyasının konfigürasyonu (admin kurucu çıktısı)

**K1 — Onaylı ve iletişimi kanıtlı sağlayıcı hoş geldin kredisi** (uygunluk geçişi; release kapısı §8.4)

```json
{
  "schemaVersion": 1,
  "trigger": "PROVIDER_ELIGIBILITY_REACHED",
  "eligibility": { "facts": ["PROVIDER_APPROVED", "EMAIL_VERIFIED", "PHONE_VERIFIED"] },
  "conditions": { "all": [
    { "type": "NO_PRIOR_REVOCATION" }
  ] },
  "benefit": { "type": "PROMO_CREDIT_LOT", "credits": 10, "validityDays": 30 },
  "limits": { "maxRedemptionsPerProvider": 1, "maxRedemptionsGlobal": 1000, "maxRedemptionsPerDay": 100, "budgetCredits": 10000 },
  "window": { "startAt": null, "endAt": null },
  "stackPolicy": "EXCLUSIVE_CREDIT_BONUS",
  "priority": 10
}
```

Okunuşu: sağlayıcı APPROVED, hesabının e-postası ve telefonu kanıtlı — **hangi sırayla olursa olsun** —
ilk kez birlikte sağlandığında, ömür boyu bir kez, 10 kredi / 30 gün. `FIRST_PROVIDER_APPROVAL` koşuluna
gerek yok: olay anahtarı `PROVIDER_ELIGIBILITY_REACHED:EMAIL_VERIFIED+PHONE_VERIFIED+PROVIDER_APPROVED:<providerId>`
sağlayıcı başına tektir; `(campaignId, triggerEventKey)` unique + `maxRedemptionsPerProvider=1` ömür boyu tek
hak edişi verir (§12.2). Kanıt olmadan onaylanan sağlayıcı onayını kaybetmez; kanıt sonradan gelince kampanya o anda
hak edilir.

**K2 — İlk paket bonusu** (S3 revoke şart)

```json
{
  "schemaVersion": 1,
  "trigger": "PACKAGE_PAYMENT_SUCCEEDED",
  "conditions": { "all": [
    { "type": "PURCHASE_KIND_IN", "kinds": ["OFFER_PACKAGE"] },
    { "type": "PACKAGE_TYPE_IN", "types": ["ONE_TIME_CREDITS"] },
    { "type": "FIRST_SUCCESSFUL_PAID_PURCHASE" },
    { "type": "MIN_PAID_AMOUNT", "minor": 50000, "currency": "TRY" },
    { "type": "NO_PRIOR_REVOCATION" }
  ] },
  "benefit": { "type": "PROMO_CREDIT_LOT", "credits": 5, "validityDays": 60 },
  "limits": { "maxRedemptionsPerProvider": 1, "maxRedemptionsGlobal": 2000, "maxRedemptionsPerDay": null, "budgetCredits": 10000 },
  "window": { "startAt": "2026-10-01T00:00:00Z", "endAt": "2026-12-31T23:59:59Z" },
  "stackPolicy": "EXCLUSIVE_CREDIT_BONUS",
  "priority": 20
}
```

`priority` K1=10, K2=20 (farklı olaylar; birbirini engellemez — §12.6). Yerel envanter: tek seferlik paket
fiyatı 100000 kuruş (`project_vit_notify_003_local_sync` notu) → K2 `MIN_PAID_AMOUNT` 50000 yerelde
sağlanır; prod katalog fiyatı bilinmiyor, kurucu ekranı slug listesini katalogdan doğrular.

---

## 8. Düzeltilen K1 zamanlama hatası — uygunluk geçişi (`PROVIDER_ELIGIBILITY_REACHED`)

### 8.1 Hata

İlk taslak K1'i `PROVIDER_APPROVED` **olay** tetikleyicisi + anlık `EMAIL_VERIFIED ∧ PHONE_VERIFIED` koşulu
olarak yazmıştı. Onay, e-posta kanıtı ve telefon kanıtı bağımsız akışlardır ve herhangi sırayla
tamamlanabilir; onay anında kanıtlardan biri eksikse koşul `false` döner, olay bir daha üretilmez ve
sağlayıcı kanıtları sonradan tamamlasa da kampanya **hiç** hak edilmez. Kanıtı onaydan önce isteyerek
çözmek "onayı bloklama" yasağına aykırıdır (§2.3). Düzeltme: bileşik şart bir olay değil, **durum
olguları kümesinin ilk kez birlikte true olması** olarak modellenir.

### 8.2 Allowlist olgu/kaynak modeli (`FactSourceRegistry`)

Genel bir mekanizmadır; K1'e özel kod adı yoktur. Her `CampaignEligibilityFact`:

| Alan | Anlam |
| --- | --- |
| `fact` | enum adı (`PROVIDER_APPROVED`, `EMAIL_VERIFIED`, `PHONE_VERIFIED`) |
| `read(tx, providerId): boolean` | kanonik kaynaktan **tek** okuma: `ProviderProfile.status = APPROVED`; `User.emailVerifiedAt IS NOT NULL` / `User.phoneVerifiedAt IS NOT NULL` (`ProviderProfile.userId` üzerinden; `userId IS NULL` → false) |
| `writers: {module, role}[]` | olguyu yazan kod noktalarının kaydı; motor yalnız kayıtlı yazıcıların `onProviderFact` çağırdığını varsayar ve bir olgunun **PROVIDER rolü için yazıcısı yoksa** o olguyu içeren versiyon aktive edilemez (§8.4) |

Yeni olgu eklemek = enum değeri + `read` + yazıcı kaydı; kural JSON'u yalnız olgu adlarını taşır. Gelecek
bileşik kampanyalar (ör. "onaylı + ilk vitrin kartı yayında") aynı modeli kullanır; motor koduna kampanya
adı girmez.

`eligibility.facts` sınırı: 2–5 olgu, tekrar yok, `PROVIDER_APPROVED` zorunlu değil ama v1 kümelerinin tümü
onu içerir (onaysız sağlayıcıya promo verilmez — kurucu ekranı uyarır, validator `FACT_SET_SIZE` dışında
zorlamaz).

### 8.3 Semantik, idempotency ve transaction sınırı

1. **Tetikleme noktası:** olguyu yazan her kayıtlı yazıcı, kendi transaction'ının son adımında
   `campaignEngine.onProviderFact(tx, providerId, fact)` çağırır. Hook `try/catch` içindedir; iş sonucu
   dışındaki hata olgu yazımını geri almaz (§3.5).
2. **Yeniden okuma:** motor, bu olguyu içeren aktif versiyonların olgu kümelerini bulur (`CampaignVersion
   @@index([trigger, factSetKey])`), her küme için **tüm** olguları aynı tx'te `read` ile yeniden okur
   (çağıranın verdiği değere güvenmez). Eksik varsa `EvaluationLog{outcome: ELIGIBILITY_INCOMPLETE}` yazar,
   döner.
3. **Olay anahtarı:** hepsi true ise `triggerEventKey = PROVIDER_ELIGIBILITY_REACHED:<factSetKey>:<providerId>`.
   Zaman damgası yok → aynı küme aynı sağlayıcı için **ömür boyu bir kez**. Kanıt sıfırlanıp (telefon
   değişimi) yeniden kazanılsa da ikinci hak ediş yoktur (suistimal freni; ürün isterse sonraki sürüm
   anahtara `epoch` ekler — bilinçli olarak v1'de yok).
4. **Unique ve yarış:** olay `CampaignTriggerEvent.triggerEventKey` (global unique), hak ediş
   `CampaignRedemption (campaignId, triggerEventKey)` unique (§12.2). İki olgu eşzamanlı yazılırsa (e-posta
   ve telefon aynı saniye) iki Serializable tx de "hepsi true" görebilir → biri P2034 alır, `runSerializable`
   yeniden dener, tekrar okuma redemption'ı görür → `ALREADY_REDEEMED`; backstop P2002 savepoint'te yakalanır,
   kendi olgu yazımı **commit** eder. Grant yazımı (sayaç + ledger + lot + redemption + settledBy) tek
   tx'tedir, kısmi grant yoktur. Aynı olayın adayı olan **başka** kampanyalar §12.3 sırasıyla yarışır; olay
   settle olduktan sonra onların sonucu `EVENT_ALREADY_SETTLED`'dır.
5. **Tekrarlar:** aynı kanıtın tekrar yazılması (guard'lı `updateMany`, §3.6), admin'in profili tekrar
   onaylaması (askı→APPROVED: olgu yeniden true olur, hook çağrılır, anahtar aynı → kazanan için
   `ALREADY_REDEEMED`, diğer adaylar için `EVENT_ALREADY_SETTLED`),
   webhook tekrarı (uygunluk geçişiyle ilgisiz; PROCESSED kısa devresi), kampanyanın PAUSE→RESUME edilmesi
   (olay üretmez) — hiçbiri ikinci redemption yaratmaz.
6. **Onay bloklanmaz:** `updateProviderStatus` hiçbir kampanya sonucuna bakmaz; hook yalnız `APPROVED`
   yazıldıktan sonra çağrılır ve sonucu onayı etkilemez.
7. **Geriye dönük yok:** kampanya aktive edildiğinde zaten uygun olan sağlayıcılar için olay üretilmez;
   yeni olgu yazımı olmadan hook çalışmaz. Kurucu ekranı bunu açıkça gösterir.

### 8.4 Release kapısı

`POST /admin/campaigns/:id/versions/:v/activate`, versiyonun her olgusu için `FactSourceRegistry`'de
**`role=PROVIDER` yazıcısı** olmasını şart koşar; yoksa `400 FACT_SOURCE_UNAVAILABLE` (versiyon
oluşturmada uyarı olarak gösterilir, aktive etmede hata). Bugün `EMAIL_VERIFIED`/`PHONE_VERIFIED` için
PROVIDER yazıcısı **yoktur** (§1.4, §9); K1 bu nedenle AUTH-PROVIDER-CONTACT-001 main'e girip
yazıcılarını kaydedene kadar **ACTIVE edilemez**. Kapı mekaniktir, süreç notu değildir.

---

## 9. Bağımlılık: `AUTH-PROVIDER-CONTACT-001` — sağlayıcı iletişim kanıtı

Bağımsız iş; CMP-002'nin parçası değildir, onunla paralel yürür. Kanıt kaynağı **yalnız** mevcut
`User.emailVerifiedAt` / `User.phoneVerifiedAt`; sağlayıcı için ikinci/paralel kanıt alanı **açılmaz**.

### 9.1 Bugünkü CUSTOMER-only guard/yazıcılar (dosya:satır)

| Nokta | Davranış |
| --- | --- |
| `auth.controller.ts:98` | yalnız `register-customer` `issueForNewCustomer` çağırır; `register-provider` (`:107`) doğrulama başlatmaz |
| `auth/email-verification.controller.ts:32-36` | `POST /auth/email-verification/resend` (AuthGuard, rol kısıtı yok) → `issue()` |
| `email-verification.service.ts:165` | `issue()`: `user.role !== UserRole.CUSTOMER` → sessiz `return` (PROVIDER için token üretilmez) |
| `email-verification.service.ts:132-133` | tek yazıcı: `tx.user.updateMany WHERE id, email = emailSnapshot, emailVerifiedAt IS NULL` |
| `customer-activation.service.ts:440-441` | aktivasyon linki ile şifre belirleme → `emailVerifiedAt` (müşteri) |
| `phone-verification.service.ts:210-218` | `user.role === CUSTOMER && serviceRequest.customerId === user.id` şartıyla `User.phoneVerifiedAt`; talep OTP'sine bağlı |
| `account.controller.ts:40-42` + `account.service.ts:121` | `PATCH /account/profile` **CUSTOMER** rolü; numara değişince `phoneVerifiedAt: null` aynı statement |
| `providers.service.ts:793, 1624, 1629` | sağlayıcı profil düzenlemesi `ProviderProfile.phone/email` yazar; **`User.email/phone`'a dokunmaz** (sağlayıcı hesabının iletişimini değiştiren hiçbir yol yok) |

### 9.2 Sözleşme

1. **E-posta:** sağlayıcı, `POST /auth/email-verification/resend` ile kendi hesabı için token ister
   (`issue()` PROVIDER'a açılır; cooldown/pencere aynen), `EmailVerificationToken` mail ile teslim edilir,
   `confirm` mevcut yazıcıyı kullanır (`email = emailSnapshot` guard'ı korunur). Kayıt sonrası otomatik
   gönderim `register-provider` için de yapılır. **Yeni yazıcı yok**; yazıcı `FactSourceRegistry`'ye
   `{role: PROVIDER}` olarak kaydedilir ve `onProviderFact(EMAIL_VERIFIED)` çağırır (yalnız `count===1`
   olduğunda).
2. **Telefon:** sağlayıcı kendi hesap numarası için SMS OTP başlatır (`PhoneVerification` tablosu ve
   mevcut OTP hash/deneme/kilit/IP bütçesi kuralları aynen); talebe bağlı akış **değişmez** — yeni bir
   "hesap numarası doğrulama" amacı eklenir (`requestId` null, `userId` zorunlu). Yazıcı:
   `tx.user.updateMany WHERE id, phone = <okunan numara>, phoneVerifiedAt IS NULL` (mevcut guard kalıbı,
   `phone-verification.service.ts:215`), `onProviderFact(PHONE_VERIFIED)`.
3. **Admin kanıt yaratmaz:** admin ekranındaki link/token gösterimi, admin'in tokenı kopyalayıp açması,
   `ProviderClaimToken`/`ProviderInviteToken` tüketimi, admin onayı — hiçbiri `emailVerifiedAt` yazmaz.
   Claim/invite token'ları hesap sahipliğini kanıtlar ama **teslim kanalı kanıtı** değildir (admin görebilir);
   bu ayrım `CustomerActivationToken.delivery` ile aynı ilkedir (AUTH-EMAIL-001).
4. **Atomik sıfırlama:** sağlayıcı hesabının `User.email` veya `User.phone`'unu değiştiren bir yol
   açıldığında (bugün yok), ilgili kanıt aynı `UPDATE` statement'ında `NULL` yapılır (kalıp:
   `account.service.ts:121`). `ProviderProfile.phone/email` değişimi kanıtı etkilemez (kanıt hesabın
   numarasına aittir; profil iletişimi ayrı alandır — kurucu ekranı bunu belirtir).
5. **Regresyon yok:** CUSTOMER e-posta/aktivasyon akışları, talep telefon gate'i
   (`provider-request-matching.ts:67`) ve `ServiceRequest.phoneVerifiedAt` davranışı değişmez; mevcut
   `email-verification`, `phone-verification`, `customer-activation` spec'leri ve E2E'ler yeşil kalır.
6. **Hesap kullanılabilirliği:** kanıt olmadan sağlayıcı hesabı **tam** kullanılır (giriş, profil, teklif,
   satın alma, onay); tek etki K1 uygunluğunun sağlanmamasıdır. Kanıt hiçbir mevcut gate'e girmez.
7. **Görünürlük:** sağlayıcı panelinde "E-posta / telefon doğrulandı" durumu ve doğrulama başlatma; admin
   sağlayıcı detayında `emailVerifiedAt/phoneVerifiedAt` (REQ-UX-011/012 rozet kaynağıyla aynı).

### 9.3 CMP ile bağ

CMP-002 S0 `FactSourceRegistry` arayüzünü tanımlar; AUTH-PROVIDER-CONTACT-001 yazıcılarını kaydeder.
Sıra bağımsızdır: registry'siz gelirse kayıt sonraki küçük PR'da yapılır; K1 her iki koşul da sağlanana
kadar `FACT_SOURCE_UNAVAILABLE` ile ACTIVE olamaz (§8.4).

---

## 10. Genelleştirilmiş limit ve bütçe sözleşmesi

### 10.1 Tanımlar (`CampaignVersion`, doğrulanmış ve sınırlı)

| Alan | Sınır | Anlam |
| --- | --- | --- |
| `maxRedemptionsPerProvider` | 1–100, zorunlu | aynı `ProviderProfile` için toplam redemption (GRANTED+REVOKED+EXPIRED sayılır) |
| `maxRedemptionsGlobal` | 1–1 000 000, null=sınırsız | kampanya ömrü boyunca toplam redemption |
| `maxRedemptionsPerDay` | 1–100 000, null | Europe/Istanbul günü başına redemption |
| `budgetCredits` | 1–10 000 000, null | kampanya ömrü boyunca verilen toplam lot kredisi |
| `maxRedemptionsPerBusiness` | **v1'de yok** | kanonik işletme kimliği yok (§1.4); geldiğinde eklenir |

Motorda sabit yoktur; beta K1/K2 için `maxRedemptionsPerProvider=1` konfigürasyondur.

### 10.2 Sayaçlar (kümülatif, kampanya düzeyinde)

`Campaign.redemptionCount`, `Campaign.budgetConsumedCredits`, `CampaignDailyCounter.redemptionCount`,
`CampaignProviderCounter.redemptionCount`. Sayaçlar **versiyonlar arası kümülatiftir**: yeni versiyon
sayaçları sıfırlamaz; limit tanımı versiyona, tüketim kampanyaya aittir. Revoke/expiry sayaçları
**azaltmaz**.

### 10.3 Tüketim sırası, atomiklik, yarış

Tümü tetikleyici tx'inin içinde, **yalnız o anda denenen aday** için, savepoint altında, şu sırayla ve her
biri **koşullu `updateMany`** ile (tam akış §12.4):

1. `CampaignProviderCounter` upsert + `WHERE redemptionCount < maxRedemptionsPerProvider → +1`
   (`count!==1` → `PER_PROVIDER_LIMIT`)
2. `CampaignDailyCounter` upsert + `WHERE redemptionCount < maxRedemptionsPerDay → +1` (`DAILY_LIMIT`)
3. `Campaign WHERE (maxRedemptionsGlobal IS NULL OR redemptionCount < max) AND (budgetCredits IS NULL OR
   budgetConsumedCredits + benefitCredits <= budgetCredits) → redemptionCount+1, budgetConsumedCredits+benefitCredits`
   (`GLOBAL_LIMIT` / `BUDGET_EXHAUSTED` — hangisinin reddettiği önce ayrı SELECT ile teşhis edilir, log için)
4. `CAMPAIGN_GRANT` ledger + `PromoCreditLot` + `CampaignRedemption` + `CampaignTriggerEvent.settledBy*`.

Herhangi bir adımda ret → `ROLLBACK TO SAVEPOINT` (adayın kısmi sayaç artışı geri alınır), log yazılır,
**sıradaki aday** denenir. Sayaç ve bütçe yalnız kazanan grant ile aynı Serializable tx'te değişir; kaybeden,
limit aşan veya PAUSED kaynaklı değerlendirmeler yalnız log satırıdır.

Sınır değerleri versiyondan **tx içinde** okunur (aktif versiyon o anda ne diyorsa). Limit reddi bir hata
değil, `EvaluationLog` sonucudur; tetikleyici tx **commit** eder. Yarışta: Serializable çakışması →
`runSerializable` yeniden dener (webhook/onay/kanıt tx'leri zaten bu sarmalayıcıdadır); koşullu `WHERE` son
slotu iki tx'in de almasını DB'de engeller. Çağırana (admin, webhook, kullanıcı) limit nedeniyle **hiçbir
zaman** HTTP hatası dönmez; `CONCURRENT_MODIFICATION` yalnız retry bütçesi tükenirse ve mevcut yollar nasıl
davranıyorsa öyle (webhook: committed-state'ten karar, §1.3).

Ön kontrol (tx dışı) **yoktur**: "önce say sonra yaz" yarışa açıktır; tek doğru yer koşullu güncellemedir.
Kurucu ekranı yalnız bilgilendirme amaçlı güncel sayaçları gösterir.

### 10.4 Versiyon değişimi ve muhasebe

- Yeni versiyon **daha düşük** limit taşıyorsa `activate` `LIMIT_BELOW_CONSUMED` uyarısıyla **kabul edilir**
  (admin bilinçli olarak durdurmak isteyebilir); sonuç: sayaç ≥ limit olduğundan yeni redemption üretilmez.
  Yükseltme aynı sayaçla devam eder.
- `budgetConsumedCredits` = Σ `CampaignRedemption.grantedCredits` (her durumdaki redemption).
  `grantedCredits` = grant anındaki aktif versiyonun `benefitCredits`'i; redemption `campaignVersionId` +
  `rulesSnapshot` taşır ve **hiç değişmez**. Versiyon `benefitCredits`'i değiştirse bile eski lotlar ve
  bütçe muhasebesi değişmez.
- Lot kredisi (`PromoCreditLot.grantedCredits`) = `redemption.grantedCredits`; `remainingCredits` harcama/iade
  ile hareket eder ama bütçeyi etkilemez (bütçe "verilen", bakiye "kalan"dır).
- Test değişmezleri: `Campaign.redemptionCount = COUNT(redemption)`, `budgetConsumedCredits = SUM(grantedCredits)`,
  `Σ CampaignProviderCounter = redemptionCount`, `Σ CampaignDailyCounter = redemptionCount`.

### 10.5 PAUSED / ENDED

`PAUSED`/`ENDED` kampanya aday kümesine girmez → sayaç değişmez; olay başka kampanyaya gidebilir (aynı
`triggerEventKey`, başka kampanya → serbest; `EXCLUSIVE_CREDIT_BONUS` olay başına yine tek bonus üretir).
Tetikleyiciyi eşleyen PAUSED kampanya için bilgi amaçlı `EvaluationLog{CAMPAIGN_PAUSED}` yazılır; ENDED için
yazılmaz. `PAUSED`→`RESUME` sayaçları korur. `ENDED` terminaldir; ENDED'ten sonra gelen olaylar o kampanya
için hiç değerlendirilmez; mevcut lotlar çalışmaya devam eder.

## 11. Güncel CMP-002 dilimleri ve release sırası

§4 tablosu günceldir. Özet sıra: **S0 → S1 (migration A) → S2 (migration B) → S3 → S4 → S5**, paralelde
**AUTH-PROVIDER-CONTACT-001**. Kapılar: K2 ≥ S3; K1 ≥ S3 + AUTH-PROVIDER-CONTACT-001 (mekanik:
`FACT_SOURCE_UNAVAILABLE`). Bu revizyonda değişenler: (1) `PROVIDER_ELIGIBILITY_REACHED` tetikleyici sınıfı
+ `FactSourceRegistry` (§8); (2) AUTH-PROVIDER-CONTACT-001 bağımlılığı ve sözleşmesi (§9); (3)
`perProvider=1` sabiti kaldırıldı, dört limit + sayaç modeli (§10); (4) `(campaignId, providerId)` unique
yerine `CampaignProviderCounter`; `CampaignEvaluationLog.triggerEventKey` unique değil; S3/S4 sırası
(reversal önce, sağlayıcı yüzeyi sonra); K1 JSON'u güncellendi (§7). Revizyon 3 (§12): `triggerEventKey`
global unique yalnız `CampaignTriggerEvent`'te; redemption `(campaignId, triggerEventKey)`;
`EXCLUSIVE_CREDIT_BONUS` + versiyon `priority`; savepoint'li aday döngüsü.

---

## 12. Revizyon 3 — olay kimliği, redemption tekilliği ve stack/conflict

### 12.1 Düzeltilen hata

Revizyon 2 `CampaignRedemption.triggerEventKey`'i **global unique** tanımlamıştı. Anahtar bir **olayı**
temsil eder (`PROVIDER_ELIGIBILITY_REACHED:<factSetKey>:<providerId>` gibi) ve aynı olay birden çok aktif
kampanyanın adayı olabilir; global unique, ilk değerlendirilen kampanyanın diğerlerini sıralamaya bakmadan
engellemesi ve "başka kampanyanın redemption'ı" ile "bu kampanyanın tekrarı"nın aynı P2002'ye düşmesi
demekti. Olay kimliği ile redemption tekilliği ayrılır.

### 12.2 Kimlikler

| Kavram | Kayıt | Tekillik |
| --- | --- | --- |
| Olay | `CampaignTriggerEvent{ id, triggerEventKey, trigger, providerId, purchaseId?, factSetKey?, firstSeenAt, lastSeenAt, evaluationCount, settledByCampaignId?, settledRedemptionId?, settledAt? }` | `@@unique([triggerEventKey])` — global, kampanyadan bağımsız, idempotent; satır immutable (yalnız `lastSeenAt/evaluationCount` ve bir kez `settled*` yazılır) |
| Hak ediş | `CampaignRedemption{ …, campaignId, campaignVersionId, triggerEventId, triggerEventKey, rulesSnapshot, grantedCredits, … }` | `@@unique([campaignId, triggerEventKey])`; `triggerEventId → CampaignTriggerEvent` (Restrict); `@@index([triggerEventKey])` |
| Değerlendirme | `CampaignEvaluationLog{ triggerEventId, campaignId?, campaignVersionId?, fact?, outcome, reasonCode?, winnerCampaignId?, evaluatedAt }` | unique yok; `@@index([triggerEventId, evaluatedAt])`, `@@index([campaignId, evaluatedAt])` |

Redemption `campaignVersionId` + `rulesSnapshot` + `grantedCredits` snapshot'ını taşır; aktif versiyon
değişse de aynı campaign+event için ikinci satır **yazılamaz** (unique). Aynı sağlayıcı, aynı kampanya,
**farklı** olay (ör. K2'de ikinci satın alma) → `maxRedemptionsPerProvider` izin veriyorsa yeni redemption.
K1 ömür boyu tek: uygunluk anahtarı sağlayıcı başına tek olay + campaign+event unique +
`maxRedemptionsPerProvider=1`.

### 12.3 Stack/conflict politikası (`CampaignVersion.stackPolicy`, `CampaignVersion.priority`)

- v1'de tek değer: `EXCLUSIVE_CREDIT_BONUS` — bir olay en fazla **bir** promosyon kredi bonusu üretir,
  kampanyadan bağımsız. `CampaignTriggerEvent.settledByCampaignId` bunun kaydıdır.
- Deterministik seçim (aynı olayın adayları arasında): (1) en yüksek `benefit.credits`; (2) eşitlikte en
  küçük `priority` (versiyonda açık integer, 1–1000, varsayılan 100); (3) eşitlikte `campaignId` artan
  (cuid, sabit). Serbest öncelik ifadesi **yok**.
- Kaybedenler `EvaluationLog{STACK_CONFLICT, winnerCampaignId}`; sayaç/bütçeleri **değişmez**.
- Kazanan bir limitte reddedilirse (`PER_PROVIDER_LIMIT/DAILY_LIMIT/GLOBAL_LIMIT/BUDGET_EXHAUSTED`) o aday
  log'lanır ve **sıradaki** aday kazanır; grant yazılınca kalan adaylar `STACK_CONFLICT` alır.
- Farklı olaylar bağımsızdır: K1 (uygunluk olayı) ve K2 (ödeme olayı) aynı sağlayıcıya ayrı ayrı grant yazar.
- Validator: `stackPolicy ∈ {EXCLUSIVE_CREDIT_BONUS}` (`STACK_POLICY_INVALID`), `priority` tam sayı 1–1000
  (`PRIORITY_INVALID`); alanlar zorunlu.
- **Stack (ADDITIVE) v1'de yok.** Gelecekte açılırsa gerekenler: olay başına en fazla N kampanya, olay başına
  toplam `grantedCredits` üst sınırı, aynı sıralama ile ardışık değerlendirme, her aday için ayrı savepoint +
  sayaç tüketimi, `CampaignTriggerEvent.settled*`'ın listeye dönmesi. Beta için gereksiz; ertelendi.

### 12.4 Transaction sınırı (tek Serializable tetikleyici tx'i)

```
tetikleyici tx (runSerializable):
  0. tetikleyicinin kendi yazımı (PAID / APPROVED / *VerifiedAt)
  1. olay: CampaignTriggerEvent oku; yoksa SAVEPOINT altında insert (P2002 → yeniden oku); evaluationCount+1
  2. engine kapalı → log ENGINE_DISABLED, dön
  3. olay settled ise → kazanan kampanya için ALREADY_REDEEMED, diğer adaylar için EVENT_ALREADY_SETTLED; dön
  4. adaylar: ACTIVE + aktif versiyon tetikleyiciyi (ve factSetKey'i) eşliyor + window + koşullar (kanonik okuma)
     eşlemeyen/koşul kaçıran: CONDITIONS_FAILED / WINDOW_CLOSED / ELIGIBILITY_INCOMPLETE; PAUSED: CAMPAIGN_PAUSED
  5. sıralama: credits desc, priority asc, campaignId asc
  6. her aday için:
       SAVEPOINT cmp_candidate
       redemption(campaignId, triggerEventKey) var mı? → ALREADY_REDEEMED, sonraki
       sayaçlar (10.3 §1–3) → ret → ROLLBACK TO SAVEPOINT, log, sonraki
       CAMPAIGN_GRANT + lot + redemption (SAVEPOINT altında; P2002 → ROLLBACK TO SAVEPOINT → ALREADY_REDEEMED)
       event.settledBy* yaz; RELEASE SAVEPOINT; log GRANTED; kalanlara STACK_CONFLICT; break
  7. commit — sayaç/bütçe/lot/redemption yalnız kazanan için ve yalnız bu tx'te değişmiştir
```

Savepoint: Prisma interactive transaction tek bağlantı üzerinde çalışır; `SAVEPOINT`/`ROLLBACK TO SAVEPOINT`
`$executeRaw` ile geçerlidir ve tetikleyici tx'ini bir unique ihlalinde abort olmaktan korur. Birincil
idempotency yolu **okuma**dır (Serializable altında iki tx aynı boşluğu görürse biri P2034 alır ve
`runSerializable` yeniden dener; tekrar okuma satırı görür); P2002 yalnız backstop'tur ve **yalnız aynı
campaign+event** tekrarında `ALREADY_REDEEMED` üretir — başka kampanyanın redemption'ı P2002 üretmez
(anahtar campaign'e bağlı), onun sonucu adım 3'teki `EVENT_ALREADY_SETTLED`'dır.

### 12.5 Korunanlar

`PROVIDER_ELIGIBILITY_REACHED` zamanlama düzeltmesi (§8) ve AUTH-PROVIDER-CONTACT-001 release kapısı (§8.4,
§9) aynen geçerli. `Campaign.priority` kaldırıldı (versiyona taşındı); `GET /admin/campaigns` sıralaması
`status, key`.

### 12.6 Örnekler

**Aynı olay, iki kampanya.** K1 (10 kredi, priority 10) ve varsayımsal K3 "onaylı+kanıtlı sağlayıcıya 5
kredi" (aynı olgu kümesi, priority 5) ACTIVE. Sağlayıcı P son olguyu tamamlar → tek olay
`PROVIDER_ELIGIBILITY_REACHED:EMAIL_VERIFIED+PHONE_VERIFIED+PROVIDER_APPROVED:P`. Sıra: K1 (10) > K3 (5).
K1 sayaçları geçerse: K1 GRANTED, K3 STACK_CONFLICT, olay `settledBy=K1`. K1 `budgetCredits` doluysa: K1
BUDGET_EXHAUSTED (savepoint geri), K3 GRANTED, olay `settledBy=K3`. Olay daha sonra yeniden değerlendirilirse
(ör. askı→yeniden onay): kazanan ALREADY_REDEEMED, diğeri EVENT_ALREADY_SETTLED; hiçbir sayaç değişmez.

**Farklı olaylar, K1 + K2.** Aynı sağlayıcı önce paket alır (K2 olayı `PACKAGE_PAYMENT_SUCCEEDED:<purchase>` →
K2 GRANTED 5 kredi), sonra telefonunu doğrular (K1 olayı → K1 GRANTED 10 kredi). İki olay bağımsız, iki
redemption, iki lot; K2 `maxRedemptionsPerProvider=1` olduğundan ikinci satın alma K2'de PER_PROVIDER_LIMIT
alır; K2 3 olsaydı ikinci ve üçüncü satın alma da (farklı olay anahtarları) grant alırdı.
