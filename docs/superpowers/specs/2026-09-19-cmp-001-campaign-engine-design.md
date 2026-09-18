# CMP-001 — Yapılandırılabilir Kampanya Motoru: Envanter + Çekirdek Tasarım

Tarih: 2026-09-19 · Taban: `origin/main` @ `89ba7f22` (SEO-003 merge, temiz worktree doğrulandı) · Docs-only.

Bu belge CMP-002'nin uygulayacağı sözleşmedir. Üretim kodu, API davranışı, şema/migration, ödeme, kredi,
webhook, admin UI, gerçek `.env`, Cloudflare, deploy, yerel/staging container veya DB verisi **değişmedi**;
salt-okunur inceleme dışında veri işlemi yapılmadı.

Bağlayıcı karar yönü (ön çalışma özeti): kampanya = adminin oluşturduğu **tetikleyici + allowlist koşul +
fayda + limit** bileşimi; kampanya başına kod yazılmaz. Serbest JS/SQL/expression, webhook URL'si veya
istemci tarafı hak ediş kararı yok. Ödeme otoritesi doğrulanmış Lemon Squeezy webhook'u; kredi/geri alma
otoritesi TakTic API'si. İlk beta: yalnız sağlayıcı edinimi + paket bonusu; ilk fayda türü **süreli
promosyon kredi lotu**. Kanıt kaynağı yalnız `User.emailVerifiedAt` / `User.phoneVerifiedAt`.

> Not: `taktick-kampanya-modulu-on-calismasi.md` repoda, ana checkout'ta, worktree'lerde ve Spotlight'ta
> bulunamadı. Görev tanımındaki madde listesi ön çalışmanın bağlayıcı özeti olarak alındı; belge bulunursa
> bu tasarımla çelişen bir maddesi CMP-002 öncesi ayrıca uzlaştırılmalıdır.

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
   ├─ settle(): store/ref/amount/currency/variant       └─ [CMP hook ②] PROVIDER_APPROVED
   ├─ purchase → PAID + providerOrderId                     (yalnız existing.status !== APPROVED)
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
```

Numaralar §1.1'deki beş defter yazıcısıdır. Kampanya motoru **yeni bir yazıcı** ekler (`CAMPAIGN_GRANT`,
`CAMPAIGN_EXPIRY`, `CAMPAIGN_REVOKE`) ve mevcut `OFFER_SPEND`/`OFFER_REFUND` satırlarına lot ilişkisi bağlar;
mevcut beş yazıcının davranışı değişmez.

### 1.7 "Yok" listesi (varsayım yapılmadı)

- Sağlayıcı hesabı için e-posta/telefon kanıtı akışı — **yok** (§1.4).
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
  `ENDED` **olmaz**; değerlendirme `CampaignEvaluationLog{outcome: BUDGET_EXHAUSTED}` yazar (admin görür, kararı verir).

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
  "trigger": "PROVIDER_APPROVED" | "PACKAGE_PAYMENT_SUCCEEDED",
  "conditions": {                       // kök: AND grubu
    "all": [ <Condition> | { "any": [ <Condition>, ... ] } ]
  },
  "benefit": { "type": "PROMO_CREDIT_LOT", "credits": 10, "validityDays": 30 },
  "limits": { "perProvider": 1, "global": 500 | null, "perDay": 50 | null },
  "window": { "startAt": "2026-10-01T00:00:00Z" | null, "endAt": null },
  "stackPolicy": "EXCLUSIVE"
}
```

**Grup sınırı:** kök `all` zorunlu; içinde en fazla bir seviye `any`; `any` içinde `any`/`all` **yasak**
(derinlik ≤ 2). `all` ≤ 16 koşul, `any` ≤ 8 koşul. `NOT` yok (her koşulun olumsuz karşılığı ayrı koşul
türü olarak tanımlanır; ör. `NO_PRIOR_REVOCATION`).

