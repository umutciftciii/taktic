# VIT-003 — Doğrudan vitrin talebi formu kanonik talep formuyla birleştirildi; `SHOWCASE_LEAD_FAILED` düzeltildi: teslim raporu

Dal: `claude/showcase-lead-canonical-form-17f446` (main ile ortak taban `d63b3dbb`).
Tek PR. **Migration yok** (`prisma/migrations` son girdi hâlâ
`20260912090100_add_phone_verification_test_bypass_flag`), **yeni bağımlılık yok**,
Lemon/Resend/Cloudflare/`.env`/compose dosyalarına dokunulmadı.

## 1. `SHOWCASE_LEAD_FAILED` kök nedeni

### Yeniden üretim (yerel Docker stack, gerçek form)

1. Kanonik değerlerle (`İstanbul` / `Kadıköy`, mahalle boş) hem doğrudan API
   çağrısı (`POST /showcase/cards/:id/leads` → **201**) hem eski web formu başarılı
   oldu. Yani API akışı değil, **gönderilen değer** kırıyordu.
2. Aynı payload'da serbest metin alanlara gerçek kullanıcı girdisi konunca:

   | Girdi | API yanıtı |
   |---|---|
   | `district: "Kadikoy"` (Türkçe karaktersiz) | `400 {"message":["Seçilen il, ilçe ve mahalle birlikte geçerli bir adres oluşturmuyor."],"error":"Bad Request"}` |
   | `neighborhood: "Caferağa"` | aynı 400 |
   | `neighborhood: "Caferağa Mahallesi"` | aynı 400 |
   | `neighborhood: "Caferağa Mah"` (kanonik ad) | 201 |

