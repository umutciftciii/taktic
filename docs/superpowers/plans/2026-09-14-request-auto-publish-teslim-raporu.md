# Anında yayın (auto-publish) ve "Talebi bildir" — teslim raporu

Dal: `claude/auto-publish-report-design-b0d504` (worktree
`credits-refund-unviewed-offers-d211e8`), taban `main` (`e05cd864`, PR #75 kimlik gate).
Spec: `docs/superpowers/specs/2026-09-14-request-auto-publish-and-report-design.md` (rev. 2,
onaylı). Plan: `docs/superpowers/plans/2026-09-14-request-auto-publish-and-report.md`.
14 görev tamamlandı (Task 1–14); bu rapor Task 14'ün çıktısıdır (push/PR HARİÇ).

## 1. Özet

Operatörün "Onayla" adımı, `OperationsSettings.marketplaceAutoPublishEnabled` anahtarına
bağlandı: anahtar **açıkken** normal pazar talebi oluşturma transaction'ında `APPROVED`
doğar (`approvedAt = submittedAt`), müşteri "Talebiniz uygun hizmet verenlere iletildi"
başarı sayfasını görür ve eşleşen hizmet verenler listede talebi hemen bulur; yayın
bildirimleri (`request-published` müşteriye, `request-available` provider başına) aynı
transaction'da `NotificationLog PENDING` niyeti olarak kalıcılaşır ve commit sonrası
`RequestPublishOutbox` teslim eder. Anahtar **kapalıyken** (varsayılan) her şey eskisi gibi:
`SUBMITTED` + `request-received` + admin onayı.

Buna karşılık hizmet verenlere bir denetim aracı verildi: talep detayında **"Talebi
bildir"** (7 gerekçe + not, provider başına günde 20, talep başına tek rapor). Admin'de yeni
**Talep bildirimleri** kuyruğu ve talep detayında üç karar: **Uygun bulundu** (raporlar
kapanır, talep yerinde kalır), **Talebi kaldır** (talep `REJECTED`, aktif teklifler
`CANCELLED` + `cancelledAt`, harcanan krediler aynı serializable transaction'da tam ve
idempotent iade, müşteriye `request-removed` e-postası, provider'a e-posta yok) ve
**Talebi geri aç** (yalnız rapor sonucu kaldırılmış talep; `APPROVED`, yeni `approvedAt`,
kapatılan teklifler kapalı kalır). Moderasyon "Reddet" de aynı cascade'i koşar.

Ayrıca: talep metinlerinde (açıklama, adres notu, TEXT/TEXTAREA yanıtları) iletişim
bilgisi engeli (`packages/shared/contact-patterns.json` tek kaynak; API `400
CONTACT_DETAILS_IN_TEXT` + formda alan altı hata + yazarken ipucu) ve `POST
/service-requests` için üç hız sınırı (IP 5/10 dk; telefon 5/24 s; telefon başına 10 açık
talep).

## 2. Görevler ve commit'ler

| Task | Kapsam | Commit |
|---|---|---|
| 1 | Prisma: `ServiceRequestReport`, `marketplaceAutoPublishEnabled`, `Offer.cancelledAt`, migration | `61831e5f` |
| 2 | `operations-settings/marketplace-publish` GET/PUT, `OperationsSettingsChange` denetimi | `8ba6c579` |
| 3 | `RequestPublishOutbox` — yayın bildirimleri kalıcı niyet, lease'li teslim, expiry tick'inde süpürme | `376c772a` |
| 4 | Oluşturmada yayın (anahtar), doğrulama sonrası yayın, admin onayında tx içi re-read | `8aa41533`, `070a63fe` |
| 5 | Vitrin lead RELEASE kararı anahtar açıkken doğrudan yayınlar | `a938b9ea` |
| 6 | `rejectRequestInTransaction` cascade: teklifler `CANCELLED`, atomik/idempotent iade | `baa5dc17` |
| 7 | Provider "Talebi bildir" ucu, günlük bütçe, `myReport` | `ba16301c` |
| 8 | Admin kuyruk, kararlar, geri açma, müşteri + destek e-postaları | `f91d7ca0` |
| 9 | İletişim bilgisi engeli (shared JSON desenleri, api + form) | `49fe19d5` |
| 10 | IP / telefon / açık talep hız sınırları | `b1d8da82`, `2024961f` |
| 11 | Web: Talebi bildir diyaloğu, kapatılan teklif metinleri, "yayında" başarı sayfası | `06761328`, `007dc8ee` |
| 12 | Admin: bildirim kuyruğu + kararlar, otomatik yayın anahtarı kartı, dashboard sayacı | `b0736871`, `547a8950` |
| 13 | E2E: `request-auto-publish`, `request-report-flow`, `request-contact-filter` (chromium + webkit) | `468919af` |
| 14 | Dry-run, tam doğrulama, bu rapor | bu commit |

Toplam: 109 dosya, +10 299 / −295 satır (test dosyaları dahil).

## 3. API sözleşmesi (yeni/değişen uçlar)

- `GET/PUT /operations-settings/marketplace-publish` — SUPER_ADMIN; `{ enabled }`;
  satır yoksa `false` okunur (fail-closed); gerçek değişiklikte bir `OperationsSettingsChange`.
- `POST /providers/:providerId/requests/:requestId/reports` — onaylı provider;
  `{ reason, note? (≤500) }`; 201; aynı provider aynı talep → 409; görünmeyen talep /
  başkasına ayrılmış lead → 404; `PENDING_REVIEW` provider → 403; günde 21. rapor → 429.
- `GET /service-requests/reports?state=open|resolved&cursor` — admin; talep başına
  gruplu, en eski ilk rapor önce, keyset sayfalama.
- `GET /service-requests/:id/reports` — admin; talebin tüm raporları.
- `POST /service-requests/:id/reports/resolve` — `{ resolution: DISMISSED |
  REQUEST_REMOVED, removalReason?, note? }`; `REQUEST_REMOVED` gerekçesiz → 400; açık
  rapor yoksa 409 `NO_OPEN_REPORTS`; `MATCHED` talepte 409 `REQUEST_NOT_REMOVABLE`.
- `POST /service-requests/:id/reopen` — yalnız rapor sonucu `REJECTED` olmuş talep;
  elle reddedilende 409 `REQUEST_NOT_REOPENABLE`.
- `POST /service-requests` — `400 CONTACT_DETAILS_IN_TEXT { field }`; `429` (IP bütçesi,
  `Retry-After`) ve `429 REQUEST_RATE_LIMITED` (telefon 24 s / açık talep tavanı).
- Provider talep detayı yanıtına `myReport`, teklif detayına `closureNotice` eklendi.

## 4. Spec §7.4 kabul kriterleri — kanıt

### 4.1 Yeni normal talep, oluşturma yanıtından hemen sonra eşleşen provider listesinde ve teklif verilebilir; admin aksiyonu yok

- API `apps/api/test/request-auto-publish.spec.ts` (7 test): "switch on: the request is
  born APPROVED, visible to a matching provider, and fanned out"; "switch off: the request
  waits at SUBMITTED and the customer gets request-received"; "switch on: a vitrin lead is
  never auto-published by the marketplace path"; "switch on + verification required:
  SUBMITTED until verifyCode, then APPROVED without an admin"; "switch off + verification
  required: verifyCode leaves the request for the operator"; "does not book a second fan-out
  when the request went live before the admin save committed"; "enqueues the fan-out in the
  approval transaction and delivers it after the commit".
- API `showcase-lead-release-auto-publish.spec.ts` (2): RELEASE anahtar açık/kapalı.
- API `request-publish-outbox.spec.ts` (5): niyet başına tek satır, iki süpürmede tek
  teslim (lease), canlı olmayan kaynak `FAILED`, expiry tick'i `publishSent` raporlar.
- API `marketplace-publish-settings.spec.ts` (2): satır yokken false, gerçek değişiklikte
  tek denetim kaydı, provider'a 403.
- E2E `e2e/tests/request-auto-publish.spec.ts` (2 varyant: aciliyetsiz ve "Bugün"):
  admin anahtarı ekrandan açar → müşteri talep açar → `/requests/success?…&published=1`
  "Talebiniz uygun hizmet verenlere iletildi" → DB `APPROVED` → provider listesinde tek
  kayıt → teklif verir (kredi düşer) → müşteri teklifi görür; admin aktörü talebi hiç açmaz.
  Chromium + WebKit.

### 4.2 Bildirim oluşturma / unique / yetkisiz provider reddi / üç admin kararı / kaldırılmış talepte engeller

- API `request-reports.spec.ts` (5): "creates once, then 409; the detail shows only my own
  report"; "does not hide the request: it stays listed and offerable after a report";
  "refuses a request the provider cannot see with 404, and a non-approved provider with
  403"; "caps a provider at 20 reports per day"; "rejects a note over 500 code units".
- API `request-report-schema.spec.ts` (3): unique `(requestId, reporterProviderId)`,
  CHECK `resolvedAt ⇔ resolution`, yeni kolonların varsayılanları.
- API `request-reports-admin.spec.ts` (7): DISMISSED tüm açık raporları kapatır ve talep
  canlı kalır; REQUEST_REMOVED → `REJECTED` + müşteri e-postası + reopen geri getirir;
  gerekçesiz kaldırma 400; başarısız kaldırma maili retry'da talepten yeniden kurulur;
  elle reddedilen talepte reopen 409; kuyruk sayfalama; provider'a admin uçları 403.
- API `request-removal-refund.spec.ts` (12): görüntülenmiş/görüntülenmemiş/çoklu
  teklifte tam iade ve idempotency; 0 kredi ve dönem paketi teklifleri ledger'sız kapanır;
  geri çekilmiş teklif dokunulmaz; `MATCHED` talepte 409 ve hiçbir şey kımıldamaz; iade
  throw ederse tam geri sarma; manuel iade çakışması "already refunded"; provider paneli
  kapatma notu; vitrin lead teklifi.
- Kaldırılmış talepte engeller: expiry/reminder taraması `REJECTED` talebi atlar
  (`request-lifecycle.spec.ts` "never expires a REJECTED request" / "never reminds a
  REJECTED request"); teklif verme / talep sayfası provider için 404, kabul yolu
  `status = APPROVED` koşullu `updateMany` ile 409, `CANCELLED` teklif geri çekilemez —
  bunlar mevcut durum bekçileridir; **bu dalda bunlara ayrı bir API testi eklenmedi**,
  kanıt E2E'dedir (aşağıda) — bkz. §8 ertelenenler.
- E2E `request-report-flow.spec.ts` (2): (a) "a dismissed report leaves the request where
  it was" — rozet "Bildiriminiz alındı", ikinci düğme yok, kuyrukta `report-count` 1,
  Uygun bulundu → kuyruktan düşer, tanık provider listede hâlâ görür, iade yok, müşteri 2
  teklifi görür; (b) "removing the request closes the offers, refunds both providers, and
  can be reopened" — listeden düşer, provider talep sayfası 404, iki teklif "Kapatıldı" +
  "Talep yayından kaldırıldı. Harcanan teklif krediniz iade edildi.", bakiyeler 10'a döner,
  `OFFER_REFUND` satırı 1'er, müşteri panosu "Reddedildi" + "Teklifi İncele" yok +
  `offer-closed-note` ×2, outbox'ta `request-removed` ×1, geri aç → listede yeniden,
  teklifler kapalı kalır, kuyruk `state=resolved`'da "geri açıldı". Chromium + WebKit.

### 4.3 PII içeren açıklama reddi (API 400 + form mesajı)

- Shared `packages/shared/src/contact-detection.spec.ts` + API
  `apps/api/test/contact-detection.spec.ts` (aynı pozitif/negatif tablo; paritesi
  `it.each` ile): TR mobil/sabit, obfuscated e-posta, URL pozitif; bütçe, tarih, posta
  kodu, IBAN parçası negatif.
- API `request-contact-filter.spec.ts` (5): açıklamada telefon → 400 + `field`
  + hiçbir satır yazılmaz; adres notunda e-posta; TEXT yanıtta link; TEXTAREA yanıtta
  telefon; temiz metin kabul.
- Web `apps/web/test/contact-details-refusal.spec.ts`: refusal → alan eşlemesi ve metin.
- E2E `request-contact-filter.spec.ts` (1): açıklamada telefon → `contact-details-error`
  alan altında, talep oluşmaz; düzeltilen form gönderilir. Chromium + WebKit.

### 4.4 Migration sonrası parmak izleri ve durum dağılımı değişmemiş; bekleyen `SUBMITTED` talepler admin listesinde ve "Onayla" çalışıyor

- Dry-run: `docs/superpowers/plans/2026-09-14-request-auto-publish-migration-dryrun.txt`
  — özet §5.
- Anahtar kapalıyken mevcut akış: E2E `marketplace-journey.spec.ts`,
  `phone-verification-gate.spec.ts`, `hero-request-demo.spec.ts` ve `request-report-flow`
  fixture'ı (`approveRequest`) admin "Onayla" adımını koşuyor — tam suite yeşil.
  API `request-auto-publish.spec.ts` "switch off …" testleri `SUBMITTED` + `request-received`.

## 5. Migration dry-run özeti

`taktic_autopublish_dryrun` (aktif `taktic`'in `pg_dump` kopyası) üzerinde `prisma migrate
deploy` → yalnız `20260914120000_add_request_reports_and_auto_publish` uygulandı (59 → 60).
Saf DDL: 2 enum, `OperationsSettings.marketplaceAutoPublishEnabled BOOLEAN NOT NULL DEFAULT
false`, `Offer.cancelledAt TIMESTAMP NULL`, `ServiceRequestReport` tablosu (CHECK +
unique + partial open index + 3 FK), `ServiceRequest(customerPhone, submittedAt)` indeksi.

Parmak izleri (count + md5) önce = sonra: ServiceRequest 13, Offer 6,
ProviderCreditTransaction 11, ShowcaseLead 3, NotificationLog 52, OperationsSettings 0.
Durum dağılımı önce = sonra: APPROVED 3, COMPLETED 3, MATCHED 1, SUBMITTED 6. 58 tablonun
tek tek satır sayısında tek fark yeni boş `ServiceRequestReport`. Sonrası: anahtar kolonu
true olan satır 0, `Offer.cancelledAt` 6/6 NULL, `ServiceRequestReport` 0 satır. Yerel
`OperationsSettings` boş olduğundan ikinci kopyada migration öncesi elle bir satır eklendi:
migration sonrası `marketplaceAutoPublishEnabled = false`, diğer anahtarlar korundu. Her
iki dry-run DB DROP edildi; aktif DB'de migration sayısı 59, yeni kolon/tablo yok.

## 6. Spec'ten kayıtlı sapmalar

1. **Hız sınırı env override'ları** (spec §8 J "kodda sabit; env yok"). E2E ortamında
   her senaryo 127.0.0.1'den dakikalar içinde talep açtığı için IP bütçesi (5/10 dk)
   suite'i kırardı. `auth` throttler emsalini izleyerek `SERVICE_REQUEST_RATE_LIMIT_MAX` /
   `SERVICE_REQUEST_RATE_LIMIT_WINDOW_SECONDS` (varsayılan 5 / 600, pozitif tam sayı
   değilse varsayılana düşer) eklendi; `.env.example`'da belgelendi; E2E config'i yükseltir.
   Telefon başına 5/24 s ve 10 açık talep sınırları env'siz sabit kaldı (ürün kuralı).
2. **`urgency: 'URGENT'` yok.** Plan metni acil varyantı `URGENT` diye yazmıştı; form
   `TODAY | THIS_WEEK | FLEXIBLE` sunar, spec `TODAY` der. E2E acil varyantı "Bugün"
   (`TODAY`) ile koşar; ürün davranışı aynı (aciliyet yalnızca etikettir).
3. **Eşleşme listesi teklif vermiş provider'ı göstermez** (`offers.none`), dolayısıyla
   "bildiren A, Uygun bulundu sonrası listede talebi hâlâ görür" iddiası olduğu gibi
   kanıtlanamaz. E2E'de üçüncü, teklif vermeyen bir **tanık provider** liste görünürlüğünü
   doğrular; bildiren A için kanıt talep sayfasının 404 olmaması + kapatma notunun yokluğu.
4. **Moderasyon "Reddet" aynı cascade'i koşar** — spec §8 K'de "kesin davranış" olarak
   yazılıydı; uygulama `rejectRequestInTransaction`'ı hem rapor kararı hem moderasyon için
   tek yol yaptı. Elle reddedilen talep `reopen` ile geri açılamaz (409); yalnız rapor
   sonucu kaldırılan açılır.
5. **Dönem paketi (`MONTHLY_QUOTA`) ve 0 kredi (`SHOWCASE_PLACEMENT`) teklifleri**
   kaldırmada `CANCELLED` olur ama ledger satırı yazılmaz, kota geri verilmez (spec §8 K
   ile uyumlu; burada açıkça not düşülüyor).
6. **`request-received` `nextStep: 'verify'`** yalnız marketplace taleplerinde;
   vitrin direct-lead'de mevcut `'review'` adımı korunur.
7. **Admin onayında tx içi re-read** (Task 4 review): admin "Onayla" kaydı, talebin
   arada doğrulama transaction'ıyla yayınlanmış olabileceğini hesaba katıp durumu
   transaction içinde yeniden okur; aksi hâlde `request-published` iki kez kuyruklanırdı.
8. **Anahtar ucu** spec §3.4'te `GET/PUT /operations-settings` gövdesine ek alan olarak
   yazılıydı; uygulama `GET/PUT /operations-settings/marketplace-publish` (`{ enabled }`)
   şeklinde ayrı bir alt uç kullandı. Spec §3.4 / §4.2 / §8 J bu notla güncellendi.

### 6.1 Son inceleme düzeltme dalgası (I-1..I-3, T14)

Bütün dal incelemesinin bulguları, her biri kendi commit'inde:

- **I-1** `833eab9b` — PII filtresi binlik ayraçlı bütçe aralığını ("50.000 - 60.000 TL")
  telefon sanıyordu; `contact-patterns.json` `amountRange` deseni, shared + api aynı gövde,
  iki spec'e üç NEGATIVE vaka.
- **I-2** `847274d0` — admin "Reddet" formu yalnız `APPROVED/IN_REVIEW/SUBMITTED`'da açık;
  409 `REQUEST_NOT_REMOVABLE` → `?statusError=notRemovable` uyarısı; panel metinleri ve
  API/rapor paneli ipucu kapanmış talebi de kapsar.
- **I-3** `8d09038c` — kodsuz 429 (IP throttler) web formunda `REQUEST_RATE_LIMITED`
  Türkçe metniyle gösterilir; İngilizce `ThrottlerException` müşteriye ulaşmaz.
- **T14** `d5c77fa9` — `request-removal-refund.spec.ts`: kaldırma sonrası provider detayı
  404, yeni teklif 404, müşteri kabul 400, geri çekme 409, mesaj kanalı 404 tek vakada.

## 7. Operasyon notları

- **Anahtar varsayılan KAPALI.** Açmak için: Admin → *Operasyon ayarları*
  (`/operations-settings`) → "Pazar talepleri otomatik yayınlansın" kartındaki anahtar
  (`data-testid="auto-publish-toggle"`); SUPER_ADMIN; her gerçek değişiklik
  `OperationsSettingsChange`'e yazılır. Migration anahtarı açmaz; satır yoksa kapalı okunur.
  Kapatınca yeni talepler yeniden `SUBMITTED` doğar; açıkken oluşmuş talepler etkilenmez.
- **Yayın outbox'ı:** niyetler oluşturma/yayın transaction'ında `PENDING` yazılır,
  commit sonrası `deliverSoon()` bloklamadan teslim eder. Kaçan satırlar (süreç düşmesi,
  transport hatası) **request-expiry scheduler tick'inde** süpürülür — bu, tick'in
  `requestExpirySchedulerEnabled` anahtarına bağlı olduğu anlamına gelir: o anahtar
  kapalıysa yeniden teslim yalnız sonraki `deliverSoon` çağrısı veya admin *Bildirim
  Geçmişi* "Yeniden gönder" düğmesiyle olur. Lease (kilit) sayesinde iki süpürme aynı
  satırı iki kez göndermez. Yeni cron yok.
- **`REQUIRE_PHONE_VERIFICATION=true`** iken anahtar açık olsa da talep `SUBMITTED`
  doğar; `verifyCode` transaction'ında otomatik yayınlanır ve fan-out kuyruklanır. Bayrak
  kapalıysa oluşturma anında yayın. Vitrin direct-lead her durumda `SUBMITTED` doğar;
  yalnız RELEASE kararı anahtar açıkken yayınlar.
- **Hız sınırları:** `SERVICE_REQUEST_RATE_LIMIT_MAX` / `_WINDOW_SECONDS` isteğe bağlı
  (varsayılan 5 / 600); IP `req.ip` üzerinden, `TRUST_PROXY` hop sayısıyla. Telefon
  başına 5/24 s ve 10 açık talep sabit; aşımda `429 REQUEST_RATE_LIMITED`.
- **Rapor bütçesi:** provider başına günde 20 (`REPORT_MAX_PER_PROVIDER_PER_DAY`, sabit).
- **E-posta:** kaldırmada müşteriye `request-removed` (gerekçe sözlüğü spec §5), destek
  kutusuna `request-report-new-for-support`; teklif veren provider'a e-posta yok — panelde
  "Kapatıldı" + kapatma notu ve kredi hareketlerinde `REQUEST_REMOVED` etiketi.
- **Kaldırılan talepte kredi:** `ONE_TIME_CREDIT` teklifleri görüntülenme ayrımı olmadan
  tam iade; `UnviewedOfferRefundService` bu teklifleri aday almaz (üç katlı idempotency:
  partial unique index + koşullu UPDATE + aday filtresi).

## 8. Ertelenen minor bulgular (ledger'dan, kısa)

- T3: `customerEmail` trim asimetrisi (enqueue/compose); `IntentDeliveryResult` `import
  type`; `composeRetryMessage` request-available satır başına `findMatchingProviders`
  (O(N²), önceden vardı).
- T4: `onModuleDestroy` beklemesi sınırsız; `verify` fişinin retry'ı `review` metniyle
  render eder; vitrin test fixture'ı ShowcaseLead'siz; `RequestExpiryOutbox` aynı
  serileştirmeye sahip değil.
- T6: 0 kredi dalında `SHOWCASE_PLACEMENT` yalnız dolaylı test; `ensureRequestExists`
  kullanılmayan `showcaseLeadId` seçer; `REQUEST_NOT_REMOVABLE` mesajı yalnız MATCHED'ı anar.
- T8: boş gövdeyle reopen `moderationNote`'u temizler (mevcut moderasyon semantiği,
  kaldırma notu `resolutionNote`'ta kalır); rota sırası AppModule import sırasına dayanır
  (tripwire testi var); cursor çapa satırı durum değiştirince sıfırlanır; keyset
  tie-break testsiz; `GET :id/reports` bilinmeyen id'de `[]`.
- T9: hem e-posta hem telefon varken `kind` `email` der (metin yine reddedilir);
  iki `contact-detection.ts` başlık yorumları farklı.
- T10: `positiveInt` yardımcısı üç kopya.
- T11: `CLOSED_OFFER_TEXT` noktalaması teklif detayı ile offers-view arasında farklı.
- T12: `[id]/page.tsx` ~210 satır büyüdü; gerekçe etiket tabloları API'den kopya (drift
  kontrolü yok); `scheduler-*` CSS adları yeniden kullanıldı; `.report-item`'da literal renk.
- T13: `report-received` testid rozet + bildirim çift görev; anahtar paylaşımlı satırı
  `workers: 1`'e dayanır.
- T14 (bu rapor): kaldırılmış talepte teklif 404 / accept 409 / withdraw 409 / mesaj 404
  için ayrı API testleri eklenmedi (E2E + mevcut durum bekçileri); OperationsSettings
  yerelde boş olduğundan "her satırda false" ikinci dry-run kopyasında elle eklenmiş
  satırla kanıtlandı.

## 9. Doğrulama sonuçları (HEAD `468919af` + bu docs commit'i)

Kök, `DATABASE_URL` yerel `taktic` (API testi kendi `taktic_13fccaacc0_test` DB'sini
türetir; E2E `taktic_e2e`):

| Komut | Sonuç | Süre |
|---|---|---|
| `pnpm typecheck` | 5/5 task ✓ | 8.6 s |
| `pnpm build --force` | api + web + admin ✓ (cache'siz) | 13.9 s |
| `pnpm --filter @taktic/api test` | **108 dosya / 2213 test** ✓ | 7 dk 33 s (vitest 452.7 s) |
| `pnpm --filter @taktic/shared test` | **5 / 119** ✓ | 0.15 s |
| `pnpm --filter @taktic/web test` | **17 / 111** ✓ | 0.45 s |
| `pnpm --filter @taktic/admin test` | **3 / 47** ✓ | 0.26 s |
| `pnpm e2e` (tam Chromium, prepare-database dahil) | **232 / 232** ✓ | 7.5 dk |
| `pnpm e2e:webkit` (WebKit projesi) | **79 / 79** ✓ | 2.9 dk |

Birim/entegrasyon toplamı: 133 dosya / **2490 test** (kimlik gate teslimindeki 2329'a
göre +161). E2E'de yeni 5 senaryo (auto-publish ×2, report-flow ×2, contact-filter ×1)
Chromium ve WebKit `testMatch`'inde.

## 10. Ekran görüntüleri

`docs/superpowers/plans/2026-09-14-request-auto-publish-screens/` (1440 px, tam sayfa;
E2E runtime'ı üzerinde tek seferlik, commit'lenmemiş bir Playwright spec'i ile çekildi):

- `01-admin-operations-settings-auto-publish-off.png` — Operasyon ayarları, anahtar kapalı
- `02-admin-operations-settings-auto-publish-on.png` — aynı kart, anahtar açık
- `03-customer-success-published.png` — müşteri başarı sayfası "Talebiniz uygun hizmet
  verenlere iletildi" (`published=1`)
- `04-provider-request-report-dialog.png` — provider talep detayı, "Talebi bildir"
  diyaloğu açık (gerekçe + not)
- `05-provider-request-report-received.png` — rapor sonrası "Bildiriminiz alındı" rozeti
- `06-admin-report-queue.png` — Talep bildirimleri kuyruğu, bir satır
- `07-admin-request-detail-report-decisions.png` — admin talep detayı: Bildirimler bloğu,
  "Uygun bulundu" ve "Talebi kaldır" formları (+ durum yönetiminde "Reddet")
- `08-admin-request-detail-removed-reopen.png` — kaldırma sonrası "Reddedildi" ve
  "Talebi geri aç"
- `09-provider-offer-detail-closure-notice.png` — provider teklif detayı "Kapatıldı" +
  kapatma notu
- `10-customer-offers-removed.png` — müşteri teklif sayfası, talep "Reddedildi", teklifler
  kapalı
