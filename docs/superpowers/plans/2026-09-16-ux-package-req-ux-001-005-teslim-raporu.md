# REQ-UX-001–005 UX Paketi — Teslim Raporu

Tarih: 2026-09-16 · Branch: `claude/ux-package-req-001-005-dc7d5b` (taban `origin/main` @ `16b5c703`) · PR: https://github.com/umutciftciii/taktic/pull/82 · Merge: **yapılmadı**

Tasarım: `docs/superpowers/specs/2026-09-16-ux-package-req-ux-001-005-design.md` · Plan: `docs/superpowers/plans/2026-09-16-ux-package-req-ux-001-005.md`

## Migration

**Var, tek ve additive:** `prisma/migrations/20260916130000_add_service_request_preferred_date_end/migration.sql`
`ALTER TABLE "ServiceRequest" ADD COLUMN "preferredDateEnd" TIMESTAMP(3);` — backfill yok; `preferredDate` başlangıç, `NULL` bitiş = eski tek tarih (tüm okuyucular tek gün olarak basar).

İzole dry-run (yerel `taktic` kopyası → `taktic_dryrun_202609161234`, gerçek DB'ye komut yok):

| | Öncesi | Sonrası |
| --- | --- | --- |
| `_prisma_migrations` | 61 (`…add_provider_reviews`) | 62 (`…add_service_request_preferred_date_end`) |
| `ServiceRequest` satır | 19 | 19 |
| `md5(string_agg(id order by id))` | `c3540c2955c45cb221e8f65d2d12b3c2` | `c3540c2955c45cb221e8f65d2d12b3c2` |
| `preferredDate IS NOT NULL` | 8 | 8 |
| `preferredDateEnd IS NOT NULL` | — (kolon yok) | 0 |

Throwaway DB `DROP DATABASE` ile silindi; yerel `taktic` 61 migration'da kaldı.

---

## REQ-UX-001 — Talep başarı ekranı

**Sözleşme:** `GET /service-requests/my/:id` (yeni; `AuthGuard` + `Roles(CUSTOMER)`; `where: { id, customerId }` → başkasının ve olmayan talep aynı 404; liste ile aynı `customerRequestInclude`/`toCustomerServiceRequest`). Form artık `published` param'ı yazmaz; sayfa URL'den durum okumaz. Misafir aktivasyon linki `redirectTo=/requests/{id}/offers` (`safeRedirectPath` süzgeci; aktivasyon → oturum → kendi teklif ekranı).

**Web `/requests/success?id=`:** id yok/cuid değil → 404. Oturumlu CUSTOMER → API'den gerçek durum: `showcaseLead` (serbest bırakılmamış) → `TALEP İLETİLDİ / Talebiniz {işletme} işletmesine iletildi` (yalnız o işletme, genel pazara açılmadı, SLA saati); `APPROVED` → `TALEP YAYINLANDI / Talebiniz yayınlandı`; diğer → mevcut ön inceleme metni. Oturumsuz → nötr makbuz (`TALEP ALINDI / Talebiniz alındı`, id'den referans, e-posta ile etkinleştirme notu, `Ana sayfaya dön`; hiçbir API çağrısı ve durum iddiası yok). Provider/admin → 404.

