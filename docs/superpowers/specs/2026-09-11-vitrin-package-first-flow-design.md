# VIT-DESIGN-002 — Vitrin paket-önce akışı ve arayüz yeniden tasarımı

**Tarih:** 2026-09-11 · **Durum:** onaylı tasarım · **Kapsam:** API + web + admin + migration

## 1. Amaç

Vitrin ticari akışı ters kurulmuştu: önce kart yazılıp onaylanıyor, sonra kart için
paket satın alınıyordu. Hizmet veren ekranları `ShowcaseCardVersion`, placement,
şart kabulü gibi sistem içi kavramları kullanıcıya döküyordu. Bu iş akışı tersine
çevirir ve tüm vitrin arayüzünü ürün seviyesine çıkarır:

1. Vitrin paketi önce satın alınır.
2. Başarılı ödeme bir **yayın hakkı** (`ShowcaseEntitlement`) üretir.
3. Sağlayıcı bu hakla kartını oluşturur; hak o anda karta **rezerve** olur.
4. Kart admin incelemesinden geçer.
5. Onayda hak **tüketilir** ve kart otomatik yayına girer.
6. Müşteri tarafında yalnız onaylı, aktif yayındaki kartlar görünür.

Kapsam dışı: yeni bağımlılık, Lemon/Resend/Cloudflare/.env/compose ayarları, para
iadesi davranışı, VIT-002 (pazar taleplerinde vitrin önceliği).

## 2. Veri modeli — tek additive migration

Migration adı: `add_showcase_entitlements`. Hiçbir mevcut satırı okumaz/günceller/
silmez; yalnız kolon, tablo, index ve CHECK ekler. Aktif dev DB'de bugün: 1 onaylı
kart (placement'sız), 2 FAILED kart-bağlı vitrin purchase, 1 paket, 0 placement —
hepsi olduğu gibi kalır.

### 2.1 `ShowcasePackage.activationWindowDays`

`INT NOT NULL DEFAULT 90`. **Satın alınmış ama kullanılmamış hakkın geçerlilik
süresi.** Paket ödemesinden itibaren bu kadar gün içinde kart onaylanıp yayına
girmezse hak düşer. Gerekçe: pakette bu süre tanımlı değildi; sınırsız hak üretmek
yerine açık bir paket kuralı konuldu. 90 gün, 30 günlük paket için üç yayın
periyodu kadar bir hazırlık payı verir ve admin paket formundan paket başına
değiştirilebilir. Mevcut paket satırı varsayılanla 90 alır.

### 2.2 `ShowcasePackageTermsAcceptance` (yeni tablo)

Sağlayıcı seviyesinde sorumluluk metni kabulü; paket-önce modelde kart-bazlı
`ShowcaseCardPriceTermsAcceptance`'ın yerini alır (eski tablo silinmez, salt
tarihçe olarak kalır; admin "Vitrin Metin Onayları" ekranı her iki tabloyu listeler).

| kolon | not |
|---|---|
| `id`, `providerId`, `termsVersion`, `termsTextSnapshot`, `acceptedByUserId`, `acceptedAt` | append-only, `updatedAt` yok |
| `UNIQUE(providerId, termsVersion)` | aynı sağlayıcı aynı sürümü ikinci kez kabul etmek zorunda kalmaz; yarışta ikinci satır oluşamaz |
| CHECK `btrim(termsVersion) <> ''`, `btrim(termsTextSnapshot) <> ''` | boş kabul yasak |

Kural: **şart metni veya sürümü değişirse** (`SHOWCASE_PRICE_TERMS_VERSION`
bump) sağlayıcının yeni sürüm için kaydı olmadığından yeni satın alma öncesinde
kutu yeniden görünür ve kabul zorunludur. Var olan kabul → kutu gösterilmez, CTA
doğrudan aktif; purchase yine o kabul satırının id'sini taşır.

### 2.3 `PackagePurchase`