3. Eski tarayıcı formunda `Caferağa` yazıp gönderince URL
   `?error=SHOWCASE_LEAD_FAILED` oldu; ad/e-posta/açıklama kayboldu (yalnız konum
   query string'de taşınıyordu); `ServiceRequest`/`ShowcaseLead`/`NotificationLog`
   sayıları değişmedi (12/2/46 → 12/2/46). API tarafında hiçbir log yoktu.

### Zincir

- Eski form ilçe ve mahalleyi **serbest metin** `input` olarak topluyordu
  (`page.tsx › LeadForm`, "server-rendered form with no client bundle" gerekçesiyle).
- `CreateShowcaseLeadDto extends CreateServiceRequestDto`; `city` üzerindeki
  `@IsKnownTurkishLocation()` üçlüyü **ilişki** olarak doğrular ve yalnız
  `turkey-neighbourhoods` paketindeki kanonik yazımları kabul eder (`"Caferağa Mah"`,
  `"Kadıköy"`). Büyük/küçük harf ve `ı/i` katlanır; eksik `ö/ğ` ya da `Mahallesi`
  eki katlanmaz.
- Nest `ValidationPipe` bu reddi `code` alanı olmadan (`message: string[]`) döner.
- Web action `errorCode()` yalnız `code` okuyordu → her DTO reddi
  `SHOWCASE_LEAD_FAILED` genel koduna düşüyordu; sunucu logu yoktu.
- Aynı yol, sorusu olan bir kategoriye bağlı kart için de geçerliydi: eski form
  `answers: []` gönderiyordu; kategoride zorunlu soru varsa API `Missing required
  answer` (400, kodsuz) → yine `SHOWCASE_LEAD_FAILED`.
- İkincil hata (kod okunarak bulundu, API testiyle kanıtlandı): oturum açmış bir
  **müşteri** için `createLead` `dto.customerPhone`'u okuyordu; hesap yolunda gövde
  iletişim alanı taşımadığı için `normalizePhoneNumber('')` → 400 (kodsuz).

### Düzeltme ve nedeni

- Serbest metin kaldırıldı; konum, normal talep formunun **aynı** bağlı
  `LocationFields` bileşeniyle (aynı `/locations/provinces` + `/api/locations/neighborhoods`
  kaynağı, aynı `request-city/district/neighborhood` test id'leri) seçiliyor. Kanonik
  olmayan bir yazım artık formdan çıkamaz.
- Kategorinin soruları (`/categories/:slug`) normal formdaki `RequestField` ile
  render ediliyor; `questionMeta` + `answer_*` sözleşmesi ortak.
- Web action artık 4xx yanıtın `message`'ını kullanıcıya iletiyor, `code`'u
  varsa onu kullanıyor ve sunucu logunda `status/code/message` bırakıyor
  (`[vitrin lead] cards/<id>/leads: API refused with 409 code=SHOWCASE_LEAD_AREA_NOT_SERVED …`).
  Kullanıcının yazdığı hiçbir şey loglanmıyor. 5xx gövdesi kullanıcıya gösterilmiyor.
- API: `ShowcaseLeadService.createLead` telefonu normal akışın kanonik
  `ServiceRequestsService.resolveContactDetails` kuralıyla çözüyor (hesap yolunda
  hesabın numarası, aksi hâlde gövdedeki numara); metot `private` → public.

## 2. Tek kaynak: ortak bileşenler ve kaldırılan duplicate kod

### Yeni ortak modüller (`apps/web/app/request-fields/`, `apps/web/lib/`)

| Modül | İçerik | Kullananlar |
|---|---|---|
| `lib/service-request-payload.ts` | `buildServiceRequestPayload(formData)` — form → `POST /service-requests` gövdesi (konum, zamanlama, iletişim, disclosure, `answers`) | `categories/actions.ts`, `vitrin/[cardId]/actions.ts` (+ `urgencyBucket`) |
| `request-fields/location-fields.tsx` | `LocationFields` (taşındı; `initialValue` prop'u eklendi) | RequestForm, ShowcaseLeadForm |
| `request-fields/question-field.tsx` | `RequestField`, `encodeQuestionMeta`, `readAnswers` | RequestForm, ShowcaseLeadForm |
| `request-fields/description-field.tsx` | `DescriptionField` — `maxLength`, sayaç, near/limit durumları, bfcache okuma | RequestForm, ShowcaseLeadForm |
| `request-fields/timing-fields.tsx` | `URGENCY_OPTIONS` (`TODAY/THIS_WEEK/FLEXIBLE`), `UrgencySelect` | RequestForm, ShowcaseLeadForm |
| `request-fields/contact-section.tsx` | `ContactSection` — misafir alanları / hesap özeti / farklı iletişim kişisi; `phoneAddon` yuvası, `phoneLocked` | RequestForm, ShowcaseLeadForm |
| `request-fields/disclosure-field.tsx` | `ContactDisclosureField` (`contactDisclosureVersion` + zorunlu onay) | RequestForm, ShowcaseLeadForm |

### Kaldırılan duplicate kod

- `vitrin/[cardId]/page.tsx`: 360 satır silindi — elle yazılmış `LeadForm`
  (serbest metin ilçe/mahalle, serbest metin "İşi ne zaman yaptırmak istiyorsunuz?",
  kendi ad/e-posta alanları), `LocationCarry`, üç ayrı adım formu (`step=phone/code/form`),
  `AreaNotServed`, `LEAD_ERRORS`.
- `vitrin/[cardId]/actions.ts`: elle kurulan payload (`readString` × 10) yerine
  `buildServiceRequestPayload` + `urgencyBucket`. Redirect tabanlı adımlar yerine
  sonuç döndüren action'lar.
- `categories/[slug]/request-form.tsx`: 403 satır silindi — `RequestField/renderInput`,
  açıklama sayacı, iletişim bölümü, disclosure bloğu, aciliyet select'i ortak
  modüllere taşındı. Davranış ve test id'leri birebir korundu.
- `categories/actions.ts`: 116 satır silindi (`parseQuestionMeta`, `readAnswerValue`,
  `contactFields`, payload kurulumu → ortak modül).

### Eski/yeni payload farkı

| Alan | Eski direct lead | Yeni direct lead (= normal talep + `urgencyBucket`) |
|---|---|---|
| `district` | serbest metin (`"Kadikoy"` mümkün) | kanonik dropdown değeri |
| `neighborhood` | serbest metin (`"Caferağa"`) | kanonik dropdown değeri (`"Caferağa Mah"`) veya `null` |
| `urgency` | serbest metin (`"bu hafta içinde"`) | `TODAY \| THIS_WEEK \| FLEXIBLE \| null` |
| `urgencyBucket` | `URGENT \| NORMAL` (radyo) | aynı — explicit, backend türetmez |
| `answers` | her zaman `[]` | kategorinin görünen sorularından (`questionMeta`) |
| `routerSelections`, `useAlternateContact`, `addressNote`, `budgetMin/Max`, `preferredDate` | yok | ortak builder'dan (`[]`/`false`/`null`) — DTO'da hepsi opsiyonel |
| `contactDisclosureVersion` | yok | disclosure açıkken gönderilir (normal formla aynı) |
| `customerName/Phone/Email` | her zaman gövdede | misafir/farklı kişi: gövdede; oturum açmış müşteri: gönderilmez, API hesaptan okur |
| Kart sahibi/placement/SLA | gönderilmez | gönderilmez (karttan türetilir) |

### Zamanlama ve aciliyet metinleri

- "İşi ne zaman yaptırmak istiyorsunuz?" → kanonik select (Bugün / Bu hafta / Esnek),
  yardımcı metin "İşin kendisi için istediğiniz zaman." Normal formla aynı opsiyonellik.
- "İşletme size ne kadar sürede dönsün? *" → kartın onaylı saatlerinden üretilen iki
  radyo ("Acil — 3 saat içinde dönüş" / "Normal — 24 saat içinde dönüş"), varsayılan
  yok, yardımcı metin "Bu seçim işin zamanı değil, işletmenin size ilk dönüş süresidir."

### Telefon doğrulama

- Kanıt yine talepten **önce**; ancak artık formun içinde, telefon alanının altında
  (`Kod gönder` → kod → `Doğrula` → "Telefon doğrulandı"). Sayfa değişmez; tüm
  alanlar korunur; doğrulanan numara `readOnly` kilitlenir, "Numarayı değiştir"
  kanıtı sıfırlar. Gönder düğmesi doğrulama tamamlanana kadar devre dışı.
- `PHONE_VERIFICATION_TEST_BYPASS_*` sözleşmesine dokunulmadı; `showcase-phone-bypass`
  E2E'si aynı numara/kod ile iki runtime'da aynı sonucu (kabul / red) doğruluyor.
- Oturum açmış müşteri: hesap özeti gösterilir, kanıt hesabın numarasına gönderilir;
  "Farklı bir iletişim kişisi" seçilirse kanıt sıfırlanır ve yeni numaraya bağlanır.

### İletişim paylaşımı

Disclosure açıkken normal formun zorunlu onay kutusu + link + sürüm; kapalıyken
direct lead'in mevcut opsiyonel onay cümlesi. Daha gevşek veya daha geniş bir
paylaşım yaratılmadı.

## 3. Hata davranışı

- `SHOWCASE_LEAD_AREA_NOT_SERVED` (409): form üstünde ret bloğu + "Genel talep
  oluştur" CTA (`/categories/<slug>`) + "Vitrine dön"; form ve doğrulanmış telefon
  yerinde kalır; konum değişince blok kalkar. Kayıt yazılmaz.
- DTO reddi (400, kodsuz): API'nin Türkçe cümlesi kullanıcıya gösterilir; kayıt yok.
- `SHOWCASE_LEAD_PHONE_VERIFICATION_REQUIRED`: mesaj + doğrulama paneli sıfırlanır.
- 403 (hizmet veren oturumu): `SHOWCASE_LEAD_FORBIDDEN` → Türkçe mesaj.
- Beklenmeyen/5xx: genel mesaj; teknik neden sunucu logunda.

## 4. Testler

### Birim / entegrasyon (`pnpm test`, kök): API 2060 · web 84 · shared 97 · admin 39 — hepsi yeşil

- `apps/web/test/service-request-payload.spec.ts` (yeni, 4 test): direct lead
  form verisi → DTO gövdesi; iletişim alanları yalnız render edildiyse; `answers`
  tiplemesi; disclosure yalnız `"true"` ile.
- `apps/api/test/showcase-lead-flow.spec.ts` (+6 test, toplam 31): kanonik olmayan
  ilçe → 400, hiçbir kayıt yok (`ServiceRequest`, `ShowcaseLead`, `NotificationLog`,
  e-posta çağrısı 0); serbest mahalle → 400, kayıt yok; kanonik mahalle → 201;
  zorunlu kategori sorusu eksik → 400, kayıt yok; `urgency: 'THIS_WEEK'` saklanır;
  oturum açmış müşterinin talebi hesabın numarasıyla kanıtlanır ve kanıt talebe bağlanır.
  Mevcut 25 test (yalnız kart sahibi görür, rakip 404, kredi harcanmaz, fan-out yok,
  SLA snapshot) değişmeden geçiyor.

### E2E

- `showcase-placement-lead.spec.ts`: ana senaryo artık **gerçek** akış — karar
  paneli → form → bağlı dropdown'lar (`select[name=district]`, `input[name=district]`
  yok, `input[name=urgency]` yok) → il değişince ilçe temizlenir → `THIS_WEEK` +
  `URGENT` → ad/e-posta/açıklama → telefon → `Kod gönder` → SMS outbox'tan kod →
  `Doğrula` → tüm alanların korunduğu assert edilir → gönder → `showcase-lead-sent`;
  DB'de `ServiceRequest` ve `ShowcaseLead` **+1**, `urgencyBucket=URGENT`,
  `slaHoursSnapshot=3`, kanonik il/ilçe, `urgency=THIS_WEEK`, `phoneVerifiedAt` dolu,
  `directShowcaseProviderId` = kart sahibi. Sonra: sahip panelinde "Acil / 3 saat
  taahhüt", "teklif kredisi harcanmaz", müşteri telefonu görünmez; rakip panelinde
  ve eşleşme listesinde yok.
- Kapsam dışı senaryo: doğrulanmış telefonla gönderim → ret bloğu + CTA çalışır,
  `ShowcaseLead` 0 ve `ServiceRequest` sayısı değişmez, alanlar korunur.
- `showcase-phone-bypass.spec.ts`: URL assert'leri UI durumuna çevrildi
  (`showcase-lead-phone-code` / `-verified` / `-error`); sözleşme aynı.
- `showcase-screens-viewport.spec.ts`: 320/768/1024/1440'ta `public-card-form`
  yakalaması eklendi (dolu form, yatay taşma ≤ 0).

Sonuçlar: aşağıda "Doğrulama" bölümünde.

## 5. UI

- Form, kart detayının sağ panelinde (`.vitrin-public` 2fr/1fr grid, ≥1024px) ve
  mobilde kartın devamında; bölümler 1px çizgiyle ayrılır, tek 2px çerçeve panelde.
  `form-grid` `auto-fit minmax(min(220px,100%),1fr)` ile 320px'te tek kolon.
- Tarayıcıda doğrulandı: 1440px (docW 1440), 320px (docW 320, taşma 0; elemanlar
  viewport dışına çıkmıyor).

## 6. Doğrulama

- `pnpm typecheck` ✓ · `pnpm lint` ✓ · `pnpm test` ✓ · `pnpm build` ✓
- E2E Chromium, tam suite (`pnpm --filter @taktic/e2e e2e`): **204 passed** (6.8 dk), 0 flaky.
- E2E WebKit (`E2E_WEBKIT=1 … --project=webkit`, `showcase-placement-lead`,
  `showcase-phone-bypass`, `showcase-screens-viewport`): **10 passed** (36.5 s) —
  gerçek başarılı direct lead senaryosu iki motorda da geçti.
- Ekran görüntüleri: `e2e/test-results/showcase-screens/public-card-form-{320,768,1024,1440}.png`
  (yatay taşma 0; 320'de tek kolon).
- CI (PR #73, run 34688984278): `typecheck · lint · test · build` ✓, `e2e (chromium)` ✓ (12m40s),
  `e2e (webkit · sign-in and mobile shells)` ✓ (7m42s). PR merge edilmedi.

## 7. Merge sonrası düzeltme — API'nin kodsuz reddi generic mesaja yutuluyordu

Yerelde gerçek denemede (`05322222323` + başka bir müşteriye ait e-posta) ekran yine
"Talebiniz gönderilemedi" gösterdi. Web logu gerçek nedeni yazmıştı:
`API refused with 409 code=- message="Telefon ve e-posta farklı müşteri kayıtlarıyla eşleşiyor."`
— marketplace'in mevcut kimlik kuralı (`resolveCustomerForCreate`), Türkçe cümle,
`code` yok. Hata `refusalText` önceliğindeydi: kodsuz reddin fallback kodu
`SHOWCASE_LEAD_FAILED` tabloda bulunduğu için API mesajının önüne geçiyordu.

- `apps/web/lib/showcase-lead-errors.ts`: öncelik artık *özel kod → API mesajı → generic*;
  generic kod hiçbir zaman mesajın önüne geçmez. 4 birim testi.
- E2E (`showcase-placement-lead.spec.ts`): iki farklı müşteriye ait telefon + e-posta ile
  gönderim → ekranda API'nin kendi cümlesi, `showcase-lead-sent` yok, `ServiceRequest`/
  `ShowcaseLead` değişmez, form ve kanıt korunur.
- Ekrandaki URL (`?step=form&phone=…&error=SHOWCASE_LEAD_FAILED&city=…`) merge öncesi
  eski akıştan kalma bir adres; yeni form URL'ye hata yazmaz, sayfa yine de açılır.
