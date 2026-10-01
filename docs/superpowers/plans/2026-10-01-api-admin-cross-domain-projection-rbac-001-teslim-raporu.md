# API-ADMIN-CROSS-DOMAIN-PROJECTION-RBAC-001 — teslim raporu

- **Taban:** `main@94d14dd0`, DB 83 migration. **Migration yok**, Prisma şeması, `.env`, compose değişmedi.
- **Sorun:** Bazı admin yanıtları rotanın ana okuma izniyle başka alanın verisini gömüyordu (ADMIN-DESIGN-001 Faz 4, ayrı açık #1). UI'da gizlemek yeterli değildi.

## Kural

Rotanın izni **kendi konusunu** açar. Bağlı kaydın **kimliği** (id, işletme adı, talep numarası, kategori, il/ilçe, durum) konuyu okunur kılar ve gider. Bağlı kaydın **içeriği, iletişimi ve parası** o alanın kendi okuma izninin ve yanıta yalnız o izinle girer:

| Gömülü veri | Gereken izin | Gerekçe (aynı veriyi kendi başına açan rota) |
| --- | --- | --- |
| Sağlayıcı kredi bakiyesi, `balanceAtOpen` | `FINANCE_LEDGER_READ` | `GET /admin/providers/:id/credits` |
| Teklif satırları ve sayıları | `OFFERS_READ` | `GET /offers` |
| Paket alımı satırları ve sayısı | `PACKAGE_PURCHASES_READ` | `GET /package-purchases` |
| Talep satırları/sayıları, talebin ayrıntısı ve sahibinin iletişim kopyası (`customerName/Phone/Email`, mahalle, kalite) | `REQUESTS_READ` | `GET /service-requests/:id` |
| Talebin arkasındaki müşteri **hesabı** (`customer {id,name,email,phone}`) | `CUSTOMERS_READ` | `GET /customers/:id` |
| Sağlayıcı yetkilisi/telefonu/e-postası | `PROVIDERS_READ` | `GET /providers` |

İzin yoksa **anahtar yanıtta hiç yok**: `null`, `0`, `[]` ya da maske yok (bunlar "yok"tan ayırt edilemez ve veri varlığı hakkında yanlış beyan olur). Hangi blokların eksik olduğu oturumun kendi izinlerinden çıkar (`GET /admin/me/permissions`). SUPER_ADMIN `hasPermission` ile her izni taşır → tam görünüm. Tek kaynak: `apps/api/src/modules/auth/embedded-permissions.ts` → `mayEmbed(user, ...perms)` (`hasPermission` üzerine, birleşik/AND).

## Endpoint → gömülü alan → izin matrisi

| Endpoint (rota izni) | Gömülü alan | İzin | Değişiklik |
| --- | --- | --- | --- |
| `GET /providers` (`PROVIDERS_READ`) | `creditBalance` | `FINANCE_LEDGER_READ` | izinsiz anahtar yok, sorgu da yapılmaz |
| | `activeOffersCount`, `totalOffersCount` | `OFFERS_READ` | 〃 |
| | `packagePurchasesCount` | `PACKAGE_PURCHASES_READ` | 〃 |
| `GET /providers/:id/admin-detail` (`PROVIDERS_READ_DETAIL`) | `creditBalance` | `FINANCE_LEDGER_READ` | 〃 |
| | `activeOffersCount`, `totalOffersCount`, `recentOffers` | `OFFERS_READ` | 〃 |
| | `packagePurchasesCount`, `recentPackagePurchases` | `PACKAGE_PURCHASES_READ` | 〃 |
| `GET /providers/:id` (OptionalAuth, personel dalı) | operatör projeksiyonu (iletişim, moderasyon notu, her durum) | `PROVIDERS_READ` | **yeni açık kapatıldı:** her personel (ör. yalnız `SUPPORT_READ`) admin görünümü alıyordu; artık izinsiz personel kamu görünümü alır (onaysız profil 404) |
| `GET /customers/:id` (`CUSTOMERS_READ`) | `metrics.requestCount`, `metrics.lastRequestAt`, `recentRequests` | `REQUESTS_READ` | izinsiz anahtar yok |
| | `metrics.offerCount`, `metrics.acceptedOfferCount`, `recentOffers`, `acceptedOffers` | `OFFERS_READ` | 〃 (`metrics` her zaman nesne, alanları izne göre) |
| `GET /customers` (`CUSTOMERS_READ`) | satır `requestCount`, `lastRequestAt`, `lastRequestCity`; `meta.anonymousRequestCount` | `REQUESTS_READ` | izinsiz anahtar yok; `city`/`lastRequestFrom`/`lastRequestTo` filtresi ve bu alanlara sıralama **403 `INSUFFICIENT_PERMISSION`** (satır sırası/süzme aynı soruyu cevaplardı); varsayılan sıralama izinsizde `createdAt` |
| | satır `offerCount`, `acceptedOfferCount` | `OFFERS_READ` | 〃 |
| `GET /offers`, `GET /offers/:id` (`OFFERS_READ`) | `provider.contactName/phone/email` | `PROVIDERS_READ` | izinsiz anahtar yok |
| | `request.neighborhood/qualityScore/customerName/customerPhone/customerEmail` | `REQUESTS_READ` | 〃 |
| | `request.customer` | `CUSTOMERS_READ` | 〃 |
| | `request.customerId` | — | **eklendi** (referans, hesap değil): durum işleminin "talep bir hesaba bağlı mı" kuralı UI'da artık hesabı görmeden okunur |
| | `q` araması: sağlayıcı yetkili/telefon, talep sahibi ad/telefon/e-posta | aynı izinler | izinsiz bu sütunlarda aranmaz (arama sonucu "bu numara var mı" kâhini olmasın) |
| `PATCH /offers/:id/status` (`OFFERS_STATUS`) | yanıt = teklif | yukarıdakiyle aynı | aynı projeksiyon |
| `POST /offers/:id/refund-credit` (`OFFER_REFUND_MANUAL`) | `offer` | yukarıdakiyle aynı | aynı projeksiyon |
| | `balance` (iade sonrası bakiye) | `FINANCE_LEDGER_READ` | izinsiz anahtar yok; `refundTransaction` ve `settlement` işlemin kendi kaydı, kalır |
| `GET /service-requests`, `GET /service-requests/:id` (`REQUESTS_READ`) | `customer {id,email,phone,name}` | `CUSTOMERS_READ` | izinsiz anahtar yok; talebin kendi iletişim kopyası ve `customerId` kalır |
| `POST /service-requests/:id/reports/resolve` (`REQUEST_REPORTS_RESOLVE`) | yanıt = tüm talep detayı | `REQUESTS_READ` | izinsiz yanıt `{ id, requestNumber, status }`; izinliye talep sayfası (müşteri hesabı yine `CUSTOMERS_READ`) |
| `GET /finance/providers` (`FINANCE_READ`) | `provider.phone/email` | `PROVIDERS_READ` | izinsiz anahtar yok, `q` bu sütunlarda aranmaz |
| `GET /finance/credit-ledger` (`FINANCE_LEDGER_READ`) | `provider.phone/email` | `PROVIDERS_READ` | 〃 |
| `GET /package-purchases`, `GET /package-purchases/:id`, `PATCH /package-purchases/:id/status` | `provider.contactName/email` | `PROVIDERS_READ` | izinsiz anahtar yok (sağlayıcının kendi rotaları ortak `include`'u projeksiyonsuz kullanmaya devam eder) |
| | `creditHold.balanceAtOpen` (detay) | `FINANCE_LEDGER_READ` | 〃 |

**Temiz bulunanlar (değişmedi):** `/notification-logs*`, `/dashboard/admin-summary` (yalnız sayılar), `/users*` (personelin kendi iletişimi), `/finance/analytics`, sağlayıcı değerlendirmeleri, `/service-requests/reports` ve `/:id/reports`, `/service-requests/:id/contact-reveal` (kendisi iletişim alanı, `CONTACT_REVEAL_READ`), promosyon uygunluk kuyruğu, vitrin uçları, `/admin/providers/:id/entitlements` (alım/ödeme alanı içi).

## UI uyarlamaları (admin)

Ortak kurallar `apps/admin/lib/cross-domain-projection.ts` (`gateColumns`, sağlayıcı/müşteri sütun kapıları, müşteri sıralama alanları ve varsayılanı).

- **`/providers`:** Kredi / Açık teklif / Paket sütunları yalnız ilgili izinle çizilir (`0` hücre yok).
- **`/providers/[id]`:** özet şeridinde Kredi bakiyesi (`FINANCE_LEDGER_READ`), Açık/Toplam teklif (`OFFERS_READ`), Paket alımı (`PACKAGE_PURCHASES_READ`) yalnız izinle; "Teklifler ve paketler" sekmesi ikisinden biri varsa çizilir, etiketi elde olana göre ("Teklifler" / "Paket alımları"); kartlar ayrı ayrı izinli.
- **`/customers`:** Şehir/Talep/Son talep (`REQUESTS_READ`) ve Teklif/Kabul (`OFFERS_READ`) sütunları; şehir ve son talep tarih filtreleri ve izinsiz sıralama seçenekleri çizilmez, URL'deki izinsiz değerler API'ye gönderilmez (yer imi 403 vermez), varsayılan sıralama ve özet metni izne göre.
- **`/customers/[id]`:** Talep geçmişi / Aldığı teklifler sekmeleri, özet şeridi rakamları ve "Şehir (son talebinden)" satırı izne göre; elle yazılmış sekme ilk sekmeye düşer.
- **`/offers`:** Müşteri sütunu yalnız `REQUESTS_READ`; yetkili adı yoksa satır boş bırakılmaz, hiç çizilmez; arama ipucu metni izne göre.
- **`/offers/[id]`:** Yetkili/telefon/e-posta ve kalite/müşteri/telefon/e-posta satırları yalnız gönderildiyse; başlıktaki "müşteri:" parçası yalnız ad varsa. Durum işlemi kuralı `request.customer === null` yerine `request.customerId === null` okur (davranış aynı, hesap verisine ihtiyaç kalmadı).
- **`/requests/[id]`:** "Bağlı hesap" `CUSTOMERS_READ` yoksa yanlışlıkla "Bağlı hesap yok" demez; `customerId` varsa "Müşteri hesabına bağlı" yazar.
- **`/package-purchases/[id]`:** "HV e-posta" ve "Vaka açıldığında bakiye" satırları yalnız gönderildiyse.
- **`/finance/providers`, `/finance/credit-ledger`:** arama ipucu izne göre (iletişim hücresi zaten koşulluydu).
- Tipler (`lib/api.ts`): ilgili alanlar opsiyonel, her biri hangi izinle geldiğini söyler.

## Yazma yetkisi

Yeni yazma yetkisi açılmadı; guard'lar, `route-permission-map.ts` ve rota haritası testi değişmedi. Değişen yalnız yanıt projeksiyonu (ve `GET /customers`'ta izinsiz sıralama/filtrenin reddi).

## Test

- **API (yeni) `apps/api/test/admin-cross-domain-projection.spec.ts` — 40 test:** her etkilenen uç için tek-izinli rol (yalnız rota izni) → gömülü anahtarlar yok ve değerleri JSON'da geçmiyor; rota izni + tek alan izni → tam olarak o blok; SUPER_ADMIN → tüm bloklar değerleriyle; müşteri listesinde izinsiz sıralama/filtre 403; teklif/finans aramasında iletişim kâhini yok; `reports/resolve` iki yanıt şekli; kredi tutma kaydında `balanceAtOpen`; sağlayıcı/self regresyonu (`/providers/me/dashboard` bakiyesi, kendi profili, kendi paket alımlarında iletişim); sağlayıcı hesabı tüm admin uçlarında 403.
- **Admin birim (yeni) `apps/admin/test/cross-domain-projection.spec.ts`:** sütun kapıları, müşteri sıralama alanları/varsayılanı, detay ekranlarının blok kapıları (kaynak).
- **E2E (yeni) `e2e/tests/admin-cross-domain-projection.spec.ts`** (WebKit `testMatch`'e eklendi): sağlayıcı liste/detay, müşteri liste/detay (yer imi sıralaması hata ekranı vermez), teklif liste/detay (iletişim metni sayfada yok), talep detayı "Müşteri hesabına bağlı"; her biri SUPER_ADMIN karşılığıyla.
- **E2E (güncellendi) `admin-people-support-screens`:** `PROVIDERS_READ_DETAIL` tek başına artık yalnız "İşletme bilgileri" sekmesini görür; `CUSTOMERS_READ` tek başına yalnız "Profil ve iletişim".

## Bilinçli bırakılanlar / yeni açıklar (bu PR'da yapılmadı)

1. `GET /finance/providers` sağlayıcı başına `currentBalance`'ı `FINANCE_READ` ile veriyor; `/finance/summary` `recentTransactions` (ledger satırları, `createdBy.email`) `FINANCE_READ` ile. Bu finans alanının kendi iç ayrımı (`FINANCE_READ` toplamlar ↔ `FINANCE_LEDGER_READ` satırlar) — alanlar arası değil; ürün kararı ister.
2. `GET /admin/campaigns/:id/redemptions` (`CAMPAIGNS_READ`) `promoLot.remainingCredits` (promosyon bakiyesi) taşıyor → `FINANCE_LEDGER_READ` adayı.
3. `GET /admin/package-refund-requests/:id` (`PACKAGE_REFUND_READ`) bağlı destek talebinin `subject/status/topic`'ini taşıyor → `SUPPORT_READ` adayı (iade kararı için bağlam olabilir; karar).
4. Yanıtlarda personel e-postası (`createdBy.email`, `actor.email`, `decidedBy.email`) `ADMIN_USERS_READ` olmadan geliyor — düşük.
5. `GET /service-requests/:id` `cancellation` bloğu teklif iade kararlarını (`refundedOfferIds`, `winnerRefundDecision`) taşıyor; talebin kendi yaşam döngüsü kaydı sayıldı, dokunulmadı.
6. Sağlayıcı bakiyesi admin ekranlarında yalnız `FINANCE_LEDGER_READ` ile; `FINANCE_READ` sahibi aynı bakiyeyi `/finance/providers`'ta görüyor (madde 1 ile birlikte karar).