**Koşul allowlist'i (v1)** — her koşulun `type` ve sabit argüman şeması vardır; tetikleyiciyle uyumsuz
koşul validasyonda reddedilir:

| `type` | Argüman | Tetikleyici | Kaynak (sunucu) |
| --- | --- | --- | --- |
| `FIRST_PROVIDER_APPROVAL` | — | PROVIDER_APPROVED | Bu sağlayıcı için daha önce `PROVIDER_APPROVED` tetikleyicili **hiçbir** redemption (her durumda) yok **ve** `existing.status !== APPROVED` geçişi |
| `EMAIL_VERIFIED` | — | her ikisi | `User.emailVerifiedAt != null` (profilin `userId`'si üzerinden; `userId=null` → false) |
| `PHONE_VERIFIED` | — | her ikisi | `User.phoneVerifiedAt != null` (aynı) |
| `FIRST_SUCCESSFUL_PAID_PURCHASE` | — | PACKAGE_PAYMENT_SUCCEEDED | Sağlayıcının bu purchase dışında `status=PAID` **ve** `kind=OFFER_PACKAGE` purchase'ı yok (mock dahil) |
| `PACKAGE_SLUG_IN` | `slugs: string[]` (1–20) | PACKAGE_PAYMENT_SUCCEEDED | `purchase.package.slug` — variant id değil, slug (variant eşlemesi env'de yaşar, katalog kimliği slug'dır) |
| `PACKAGE_TYPE_IN` | `types: OfferPackageType[]` | PACKAGE_PAYMENT_SUCCEEDED | `purchase.package.type` |
| `MIN_PAID_AMOUNT` | `minor: int ≥ 100, currency: "TRY"` | PACKAGE_PAYMENT_SUCCEEDED | `purchase.priceAmountSnapshot` ve `currencySnapshot` (webhook zaten tutar eşitliğini doğruladı) |
| `PURCHASE_KIND_IN` | `kinds: PackagePurchaseKind[]` | PACKAGE_PAYMENT_SUCCEEDED | v1'de yalnız `OFFER_PACKAGE` kabul edilir; `SHOWCASE_PACKAGE` validasyonda reddedilir |
| `NO_PRIOR_REVOCATION` | — | her ikisi | Sağlayıcının `CampaignRedemption.status=REVOKED` satırı yok |
| `PROVIDER_APPROVED_WITHIN_DAYS` | `days: 1–365` | PACKAGE_PAYMENT_SUCCEEDED | `approvedAt >= now − days` |

Zaman penceresi ve limitler koşul değil, versiyonun `window`/`limits` alanlarıdır (motor her zaman
uygular). `perProvider` v1'de **sabit 1**; başka değer validasyonda reddedilir (DB unique bunun teminatıdır,
§3.1).

**Validation error modeli:** `{ errors: [{ path: "conditions.all[2].slugs", code: "UNKNOWN_PACKAGE_SLUG", message }] }`,
HTTP 400, kodlar kapalı küme: `UNSUPPORTED_SCHEMA_VERSION, UNKNOWN_TRIGGER, UNKNOWN_CONDITION,
CONDITION_TRIGGER_MISMATCH, GROUP_DEPTH_EXCEEDED, GROUP_SIZE_EXCEEDED, ARGUMENT_INVALID, UNKNOWN_PACKAGE_SLUG,
BENEFIT_INVALID, LIMIT_INVALID, WINDOW_INVALID, STACK_POLICY_INVALID, DUPLICATE_CONDITION`. Slug'lar
validasyonda katalogda **var olmalı** (pasif olabilir); referans slug'la tutulur, id ile değil, böylece
katalog satırı yeniden oluşturulsa bile kural okunabilir kalır.

