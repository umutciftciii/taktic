# REQ-UX-006 — Adım kartları ve misafir aktivasyon notu — Teslim Raporu

Tarih: 2026-09-17 · Branch: `claude/req-ux-006-cards-activation-e2dc6e` (taban `main` @ `70034dbe`) · PR: _(aşağıda)_ · Merge: **yapılmadı**

Migration yok. API, Prisma, Docker/compose, `.env`, Turnstile, ödeme, SMS, e-posta gönderimi ve admin uygulamasına dokunulmadı; yalnız web bileşeni/CSS/test dosyaları değişti.

---

## 1. Ana sayfa — "3 adımda teklif al"

**Kök neden.** Kart, `01` · ikon · başlık · açıklamayı dört bağımsız flex satırı olarak diziyordu; üç kartta ikonlar aynı hizada durunca kartlardan bağımsız yatay bir ikon şeridi algısı oluşuyordu. Ayrıca `.lp-step-card:first-child { padding-left: 0 }` istisnası ilk kartın başlığını diğer ikisinden 24px sola kaydırıyordu — 768px'te üçüncü kart alt satıra sarılınca ve 320/375'te kartlar dikey dizilince başlık başlangıçları tutmuyordu.

**Çözüm.** `apps/web/app/landing-steps.tsx` (yeni): `steps` verisi ve `StepCard` bileşeni `page.tsx`'ten çıkarıldı (metinler, sıra, ikonlar aynen korundu). Kart yapısı:

```
<article.lp-step-card>
  <div.lp-step-head>            ← başlık grubu (flex satırı)
    <span.lp-step-icon> svg     ← 40×40 mürekkep çerçeveli kutu, ikon 20px (değişmedi)
    <div.lp-step-head-text>     ← numara + başlık sütunu
      <span.lp-step-num>01
      <h3.lp-step-title>
  <p.lp-step-desc>
```

CSS (`globals.css`): ilk kart istisnası kaldırıldı (bütün kartlar `padding: var(--space-6)`, güven ızgarasıyla aynı desen); `gap: var(--space-3)`; ikon kutusu `var(--color-text)` çerçeve; başlık `line-height: 1.15`, numara `line-height: 1` (kutu ile iki satır aynı boy). 552px altında (kartlar tek sütuna düştüğünde — her hücre ≥260px, kenar boşluğu 16px) sağ dikey çizgi yerine hücre altı çizgi. Flex-wrap kolon davranışı (≥1024: 3; 768: 2+1; ≤375: 1) değişmedi.

Erişilebilirlik: `h3` başlık, ikon `aria-hidden="true"`; klavye etkileşimi olan öğe yok.

## 2. Misafir talep makbuzu — aktivasyon notu

