# Hizmet veren değerlendirmeleri — PR-A teslim raporu (API + migration)

Tarih: 2026-09-15 · Dal: `claude/tactic-provider-rating-design-351f65` · Taban: `main@59c45b88`
· Plan: `docs/superpowers/plans/2026-09-15-provider-rating-design-and-plan.md` (Task 1–10)
· Durum: **PR açıldı, merge edilmedi** — anahtar (`OperationsSettings.providerReviewsEnabled`)
varsayılan `false`; PR-B (web/admin/E2E) merge edilene kadar **açılmamalı** (davet maili henüz var
olmayan `/requests/<id>/degerlendir` sayfasına link verir).

## Kapsam

| Alan | İçerik |
|---|---|
| Şema/migration | `ProviderReview`, `ProviderReviewReport`, `ProviderReviewModeration` + 3 enum + `OperationsSettings.providerReviewsEnabled BOOLEAN NOT NULL DEFAULT false`; 4 CHECK, 2 partial index, 1 partial unique (`ProviderReviewReport_one_open_per_review`), FK'ler `Restrict` (admin `SetNull`/`Restrict`). Tek additive migration `20260916120000_add_provider_reviews` (60 → 61). Dry-run: `docs/superpowers/plans/2026-09-16-provider-reviews-migration-dryrun.txt`. |
| Anahtar | `ProviderReviewSettingsService` (fail-closed) + `GET/PUT /operations-settings/provider-reviews` + `OperationsSettingsChange` günlüğü. Admin toggle UI **PR-B**'de. |
| E-posta | `review-invitation`, `review-received`, `review-report-new-for-support`, `review-removed` (41 → 45 şablon); dedupe anahtarları `review-invitation:<requestId>`, `review-received:<reviewId>`, `review-report-new:<reportId>`, `review-removed:<reviewId>:<ISO>`; hepsi `composeRetryMessage`/`rebuild` ile yeniden kurulabilir. Yorum metni ve PII hiçbir mailde yok. |
| `COMPLETED` geçişi | `completeServiceRequest` artık `runSerializable` içinde: koşullu `updateMany` + davet niyeti (`ReviewInvitationOutbox.enqueue`, `intentRow` + `createMany skipDuplicates`) aynı transaction'da; `deliverSoon()` commit sonrası; `request-expiry` scheduler tick'i artıkları süpürür (`reviewInvitationsSent=`). Sahipsiz (`customerId NULL`) talebe davet yazılmaz. |
| Müşteri API | `POST/GET /service-requests/:id/review` — yalnız talep sahibi CUSTOMER; `COMPLETED` + kabul edilmiş teklif + 90 gün; sağlayıcı `matchedOffer.providerId`'den türetilir; yorum `normalizeComment` + canonical `assertNoContactDetails`; `create` + P2002 → 409. |
| Sağlayıcı API | `GET /providers/:id/reviews`, `/summary` (tam özet, eşiksiz); `POST /providers/:id/reviews/:reviewId/reports` (yalnız değerlendirilen sağlayıcı, tek açık rapor, 20/gün). |
| Public API | `GET /providers/:id/reviews/public` — yalnız `APPROVED` + anahtar açık; eşik **3** tek helper'da (`toPublicSummary`); eşik altı `summary: null, items: []`. |
| Admin API | `GET /provider-reviews/reports`, `GET /provider-reviews/:id`, `POST /provider-reviews/:id/moderate` (`REMOVE_COMMENT` / `REMOVE_REVIEW` / `RESTORE`, tek serializable tx, append-only `ProviderReviewModeration`), `POST /provider-reviews/:id/reports/dismiss`. |
| Projeksiyonlar | `listRequestOffers` + teklif detayı: `provider.id` + `reviewSummary`; vitrin feed/public kart: `provider.reviewSummary`; sağlayıcı dashboard: `reviewSummary` (tam); müşteri listesi: `review { id, rating, removedAt } \| null`. Public özetler `publicSummariesForProviders`'tan geçer: anahtar kapalı ya da sağlayıcı `APPROVED` değilse `null`. Sıralama/fiyat/bölge/SQL dokunulmadı. |

**Dokunulmayanlar:** `apps/web`, `apps/admin`, `e2e` (sıfır değişiklik), kredi/iade/entitlement/vitrin
hakkı kodu, `.env`/compose, teklif sıralaması.

## Commit'ler (15)