**Versiyonlama:** `schemaVersion` yükselirse eski versiyonlar okunmaya devam eder (motor v1 ayrıştırıcısını
korur); yeni versiyon oluşturma yalnız güncel şemayla. Kural JSON'u DB'de `Json` kolonu; okuma her zaman
ayrıştırıcıdan geçer (ham JSON'a güvenilmez).

### 2.3 Tetikleyiciler

- `PROVIDER_APPROVED`: `updateProviderStatus` içinde, `dto.status===APPROVED && existing.status!==APPROVED`
  geçişinde, **aynı transaction**da. Bu tx CMP-002'de `runSerializable`'a taşınır (bugün düz tx,
  `providers.service.ts:957`); değişiklik yalnız izolasyon/retry'dır, iş kuralı aynı.
- `PACKAGE_PAYMENT_SUCCEEDED`: `settle()` içinde purchase `PAID` yazıldıktan **sonra**, aynı Serializable tx'te;
  yalnız gerçek Lemon webhook'u ve mock adapter settle yolu (mock, yalnız `PAYMENT_PROVIDER=mock` ortamda
  çalışır; prod'da yok). Admin manuel `ADMIN_GRANT` **tetikleyici değildir**.
- Scheduled inactivity ve coupon: **v1 veri modeline girmez.** `CampaignTrigger` enum'u iki değerle açılır;
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

### 2.7 Checkout başına tek bonus, deterministik seçim

- `CampaignRedemption.triggerEventKey` **global unique** (`PACKAGE_PAYMENT_SUCCEEDED:<purchaseId>` /
  `PROVIDER_APPROVED:<providerId>`). Bir olay → en fazla bir redemption, kampanyadan bağımsız.
- Aday sıralaması: `ACTIVE` kampanyalar, versiyon `window` içinde, koşulları sağlayan; sıra
  `priority asc, activatedAt asc, id asc`; **ilk** aday kazanır. `stackPolicy` v1'de yalnız `EXCLUSIVE`
  (enum tek değer; başka değer reddedilir).
- `CampaignRedemption` yalnız GRANTED/REVOKED/EXPIRED satırı taşır; kaybeden adaylar için satır yazılmaz
  (satır patlaması). Atlama nedeni tetikleyici başına **tek** `CampaignEvaluationLog{triggerEventKey unique,
  outcome, reasonCode, winnerCampaignId?}` satırıdır (dar, payload'sız; admin "neden hak etmedi" sorusuna
  cevap).

### 2.8 Global bütçe

- **Kredi olarak** tutulur (`Campaign.budgetCredits`, `budgetConsumedCredits`). Fayda kredi; para karşılığı
  paket fiyatına göre değişir, "kredi başı maliyet" raporu finance'te türetilir.
- Atomik tüketim: `updateMany WHERE id AND (budgetCredits IS NULL OR budgetConsumedCredits + N <= budgetCredits)
  → increment`; `count!==1` → değerlendirme `BUDGET_EXHAUSTED` ile biter, redemption yazılmaz. Aynı örüntü
  `perDay` için `CampaignDailyCounter{campaignId, day(Europe/Istanbul), consumedCredits}` upsert + koşullu
  update (`istanbulDayStart` mevcut, `entitlement-period.ts`).
- Revoke/expiry bütçeye **geri dönmez** (v1; iade döngüsüyle bütçe pompalanmasını engeller, raporu basit tutar).

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
enum CampaignTrigger       { PROVIDER_APPROVED PACKAGE_PAYMENT_SUCCEEDED }
enum CampaignBenefitType   { PROMO_CREDIT_LOT }
enum CampaignStackPolicy   { EXCLUSIVE }
enum CampaignRedemptionStatus { GRANTED REVOKED EXPIRED }
enum CampaignRevokeReason  { PAYMENT_REVERSED ADMIN_REVOKED }
enum PromoCreditLotStatus  { ACTIVE EXHAUSTED EXPIRED REVOKED }
enum CampaignAuditAction   { CREATED VERSION_CREATED VERSION_ACTIVATED ACTIVATED PAUSED RESUMED ENDED
                             AUTO_PAUSED_REVOCATIONS REDEMPTION_REVOKED_BY_ADMIN }
enum CreditTransactionType += CAMPAIGN_GRANT CAMPAIGN_EXPIRY CAMPAIGN_REVOKE
```

### 3.2 Modeller (kritik kısıtlar)

| Model | Alanlar (özet) | Unique / index / FK |
| --- | --- | --- |
| `Campaign` | `id, key (slug), name, status, activeVersionId?, budgetCredits?, budgetConsumedCredits=0, revokeAlertThreshold=3, priority=100, createdById, activatedAt?, pausedAt?, endedAt?, createdAt, updatedAt` | `@@unique([key])`; `activeVersionId` → `CampaignVersion` (Restrict); `@@index([status, priority])`; CHECK `budgetConsumedCredits >= 0 AND (budgetCredits IS NULL OR budgetConsumedCredits <= budgetCredits)` |
| `CampaignVersion` | `id, campaignId, versionNumber, trigger, rules Json, benefitType, benefitCredits, benefitValidityDays, limitPerProvider=1, limitPerDayCredits?, windowStartAt?, windowEndAt?, stackPolicy, createdById, createdAt` (güncelleme yok) | `@@unique([campaignId, versionNumber])`; CHECK `benefitCredits BETWEEN 1 AND 1000`, `benefitValidityDays BETWEEN 1 AND 365`, `limitPerProvider = 1` |
| `CampaignRedemption` | `id, campaignId, campaignVersionId, providerId, userId?, trigger, triggerEventKey, purchaseId?, status, rulesSnapshot Json, grantedCredits, grantTransactionId, promoLotId, grantedAt, revokedAt?, revokeReason?, spentAtRevoke?, revokedById?` | `@@unique([triggerEventKey])` (olay başına tek bonus); `@@unique([campaignId, providerId])` (perProvider=1'in DB yarısı); `@@unique([grantTransactionId])`; `@@unique([promoLotId])`; `purchaseId` → `PackagePurchase` (Restrict), `@@index([purchaseId])`, `@@index([providerId, status])`, `@@index([campaignVersionId])` |
| `PromoCreditLot` | `id, providerId, redemptionId, grantedCredits, remainingCredits, expiresAt, status, expiryTransactionId?, revokeTransactionId?, createdAt, updatedAt` | `@@unique([redemptionId])`; `@@index([providerId, status, expiresAt])`; `@@index([status, expiresAt])` (süpürücü); CHECK `0 <= remainingCredits <= grantedCredits` |
| `PromoCreditLotConsumption` | `id, lotId, creditTransactionId, amount, createdAt` | `@@unique([lotId, creditTransactionId])`; `creditTransactionId` → `ProviderCreditTransaction` (Restrict); CHECK `amount > 0` |
| `CampaignEvaluationLog` | `id, triggerEventKey, trigger, providerId, outcome (GRANTED/NO_CANDIDATE/CONDITIONS_FAILED/BUDGET_EXHAUSTED/DAILY_LIMIT/ENGINE_DISABLED), reasonCode?, winnerCampaignId?, evaluatedAt` | `@@unique([triggerEventKey])`; `@@index([providerId, evaluatedAt])` |
| `CampaignDailyCounter` | `campaignId, day (date), consumedCredits` | `@@unique([campaignId, day])` |
| `CampaignAuditLog` | `id, campaignId, action, campaignVersionId?, redemptionId?, actorId?, detail String?` (kısa kod/not, payload değil), `createdAt` | `@@index([campaignId, createdAt])`, `actorId` → `User` |
| `OperationsSettings` | `+ campaignEngineEnabled Boolean @default(false)`, `+ campaignLotExpirySchedulerEnabled Boolean @default(false)` | mevcut singleton |

Silme yok: hiçbir kampanya modeli `onDelete: Cascade` taşımaz; kampanya "silinmez", `ENDED` olur.

### 3.3 Admin API sözleşmesi (SUPER_ADMIN)

| Uç | Amaç |
| --- | --- |
| `GET /admin/campaigns` | liste + özet sayaçlar |
| `POST /admin/campaigns` | `{key, name, budgetCredits?, priority?}` → DRAFT |
| `GET /admin/campaigns/:id` | detay + versiyonlar + audit |
| `POST /admin/campaigns/:id/versions` | kural JSON'u doğrula + immutable versiyon yaz (`201 {version}` / `400 {errors[]}`) |
| `POST /admin/campaigns/:id/versions/validate` | yalnız doğrula (kurucu ekranı canlı hata için) |
| `POST /admin/campaigns/:id/versions/:v/activate` | `activeVersionId` değiştir (+ DRAFT ise ACTIVE) |
| `POST /admin/campaigns/:id/pause|resume|end` | durum geçişleri, gerekçe zorunlu |
| `GET /admin/campaigns/:id/redemptions` | filtreli liste |
| `GET /admin/campaign-evaluations?providerId=` | "neden hak etmedi" |
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
webhook tx:  HMAC → PROCESSED? → settle: PAID → PACKAGE_PURCHASE ledger → [campaign.evaluate(PACKAGE_PAYMENT_SUCCEEDED, purchase)]
             → CAMPAIGN_GRANT ledger + lot + redemption → recordAttempt(PROCESSED) → commit → receipt mail
approve tx:  status/approvedAt → claim/vitrin yan etkileri → [campaign.evaluate(PROVIDER_APPROVED, provider)] → commit → mail
offer tx:    rules → resolve → offer.create → consume: lots(en erken dolacak) → OFFER_SPEND → consumptions → commit
```

Değerlendirme tetikleyici tx'inin **son** adımıdır ve **yalnız beklenen iş hataları** (koşul sağlanmadı,
bütçe yok) sessizce `EvaluationLog` yazar; beklenmeyen hata (kural JSON ayrıştırılamadı vb.) tetikleyici
tx'ini **geri almaz**: motor `try/catch` ile `outcome=ENGINE_ERROR` yazar ve loglar. Gerekçe: bir kampanya
hatası ödeme settle'ını veya sağlayıcı onayını engelleyemez (ödeme otoritesi webhook; kampanya ikincil).
Ancak grant yazımı başladıysa (ledger + lot) ve ortada hata olursa tx'in tamamı geri alınır — kısmi grant
yoktur; bu durumda webhook `PROCESSED` de yazılmamış olur ve Lemon tekrar teslim eder (mevcut davranış).

