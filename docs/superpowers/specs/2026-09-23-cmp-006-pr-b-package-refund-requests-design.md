# CMP-006 PR-B — Destek talebine bağlı paket iade isteği ve kontrollü dış mutabakat

Tarih: 2026-09-23 · Taban: `main` @ `58c51e13` (PR #106 merge) · Branch: `claude/cmp-006-prb-package-refund-032c11` ·
Bağlayıcı üst belge: [CMP-006 S0](2026-09-22-cmp-006-s0-refund-rbac-fraud-channel-design.md) §2–§3, §6.3, §10 ·
Önceki dilimler: [PR-0 RBAC](2026-09-22-pr0-admin-rbac-design.md), [PR-A kabul kanıtı + uygunluk](2026-09-22-cmp-006-pr-a-package-refund-terms-design.md).

**Kampanya motoru anahtarı okunmaz, yazılmaz, açılmaz. `PURCHASE_TERMS_GATE` varsayılan kapalı kalır. Gerçek
Lemon, gerçek checkout, gerçek e-posta/SMS, staging/yerel veri bu PR'da kullanılmaz. Hukuki metin değişmez.**

---

## 0. Görev tanımının S0'dan ayrıldığı yerler (bu PR'ı bağlayan görev tanımıdır)

| S0 | Bu PR | Gerekçe |
| --- | --- | --- |
| `DRAFT` durumu | **Yok.** Talep `SUBMITTED` doğar | Görev tanımının durum makinesi `SUBMITTED` ile başlar; taslak durumu hiçbir aktörün işine yaramıyordu |
| `SETTLEMENT_ABANDONED` | **`SETTLEMENT_FAILED`** | Görev tanımının adı; anlamı aynı (webhook gelmedi / iade dışarıda başarısız) |
| Geri çekme yalnız `DRAFT/SUBMITTED` | **`SUBMITTED` ve `UNDER_REVIEW`** | Görev tanımı; `APPROVED_PENDING_SETTLEMENT`'tan sonra kapalı (operatör Lemon'da iade yapmış olabilir) |
| Okuma izni `PACKAGE_PURCHASES_READ` | **Yeni `PACKAGE_REFUND_READ`** | Paket satın alma listesini gören herkesin iade kararlarını ve uygunluk snapshot'ını görmesi gerekmiyor |
| Maker-checker her onayda | **Yalnız istisna onayında** (normal onayda da onaylayan zorunlu kayıtlı) | Görev tanımı: "admin tarafından açılmış veya işleme alınmış istisna talebini aynı admin onaylayamaz". Normal onay kanonik uygunluk hesabına bağlı olduğu için ikinci göz istisnadaki kadar değer katmıyor |
| Settle anında clawback + `unrecoveredCreditBenefit` | **Yok.** `creditClawbackCredits` kolonu var, CHECK ile **0'a kilitli** | Görev tanımı: bu PR clawback uygulamaz; risk sinyali modeli sonraki dilimde |
| `SupportTicket.packagePurchaseId` | **Yok.** Bağ `PackageRefundRequest.supportTicketId @unique` + `purchaseId` üzerinden | Tek bilgi tek yerde: aynı satın almayı iki kolonda tutmak bir gün ikisinin ayrışmasına izin verir |

## 1. Ürün sözleşmesi (özet)

1. Sağlayıcı para iadesini **kendi kendine gerçekleştiremez**. Tek yazma yüzeyi: Destek > Yeni talep > konu
   **"Paket ve kredi iadesi"** + kendi `PAID` paketlerinden biri. Bu işlem **tek transaction'da** bir
   `SupportTicket` (konu `PACKAGE_AND_CREDIT_REFUND`) + ona bağlı tek `PackageRefundRequest` (`SUBMITTED`) yazar.
2. Operatör parayı **Lemon panelinde, TakTic dışında** iade eder. TakTic'te hiçbir para hareketi çağrısı yoktur;
   `PaymentProviderPort` değişmez.
3. **`SETTLED`'a yalnız imzalı, ilgili `order_refunded` webhook'u geçirir.** Hiçbir admin rotası `SETTLED` yazmaz;
   DB tetikleyicisi ve CHECK aynı kuralı ikinci kez tutar.
4. Talebe bağlı olmayan `order_refunded` bugünkü davranışı birebir korur: bayrak + S3 promo revoke. Talep üretmez.

## 2. Durum makinesi

```
SUBMITTED ──take──▶ UNDER_REVIEW ──reject──▶ REJECTED (terminal)
    │                   │
    │ withdraw          ├──approve (NORMAL | EXCEPTION)──▶ APPROVED_PENDING_SETTLEMENT
    ▼                   │ withdraw                               │            │
WITHDRAWN ◀─────────────┘                    order_refunded webhook  settlement-failed (gerekçeli)
(terminal)                                                     ▼            ▼
                                                           SETTLED    SETTLEMENT_FAILED
                                                          (terminal)     (terminal)
```