- Yeni kolon `showcasePackageTermsAcceptanceId TEXT NULL` (FK Restrict).
- `PackagePurchase_showcase_card_matches_kind` CHECK'i drop/recreate:

```
kind='OFFER_PACKAGE'    AND showcaseCardId IS NULL AND showcaseCardVersionId IS NULL
                        AND durationDaysSnapshot IS NULL AND showcasePriceTermsAcceptanceId IS NULL
                        AND showcasePackageTermsAcceptanceId IS NULL
OR
kind='SHOWCASE_PACKAGE' AND durationDaysSnapshot IS NOT NULL AND (
   -- legacy, kart-bağlı satın alma (yalnız tarihçe; yeni satır yazılmaz)
   (showcaseCardId IS NOT NULL AND showcaseCardVersionId IS NOT NULL
    AND showcasePriceTermsAcceptanceId IS NOT NULL AND showcasePackageTermsAcceptanceId IS NULL)
   OR
   -- paket-önce satın alma
   (showcaseCardId IS NULL AND showcaseCardVersionId IS NULL
    AND showcasePriceTermsAcceptanceId IS NULL AND showcasePackageTermsAcceptanceId IS NOT NULL)
)
```

Mevcut 2 FAILED satır legacy dalı, OFFER satırları ilk dalı sağlar.
`providerOrderId` / `paymentReference` unique'leri ve `kind_matches_package`,
`showcase_grants_no_credit` CHECK'leri değişmez.

### 2.4 `ShowcaseEntitlement` (yeni tablo) — yayın hakkı