### 3.6 Tekrar olay / webhook tekrarında tek hak ediş

1. Webhook: `PaymentWebhookEvent.status=PROCESSED` kısa devresi (`payments-webhook.service.ts:265`) →
   settle çalışmaz → değerlendirme çalışmaz.
2. `CampaignRedemption.triggerEventKey` unique → aynı purchase/approval ikinci kez hak edemez, hangi yoldan
   gelirse gelsin (yeniden yargılanan `MISMATCHED` olay, ikinci onay geçişi, admin retry).
3. `@@unique([campaignId, providerId])` → aynı kampanyadan ikinci lot imkânsız.
4. `PromoCreditLot.redemptionId` unique, `grantTransactionId` unique → tek redemption tek lot tek ledger satırı.
5. Süresi dolmuş lot süpürücüsü koşullu `updateMany status=ACTIVE/EXHAUSTED AND expiresAt<=now` → çift
   `CAMPAIGN_EXPIRY` yok; `expiryTransactionId` unique.

### 3.7 Suistimal senaryoları

| Senaryo | Açık kapı bugün | v1 önlemi | Kalan risk |
| --- | --- | --- | --- |
| Aynı kişi ikinci sağlayıcı hesabı | `User.email/phone` global unique; ancak yeni e-posta+yeni telefonla ikinci hesap açılabilir | `EMAIL_VERIFIED + PHONE_VERIFIED` (gerçek kanal kanıtı), `FIRST_PROVIDER_APPROVAL` (onay insan kararı) | Çok numaralı kişi; maliyeti 10 süreli kredi ile sınırlı, bütçe/günlük limit tavan koyar |
| Aynı işletme, farklı hesap | `taxNumber` unique değil | v1 kural yok (kanıt kaynağı yok) | Açık; admin onayında görünür; sonraki sürüm `taxNumber` normalizasyonu + `BUSINESS_UNIQUE` koşulu |
| İade sonrası yeniden satın alma | `REFUNDED` yazılmaz, purchase `PAID` kalır | `FIRST_SUCCESSFUL_PAID_PURCHASE` iade edileni sayar → ikinci alım "ilk" değil; `NO_PRIOR_REVOCATION` | Yok (bonus tekrar üretilemez) |
| Promo ile teklif → iade → kalıcı kredi | 48s iade lot bilmez | §2.6: lot'a geri; süresi dolmuşsa aynı tx'te expire | Yok |
| Süre dolmadan hızlı harcama + paket iadesi | Bonus harcanmış | Harcanan kısım geri alınmaz; admin görür; `NO_PRIOR_REVOCATION` gelecek bonusu keser; otomatik PAUSE eşiği | Sınırlı, tek seferlik |
| Admin tekrar denemesi / çift tık | — | `triggerEventKey` + `(campaignId, providerId)` unique; pause/resume idempotent | Yok |
| Askı → yeniden onay (ikinci "geçiş") | `approvedAt` üzerine yazılır, geçmiş yok | `FIRST_PROVIDER_APPROVAL` redemption varlığına bakar (onay geçmişine değil) + `triggerEventKey=PROVIDER_APPROVED:<providerId>` sabit | Yok |
| Misafir başvuru (`userId=null`) onayı | Kanıt hesaba bağlı | `EMAIL/PHONE_VERIFIED` false → hak yok; claim sonrası **tetikleyici yok** (onay geçmişte) | Ürün kararı: claim sonrası bonus istenirse v2 tetikleyici |
| Webhook sahteciliği | HMAC, store, tutar, variant kontrolü | Değişmez; kampanya yalnız settle sonrası | Yok |

