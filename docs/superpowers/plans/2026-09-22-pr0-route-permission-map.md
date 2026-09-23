# PR-0 ön koşulu (RG-7) — rota + HTTP metodu + aksiyon düzeyinde izin eşleme tablosu

Tarih: 2026-09-22 · Taban: `origin/main` @ `6f765b81` (PR #103 merge, temiz worktree doğrulandı) ·
Branch: `claude/pr0-route-permission-map` ·
Bağlayıcı tasarım: [`2026-09-22-cmp-006-s0-refund-rbac-fraud-channel-design.md`](../specs/2026-09-22-cmp-006-s0-refund-rbac-fraud-channel-design.md)
(D11–D13, §6, RG-7).

**Bu belge yalnız envanter ve karardır.** Kod, Prisma şeması, migration, test, `.env`, container ve API/UI
davranışı değişmez. PR-0 kodu bu tabloyu girdi olarak alır.

**Neden rota düzeyi.** Tasarımın §6.3 tablosu controller/alan düzeyindeydi ve açıkça "eşlemenin **alt sınırı**"
olarak işaretlenmişti. Alan düzeyinde kalınsaydı, örneğin `offers` alanına verilen tek bir izin
`GET /offers` ile birlikte `POST /offers/refund-scan/execute`'u — toplu para hareketini — da açardı. §9'da
§6.3 ile farklar tek tek gerekçesiyle listelenmiştir.

---

## 1. Sayısal kanıt

| Ölçüm | Değer | Nasıl doğrulandı |
| --- | --- | --- |
| `@Roles(UserRole.SUPER_ADMIN)` kullanımı | **72** | `grep -rn "@Roles(UserRole.SUPER_ADMIN)" apps/api/src --include="*.ts" \| wc -l` |
| Bu dekoratörü içeren controller dosyası | **28** | aynı grep, `-l` |
| **Sınıf** düzeyi dekoratör | **14** | `export class` satırından önce görülen kullanım |
| **Metod** düzeyi dekoratör | **58** | `export class` satırından sonra görülen kullanım |
| Sınıf düzeyi 14 dekoratörün kapsadığı rota | **63** | o 14 controller'ın gövdesindeki tüm HTTP dekoratörleri |
| Metod düzeyi 58 dekoratörün kapsadığı rota | **58** | 1:1 — hiçbir handler'da ikinci bir HTTP dekoratörü (alias) yok |
| **SUPER_ADMIN korumalı toplam HTTP rota** | **121** | 63 + 58 |
| Aynı 28 dosyadaki SUPER_ADMIN korumasız rota | **37** | sağlayıcı/müşteri/public rotalar — §7 |
| 28 dosyadaki toplam HTTP rota | **158** | 121 + 37 ✓ |

**Denklem:** `72 = 14 + 58` ve `121 = 63 + 58`. Aşağıdaki §3 tablosunda **121 satır** vardır; §8'deki
kontrol toplamı her controller için ayrı ayrı tutar.

**Alias kontrolü.** Hiçbir handler birden fazla HTTP dekoratörü taşımıyor (metod düzeyi dekoratör sayısı = metod
düzeyi rota sayısı = 58). Dolayısıyla "aynı handler, iki gerçek HTTP rota" vakası bu kod tabanında yoktur; olsaydı
her biri ayrı satır olacaktı.

---

## 2. İzin adlandırma kuralları

1. **Katalog sabittir.** Aşağıdaki 77 değerin tamamı `AdminPermission` Prisma enum'una girer. Panelden yeni izin
   adı üretilemez (tasarım D11); yeni bir izin migration + kod demektir.
2. **`SUPER_ADMIN` örtük olarak hepsine sahiptir** ve hiçbir rol ataması gerektirmez (D12). Tablo, `SUPER_ADMIN`
   *olmayan* personel hesabının neye ihtiyaç duyduğunu söyler.
3. **Ad kalıbı:** `<ALAN>_READ` / `<ALAN>_WRITE` temel; ayrılan riskli aksiyonlar kendi son ekini alır
   (`_STATUS`, `_DELETE`, `_MODERATE`, `_ISSUE`, `_REVOKE`, `_EXECUTE`, `_TOGGLE`).
4. **Okuma ile yıkıcı aksiyon asla aynı izni paylaşmaz.** Aynı controller'daki `GET :id` ve `DELETE :id`
   farklı izinlerdir.
5. **Simetrik yazmalar birleşir.** Bir listeye ekleme ve o listeden çıkarma (`POST`/`DELETE` service-categories)
   tek `_WRITE` iznidir: ikisi de aynı alanı aynı yönde değiştirir ve biri diğerinden daha yıkıcı değildir.
6. **Kimlik bilgisi üreten her rota kendi iznini alır.** Davet/aktivasyon/claim bağlantısı mintleyen dört rota
   (`ADMIN_INVITE_ISSUE`, `CUSTOMER_ACTIVATION_LINK_ISSUE`, `PROVIDER_CLAIM_INVITE_ISSUE`,
   `PROVIDER_INVITES_ISSUE`) hiçbir okuma ya da düzenleme izniyle birleştirilmez — her biri hesap ele geçirme
   ya da yetki yükseltme yüzeyidir.
7. **Para hareketi eden her rota kendi iznini alır** ve yönü ayrılır (`CREDITS_GRANT` ≠ `CREDITS_DEDUCT`).

**Hassasiyet etiketleri:** `PARA` (bakiye/ödeme hareketi) · `KİMLİK` (kimlik bilgisi mintler) · `PII` (kişisel
veri okur) · `AYAR` (operasyon davranışını değiştirir) · `YAYIN` (public içeriği değiştirir) · `KAMPANYA`
(hak ediş üretebilir) · `YIKICI` (geri alınamaz/terminal).

---

## 3. Eşleme tablosu (121 rota)

### 3.1 `campaigns/admin-campaigns.controller.ts` — sınıf düzeyi (L49), 13 rota

| HTTP | Rota | Handler | Aksiyon | İzin | Hassasiyet |
| --- | --- | --- | --- | --- | --- |
| GET | `/admin/campaigns` | `list` (L52) | Kampanya listesi | `CAMPAIGNS_READ` | — |
| POST | `/admin/campaigns/validate` | `validate` (L58) | Tanımı yargılar, **hiçbir şey yazmaz** | `CAMPAIGNS_READ` | — (POST ama saf okuma) |
| POST | `/admin/campaigns` | `create` (L63) | Kampanya + ilk taslak sürüm | `CAMPAIGNS_WRITE` | KAMPANYA |
| GET | `/admin/campaigns/:id` | `detail` (L68) | Detay | `CAMPAIGNS_READ` | — |
| POST | `/admin/campaigns/:id/versions` | `addVersion` (L73) | Yeni değişmez sürüm (taslak) | `CAMPAIGNS_WRITE` | KAMPANYA |
| POST | `/admin/campaigns/:id/versions/:versionNumber/activate` | `activateVersion` (L83) | Sürümü **motorun değerlendireceği** sürüm yapar | `CAMPAIGNS_LIFECYCLE` | KAMPANYA, PARA |
| POST | `/admin/campaigns/:id/pause` | `pause` (L92) | ACTIVE → PAUSED | `CAMPAIGNS_LIFECYCLE` | KAMPANYA |
| POST | `/admin/campaigns/:id/resume` | `resume` (L97) | PAUSED → ACTIVE | `CAMPAIGNS_LIFECYCLE` | KAMPANYA, PARA |
| POST | `/admin/campaigns/:id/end` | `end` (L102) | **Terminal** — geri dönüşü yok | `CAMPAIGNS_LIFECYCLE` | KAMPANYA, YIKICI |
| GET | `/admin/campaigns/:id/redemptions` | `redemptions` (L109) | Hak ediş listesi | `CAMPAIGNS_READ` | — |
| GET | `/admin/campaigns/:id/evaluation-events` | `evaluationEvents` (L114) | Aday olay listesi | `CAMPAIGNS_READ` | — |
| POST | `/admin/campaigns/:id/redemptions/:redemptionId/revoke` | `revokeRedemption` (L120) | Lotu geri alır, **cüzdandan kredi çıkar** | `CAMPAIGN_REDEMPTION_REVOKE` | PARA, YIKICI |
| POST | `/admin/campaigns/:id/evaluation-events/:eventId/retry` | `retryEvaluationEvent` (L131) | Parked olayı kuyruğa koyar — **grant doğurabilir** | `CAMPAIGN_EVENT_RETRY` | KAMPANYA, PARA |

> **Neden `CAMPAIGNS_WRITE` ≠ `CAMPAIGNS_LIFECYCLE`:** taslak sürüm yazmak hiçbir hak ediş doğurmaz (motor yalnız
> `activeVersionId`'yi okur); `activate`/`resume` ise doğurur. İkisini tek izinde birleştirmek, "kampanya metnini
> düzenlesin" diye verilen yetkiyi "para dağıtmaya başlatsın"a çevirirdi.

### 3.2 `categories/categories.controller.ts` — metod düzeyi ×4

| HTTP | Rota | Handler | Aksiyon | İzin | Hassasiyet |
| --- | --- | --- | --- | --- | --- |
| POST | `/categories` | `createCategory` (L124) | Kategori oluşturur | `CATEGORIES_WRITE` | — |
| PATCH | `/categories/:id` | `updateCategory` (L131) | Ad/üst/slug/görsel düzenler | `CATEGORIES_WRITE` | — |
| PATCH | `/categories/:id/status` | `updateCategoryStatus` (L138) | DRAFT↔ACTIVE↔INACTIVE — **public görünürlük, talep kabulü ve SEO indekslenebilirliği** | `CATEGORIES_STATUS` | YAYIN |
| DELETE | `/categories/:id` | `deleteCategory` (L151) | Kategori siler | `CATEGORIES_DELETE` | YIKICI |

> `GET /categories`, `/categories/:slug`, `/categories/provider-enrollment` ve `POST /categories/routing/resolve`
> bu controller'da **SUPER_ADMIN korumalı değildir** (public okuma) — §7'de listelenir. Bu yüzden katalogda
> `CATEGORIES_READ` **yoktur**: bugün korunan bir kategori okuma rotası yok.

### 3.3 `company-settings/company-settings.controller.ts` — sınıf düzeyi (L26), 2 rota

| HTTP | Rota | Handler | Aksiyon | İzin | Hassasiyet |
| --- | --- | --- | --- | --- | --- |
| GET | `/company-settings` | `getCompanySettings` (L32) | Şirket künyesi | `COMPANY_SETTINGS_READ` | — |
| PUT | `/company-settings` | `saveCompanySettings` (L37) | Her e-posta altbilgisindeki yasal ad/adres | `COMPANY_SETTINGS_WRITE` | AYAR, YAYIN |

### 3.4 `contact-sharing/contact-sharing.controller.ts` — metod düzeyi ×1

| HTTP | Rota | Handler | Aksiyon | İzin | Hassasiyet |
| --- | --- | --- | --- | --- | --- |
| GET | `/service-requests/:requestId/contact-reveal` | `getContactRevealForAdmin` (L57) | Kimin kimin iletişimini gördüğü | `CONTACT_REVEAL_READ` | **PII** |

> Talep okuma iznine (`REQUESTS_READ`) **katılmaz**: talep listesini görmek ile iki tarafın iletişim
> paylaşımı kaydını görmek farklı veri sınıflarıdır.

### 3.5 `credits/credits.controller.ts` — metod düzeyi ×8

| HTTP | Rota | Handler | Aksiyon | İzin | Hassasiyet |
| --- | --- | --- | --- | --- | --- |
| GET | `/admin/offer-packages` | `listAdminPackages` (L47) | Katalog listesi | `CREDIT_PACKAGES_READ` | — |
| GET | `/admin/offer-packages/unlimited-eligible-categories` | `listUnlimitedEligibleCategories` (L60) | Kapsam adayları | `CREDIT_PACKAGES_READ` | — |
| GET | `/admin/offer-packages/:id` | `getAdminPackage` (L67) | Paket detayı | `CREDIT_PACKAGES_READ` | — |
| POST | `/credit-packages` | `createCreditPackage` (L74) | **Fiyat/kredi tanımlar** | `CREDIT_PACKAGES_WRITE` | PARA |
| PATCH | `/credit-packages/:id` | `updateCreditPackage` (L81) | **Fiyat/kredi değiştirir** | `CREDIT_PACKAGES_WRITE` | PARA |
| PATCH | `/credit-packages/:id/status` | `updateCreditPackageStatus` (L88) | Paketi satın alınabilir yapar/kapatır | `CREDIT_PACKAGES_STATUS` | PARA, YAYIN |
| POST | `/providers/:providerId/credits/grant` | `grantCredits` (L130) | **Bakiyeye kredi ekler** | `CREDITS_GRANT` | PARA |
| POST | `/providers/:providerId/credits/deduct` | `deductCredits` (L141) | **Bakiyeden kredi düşer** | `CREDITS_DEDUCT` | PARA, YIKICI |

> **Neden `CREDITS_GRANT` ≠ `CREDITS_DEDUCT`:** tek bir "kredi düzenle" izni, hata telafisi için verilen yetkiyi
> keyfî bakiye silmeye çevirir. Yön ayrımı bu tablonun 7. kuralıdır.

### 3.6 `customers/customers.controller.ts` — metod düzeyi ×6

| HTTP | Rota | Handler | Aksiyon | İzin | Hassasiyet |
| --- | --- | --- | --- | --- | --- |
| GET | `/customers` | `list` (L21) | Müşteri listesi | `CUSTOMERS_READ` | PII |
| GET | `/customers/:id` | `detail` (L28) | Müşteri detayı | `CUSTOMERS_READ` | PII |
| GET | `/customers/:id/notes` | `listNotes` (L35) | **Kişi hakkındaki iç notlar** | `CUSTOMER_NOTES_READ` | PII |
| POST | `/customers/:id/notes` | `createNote` (L42) | İç not yazar | `CUSTOMER_NOTES_WRITE` | PII |
| PATCH | `/customers/:id/status` | `updateStatus` (L53) | Hesabı devre dışı bırakır | `CUSTOMERS_STATUS` | YIKICI |
| POST | `/customers/:id/activation-link` | `createActivationLink` (L60) | **Oturum açtıran bağlantı mintler** | `CUSTOMER_ACTIVATION_LINK_ISSUE` | **KİMLİK** |

> Aktivasyon bağlantısı, taşıyanı o müşteri hesabına sokar. Müşteri okuma/düzenleme izniyle birleştirilmesi,
> destek masasına hesap ele geçirme yeteneği vermek olurdu.

### 3.7 `dashboard/dashboard.controller.ts` — metod düzeyi ×1

| HTTP | Rota | Handler | Aksiyon | İzin | Hassasiyet |
| --- | --- | --- | --- | --- | --- |
| GET | `/dashboard/admin-summary` | `adminSummary` (L12) | Panel özet metrikleri | `DASHBOARD_READ` | — |

### 3.8 `finance/finance.controller.ts` — metod düzeyi ×4

| HTTP | Rota | Handler | Aksiyon | İzin | Hassasiyet |
| --- | --- | --- | --- | --- | --- |
| GET | `/finance/summary` | `summary` (L15) | Toplam figürler | `FINANCE_READ` | — |
| GET | `/finance/analytics` | `analytics` (L22) | Zaman serisi | `FINANCE_READ` | — |
| GET | `/finance/credit-ledger` | `creditLedger` (L29) | **Sağlayıcı bazında satır satır hareket** | `FINANCE_LEDGER_READ` | PARA, PII |
| GET | `/finance/providers` | `providerFinance` (L36) | Sağlayıcı bazında toplam | `FINANCE_READ` | — |

### 3.9 `notification-logs/notification-log.controller.ts` — sınıf düzeyi (L28), 3 rota

| HTTP | Rota | Handler | Aksiyon | İzin | Hassasiyet |
| --- | --- | --- | --- | --- | --- |
| GET | `/notification-logs` | `listNotificationLogs` (L34) | **Alıcı adresleri** | `NOTIFICATION_LOGS_READ` | PII |
| GET | `/notification-logs/:id` | `getNotificationLog` (L39) | Tek kayıt | `NOTIFICATION_LOGS_READ` | PII |
| POST | `/notification-logs/:id/retry` | `retryNotification` (L52) | **Gerçek kişiye tekrar mesaj gönderir** | `NOTIFICATION_RETRY` | PII, YAYIN |

### 3.10 `offers/offers.controller.ts` — metod düzeyi ×6

| HTTP | Rota | Handler | Aksiyon | İzin | Hassasiyet |
| --- | --- | --- | --- | --- | --- |
| GET | `/offers` | `listOffers` (L33) | Teklif listesi | `OFFERS_READ` | — |
| GET | `/offers/refund-scan` | `refundScan` (L50) | **Toplu iadenin kuru provası** | `OFFER_REFUND_SCAN_READ` | PARA (önizleme) |
| POST | `/offers/refund-scan/execute` | `executeRefundScan` (L57) | **Toplu kredi iadesi uygular** | `OFFER_REFUND_EXECUTE` | PARA, YIKICI |
| GET | `/offers/:id` | `getOffer` (L64) | Teklif detayı | `OFFERS_READ` | — |
| PATCH | `/offers/:id/status` | `updateOfferStatus` (L79) | Teklif durumunu değiştirir | `OFFERS_STATUS` | — |
| POST | `/offers/:id/refund-credit` | `refundOfferCredit` (L100) | **Tek teklifin kredisini elle iade eder** | `OFFER_REFUND_MANUAL` | PARA |

> **Neden toplu ile tekil ayrı:** `refund-scan/execute` tek istekte çok sayıda cüzdana yazar; `refund-credit`
> tek teklife. Aynı izinde birleştirmek, "şu tek hatayı düzelt" yetkisini toplu çalıştırma yetkisine çevirir.
> Kuru prova (`GET refund-scan`) `OFFERS_READ` ile değil `OFFER_REFUND_SCAN_READ` ile korunur: o liste toplu para
> aksiyonunun girdisidir, teklif listesi değil.

### 3.11 `operations-settings/operations-settings.controller.ts` — sınıf düzeyi (L28), 2 rota

| HTTP | Rota | Handler | Aksiyon | İzin | Hassasiyet |
| --- | --- | --- | --- | --- | --- |
| GET | `/operations-settings` | `getOperationsSettings` (L34) | Ayarlar + değişim geçmişi | `OPERATIONS_SETTINGS_READ` | — |
| PUT | `/operations-settings` | `saveOperationsSettings` (L39) | **İade penceresi saati** (ticari şart) | `OPERATIONS_SETTINGS_WRITE` | AYAR, PARA |

### 3.12 `operations-settings/scheduler-settings.controller.ts` — sınıf düzeyi (L39), 2 rota

| HTTP | Rota | Handler | Aksiyon | İzin | Hassasiyet |
| --- | --- | --- | --- | --- | --- |
| GET | `/operations-settings/schedulers` | `list` (L45) | Altı job anahtarı | `OPERATIONS_SETTINGS_READ` | — |
| PUT | `/operations-settings/schedulers/:job` | `setEnabled` (L50) | **Kredi iadesi/yenileme job'larını açar** | `SCHEDULERS_WRITE` | AYAR, PARA |

### 3.13 `operations-settings/marketplace-publish-settings.controller.ts` — sınıf düzeyi (L13), 2 rota

| HTTP | Rota | Handler | Aksiyon | İzin | Hassasiyet |
| --- | --- | --- | --- | --- | --- |
| GET | `/operations-settings/marketplace-publish` | `get` (L19) | Anahtar durumu | `OPERATIONS_SETTINGS_READ` | — |
| PUT | `/operations-settings/marketplace-publish` | `set` (L24) | **Talepleri operatör onayı olmadan yayımlar** | `MARKETPLACE_PUBLISH_WRITE` | AYAR, YAYIN |

### 3.14 `operations-settings/provider-review-settings.controller.ts` — sınıf düzeyi (L13), 2 rota

| HTTP | Rota | Handler | Aksiyon | İzin | Hassasiyet |
| --- | --- | --- | --- | --- | --- |
| GET | `/operations-settings/provider-reviews` | `get` (L19) | Anahtar durumu | `OPERATIONS_SETTINGS_READ` | — |
| PUT | `/operations-settings/provider-reviews` | `set` (L24) | **Public değerlendirmeleri açar/kapatır** | `PROVIDER_REVIEWS_SETTING_WRITE` | AYAR, YAYIN |

### 3.15 `operations-settings/campaign-engine-settings.controller.ts` — sınıf düzeyi (L17), 2 rota

| HTTP | Rota | Handler | Aksiyon | İzin | Hassasiyet |
| --- | --- | --- | --- | --- | --- |
| GET | `/operations-settings/campaign-engine` | `get` (L23) | Motor anahtarı durumu | `OPERATIONS_SETTINGS_READ` | — |
| PUT | `/operations-settings/campaign-engine` | `set` (L28) | **Kampanya motorunu açar** — para dağıtan tek anahtar | `CAMPAIGN_ENGINE_TOGGLE` | AYAR, PARA, KAMPANYA |

> **Bu, kataloğun en kritik tek değeridir.** `OPERATIONS_SETTINGS_WRITE` içine katılmaz: diğer dört ayar yazma
> izni birer operasyon tercihidir, bu ise promosyon kredisi dağıtımını başlatır.

### 3.16 `package-purchases/package-purchases.controller.ts` — metod düzeyi ×3

| HTTP | Rota | Handler | Aksiyon | İzin | Hassasiyet |
| --- | --- | --- | --- | --- | --- |
| GET | `/package-purchases` | `listAdminPurchases` (L47) | Satın alma listesi | `PACKAGE_PURCHASES_READ` | PARA (okuma) |
| GET | `/package-purchases/:id` | `getAdminPurchase` (L58) | Satın alma detayı | `PACKAGE_PURCHASES_READ` | PARA (okuma) |
| PATCH | `/package-purchases/:id/status` | `updateAdminPurchaseStatus` (L65) | **Ödeme durumunu elle değiştirir** | `PACKAGE_PURCHASE_STATUS_WRITE` | PARA, YIKICI |

> CMP-006 PR-B (2026-09-23) iade talebi rotalarını bu controller'a değil, ayrı bir controller'a ekledi — bkz.
> §14. İzinler `PACKAGE_REFUND_READ` / `PACKAGE_REFUND_REQUEST_CREATE` / `PACKAGE_REFUND_APPROVE`.

### 3.17 `payments/payments.controller.ts` — metod düzeyi ×1

| HTTP | Rota | Handler | Aksiyon | İzin | Hassasiyet |
| --- | --- | --- | --- | --- | --- |
| GET | `/payments/config` | `readAdminPaymentConfig` (L27) | Eksik ayarların **adları** (değer yok) | `PAYMENTS_CONFIG_READ` | AYAR (okuma) |

### 3.18 `provider-invites/category-provider-invites.controller.ts` — sınıf düzeyi (L35), 3 rota

| HTTP | Rota | Handler | Aksiyon | İzin | Hassasiyet |
| --- | --- | --- | --- | --- | --- |
| GET | `/categories/:categoryId/provider-invites` | `list` (L41) | Davet listesi | `PROVIDER_INVITES_READ` | PII |
| POST | `/categories/:categoryId/provider-invites` | `issue` (L51) | **Sağlayıcı hesabı açtıran token mintler** | `PROVIDER_INVITES_ISSUE` | **KİMLİK** |
| POST | `/categories/:categoryId/provider-invites/:inviteId/revoke` | `revoke` (L63) | Daveti iptal eder | `PROVIDER_INVITES_REVOKE` | — |

### 3.19 `provider-reviews/admin-provider-reviews.controller.ts` — sınıf düzeyi (L23), 4 rota

| HTTP | Rota | Handler | Aksiyon | İzin | Hassasiyet |
| --- | --- | --- | --- | --- | --- |
| GET | `/provider-reviews/reports` | `listReports` (L29) | Bildirim kuyruğu | `PROVIDER_REVIEWS_READ` | PII |
| GET | `/provider-reviews/:reviewId` | `get` (L43) | Değerlendirme detayı | `PROVIDER_REVIEWS_READ` | PII |
| POST | `/provider-reviews/:reviewId/moderate` | `moderate` (L48) | **Public yorumu gizler/siler** | `PROVIDER_REVIEWS_MODERATE` | YAYIN, YIKICI |
| POST | `/provider-reviews/:reviewId/reports/dismiss` | `dismiss` (L57) | Bildirimi kapatır | `PROVIDER_REVIEWS_MODERATE` | — |

> `dismiss` ile `moderate` aynı izindedir: ikisi de **aynı bildirimin** kararıdır ve ayrı izin, "kuyruğu
> kapatabilir ama karar veremez" gibi çalışmayan bir rol üretirdi. Yıkıcı olan (`moderate`) daha geniş olanı
> belirler.

### 3.20 `providers/providers.controller.ts` — metod düzeyi ×7

| HTTP | Rota | Handler | Aksiyon | İzin | Hassasiyet |
| --- | --- | --- | --- | --- | --- |
| GET | `/providers` | `listProviders` (L46) | Sağlayıcı listesi | `PROVIDERS_READ` | PII |
| GET | `/providers/:providerId/admin-detail` | `getAdminProviderDetail` (L137) | **`taxType`/`taxNumber` dahil tam detay** | `PROVIDERS_READ_DETAIL` | **PII** |
| GET | `/providers/:providerId/service-categories` | `listProviderServiceCategories` (L152) | Hizmet kapsamı | `PROVIDERS_READ` | — |
| POST | `/providers/:providerId/service-categories` | `addProviderServiceCategory` (L168) | Kapsama kategori ekler | `PROVIDER_CATEGORIES_WRITE` | — |
| DELETE | `/providers/:providerId/service-categories/:categoryId` | `removeProviderServiceCategory` (L178) | Kapsamdan çıkarır | `PROVIDER_CATEGORIES_WRITE` | — |
| POST | `/providers/:providerId/claim-invitations` | `resendClaimInvitation` (L197) | **Profili sahiplendiren token mintler** | `PROVIDER_CLAIM_INVITE_ISSUE` | **KİMLİK** |
| PATCH | `/providers/:id/status` | `updateProviderStatus` (L223) | **Onay/ret/askı — `PROVIDER_APPROVED` kampanya tetikleyicisi** | `PROVIDERS_MODERATE` | KAMPANYA, YIKICI |
| PATCH | `/providers/:id` | `updateProvider` (L217) | Profil düzenleme — **72'nin dışında**, §12.3 ile eklendi | `PROVIDERS_WRITE` | PII |

> `POST` ve `DELETE` service-categories tek izindedir (kural 5): ikisi de aynı listeyi düzenler ve biri diğerinden
> daha yıkıcı değil. Buna karşılık `GET admin-detail` ayrı bir izindedir, çünkü bugün ham vergi bilgisi
> döndürüyor — CMP-006 PR-C bu alanı `PROVIDER_REGISTRATION_READ_SENSITIVE` arkasına alacak (§10).

### 3.21 `questions/questions.controller.ts` — metod düzeyi ×7

| HTTP | Rota | Handler | Aksiyon | İzin | Hassasiyet |
| --- | --- | --- | --- | --- | --- |
| GET | `/categories/:categoryId/questions` | `listQuestions` (L37) | Form alanları | `QUESTIONS_READ` | — |
| POST | `/categories/:categoryId/questions` | `createQuestion` (L44) | Alan ekler | `QUESTIONS_WRITE` | — |
| PATCH | `/questions/:id` | `updateQuestion` (L51) | Alanı düzenler | `QUESTIONS_WRITE` | — |
| PATCH | `/questions/:id/status` | `updateQuestionStatus` (L58) | Alanı sorulur/sorulmaz yapar | `QUESTIONS_WRITE` | — |
| PUT | `/questions/:id/conditions` | `replaceQuestionConditions` (L69) | Koşulları **değiştirir** | `QUESTIONS_WRITE` | — |
| PUT | `/questions/:id/router-rules` | `replaceRouterRules` (L80) | Yönlendirme kurallarını **değiştirir** | `QUESTIONS_WRITE` | — |
| DELETE | `/questions/:id` | `softDeleteQuestion` (L87) | Alanı canlı formdan kaldırır | `QUESTIONS_DELETE` | YIKICI |

> **Kategori ile asimetri kasıtlı.** `CATEGORIES_STATUS` ayrı bir izindir çünkü kategori durumu public
> görünürlüğü, talep kabulünü ve SEO indekslenebilirliğini birlikte değiştirir. Soru durumu yalnız bir form
> alanının sorulup sorulmayacağını belirler ve `QUESTIONS_WRITE` içinde kalır. Ayrım risk farkından gelir,
> isim benzerliğinden değil.

### 3.22 `request-reports/admin-request-reports.controller.ts` — sınıf düzeyi (L26), 4 rota

| HTTP | Rota | Handler | Aksiyon | İzin | Hassasiyet |
| --- | --- | --- | --- | --- | --- |
| GET | `/service-requests/reports` | `list` (L32) | Bildirim kuyruğu | `REQUEST_REPORTS_READ` | PII |
| GET | `/service-requests/:id/reports` | `listForRequest` (L46) | Talebin bildirimleri | `REQUEST_REPORTS_READ` | PII |
| POST | `/service-requests/:id/reports/resolve` | `resolve` (L51) | Bildirimi karara bağlar | `REQUEST_REPORTS_RESOLVE` | — |
| POST | `/service-requests/:id/reopen` | `reopen` (L60) | **Talebi yeniden yayımlar → yeni kredi harcamaları** | `REQUESTS_REOPEN` | PARA |

> `reopen`, bildirim çözme iznine **katılmaz**: bir bildirimi kapatmak ile talebi sağlayıcılara yeniden açıp
> kredi harcanmasına yol açmak farklı sonuçlardır.

### 3.23 `service-requests/service-requests.controller.ts` — metod düzeyi ×4

| HTTP | Rota | Handler | Aksiyon | İzin | Hassasiyet |
| --- | --- | --- | --- | --- | --- |
| GET | `/service-requests` | `listServiceRequests` (L40) | Talep listesi | `REQUESTS_READ` | PII |
| GET | `/service-requests/:id` | `getServiceRequest` (L65) | Talep detayı | `REQUESTS_READ` | PII |
| PATCH | `/service-requests/:id/status` | `updateServiceRequestStatus` (L109) | **Yayımlar/kapatır → kredi harcamalarını tetikler** | `REQUESTS_STATUS` | PARA |
| POST | `/service-requests/:id/recalculate-quality` | `recalculateQuality` (L141) | Kalite skorunu yeniden hesaplar | `REQUESTS_QUALITY_RECALC` | — |

### 3.24 `showcase/admin-showcase-placements.controller.ts` — sınıf düzeyi (L63), 11 rota

| HTTP | Rota | Handler | Aksiyon | İzin | Hassasiyet |
| --- | --- | --- | --- | --- | --- |
| GET | `/admin/showcase/packages` | `listPackages` (L69) | Vitrin paket kataloğu | `SHOWCASE_PACKAGES_READ` | — |
| GET | `/admin/showcase/packages/:packageId` | `getPackage` (L74) | Paket detayı | `SHOWCASE_PACKAGES_READ` | — |
| POST | `/admin/showcase/packages` | `createPackage` (L79) | **Fiyat tanımlar** | `SHOWCASE_PACKAGES_WRITE` | PARA |
| PATCH | `/admin/showcase/packages/:packageId` | `updatePackage` (L85) | **Fiyat değiştirir** | `SHOWCASE_PACKAGES_WRITE` | PARA |
| GET | `/admin/showcase/placements` | `listPlacements` (L93) | Yayındaki yerleşimler | `SHOWCASE_PLACEMENTS_READ` | — |
| GET | `/admin/showcase/placements/:placementId` | `getPlacement` (L102) | Yerleşim detayı | `SHOWCASE_PLACEMENTS_READ` | — |
| POST | `/admin/showcase/placements/:placementId/suspend` | `suspendPlacement` (L115) | **Ödenmiş yayını durdurur** | `SHOWCASE_PLACEMENTS_MODERATE` | YAYIN |
| POST | `/admin/showcase/placements/:placementId/resume` | `resumePlacement` (L133) | Yayını sürdürür | `SHOWCASE_PLACEMENTS_MODERATE` | YAYIN |
| POST | `/admin/showcase/placements/:placementId/cancel` | `cancelPlacement` (L147) | **Ödenmiş süreyi kalıcı sonlandırır** | `SHOWCASE_PLACEMENT_CANCEL` | PARA, YIKICI |
| GET | `/admin/showcase/leads` | `listLeads` (L157) | **Müşteri iletişim bilgileri** | `SHOWCASE_LEADS_READ` | **PII** |
| GET | `/admin/showcase/leads/:leadId` | `getLead` (L165) | Lead detayı | `SHOWCASE_LEADS_READ` | **PII** |

> `cancel`, `suspend`/`resume` iznine katılmaz: askı geri alınabilir, iptal ödenmiş bir süreyi bitirir.

### 3.25 `showcase/admin-showcase.controller.ts` — sınıf düzeyi (L59), 9 rota

| HTTP | Rota | Handler | Aksiyon | İzin | Hassasiyet |
| --- | --- | --- | --- | --- | --- |
| GET | `/admin/showcase/price-terms-acceptances` | `listPriceTermsAcceptances` (L65) | **Sözleşme kabul defteri** | `SHOWCASE_TERMS_ACCEPTANCES_READ` | PII |
| GET | `/admin/showcase/versions` | `listVersions` (L75) | İnceleme kuyruğu | `SHOWCASE_REVIEW_READ` | — |
| GET | `/admin/showcase/versions/:versionId` | `getVersion` (L80) | Sürüm detayı | `SHOWCASE_REVIEW_READ` | — |
| POST | `/admin/showcase/versions/:versionId/approve` | `approveVersion` (L90) | **Public içeriği yayımlar** | `SHOWCASE_REVIEW_DECIDE` | YAYIN |
| POST | `/admin/showcase/versions/:versionId/reject` | `rejectVersion` (L96) | Sürümü reddeder | `SHOWCASE_REVIEW_DECIDE` | — |
| GET | `/admin/showcase/cards` | `listCards` (L106) | Tüm kartlar | `SHOWCASE_CARDS_READ` | — |
| GET | `/admin/showcase/cards/:cardId` | `getCard` (L111) | Kart detayı | `SHOWCASE_CARDS_READ` | — |
| POST | `/admin/showcase/cards/:cardId/suspend` | `suspendCard` (L128) | **Kartı yayından kaldırır** | `SHOWCASE_CARDS_MODERATE` | YAYIN |
| POST | `/admin/showcase/cards/:cardId/unsuspend` | `unsuspendCard` (L138) | Kartı geri açar | `SHOWCASE_CARDS_MODERATE` | YAYIN |

### 3.26 `support-tickets/admin-support-tickets.controller.ts` — sınıf düzeyi (L39), 4 rota

| HTTP | Rota | Handler | Aksiyon | İzin | Hassasiyet |
| --- | --- | --- | --- | --- | --- |
| GET | `/admin/support/tickets` | `listTickets` (L45) | Destek kuyruğu | `SUPPORT_READ` | PII |
| GET | `/admin/support/tickets/:ticketId` | `getTicket` (L50) | Talep + mesajlar | `SUPPORT_READ` | PII |
| POST | `/admin/support/tickets/:ticketId/messages` | `addMessage` (L55) | **Gerçek kişiye mesaj gider** | `SUPPORT_WRITE` | PII |
| POST | `/admin/support/tickets/:ticketId/status` | `changeStatus` (L71) | Durum değiştirir (CLOSED terminal) | `SUPPORT_WRITE` | — |

> Mesaj ve durum tek `SUPPORT_WRITE` iznindedir: ikisi de aynı masanın olağan işi ve hiçbiri para, kimlik ya da
> public yayın yüzeyine dokunmuyor. Kural 4 burada tetiklenmez — yıkıcı bir aksiyon yok.
> CMP-006 PR-B bu controller'a iade talebi bağını ekleyecek; o rotalar bugün yok (§10).

### 3.27 `uploads/uploads.controller.ts` — metod düzeyi ×1

| HTTP | Rota | Handler | Aksiyon | İzin | Hassasiyet |
| --- | --- | --- | --- | --- | --- |
| POST | `/admin/uploads/category-image` | `uploadCategoryImage` (L69) | **Diske dosya yazar, public servis edilir** | `UPLOADS_WRITE` | YAYIN |

### 3.28 `users/users.controller.ts` — metod düzeyi ×5

| HTTP | Rota | Handler | Aksiyon | İzin | Hassasiyet |
| --- | --- | --- | --- | --- | --- |
| GET | `/users` | `list` (L26) | Admin hesapları | `ADMIN_USERS_READ` | PII |
| POST | `/users` | `create` (L33) | Personel hesabı oluşturur (§12.1 sonrası **`ADMIN`** rolünde) | **KÖK — `@Roles(SUPER_ADMIN)`** | **KİMLİK**, YIKICI |
| GET | `/users/:id` | `detail` (L40) | Admin detayı | `ADMIN_USERS_READ` | PII |
| PATCH | `/users/:id/status` | `updateStatus` (L47) | Admin hesabını kapatır | `ADMIN_USERS_STATUS` | YIKICI |
| POST | `/users/:id/invite-link` | `createInviteLink` (L58) | **Admin davet token'ı mintler** | **KÖK — `@Roles(SUPER_ADMIN)`** | **KİMLİK**, YIKICI |

> **§12.1 kararı:** bu iki rota ile `/admin/roles*` rotaları **kök yetkidir** — `AdminPermission` enum'unda
> karşılıkları yoktur, dolayısıyla hiçbir rol satırı onları devralamaz. `@Roles(UserRole.SUPER_ADMIN)` ile
> korunmaya devam ederler. `ADMIN_USERS_READ` ve `ADMIN_USERS_STATUS` devredilebilir kalır.

---

## 4. İzin kataloğu — 77 aday değer (§12.1 sonrası **76 dinamik**)

> **§12 kararlarından sonra okuyun.** `ADMIN_USERS_CREATE` ve `ADMIN_INVITE_ISSUE` bu tablodan çıkarıldı ve
> `@Roles(UserRole.SUPER_ADMIN)` ile korunan **kök yetki** oldular (§12.1); `PROVIDERS_WRITE` eklendi (§12.3).
> Dinamik `AdminPermission` enum'u bu yüzden **76** değer taşır.

`AdminPermission` Prisma enum'unun tamamı. Panelden üretilemez (D11); `SUPER_ADMIN` hepsine örtük sahiptir (D12).

| Alan | İzinler |
| --- | --- |
| Panel | `DASHBOARD_READ` |
| Kampanya | `CAMPAIGNS_READ` · `CAMPAIGNS_WRITE` · `CAMPAIGNS_LIFECYCLE` · `CAMPAIGN_REDEMPTION_REVOKE` · `CAMPAIGN_EVENT_RETRY` |
| Kampanya motoru | `CAMPAIGN_ENGINE_TOGGLE` |
| Kategori | `CATEGORIES_WRITE` · `CATEGORIES_STATUS` · `CATEGORIES_DELETE` |
| Soru / form | `QUESTIONS_READ` · `QUESTIONS_WRITE` · `QUESTIONS_DELETE` |
| Şirket ayarı | `COMPANY_SETTINGS_READ` · `COMPANY_SETTINGS_WRITE` |
| Operasyon ayarı | `OPERATIONS_SETTINGS_READ` · `OPERATIONS_SETTINGS_WRITE` · `SCHEDULERS_WRITE` · `MARKETPLACE_PUBLISH_WRITE` · `PROVIDER_REVIEWS_SETTING_WRITE` |
| Kredi paketi | `CREDIT_PACKAGES_READ` · `CREDIT_PACKAGES_WRITE` · `CREDIT_PACKAGES_STATUS` |
| Kredi bakiyesi | `CREDITS_GRANT` · `CREDITS_DEDUCT` |
| Finans | `FINANCE_READ` · `FINANCE_LEDGER_READ` |
| Paket satın alma | `PACKAGE_PURCHASES_READ` · `PACKAGE_PURCHASE_STATUS_WRITE` |
| Ödeme yapılandırması | `PAYMENTS_CONFIG_READ` |
| Teklif | `OFFERS_READ` · `OFFERS_STATUS` · `OFFER_REFUND_SCAN_READ` · `OFFER_REFUND_EXECUTE` · `OFFER_REFUND_MANUAL` |
| Talep | `REQUESTS_READ` · `REQUESTS_STATUS` · `REQUESTS_QUALITY_RECALC` · `REQUESTS_REOPEN` · `REQUEST_REPORTS_READ` · `REQUEST_REPORTS_RESOLVE` |
| İletişim paylaşımı | `CONTACT_REVEAL_READ` |
| Hizmet alan | `CUSTOMERS_READ` · `CUSTOMERS_STATUS` · `CUSTOMER_NOTES_READ` · `CUSTOMER_NOTES_WRITE` · `CUSTOMER_ACTIVATION_LINK_ISSUE` |
| Hizmet veren | `PROVIDERS_READ` · `PROVIDERS_READ_DETAIL` · `PROVIDERS_MODERATE` · `PROVIDER_CATEGORIES_WRITE` · `PROVIDER_CLAIM_INVITE_ISSUE` |
| Sağlayıcı daveti | `PROVIDER_INVITES_READ` · `PROVIDER_INVITES_ISSUE` · `PROVIDER_INVITES_REVOKE` |
| Değerlendirme | `PROVIDER_REVIEWS_READ` · `PROVIDER_REVIEWS_MODERATE` |
| Vitrin | `SHOWCASE_PACKAGES_READ` · `SHOWCASE_PACKAGES_WRITE` · `SHOWCASE_PLACEMENTS_READ` · `SHOWCASE_PLACEMENTS_MODERATE` · `SHOWCASE_PLACEMENT_CANCEL` · `SHOWCASE_LEADS_READ` · `SHOWCASE_TERMS_ACCEPTANCES_READ` · `SHOWCASE_REVIEW_READ` · `SHOWCASE_REVIEW_DECIDE` · `SHOWCASE_CARDS_READ` · `SHOWCASE_CARDS_MODERATE` |
| Destek | `SUPPORT_READ` · `SUPPORT_WRITE` |
| Bildirim | `NOTIFICATION_LOGS_READ` · `NOTIFICATION_RETRY` |
| Yükleme | `UPLOADS_WRITE` |
| Admin hesapları | `ADMIN_USERS_READ` · `ADMIN_USERS_STATUS` · ~~`ADMIN_USERS_CREATE`~~ · ~~`ADMIN_INVITE_ISSUE`~~ (§12.1: kök yetki, enum'da yok) |
| Hizmet veren (ek) | `PROVIDERS_WRITE` (§12.3 — `PATCH /providers/:id`) |

**`ADMIN_ROLES_MANAGE` kataloğa hiç girmez** (§12.1): rol/izin yönetim rotaları `@Roles(UserRole.SUPER_ADMIN)`
ile korunur. Panel erişimi bir izin değil, `AdminAccessGuard`'ın kendi kuralıdır (D12).

**Ayrıca beş izin CMP-006 tasarımında adı geçtiği hâlde burada yoktur**, çünkü karşılık gelen rota henüz
yazılmadı: `PACKAGE_REFUND_REQUEST_CREATE`, `PACKAGE_REFUND_APPROVE`, `PURCHASE_EVIDENCE_READ`,
`PROVIDER_REGISTRATION_READ_SENSITIVE`, `PROMOTION_ELIGIBILITY_REVIEW` (§10.3).

---

## 5. Karma rollü rotalar — 27 rota (72'nin dışında)

`@Roles(...)` içinde `SUPER_ADMIN` **başka bir rolle birlikte** geçen 9 dekoratör. Bunlar 72'nin içinde
**değildir** (grep tam eşleşme arıyordu) ama PR-0'ın kararı gereken yüzeylerdir.

| Dosya | Dekoratör | Roller | Kapsadığı rota |
| --- | --- | --- | --- |
| `phone-verification/phone-verification.controller.ts` | L32, L43 (metod) | CUSTOMER + SA | `POST /service-requests/:requestId/phone-verification`, `POST .../verify` |
| `service-requests/service-requests.controller.ts` | L129, L136 (metod) | CUSTOMER + SA | `POST /service-requests/:id/complete`, `POST /service-requests/:id/cancel` |
| `provider-reviews/customer-provider-reviews.controller.ts` | L31 (metod) | CUSTOMER + SA | `GET /service-requests/:id/review` |
| `showcase/showcase-fallback.controller.ts` | L58 (metod) | CUSTOMER + SA | `POST /service-requests/:id/showcase-fallback` |
| `showcase/provider-showcase-placements.controller.ts` | L48 (**sınıf**) | PROVIDER + SA | `providers/:providerId/showcase` altındaki **9** rota |
| `showcase/showcase-uploads.controller.ts` | L48 (**sınıf**) | PROVIDER + SA | `POST /providers/:providerId/showcase/uploads/card-image` |
| `showcase/provider-showcase-cards.controller.ts` | L47 (**sınıf**) | PROVIDER + SA | `providers/:providerId/showcase/cards` altındaki **11** rota |

**Toplam:** 2 + 2 + 1 + 1 + 9 + 1 + 11 = **27 rota**.

**PR-0 kararı (öneri).** Bunlar **rol rotalarıdır, admin rotaları değildir**: birincil kullanıcı müşteri ya da
sağlayıcıdır; `SUPER_ADMIN` yalnız "operatör sahibinin ekranını görebilsin/onun adına işlem yapabilsin" diye
eklenmiş. PR-0'da:

1. `@Roles(UserRole.CUSTOMER, UserRole.PROVIDER, ...)` kısmı **aynen kalır** — `RolesGuard` silinmez (tasarım §6.2).
2. `UserRole.SUPER_ADMIN` kısmı **aynen kalır**, çünkü `SUPER_ADMIN` örtük tam yetkilidir.
3. `ADMIN` hesabı bu rotalara **erişemez** ve bu **kasıtlıdır**: bir operasyon personelinin bir müşterinin adına
   talep kapatması ya da bir sağlayıcının kartını düzenlemesi, izin kataloğunun vereceği bir yetenek değil, ayrı
   bir ürün kararıdır. İhtiyaç doğarsa kendi izniyle (`ACT_AS_PROVIDER` gibi) ve kendi tasarım notuyla gelir.

**Bu 27 rota PR-0'da değiştirilmez.** Karar, "dokunmama" kararıdır ve burada yazılıdır ki sessiz bir boşluk
sayılmasın.

---

## 6. `ProviderAccessGuard` kaçağı — 21 rota · **RBAC kapsamı dışında · admin impersonation yok**

> **§12.2 kararı (bağlayıcı).** Aşağıdaki 21 rotanın tamamı PR-0'da **hiçbir `ADMIN` rolüne açılmaz** ve
> guard'a `ADMIN` **eklenmez**. Sınıflandırmaları: *RBAC kapsamı dışında · admin impersonation yok*.
> Her biri için, tüm izinleri atanmış bir `ADMIN` hesabının **403** aldığı test edilir (I-7).

`apps/api/src/modules/auth/provider-access.guard.ts:20`:

```ts
if (user.role === UserRole.SUPER_ADMIN) {
  return true;
}
```

Bu kısa devre yüzünden, **hiçbir `@Roles` dekoratörü taşımayan** 21 rota bugün `SUPER_ADMIN` tarafından
erişilebilir durumdadır. Hiçbiri 72'nin içinde değildir ve hiçbiri §3 tablosunda görünmez.

| HTTP | Rota | Dosya:satır | Aksiyon | Risk |
| --- | --- | --- | --- | --- |
| GET | `/providers/:providerId/offers/:offerId/matched-contact` | `contact-sharing.controller.ts:47` | Müşteri iletişimi | **PII** |
| GET | `/providers/:providerId/credits` | `credits.controller.ts:111` | Bakiye | PARA (okuma) |
| GET | `/providers/:providerId/credits/transactions` | `credits.controller.ts:119` | Kredi geçmişi | PARA (okuma) |
| GET | `/providers/:providerId/entitlements` | `entitlements.controller.ts:37` | Abonelik dönemleri | — |
| GET | `/providers/:providerId/offer-packages` | `entitlements.controller.ts:49` | Satın alınabilir paketler | — |
| PATCH | `/providers/:providerId/entitlements/:entitlementId/auto-renew` | `entitlements.controller.ts:55` | **Otomatik yenilemeyi açar/kapatır** | PARA |
| POST | `/providers/:providerId/entitlements/:entitlementId/cancel` | `entitlements.controller.ts:71` | **Aboneliği iptal eder** | PARA, YIKICI |
| POST | `/providers/:providerId/package-purchases` | `package-purchases.controller.ts:19` | Satın alma satırı açar | PARA |
| GET | `/providers/:providerId/package-purchases` | `package-purchases.controller.ts:25` | Satın alma listesi | PARA (okuma) |
| GET | `/providers/:providerId/package-purchases/:purchaseId` | `package-purchases.controller.ts:31` | Satın alma detayı | PARA (okuma) |
| POST | `/providers/:providerId/package-purchases/:purchaseId/mock-pay` | `package-purchases.controller.ts:37` | **Ödemeyi settle eder → kredi yükler → `PACKAGE_PAYMENT_SUCCEEDED` kampanya tetikleyicisi** | **PARA, KAMPANYA** |
| POST | `/providers/:providerId/checkout-sessions` | `payments.controller.ts:42` | Checkout açar | PARA — *servis ayrıca `role !== PROVIDER` ise 403 verir* (`payments.service.ts:90`) |
| GET | `/providers/:providerId/reviews` | `provider-panel-reviews.controller.ts:28` | Sağlayıcının değerlendirmeleri | PII |
| GET | `/providers/:providerId/reviews/summary` | `provider-panel-reviews.controller.ts:37` | Özet | — |
| GET | `/providers/:providerId/requests` | `providers.controller.ts:72` | Eşleşen talepler | PII |
| GET | `/providers/:providerId/requests/:requestId` | `providers.controller.ts:93` | Talep detayı | PII |
| POST | `/providers/:providerId/requests/:requestId/offers` | `providers.controller.ts:99` | **Sağlayıcı adına teklif verir → kredi harcar** | **PARA** |
| GET | `/providers/:providerId/offers` | `providers.controller.ts:109` | Teklif listesi | — |
| GET | `/providers/:providerId/offers/:offerId` | `providers.controller.ts:115` | Teklif detayı | — |
| POST | `/providers/:providerId/offers/:offerId/withdraw` | `providers.controller.ts:128` | Teklifi geri çeker | PARA |
| POST | `/providers/:providerId/requests/:requestId/reports` | `provider-request-reports.controller.ts:12` | Talep bildirir | — |

**Neden bu PR-0'ı doğrudan ilgilendiriyor.** PR-0'dan sonra operasyon personeli `SUPER_ADMIN` değil `ADMIN`
olacak. O anda bu 21 rota **sessizce erişilemez** hâle gelir — `ProviderAccessGuard` `ADMIN`'i `PROVIDER`
olmadığı için reddeder. İki yanlış çözüm vardır ve ikisi de PR-0'da **yasaklanmalıdır**:

- ❌ Guard'a `user.role === UserRole.ADMIN` eklemek: 21 rotanın tamamını, **`mock-pay` ve "sağlayıcı adına teklif
  ver" dahil**, hiçbir izin kontrolü olmadan her operasyon personeline açar.
- ❌ Hiçbir şey yapmayıp fark etmemek: operasyon personeli bugün yaptığı bir işi yapamaz hâle gelir ve bu, PR-0
  merge edildikten sonra üretimde keşfedilir.

**Verilen karar (§12.2):** `ProviderAccessGuard`'ın `SUPER_ADMIN` kısa devresi **olduğu gibi korunur**;
`ADMIN` guard'a **eklenmez** ve bu 21 rotanın **hiçbiri** bir izne bağlanmaz. Mock ödeme, sağlayıcı adına
teklif verme, kredi harcayan yazma ve sağlayıcıya ait diğer yazma aksiyonları yalnız **sağlayıcı sahibinin ya
da `SUPER_ADMIN`'in** davranışı olarak kalır. Operasyon ihtiyacı ileride çıkarsa çözüm guard'ı gevşetmek
değil, **ayrı admin rotası + sabit izin + audit**'tir.

---

## 7. Rol dekoratörü olmayan diğer admin-ilgili yüzeyler

| HTTP | Rota | Dosya | Guard | Not |
| --- | --- | --- | --- | --- |
| GET | `/auth/admin-invite` | `users/admin-invite.controller.ts:20` | **yok** (token ile) | Davet token'ını doğrular |
| POST | `/auth/admin-invite` | `users/admin-invite.controller.ts:29` | **yok** (token ile) | **Token karşılığında `SUPER_ADMIN` hesabı oluşturur** (`admin-invite.service.ts:169`) |

Bu ikisi **kimlik doğrulamasız olmak zorundadır** — daveti kabul eden kişinin henüz hesabı yoktur — dolayısıyla
izin kataloğuna girmezler. Ama PR-0'ın güvenlik yüzeyinin parçasıdırlar: `ADMIN_INVITE_ISSUE` izni olan biri
`POST /users/:id/invite-link` ile token mintler, token'ı alan kişi buradan `SUPER_ADMIN` olur. **Bu, kataloğun
tek yetki yükseltme zinciridir** ve §10.1'de kararı verilmiştir.

`PATCH /providers/:id` (`providers.controller.ts:217`) ayrıca not edilir: yalnız `@UseGuards(AuthGuard)` taşır,
yetki kararı serviste (`providers.service.ts:2048 ensureProviderUpdateAccess`, `SUPER_ADMIN` erken döner).
**Muğlak** sayılır: guard'dan okunamayan bir admin yeteneği. PR-0'da bu rotanın admin yolu ayrı bir izne
(`PROVIDERS_WRITE`) bağlanmalı mı, yoksa servis kontrolü mü korunmalı — açık karar **K3** (§10.2).

---

## 8. Kontrol toplamı (controller başına)

| # | Controller | Dekoratör | Düzey | Rota |
| --- | --- | --- | --- | --- |
| 1 | `campaigns/admin-campaigns.controller.ts` | 1 | sınıf | 13 |
| 2 | `categories/categories.controller.ts` | 4 | metod | 4 |
| 3 | `company-settings/company-settings.controller.ts` | 1 | sınıf | 2 |
| 4 | `contact-sharing/contact-sharing.controller.ts` | 1 | metod | 1 |
| 5 | `credits/credits.controller.ts` | 8 | metod | 8 |
| 6 | `customers/customers.controller.ts` | 6 | metod | 6 |
| 7 | `dashboard/dashboard.controller.ts` | 1 | metod | 1 |
| 8 | `finance/finance.controller.ts` | 4 | metod | 4 |
| 9 | `notification-logs/notification-log.controller.ts` | 1 | sınıf | 3 |
| 10 | `offers/offers.controller.ts` | 6 | metod | 6 |
| 11 | `operations-settings/campaign-engine-settings.controller.ts` | 1 | sınıf | 2 |
| 12 | `operations-settings/marketplace-publish-settings.controller.ts` | 1 | sınıf | 2 |
| 13 | `operations-settings/operations-settings.controller.ts` | 1 | sınıf | 2 |
| 14 | `operations-settings/provider-review-settings.controller.ts` | 1 | sınıf | 2 |
| 15 | `operations-settings/scheduler-settings.controller.ts` | 1 | sınıf | 2 |
| 16 | `package-purchases/package-purchases.controller.ts` | 3 | metod | 3 |
| 17 | `payments/payments.controller.ts` | 1 | metod | 1 |
| 18 | `provider-invites/category-provider-invites.controller.ts` | 1 | sınıf | 3 |
| 19 | `provider-reviews/admin-provider-reviews.controller.ts` | 1 | sınıf | 4 |
| 20 | `providers/providers.controller.ts` | 7 | metod | 7 |
| 21 | `questions/questions.controller.ts` | 7 | metod | 7 |
| 22 | `request-reports/admin-request-reports.controller.ts` | 1 | sınıf | 4 |
| 23 | `service-requests/service-requests.controller.ts` | 4 | metod | 4 |
| 24 | `showcase/admin-showcase-placements.controller.ts` | 1 | sınıf | 11 |
| 25 | `showcase/admin-showcase.controller.ts` | 1 | sınıf | 9 |
| 26 | `support-tickets/admin-support-tickets.controller.ts` | 1 | sınıf | 4 |
| 27 | `uploads/uploads.controller.ts` | 1 | metod | 1 |
| 28 | `users/users.controller.ts` | 5 | metod | 5 |
| | **TOPLAM** | **72** | 14 sınıf + 58 metod | **121** |

**Tüm API bağlamı:** 247 rota = 121 (tam `SUPER_ADMIN`) + 27 (karma) + 21 (`ProviderAccessGuard`, `@Roles` yok)
+ 78 (müşteri/sağlayıcı/public/token/webhook).

---

## 9. Tasarım §6.3 ile farklar

§6.3, 37 izin adıyla alan düzeyinde bir özetti ve "eşlemenin alt sınırı" olarak işaretliydi. Rota düzeyinde
77 değer çıktı. Farklar ve gerekçeleri:

### 9.1 §6.3'ün eksik bıraktığı yazma yüzeyleri (düzeltilmesi zorunlu)

| # | §6.3 diyordu ki | Gerçek | Sonuç |
| --- | --- | --- | --- |
| F1 | "Teklifler \| `OFFERS_READ` \| —" (yazma yok) | Teklifler'de **4 yazma** rotası var, ikisi para: `refund-scan/execute` (toplu iade) ve `refund-credit` (tekil iade) | `OFFERS_STATUS`, `OFFER_REFUND_SCAN_READ`, `OFFER_REFUND_EXECUTE`, `OFFER_REFUND_MANUAL` eklendi |
| F2 | "Bildirim logları \| `NOTIFICATIONS_READ` \| —" | `POST /notification-logs/:id/retry` **gerçek kişiye mesaj gönderiyor** | `NOTIFICATION_RETRY` eklendi; `NOTIFICATIONS_READ` → `NOTIFICATION_LOGS_READ` |
| F3 | "Paket satın almalar \| `PACKAGE_PURCHASES_READ` \| —" | `PATCH /package-purchases/:id/status` **ödeme durumunu elle değiştiriyor** | `PACKAGE_PURCHASE_STATUS_WRITE` eklendi |
| F4 | `OPERATIONS_SETTINGS_MANAGE` tek değer, motor anahtarı da içinde | Motor anahtarı **para dağıtımını başlatan tek switch** | `CAMPAIGN_ENGINE_TOGGLE` ayrıldı; ayrıca `SCHEDULERS_WRITE`, `MARKETPLACE_PUBLISH_WRITE`, `PROVIDER_REVIEWS_SETTING_WRITE` ayrıldı |
| F5 | `CREDITS_ADJUST` tek değer | `grant` ve `deduct` ayrı rotalar | `CREDITS_GRANT` / `CREDITS_DEDUCT` |
| F6 | `ADMIN_USERS_MANAGE` tek değer | `POST /users` **`SUPER_ADMIN` yaratıyor**, `POST /users/:id/invite-link` **davet token'ı mintliyor** | `ADMIN_USERS_READ` / `_CREATE` / `_STATUS` + `ADMIN_INVITE_ISSUE` |
| F7 | `CUSTOMERS_MANAGE` tek değer | `POST /customers/:id/activation-link` **oturum açtıran bağlantı mintliyor** | `CUSTOMERS_STATUS`, `CUSTOMER_NOTES_READ/WRITE`, `CUSTOMER_ACTIVATION_LINK_ISSUE` |
| F8 | `PROVIDERS_MANAGE` tek değer | `POST /providers/:providerId/claim-invitations` **claim token'ı mintliyor** | `PROVIDER_CATEGORIES_WRITE`, `PROVIDER_CLAIM_INVITE_ISSUE`, `PROVIDERS_READ_DETAIL` |
| F9 | `CAMPAIGNS_MANAGE` tek değer | Taslak yazmak ile sürüm aktive etmek farklı risk | `CAMPAIGNS_WRITE` / `CAMPAIGNS_LIFECYCLE`; `CAMPAIGN_EVENT_RETRY` yeni (grant doğurabilir) |
| F10 | `REQUESTS_MANAGE`, `REQUEST_REPORTS_MANAGE` | `reopen` talebi yeniden yayımlıyor (kredi harcaması) | `REQUESTS_STATUS`, `REQUESTS_QUALITY_RECALC`, `REQUESTS_REOPEN`, `REQUEST_REPORTS_READ/RESOLVE` |
| F11 | Vitrin 4 değer (`SHOWCASE_READ/REVIEW/PLACEMENTS_MANAGE/PACKAGES_MANAGE`) | 20 rota; `cancel` ödenmiş süreyi bitiriyor, `leads` müşteri iletişimi taşıyor | 11 değer |
| F12 | Yok | `GET /service-requests/:requestId/contact-reveal` (PII), `GET /payments/config`, `POST /admin/uploads/category-image`, sağlayıcı davetleri, vitrin sözleşme defteri | `CONTACT_REVEAL_READ`, `PAYMENTS_CONFIG_READ`, `UPLOADS_WRITE`, `PROVIDER_INVITES_*`, `SHOWCASE_TERMS_ACCEPTANCES_READ` |

### 9.2 §6.3'ün fazladan varsaydıkları

| # | §6.3 diyordu ki | Gerçek | Sonuç |
| --- | --- | --- | --- |
| F13 | `CATEGORIES_READ` | Kategori GET rotalarının hepsi **public/korumasız** | Katalogda `CATEGORIES_READ` **yok** |
| F14 | "Kredi paketleri \| okuma: `PACKAGE_PURCHASES_READ`" | Yanlış alan eşlemesi — katalog okuma `credits.controller.ts`'te | `CREDIT_PACKAGES_READ` |
| F15 | `PROVIDER_REGISTRATION_READ_SENSITIVE`, `PACKAGE_REFUND_*`, `PURCHASE_EVIDENCE_READ`, `PROMOTION_ELIGIBILITY_REVIEW` | Bugün **hiçbiri bir rotaya karşılık gelmiyor** (PR-A/B/C ile gelecek) | 77'ye dahil değil; §10.3'te listeli |
| F16 | `ADMIN_ROLES_MANAGE` | PR-0'ın kendi yeni rotaları | 77'ye dahil değil; §10.1 |

### 9.3 §6.3'ün doğru çıktığı yerler

`DASHBOARD_READ`, `CAMPAIGNS_READ`, `FINANCE_READ`, `OPERATIONS_SETTINGS_READ`, `SUPPORT_READ`,
`PROVIDERS_READ`, `PROVIDERS_MODERATE`, `PROVIDER_REVIEWS_MODERATE`, `CUSTOMERS_READ`, `REQUESTS_READ`,
`PACKAGE_PURCHASES_READ`, `COMPANY_SETTINGS_*` adları ve anlamları korunmuştur.

**Sonuç:** §6.3 bir **alt sınır** olarak doğruydu; 12 noktada eksik, 4 noktada fazlaydı. Tasarım notunun §6.3
başındaki uyarı bu belgeyle karşılanmıştır. **Tasarım notu bu PR'da değiştirilmez** — §6.3 zaten kendisini
"alt sınır" ilan ediyor ve bu belge onun üstüdür.

---

## 10. PR-0 kodundan önce cevaplanacak açık kararlar — **§12'de cevaplandı**

> Bu bölüm kararlar verilmeden önceki hâliyle bırakılmıştır; bağlayıcı cevaplar **§12**'dedir.

### 10.1 PR-0'ın kendi rotaları (K1)

PR-0, §4'teki 77'ye ek olarak kendi yönetim rotalarını getirir ve bunlar iki yeni izin ister:

| Rota | İzin | Not |
| --- | --- | --- |
| `GET /admin/me/permissions` | — (`AdminAccessGuard` yeter) | Tek kaynak (D13) |
| `GET/POST/PATCH /admin/roles*`, `PUT /admin/roles/:id/permissions`, `GET /admin/permissions` | `ADMIN_ROLES_MANAGE` | Rol dinamik, izin katalogu sabit |
| `POST/DELETE /admin/users/:id/roles*` | `ADMIN_USERS_MANAGE`? → **`ADMIN_ROLES_MANAGE`** önerilir | Rol atamak, rol tanımlamakla aynı yetkidir |

**Öneri:** `ADMIN_ROLES_MANAGE`, `ADMIN_USERS_CREATE` ve `ADMIN_INVITE_ISSUE` üçü **hiçbir role verilmez** ve
yalnız `SUPER_ADMIN`'de kalır. Gerekçe: bu üçü birlikte yetki yükseltme zinciridir (§7) — bir rol kendisine
izin ekleyebiliyorsa izin modeli yoktur. Bu, izin kataloğunda bir kısıt değil, **operasyon kuralıdır**; PR-0'ın
testi bunu doğrular ama DB zorlamaz. *Karar gerekiyor: DB'de de zorlansın mı?*

### 10.2 `ProviderAccessGuard` (K2) ve `PATCH /providers/:id` (K3)

**K2 (§6):** 21 rotanın hangileri operasyon tarafından gerçekten kullanılıyor? Kullanılanlar açık izinle açılır,
kullanılmayanlar `ADMIN`'e kapalı kalır. Guard'a `ADMIN` eklenmesi **yasaktır**.

**K3 (§7):** `PATCH /providers/:id`'nin admin yolu `PROVIDERS_WRITE` iznine mi bağlanacak, yoksa servis
içindeki `ensureProviderUpdateAccess` kontrolü mü korunacak? Guard'dan okunamayan bir yetki, izin modelinin
"tek kaynak" iddiasını (D13) zayıflatır.

### 10.3 CMP-006 dilimlerinin ekleyeceği izinler

| İzin | Hangi PR | Hangi rota |
| --- | --- | --- |
| `PURCHASE_EVIDENCE_READ` | PR-A | `GET /admin/package-purchases/:id/terms-acceptance` |
| `PACKAGE_REFUND_REQUEST_CREATE` | PR-B | `POST /admin/package-refund-requests/:id/take` |
| `PACKAGE_REFUND_APPROVE` | PR-B | `.../approve`, `/reject`, `/abandon` |
| `PROVIDER_REGISTRATION_READ_SENSITIVE` | PR-C | `GET /admin/providers/:id/business-registration/raw` |
| `PROMOTION_ELIGIBILITY_REVIEW` | PR-C | `POST /admin/campaigns/events/:id/eligibility-decision` |

Bunlar PR-0'ın enum'una **şimdiden eklenmez**: karşılık gelen rota olmadan bir izin, panelde işaretlenebilen ama
hiçbir şey açmayan bir kutudur (D11'in kaçınmak istediği durum).

---

## 11. PR-0'ın testine girdi

`T12c` (tasarım §11.1): her admin rotası için beklenen izin **bu belgenin §3 tablosundan** okunur. Tablo, testin
girdisi olan makine-okunabilir bir listeye (`apps/api/test/route-permission-map.ts` gibi) çevrilir; NestJS rota
kayıtları taranır ve:

1. `AdminAccessGuard` taşıyan her rota tabloda **olmalıdır** (eşlemesi olmayan admin rotası testi kırar),
2. tablodaki her satır gerçek bir rotaya **karşılık gelmelidir** (ölü eşleme testi kırar),
3. her rotanın `@RequiresPermission` metadata'sı tablodaki değere **eşit olmalıdır**.

Böylece bu belge bir kerelik envanter değil, kodun yanında yaşayan bir sözleşme olur.

---

## 12. RG-7 kararları (bağlayıcı — 2026-09-22)

§10'daki açık kararlar cevaplandı. Aşağıdakiler PR-0'ın bağlayıcı girdisidir ve §3/§4/§6/§7'yi **değiştirir**.

### 12.1 K1 — kök yetkiler devredilemez

Üç yetki **dinamik `AdminPermission` kataloğunda yer almaz**:

| Yetki | Neden kök | PR-0'da nasıl korunur |
| --- | --- | --- |
| `ADMIN_ROLES_MANAGE` | Rol tanımlayıp izin bağlayabilen, kendi yetkisini genişletebilir | Enum'a **girmez**; rotalar `@Roles(UserRole.SUPER_ADMIN)` ile kalır |
| `ADMIN_USERS_CREATE` | Personel hesabı doğurur | Enum'a **girmez**; `POST /users` `@Roles(UserRole.SUPER_ADMIN)` |
| `ADMIN_INVITE_ISSUE` | Hesabı etkinleştiren token mintler | Enum'a **girmez**; `POST /users/:id/invite-link` `@Roles(UserRole.SUPER_ADMIN)` |

**DB düzeyinde garanti:** bu üç ad `AdminPermission` enum'unun **değeri değildir**, dolayısıyla
`AdminRolePermission` satırı olarak temsil edilemez. Hiçbir rol, hiçbir grant, hiçbir migration bunları
devralamaz — kısıt bir uygulama kuralı değil, tip sisteminin ve enum'un kendisidir.

**Bunun sonucu katalog büyüklüğü:** §4'teki 77 değerden `ADMIN_USERS_CREATE` ve `ADMIN_INVITE_ISSUE`
çıkarılır (`ADMIN_ROLES_MANAGE` zaten 77'nin içinde değildi), §12.3 ile `PROVIDERS_WRITE` eklenir →
**dinamik katalog = 76 değer**. `ADMIN_USERS_READ` ve `ADMIN_USERS_STATUS` **devredilebilir kalır**: admin
listesini okumak ve bir hesabı pasife almak yetki yükseltmez.

#### Davet zincirinin bugünkü hâli ve değişimi

Bugün (`users.service.ts:79`, `admin-invite.service.ts:93,169,227`):

```
POST /users            → User{ role: SUPER_ADMIN, passwordHash: null }      ← hesap burada SUPER_ADMIN doğuyor
POST /users/:id/invite-link → AdminInviteToken (yalnız role=SUPER_ADMIN, passwordHash=null olan hesaba)
POST /auth/admin-invite     → o hesabın passwordHash'ini doldurur           ← davet yalnız etkinleştiriyor
```

Yani davet kabulü hesabı `SUPER_ADMIN` **yapmıyor**; hesap `POST /users` anında zaten `SUPER_ADMIN`
doğuyor. PR-0'da:

```
POST /users            → User{ role: ADMIN, passwordHash: null }            ← artık ADMIN
POST /users/:id/invite-link → AdminInviteToken (role=ADMIN, passwordHash=null)
POST /auth/admin-invite     → passwordHash doldurur; rol DEĞİŞMEZ (ADMIN kalır)
```

**`SUPER_ADMIN` panelden ya da dinamik rolden oluşturulamaz ve hiçbir hesap `SUPER_ADMIN`'e terfi
ettirilemez.** `SUPER_ADMIN` yalnız kontrollü bootstrap ile doğar (seed / operatör eliyle çalıştırılan
kurulum adımı); PR-0 bu bootstrap'i olduğu gibi bırakır ve ona yeni bir HTTP yüzeyi eklemez.

`admin-invite.service.ts`'in üç yerdeki `role !== UserRole.SUPER_ADMIN` kontrolü `role !== UserRole.ADMIN`
olur; `users.service.ts`'in `where: { role: SUPER_ADMIN }` filtreleri **her iki personel rolünü** kapsar
(`role: { in: [SUPER_ADMIN, ADMIN] }`) ki mevcut `SUPER_ADMIN` hesapları listede kaybolmasın.

#### Bu zincir için zorunlu invariant testleri

| # | Test | Katman |
| --- | --- | --- |
| I-1 | `AdminPermission` enum'unun değerleri arasında `ADMIN_ROLES_MANAGE`, `ADMIN_USERS_CREATE`, `ADMIN_INVITE_ISSUE` **yoktur** (enum değerleri üzerinde doğrudan assertion) | DB-katalog |
| I-2 | `AdminRolePermission` tablosuna bu üç adı yazmak **tip düzeyinde imkânsız**; ham SQL ile denendiğinde PostgreSQL enum hatası verir | DB |
| I-3 | `POST /users` `ADMIN` rolünde hesap üretir; hiçbir gövde alanı `SUPER_ADMIN` ürettiremez | API |
| I-4 | `POST /auth/admin-invite` başarıyla tamamlandıktan sonra hesabın rolü hâlâ `ADMIN`'dir | API |
| I-5 | Hiçbir rota bir hesabın `role`'ünü `SUPER_ADMIN`'e yazamaz (tüm rotalar taranır; `role: 'SUPER_ADMIN'` yazan servis yolu yalnız bootstrap'tir) | API |
| I-6 | Tüm izinleri atanmış bir `ADMIN` hesabı `POST /users`, `POST /users/:id/invite-link` ve `/admin/roles*` rotalarında **403** alır | API |

### 12.2 K2 — `ProviderAccessGuard` mirası: RBAC kapsamı dışında

§6'daki **21 rota PR-0'da hiçbir `ADMIN` rolüne açılmaz** ve `ProviderAccessGuard`'a `ADMIN` **eklenmez**.
Guard'ın `SUPER_ADMIN` kısa devresi (`provider-access.guard.ts:20`) **olduğu gibi kalır**.

**İşaret:** §6'daki 21 rotanın tamamı **"RBAC kapsamı dışında · admin impersonation yok"** olarak
sınıflandırılmıştır. Bu bir eksik değil, bir karardır.

Özellikle şu dört aksiyon sınıfı **yalnız sağlayıcı sahibinin ya da `SUPER_ADMIN`'in davranışı** olarak kalır:

| Aksiyon sınıfı | Rotalar |
| --- | --- |
| Mock ödeme | `POST /providers/:providerId/package-purchases/:purchaseId/mock-pay` |
| Sağlayıcı adına teklif verme | `POST /providers/:providerId/requests/:requestId/offers` |
| Kredi harcayan/geri alan yazma | `POST /providers/:providerId/offers/:offerId/withdraw`, `POST /providers/:providerId/package-purchases`, `POST /providers/:providerId/checkout-sessions` |
| Sağlayıcıya ait diğer yazma | `PATCH /providers/:providerId/entitlements/:entitlementId/auto-renew`, `POST /providers/:providerId/entitlements/:entitlementId/cancel`, `POST /providers/:providerId/requests/:requestId/reports` |

Operasyon ihtiyacı ileride çıkarsa çözüm **guard'ı gevşetmek değildir**: ayrı bir admin rotası + sabit bir
izin + audit kaydı ile, kendi tasarım notuyla ele alınır.

**PR-0 testi:** 21 rotanın her biri için, tüm izinleri atanmış bir `ADMIN` hesabının **403** aldığı
doğrulanır (test I-7). Bu, "sessizce açıldı" hâlini imkânsız kılar.

### 12.3 K3 — `PATCH /providers/:id`

| Karar | Ayrıntı |
| --- | --- |
| API katmanı | `@RequiresPermission(PROVIDERS_WRITE)` eklenir — yetki artık guard'dan okunur |
| Servis katmanı | `ensureProviderUpdateAccess` (`providers.service.ts:2048`) ve diğer sahiplik/iş kuralı kontrolleri **aynen korunur**; yeni guard onların yerine geçmez, önüne eklenir |
| Sahip yolu | Sağlayıcının kendi profilini güncellemesi **değişmez**: guard `PROVIDERS_WRITE` ister, ama bu rota `@Roles` taşımadığı için sağlayıcı yolu `AuthGuard` + servis kontrolüyle çalışmaya devam eder — izin kontrolü yalnız personel hesabına uygulanır (`PermissionsGuard`, `ADMIN` rolü için) |
| Tek kaynak | `PROVIDERS_WRITE`, `GET /admin/me/permissions` yanıtında görünür; menü, sayfa ve aksiyon görünürlüğü aynı değeri okur (D13) |

`PROVIDERS_WRITE` §4 kataloğuna **eklenir** (76'nın içindedir) ve §3.20'nin altına bu rota 122. satır olarak
girer. §3'ün 121 satırlık sayımı, 72 dekoratörün kapsamını ölçer; `PATCH /providers/:id` o 72'nin içinde
olmadığı için sayımı değiştirmez.

### 12.4 `CAMPAIGN_ENGINE_TOGGLE` ayrı kalır

`PUT /operations-settings/campaign-engine`, `OPERATIONS_SETTINGS_WRITE` kapsamına **alınmaz**. Ayrı sabit izin
olarak kalır ve üç katmanda ayrı kontrol edilir:

| Katman | Kontrol |
| --- | --- |
| Rota | `@RequiresPermission(CAMPAIGN_ENGINE_TOGGLE)` |
| Admin menüsü | Operasyon Ayarları sayfasındaki `#kampanya-motoru` kartı yalnız bu izinle render edilir |
| Aksiyon | Onay kutusu + "Motoru aç/kapat" düğmesi yalnız bu izinle etkin; izinsiz oturumda düğme **yoktur** ve server action API'ye gitmez |

`OPERATIONS_SETTINGS_WRITE` taşıyan ama `CAMPAIGN_ENGINE_TOGGLE` taşımayan bir rolün motoru açamadığı,
PR-0'ın testinde ayrı bir vaka olarak doğrulanır (I-8).

### 12.5 Kararların §3/§4'e yansıması — özet

| Değişiklik | Etki |
| --- | --- |
| `ADMIN_USERS_CREATE`, `ADMIN_INVITE_ISSUE` kataloğdan çıktı | §3.28'deki iki satır artık `@Roles(UserRole.SUPER_ADMIN)` olarak **kök yetki**; izin adı yok |
| `ADMIN_ROLES_MANAGE` kataloğa hiç girmedi | §10.1'deki öneri karara dönüştü |
| `PROVIDERS_WRITE` eklendi | §12.3 |
| Dinamik katalog | 77 → **76** (`−2 +1`) |
| §6'daki 21 rota | "RBAC kapsamı dışında · admin impersonation yok" olarak işaretlendi |
| §5'teki 27 karma rota | Kararı değişmedi: PR-0'da dokunulmaz |

---

## 13. Katalog görünürlüğü düzeltmesi (2026-09-22, PR-0 içinde)

§3.2'nin altındaki not — "kategori GET rotalarının hepsi public/korumasız, bu yüzden katalogda
`CATEGORIES_READ` **yok**" — eksik bir gözlemdi. Rotalar korumasızdı ama `?includeInactive=true` ile
**yayımlanmamış katalogu** (DRAFT/INACTIVE) döndürebiliyordu; PR-0'ın ilk hâli o genişlemeyi panel
erişimine bağlamıştı, yani rolü ne olursa olsun her personel hesabı gelecek çeyreğin katalogunu görebiliyordu.

**Karar:** yayımlanmamış katalog ayrı ve izinli bir admin yüzeyi olur.

| Değişiklik | Ayrıntı |
| --- | --- |
| Yeni sabit izin | **`CATALOG_READ`** — katalog 76 → **77** |
| Yeni rota | `GET /admin/categories`, `GET /admin/categories/:slug` — `@RequiresPermission(CATALOG_READ)` |
| Public rotalar | `GET /categories` ve `GET /categories/:slug` artık **genişleyen hiçbir parametre okumuyor**; `includeInactive` diye bir şey yok. Spoof edilecek bir şey yok, çünkü geçirilecek bir şey yok |
| `POST /categories/routing/resolve` | Yalnız public katalog üzerinde yürür. Operatör için genişlemesi kaldırıldı: yayımlanmamış katalogun ikinci kapısıydı ve "taslağı ne sızdırır" diye sorarken kimsenin bakmayacağı bir yerdi |
| `auth/elevated-query.ts` | **Silindi** — tek tüketicisi buydu ve genişleyen mod artık yok |
| Yazma | `CATEGORIES_WRITE` / `CATEGORIES_STATUS` / `CATEGORIES_DELETE` aynen ayrı; okuma izni yazma yetkisi vermiyor |
| Admin UI | Katalog ekranları `/admin/categories`'i kullanıyor; `/categories` public görünüm için bile çağrılmıyor |

**Filtre listeleri için kasıtlı düşüş yolu.** Teklifler, talepler ve hizmet veren ekranları kategori
adlarını *filtre* için okuyor. Bunları `CATALOG_READ`'e bağlamak "gelecek çeyreğin katalogunu göremeyen
teklifleri de göremesin" demek olurdu — yanlış bağ. `listCatalogueForFilter()` izin yoksa **boş liste**
döndürür (yönlendirme değil): daha kısa bir açılır liste, gelinen sayfanın kendisi yerine.

**Kasıtlı tek istisna:** `GET /categories/provider-enrollment` yayına girmemiş kategorileri de adlandırır —
sıradaki dalgada açılacak bir mesleğin başvuru yapabilmesi için. Bu bir genişleme değil, kendi predicate'i
ve kendi dar projeksiyonu olan ayrı bir yüzeydir; testi `status`, `isActive`, `questions` ve `children`
alanlarının **olmadığını** doğrular.

**Testler** (`admin-catalog-visibility.spec.ts`, 11 vaka): sekiz farklı query yazımıyla public uç
sızdırmıyor · slug ile de sızdırmıyor · müşteri/sağlayıcı/`CATALOG_READ`'siz ADMIN dar görünüm alıyor ·
routing walk taslağa girmiyor · izinsiz ADMIN 403 `INSUFFICIENT_PERMISSION` · anonim 401, müşteri/sağlayıcı
403 `NOT_STAFF` · `CATALOG_READ` sahibi tam katalog · atamasız `SUPER_ADMIN` örtük erişim · yalnız
`CATALOG_READ` taşıyan dört yazmada da 403 ve satır değişmiyor · yayımlanmamış katalogu servis eden rota
sayısı **tam olarak iki**.

## 14. CMP-006 PR-B eklemesi (2026-09-23)

`package-refunds/admin-package-refund-requests.controller.ts` — sınıf düzeyi guard
(`AuthGuard, AdminAccessGuard, PermissionsGuard`), 7 rota. İzin sayısı 77 → **80**.

| HTTP | Rota | Handler | Aksiyon | İzin | Hassasiyet |
| --- | --- | --- | --- | --- | --- |
| GET | `/admin/package-refund-requests` | `list` | İade isteği kuyruğu | `PACKAGE_REFUND_READ` | PARA (okuma) |
| GET | `/admin/package-refund-requests/:id` | `detail` | Detay, snapshot'lar, audit | `PACKAGE_REFUND_READ` | PARA (okuma) |
| POST | `/admin/package-refund-requests` | `create` | Sağlayıcının mevcut talebine iade isteği bağlar (maker) | `PACKAGE_REFUND_REQUEST_CREATE` | PARA |
| POST | `/admin/package-refund-requests/:id/take` | `take` | İşleme alır (maker) | `PACKAGE_REFUND_REQUEST_CREATE` | PARA |
| POST | `/admin/package-refund-requests/:id/approve` | `approve` | Normal/istisna onayı (checker; istisnada DB maker-checker) | `PACKAGE_REFUND_APPROVE` | PARA, YIKICI |
| POST | `/admin/package-refund-requests/:id/reject` | `reject` | Gerekçeli ret | `PACKAGE_REFUND_APPROVE` | PARA |
| POST | `/admin/package-refund-requests/:id/settlement-failed` | `settlementFailed` | Dış iade tamamlanamadı kaydı | `PACKAGE_REFUND_APPROVE` | PARA |

**`SETTLED` yazan rota yoktur.** Tek yazarı imzalı `order_refunded` webhook'udur (RBAC dışı, imza ile korunur).

Sağlayıcı rotaları (`support/package-refund/*`, `@Roles(PROVIDER)`) ve `POST /support/tickets`'in yeni
`topic` alanı admin rotası değildir; bu tabloya girmez. Admin destek talebi detayı (`SUPPORT_READ`) iade
bloğunu ve iade zaman çizelgesi olaylarını yalnız `PACKAGE_REFUND_READ` sahibine döndürür.

## 15. CMP-006 PR-C eklemesi (2026-09-23)

İki yeni sabit izin, dört rota. İzin sayısı 80 → **82**. Tasarım:
[`2026-09-23-cmp-006-pr-c-business-registration-promotion-eligibility-design.md`](../specs/2026-09-23-cmp-006-pr-c-business-registration-promotion-eligibility-design.md).

`campaigns/eligibility/admin-promotion-eligibility.controller.ts` — sınıf düzeyi guard
(`AuthGuard, AdminAccessGuard, PermissionsGuard`). `admin/campaigns/…` altında değil: orada `GET :id` yakalardı.

| HTTP | Rota | Handler | Aksiyon | İzin | Hassasiyet |
| --- | --- | --- | --- | --- | --- |
| GET | `/admin/promotion-eligibility/holds` | `list` | Bekleyen / karar verilen uygunluk incelemeleri | `PROMOTION_ELIGIBILITY_REVIEW` | RİSK GEREKÇESİ (okuma) |
| GET | `/admin/promotion-eligibility/holds/:eventId` | `get` | Hold snapshot'ı, aday kampanyalar, karar | `PROMOTION_ELIGIBILITY_REVIEW` | RİSK GEREKÇESİ (okuma) |
| POST | `/admin/promotion-eligibility/holds/:eventId/decision` | `decide` | Gerekçeli `ELIGIBLE`/`INELIGIBLE`, bir kez | `PROMOTION_ELIGIBILITY_REVIEW` | PROMOSYON (dolaylı PARA) |

`business-registration/business-registration.controller.ts` — metod düzeyi.

| HTTP | Rota | Handler | Aksiyon | İzin | Hassasiyet |
| --- | --- | --- | --- | --- | --- |
| GET | `/providers/:providerId/business-registration/raw` | `readRaw` | Ham kayıt numarası + ham eski vergi numarası; her okuma `SensitiveDataAccessLog`; `no-store` | `PROVIDER_REGISTRATION_READ_SENSITIVE` | KİŞİSEL VERİ (TCKN olabilir) |

`GET/PUT /providers/me/business-registration` sağlayıcının kendi rotasıdır (`@Roles(PROVIDER)`), admin rotası
değildir; bu tabloya girmez. Operatörün kanonik kaydı yazdığı bir rota **yoktur**. `PROVIDERS_READ_DETAIL` ve
`PROVIDERS_READ` artık ham vergi/kayıt numarası taşımaz (maskeli; listede eski vergi numarası hiç yok).
Mevcut `GET /admin/campaigns/:id/evaluation-events` (`CAMPAIGNS_READ`) `HELD_FOR_REVIEW` durumunu görür, snapshot'ı
görmez; `POST …/retry` held event'i kabul etmez (409 `CAMPAIGN_EVENT_NOT_RETRYABLE`).
