# REQ-UX-011 + REQ-UX-012 + talep içeriği + doğrulama rozetleri — Tasarım Notu

Tarih: 2026-09-18 · Taban: `main` @ `09c50b11` · Tek PR.

Migration yok. Prisma/schema, `.env`, compose/Dockerfile, lockfile, Turnstile/Cloudflare, SMS/e-posta
sağlayıcıları, ödeme, OTP güvenlik/rate limit/istemci adresi iletimi ve doğrulama yaşam döngüsü
değişmedi. Yeni public endpoint yok.

---

## 1. REQ-UX-011 — Landing'in statik "ön inceleme" iddiaları

### Envanter (müşteri talep alma akışı)

| Yüzey | Dosya | Eski kopya | Karar |
| --- | --- | --- | --- |
| Güven kartı | `app/page.tsx` `trustCards[1]` | "Admin ön inceleme / Talepler yayına alınmadan önce inceleme süreçlerinden geçer." | **anahtara bağlandı** |
| Hero yüzen kart | `app/landing-hero.tsx` | "Ön inceleme · Her talep" | **anahtara bağlandı** |
| "3 adımda teklif al" 1. adım | `app/landing-steps.tsx` | "…kalite skoru ile yayına alınır." | nötr, değişmedi |
| Hero alt cümle | `app/landing-hero.tsx` | "…yalnızca bölgende çalışan onaylı işletmelere iletilir." | nötr, değişmedi |
| Hero demo aşamaları | `lib/hero-demo.ts` | "Talep oluşturuldu → Teklifler geldi → Tamamlandı" | inceleme iddiası yok, değişmedi |
| Hizmet verenler için "İncelenmiş talepler" | `app/page.tsx` `buildProviderFeatures` | "…yayına alınmadan önce incelenir." | **kapsam dışı** (provider değer önerisi; §7 açık nokta) |
| SSS "Hizmet veren olmak" | `app/landing-faq.tsx` | "…ekibimiz başvurunu inceler." | gerçek admin süreci (başvuru), değişmedi |
| Provider başvuru/başarı/davet, admin, e-posta | — | — | kapsam dışı, değişmedi |

### Okuma yolu

`app/page.tsx` mevcut `getRefundPolicy()` ile aynı `Promise.all` içinde `getMarketplacePublishPolicy()`
okur (REQ-UX-008/009 ile aynı fail-closed yol: HTTP hatası, JSON olmayan gövde, `"true"` dizesi → `false`).
Boolean `LandingHero` (client) ve `FinalCTA` (server) prop'u olarak iner; sayfa `cache: 'no-store'`
`apiFetch` kullandığı için her yüklemede taze okunur — REQ-UX-008/009 sözleşmesiyle aynı.

### Metin matrisi

| Durum | Güven kartı | Hero yüzen kart |
| --- | --- | --- |
| AÇIK | **Onaylı hizmet verenlere iletim** — Talebin bölgendeki uygun ve onaylı hizmet verenlere iletilir; teklifler onlardan toplanır. | Onaylı hizmet verenler · Her talep |
| KAPALI | Admin ön inceleme — Talepler yayına alınmadan önce inceleme süreçlerinden geçer. (aynen) | Ön inceleme · Her talep (aynen) |
| okunamaz / bozuk | KAPALI ile aynı | KAPALI ile aynı |

Kopya çifti `lib/request-next-steps.ts › landingPublishCopy(autoPublishEnabled)` — notla aynı modül.
`data-testid="landing-trust-cards"` / `"landing-hero-publish-card"` + `data-auto-publish="on|off"`.

## 2. REQ-UX-012 — OTP satırı hizası

`phone-verification-card.tsx`: dış `.verify-row` → `.otp-row` (`data-testid="phone-verification-controls"`);
iki form `.otp-send` / `.otp-verify`; üç kontrol `.otp-control` (min-height 42px = form kontrolü,
padding 9px 14px, 14px, line-height 1.2, box-sizing border-box). Input artık inline `maxWidth` yerine
`.otp-code` (flex 1 1 120px, max 180px, min-width 0, tabular-nums, `aria-invalid` yalnız `invalid`
durumunda). `align-items: stretch` katlanan satırda yükseklikleri eşitler; dar ekranda gönder butonu kendi
satırına iner, kod+Doğrula birlikte kalır.

Korunan durumlar: gönderilmemiş, `ok`, `invalid`, `rate-limited`, `already-verified`, `challenge-failed`,
`challenge-unavailable`, gönderiliyor (`aria-busy`), Turnstile unconfigured (gönder disabled), doğrulanmış
(kart yok). Action'lar, Turnstile token akışı, `clientForwardingHeaders()` ve API sözleşmesi değişmedi.

## 3. Talep detayının kendi içeriği

### Projeksiyon

