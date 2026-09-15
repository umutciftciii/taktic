# Hizmet veren değerlendirmeleri — PR-B teslim raporu (web + admin + E2E)

Tarih: 2026-09-15 · Dal: `feature/provider-reviews-pr-b` · Taban: `main@2780b5a7` (PR #79 merge)
· Plan: `docs/superpowers/plans/2026-09-15-provider-rating-design-and-plan.md` (Task 3 adım 5–7, Task 11–16)
· Durum: **PR açıldı** — anahtar (`OperationsSettings.providerReviewsEnabled`) yerelde/staging'de **kapalı**
kalır; merge sonrası admin `/operations-settings` › "Hizmet veren değerlendirmeleri" kartından açılır.

**Değişmeyenler:** API sözleşmesi ve şema (PR-A), migration (yok; DB 61'de kalır), kredi/iade/teklif
sıralaması/paket/vitrin hakkı kodu, `.env`/compose.

## Kapsam

| Alan | İçerik |
|---|---|
| Admin ayar | `provider-reviews-toggle.tsx` + `toggleProviderReviewsAction` (`PUT /operations-settings/provider-reviews`) + "Hizmet veren değerlendirmeleri" kartı (`#degerlendirmeler`, durum rozeti, kendi audit tablosu). Varsayılan Kapalı; yalnız SUPER_ADMIN (admin uygulaması + API `RolesGuard`). `OPERATIONS_SETTING_LABELS` genişletildi; mevcut kartlar dokunulmadı. |
| Admin moderasyon | Nav "Değerlendirme bildirimleri" (`/provider-reviews/reports`, açık/çözülen sekmeleri, cursor); detay `/provider-reviews/[reviewId]` (yorum kaldırılmış olsa da okunur, müşteri adı, raporlar+not, append-only günlük); `moderation-form.tsx` üç karar (`REMOVE_COMMENT`/`REMOVE_REVIEW`/`RESTORE`, duruma göre görünür, kaldırmada gerekçe zorunlu, müşteri cümlesi seçenek yanında) + "Uygun bulundu"; 409 `REVIEW_MODERATION_NOOP`/`NO_OPEN_REVIEW_REPORT` sayfa mesajı. Sağlayıcı detayına "Değerlendirmeler" kartı, talep detayına "Değerlendirme" kartı; bildirim geçmişine 4 şablon etiketi. **Sağlayıcı adına rapor açma kontrolü yok** (API 403). |
| Müşteri | `completeRequestAction` → anahtar açıksa `/requests/<id>/degerlendir`, kapalıysa eski davranış (`/offers`). Sayfa: 1–5 yıldız zorunlu (5 native radio, ok tuşları), isteğe bağlı yorum (600, sayaç, canlı `detectContactDetails` uyarısı), API `CONTACT_DETAILS_IN_TEXT` → alan altı hata; `already-reviewed`/`removed`/`not-completed`/`window-closed` durum metinleri; `disabled`, 403, 404 → aynı 404. Taleplerim satırı "Değerlendir" / "★ n Değerlendirmeniz" / "Değerlendirme kaldırıldı"; teklif sayfasında CTA. |
| Sağlayıcı | Menü "Değerlendirmeler"; `/providers/[id]/degerlendirmeler` (tam özet + dağılım, eşiksiz; liste; kaldırılmış yorum etiketi; rapor diyaloğu `review-report-*`; 409/429 mesajları); dashboard metrik hücresi ve profil rail'i özet kartı. Müşteri adı/telefon/e-posta hiçbir yerde yok. |
| Public | `/isletme/[id]`: yalnız `APPROVED` (sayfa da kontrol eder), public alan allow-list'i (`businessName/city/district/description/serviceCategories/serviceAreas`), `GET /providers/:id/reviews/public` 404 → bölüm yok; eşik altı "Henüz yeterli değerlendirme yok"; yorumlar text child, ay+kategori. Teklif kartı: isim → `/isletme/<id>`, `RatingSummaryLine`; vitrin kart sayfası: isim linki + özet; vitrin feed yüzü: yalnız eşik üstü kompakt satır (`.vitrin-face-rating`, 12px < fiyat). |
| Anahtar kapalı | Hiçbir yüzeyde puan/eşik cümlesi/CTA yok: teklif sayfası `GET /service-requests/:id/review` (`disabled`), vitrin kart sayfası public liste 404, Taleplerim `loadReviewsEnabled`, profil bölüm yok. |
| E2E | `provider-review-flow.spec.ts` (5 test) + `scheduler-settings.spec.ts` (+2); WebKit `testMatch`'e eklendi; `review-fixtures.ts`, journeys (`completeRequest`, `submitReview`, `reportReview`, `moderateReview`, `enableProviderReviews`). |

## Commit'ler (9), diff 43 dosya +4533/−26

```
9125f912 test(e2e): capture the operator screens and the off-state switch for the delivery report
363ca574 test(e2e): the switch audit row reads on/off whatever the stored prior value
4a60bdd4 test(e2e): report the review under test, not the newest row
215c3eb6 fix(web): no rating line anywhere while the switch is off; e2e waits on the committed offer and the open dialog
d5b6979f test(e2e): provider review flow for marketplace and vitrin direct lead; admin switch
ed8fffee feat(admin): provider-reviews switch, report queue, moderation detail and provider/request sections
44468b92 feat(web): public provider profile, offer card link and compact vitrin rating line
661ce234 feat(web): provider review list, report dialog and dashboard summary
28918bb7 feat(web): customer review page, completion redirect and Taleplerim CTA
```

## Doğrulama (worktree; `main`/yerel Docker verisi dokunulmadı)

| Kontrol | Sonuç |
|---|---|
| `pnpm typecheck` / `pnpm lint` / `pnpm build` | 5/5, 4/4, 3/3 temiz |
| `pnpm test` | api **2393/2393**, web **120/120** (+8 `reviews.spec`), admin **49/49** (+2 nav), shared 159/159 |
| `pnpm e2e` (Chromium, tam) | **239/239** (8.0 dk; 232 + 7 yeni) |
| `pnpm e2e:webkit` (tam proje) | **84/84** (3.5 dk; 79 + 5 yeni) |

E2E kapsamı: normal talep tamamlanma → değerlendirme sayfası; vitrin direct lead → aynı yol (`providerId` = kart sahibi, `ShowcaseLead` dokunulmadı); 0/1/2/3 eşiği profil + teklif kartı + vitrin rafı/kartı; 90 gün (`completedAt` −91g); PII reddi (400 → alan altı hata, satır yok); rapor → yorum yayında kalır; `REMOVE_COMMENT` (ortalama aynı, yorum yok, `review-removed` maili 1) → `REMOVE_REVIEW` (eşik altı, Taleplerim "kaldırıldı") → `RESTORE`; 3 moderasyon satırı; kredi/entitlement değişmedi; bildirim geçmişinde 4 etiket ve yorum metni yok; admin sağlayıcı adına rapor 403 (UI kontrolü yok, API satır yazmaz); müşteri anahtar ucu 401/403; başka müşteri/bilinmeyen talep/askıdaki sağlayıcı/bilinmeyen sağlayıcı 404; anahtar kapalı: tamamlama `/offers`'a döner, CTA yok, review URL 404, profilde bölüm yok, davet yazılmaz; 320/768/1024/1440 yatay taşma 0 (3 ekran), radio ok tuşları/Enter ile gönderim, sayaç `15 / 600`.

## Ekran kanıtı (`docs/superpowers/plans/2026-09-15-provider-reviews-pr-b-screens/`)

- `admin-switch-off-1280.png` — **anahtar kapalı** kartı ("Kapalı", audit boş, varsayılan).
- `admin-review-queue-1280.png`, `admin-review-detail-1280.png` — kuyruk ve moderasyon detayı.
- `customer-review-form-320/1440.png`, `customer-review-done-1024.png`, `customer-offer-card-rating-1280.png`.
- `provider-reviews-320/1440.png`, `public-profile-320/768/1024/1440.png`, `public-profile-three-reviews-1280.png`.
- `vitrin-shelf-card-rating-1280.png` — feed yüzünde kompakt satır (fiyat ve bölge altta korunur).

## Açık kararlar (uygulamada verildi)

1. **Müşteri rotası** `/requests/<id>/degerlendir` — PR-A'nın davet maili buraya link verir (`customerReviewUrl`); istenen `/degerlendir/<id>` yerine "eşdeğer" rota.
2. **Vitrin feed'de eşik altı metin yok** (yalnız eşik üstü kompakt satır); "Henüz yeterli değerlendirme yok" cümlesi profil, teklif kartı ve vitrin kart sayfasında. Gerekçe: plan A6 — raf kartında fiyat/bölge satırlarını gölgelememek. Feed'de de metin istenirse tek satırlık değişiklik (`showcase-card-face.tsx`).
3. **Anahtar kapalıyken hiçbir puan yüzeyi yok** (eşik cümlesi dahil). API `null` ile "kapalı" ve "eşik altı"nı ayırmaz; web mevcut uçlardan (müşteri review state, public liste 404) anahtarı okur — API sözleşmesi değişmedi.
4. **Public profil `status` kontrolü sayfada da var**: sahibi/admin `GET /providers/:id`'den tam kaydı alır; sayfa `APPROVED` değilse herkese aynı 404'ü verir ve yalnız public alanları okur.
5. **Moderasyon düğmeleri duruma göre**: yayında → "Yorumu kaldır" (yorum varsa) + "Değerlendirmeyi kaldır"; yorum kaldırılmış → "Değerlendirmeyi kaldır" + "Geri getir"; kaldırılmış → yalnız "Geri getir".
6. Admin `/provider-reviews/<id>` için sidebar'da aktif satır yok (kuyruk `/provider-reviews/reports`); vitrin inceleme ekranlarıyla aynı.

## Bilinen küçük notlar (merge engeli değil)

- Teklif sayfası artık her açılışta bir `GET /service-requests/:id/review` daha yapar (anahtar sinyali için).
- `notFound()` public profilde `generateMetadata` de sağlayıcıyı ayrıca okur (iki çağrı).
- Ekran görüntüleri viewport-only (WebKit DPR koruması gerekmedi).