| kolon | not |
|---|---|
| `id`, `providerId` | |
| `purchaseId UNIQUE` | bir ödeme → en fazla bir hak (idempotency'nin DB yarısı) |
| `showcasePackageId` (FK Restrict) | |
| `packageNameSnapshot`, `durationDaysSnapshot`, `priceAmountSnapshot`, `currencySnapshot`, `allowedCardKindSnapshot?`, `maxAreasSnapshot?` | satın alındığı anki paket; katalog sonradan değişse de hak değişmez |
| `priceTermsVersionSnapshot`, `priceTermsTextSnapshot` | kabul satırından kopya; placement'a taşınır |
| `status` enum `ShowcaseEntitlementStatus { AVAILABLE, RESERVED, CONSUMED, EXPIRED }` | |
| `grantedAt`, `expiresAt` | `expiresAt = paidAt + activationWindowDays` |
| `cardId?` (FK Restrict), `reservedAt?` | RESERVED/CONSUMED'da dolu |
| `consumedAt?`, `placementId? UNIQUE` (FK Restrict) | CONSUMED'da dolu |

Index/constraint:
- `UNIQUE (cardId) WHERE status = 'RESERVED'` — **bir kartta aynı anda tek rezerve hak.**
- `(providerId, status, expiresAt)` index.
- CHECK `ShowcaseEntitlement_status_shape`:
  - AVAILABLE ⇒ cardId, reservedAt, consumedAt, placementId NULL
  - RESERVED ⇒ cardId, reservedAt NOT NULL; consumedAt, placementId NULL
  - CONSUMED ⇒ cardId, reservedAt, consumedAt, placementId NOT NULL
  - EXPIRED ⇒ consumedAt, placementId NULL (cardId serbest: süresi dolan rezerve hak hangi karttaydı, kayıt kalır)
- CHECK `expiresAt > grantedAt`.

Hiçbir okuyucu `status`'a tek başına güvenmez: kullanılabilirlik her zaman
`status IN (AVAILABLE) AND expiresAt > now()` ile sorulur; rezervasyon geçerliliği
`status = RESERVED AND expiresAt > now()`.

`ShowcasePlacement` şeması **değişmez**; haktan doğan placement aynı `purchaseId`'yi
taşır (purchase → hak → placement zinciri her halkada unique).

## 3. Hak yaşam döngüsü (API)

### 3.1 Settlement (webhook + mock, aynı dallanma)
- `purchase.showcaseCardId` doluysa → legacy `createForPurchase` (değişmez; yalnız
  bekleyen legacy satırlar için).
- Değilse → `ShowcaseEntitlementService.grantForPurchase(tx, purchase, paidAt)`:
  AVAILABLE hak, snapshot'lar purchase + paket + kabul satırından.
- Aynı order ikinci kez hak üretemez: PROCESSED kısa devresi, `status !== PENDING`
  reddi, `providerOrderId` unique, `ShowcaseEntitlement.purchaseId` unique.
- Bildirim: hak oluştuğunda e-posta gönderilmez (yeni şablon eklenmez; ödeme dönüş
  ekranı sonucu gösterir). Placement doğduğunda — yani admin onayında ya da
  `use-entitlement` ile anında yayında — tx sonrası mevcut
  `sendShowcasePlacementActivated` çağrılır.

### 3.2 Satın alma
`POST /providers/:id/showcase/packages/checkout`
`{ showcasePackageId, priceTermsAccepted?, priceTermsVersion? }` — **tek satın alma yolu.**
- Yalnız PROVIDER rolü; sağlayıcı APPROVED; paket `isActive`.
- Serializable tx: mevcut kabul yoksa `priceTermsAccepted && priceTermsVersion ===
  güncel` şart, kabul satırı yazılır (unique ile idempotent); kartsız purchase satırı
  `showcasePackageTermsAcceptanceId` ile oluşur. Aynı paket için kullanılabilir
  PENDING checkout varsa yeniden verilir.
- Ödeme sağlayıcısı tx dışında çağrılır; hata → purchase FAILED + `503 {code}`.
- Dönüş URL'si `/providers/:id/vitrin/odeme/:purchaseId?checkout=return` (mevcut
  `buildReturnUrl` ile aynı; rota web'e eklenir).
- Paket haritada yoksa (`PACKAGE_NOT_MAPPED`) veya paket yoksa web'de tek cümle:
  "Bu paket şu an satın alınamıyor."

`GET /providers/:id/showcase/entitlements` → `{ available: [...], reservedByCard: {...} }`
(paket adı, süre, `expiresAt`, `allowedCardKind`).

### 3.3 Kart oluşturma
`POST /providers/:id/showcase/cards` gövdesine opsiyonel `entitlementId` eklenir.
- Serializable tx içinde: aday hak = verilen id ya da **en erken dolacak**, kartın
  türüyle uyumlu (`allowedCardKindSnapshot IS NULL OR = kind`), geçerli AVAILABLE hak.
- Rezervasyon `updateMany({ where: { id, status: 'AVAILABLE', expiresAt: { gt: now } }, data: { status: 'RESERVED', cardId, reservedAt } })`; `count !== 1` → `409 SHOWCASE_ENTITLEMENT_UNAVAILABLE`. Kart ve sürüm aynı tx'te yazılır.
- Hak yoksa `409 SHOWCASE_ENTITLEMENT_REQUIRED` (web zaten formu göstermez).

### 3.4 Kart durum geçişleri
- **İncelemeye gönder**: checkbox yok. Sürümün `priceTermsVersion/priceTermsAcceptedAt`
  değerleri sırasıyla şuradan alınır: kartın RESERVED hakkı → kartın son CONSUMED
  hakkı → sağlayıcının güncel sürüm paket kabulü → kartın eski kart-bazlı kabulü.
  Canlı sürümü olmayan kartta RESERVED+geçerli hak zorunlu (`SHOWCASE_ENTITLEMENT_REQUIRED`).
  DTO'daki `priceTermsAccepted/priceTermsVersion` alanları kaldırılır.
- **Red / geri çekme**: hak RESERVED kalır; kart düzenlenip yeniden gönderilir.
- **Kartı sil ve yayın hakkını serbest bırak** (canlı sürümü olmayan kart —
  DRAFT/PENDING_REVIEW/REJECTED): kart `ARCHIVED`, RESERVED hak `AVAILABLE`'a
  döner (`cardId/reservedAt` NULL). Arayüzde tam bu adla, `⋯` menüsünde ve onay
  diyaloğunda sunulur; hak yanlışlıkla 90 gün kilitli kalmaz. Yayınlanmamış arşiv
  kartları listeden gizlenir. Bekleyen inceleme varsa aynı tx'te geri çekilir.
- **Aktif yayındaki kartı arşivle**: bugünkü davranış (placement CARD_ARCHIVED
  suspend, süre işler); hak zaten CONSUMED, dokunulmaz.
- **`POST /cards/:id/use-entitlement`** `{ entitlementId? }`: rezerve hakkı olmayan
  karta hak bağlar. Kart APPROVED + canlı sürümlü + kategori açık + bölgeler kapsamda
  ise **aynı tx'te** hak tüketilir ve placement doğar (legacy onaylı kart, süresi
  dolmuş kart "Yeniden yayınla", serbest bırakılıp geri getirilen kart). Değilse
  yalnız rezerve eder.