```
b3c20c92 chore(reviews): drop the unused re-export and import; truncate the review tables explicitly
298bedbb fix(reviews): public summaries follow provider visibility; no invitation for an owner-less request
d9cd7229 feat(reviews): public summaries on offer previews, vitrin cards, dashboard and the customer list
ab337adf feat(reviews): provider reports and operator moderation with an append-only log
f203cb30 feat(reviews): provider panel list, public list and live aggregate with the 3-review threshold
0476df8d fix(reviews): spell control characters as escapes so the comment normaliser and its spec are text
5fc634bd feat(reviews): customers rate the matched provider once after completion
9339c736 fix(requests): read the review switch on the completing transaction without swallowing errors
e6c2d4e2 feat(requests): complete inside a transaction and enqueue the review invitation as an outbox intent
1a6e6bae feat(mail): review notifications with dedupe keys and retry rebuild
6adaca07 feat(mail): review invitation, received, report and removed templates
53f0d3fd feat(settings): providerReviewsEnabled switch with audit trail and admin toggle  (not: UI PR-B'de; başlık API yarısını kapsar)
ecf55bb1 feat(db): provider reviews, reports and moderation log (additive)
a7152cd2 refactor(api): shared review limits and a common contact-details guard
bdf93fca docs: provider review design and implementation plan
```

Diff: 54 dosya, +9234/−83 (API src+prisma 39 dosya, test 11 dosya, docs/limits 4).

## Yerel doğrulama (worktree, `main`/yerel Docker verisi dokunulmadı)

| Kontrol | Sonuç |
|---|---|
| `pnpm typecheck` / `pnpm lint` / `pnpm build` | temiz (5/5, 4/4, 3/3) |
| API `vitest run` (tek başına) | **115 dosya, 2390/2390** |
| web/admin vitest | 112/112, 47/47 |
| `pnpm e2e` (Chromium, tam) | **232/232** (7.3 dk) |
| `pnpm e2e:webkit` | **79/79** (2.6 dk) |
| Migration dry-run | `migrate diff` boş drift; izole kopya DB'de `migrate deploy` 60→61; `\d` çıktıları dosyada; scratch DB'ler düşürüldü |

Yeni spec'ler: `provider-review-schema`, `provider-reviews`, `provider-reviews-aggregate`,
`provider-review-moderation`, `provider-review-notifications`, `provider-review-projections`,
`review-invitation-outbox`; uzatılanlar: `operations-settings`, `transactional-email-render` (45),
`credits-integrity`.

Not: aynı checkout'ta iki vitest koşusu paylaşılan test DB'sini bozar (TRUNCATE yarışı) — ilk
tam suite koşusu bu yüzden 34 hata verdi; tek başına tekrarında 2390/2390.

## Yarış kontrolleri (final incelemede özellikle arandı)

| Yarış | Mekanizma | Kanıt |
|---|---|---|
| Aynı değerlendirme iki kez | `@@unique([requestId, providerId])` + `offerId @unique`, `create` + P2002 → 409 | `provider-reviews.spec` 10 paralel → 1×201/9×409 |
| `COMPLETED` × review create | Create `status === COMPLETED` okur; complete serializable + koşullu `updateMany`; ikinci complete 409 | `review-invitation-outbox.spec` paralel complete → [201, 409], tek intent |
| Moderasyon kaldır/geri getir × aggregate | Koşullu `updateMany` (predikat `where`'de), kaybeden 409 `REVIEW_MODERATION_NOOP`; aggregate anlık sorgu | `provider-review-moderation.spec` iki admin paralel → 1 satır, 1 mail |
| Davet intent × retry/rebuild | `(template, dedupeKey)` unique + `skipDuplicates`; sweep koşullu claim + 15 dk lease; admin retry aynı satır | outbox spec "second sweep claimed=0", notifications spec rebuild |
| 3-eşiği tutarsızlığı | Tek helper `toPublicSummary`; tüm public yüzeyler `publicSummariesForProviders` | projections spec (teklif/feed/kart/dashboard) |
| Onaysız sağlayıcı / PII sızıntısı | `publicSummariesForProviders` yalnız `APPROVED`; public liste 404; public item allow-list; `loadReview` yorumu select etmez | projections spec SUSPENDED → null; aggregate spec key-set + PII regex |

## Bilinen küçük notlar (merge engeli değil; ledger'da)

- `normalizeComment` regex'i plan-verbatim: yalnız `\r` (CR) satır sonu silinir (CRLF çalışır). Karar: plan metni; istenirse `` sınıftan çıkarılır.
- Public özet her çağrıda bir ek indeksli `providerProfile` sorgusu (sayfa boyutuyla sınırlı).
- `listQueue` bilinmeyen cursor → boş sayfa (talep raporları üstten başlar) — PR-B admin UI bunu hesaba katmalı.
- `ProviderAccessGuard` SUPER_ADMIN'i geçirdiği için admin, panel rotasından sağlayıcı adına rapor açabilir (A5 kabulü).
- Rapor oluşturma tx dışı: eşzamanlı `REMOVE_REVIEW` sonrası açık rapor kalabilir (admin dismiss eder). 20/gün bütçesi read-then-insert.
- `MATCH_INCONSISTENT` dalı doğrudan testsiz (savunma amaçlı).

## PR-B'ye devredilenler

Task 3 adım 5–7 (admin toggle UI + E2E), Task 11–16 (müşteri değerlendirme sayfası, sağlayıcı
paneli, `/isletme/[id]`, teklif kartı/vitrin satırı, admin kuyruğu/detayı, E2E, yerel kabul).
