# REQ-UX-011 + REQ-UX-012 + talep içeriği + doğrulama rozetleri — Teslim Raporu

Tarih: 2026-09-18 · Branch: `claude/req-ux-011-012-6d0279` (taban `main` @ `09c50b11`, main ilerlemedi —
rebase gerekmedi) · Merge / deploy / yerel-staging eşitleme: **yapılmadı**.

Migration yok. Prisma/schema, `.env`, compose/Dockerfile, lockfile, Turnstile/Cloudflare, SMS/e-posta
sağlayıcıları, ödeme, OTP güvenlik/rate limit/istemci adresi iletimi, doğrulama yaşam döngüsü, vitrin
direct lead, başarı ekranı, provider başvurusu ve admin süreçleri değişmedi. Yeni public endpoint yok.
Tasarım notu: `docs/superpowers/specs/2026-09-18-req-ux-011-012-verification-badges-design.md`.

---

## 1. Değişen projeksiyonlar / endpoint'ler ve yetki sınırları

| Uç | Değişiklik | Yetki (aynen) |
| --- | --- | --- |
| `GET /service-requests/my/:id` | + `answers[]` = `{questionKey, questionLabel, questionType, value, displayValue}`; `displayValue` SELECT/MULTI_SELECT için seçenek etiketi (silinmiş seçenekte key), boolean Evet/Hayır. Include `customerRequestDetailInclude = {...customerRequestInclude, answers}`; yeni sorgu/endpoint yok. | AuthGuard + Roles(CUSTOMER) + `where {id, customerId}` → anon 401, başka müşteri 404 (bilinmeyen id ile aynı gövde), provider/admin 403 |
| `GET /service-requests/my` ve `my/:id` | **−** `moderationNote`, **−** `qualityScoreBreakdown` (müşteri projeksiyonundan düşürüldü; daha önce satırın tamamı spread ediliyordu, iki alan müşteriye sızıyordu, web hiç okumuyordu) | aynen |
| `GET /customers` | + `items[].emailVerifiedAt`, `items[].phoneVerifiedAt` — mevcut `user.findMany` select'ine iki sütun; N+1 yok | AuthGuard + Roles(SUPER_ADMIN) → provider/customer 403, anon 401 |
| `GET /customers/:id` | + `customer.emailVerifiedAt/phoneVerifiedAt` — mevcut `findUnique` select'i | aynen (SUPER_ADMIN) |
| `GET /auth/me` | + `emailVerifiedAt` (oturum kullanıcısı select'i; `phoneVerifiedAt` PR #88'den beri vardı) | yalnız oturumun kendi hesabı |
| `GET /account/profile` | + `emailVerifiedAt`, `phoneVerifiedAt` (`profileSelect`) | AuthGuard + Roles(CUSTOMER), yalnız kendi hesabı |
| Admin `GET /service-requests/:id` `customer{}` | **değişmedi** — doğrulama alanı yok (testle kanıtlı) | — |
| Provider yüzeyleri | **değişmedi** — yeni alan yok | — |

Web: `app/requests/[id]/offers/page.tsx` özeti artık `/service-requests/my` listesinden bulmak yerine
`/service-requests/my/:id` okur (`safeFetchMyRequest`, hata → özet yok, sayfa hatasız); 404 kapısı
`GET /service-requests/:id/offers` ile aynen; provider → `/login?redirectTo=` (aynen).

## 2. Doğrulama rozetlerinin kanonik kaynağı

| Rozet | Yüzey | Kaynak | Başka hiçbir şey |
| --- | --- | --- | --- |
| E-posta | admin liste/detay, müşteri profili | `User.emailVerifiedAt` | — |
| Telefon | admin liste/detay, müşteri profili | `User.phoneVerifiedAt` | `ServiceRequest.phoneVerifiedAt` ve `PhoneVerification` hiçbir rozet yolunda okunmaz |

Tek okuma noktası `@taktic/shared › contactVerification(at)` → `{verified, label: 'Doğrulandı'|'Doğrulanmadı', at}`;
null/undefined/bozuk tarih → `Doğrulanmadı`. Eski/demo kayıtlar (iki sütun NULL) hiçbir yerde onaylı görünmez.
API testi: talebi kodla doğrulanmış + `PhoneVerification` satırı olan müşteri listede/detayda `phoneVerifiedAt: null`;
admin helper testi ve E2E aynı tuzağı kurar (`seedCustomerRequest({phoneVerifiedAt})` + `stampAccountProofs` yok).