### 3.5 Admin onayı (`approveVersion`)
Serializable tx içinde, kartın **canlı sürümü yoksa** (ilk onay):
1. RESERVED + `expiresAt > now` hak → yoksa `409 SHOWCASE_ENTITLEMENT_MISSING`
   ("Bu kartın geçerli bir yayın hakkı yok; sağlayıcı paket almadan kart yayına
   alınamaz."), hiçbir yazım olmaz.
2. Kategori hâlâ açık, sürümün bölgeleri sağlayıcının hizmet bölgeleri içinde →
   değilse `409 SHOWCASE_CARD_NOT_PUBLISHABLE` ile anlaşılır mesaj.
3. Sürüm APPROVED, kart APPROVED/liveVersionId, review satırı, **placement**
   (`createForEntitlement`: startAt = now, endAt = now + durationDaysSnapshot,
   snapshot'lar haktan), hak CONSUMED (`updateMany WHERE status='RESERVED' AND
   cardId = …`, count=1), shelf satırları, mail (tx sonrası).

Canlı sürümü olan kartın revizyonu: bugünkü gibi yalnız repin; hak aranmaz.
"Onaylandı ama yayınlanamıyor" hâli temsil edilemez: onay ve yayın tek tx.

### 3.6 Süre dolumu
Mevcut `ShowcasePlacementExpiryService` süpürmesi ek olarak
`status IN (AVAILABLE, RESERVED) AND expiresAt <= now` hakları EXPIRED yapar.
Okuyucular zaten `expiresAt`'e baktığından süpürücü kapalıyken de ek süre kazanılmaz.

### 3.7 Kaldırılan uçlar
`POST /providers/:id/showcase/placements/checkout`, `GET …/placements/eligibility`,
`POST …/cards/:cardId/price-terms-acceptances`, `GET …/cards/:cardId/price-terms`.
Repo içi tek tüketici web uygulamasıydı; dış tüketici yok (Lemon webhook bu uçları
çağırmaz). Kaldırma kontrollü: (a) `apps/web`, `apps/admin`, `e2e` ağacında bu yolların
sıfır referansı bir unit test ile kanıtlanır (`test/showcase-legacy-routes.spec.ts`);
(b) API spec'i bu yolların 404 döndüğünü doğrular.

### 3.8 Sunucu-çözümlü kart durumu (`ShowcasePublicationService`)
Öncelik sırası: `ARCHIVED` → `SUSPENDED` → `LIVE / ACTIVATING / PAUSED` →
`IN_REVIEW` → geçerli rezerve hak yoksa `EXPIRED` (daha önce yayını olmuş) ya da
`NEEDS_PACKAGE` (hiç olmamış) → `REJECTED` → `DRAFT`.
`TERMS_REQUIRED`, `READY_TO_PUBLISH`, `AWAITING_PAYMENT` kalkar. Cevap:
`{ cards: [...], availableEntitlements: [...], hasPublicationHistory }`; kart girdisi
`entitlement: { packageName, durationDays, expiresAt } | null`, `hasRunBefore`.

## 4. Ekranlar

### 4.1 Tasarım sistemi kararları
- Token'lar `apps/web/app/globals.css` Modernist seti (radius 0, Archivo, accent
  `--color-accent`). Yeni renk/yazı tipi eklenmez.
- **İmza:** tek `ShowcaseCardFace` bileşeni (`apps/web/app/showcase-card-face.tsx`):
  görsel alanı (yoksa kategori sanatından türeyen token gradient), kategori + tür
  etiketi, başlık, SERVICE fiyatı, özet, belirgin `Hizmet bölgesi · …` bandı. Ana
  sayfa rafı, sağlayıcı grid'i, kart özeti ve admin inceleme önizlemesi aynı yüzü
  çizer: sağlayıcı "kayıt" değil, müşterinin göreceği kartı görür.
- Formlar: tek yüzey (`--color-surface`), grup başlıkları 2px üst çizgi ile değil
  başlık + 1px iç ayırıcıyla; radio/checkbox `appearance:none` + token'lı özel
  görünüm; `select` özel ok. Kalın siyah bordür tekrarı kaldırılır.
- Her ekranda tek ana CTA (`pdash-btn-primary`), ikincil eylemler ghost.
- Reduced-motion: geçişler `@media (prefers-reduced-motion: reduce)` ile kapanır.
- 320px'te yatay taşma 0; grid 1 / 2 (≥768) / 3 (≥1200) kolon.

### 4.2 Hizmet veren
| rota | içerik |
|---|---|
| `/providers/:id/vitrin` | Başlık **Vitrinde yer alın**; alt metin "Hizmetlerinizi ana sayfada gösterin ve doğrudan talep alın." Sayaç: `N kullanılabilir vitrin hakkınız var` + `Vitrin kartını oluştur`; hak yoksa `Vitrin paketi al`. Grid: "Yayında" ve "Hazırlık" başlıkları altında `ShowcaseCardFace` + durum rozeti (`Taslak · İncelemede · Pakete hazır · Yayında · Reddedildi · Süresi doldu`) + tek bağlamsal eylem. Boş durum: kısa açıklama + `Vitrin paketi al`. `Yeni vitrin kartı` paketsize gösterilmez. |
| `/providers/:id/vitrin/paketler` | Paket kartları (ad, süre, fiyat, kısa fayda) seçilebilir; seçilince altında sorumluluk metni kutusu (kabul kaydı varsa görünmez) ve `Güvenli ödemeye geç`. Kabulsüz CTA pasif + "Devam etmek için sorumluluk metnini kabul edin." `?card=<id>` ile geliş → satın alma sonrası o kartı yayınlama akışı. |
| `/providers/:id/vitrin/odeme/:purchaseId` | PAID → "Vitrin hakkınız hazır" + `Şimdi kartınızı oluşturun` (`?card` varsa `Kartı yayınla`). PENDING (mock) → `Ödemeye devam et` (mock form; ödeme sonrası buraya döner). FAILED/CANCELLED → "Ödeme tamamlanmadı, hak oluşmadı" + `Paket seçimine dön`. |
| `/providers/:id/vitrin/yeni` | Yalnız geçerli hak olana (yoksa `/paketler`'e yönlendirme). Üstte kullanılacak hak ("1 Aylık Vitrin Paketi · 30 gün"; birden çok farklı paket varsa seçim). Gruplar: Temel bilgiler / Hizmet ve fiyat / Yanıt taahhüdü / Hizmet bölgeleri. CTA `Kartı oluştur` → kart ekranı. |
| `/providers/:id/vitrin/:cardId` | **Kart özeti** (`ShowcaseCardFace` + dahil/hariç + yanıt taahhüdü + bölgeler), **Yayın durumu** paneli (tek bağlamsal panel; metinler brief §4), `Kartı düzenle` linki, `⋯` menüsü: `Kartı sil ve yayın hakkını serbest bırak` (yayınlanmamış) / `Kartı arşivle` (yayında) + `<dialog>` onayı. Red notu panelin içinde. |
| `/providers/:id/vitrin/:cardId/duzenle` | Ayrı düzenleme görünümü; canlı kartta tek cümle: "Değişiklikler yeniden incelemeye girer; yayındaki metin onaya kadar aynı kalır." |

`Vitrin taleplerim` menüsü yalnız `hasPublicationHistory` olanda (mevcut kural).

### 4.3 Admin
- `lib/nav.ts`: `Paketler`, `Kart incelemeleri`, `Yayındaki kartlar`, `Vitrin talepleri`.
- İnceleme detayı: "Yayın hakkı: 1 Aylık Vitrin Paketi · 30 gün · 10 Aralık 2026'ya
  kadar geçerli" satırı; hak yoksa/süresi dolmuşsa uyarı ve `Onayla` yanında neden.
  `SHOWCASE_ENTITLEMENT_MISSING` hatası okunur cümleyle gösterilir.
- Paket formu: `activationWindowDays` alanı ("Kullanılmamış hakkın geçerliliği (gün)").
- Kart önizlemesi `ShowcaseCardFace` benzeri sade özet (admin ayrı uygulama; paylaşılan
  bileşen değil, aynı içerik düzeni).

### 4.4 Müşteri
Mantık aynı: konumsuz `Öne çıkan hizmetler`, `Bu hizmeti incele`, kart detayı karar
ekranı (`Devam et` / `Vazgeç`), gerçek adres girişi, sunucu kapsam kontrolü (kapsam
dışında `ServiceRequest`/`ShowcaseLead` yazılmaz, genel talep CTA'sı). Yalnız
`livePlacementWhere` ile onaylı+aktif kartlar. Raf ve detay `ShowcaseCardFace` ile
ürün estetiğine çekilir; panel/operasyon görünümü taşımaz.

## 5. Doğrulama

- **API spec'leri** (`apps/api/test/showcase-entitlement-*.spec.ts`):
  hak üretimi + aynı webhook/mock ikinci hak üretmez; paketsiz kart oluşturma 409;
  rezervasyon yarışı (`Promise.all` ile 2 kart, 1 hak → tam biri başarılı);
  red→düzelt→gönder→onay tek tüketim; silme hakkı serbest bırakır; süresi dolmuş
  hakla onay 409 ve hiçbir yazım yok; çoklu paket/çoklu kart; süresi dolmuş kartın
  `use-entitlement` ile yeniden yayını; legacy uçlar 404; publication durumları.
- **Web unit**: `panel-routes.spec.ts` yeni rotalar; `showcase-legacy-routes.spec.ts`
  kaldırılan yolların sıfır referansı.
- **E2E** (Chromium + WebKit): yeni uçtan uca akış (paket al → mock öde → kart
  oluştur → gönder → admin onay → ana sayfada görünür → kapsam dışı direct-lead reddi);
  paketsiz sağlayıcı doğru CTA'yı görür; yapılandırmasız paket ekranı teknik terim
  içermez; 320/768/1024/1440 taşma 0 + `test-results/showcase-screens/*.png` kanıt.
  Mevcut `showcase-cards.spec.ts` ve `showcase-placement-lead.spec.ts` yeni akışa
  taşınır.
- **Komutlar**: `pnpm typecheck`, `pnpm lint`, kök `pnpm test`, `pnpm build`, tam
  Chromium + WebKit E2E.
- **Migration dry-run**: aktif DB `pg_dump` → izole `taktic_vitdesign002_dryrun` →
  `prisma migrate deploy` → tablo satır sayıları ve vitrin/purchase satırlarının
  `md5(row::text)` karşılaştırması (öncesi = sonrası). Aktif `DATABASE_URL` shadow
  olarak kullanılmaz; `db push`/reset yok.
- PR açılır, CI beklenir, merge edilmez.
