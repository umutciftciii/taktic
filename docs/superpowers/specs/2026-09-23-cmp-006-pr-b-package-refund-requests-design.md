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
WITHDRAWN ◀─────────────┘              kanıtlı tam iade webhook'u   kanıtsız iade webhook'u / operatör (gerekçeli)
(terminal)                                                     ▼            ▼
                                                           SETTLED ◀── SETTLEMENT_FAILED
                                                          (terminal)   yalnız kanıtlı tam iade webhook'u
```

**`SETTLEMENT_FAILED` terminal değildir** (rev. 3): dış ödemenin henüz kesinleşmemiş olduğunu kaydeden bir
mutabakat hatasıdır. Tek çıkışı `SETTLED`'dır ve bu geçişi **yalnız** tam iadeyi kanıtlayan imzalı webhook yazabilir
(operatör rotası yok; CHECK webhook olayını ister). Satır başarısızlık kaydını (zaman, gerekçe, neden) `SETTLED`
olduktan sonra da taşır. Başka hiçbir geçişe ya da kolon değişikliğine izin yoktur. Açık istek sayılır
(paket başına tek açık istek index'i onu içerir). Terminal durumlar: `REJECTED`, `SETTLED`, `WITHDRAWN`.

| Geçiş | Aktör | Koşul | DB garantisi |
| --- | --- | --- | --- |
| `→ SUBMITTED` (sağlayıcı) | PROVIDER, kendi paketi | Kapı açık, `PAID`, kanıt var, uygunluk **REFUNDABLE** | açık talep partial unique |
| `→ SUBMITTED` (operatör) | `PACKAGE_REFUND_REQUEST_CREATE` | Sağlayıcının **kendi açtığı** mevcut destek talebi, kapı açık, `PAID`, kanıt var, uygunluk `NOT_APPLICABLE` değil | aynı |
| `SUBMITTED → UNDER_REVIEW` | `PACKAGE_REFUND_REQUEST_CREATE` | kapı açık | `reviewStartedById` NOT NULL |
| `UNDER_REVIEW → REJECTED` | `PACKAGE_REFUND_APPROVE` | gerekçe 10–1000 | CHECK |
| `UNDER_REVIEW → APPROVED_PENDING_SETTLEMENT` (NORMAL) | `PACKAGE_REFUND_APPROVE` | kapı açık, kanıt var, **o anda yeniden hesaplanan** uygunluk `REFUNDABLE` | CHECK: onaylayan + snapshot NOT NULL |
| `UNDER_REVIEW → APPROVED_PENDING_SETTLEMENT` (EXCEPTION) | `PACKAGE_REFUND_APPROVE` | kapı açık, kanıt var, yeniden hesaplanan uygunluk `EXCEPTION_ONLY`, kapalı küme gerekçe kodu + açıklama 10–1000, **onaylayan ≠ açan ≠ işleme alan** | **maker-checker CHECK (NULL kaçağı kapalı)** |
| `APPROVED_PENDING_SETTLEMENT → SETTLED` | **yalnız webhook** | imzalı, sandbox, doğru mağaza, bu satın almayı ödeyen sipariş, `order_refunded` | CHECK + FK + `settledByWebhookEventId @unique` + paket başına tek SETTLED |
| `SETTLEMENT_FAILED → SETTLED` | **yalnız webhook** | §3 tam iade kanıtı | tetikleyici (başka çıkış yok) + `settled_by_webhook` CHECK |
| `APPROVED_PENDING_SETTLEMENT → SETTLEMENT_FAILED` | `PACKAGE_REFUND_APPROVE` **veya** tam iadeyi kanıtlamayan imzalı `order_refunded` (§3) | gerekçe 10–1000 | CHECK: tam bir neden (`settlementFailedById` XOR `settlementFailedByWebhookEventId`) |
| `SUBMITTED \| UNDER_REVIEW → WITHDRAWN` | PROVIDER, kendi talebi | — | tetikleyici: onaydan sonra imkânsız |

**Tetikleyici `PackageRefundRequest_transition_guard`** (BEFORE UPDATE OR DELETE): DELETE reddedilir; kimlik kolonları
(`supportTicketId`, `purchaseId`, `providerId`, `createdById`, `origin`, `submittedEligibility`, `createdAt`)
değişmez; durum değişikliği yalnız yukarıdaki tablodaki çiftlerle; terminal satırın (`REJECTED`, `SETTLED`,
`WITHDRAWN`) hiçbir kolonu değişmez; `SETTLEMENT_FAILED` satırı yalnız `SETTLED`'a geçebilir.
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

## 3. Webhook mutabakatı — tam iade kanıtı (rev. 2, 2026-09-23)

### 3.1 Sağlayıcı sözleşmesi ve neden `priceAmountSnapshot` kullanılmaz

Lemon Squeezy `order_refunded` olayı **tam ve kısmi** iadede gelir; payload Order nesnesidir. Tutar/durum alanları:
`total` ve `refunded_amount` (sipariş para biriminde, kuruş, tam sayı), `currency`, `refunded` ("tamamen iade
edildiyse `true`"), `status` (`refunded` | `partial_refund`). Satır kaleminde iade tutarı yoktur.

Sipariş düzeyindeki tutarlar TRY mağazada USD normalizasyonuyla kayar (gerçek sandbox: 999,00 TL checkout,
`total` 99904 — commit `624f843d`). Doğru bir tam iade `priceAmountSnapshot`'a hiçbir zaman eşit olmaz; tolerans
tahmindir. Bu yüzden karşılaştırma **Lemon'un kendi toplamına** yapılır:

- **Ödeme anında (tek yazıcı):** imzalı `order_created`'ı PAID yapan settlement, siparişin `total`/`currency`'sini
  `PackagePurchase.providerOrderTotalAmount`/`providerOrderCurrency` olarak yazar. İkisi birlikte ya da hiç (CHECK),
  ISO kod ve ≥ 0 (CHECK), yazıldıktan sonra değişmez/silinmez (tetikleyici). Hiçbir DTO taşımaz, hiçbir satın alma
  projeksiyonu döndürmez (`packagePurchaseOmit`). Mevcut satın alma satırı işleme alınmaz (**DML yok**) → NULL.
- **İade anında:** `fullRefundFailure(event, purchase)` şu koşulların **hepsini** tam eşitlikle arar:
  saklı toplam+para birimi var · `refunded === true` · `status === 'refunded'` · `refunded_amount === saklı toplam` ·
  `currency === saklı para birimi`. Float, tolerans, dönüşüm, `priceAmountSnapshot` yok.

### 3.2 Karar tablosu (`flagForManualReview`, ilgili ters işlem içinde)

| Olay | Kanıt | Etki |
| --- | --- | --- |
| `order_refunded`, ilgili, **tam kanıt geçti** | ✓ | S3 promo revoke (değişmedi) · onaylı istek varsa `SETTLED` + satın alma `REFUNDED` + audit + bildirim |
| `order_refunded`, ilgili, **kanıt geçmedi** (kısmi/fazla/eksik/para birimi/tutar yok/saklı toplam yok) | ✗ | **Revoke yok, REFUNDED yok, kredi/promo etkisi yok.** Onaylı istek varsa tek seferlik `SETTLEMENT_FAILED` (`settlementFailedByWebhookEventId`, gerekçe + kod) + audit (`PAYMENT_WEBHOOK`) + ticket olayı + bildirim |
| `order_refunded`, ilgisiz (canlı mod, başka mağaza/sipariş) | — | Yalnız bayrak (değişmedi) |
| `subscription_payment_refunded` | — | Bugünkü S3 davranışı; iade isteğine dokunmaz |

Bayrak (`manualReviewAt`) her durumda eskisi gibi yazılır — mali etki değil, insan için işarettir.

**Main'deki hata kapandı:** talebe bağlı olmayan kısmi `order_refunded` artık S3 promo revoke tetiklemez.

### 3.3 İdempotency — iade durumu olayı (rev. 3)

Lemon webhook'larında belgelenmiş bir teslim/olay kimliği **yok** (`X-Event-Name`, `X-Signature`, `meta.event_name`,
`meta.custom_data`). `order_refunded` ise bir siparişin **her** iadesinde gelir. Sipariş başına tek anahtar, kısmi
iadeden sonra gelen tamamlayıcı tam iadeyi "tekrar" sayıp mutabakatı imkânsız kılıyordu.

Yeni anahtar yalnız `order_refunded` için: `order_refunded:orders:<orderId>:<sha256(status, refunded,
refunded_amount, currency) ilk 32 hex>`. Diğer tüm olaylar (`order_created` dahil) eski `event:type:id` biçimini korur.

- Aynı iade durumunun tekrar teslimi aynı anahtar → mevcut `MANUAL_REVIEW_REQUIRED` kısa devresi → tek olay, sıfır ek etki.
- Kümülatif `refunded_amount` yalnız artar, tam iade bayrağı yalnız bir kez döner → her gerçek yeni iade yeni anahtardır.
- **Zaman damgası anahtara girmez:** sağlayıcı tekrar denemelerde `updated_at`'in aynen tekrarlandığını belgelemiyor;
  zamanla değişen bir anahtar tek bildirimi ikiye bölerdi. Durum alanları yeni iadeyi ayırt etmeye yeter.
- Anahtar özetlenmiş hâlde saklanır: `PaymentWebhookEvent.eventKey` tutar/para birimi taşımaz.

Tam iade sonrası gelen her bildirim satın almayı `REFUNDED` bulur (ilgili ters işlem değildir) → bayrak dışında etki
yok; ayrıca `SETTLED` istek paket başına tekildir. Unique: `settledByWebhookEventId`, `settlementFailedByWebhookEventId`,
audit `webhookEventId`.

Webhook gelmezse otomatik `SETTLED` yok; operatör yalnız `SETTLEMENT_FAILED` yazabilir.

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
- `PackagePurchase.providerOrderTotalAmount` (Int) + `providerOrderCurrency` (ISO) — yalnız webhook settlement'ı
  yazar; CHECK (ikisi birlikte, ≥ 0, `^[A-Z]{3}$`) + değişmezlik tetikleyicisi; hiçbir projeksiyonda yok.
- `PackageRefundRequest.settlementFailedByWebhookEventId` (unique, FK); audit `actor_shape`: webhook satırı yalnız
  `SETTLED`/`SETTLEMENT_FAILED`, `SETTLED` yalnız webhook.
- **DML yok.** `ALTER COLUMN … SET NOT NULL` yok. Eski satın almaların sağlayıcı toplamı backfill edilmez.

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

## 7. Bildirim (rev. 2)

Tek şablon `package-refund-status`, dedupe anahtarı geçişin audit satırı: `package-refund-status:<eventId>`.
Niyet (NotificationLog PENDING) geçişle **aynı transaction'da** yazılır (`enqueuePackageRefundNotice`); commit sonrası
`PackageRefundNotificationOutbox.deliverSoon()` gönderir, kalanları request lifecycle tick'i süpürür. Gönderim
hatası niyeti FAILED yapar, durumu geri almaz.

| Geçiş | E-posta |
| --- | --- |
| `SUBMITTED`, `UNDER_REVIEW`, `REJECTED`, `APPROVED_PENDING_SETTLEMENT`, `SETTLED`, `SETTLEMENT_FAILED` | Evet, geçiş başına bir kez |
| `WITHDRAWN` | Hayır (ticket zaman çizelgesi yeterli) |

İçerik: paket adı, satın alma no, paket tutarı, durum, zaman, ticket bağlantısı. Ret ve başarısızlık **sabit güvenli
özetle** anlatılır (operatör gerekçesi, kod, Lemon tutarı taşınmaz); webhook kaynaklı başarısızlık ayrı sabit cümle.
Sözleşme metni, IP/UA, digest, ödeme referansı, sipariş kimliği, webhook verisi yok.

## 8. Test planı

API (`package-refund-requests.spec.ts`, `package-refund-settlement.spec.ts`, `package-refund-access.spec.ts`,
`package-refund-schema.spec.ts`), route-map/izin sayısı güncellemesi, web birim testleri, E2E
(`package-refund-request.spec.ts`, purchase-terms runtime'ına admin süreci eklenir; Chromium + WebKit),
izole migration dry-run.

## 9. Release kapıları

RG-1 ve RG-2 (PR-A) açık kalır — kapı açılmadan bu akış da görünmez. **RG-3 (mutabakat prosedürü)** bu PR'ın
üretim kapısıdır: Lemon panelinde **tam tutar** iade adımları, `APPROVED_PENDING_SETTLEMENT` SLA'sı, webhook
gelmezse `SETTLEMENT_FAILED` kaydı ve sağlayıcıya destek talebinden bilgi verilmesi yazılı olmalıdır.
**Ayrıca, motor veya kapı açılmadan önce staging'de gerçek Lemon sandbox üzerinde bir tam ve bir kısmi iade
webhook'u doğrulanacak:** tam iadede `refunded === true`, `status === 'refunded'`, `refunded_amount ===` saklanan
`total` ve `currency` eşleşmesi (→ `SETTLED`); kısmi iadede `partial_refund` (→ `SETTLEMENT_FAILED`, revoke yok).
Aynı sipariş için kısmi → tam iade dizisinde iki ayrı olay geldiği ve payload'ın tekrar denemede aynı iade durumunu
taşıdığı (§3.3) da bu doğrulamada gözlenecek.