`GET /service-requests/my/:id` (AuthGuard + Roles(CUSTOMER) + `where {id, customerId}`) =
liste satırı + `answers[]`. `customerRequestDetailInclude = {...customerRequestInclude, answers: {select:
questionKey, questionLabel, questionType, value, question.options}}`; `toCustomerAnswer` → `{questionKey,
questionLabel, questionType, value, displayValue}`; `displayValue` SELECT/MULTI_SELECT için seçeneğin
`label`'ı (silinmiş seçenekte key), boolean Evet/Hayır, dizi virgülle.

`toCustomerServiceRequest` artık `moderationNote` ve `qualityScoreBreakdown`'ı düşürür (liste ve detay).
Diğer sütunlar (`description`, `neighborhood`, `addressNote`, `budgetMin/Max`, `preferredDate(End)`,
`urgency`) zaten satırda geliyordu; web tipi bunları artık bildiriyor.

Yetki: anon 401, başka müşteri 404 (bilinmeyen id ile aynı gövde), provider/admin 403 — aynen.
Paralel endpoint yok.

### Web

`app/requests/[id]/offers/page.tsx` özeti listeden bulmak yerine `/service-requests/my/:id` okur
(`safeFetchMyRequest`, hata → null; 404 kapısı `GET :id/offers` ile aynen). "Talep içeriği" bloğu
(`data-testid="request-content"`, satırlar `request-content-<key>`), satırlar `lib/request-content.ts ›
requestContentRows`: Açıklama → soru/cevaplar → Konum (il, ilçe, mahalle) → Adres notu → Tercih edilen
tarih (`formatDateRange`) → Bütçe (kuruş → `formatPrice`) → Aciliyet (`urgencyLabel`; bilinmeyen kod →
satır yok). Boş alan = satır yok; telefon/e-posta/iletişim adı blokta yok.

"İletişim tercihi": şemada böyle bir alan yok (`useAlternateContact` kalıcı değil); türetmek tahmin olurdu,
satır eklenmedi (§7).

## 4. Doğrulama rozetleri

Kanonik kaynak yalnız `User.emailVerifiedAt` ve `User.phoneVerifiedAt`. `ServiceRequest.phoneVerifiedAt`
ve `PhoneVerification` hiçbir rozet yolunda okunmaz.

| Yüzey | Alan | Kaynak sorgu |
| --- | --- | --- |
| `GET /customers` | `items[].emailVerifiedAt/phoneVerifiedAt` | mevcut `user.findMany` select'ine iki sütun (N+1 yok) |
| `GET /customers/:id` | `customer.emailVerifiedAt/phoneVerifiedAt` | mevcut `user.findUnique` select'i |
| `GET /auth/me` | `emailVerifiedAt` (+ mevcut `phoneVerifiedAt`) | oturum kullanıcısı select'i (yalnız kendi hesabı) |
| `GET /account/profile` | ikisi | `profileSelect` (Roles(CUSTOMER), yalnız kendi hesabı) |
| Admin `GET /service-requests/:id` `customer{}` | **yok** | değişmedi |
| Provider yüzeyleri | **yok** | değişmedi |

Sözcükler `@taktic/shared › contactVerification`: `Doğrulandı` / `Doğrulanmadı` (nötr; kırmızı/"başarısız"
yok). Admin liste: "Doğrulama" sütunu, yalnız kanıtlı kanallar `badge-good` pil ("E-posta", "Telefon"),
hiçbiri yoksa `cell-muted` "Yok"; `title` ile zaman. Admin detay: telefon/e-posta altında pil + zaman
(`formatDateTime`), kanıtsızda `badge-muted` ve zaman yok. Müşteri profili: alan etiketi satırında
`tag tag-ink` / `tag tag-neutral`, `aria-label="E-posta doğrulandı"` vb.; CTA eklenmedi (web'de e-posta
yeniden gönderme/telefon hesap doğrulama akışı yok).

## 5. Testler

- API: `customer-request-detail.spec.ts` (+2, 1 güncellendi), `account-verification-badges.spec.ts` (6).
- Shared: `contact-verification.spec.ts` (3). Admin: `customer-verification.spec.ts` (6).
- Web: `landing-publish-copy.spec.ts` (7; gerçek `apiFetch`, AÇIK/KAPALI/503/bozuk), `request-content.spec.ts`
  (11), `request-detail-content.spec.ts` (15; dolu/boş/okunamaz/yabancı/provider + OTP durumları),
  `account-profile-badges.spec.ts` (5).
- E2E: `landing-publish-copy`, `customer-request-content` (3 test), `admin-customer-verification`;
  320/768/1440, yatay taşma 0, OTP üç kontrol aynı yükseklik/padding/font/line-height + aynı satırdakiler
  aynı top/bottom; WebKit projesine eklendi.
