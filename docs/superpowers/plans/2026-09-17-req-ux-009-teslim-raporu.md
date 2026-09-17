# REQ-UX-009 — Otomatik yayınla çelişen müşteri kopyaları: envanter ve düzeltme — Teslim Raporu

Tarih: 2026-09-17 · Branch: `claude/auto-publish-copy-alignment-9bd419` (taban `main` @ `1a5d3b5d`) · PR: https://github.com/umutciftciii/taktic/pull/87 · Merge: **yapılmadı**

Migration yok. Prisma/schema, `.env`, compose/Dockerfile, Turnstile, ödeme/SMS/e-posta, `OperationsSettings` yazma yolu, talep durum geçişi ve outbox/dedupe değişmedi. API kodu değişmedi. Staging, yerel container/DB, Cloudflare ve dış servislere dokunulmadı.

Tasarım notu ve tam envanter: `docs/superpowers/specs/2026-09-17-req-ux-009-auto-publish-copy-audit-design.md`.

---

## 1. Envanter (özet — tam tablo tasarım notunda)

| Yüzey | Aktör / durum | Sözleşme | Sonuç |
| --- | --- | --- | --- |
| Form başlık altı fallback (`categories/[slug]/page.tsx`, kategori açıklaması boşken) | herkes · ayardan bağımsız sabit "…ön incelemeden geçtikten sonra…" | #4 ile çelişir | **gerçek regresyon — düzeltildi** |
| "Sırada ne var?" notu (`lib/request-next-steps.ts`) | herkes · ayara göre | #4 | zaten uyumlu (REQ-UX-008) |
| Başarı ekranı `published` | oturumlu sahip · API `APPROVED` | #1 | zaten uyumlu — test ile kanıtlandı |
| Başarı ekranı `review` ("ön incelemeye gönderildi") | oturumlu sahip · API `status !== APPROVED` (KAPALI'da `SUBMITTED`) | #2 | **ayrı varyant, regresyon değil** — gerçek durumdan render, bayrak okunmaz |
| Başarı ekranı `guest` ("Talebiniz alındı") | oturumsuz · API çağrısı yok | #3 | zaten uyumlu — test ile kanıtlandı |
| Başarı ekranı `targeted`, vitrin-karar, vitrin lead formu, showcase-matches | vitrin/direct lead | #5 | değişmedi, E2E ile korunduğu kanıtlandı |
| Talep detayı zaman çizelgesi "Ön inceleme", durum etiketleri `İncelemede/Onaylandı` | oturumlu sahip · gerçek durum | durum göstergesi | değişmedi |
| Landing "Admin ön inceleme" / "Ön inceleme · Her talep"; provider başvuru "ön incelemeye gönderildi"; admin/e-posta | pazarlama / provider / operatör | talep yolu dışı | değişmedi (landing açık risk, §7) |

## 2. Değişen kopyalar

| Yüzey | KAPALI / okunamadı | AÇIK |
| --- | --- | --- |
| Form başlık altı (yalnız kategori açıklaması boşken) | `Soruları yanıtla, talebin ön incelemeden geçtikten sonra bölgendeki onaylı ustalara iletilir.` (aynen) | `Soruları yanıtla, talebin bölgendeki uygun hizmet verenlere iletilir.` (**yeni**) |

- `apps/web/lib/request-next-steps.ts`: `requestFormIntroText(autoPublishEnabled)` — notla aynı modül, aynı ayar okuma.
- `apps/web/app/categories/[slug]/page.tsx`: fallback yardımcıdan; `data-testid="request-form-intro"`; kategori açıklaması varsa her durumda o gösterilir (DB içeriği; kod değil).
- Başka müşteri kopyası değişmedi.

## 3. Korunmuş yüzeyler ve kanıt

- Başarı ekranı: kod değişmedi. `apps/web/test/request-success-screen.spec.ts` sayfayı gerçek `apiFetch`/`fetchOrNotFound` ile (yalnız `fetch` ve `cookies` stub) render eder: `APPROVED` → `published`, "Talebiniz yayınlandı", metinde "ön incele"/"onay" yok; `SUBMITTED` → `review`; `?published=1` etkisiz; vitrin lead → `targeted`; oturumsuz → `guest`, `/service-requests/my/:id` **çağrılmaz**, iddia listesi yok; başkasının id'si (API 404) / PROVIDER / ADMIN / SUPER_ADMIN / bozuk id / id yok → `notFound()`.
- API: `apps/api/test/customer-request-detail.spec.ts` (+1): policy `false` iken gönderilen talep detayı `SUBMITTED`; policy `true` iken gönderilen `APPROVED`, önceki talep değişmez; yanıtta `autoPublishEnabled`/`marketplaceAutoPublishEnabled` alanı yok; yabancıya 404. Mevcut 401/403/404 testleri aynen.
- E2E `request-auto-publish` (`expectPublishedSuccess`): AÇIK'ta oturumlu müşteri başarı ekranında artık "ön incele"/"onay" yokluğu da doğrulanır. `request-success-screen`: KAPALI `review` + misafir nötr makbuz + başkası/yok 404 + vitrin `targeted` aynen geçer.
- Vitrin lead formu: `request-next-steps-note.spec.ts` iki ayar durumunda da `request-form-intro`/`request-next-steps` testid'lerinin ve dört cümlenin gövdede olmadığını doğrular.

## 4. Fail-closed / sızıntı

- `getMarketplacePublishPolicy`: HTTP 500/503/404/401, JSON olmayan gövde, `{autoPublishEnabled:"true"}`, ağ hatası → `false` → kapalı cümle (`apps/web/test/marketplace-publish-policy-read.spec.ts`, gerçek `apiFetch`). Gövde okuma katılığı REQ-UX-008 testlerinde (8 bozuk biçim).
- Form ve not aynı `Promise.all` içindeki tek okumayı paylaşır; ikisi birbirinden farklı cümle gösteremez.
- Başarı ekranı bayrağı hiç okumaz; oturumsuz/rol dışı/yabancı için yeni veri yok.

## 5. Testler (RED→GREEN)

- **Web unit** `request-next-steps.spec.ts` (+2): `requestFormIntroText is not a function` ile düştü → yardımcı eklendi → geçti.
- **E2E** `request-next-steps-note.spec.ts`: `page.tsx` değişikliği geri alınmış hâlde koşuldu → `getByTestId('request-form-intro')` bulunamadı (1 failed) → değişiklik uygulanınca 2/2.
- **Karakterizasyon (hemen geçti, beklenen)**: `request-success-screen.spec.ts` (10), `marketplace-publish-policy-read.spec.ts` (9), API `customer-request-detail` (+1). Kod değişikliği gerekmediğinin kanıtı olarak eklendi.

## 6. Kalite kapıları

| Komut | Sonuç |
| --- | --- |
| `pnpm typecheck` | geçti (5/5) |
| `pnpm lint` | geçti (4/4) |
| `pnpm test` | shared 165/165 · admin 49/49 · web 190/190 (24 dosya) · api **2945/2945** (126 dosya) |
| `pnpm build` | geçti (3/3) |
| `pnpm e2e request-next-steps-note request-success-screen request-auto-publish` | 7/7 (Chromium) |
| CI (#87) | run 35230936859 @ `b4c81298` 3/3 geçti: `typecheck · lint · test · build` 10m17s, `e2e (chromium)` 13m15s, `e2e (webkit · sign-in and mobile shells)` 11m53s. Bu satırı ekleyen commit docs-only; kod ağacı `b4c81298` ile aynıdır. |

## 7. Responsive kanıt (Chromium; `docs/superpowers/plans/2026-09-17-req-ux-009-screens/`)

| Durum | 320 | 768 | 1440 |
| --- | --- | --- | --- |
| Açık | `request-form-intro-on-320.png` | `request-form-intro-on-768.png` | `request-form-intro-on-1440.png` |
| Kapalı | `request-form-intro-off-320.png` | `request-form-intro-off-768.png` | `request-form-intro-off-1440.png` |

E2E her genişlikte iki durumda: intro ve not viewport içinde, `scrollWidth ≤ clientWidth`, `scrollHeight ≤ clientHeight`, sayfa yatay taşması 0.

## 8. Açık riskler / notlar

- **`REQUIRE_PHONE_VERIFICATION=true` + AÇIK + doğrulanmamış telefon**: talep `SUBMITTED` doğar ve `verifyCode`'da yayınlanır; başarı ekranı bu durumda "ön incelemeye gönderildi" der, doğrusu "telefonunuzu doğrulayın" olurdu. Sözleşme "API durumundan sapma yapma" dediği ve bayrak varsayılan `false` olduğu için değiştirilmedi; ayrı iş.
- **Landing** (`app/page.tsx` "Admin ön inceleme", `landing-hero.tsx` "Ön inceleme · Her talep") statik pazarlama kopyası; AÇIK'ta gerçekle uyuşmaz. Talep yolu dışı olduğu için kapsam dışı bırakıldı.
- **Kategori açıklaması DB içeriğidir**; bir kategorinin açıklamasına "ön inceleme" yazılmışsa kod bunu değiştiremez. Seed/import kümesinde böyle bir metin yok (`grep` ile bakıldı).
- Talep detayı zaman çizelgesindeki "Ön inceleme" adımı AÇIK'ta doğan talepte "tamamlandı" görünür — durum göstergesi olduğu için bırakıldı; UX açısından "atlandı" gösterimi düşünülebilir.