| Geçiş | Aktör | Koşul | DB garantisi |
| --- | --- | --- | --- |
| `→ SUBMITTED` (sağlayıcı) | PROVIDER, kendi paketi | Kapı açık, `PAID`, kanıt var, uygunluk **REFUNDABLE** | açık talep partial unique |
| `→ SUBMITTED` (operatör) | `PACKAGE_REFUND_REQUEST_CREATE` | Sağlayıcının **kendi açtığı** mevcut destek talebi, kapı açık, `PAID`, kanıt var, uygunluk `NOT_APPLICABLE` değil | aynı |
| `SUBMITTED → UNDER_REVIEW` | `PACKAGE_REFUND_REQUEST_CREATE` | kapı açık | `reviewStartedById` NOT NULL |
| `UNDER_REVIEW → REJECTED` | `PACKAGE_REFUND_APPROVE` | gerekçe 10–1000 | CHECK |
| `UNDER_REVIEW → APPROVED_PENDING_SETTLEMENT` (NORMAL) | `PACKAGE_REFUND_APPROVE` | kapı açık, kanıt var, **o anda yeniden hesaplanan** uygunluk `REFUNDABLE` | CHECK: onaylayan + snapshot NOT NULL |
| `UNDER_REVIEW → APPROVED_PENDING_SETTLEMENT` (EXCEPTION) | `PACKAGE_REFUND_APPROVE` | kapı açık, kanıt var, yeniden hesaplanan uygunluk `EXCEPTION_ONLY`, kapalı küme gerekçe kodu + açıklama 10–1000, **onaylayan ≠ açan ≠ işleme alan** | **maker-checker CHECK (NULL kaçağı kapalı)** |
| `APPROVED_PENDING_SETTLEMENT → SETTLED` | **yalnız webhook** | imzalı, sandbox, doğru mağaza, bu satın almayı ödeyen sipariş, `order_refunded` | CHECK + FK + `settledByWebhookEventId @unique` + paket başına tek SETTLED |
| `APPROVED_PENDING_SETTLEMENT → SETTLEMENT_FAILED` | `PACKAGE_REFUND_APPROVE` | gerekçe 10–1000 | CHECK |
| `SUBMITTED \| UNDER_REVIEW → WITHDRAWN` | PROVIDER, kendi talebi | — | tetikleyici: onaydan sonra imkânsız |

**Tetikleyici `PackageRefundRequest_transition_guard`** (BEFORE UPDATE OR DELETE): DELETE reddedilir; kimlik kolonları
(`supportTicketId`, `purchaseId`, `providerId`, `createdById`, `origin`, `submittedEligibility`, `createdAt`)
değişmez; durum değişikliği yalnız yukarıdaki tablodaki çiftlerle; terminal satırın hiçbir kolonu değişmez.
Böylece "admin `SETTLED` yazdı" ya da "onaylanmış talep geri çekildi" servis katmanını atlayan bir SQL'le de
mümkün değildir.

### 2.1 Kapı ve kapının kapsamı (fail-closed)

`isPackageRefundFlowOpen()` (`package-refund-request.rules.ts`) = `resolvePurchaseTermsGate()` **açık ve geçerli** (geçersiz set fırlatırsa
kapalı sayılır). Ayrıca her satın alma için `termsAcceptanceRequired = true` ∧ `purchaseTermsAcceptanceId IS NOT NULL`.

| Aksiyon | Kapı kapalı / kanıt yok |
| --- | --- |
| Sağlayıcı seçenekleri (`GET /support/package-refund/options`) | `{ available: false, purchases: [] }` — form konuyu hiç göstermez |
| Sağlayıcı oluşturma (`POST /support/tickets` + `topic`) | **403 `PACKAGE_REFUND_UNAVAILABLE`**, satır yazılmaz |
| Operatör oluşturma, işleme alma, onay | **409 `PACKAGE_REFUND_UNAVAILABLE`** |
| Ret, geri çekme, `SETTLEMENT_FAILED`, webhook mutabakatı | **Açık** — riski azaltan ya da dış gerçeği kaydeden geçişler kapıya bağlanmaz; kapının sonradan kapanması açık talepleri kilitli bırakmamalı |

Kanıtsız (kapıdan önceki) satın almalar seçicide **hiç listelenmez**; sağlayıcı genel konu üzerinden yazar.
DB de aynı kuralı tutar: `PackageRefundRequest_insert_guard` kanıtsız ya da vitrin satın almasına bağlanan satırı
**hangi yoldan gelirse gelsin** reddeder (servis birinci, tetikleyici ikinci çit).

### 2.2 Uygunluk

