# REQ-UX-008 — "Sırada ne var?" metni otomatik yayın durumuna göre — Teslim Raporu

Tarih: 2026-09-17 · Branch: `claude/request-form-autopublish-text-57dabc` (taban `main` @ `a89699fa`) · PR: https://github.com/umutciftciii/taktic/pull/86 · Merge: **yapılmadı**

Migration yok. Prisma/schema, `.env`, compose/Dockerfile, Turnstile, ödeme/SMS/e-posta, provider eşleşme ve `marketplaceAutoPublishEnabled` ayarının yazma yolu değişmedi. Staging, yerel container/DB, Cloudflare ve dış servislere dokunulmadı.

---

## 1. Ayar okuma sözleşmesi

Mevcut durumda ayarın tek public projeksiyonu yoktu: `GET /operations-settings/marketplace-publish` SUPER_ADMIN'e kilitli ve değişiklik geçmişini (`recentChanges`, kim/ne zaman) taşıyor. Talep oluşturma yolu ayarı `MarketplacePublishSettingsService.isAutoPublishEnabled()` ile okuyor (satır yok → `false`, okuma hatası → loglanır ve `false`).

Eklenen en dar projeksiyon (`RefundPolicyController` örüntüsü):

- `GET /marketplace-publish-policy` → `{ "autoPublishEnabled": boolean }`
- `apps/api/src/modules/operations-settings/marketplace-publish-policy.controller.ts` (yeni; guard yok, oturum gerekmez), `OperationsSettingsModule`'a kaydedildi.
- Değer aynı `isAutoPublishEnabled()` ile okunur; başka alan, audit, operatör veya başka operasyon ayarı yanıtta yok. PUT/POST aynı yolda 404.

## 2. Web ve fail-closed zinciri

- `apps/web/lib/request-next-steps.ts` (yeni): `NEXT_STEPS_TITLE`, `nextStepsNoteText(enabled)` (iki sabit cümle), `readMarketplacePublishPolicy(unknown)` — yalnız `{ autoPublishEnabled: true }` biçimi (literal boolean) AÇIK; `null`, `{}`, `"true"`, `1`, dizi, farklı alan → KAPALI.
- `apps/web/lib/api.ts` → `getMarketplacePublishPolicy()`: mevcut `apiFetch` (`cache: 'no-store'`) ile okur; fetch hatası/zaman aşımı/HTTP hatası → `false`; gövde `readMarketplacePublishPolicy` ile katı okunur.
- `apps/web/app/categories/[slug]/page.tsx` (sunucu bileşeni; `cookies()` kullandığı için her istekte çalışır) değeri `Promise.all` içinde okur ve `RequestForm`'a `autoPublishEnabled` prop'u verir. Prop verilmezse `false`.
- `apps/web/app/categories/[slug]/next-steps-note.tsx` (yeni): `NextStepsNote` → `<div class="rail-note" data-testid="request-next-steps" data-auto-publish="on|off">`; başlık `Sırada ne var?` sabit.
- `request-form.tsx`: satır içi metin bu bileşenle değiştirildi; başka değişiklik yok.

Cache politikası: istemci tarafında cache yok; SSR her sayfa yüklemesinde API'ye gider (`no-store`). Ayar değişince bir sonraki sayfa yüklemesi güncel cümleyi gösterir (E2E'de kapalı→açık→kapalı üç yeni yüklemeyle kanıtlandı). İstemcinin metin üzerinden karar verebileceği bir yol yok; talep oluşturma API'si aynı ayarı gönderim anında kendisi okumaya devam eder.

## 3. Etkilenen / etkilenmeyen yüzeyler

| Yüzey | Durum |
| --- | --- |
| Normal marketplace talep formu (`/categories/[slug]`, leaf kategori) | **değişti** — kutu iki cümleden birini gösterir |
| Vitrin / direct lead formu (`/vitrin/[cardId]?step=form`, `lead-form.tsx`) | değişmedi — `rail-note`/"Sırada ne var?" hiç yoktu; `NextStepsNote` yalnız `request-form.tsx` tarafından içe aktarılır (`grep -rn next-steps-note apps/web` → tek kullanıcı); E2E iki ayar durumunda da metnin/testid'in olmadığını doğrular |
| Başarı ekranı, landing, e-posta, admin | değişmedi — dosyalarına dokunulmadı |

