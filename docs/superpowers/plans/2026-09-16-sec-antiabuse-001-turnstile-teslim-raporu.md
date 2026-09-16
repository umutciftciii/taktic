# SEC-ANTIABUSE-001 — Cloudflare Turnstile ile müşteri kaynaklı spam/bot koruması — teslim raporu

Tarih: 2026-09-16 · Dal: `claude/cloudflare-turnstile-spam-691780` · Taban: `main@f04e7f5c` (PR #82 merge)
· Durum: **PR açıldı, merge edilmedi.** Migration **yok**; `.env`/compose/container/staging/Cloudflare dokunulmadı.
Tasarım: `docs/superpowers/specs/2026-09-16-sec-antiabuse-001-turnstile-design.md`.

## 1. Kök neden ve tehdit modeli

Altı müşteri kaynaklı yazma route'u oturumsuz ya da ucuz bir oturumla erişilebiliyor ve her biri bir maliyet
üretiyordu: `ServiceRequest` (moderasyon kuyruğu; otomatik yayın açıkken doğrudan sağlayıcı önü),
`ShowcaseLead` (işletmeye ulaşan mesaj + SLA saati), SMS gönderimi (sağlayıcı ücreti; iki yol), aktivasyon
maili (posta itibarı), kimlik ön-kontrolü (hesap varlığı sorgusu). Mevcut savunmalar — IP throttle, numara
başına bütçeler, telefon kanıtı, kimlik gate'i — tek bir script'in maliyetini yükseltiyor ama dağıtık, düşük
hızlı bot trafiğini insan trafiğinden ayıramıyordu. Turnstile bu ayrımı yapan **ek** katman; hiçbir mevcut
savunmanın yerine geçmiyor.

| Saldırgan | Yol | Yeni davranış |
|---|---|---|
| Kafasız script (curl) | Doğrudan API'ye POST, header yok | 403 `TURNSTILE_REQUIRED`, sıfır yan etki (E2E'de canlı stack'e karşı kanıtlandı) |
| Token taklidi / eski token | Uydurma değer | `siteverify` reddeder → 403 `TURNSTILE_FAILED` |
| Başka action için alınmış token | `identity-check` token'ı ile talep açma | `action` eşleşmez → 403 |
| Başka sitede alınmış token | Farklı `hostname` | Beklenen liste dışı → 403 |
| Token çoğaltma | Aynı token tekrar / başka uçta | API tarafı SHA-256 tek-kullanım kilidi (5 dk) + Cloudflare tek-kullanım → 403 |
| Doğrulama altyapısı çökertme | siteverify timeout / 5xx / bozuk gövde | **fail-closed** 503 `TURNSTILE_UNAVAILABLE`, sıfır yan etki, "tekrar deneyin" |
| Yapılandırma hatası | Secret/hostname eksik | **boot reddi** (değişken adı loglanır, değeri asla) |
| Bypass sızması | staging/prod'da `test`/`off` | boot reddi |

## 2. Değişen dosyalar ve kararlar

**Paylaşılan sabitler** — `packages/shared/turnstile.json`: header adı (`x-turnstile-token`), action adları,
test-token öneki. JSON, çünkü API `@taktic/shared`'i CommonJS'ten `require` edemez (bkz. `limits.json` deseni).

**API — `apps/api/src/modules/turnstile/`** (yeni modül, `@Global()`):

| Dosya | Karar |
|---|---|
| `turnstile.config.ts` | `TURNSTILE_MODE` çözümü. **Boşken ortamı izler:** `APP_ENVIRONMENT=local` ya da `NODE_ENV=test` → `test`; staging/production/bildirilmemiş → `cloudflare` (secret + hostname zorunlu, yoksa boot reddi). Açık `test`/`off` yalnız local/test'te; staging/prod'da boot reddi. `NODE_ENV` tek başına ortam kararı vermez. `off` + secret birlikte → ret. `parseAppEnvironment` `common/app-environment.ts`'e çıkarıldı. |
| `cloudflare-turnstile.verifier.ts` | `fetch` enjekte; form-encoded POST; `AbortController` timeout; `success && hostname ∈ liste && action === beklenen`; diğer her şey ret. Log'a yalnız `error-codes` ve action; token/secret asla. |
| `test-turnstile.verifier.ts` | `turnstile-test:<action>:<nonce>`; `__unavailable__` → 503 yolu. Gerçek Cloudflare token'ı bile reddedilir. |
| `off-turnstile.verifier.ts` | Entegrasyon suite'i için; yalnız izinli ortamda bağlanır. |
| `turnstile-replay.cache.ts` | Özet (SHA-256) → TTL; token ilk görüşte kilitlenir, sonuç ne olursa olsun. |
| `turnstile.guard.ts` | Header okur, boy sınırı (2048), replay claim, verifier, hata eşlemesi. `@TurnstileAction` yoksa reddeder (yanlış kullanım fail-closed). IP yalnız `req.ip` (TRUST_PROXY sözleşmesi). |
| `turnstile.module.ts` | Port'u moda göre factory ile bağlar; `main.ts` `assertTurnstileConfig()` ile önce sorar. |

**Guard sırası:** throttle → Turnstile → auth. Token'sız sel adresin bütçesini yer, siteverify çağrısı değil;
geçerli token'lı sel yine 429 alır (testli).

Korunan route'lar: `service-requests.controller.ts` (POST), `showcase-public.controller.ts`
(`lead-verification`, `cards/:id/leads`), `phone-verification.controller.ts` (POST send — verify **değil**),
`auth/request-identity.controller.ts` (check, activate). DTO'lara alan eklenmedi; `…/verify` uçları kapsam dışı
(SMS göndermez, kendi deneme bütçesi var).

**Web:**

| Dosya | Karar |
|---|---|
| `lib/turnstile.ts` | `readTurnstileWebConfig` — `TURNSTILE_MODE` + `TURNSTILE_SITE_KEY` sunucuda **istek zamanında** okunur (`NEXT_PUBLIC_` değil: build tek, E2E stack'leri farklı env). Boş mod `APP_ENVIRONMENT=local` → `test`, aksi `cloudflare` (site key yoksa `unconfigured` = **kapalı**: slot uyarısı + gönder/kod-iste düğmeleri disabled + kimlik gate'i açılmaz). `test`/`off` yalnız local. `turnstileHeaders`, `resolveTestTurnstileToken`. |
| `app/request-fields/turnstile.tsx` | Tek adapter: `useTurnstile(config)` + `<TurnstileSlot>`. `cloudflare`: api.js explicit, `execution:'execute'`, `appearance:'interaction-only'`, action başına yeni widget; `test`: ağ yok, `window.__TAKTIC_TURNSTILE_TEST__` ile E2E yönlendirmesi; `off`: token yok; `unconfigured`: acquire reddeder, slot "kullanılamıyor". Challenge'lar sırayla (kuyruk). |
| `request-fields/identity-check.ts` | Opsiyonel `acquireToken`; alım/ret → mevcut `error` durumu ("İletişim bilgileri doğrulanamadı, tekrar deneyin.") — hesap durumu hakkında hiçbir ek bilgi yok. |
| `categories/actions.ts`, `vitrin/[cardId]/actions.ts`, `requests/[id]/offers/actions.ts` | Token **ayrı argüman**, FormData'da değil → `draftPayloadFromForm`'a giremez. Header yalnız korunan çağrıda. |
| `api/auth/request-identity-check{,/activate}/route.ts` | Header aynen iletilir; proxy karar vermez. |
| `request-form.tsx`, `lead-form.tsx` | Slot adım panellerinin **dışında**, düğmelerin üstünde (etkileşimli challenge son adımda da görünür). Form sırası, taslak, identity notice, SMS akışı değişmedi. |
| `requests/[id]/offers/phone-verification-card.tsx` | Kart client bileşenine taşındı; yalnız "kod gönder" token ister, "Doğrula" düz form. Sayfa numarayı maskeleyip verir. |
| `lib/request-refusal-text.ts` | `TURNSTILE_REQUIRED/FAILED` → "Güvenlik doğrulaması başarısız oldu. Lütfen tekrar deneyin."; `TURNSTILE_UNAVAILABLE` → "…şu anda yapılamıyor. Lütfen birkaç saniye sonra tekrar deneyin."; `TURNSTILE_CHALLENGE_FAILED` (widget) → "…tamamlanamadı. Lütfen tekrar deneyin." |

**Compose (`docker-compose.yml`, yalnız api + web):** `APP_ENVIRONMENT: ${APP_ENVIRONMENT:-local}` ve
boş-when-unset `TURNSTILE_MODE` / `TURNSTILE_SECRET_KEY` / `TURNSTILE_EXPECTED_HOSTNAMES` /
`TURNSTILE_SITEVERIFY_TIMEOUT_MS` (api), `TURNSTILE_MODE` / `TURNSTILE_SITE_KEY` (web). Değer yok; secret
yalnız api servisine.

**Test altyapısı:** `apps/api/test/setup-env.ts` suite geneli `TURNSTILE_MODE=off` (NODE_ENV=test ile izinli),
`harness.ts` `turnstileVerifier` override'ı; `e2e/playwright.config.ts` **mod adı geçmez** — API'ler NODE_ENV=test,
web'ler `APP_ENVIRONMENT=local` ile varsayılan `test` adapter'ına düşer (compose'un boot ettiği yolun aynısı);
ek bir web süreci (`turnstileClosedWebRuntime`, :3250) `APP_ENVIRONMENT=staging` + site key'siz — kapalı web kanıtı.
WebKit `testMatch`'e `turnstile-protection` eklendi.

## 3. Environment matrisi ve yeni değişkenler

| Ortam | `APP_ENVIRONMENT` | Turnstile modu (mod boşken) | Secret / hostname / site key yoksa |
|---|---|---|---|
| Yerel geliştirme (compose) | `local` (compose varsayılanı) | **test adapter** | Uygulama normal açılır; gerçek Cloudflare çağrısı yok |
| Birim / E2E test | — / `local` (NODE_ENV=test) | **test adapter** | aynı |
| Staging | `staging` (deployment bildirir) | **cloudflare** | API **boot reddi**; web formları **kapalı** (slot uyarısı, düğmeler disabled, gate açılmaz) |
| Production | `production` (deployment bildirir) | **cloudflare** | aynı |
| Bildirilmemiş | — | **cloudflare** | aynı (bilinmeyen = kapalı) |

`test`/`off` açıkça verilirse yalnız ilk iki satırda kabul; staging/production'da boot reddi (`TURNSTILE_MODE=off is
refused here …`). `NODE_ENV` tek başına ortam kararı vermez: yerel stack production build olabilir, web `next start`
altında hep production'dır.

| Değişken | Uygulama | Gerekli ortam | Güvenli varsayılan / yokken davranış |
|---|---|---|---|
| `APP_ENVIRONMENT` | api, web | staging, prod bildirir; compose `local` geçer | yok → production gibi kapalı |
| `TURNSTILE_MODE` | api, web | opsiyonel | yok → ortamı izler (yukarıdaki tablo) |
| `TURNSTILE_SECRET_KEY` | **yalnız api** | staging, prod | yoksa API boot etmez |
| `TURNSTILE_EXPECTED_HOSTNAMES` | api | staging, prod | yoksa API boot etmez; virgülle ayrılmış, küçük harfe indirgenir |
| `TURNSTILE_SITEVERIFY_TIMEOUT_MS` | api | opsiyonel | 5000; pozitif tam sayı değilse boot reddi |
| `TURNSTILE_SITE_KEY` | web | staging, prod | yoksa formlar kapalı |

`.env.example`'a yorumlu/değersiz eklendi. Gerçek `.env`, GitHub secret, Cloudflare, DB, container değişmedi.
Compose'a yalnız api/web için `APP_ENVIRONMENT` + değersiz `TURNSTILE_*` aktarımı eklendi (runtime sözleşmesi).

## 4. Test sayıları ve CI

| Paket | Komut | Sonuç |
|---|---|---|
| API | `pnpm --filter @taktic/api test` | **123 dosya / 2554 test geçti** (yeni: `turnstile-config` 26, `turnstile-verifiers` 19, `turnstile-protection` 66, `turnstile-boot` 5) |
| Web | `pnpm --filter @taktic/web test` | 19 dosya / 141 test (yeni `turnstile.spec.ts` 14) |
| Shared / Admin | `pnpm test` | 165 / 49 geçti |
| Typecheck · lint · build | `pnpm typecheck && pnpm lint && pnpm build` | geçti |
| E2E Chromium | `pnpm e2e` (tam suite) | **257 geçti** (yeni `turnstile-protection` 8 senaryo dahil; ilk koşuda 1 senaryo Playwright `aria-disabled` aktivasyon kuralı yüzünden düzeltildi, tekrar 8/8) |
| E2E WebKit | `pnpm e2e:webkit` | **102 geçti** (3.3 dk; `turnstile-protection` 8 senaryo WebKit'te de) |
| CI | PR üzerinde | ilk head: 3/3 ✅ · düzeltme head'i `3ade11c1`: `typecheck · lint · test · build` ✅ · `e2e (chromium)` ✅ · `e2e (webkit)` ✅ |
| Boot kanıtı (compose env) | `docker compose config` → env → `node dist/main.js` / `next start` | aşağıda §4.1 |

### 4.1 Boot kanıtı — mevcut compose, değersiz `.env`

`.env` bulunmayan worktree'de `docker compose config` api/web için şunu üretir: `APP_ENVIRONMENT=local`,
`NODE_ENV=development`, `TURNSTILE_MODE=''`, `TURNSTILE_SECRET_KEY=''`, `TURNSTILE_EXPECTED_HOSTNAMES=''`,
`TURNSTILE_SITE_KEY=''` (web). Bu env **aynen** derlenmiş `apps/api/dist/main.js` ve `next start`'a verildi
(container/DB'ye dokunmadan; yalnız `postgres` hostname'i → localhost:5433 `taktic_e2e`, portlar 390x):

| Adım | Sonuç |
|---|---|
| 1. API, local compose env | `/health` 200 · `POST /service-requests` header'sız → `403 TURNSTILE_REQUIRED` · `identity-check` + `turnstile-test:identity-check:…` → 200 · API log'unda `challenges.cloudflare.com` 0 |
| 2. Web, local compose env | `/categories/<slug>` 200 · HTML `data-turnstile-mode="test"` · Cloudflare script 0 |
| 3. API `APP_ENVIRONMENT=staging`, secret yok | exit 1: `TURNSTILE_SECRET_KEY is required: TURNSTILE_MODE is "cloudflare" (the default for APP_ENVIRONMENT "staging")…` · `/health` cevap yok |
| 4. API `APP_ENVIRONMENT=production` + `TURNSTILE_MODE=off` | exit 1: `TURNSTILE_MODE=off is refused here…` (`APP_ENVIRONMENT=staging` + `test` de aynı) |
| 5. Web `APP_ENVIRONMENT=staging`, site key yok | `/categories/<slug>` 200 · `data-turnstile-mode="unconfigured"` · `turnstile-unconfigured` uyarısı 1 |

E2E'de aynı kapalı web (`turnstileClosedWebRuntime`) üç senaryoyla: normal form gate açılmaz ("Devam et"
`aria-disabled`, zorla tıklama adım ilerletmez, talep 0); vitrin kod-iste ve gönder disabled + ipucu "Güvenlik
doğrulaması şu anda kullanılamıyor."; teklifler sayfası kod-iste disabled. Playwright config'inde mod adı geçmez;
beş stack varsayılan yoldan `test` adapter'ına düşer ve tüm mevcut akışlar (normal talep, vitrin lead, iki SMS yolu,
identity check, activation) bu yolla çalışır.

Kanıtlanan spec maddeleri (`apps/api/test/turnstile-protection.spec.ts`, 6 route × matris):
geçerli token → eski davranış ve yan etki (+1 kayıt / +1 SMS / +1 mail); eksik / geçersiz / action uyuşmaz /
hostname uyuşmaz → 403 ve **0 yan etki** (ServiceRequest, ShowcaseLead, PhoneVerification, NotificationLog,
CustomerActivationToken, tüketilmiş RequestDraft, User, SMS, mail); timeout / 5xx / bozuk JSON → 503 ve 0 yan
etki; aynı token tekrar / başka uçta (ilk kullanım reddedilmiş olsa bile) → 403; taslak tüketilmez; IP throttle
geçerli token'larla da 429; kimlik throttle Turnstile'dan önce; mevcut 403 (sağlayıcı oturumu) aynen.
`turnstile-boot.spec.ts`: local'de hiçbir değer olmadan boot + `TestTurnstileVerifier` bağlı; staging'de değer yok →
boot etmez; bildirilmemiş + NODE_ENV=production → boot etmez; production'da `test` → boot etmez.
E2E (`e2e/tests/turnstile-protection.spec.ts`): normal form (identity check ret → "Tekrar dene" → geçer;
submit `invalid`/`error`/`unavailable` → üç ayrı cümle, 0 talep; sonra başarı), aktivasyon bağlantısı
(`invalid` → mail yok, "sent" yok, hesap durumu sızmaz; retry → mail 1), vitrin (SMS `invalid` → 0 SMS;
"Kodu yeniden gönder" → kod; lead `unavailable` → 0 lead, kanıt korunur; sonra gönderildi), teklifler sayfası
OTP (`challenge-failed` → 0 SMS; retry → `ok`, 1 SMS), tarayıcısız POST → 403. Her adımdan sonra token'ın
URL / HTML / localStorage / sessionStorage / çerezlerde olmadığı; sayfada Cloudflare script'i olmadığı.

## 5. Staging'de Cloudflare tarafında elle yapılacaklar (sıralı)

1. Cloudflare Dashboard → Turnstile → **Add widget** × 3: `taktic-local`, `taktic-staging`, `taktic-prod`.
   Widget mode: *Managed*; pre-clearance kapalı.
2. Her widget'ın **Hostnames** listesi yalnız kendi ortamı: staging widget'ına yalnız staging web hostname'i
   (www'lu/www'suz iki biçim varsa ikisi), prod'a yalnız prod. Local widget'ına `localhost`.
3. Staging site key'ini web ortamına: `TURNSTILE_SITE_KEY=<staging site key>` (public; web servisine).
4. Staging secret'ını **yalnız API** ortamına (secret store / GitHub environment secret; dosyaya değil):
   `TURNSTILE_SECRET_KEY=<staging secret>`, `TURNSTILE_EXPECTED_HOSTNAMES=<staging hostname(ler)>`.
   `TURNSTILE_MODE` **boş bırak** (= cloudflare). Staging'de `APP_ENVIRONMENT=staging` kalır.
5. Deploy; API log'unda boot hatası olmadığını, `GET /health`'in cevap verdiğini doğrula.
6. Staging'de elle: normal talep formu, vitrin lead + SMS, kimlik gate (kayıtlı numara → giriş yönlendirmesi),
   aktivasyon bağlantısı, teklifler sayfasında "Doğrulama kodu gönder". Her biri widget görünmeden ya da kısa bir
   etkileşimle geçmeli; `curl -X POST …/service-requests` → 403 `TURNSTILE_REQUIRED`.
7. Cloudflare Turnstile **Analytics**'te staging widget'ında solve/verify sayıları görülmeli;
   `hostname-mismatch` / `invalid-input-secret` gibi hatalar sıfır olmalı.
8. Yalnız 6–7 doğrulandıktan **sonra** admin panelinden `marketplaceAutoPublishEnabled` açılabilir; Turnstile
   doğrulanmadan otomatik yayın açılmamalı.
9. Prod için 2–7'yi prod widget/anahtarlarıyla tekrarla; local widget test/geliştirme içindir (yerel stack
   `TURNSTILE_MODE=test` ile ağa çıkmadan da çalışır).
10. Anahtar rotasyonu: Cloudflare'da **Rotate secret** → API ortamını güncelle → yeniden başlat. Site key
    değişmez.

## 6. Kapsam dışı / değişmeyen

Migration, Prisma şeması, ödeme, kredi, e-posta/SMS sağlayıcıları, scheduler, rate-limit değerleri, telefon
doğrulama sözleşmesi, RequestDraft, activation redirect, mevcut 4xx/409/403 kodları ve metinleri. Cloudflare
test anahtarları hiçbir yerde varsayılan değil. Gerçek anahtar repoda/test çıktısında/logda yok.
