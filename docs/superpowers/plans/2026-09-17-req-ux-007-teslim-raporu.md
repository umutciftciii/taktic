# REQ-UX-007 — Transactional e-postalarda koyu mod ve istemci uyumu — Teslim Raporu

Tarih: 2026-09-17 · Branch: `claude/transactional-email-dark-mode-26ecb1` (taban `main` @ `7ee6d21b`) · PR: _(aşağıda)_ · Merge: **yapılmadı**

Migration yok. Şablon metinleri, alıcılar, gönderim/dedupe/outbox mantığı, URL'ler, bildirim semantiği, plain-text gövde, asset dosyaları, `.env`/compose/Dockerfile, Turnstile, ödeme/SMS/e-posta gönderici entegrasyonu ve web/admin ekranlarına dokunulmadı. Değişen üretim kodu tek dosya: ortak e-posta shell'i.

## Kök neden

Bütün transactional HTML e-postalar tek shell'den çıkar: `apps/api/src/modules/notifications/templates/email-design.ts › renderHtml()`. 45 şablonun tamamı `transactional-templates.ts › buildDocument()` → `renderDocument()` yolunu izler; başka HTML üreticisi yok (`email-template.ts` yalnız sarmalayıcı, eski plain renderer kaldırılmış).

Shell `<meta name="color-scheme" content="light dark">` ile koyu moda **opt-in** yapıyordu ama:

1. tek bir `@media (prefers-color-scheme: dark)` kuralı yoktu — opt-in'i onurlandıran istemci (Apple Mail ailesi) kendi koyu kanvasını basınca metinler inline `#201e1d` kalıyordu;
2. sayfa/kart zemini yalnız `style="background-color"` ile verilmişti, `bgcolor` attribute'u yoktu — `style`'ı kısmen düşüren ya da yeniden yazan istemcide açık zemin kaybolup metin koyu kalıyordu;
3. Outlook'un `data-ogsc`/`data-ogsb` yeniden yazımı ve Gmail'in otomatik dönüşümü için düzeltme yazılacak sınıf kancası yoktu.

Kısacası: opt-in var, sözleşmenin gerisi yok. Bu, hiç opt-in yapmamaktan daha kötü bir durumdur.

## Çözüm — üç katman, tek kaynak

Yalnız `email-design.ts` değişti; 45 belge shell'i miras aldığı için her aile otomatik kapsandı.

**Katman 1 — açık mod fallback (her istemci).** `<body>`, sayfa hücresi, kart tablosu, üst bant, 2px ayraçlar ve CTA hücrelerinde `bgcolor` attribute'u + inline `background-color`; her metin taşıyan öğede (`p`, `h1`, `a`, veri tablosu hücreleri) inline `color`. Açık görünüm bire bir aynı (mevcut `transactional-email-render.spec.ts`'in tam-dize assertion'ları değişmeden geçiyor).

**Katman 2 — `prefers-color-scheme: dark` destekleyen istemciler.** `:root{color-scheme:light dark;supported-color-schemes:light dark}` + media query altında sınıf tabanlı `!important` override'lar (`dm-page`, `dm-card`, `dm-head`, `dm-rule`, `dm-hair`, `dm-ink`, `dm-muted`, `dm-accent`, `dm-link`, `dm-link-muted`, `dm-cta`/`dm-cta-link`, `dm-ghost`/`dm-ghost-link`). Tema tablosu `EMAIL_THEME` olarak dışa açıldı:

| Rol | Açık | Koyu | Kontrast (koyu) |
| --- | --- | --- | --- |
| Sayfa zemini | `#e7e5e3` | `#121110` | — |
| Kart / içerik yüzeyi | `#ffffff` | `#242120` | — |
| Üst (logo) bandı | `#ffffff` | `#ffffff` (bilerek sabit) | — |
| Metin / başlık | `#201e1d` | `#f3f1ef` | 14.6:1 |
| İkincil metin / footer | `#6b6663` | `#b3aca8` | 7.0:1 |
| Kart çerçevesi + 2px ayraç | `#201e1d` | `#f3f1ef` | 14.6:1 |
| İnce çizgi (veri tablosu) | `#d5d1ce` | `#3f3b38` | 1.6:1 (dekoratif) |
| Vurgu (kicker) | `#ec3013` | `#ff5a3c` | 5.1:1 (açıkta 4.2:1 — tasarımın kendi değeri, dokunulmadı) |
| CTA primary | `#ec3013` / `#ffffff` | aynı | 4.2:1 (bold) |
| CTA ghost | `#fbfafa` + mürekkep | `#242120` + `#f3f1ef` | 14.6:1 |
| Linkler | mürekkep / ikincil | `#f3f1ef` / `#b3aca8` | 14.6 / 7.0 |

