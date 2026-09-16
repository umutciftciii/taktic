# REQ-UX-001–005 — Talep/teklif UX paketi (tasarım)

Tarih: 2026-09-16 · Taban: `origin/main` @ `16b5c703`

## 0. Doğrulanan mevcut sözleşme

| Konu | Bugün |
| --- | --- |
| Tarih | `ServiceRequest.preferredDate DateTime?` tek alan; API `new Date(str)` ile parse eder, gün/zaman dilimi kuralı yok. Form `<input type=date name=preferredDate>`. Taslak payload'ında `preferredDate` (string). |
| Hedefli talep | Yalnız vitrin lead: `POST /showcase/cards/:cardId/leads` → `ServiceRequest.directShowcaseProviderId` + `ShowcaseLead` (SLA snapshot, `urgencyBucket`, **gönderim öncesi zorunlu telefon doğrulaması**, rate limit). `POST /service-requests` hedef kabul etmez; lead'siz `directShowcaseProviderId` servis yorumuyla yasak. |
| Başarı sayfası | `/requests/success?id&published=1`; `published` formun raporu. Misafir gönderimde oturum yok (AUTO_CREATED_REQUEST hesabı; aktivasyon maili best-effort). Tekil müşteri endpoint'i yok; `/service-requests/my` liste var. |
| Teklif listesi | `listRequestOffers` projeksiyonunda `viewedAt` yok (yalnız detayda). VIEWED teklif geri çekilebilir. |
| Teklif tutarı | Provider paneli `type=number` + `parseDecimalToMinor` (float çarpımı). Ortak lira parser `apps/web/lib/lira-input.ts` (`BudgetFields` kullanır). |
| Landing | `Admin onayından sonra talepleri gör` yalnız `apps/web/app/page.tsx:452`. |
| Ortak paket | `@taktic/shared` web/admin'e açık; **API import edemez** (boot hatası) → API tarafı date-only yardımcıları API içinde yaşar. |

## 1. REQ-UX-001 — Talep başarı ekranı

### API (additive)
- `GET /service-requests/my/:id` — `AuthGuard + Roles(CUSTOMER)`. Servis: `getCustomerServiceRequest(customerId, id)`; `where: { id, customerId }` bulamazsa `NotFoundException` (başkasının talebi ile olmayan talep aynı 404). Projeksiyon `listCustomerServiceRequests` ile **aynı** select/`toCustomerServiceRequest` mapper'ından geçer (liste/detay ayrışmaz). Provider/admin → RolesGuard 403, oturumsuz → 401 (mevcut guard davranışı).
- `issueForAutoCreatedCustomer(customerId, { redirectTo: '/requests/${id}/offers' })` — aktivasyon linki açılıp şifre kurulunca oturum kurulur ve müşteri kendi teklif ekranına düşer (mevcut `safeRedirectPath` süzgeci).

### Web `/requests/success?id=…`
- `id` yok veya cuid biçiminde değil → `notFound()`.
- Form artık `published` param'ı **yazmaz**; sayfa hiçbir durumu URL'den okumaz.
- Oturumlu `CUSTOMER`: `fetchOrNotFound(GET /service-requests/my/:id)`; 404 → `notFound()`. Render:
  - `showcaseLead` varsa (hedefli talep): eyebrow `TALEP İLETİLDİ`, başlık `Talebiniz {işletme} işletmesine iletildi`, metin: yalnız bu işletmeye iletildi, genel pazara açılmadı; SLA saati.
  - `APPROVED`: eyebrow `TALEP YAYINLANDI`, başlık `Talebiniz yayınlandı`, metin: bölgenizdeki uygun hizmet verenler şimdi teklif verebilir; 14 gün.
  - Diğer (`SUBMITTED`, `IN_REVIEW`): mevcut ön inceleme metni.
  - CTA'lar: Teklifleri görüntüle / Taleplerim / Kategorilere dön (mevcut).