---

## 4. CMP-002 dilimleri

| Dilim | İçerik | Migration | Bağımlılık |
| --- | --- | --- | --- |
| **S0** Kural çekirdeği | `apps/api/src/modules/campaigns/rules/`: şema tipleri, ayrıştırıcı, validator (hata modeli), saf `evaluate(rules, facts)`; unit testler; hiçbir wiring yok | Yok | — |
| **S1** Kampanya tanımı | Enum'lar + `Campaign, CampaignVersion, CampaignAuditLog`; admin CRUD/validate/activate/pause API; admin UI liste+kurucu; motor **kapalı** (redemption yok) | **A** (tanım tabloları) | S0 |
| **S2** Hak ediş + lot + harcama | `CreditTransactionType` genişletme, `CampaignRedemption, PromoCreditLot, PromoCreditLotConsumption, CampaignEvaluationLog, CampaignDailyCounter`, `OperationsSettings` anahtarları; `updateProviderStatus`→`runSerializable`; webhook/mock settle hook'u; resolver lot tüketimi; iade lot geri yazımı; expiry süpürücü + scheduler anahtarı | **B** (ledger enum + lot tabloları + settings) | S1 |
| **S3** Sağlayıcı yüzeyi + bildirim | credits sayfası promo satırı/etiketler; grant maili + dedupe; admin ledger etiketleri | Yok | S2 |
| **S4** Reversal + denetim | `order_refunded` → revoke; admin revoke ucu; otomatik PAUSE eşiği; redemption/evaluation ekranları | Yok (kolonlar B'de) | S2 |
| **S5** E2E + fingerprint + runbook | Playwright akışları; migration dry-run fingerprint; docs | Yok | S1–S4 |

**Kapalı beta için en kısa güvenli yol: S0 + S1 + S2 (+ S4'ün revoke kısmı).** Bu üçü ile admin, kod
değişmeden §7'deki iki kampanyayı kurucu ekranından tanımlar; S3 olmadan sağlayıcı bakiyesini görür ama
promo ayrımını göremez (beta'da kabul edilebilir, ama S3 hemen ardından). S4 revoke olmadan paket-bonus
kampanyası **açılmamalı** (iade riski); onay kampanyası açılabilir — **ancak §1.4 önkoşulu:** sağlayıcı
e-posta/telefon kanıtı akışı (`AUTH-EMAIL-002` / `AUTH-PHONE-002` benzeri ayrı iş) main'e girmeden
`EMAIL_VERIFIED/PHONE_VERIFIED` koşullu kampanya hiçbir zaman hak ettirmez. CMP-002 bu akışı **kapsamaz**.

---

## 5. Test planı

| Alan | Testler |
| --- | --- |
| Kural DSL (S0, vitest) | şema kabul/ret matrisi (her hata kodu ≥1 vaka), derinlik/boyut sınırları, tetikleyici-koşul uyumsuzluğu, `any` doğruluk tablosu, deterministik sıralama |
| API (S1) | RBAC: CUSTOMER/PROVIDER 403; versiyon immutability (PATCH yok, 405/404); activate akışı; audit satırı her geçişte |
| Transaction (S2) | grant + lot + redemption tek tx; grant yazımında hata → purchase PAID **yazılmamış** (rollback) ve webhook redelivery ile tek grant; değerlendirme iş hatası → tetikleyici tx commit |
| Webhook | `order_created` tekrar teslim → tek redemption; `MISMATCHED→PROCESSED` yeniden yargılama → tek grant; `order_refunded` → revoke harcanmamış, `spentAtRevoke` doğru; kısmi iade aynı davranış |
| Concurrency | iki teklif aynı sağlayıcı, 1 promo kredi: biri promo biri ücretli/402; grant vs spend yarışı: bakiye eşitliği (`balance = paid + Σremaining`) her senaryoda; bütçe son kredi için iki webhook |
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
kademeli admin rolü, sağlayıcı e-posta/telefon kanıt akışı (ayrı iş), `taxNumber` tekilleştirme, çok-instance
scheduler kilidi, expiry/revoke e-postaları, A/B veya segment hedefleme.

---

## 7. İlk iki beta kampanyasının konfigürasyonu (admin kurucu çıktısı)

**K1 — Onaylı sağlayıcı hoş geldin kredisi** (önkoşul: sağlayıcı kanıt akışı main'de)

```json
{
  "schemaVersion": 1,
  "trigger": "PROVIDER_APPROVED",
  "conditions": { "all": [
    { "type": "FIRST_PROVIDER_APPROVAL" },
    { "type": "EMAIL_VERIFIED" },
    { "type": "PHONE_VERIFIED" },
    { "type": "NO_PRIOR_REVOCATION" }
  ] },
  "benefit": { "type": "PROMO_CREDIT_LOT", "credits": 10, "validityDays": 30 },
  "limits": { "perProvider": 1, "global": 1000, "perDay": 100 },
  "window": { "startAt": null, "endAt": null },
  "stackPolicy": "EXCLUSIVE"
}
```

**K2 — İlk paket bonusu** (S4 revoke şart)

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
  "limits": { "perProvider": 1, "global": 2000, "perDay": null },
  "window": { "startAt": "2026-10-01T00:00:00Z", "endAt": "2026-12-31T23:59:59Z" },
  "stackPolicy": "EXCLUSIVE"
}
```

`Campaign.priority`: K1=10, K2=20 (aynı olayda ikisi zaten farklı tetikleyicidir; sıralama gelecekteki
çakışmalar için deterministiktir). Yerel envanter: tek seferlik paket fiyatı 100000 kuruş
(`project_vit_notify_003_local_sync` notu) → K2 `MIN_PAID_AMOUNT` 50000 yerelde sağlanır; prod katalog fiyatı
bilinmiyor, kurucu ekranı slug listesini katalogdan doğrular.