Logo: mevcut PNG siyah mürekkep + **opak beyaz plaka** (dosya analiziyle doğrulandı). Yeni dosya üretilmedi; üst bant iki temada da beyaz kalıyor, böylece logo her zaman kendi plakasında duruyor ve koyu kartın üstünde tanımlı bir marka alanı oluşuyor. Bant üzerindeki "HİZMET ALAN" etiketi bu yüzden `dm-*` almıyor (beyaz bantta ikincil renkte kalır).

**Katman 3 — istemciye özgü dönüşümler.** Outlook (outlook.com / yeni Outlook uygulamaları) media query'yi yok sayar, renkleri kendi yeniden yazar ve değiştirdiği öğeleri `data-ogsc` (renk) / `data-ogsb` (zemin) ile işaretler; aynı `dm-*` kuralları `[data-ogsc] .dm-*` / `[data-ogsb] .dm-*` altında bir kez daha bağlandı. Bu, shell'deki **tek** istemciye özgü CSS'tir; MSO koşulu eklenmedi (mevcut font bloğu yeter). Gmail için (aşağıda) Katman 1 yeterlidir.

## Apple Mail / Outlook / Gmail — yaklaşım ve sınırlar

Bu istemcilerin render motorları yerelde **emüle edilemez**; aşağıdaki kanıt Chromium'da alınmıştır ve her istemci için kalan kontrol gereksinimi açıkça yazılmıştır.