**Test/E2E:** API `customer-request-detail.spec.ts` (sahip 200 = liste satırı; başka müşteri 404 = olmayan id 404 gövdesi; provider 403, admin 403, oturumsuz 401), `customer-activation.spec.ts` (`redirectTo`). E2E `request-success-screen.spec.ts` (misafir makbuz + iddia sözcükleri yok, `published=1` param'ı etkisiz; başka müşteri/olmayan/bozuk/eksik id → 404 ekranı; vitrin lead → hedefli metin), `request-auto-publish` (açık → `Talebiniz yayınlandı`), `request-contact-filter` (kapalı → ön inceleme), `auth-session-cookie` (aktivasyon → `/requests/{id}/offers`).

## REQ-UX-002 — Aciliyet ve tarih aralığı

**Sözleşme:** DTO `preferredDate?` + **yeni** `preferredDateEnd?` (`YYYY-MM-DD`). Kural (`apps/api/src/modules/service-requests/preferred-date-range.ts`, saat parametreli): iki uç boş → kabul (her aciliyet; eski istemci/`ESNEK`); tek uç → 400 `Tarih aralığının iki ucu da girilmeli.`; bozuk/takvimde yok → 400; geçmiş (İstanbul günü) → 400; ters → 400; `TODAY` ≠ bugün-bugün → 400; `THIS_WEEK` bitiş > haftanın pazarı → 400. Saklama UTC gece yarısı (`new Date('YYYY-MM-DD')`, eski satırlarla aynı biçim). Date-only yardımcıları `@taktic/shared` (`todayIsoDay`, `addIsoDays`, `endOfWeekIsoDay`, `isIsoDay`, `compareIsoDays`, `formatDateRange`) + API kopyası `apps/api/src/common/date-only.ts` (API shared'i import edemez; parity spec). Taslak payload'ı `preferredDateEnd` taşır. Projeksiyonlar: provider talep/teklif detayı, vitrin lead, admin talep detayı, e-posta özetleri `formatDateRange` ile (`15 Eyl 2026 – 21 Eyl 2026`, eşit/uçsuz → tek tarih). Kalite skoru değişmedi.

**Form:** `TimingFields` (`apps/web/app/request-fields/timing-fields.tsx`) iki formda: aciliyet + Başlangıç/Bitiş (`min=today` tarayıcı İstanbul günü), `BUGÜN` → ikisi bugün, `BU_HAFTA` → bugün..pazar, `Varsayılan aralığı uygula` düğmesi (aynı seçeneğin yeniden seçimi `change` üretmez; klavye yolu), `ESNEK` tarihler isteğe bağlı; tek uç/ters için `setCustomValidity`. Payload builder iki alanı string olarak geçirir (Date kurulmaz).

**Test:** shared `datetime.spec.ts` (Pazar 2024-09-15 → aynı gün; 2026-09-30 → 2026-10-04; 2026-12-30 → 2027-01-03; `2026-09-14T21:30Z` → bugün `2026-09-15`); API `date-only-parity.spec.ts`, `request-preferred-date-range.spec.ts` (15 case: saf kural + HTTP); web `service-request-payload.spec.ts`; E2E `request-date-range.spec.ts` (otomatik doldurma, yeniden uygulama, tarayıcı ön doğrulaması, API reddi inline + form korunur, DB'de gün kaymasız, provider ekranında aralık metni).

## REQ-UX-003 — İşletme seçme kartları (hand-off)

**Sözleşme:** `POST /service-requests`'e `showcaseCardId` **eklenmedi**; `RequestDraftPayloadDto` **genişletilmedi** (iletişim bilgisi taslakta yok). Hand-off `handOffToShowcaseAction` (server action): kartı `/showcase/feed` ile kategori+konum için yeniden doğrular (yoksa `CARD_UNAVAILABLE`, hiçbir şey yazılmaz); `RequestDraft` `SHOWCASE_LEAD + card.category.slug + cardId` anahtarıyla kaydeder (kimlik: misafir formdaki telefon/e-posta, oturumlu hesabın); `DRAFT_EXISTS` → "Evet, geç / Vazgeç" diyaloğu; sonuç `/vitrin/{cardId}?step=form` (URL'de PII/form içeriği yok). Vitrin lead formu taslağı restore eder; `ServiceRequest`/`ShowcaseLead`/SMS yalnız oradaki nihai gönderimde, mevcut kurallarla (zorunlu telefon doğrulaması, acil/normal) oluşur.

**Bileşen:** `ProviderChoiceCard` + `GeneralRequestChoice` (`role=radiogroup`, görsel olarak gizli native radio, ok tuşları, `:focus-within`): işletme adı, kategori, hizmet bölgesi, yanıt taahhüdü, `reviewSummary` yalnız non-null ise (anahtar kapalı/eşik altı → hiç yok). Seçimde not: "Talebiniz yalnız X işletmesine iletilir; genel pazara açılmaz." + misafir için "Seçili işletmeye talep göndermek için telefonunuzu doğrulamanız gerekir." Ana CTA `Seçili işletmeye devam et` (`type=button`; Enter ile submit engellenir). Vitrin lead formuna **isteğe bağlı** Adres notu, tarih aralığı, bütçe eklendi (taşınan veri kaybolmaz; aynı `LocationFields`/`TimingFields`/`BudgetFields`).

**E2E `request-provider-choice.spec.ts`:** seçim talebi göndermez (DB sayısı sabit) ve CTA'yı değiştirir; hand-off → vitrin formunda açıklama, kategori cevabı, il/ilçe, adres notu, aciliyet, tarih aralığı, bütçe dolu; iletişim alanları boş; URL yalnız `step`; `ServiceRequest`/`ShowcaseLead` yok. Kart yayından düşmüş → hata cümlesi, genel'e dönüş, alanlar korunur, taslak yazılmaz, genel gönderim `directShowcaseProviderId=null`. Klavye (ok tuşları), review anahtarı kapalı → puan yok / açık → 4,7 yalnız eşiği geçende; 320/768/1024/1440 taşma 0 + ekran görüntüleri. `showcase-placement-lead` form-içi test hand-off'a güncellendi.

## REQ-UX-004 — Teklif deneyimi

**Müşteri:** `listRequestOffers` → `viewedAt` (additive). Liste Geçmiş satırında `viewedAt && WITHDRAWN` → `role=status` "Bu teklif hizmet veren tarafından iptal edilmiştir." (iade/kredi sözcüğü yok); detayda aynı uyarı başta, `Kabul Et/Reddet` yok (`actionable=false`). Görüntülenmemiş geri çekilmiş satır nötr kalır; canlı teklif regresyonsuz (E2E `offer-experience.spec.ts`, `offer-withdrawal.spec.ts` genişletildi; API `offer-withdrawal.spec.ts`, `provider-review-projections.spec.ts` anahtar listesi).

**Hizmet veren teklif paneli:** `OfferPriceField` (`apps/web/app/providers/offer-price-field.tsx`) mevcut `LiraInput`/`formatLiraDraft`/`completeLiraAmount`/`parseLiraToMinor` ile (yeni parser/float yok) — marketplace talep paneli **ve** vitrin lead teklif formu aynı alanı kullanır; action `parseLiraToMinor` (kuruş integer, mevcut DTO sözleşmesi). Görünüm `₺` + `4.500,00`; boş → `required`, <1 TL → `En az 1,00 TL girin.`, `-` düşer, `12.50` binlik olarak `1.250`, `4500,5` → `4.500,50` (unit `lira-input.spec.ts` +6 case, E2E fiyat `4.500,00` → DB `450000`, ekranda `₺4.500,00`). `Görüntülenme bekleniyor` rozeti: `dd` içinde satır kırar, 480px altında dt/dd üst üste; E2E rozet kutusu kart sınırı içinde (4 genişlik).

**Tekliflerim:** `minWidth:800` ve yatay scroll kaldırıldı; ≥1100px `table-layout: fixed`, işlem alanı her satırda aynı: `Teklif detayı` üstte tam genişlik, altında iki sabit slot (`Talep`, `Geri çek`; boş slot yer tutar); <1100px satırlar kart (`data-label`), başlıklar ekran okuyucuya kalır. E2E: 320/768/1024/1440'ta doküman ve tablo kapsayıcısı taşma 0 **ve** hiçbir buton metni kesilmedi/kutudan çıkmadı (canlı satır + geri çekilmiş satır).

## REQ-UX-005 — Landing metni

`apps/web/app/page.tsx` adım 3: `Admin onayından sonra talepleri gör` → `Talepleri gör`. Repo taramasında aynı ifade başka kullanıcı yüzeyinde yok; alakasız sweep yapılmadı. `landing-hero.spec.ts` dört adımı ve eski ifadenin yokluğunu asserte eder.

---

## Kalite kapıları

| Komut | Sonuç |
| --- | --- |
| `pnpm typecheck` | 5/5 |
| `pnpm lint` | 4/4 |
| `pnpm test` | shared 165, admin 49, web 127, API 2438 (119 dosya) — hepsi geçti |
| `pnpm build` | 3/3 |
| `pnpm e2e` (Chromium) | 249/249 |
| `pnpm e2e:webkit` | 94/94 (yeni dört spec WebKit `testMatch`'e eklendi) |
| CI (#82, run 35099366703) | 3/3 geçti: `typecheck · lint · test · build`, `e2e (chromium)`, `e2e (webkit · sign-in and mobile shells)` |

Not: `playwright test` doğrudan çağrıldığında `prepare-database` (outbox temizliği) atlanır ve aynı saat içinde tekrar koşularda `provider-review-flow` eski SMS kodunu okuyup düşer; `pnpm e2e` ile temiz koşuda geçti.

## Responsive kanıt (E2E ekran görüntüleri: `e2e/.artifacts/screens/`)

| Yüzey | 320 | 768 | 1024 | 1440 |
| --- | --- | --- | --- | --- |
| Talep formu — işletme seçimi | taşma 0 | taşma 0 | taşma 0 | taşma 0 |
| Provider teklif paneli (rozet kart içinde) | 0 | 0 | 0 | 0 |
| Tekliflerim — canlı satır (3 aksiyon) | 0 (kart) | 0 (kart) | 0 (kart) | 0 (tablo) |
| Tekliflerim — geri çekilmiş satır (2 aksiyon) | 0 (kart) | 0 (kart) | 0 (kart) | 0 (tablo) |

Buton metni kesilmesi (`scrollWidth > clientWidth`) da her genişlikte 0.

## Açık riskler / notlar

- **Hand-off yarışı:** action'daki kart doğrulaması ile vitrin sayfasının yüklenmesi arasında kart düşerse müşteri vitrin 404'ünü görür; taslak cookie'si 24 saat durur ve kart geri gelirse okunur. Kabul edilen küçük pencere.
- **Misafir referansı** id'den türetilir (`#XXXXXX`); gerçek `requestNumber` yalnız oturumla görülür (bugünkü davranış korunur).
- **Oturumlu müşterinin hesabında telefon/e-posta eksikse** hand-off `IDENTITY_MISSING` ile inline reddedilir (taslak kimliği hesaba bağlanamaz); genel gönderim etkilenmez.
- **Tekliflerim 1024px'te kart düzeni:** yan panelle 700px'lik içerik alanına 7 sütun sığmadığı için (1024 tablo denemesinde sayı ve rozet kelime ortasından kırılıyordu) eşik 1100px'e alındı; 1440'ta tablo.
- **Eski `type=number` fiyat alanını `1500.00` ile dolduran E2E'ler** `1500,00` biçimine çevrildi (lira alanı noktayı binlik okur).
- Vitrin lead SLA/telefon doğrulaması/urgencyBucket kuralları, teklif durum makinesi, kredi/iade ve review eşikleri değiştirilmedi. Compose/Dockerfile/env/Cloudflare/Lemon/Resend/scheduler dokunulmadı; yeni bağımlılık yok.

## Merge sonrası gerekli container'lar

1. `taktic-api` — `prisma migrate deploy` (yeni kolon) + yeni endpoint/DTO/projeksiyonlar.
2. `taktic-web` — form, başarı ekranı, teklif yüzeyleri, landing.
3. `taktic-admin` — talep detayında tarih aralığı gösterimi (`@taktic/shared` yeni export).

Sıra: api → web → admin (web/admin API'nin `preferredDateEnd`/`my/:id` yanıtlarına bağlı). Yerel Docker eşitlemesi merge sonrası ayrıca yapılacak (memory kuralı).
