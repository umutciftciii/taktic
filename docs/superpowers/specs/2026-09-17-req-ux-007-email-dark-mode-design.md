# REQ-UX-007 — Transactional e-postalarda koyu mod ve istemci uyumu — Tasarım

Tarih: 2026-09-17 · Taban: `main` @ `7ee6d21b` · Branch: `claude/transactional-email-dark-mode-26ecb1`

## Sorun

Bütün transactional HTML e-postalar tek shell'den çıkar: `apps/api/src/modules/notifications/templates/email-design.ts › renderHtml()`. Shell `<meta name="color-scheme" content="light dark">` ile koyu moda **opt-in** yapıyor ama:

1. tek bir `@media (prefers-color-scheme: dark)` kuralı yok — opt-in'i onurlandıran istemci (Apple Mail) kendi koyu kanvasını basar, metinler inline `#201e1d` kalır;
2. sayfa zemini yalnız `<body style>` ve `<table style>` ile verilmiş; `bgcolor` attribute'u yok — `style`'ı kısmen düşüren istemcide açık zemin kaybolur, metin koyu kalır;
3. Outlook'un (`data-ogsc`/`data-ogsb`) ve Gmail'in otomatik renk dönüşümüne karşı sınıf kancası yok, dolayısıyla düzeltme yazılacak seçici de yok.

## Karar: üç katman, tek kaynak

Değişiklik yalnız ortak shell'de yapılır; `transactional-templates.ts`'teki 45 belge ve plain-text gövde değişmez.

**Katman 1 — açık mod fallback (her istemci).** Kritik yüzeylere `bgcolor` attribute'u + inline `background-color`; her metin taşıyan öğede inline `color`. Mevcut açık görünüm bire bir korunur (`#e7e5e3` sayfa, `#ffffff` kart, `#201e1d` mürekkep, `#6b6663` ikincil, `#d5d1ce` ince çizgi, `#ec3013` vurgu).

**Katman 2 — koyu modu destekleyen istemciler.** `:root{color-scheme:light dark;supported-color-schemes:light dark}` + `@media (prefers-color-scheme: dark)` altında sınıf tabanlı `!important` override'lar. Sınıflar (`dm-*`) shell'deki blok üreticilerine eklenir: `dm-page`, `dm-card`, `dm-head`, `dm-rule`, `dm-hair`, `dm-ink`, `dm-muted`, `dm-accent`, `dm-cta`, `dm-ghost`. Koyu palet:

| Rol | Açık | Koyu |
| --- | --- | --- |
| Sayfa zemini | `#e7e5e3` | `#121110` |
| Kart / içerik yüzeyi | `#ffffff` | `#1c1a19` |
| Üst (logo) bandı | `#ffffff` | `#ffffff` (bilerek sabit) |
| Metin | `#201e1d` | `#f3f1ef` |
| İkincil metin | `#6b6663` | `#b3aca8` |
| Kart çerçevesi + 2px ayraç | `#201e1d` | `#f3f1ef` |
| İnce çizgi (veri tablosu) | `#d5d1ce` | `#3f3b38` |
| Vurgu (kicker) | `#ec3013` | `#ff5a3c` |
| CTA primary | `#ec3013` / `#ffffff` | aynı |
| CTA ghost | `#fbfafa` + mürekkep çerçeve | `#1c1a19` + `#f3f1ef` çerçeve/metin |
| Linkler | mürekkep / ikincil | `#f3f1ef` / `#b3aca8` |

Logo: mevcut PNG siyah mürekkep + opak beyaz plaka. Yeni dosya üretilmez; üst bant iki temada da beyaz kalır, böylece logo her zaman kendi plakasında durur ve koyu kartın üstünde tanımlı bir marka alanı olur.

**Katman 3 — istemciye özgü dönüşümler.** Outlook (outlook.com / Outlook uygulamaları) renkleri yeniden yazıp `data-ogsc`/`data-ogsb` attribute'u ekler; aynı `dm-*` sınıfları `[data-ogsc] .dm-*` / `[data-ogsb] .dm-*` seçicileriyle bir kez daha bağlanır (dar kapsam, yalnız bu). Gmail (Android kısmi, iOS tam inversiyon; web dokunmaz): her metin ve zemin renginin inline ve eşleşik tanımlı olması, inversiyonun zemin+metni birlikte çevirmesini sağlar; bu istemcide media query çalışmaz, o yüzden Katman 1 yeter. Windows Outlook: mevcut MSO font bloğu ve `bgcolor` fallback yeter; ek MSO koşulu eklenmez.

## Test

- `apps/api/test/transactional-email-render.spec.ts`: RED → GREEN. Her şablon için (45) meta çifti, `:root color-scheme`, `prefers-color-scheme: dark` bloğu, `bgcolor` fallback'leri, `dm-*` kancaları, Outlook seçicileri; aile temsilcileri (aktivasyon, e-posta doğrulama, telefon doğrulama isteği, talep/teklif, review/moderasyon, ödeme/vitrin) için aynı shell'in kullanıldığı açıkça asserte edilir. Tema tablosu `EMAIL_THEME` olarak dışa açılır; WCAG kontrast testi iki temada metin çiftleri için ≥4.5, vurgu/CTA için ≥3 ister.
- Playwright (Chromium, `colorScheme: light|dark`) ile render edilmiş HTML'in ekran görüntüleri `docs/superpowers/plans/2026-09-17-req-ux-007-screens/` altına.
- Apple Mail / Outlook / Gmail motorları yerelde emüle edilemez; rapor bunu ve her istemci için kalan kontrol gereksinimini açıkça yazar.

## Kapsam dışı

API davranışı, gönderim/dedupe/outbox, URL'ler, plain-text gövde, asset dosyaları, `.env`/compose/Dockerfile, web/admin ekranları.