## 4. Testler (RED→GREEN)

- **API** `apps/api/test/marketplace-publish-policy.spec.ts` (6) — önce 5/5 `404` ile düştü, controller eklenince geçti: satır yok → `false`; kapatıldıktan sonra `false`; açıkken oturumsuz `true`; yanıt anahtarları yalnız `['autoPublishEnabled']` (`recentChanges`/`updatedBy`/refund alanı yok); `findUnique` reddedilince 200 + `false`, sonraki okuma gerçek değer; PUT/POST 404.
- **Web unit** `apps/web/test/request-next-steps.spec.ts` (16) — önce modül bulunamadı ile düştü: iki tam cümle; başlık; katı gövde okuma (8 bozuk biçim); render markup (`rail-note`, testid, `data-auto-publish`, `<strong>Sırada ne var?</strong>`, tam metin, açıkken "ön inceleme" yok); prop yokken kapalı cümle.
- **E2E** `e2e/tests/request-next-steps-note.spec.ts` (2) — önce `request-next-steps` bulunamadı ile düştü: ayar fixture (`setAutoPublish`) ile kapalı → kapalı cümle; açık → yeni yüklemede açık cümle; 320/768/1440 × {on, off} kutu viewport içinde, `scrollWidth ≤ clientWidth`, `scrollHeight ≤ clientHeight`, sayfa taşması 0, ekran görüntüleri; tekrar kapalı → kapalı cümle; `afterEach` ayarı kapatır. Vitrin canlı kart seed'i ile lead formunda testid 0 ve iki cümle/başlık gövdede yok; placement `afterEach`'te emekli edilir.

## 5. Kalite kapıları

| Komut | Sonuç |
| --- | --- |
| `pnpm typecheck` | geçti |
| `pnpm lint` | geçti |
| `pnpm build` | geçti |
| `pnpm --filter @taktic/web test` | 169/169 (22 dosya) |
| API ilgili spec'ler (`marketplace-publish-policy`, `marketplace-publish-settings`, `request-auto-publish`, `operations-settings`) | 33/33 |
| API tam suite (yerel) | 2943/2944 — `account-email-role-conflict.spec.ts › two simultaneous cross-role registrations cannot both win` **1 başarısız** (bilinen yarış flake'i, REQ-UX-006 raporunda da kayıtlı; bu PR auth/kayıt yoluna dokunmuyor) |
| `pnpm e2e request-next-steps-note` | 2/2 |
| CI (#86) | run 35218547905 @ `d91ffb3d` (kod head'i) 3/3 geçti: `typecheck · lint · test · build` 13m13s, `e2e (chromium)` 15m31s, `e2e (webkit · sign-in and mobile shells)` 12m8s |

## 6. Responsive kanıt (Chromium; `docs/superpowers/plans/2026-09-17-req-ux-008-screens/`)

| Durum | 320 | 768 | 1440 |
| --- | --- | --- | --- |
| Açık | `request-next-steps-on-320.png` | `request-next-steps-on-768.png` | `request-next-steps-on-1440.png` |
| Kapalı | `request-next-steps-off-320.png` | `request-next-steps-off-768.png` | `request-next-steps-off-1440.png` |

## 7. Açık risk / not

- Aynı sayfanın **başlık altındaki varsayılan açıklama** (`page.tsx`, kategori açıklaması boşken: "…talebin ön incelemeden geçtikten sonra…") ve `requests/success` "ön incelemeye gönderildi" kopyaları kapsam dışı bırakıldı; otomatik yayın açıkken bu metinler hâlâ ön incelemeden söz edebilir. Ayrı iş olarak ele alınmalı.
- Public uç kimlik doğrulaması ve hız sınırı olmadan tek boolean döner; sızdırdığı bilgi, formun zaten ekranda yazdığı cümleyle aynıdır.
- E2E ayarı doğrudan DB fixture'ı ile değiştirir (admin ekranı değil); admin ekranı üzerinden değiştirme `request-auto-publish.spec.ts`'in konusudur.