**Kök neden.** `.notice` sınıfı `display: flex; gap: 10px` (ikon + mesaj düzeni için). `<p class="notice">` içindeki *metin → `<Link>` → metin* dizisi üç anonim flex öğesine dönüşüyor, cümle üç yan yana sütuna bölünüyordu (320px'te "kayıt olmayı" ve "deneyin, bağlantı yeniden gönderilir." ayrı dar sütunlar).

**Çözüm.** `apps/web/app/requests/success/activation-note.tsx` (yeni): `GuestActivationNote` — aynı cümle, aynı `<Link href="/register/customer">`, `role="status"`, `data-testid="request-success-activation-note"`, sınıf `notice notice-prose`. CSS: `.notice-prose { display: block; line-height: 1.55; }`. Metin aynen korundu; nötr makbuz sözleşmesi (durum/işletme/teklif/hesap bilgisi yok) değişmedi; aktivasyon yeniden gönderme davranışı, RequestDraft/identity akışı, yönlendirme ve API sözleşmesine dokunulmadı. Diğer `.notice` kullanımları (ikon + mesaj) etkilenmedi — `notice-prose` yalnız bu blokta.

## Testler

**Web unit (vitest, `apps/web/test/`, node ortamı; `vitest.config.ts`'e `.tsx` import edilebilsin diye `oxc: { jsx: { runtime: 'automatic' } }` eklendi):**
- `landing-steps.spec.ts` (7): üç adım sırası/başlıkları/ikon farklılığı; kartta tek `lp-step-head`; numara, ikon, başlık grubun içinde ve bu sırada; açıklama grubun dışında; ikon `aria-hidden` + 20px; `01` biçimi.
- `request-success-activation-note.spec.ts` (5): tek `<p>`, tam cümle; `notice` + `notice-prose`; içinde tek eleman (`<a href="/register/customer">kayıt olmayı</a>`); `role=status` + test id; yasak iddia sözcükleri yok.

**E2E:**
- `e2e/tests/landing-steps.spec.ts` (yeni; WebKit `testMatch`'e eklendi): 320/375/768/1024/1440'ta sayfa taşması 0; her kart viewport içinde; ikon kutusu grubun sol kenarında ve üstünde; ikon başlıkla **dikey aralık paylaşıyor** (eski düzende ikon tamamen başlığın üstündeydi → bu assertion düşerdi); numara ve başlık aynı x; grup–açıklama boşluğu ≤24px; üç kartta ikon boyu ve başlık/ikon inset'i eşit (eski `first-child` istisnası düşürürdü); kolon davranışı 3 / 2+1 / 1; `#nasil-calisir` bölüm ekran görüntüsü.
- `e2e/tests/request-success-screen.spec.ts` (genişletildi): misafir makbuzunda 5 genişlikte not görünür, metin tam cümle, link `href` doğru, `display` flex değil, not sütunu tamamen dolduruyor, taşma yok (`scrollWidth ≤ clientWidth`), satır yüksekliği ≥1.4×, link ilk satırda değil (eski düzende link kutunun en üstünde ayrı sütundu → düşerdi); başlık `Talebiniz alındı`, `Ana sayfaya dön` CTA görünür, iddia sözcükleri yok; ekran görüntüleri.

## Kalite kapıları

| Komut | Sonuç |
| --- | --- |
| `pnpm typecheck` | geçti |
| `pnpm lint` | geçti |
| `pnpm test` | shared 165, admin 49, web 153 (21 dosya) geçti; API 2563/2564 — `account-email-role-conflict.spec.ts › two simultaneous cross-role registrations cannot both win` **1 başarısız** (bu PR'dan bağımsız, `9817da42`'den gelen yarış testi; tek başına 3 koşuda 2 geçti / 1 düştü → flaky, kod tarafı web dışına dokunmuyor) |
| `pnpm build` | geçti |
| `pnpm e2e` (Chromium, tam suite) | 258/258 |
| `pnpm e2e:webkit` | 103/103 (`landing-steps` + `request-success-screen` dahil) |
| CI | _(PR açıldıktan sonra)_ |

## Responsive kanıt (Chromium; `docs/superpowers/plans/2026-09-17-req-ux-006-screens/`)

| Yüzey | 320 | 375 | 768 | 1024 | 1440 |
| --- | --- | --- | --- | --- | --- |
| Adım kartları | `landing-steps-320.png` | `landing-steps-375.png` | `landing-steps-768.png` | `landing-steps-1024.png` | `landing-steps-1440.png` |
| Misafir makbuzu | `request-success-guest-320.png` | `request-success-guest-375.png` | `request-success-guest-768.png` | `request-success-guest-1024.png` | `request-success-guest-1440.png` |

## Değişen dosyalar

- `apps/web/app/landing-steps.tsx` (yeni), `apps/web/app/page.tsx` (adım verisi/kartı buradan import)
- `apps/web/app/requests/success/activation-note.tsx` (yeni), `apps/web/app/requests/success/page.tsx`
- `apps/web/app/globals.css` (`.lp-step-*`, `.notice-prose`)
- `apps/web/vitest.config.ts`, `apps/web/test/landing-steps.spec.ts` (yeni), `apps/web/test/request-success-activation-note.spec.ts` (yeni)
- `e2e/tests/landing-steps.spec.ts` (yeni), `e2e/tests/request-success-screen.spec.ts`, `e2e/playwright.config.ts` (WebKit testMatch)
- `docs/superpowers/plans/2026-09-17-req-ux-006-teslim-raporu.md`, `docs/superpowers/plans/2026-09-17-req-ux-006-screens/*.png`

## Kapsam dışı (bilerek dokunulmadı)

Güven ızgarası (`.lp-trust-*`) aynı flex-wrap desenini kullanır; brief yalnız adım kartlarını adlandırdığı için değiştirilmedi. `E-postanızı` sözcüğünün 320px'te tire sonrasında kırılması tarayıcının doğal satır kırılımıdır; metin değiştirilmedi. Staging/Cloudflare/`.env`/compose/DB/migration/container/dış servisler.