- **Snapshot (submit):** PR-A `evaluate` sonucu `submittedEligibility` (jsonb) olarak donar; bir daha yazılmaz.
- **Yeniden hesap (onay):** Onay transaction'ında (Serializable) `readFacts(tx, …)` ile aynı snapshot'tan okunur ve
  `approvalEligibility` olarak saklanır. `paidAt` sonrası **herhangi** `OFFER_SPEND` ya da bağlı promo tüketimi →
  normal onay 409 `PACKAGE_REFUND_NOT_NORMALLY_ELIGIBLE` (engelleyen kodlarla). `NOT_APPLICABLE` (ödenmemiş, zaten
  iade, ters işlem kaydı var) → her onay türü 409 `PACKAGE_REFUND_NOT_APPLICABLE`.
- Sağlayıcı yalnız `REFUNDABLE` satın almayla talep açabilir; `EXCEPTION_ONLY` satın alma seçicide açıklamasıyla
  pasif görünür. İstisna yolu: sağlayıcı genel konu ile yazar, operatör o talep üzerinden istisna isteği açar.

### 2.3 İstisna gerekçeleri (kapalı küme, enum)

`STATUTORY_RIGHT` · `UNAUTHORIZED_TRANSACTION` · `DUPLICATE_CHARGE` · `PLATFORM_SERVICE_FAULT`. İstisna onayı:
kod + açıklama zorunlu (CHECK), audit satırında açıklama saklanır, **onaylayan ne açan ne işleme alan olabilir**.

### 2.4 Maker-checker (DB)

```sql
CHECK ("approvalKind" IS DISTINCT FROM 'EXCEPTION' OR (
  "approvedById" IS NOT NULL AND "reviewStartedById" IS NOT NULL
  AND "approvedById" <> "reviewStartedById" AND "approvedById" <> "createdById"))
```

`createdById` NOT NULL (sağlayıcının açtığında sağlayıcı kullanıcısı; eşitsizlik zaten doğru). `IS NOT NULL`
konjunktları `<>`'ın NULL'da UNKNOWN dönüp CHECK'i geçirmesini engeller (S0 D5). `IS DISTINCT FROM` sayesinde
`approvalKind` NULL iken de koşul belirlidir; onaylı durumlar ayrıca `approvalKind IS NOT NULL` ister.

## 3. Webhook mutabakatı

`flagForManualReview` Serializable transaction'ının **sonuna**, mevcut adımlardan (bayrak, attempt kaydı, S3
revoke) **sonra**, tek bir çağrı eklenir:

```
if (event.eventName === 'order_refunded' && purchase && isRelevantReversal(event, purchase, storeId))
  settleFromWebhook(tx, { purchaseId, webhookEventId: recorded.id, now })
```

`settleFromWebhook`: bu satın almanın `APPROVED_PENDING_SETTLEMENT` talebi varsa → `SETTLED`,
`settledByWebhookEventId`, `settledAt`, tek audit satırı (`actorKind = PAYMENT_WEBHOOK`, `webhookEventId` unique),
destek zaman çizelgesi aktivitesi, `PackagePurchase.status = REFUNDED` + `refundedAt` (S0 §3.5: bugün hiçbir yolun
yazmadığı değer). **Kredi/ledger/para yazısı yok.** Talep yoksa hiçbir şey yapmaz.

İdempotency üç katmanlı: (1) mevcut `MANUAL_REVIEW_REQUIRED` kısa devresi tekrar teslimi transaction'a sokmaz;
(2) `settledByWebhookEventId @unique` + audit `webhookEventId` partial unique; (3) paket başına tek `SETTLED`
partial unique. `subscription_payment_refunded`, ilgisiz mağaza/sipariş, canlı mod, eşleşmeyen satın alma →
talep **settle edilmez**, S3 davranışı aynen çalışır.

Webhook gelmezse otomatik `SETTLED` yok; operatör yalnız `SETTLEMENT_FAILED` (gerekçeli) yazabilir.