- Oturumsuz: **nötr makbuz** — eyebrow `TALEP ALINDI`, başlık `Talebiniz alındı`, referans `#XXXXXX` (id'den türetilir, DB okunmaz), metin `Talebiniz işleme alındı. Gelişmeleri hesabınızı etkinleştirdikten sonra takip edebilirsiniz.`, `Hesabınızı etkinleştirmeniz için e-posta adresinize bir bağlantı gönderdik; e-postanızı kontrol edin.` CTA: `Ana sayfaya dön`; not: bağlantı gelmediyse `/register/customer` (aynı e-posta ile kayıt → aktivasyon linki yeniden gönderilir). Hiçbir API çağrısı yok; durum/hedef/teklif iddiası yok.
- Oturumlu ama `CUSTOMER` değil (provider/admin): `notFound()`.

### Testler
- API: sahibi 200 + projeksiyon eşitliği; başka müşteri 404; olmayan id 404; provider 403; oturumsuz 401.
- E2E: auto-publish açık → `Talebiniz yayınlandı`; kapalı → ön inceleme; misafir → nötr makbuz + metinde `yayın/onay/teklif` iddiası yok; başka müşterinin id'si → 404 yüzeyi; uydurma id → 404; vitrin lead'li talep id'si (fixture) → hedefli metin. `journeys.ts` yardımcıları URL'de `published` beklemez.

## 2. REQ-UX-002 — Aciliyet ve tarih aralığı

### Veri
- Migration `20260916130000_add_service_request_preferred_date_end`: `ALTER TABLE "ServiceRequest" ADD COLUMN "preferredDateEnd" TIMESTAMP(3);` — additive, backfill yok. `preferredDate` = başlangıç (eski satırlar: başlangıç var, bitiş NULL → tek gün olarak okunur).
- Dry-run: izole throwaway DB'de `prisma migrate deploy`; pre/post `count(*)` + `md5(string_agg(id order by id))` parmak izi. Gerçek DB'ye komut yok.

### Date-only kural (tek kaynak)
- Değer biçimi her yerde `YYYY-MM-DD`. Saklama: `new Date('YYYY-MM-DD')` (UTC gece yarısı — eski satırlarla aynı biçim); okuma: `formatIsoDay(value)` (Europe/Istanbul) → aynı gün. `formatDate` zaten Istanbul ile basar.
- "Bugün" = `formatIsoDay(now)` Europe/Istanbul ile; sunucunun UTC günü **kullanılmaz**.
- Haftanın pazarı: date-only string üzerinden `Date.UTC` aritmetiği (`(7 - getUTCDay()) % 7` gün ekle).
- Web/admin: `@taktic/shared` → `datetime.ts`'e `todayIsoDay(now)`, `addIsoDays`, `endOfWeekIsoDay`, `isIsoDay`, `formatDateRange(start,end)` (eşit/uçsuz → tek tarih). API: `apps/api/src/common/date-only.ts` aynı fonksiyonlar (import kısıtı; birebir kopya, spec ile kilitli).

### API doğrulama (`CreateServiceRequestDto` + servis)
- DTO: `preferredDate?: string|null`, **yeni** `preferredDateEnd?: string|null` (`@IsOptional @IsString`). Servis `normalizePreferredDateRange(dto, now)`:
  - ikisi de boş → `{start:null,end:null}` (her aciliyet için geçerli; eski istemcilerle uyumlu).
  - biri dolu biri boş → 400 `Tarih aralığının iki ucu da girilmeli`.
  - `YYYY-MM-DD` değil / takvimde yok → 400 `Geçerli bir tarih girin`.
  - `start < today` → 400 `Geçmiş tarih seçilemez`.
  - `start > end` → 400 `Başlangıç tarihi bitişten sonra olamaz`.
  - `urgency=TODAY` ve (start≠today veya end≠today) → 400 `Bugün seçildiğinde tarih aralığı bugün olmalı`.
  - `urgency=THIS_WEEK` ve end > bu haftanın pazarı → 400 `Bu hafta seçildiğinde bitiş tarihi haftanın pazarını geçemez`.
  - `FLEXIBLE`/boş/eski kodlar: aralık serbest (geçerli ve gelecekte).
- Vitrin lead aynı DTO'yu genişlettiği için aynı kural otomatik uygulanır.
- Kalite skoru değişmez (`preferredDatePresent` başlangıca bakar).
- Taslak: `RequestDraftPayloadDto` + web `RequestDraftPayload` → `preferredDateEnd?: string` (JSON, migration yok).

### Projeksiyonlar
- Provider talep detayı / teklif detayı, admin talep detayı, müşteri talep listesi (`CustomerServiceRequest`'e `preferredDate/End` eklenir), e-posta özetleri (`transactional-templates.ts` `formatDate(preferredDate)` → aralık formatı): `preferredDateEnd` eklenir, `formatDateRange` ile basılır.

### Form (`TimingFields`, `apps/web/app/request-fields/timing-fields.tsx`)
- `UrgencySelect` + `Başlangıç tarihi` + `Bitiş tarihi` (`type=date`, `min=today`), tek client bileşeni; iki form (marketplace + vitrin lead) aynı bileşeni kullanır.
- Aciliyet değişince: `TODAY` → ikisi bugün; `THIS_WEEK` → bugün..pazar; `FLEXIBLE` → alanlar boşaltılmaz, yardım metni "İsteğe bağlı: tarih vermezseniz esnek kabul edilir"; aynı aciliyet yeniden seçilirse varsayılan yeniden uygulanır (select `onChange` her seçimde çalışır; aynı değer için `onClick`/yeniden seçme: seçili option tekrar seçildiğinde `change` tetiklenmez → yanında `Varsayılan aralığı uygula` düğmesi eklenir; klavye/erişilebilirlik için de gereklidir).
- Tarayıcı ön doğrulaması: `setCustomValidity` ile start>end, tek uç; API kural sahibi.
- Payload builder: `preferredDate`, `preferredDateEnd`. Taslak restore iki alanı da doldurur.

### Testler
- shared `datetime.spec.ts`: pazar başlangıç (2024-09-15 Pazar → aynı gün), ay sınırı (2026-09-30 Çarşamba → 2026-10-04), yıl sınırı (2026-12-30 → 2027-01-03), TR gün değişimi (`2026-09-14T21:30:00Z` → today `2026-09-15`).
- API `request-preferred-date-range.spec.ts`: yukarıdaki her ret + kabul; eski tek tarihli satır GET projeksiyonunda `preferredDateEnd: null`.
- web `service-request-payload.spec.ts` iki alan; E2E: TODAY/THIS_WEEK otomatik doldurma, tekrar uygulama, düzenlenmiş aralık DB'de gün kaymasız.

## 3. REQ-UX-003 — İşletme seçme kartları (hand-off)

### Bileşen `ProviderChoiceCard` (`apps/web/app/request-fields/provider-choice-card.tsx`)
- `fieldset role=radiogroup aria-labelledby` içinde her kart bir `<label>` + görsel olarak gizli `<input type=radio name=showcaseCardId value=cardId>`; ek seçenek `Genel talep olarak devam et` (`value=""`, varsayılan seçili). Seçili kart `data-selected` + belirgin çerçeve; klavye ok tuşlarıyla gezilir (native radio).
- Kart içeriği: işletme adı, kategori (`card.category.name`), hizmet bölgesi (`areas`), yanıt taahhüdü (`Acil {u} sa · Normal {n} sa dönüş`), `reviewSummary` **yalnız non-null ise** `RatingSummaryLine`. Açıklama/fiyat/görsel yok.
- Seçim yapılınca kart altında: `Talebiniz yalnız {işletme} işletmesine iletilir; genel pazara açılmaz.`
- 320–1440 tek sütun → 2 sütun grid; yatay taşma 0 (E2E ölçüm).

### Akış
- `showcaseCardId` state'i formda; seçili kartla son adımdaki ana CTA `Seçili işletmeye devam et` (`type=button`). Tıklama `handOffToShowcaseAction(formData)` çağırır:
  1. Sunucuda kartı yeniden doğrula: `GET /showcase/feed?categoryId&city&district[&neighborhood]` sonucunda `cardId` yoksa → `{ ok:false, code:'SHOWCASE_CARD_UNAVAILABLE' }` (kart artık yayında değil / kapsam dışı). Hiçbir şey kaydedilmez; form `Bu işletme artık bu bölge için seçilemiyor. Genel talep olarak devam edebilirsiniz.` gösterir, seçim genel'e döner, tüm alanlar yerinde.
  2. Taslağı `saveRequestDraftAction({ formType:'SHOWCASE_LEAD', categorySlug: card.category.slug, cardId, payload: draftPayloadFromForm(form), identity })` ile kaydet. `identity`: misafir → formdaki telefon/e-posta; oturumlu → `getCurrentUser()` telefon/e-posta (eksikse `{ok:false, code:'HANDOFF_FAILED'}`). `replace:false`; `DRAFT_EXISTS` → mevcut "Evet, geç / Vazgeç" diyaloğu (`draftIntent:'showcase'`), `Evet, geç` → `replace:true`.
  3. `{ ok:true, href:'/vitrin/{cardId}' }` → `router.push`. URL'de yalnız kart id; PII/form içeriği yok (taslak HttpOnly cookie token'ıyla bağlı).
- Vitrin lead formu `readCurrentDraft` ile taslağı bulur (anahtar kart+kategori, hesaba bağlı) ve alanları önceden dolu gösterir; müşteri yalnız `urgencyBucket` + telefon doğrulaması yapar. Vitrin formuna eklenen alanlar (taşınan veri kaybolmasın): `Adres notu`, `TimingFields` (aralık), `BudgetFields`. Hepsi isteğe bağlı; lead DTO zaten bu alanları kabul ediyor.
- `ServiceRequest`/`ShowcaseLead`/SMS/bildirim yalnız vitrin formunun nihai gönderiminde, mevcut kurallarla oluşur.
- Kart değiştirilirse eski taslak anahtarı farklı olduğu için okunmaz; yeni hand-off yeni anahtarla yazar (`replace`).
- **İletişim bilgileri taşınmaz** (varsayım): taslak payload DTO'su iletişim alanlarını bilinçli olarak yasaklar (`forbidNonWhitelisted`); telefon vitrin formunda zaten yeniden yazılıp doğrulanır. Sözleşme değişikliği istenirse ayrı karar.

### Testler
- E2E `request-provider-choice.spec.ts`: kart seçimi CTA metnini değiştirir ve talep göndermez (DB sayısı sabit); hand-off → `/vitrin/{cardId}` tüm alanlar dolu (açıklama, cevaplar, konum, adres notu, tarih aralığı, bütçe, aciliyet); genel'e dönüş → normal gönderim; kart pasifleştirildiğinde güvenli hata + alanlar korunur; klavye (Tab/ok) seçimi; 320/768/1024/1440 taşma 0; review anahtarı kapalı → puan yok.

## 4. REQ-UX-004 — Teklif deneyimi

### Müşteri
- API `listRequestOffers` projeksiyonuna `viewedAt` (additive); web `RequestOfferPreview.viewedAt`.
- Liste (`/requests/[id]/offers` Geçmiş bölümü): `status==='WITHDRAWN' && viewedAt` → satırda `role=status` uyarı `Bu teklif hizmet veren tarafından iptal edilmiştir.` (iade metni yok). Görüntülenmemiş geri çekilmiş satır bugünkü nötr biçimde kalır.
- Detay: `WITHDRAWN && viewedAt` → sayfa başında aynı uyarı (`data-testid=offer-withdrawn-notice`); kabul/eşleşme CTA'sı zaten `actionable=false` — test ile sabitlenir.
- E2E `offer-withdrawal.spec.ts` genişletilir: görüntüle → geri çek → liste+detay uyarısı, CTA yok; görüntülenmemiş geri çekme → uyarı yok; kabul edilmiş teklif regresyonsuz.

### Hizmet veren talep detayı
- `İade durumu` rozeti: `.pdash-badge`/refund badge sınıfına `white-space: normal; max-width: 100%; display: inline-flex; line-height` ve `cdash-meta-list dd` içinde kendi satırı (`display:block`). 320'de kesilme/taşma yok (E2E ölçüm).
- Tutar alanı: `OfferPriceField` (client) — `LiraInput` `budget-fields.tsx`'ten `request-fields/lira-input.tsx`'e taşınır ve iki yerden kullanılır. Görünüm `₺` ön eki + `4.500,00`; blur'da `completeLiraAmount`. Action: `parseLiraToMinor` (mevcut, float yok) → API'ye kuruş integer (mevcut sözleşme). Boş/negatif/geçersiz ondalık (`12.50`), binlikli (`4.500`), virgüllü (`4500,5`) → unit test (`lira-input.spec.ts` genişletilir) + E2E gönderim (`4.500,00` → DB `450000`).

### Hizmet veren “Tekliflerim”
- `offers-table.tsx`: `minWidth:800` kaldırılır; `table-layout: fixed` sütun genişlikleri; işlem sütunu sabit genişlik, içinde 3 slotlu `grid` (`Teklif detayı` ana CTA daima; `Talep`, `Geri çek` uygunsa; boş slot `aria-hidden` yer tutucu → ritim sabit). `≤768px`: CSS ile satırlar karta döner (`display:block`, `td::before{content:attr(data-label)}`), işlem alanı tam genişlik dikey.
- E2E `provider-offers-table-viewport.spec.ts`: 320/768/1024/1440'ta `document.documentElement.scrollWidth <= window.innerWidth` ve tablo kapsayıcısında `scrollWidth <= clientWidth`; ekran görüntüleri artefakt.

## 5. REQ-UX-005 — Landing metni
- `apps/web/app/page.tsx:452` → `Talepleri gör`. Başka yüzeyde aynı ifade yok (repo taraması). `landing-hero.spec.ts` varsa assertion güncellenir.

## 6. Kapsam dışı / riskler
- Ödeme, scheduler, compose, env, Cloudflare/Lemon/Resend dokunulmaz. Teklif durum makinesi, kredi/iade, review eşikleri değişmez.
- Hand-off yarışı: kart, action doğrulaması ile vitrin sayfası yüklenmesi arasında düşerse müşteri vitrin 404'ünü görür; taslak cookie'si durur (24 sa) ve aynı kart geri gelirse yeniden okunur. Kabul edilen küçük pencere.
- Misafir makbuzda referans id'den türetilir (bugünkü davranış); gerçek `requestNumber` oturumla görülür.
- `THIS_WEEK` haftası Pazartesi–Pazar; Pazar günü açılan talepte aralık tek gün olur (test edilir).

## 7. Teslim
`pnpm typecheck && pnpm lint && pnpm test && pnpm build`, Chromium + WebKit E2E, migration dry-run raporu, 320/768/1024/1440 ekran görüntüleri, PR (merge yok), CI 3 iş.