| İstemci | Davranış | Kullanılan teknik | Yerel kanıt | Kalan kontrol |
| --- | --- | --- | --- | --- |
| Apple Mail (macOS/iOS) | `color-scheme` meta'sını onurlandırır, `prefers-color-scheme` destekler | Katman 2 (media query + `!important` sınıf override) | `*--dark.png` (Chromium `colorScheme: dark`) — hesaplanan renkler tema tablosuyla birebir | Gerçek cihazda macOS Mail + iOS Mail koyu mod görsel onayı |
| Outlook (outlook.com, yeni Windows/Mac/mobil) | Media query yok; renkleri yeniden yazar, `data-ogsc`/`data-ogsb` ekler | Katman 3 (`[data-ogs*]` re-bind) + Katman 1 | `*--outlook-rebind.png` (media bloğu silinip `<body>`'ye `data-ogsc data-ogsb` verilerek) — koyu tema devreye giriyor | Litmus/Email on Acid veya gerçek Outlook.com koyu tema; Outlook'un hangi öğeleri işaretlediği sürüme göre değişir |
| Outlook Windows (Word motoru) | Media query yok; kısmi inversiyon; `bgcolor` ve inline renkleri kullanır | Katman 1 (`bgcolor` + inline `color`), mevcut MSO font bloğu | `*--attrs-only.png` (`<style>` ve inline `background-color` tamamen silinmiş, yalnız attribute) — açık zemin + koyu metin korunuyor | Gerçek Outlook 2019/365 koyu mod |
| Gmail (web) | Koyu temada içerik renklerine dokunmaz; `prefers-color-scheme` desteklemez | Katman 1 — açık görünüm aynen | `*--light.png` | Gmail web'de açık render doğrulaması |
| Gmail (Android kısmi / iOS tam inversiyon) | Zemin ve metni birlikte çevirir; renk inline ve eşleşik tanımlıysa kontrast korunur | Katman 1 — her yüzeyde zemin, her metinde renk inline | `*--attrs-only.png` (metin rengi hiçbir yerde kalıtım yoluyla gelmiyor; birim test her `p/h1/a`'da inline renk ister) | Gerçek Gmail Android/iOS koyu mod; inversiyon algoritması belgelenmemiştir |

Yalnız Apple Mail'e özgü bir çözüm değildir: Katman 1 istemciden bağımsızdır, Katman 3 Outlook'a özeldir, Katman 2 media query destekleyen tüm istemcileri (Apple Mail, Outlook for Mac/iOS, Samsung Mail, Thunderbird) kapsar.

## Testler

**Yeni: `apps/api/test/transactional-email-dark-mode.spec.ts` (374 test)** — önce RED (`EMAIL_THEME` yok → import düşer; tema eklenince 7 grup × 45 şablon assertion düşer), sonra GREEN.
- 45 şablonun her biri için: meta çifti + `:root color-scheme`; `bgcolor` fallback'leri (body, sayfa, kart, üst bant, ayraç); her `p/h1/a`'da inline renk; her metin öğesinde `dm-*` kancası; `prefers-color-scheme: dark` bloğunda yüzey/metin/ayraç/CTA/link override'ları; logo bandının iki temada beyaz kalması ve **tek** `<img>` (koyu logo dosyası yok); Outlook `[data-ogsc]`/`[data-ogsb]` re-bind; media bloğu dışına sızan `.dm-` kuralı yok.
- Aile kanıtı: aktivasyon (customer-activation, email-verification, password-reset, provider-claim), telefon doğrulama (request-received `nextStep=verify`), talep/teklif yaşam döngüsü (7 şablon), review/moderasyon (5), ödeme/vitrin (5), destek (2) — her ailenin `<head>`'i (title hariç) referans şablonla **bayt bayt aynı**; kalan şablonlar için de aynı assertion.
- Kontrast: WCAG göreli parlaklık hesabıyla iki temada metin/ikincil ≥ 4.5, vurgu/CTA/yapı ≥ 3, dekoratif çizgiler ayırt edilebilir; koyu vurgu ≥ 4.5 ve açık vurgudan farklı; açık tema token'ları tasarımın değerleriyle birebir.

**Mevcut `transactional-email-render.spec.ts` (470)** değişmeden geçiyor — açık görünümün korunduğunun kanıtı.

## Kalite kapıları

| Komut | Sonuç |
| --- | --- |
| `pnpm typecheck` | geçti (worktree'de önce `pnpm db:generate` gerekti — eski Prisma client, bu PR'dan bağımsız) |
| `pnpm lint` | geçti |
| `pnpm test` | shared 165, admin 49, web 153, API 2938/2938 (125 dosya) geçti |
| `pnpm build` | geçti |
| E2E | **Etkilenmiyor**: E2E'nin kullandığı `file-outbox-notification.adapter.ts` ve `console-notification.adapter.ts` `renderEmail`'i hiç çağırmaz; HTML yalnız `resend-notification.adapter.ts`'te üretilir. Yerelde koşulmadı; CI'daki iki E2E işi PR üzerinde koşar. |
| CI | _(PR açıldıktan sonra aşağıda)_ |

## Görsel kanıt (Chromium 700px, `docs/superpowers/plans/2026-09-17-req-ux-007-screens/`)

Altı aile temsilcisi × dört varyant: `customer-activation`, `email-verification`, `request-received` (telefon doğrulama varyantı), `offer-received`, `review-invitation`, `showcase-package-payment-succeeded`.

| Varyant | Ne emüle eder | Dosya |
| --- | --- | --- |
| `--light` | Açık mod / Gmail web | `<şablon>--light.png` |
| `--dark` | `prefers-color-scheme: dark` (Apple Mail ailesi) | `<şablon>--dark.png` |
| `--attrs-only` | `<style>` ve inline `background-color` tamamen silinmiş; yalnız attribute + inline `color` (Katman 1) | `<şablon>--attrs-only.png` |
| `--outlook-rebind` | Media bloğu silinmiş, `<body data-ogsc data-ogsb>` (Katman 3) | `<şablon>--outlook-rebind.png` |

`computed-colors.json`: her varyantta sayfa/kart/başlık/metin/ikincil/kicker/CTA hesaplanan renkleri. `html/`: altı şablonun render edilmiş HTML'i — fixture verisi (`example.test`), token yok, gerçek bağlantı/PII yok.

## Değişen dosyalar

- `apps/api/src/modules/notifications/templates/email-design.ts` — `EMAIL_THEME` (+`EmailTheme`), `darkModeCss()`, `bgcolor`/sınıf kancaları; belge yorumu güncellendi
- `apps/api/test/transactional-email-dark-mode.spec.ts` (yeni)
- `docs/superpowers/specs/2026-09-17-req-ux-007-email-dark-mode-design.md` (yeni)
- `docs/superpowers/plans/2026-09-17-req-ux-007-teslim-raporu.md`, `docs/superpowers/plans/2026-09-17-req-ux-007-screens/**`

## Açık riskler

- Gerçek istemci renderi doğrulanmadı (yukarıdaki tablo). En belirsiz olan Gmail mobil inversiyonudur: algoritma belgelenmemiştir; Katman 1 sektör pratiğidir ama garanti değildir. Merge öncesi/sonrası bir Litmus/Email on Acid turu ya da gerçek cihaz kontrolü önerilir.
- Koyu modda beyaz logo bandı bilinçli bir görsel karardır; ürün "koyu bant + koyu logo" isterse bu yeni bir asset gerektirir ve kapsam dışıdır.
- Açık moddaki vurgu rengi (`#ec3013` beyazda 4.2:1) tasarımın kendi değeridir ve değiştirilmedi; koyu modda 5.1:1'e çıkarıldı.