**Bilinen sınır (RG-3'e eklendi):** Sandbox parser'ı `refunded_amount`'u okumaz; kısmi bir `order_refunded` da
talebi settle eder. Operasyon prosedürü paket iadesini **tam tutar** olarak yapmalıdır.

## 4. Veri modeli (Migration J `20260923120000_add_package_refund_requests`)

- `SupportTicketTopic { GENERAL, PACKAGE_AND_CREDIT_REFUND }`; `SupportTicket.topic @default(GENERAL)` —
  mevcut satırlar için varsayılan gerçek backfill'dir (hepsi genel konudur).
- `PackageRefundRequestStatus`, `PackageRefundApprovalKind { NORMAL, EXCEPTION }`,
  `PackageRefundExceptionGround`, `PackageRefundRequestOrigin { PROVIDER, ADMIN }`,
  `PackageRefundAuditAction`, `PackageRefundActorKind { PROVIDER, ADMIN, PAYMENT_WEBHOOK }`.
- `PackageRefundRequest` (kolonlar §2 tablosundaki alanlar) + 11 CHECK + 2 partial unique + tetikleyici.
- `PackageRefundRequestEvent` — audit + zaman çizelgesi kaynağı; append-only tetikleyici; webhook satırı için
  `actorId IS NULL ⇔ actorKind = PAYMENT_WEBHOOK ⇔ webhookEventId IS NOT NULL`.
- `AdminPermission` += `PACKAGE_REFUND_READ`, `PACKAGE_REFUND_REQUEST_CREATE`, `PACKAGE_REFUND_APPROVE`
  (`ALTER TYPE … ADD VALUE`; migration bu değerleri kullanmaz).
- **DML yok.** `ALTER COLUMN … SET NOT NULL` yok.

## 5. RBAC

| Rota | İzin |
| --- | --- |
| `GET /admin/package-refund-requests`, `GET /admin/package-refund-requests/:id` | `PACKAGE_REFUND_READ` |
| `POST /admin/package-refund-requests` (mevcut sağlayıcı talebine bağlar) | `PACKAGE_REFUND_REQUEST_CREATE` |
| `POST /admin/package-refund-requests/:id/take` | `PACKAGE_REFUND_REQUEST_CREATE` |
| `POST /admin/package-refund-requests/:id/approve` · `/reject` · `/settlement-failed` | `PACKAGE_REFUND_APPROVE` |

SUPER_ADMIN örtük tümüne sahip. Üç izin aynı role verilebilir; satır düzeyi kural (maker-checker) izin değil,
CHECK'tir. Admin destek talebi detayı iade bloğunu ve iade zaman çizelgesi olaylarını **yalnız
`PACKAGE_REFUND_READ` sahibine** döndürür; yalnız `SUPPORT_READ` sahibi konuyu görür, iade kaydını görmez.

**Sızıntı sözleşmesi:** sağlayıcı yalnız kendi talebini görür; başkasının satın alma/talep/destek kimliği 404
(var/yok ayrımı yok, S0 D16). Müşteri ve anonim hiçbir seçenek/uygunluk/iade bilgisi alamaz. Hiçbir iade
projeksiyonu IP/UA, sözleşme metni/digest, `paymentReference`, `providerOrderId`, `providerCheckoutId`, webhook
`eventKey`/payload taşımaz — allowlist `select` + tam anahtar seti testleriyle.

## 6. Yüzeyler

**Sağlayıcı (web):** `/destek/yeni` — kapı açık ve en az bir kanıtlı `PAID` paket varken konu seçimi; iade konusunda
paket seçici (her satır: paket adı, satın alma no, tutar, ödeme tarihi, uygunluk açıklaması, 14 günlük pencere
sonu; uygun olmayanlar pasif). Gönderim sonrası: *"Talep gönderildi; ödeme iadesi onaylanırsa ödeme sağlayıcısı
üzerinden işlenir."* Talep sayfasında iade kartı (durum, paket, geri çekme düğmesi yalnız izinli durumda) ve zaman
çizelgesinde iade olayları (aktör adı ve iç gerekçe **yok**).

**Admin:** Finans > "Paket İadeleri" listesi (durum filtresi), detay: satın alma özeti, destek talebine bağlantı,
submit ve onay snapshot'ı, **canlı** uygunluk, kabul kanıtının yalnız sürüm + an bilgisi, audit, izne ve
maker-checker'a göre açılan aksiyon formları. Destek talebi detayında "İade isteği" bağlantısı ve (izin varsa)
"Bu talep üzerinden iade isteği aç" formu.

## 7. Bildirim

Yeni e-posta/SMS **yok**. Sağlayıcının talebi mevcut destek akışıyla açıldığı için destek kutusuna giden
"yeni talep" bildirimi aynen çalışır. Durum değişikliği bildirimleri sonraki dilim.

## 8. Test planı

API (`package-refund-requests.spec.ts`, `package-refund-settlement.spec.ts`, `package-refund-access.spec.ts`,
`package-refund-schema.spec.ts`), route-map/izin sayısı güncellemesi, web birim testleri, E2E
(`package-refund-request.spec.ts`, purchase-terms runtime'ına admin süreci eklenir; Chromium + WebKit),
izole migration dry-run.

## 9. Release kapıları

RG-1 ve RG-2 (PR-A) açık kalır — kapı açılmadan bu akış da görünmez. **RG-3 (mutabakat prosedürü)** bu PR'ın
üretim kapısıdır: Lemon panelinde **tam tutar** iade adımları, `APPROVED_PENDING_SETTLEMENT` SLA'sı, webhook
gelmezse `SETTLEMENT_FAILED` kaydı ve sağlayıcıya destek talebinden bilgi verilmesi yazılı olmalıdır.