Yüzeyler:
- **Admin > Hizmet Alanlar listesi**: "Doğrulama" sütunu; yalnız kanıtlı kanallar `badge badge-good` pil
  ("E-posta", "Telefon"; `title`'da zaman), hiçbiri yoksa `cell-muted` "Yok"; `data-testid="customer-verification"`
  `data-verified="email phone"`.
- **Admin müşteri detayı**: Telefon/E-posta altında `Doğrulandı` (`badge-good`) + `formatDateTime(at)` ya da
  `Doğrulanmadı` (`badge-muted`, zaman yok). Kırmızı/başarısız damga yok.
- **Hizmet alan paneli > Profil ve ayarlar**: alan etiketi satırında `tag tag-ink` "Doğrulandı" / `tag tag-neutral`
  "Doğrulanmadı", `aria-label="E-posta doğrulandı"` / `"Telefon doğrulanmadı"`, `data-testid="account-{email,phone}-verification"`.
  Tarih gösterilmiyor. CTA eklenmedi: web'de e-posta yeniden gönderme ekranı ya da hesap düzeyi telefon doğrulama akışı
  yok; sahte CTA konmadı.

Erişilebilirlik: her rozet görünür metin + `aria-label` taşır; renk yalnız pekiştirir (ink/nötr; kırmızı yok).

## 3. Landing — açık / kapalı / fail-closed metin matrisi (REQ-UX-011)

Envanter (yalnız müşteri talep alma akışı): iki statik iddia bulundu ve anahtara bağlandı; adımlar/hero alt cümle/demo
nötr. Provider değer önerisi ("İncelenmiş talepler"), SSS'deki başvuru cümlesi ("ekibimiz başvurunu inceler"),
provider başvuru/başarı/davet ekranları kapsam dışı — değişmedi ve E2E ile korunduğu kanıtlandı.

| Policy | Güven kartı (`landing-trust-cards`) | Hero yüzen kart (`landing-hero-publish-card`) |
| --- | --- | --- |
| AÇIK (`{autoPublishEnabled:true}`) | **Onaylı hizmet verenlere iletim** — Talebin bölgendeki uygun ve onaylı hizmet verenlere iletilir; teklifler onlardan toplanır. | Onaylı hizmet verenler · Her talep |
| KAPALI (`false`) | Admin ön inceleme — Talepler yayına alınmadan önce inceleme süreçlerinden geçer. *(aynen)* | Ön inceleme · Her talep *(aynen)* |
| okunamaz (HTTP 503) / bozuk (`"true"` dizesi, farklı şekil) | KAPALI ile aynı | KAPALI ile aynı |

Okuma: `app/page.tsx` mevcut `getMarketplacePublishPolicy()` (REQ-UX-008/009 ile aynı fail-closed yol), `getRefundPolicy()` ile
aynı `Promise.all`; `cache: 'no-store'` → her yüklemede taze, SSR. Kopya çifti `lib/request-next-steps.ts › landingPublishCopy`.
Web testi sayfayı gerçek `apiFetch` ile 4 durumda render eder; E2E anahtarı gerçek DB'de çevirip 320/768/1440'ta doğrular.

## 4. OTP hizası (REQ-UX-012) — responsive kanıt

`phone-verification-card.tsx`: `.otp-row` > `.otp-send` (buton) + `.otp-verify` (input + buton); üçü `.otp-control`
(min-height 42px, padding 9px 14px, 14px, line-height 1.2, `align-items: stretch`). Input: `.otp-code` (flex 1 1 120px,
max 180px, tabular-nums; inline `maxWidth` kaldırıldı), `aria-invalid` yalnız `invalid` durumunda. `≤400px`: kart padding 16,
her yarı tam satır, kontroller 13px / 10px yan padding / nowrap (üçünde aynı).

Korunan durumlar (web testi 15, her biri iki aksiyonla): gönderilmemiş, `ok`, `invalid`, `rate-limited`, `already-verified`,
`challenge-failed`, `challenge-unavailable`, gönderiliyor (`aria-busy`), Turnstile unconfigured (gönder disabled),
doğrulanmış (kart yok). Action'lar, Turnstile token akışı, `clientForwardingHeaders()`, API sözleşmesi değişmedi.

E2E (`customer-request-content.spec.ts`, Chromium) 320/375/768/1024/1440'ta üç kontrol için: `font-size`, `line-height`,
`padding-top/bottom` eşit; yükseklik farkı ≤1px; kod alanı + Doğrula aynı satırda (top/bottom eşit, çakışma yok); gönder
butonu aynı satırdaysa aynı taban çizgisi, katlandıysa üstte ve çakışmasız; hiçbir butonda `scrollWidth > clientWidth` yok;
sayfa yatay taşması 0; ≥1024'te üçü tek satırda. `?verification=invalid` durumunda 320'de aynı ölçümler.

| Genişlik | Görüntü (`docs/superpowers/plans/2026-09-18-req-ux-011-012-screens/`) | Yerleşim |
| --- | --- | --- |
| 320 | `otp-row-320.png`, `otp-row-invalid-320.png` | gönder tam satır; kod + Doğrula ikinci satır, 42px |
| 375 | `otp-row-375.png` | aynı |
| 768 | `otp-row-768.png` | iki sütunlu özet: gönder kendi satırında, kod + Doğrula altında |
| 1024 / 1440 | `otp-row-1024.png`, `otp-row-1440.png` | üçü tek satır, tek taban çizgisi |

## 5. Talep içeriği (hizmet alan paneli)

"Talep içeriği" bloğu (`data-testid="request-content"`, satır `request-content-<key>`), `lib/request-content.ts ›
requestContentRows`: Açıklama → kategori soru/cevapları (etiket → `displayValue`) → Konum (il, ilçe, mahalle) → Adres notu →
Tercih edilen tarih (`formatDateRange`) → Bütçe (kuruş → `formatPrice`) → Aciliyet (`urgencyLabel`; bilinmeyen kod → satır yok).
Kategori ve referans zaten başlıkta. Boş alan = satır yok (dash/"belirtilmedi" yok; boşluk-only ve boş `displayValue` de yok).
Blok telefon/e-posta/iletişim adını içermez (unit + E2E ile kanıtlı). Ekran: `otp-row-1440.png` bloğu da gösterir.

## 6. Test sayıları ve kapılar

| Paket | Sonuç |
| --- | --- |
| API (`vitest`) | **129 dosya / 2972 test** yeşil (+8: `customer-request-detail` +2, 1 güncellendi; `account-verification-badges` 6) |
| Web | **30 dosya / 249 test** yeşil (+38: `landing-publish-copy` 7, `request-content` 11, `request-detail-content` 15, `account-profile-badges` 5) |
| Admin | **4 dosya / 55 test** yeşil (+6: `customer-verification`) |
| Shared | **6 dosya / 168 test** yeşil (+3: `contact-verification`) |
| `pnpm typecheck` | 5/5 geçti |
| `pnpm lint` | 4/4 geçti |
| `pnpm build` | 3/3 geçti (E2E koşularının içinde) |
| E2E Chromium — yeni 3 spec (5 test) | `landing-publish-copy` 1/1, `customer-request-content` 3/3, `admin-customer-verification` 1/1 |
| E2E Chromium — regresyon | `phone-verification-gate request-success-screen customer-panel landing-hero landing-steps account-settings request-auto-publish request-next-steps-note responsive-shell hero-request-demo access-and-errors` → **39/39** (2.0 dk) |
| E2E WebKit — yeni 3 spec | `pnpm e2e:webkit …` → **5/5** (üç spec `webkitProject().testMatch`'e eklendi) |
| CI (#89) | run 35285960445 @ `8920a1f7` **3/3 geçti**: `typecheck · lint · test · build` 10m40s, `e2e (chromium)` 15m54s, `e2e (webkit · sign-in and mobile shells)` 8m28s. İlk koşu (35284545929 @ `797186d9`) yalnız `admin-customer-verification` ile düştü: müşteri listesi 320'de Linux Chromium'da 2px, WebKit'te 8px taşıyordu — `type=date` input'u Linux'ta daha geniş çizilir ve toolbar alanı altına küçülemiyordu (yerelde Mac'te 0). `.customers-page` kapsamlı `flex-wrap` + `min-width: 0` kuralıyla kapatıldı (`8920a1f7`). Bu satırı ekleyen commit docs-only; kod ağacı `8920a1f7` ile aynıdır. |

RED→GREEN: API `answers`/sızıntı testleri önce `undefined`/400 ile düştü; web `landing-publish-copy` sayfa testleri
router/async shell mock'ları eklenene kadar düştü, sonra kopya bağlandı; `request-content` helper `is not a function` ile
başladı; profil rozet testleri 5/5 düştü → bileşen eklendi. E2E ilk koşuda 3 hata: admin liste 320'de 825px yatay taşma
(**mevcut** hata — tablo `.section-card` içinde `overflow-x` almıyordu; support/vitrin ekranlarındaki kapsamlı kuralın aynısı
`.customers-page .table-scroll` ile eklendi), `innerText`'in CSS uppercase'i yansıtması (test okuması `textContent`'a alındı),
320'de gönder butonunun iki satıra sarması (dar genişlik kuralı eklendi).

## 7. Bilinen kapsam dışı noktalar / açık riskler

- **"İletişim tercihi" satırı yok**: şemada böyle bir alan yok (`useAlternateContact` DTO'da var, kalıcı değil); telefon
  eşitliğinden türetmek tahmin olurdu. Alan eklenmedi, satır gösterilmiyor.
- **Provider değer önerisi** "İncelenmiş talepler — yayına alınmadan önce incelenir" ve hero demo etiketleri kapsam dışı
  bırakıldı (müşteri talep alma akışı değil); AÇIK'ta bu cümle de gerçekle uyuşmaz — ayrı iş.
- **`rejectionReason`** müşteri projeksiyonunda kaldı (müşteriye söylenen ret nedeni; operatör notu değil).
- 768'de OTP satırı iki sütunlu özetin dar sütununda katlanır (gönder kendi satırında) — kontrollü katlanma, hizalı.
- Admin listesinde başka tabloların 320 taşması (varsa) bu PR'ın kapsamı dışında; kural yalnız `.customers-page`'e uygulandı.
- Web'de e-posta yeniden gönderme / hesap telefon doğrulama CTA'sı yok; profil rozetleri yalnız bilgi verir.
