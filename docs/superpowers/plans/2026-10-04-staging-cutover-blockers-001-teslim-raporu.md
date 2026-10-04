# STAGING-CUTOVER-BLOCKERS-001 — Teslim raporu

- Taban: `main` `e98d604e230409fabc8d4a07e569e3f46eb5a71c` (#142), DB 86 migration
- Dal: `claude/staging-cutover-blockers-001`
- Migration: **yok** (şema değişmedi; DB 86'da kaldı)
- Staging'e deploy **yapılmadı**; staging checkout'u, `.env`'i, container'ları,
  volume'ları ve veritabanı değişmedi. Cloudflare/Lemon/Resend ayarlarına ve
  PR #71'e dokunulmadı. İş, staging checkout'undan ayrı bir clone'da yapıldı
  (staging checkout'u çalışan dev container'lara bind-mount'lu olduğu için).
- Runbook: [docs/ops/deploy-runtime.md](../../ops/deploy-runtime.md) §3–4

## 1. Kapatılan blocker'lar (STAGING-CUTOVER-PREFLIGHT-001)

| # | Blocker | Kapanış |
|---|---|---|
| 1 | `PROMOTION_FINGERPRINT_KEY` eksik → yeni API migration'dan **sonra** boot edemez | Preflight 5b (statik sözleşme) ve 5c (image içi boot kontrolü) API durdurulmadan önce FAIL verir. Değeri operatör `.env`'e yazar. |
| 2 | `NODE_ENV=production` + `lemon-squeezy-test` boot reddi | Guard `APP_ENVIRONMENT`'a bağlandı: staging'de geçerli, production'da red. `API_NODE_ENV` workaround'u kaldırıldı. |
| 3 | `COMPOSE_PROJECT_NAME` eksik | Zaten anında duruyordu; ek olarak sözleşme beklenen projeyi (`taktic-staging`) doğrular. |
| 4 | Image'lar `--check` sırasında build ediliyordu | `--check` artık build/fetch/yazma yapmaz; image gerektiren kontroller NOT RUN (exit 3). |
| 5 | Uploads volume 0:0, prod API uid 1000 | Preflight her girdiyi image'ın gerçek uid:gid'iyle kontrol eder; düzeltme API durdurulmadan önce (adım 1b), yalnız bağlı volume'a, içerik sha256 ile doğrulanarak. |

## 2. Lemon staging runtime sözleşmesi

`apps/api/src/modules/payments/payment-provider.config.ts`,
`isSandboxPaymentProviderPermitted`:

| `APP_ENVIRONMENT` | `NODE_ENV` | `lemon-squeezy-test` |
|---|---|---|
| `production` | her değer | **red** |
| `staging` | her değer (`production` dahil) | izinli |
| `local` / bildirilmemiş | `production` | red (eski kural) |
| `local` / bildirilmemiş | diğer | izinli (eski kural, yerel/test aynı) |
| geçersiz değer | — | `parseAppEnvironment` boot reddi |

**Production güvenlik değişmezi:** live mod hâlâ yok — `LEMON_SQUEEZY_LIVE_*`,
`PAYMENT_LIVE_ENABLED` (herhangi bir değerle) ve `LEMON_SQUEEZY_MODE`≠`test`
her ortamda (staging dahil) boot'u durdurur. `APP_ENVIRONMENT=production`
sandbox sağlayıcıyı `NODE_ENV`'den bağımsız reddeder; prod compose
`LEMON_SQUEEZY_API_BASE_URL` test seam'ini iletmez ve seam `NODE_ENV=production`
altında zaten reddedilir. Runtime sözleşmesi production'da yalnız `mock`'a izin
verir.

`docker-compose.prod.yml` artık `NODE_ENV: production` **literal** yazar
(`API_NODE_ENV` override'ı yok; `.env`'de kalmışsa etkisiz — testle kanıtlı).

## 3. Preflight artık migration öncesi neyi doğruluyor

Her ikisi de adım 1'de, API durdurulmadan ve checkout/migration'dan önce:

- **5b runtime sözleşmesi** (`scripts/ops/runtime-contract.mjs`, çözümlenmiş
  compose yapılandırması üzerinde; çıktı yalnız ad + PASS/WARN/FAIL):
  `COMPOSE_PROJECT_NAME` = beklenen proje (staging: `taktic-staging`,
  `--project` ile), `APP_ENVIRONMENT` (api + web) = `--environment`,
  `NODE_ENV (api)` = `production`, `PROMOTION_FINGERPRINT_KEY` (var, ≥ 32,
  geliştirme anahtarı değil) ve `_VERSION`, `PAYMENT_PROVIDER` ortam için izinli,
  sandbox ise dört Lemon anahtarı + mod `test`/boş ("test-payment contract"),
  live anahtar yok, `API_PUBLIC_URL`/`WEB_APP_URL`/`WEB_ORIGIN`/`ADMIN_ORIGIN`
  ve `NEXT_PUBLIC_API_URL` https + loopback değil (`NEXT_PUBLIC_WEB_URL` uyarı),
  `EMAIL_TRANSPORT=resend` + `RESEND_API_KEY` + pinlenmiş gönderici, Turnstile
  secret/hostnames/site key, SMS stand-in (§7).
- **5c boot yapılandırması**: yeni `taktic-api:<sha>` image'ında
  `node dist/boot-config-check.js`, `compose run --rm --no-deps -T api` ile —
  yeni API'nin alacağı env'in aynısı. `main.ts`'in çalıştırdığı listenin aynısı
  (`apps/api/src/boot-config.ts`, tek kaynak); hepsi raporlanır, ilk hatada
  durmaz; DB bağlantısı/listener yok.

## 4. `--check` davranışı

`deploy-staging.sh --check`: `git fetch` yok, image build yok, log dosyası/dizin
yok, `mkdir` yok; durdurma/checkout/migration/recreate yok. Preflight
`--allow-missing-images` ile çalışır: image yoksa 5c ve 7 **NOT RUN**, çıkış
`3`; image'lar varsa tam kontrol, çıkış `0`; FAIL → `1`. Image build ayrı ve açık
adım: `scripts/ops/build-images.sh <sha>` (ya da gerçek deploy'un adım 0'ı).
Preflight'ın kendisi de artık yedek dizinini oluşturmuyor.

## 5. Uploads ownership

- Preflight: volume, API container'ının `/app/apps/api/uploads` bağlantısından
  okunur ve prod compose'un bağlayacağıyla aynı olmalıdır. Beklenen sahip
  image'dan okunur (`id -u`/`id -g`; image yoksa Dockerfile'ın `1000:1000`'i).
  **Her girdi** uid **ve** gid için kontrol edilir; link/özel dosya FAIL.
  Root sahipli + bayraksız → FAIL (`--fix-uploads-ownership` önerisiyle).
- `--fix-uploads-ownership` (adım 1b, API durdurulmadan önce): yalnız bağlı
  volume tek `-v` ile; ağ yok, yalnız `CHOWN` yeteneği; link/özel dosya varsa
  reddeder; yalnız normal dosya + dizin sahipliği değişir; önce/sonra dosya
  listesi + sha256 aynı olmalı, sonra yabancı sahipli girdi kalmamalı. Boş volume
  geçerli. Eski adım-8 `chown -R` kaldırıldı.

## 6. Testler

| Kapsam | Sonuç |
|---|---|
| `apps/api/test/payment-provider-config.spec.ts` (staging+prod+lemon OK, production red, local eski davranış, live red) | 27/27 |
| `apps/api/test/boot-config.spec.ts` (staging sözleşmesi boot eder, eksik/kısa key, sır basılmaz, SMS stand-in/kayıt transport'u, liste sırası) | 7/7 |
| `apps/api/test/sms-transport.spec.ts` (staging+production NODE_ENV → kod log'da; production → red, kod/numara hiçbir yerde; local/dev eski davranış; kayıt transport'u reddi; **telefon doğrulama dispatch regression**: gerçek `ConsoleSmsAdapter` ile `NotificationDispatcher.sendSms` → staging `SENT` + audit'te kod yok, production `FAILED`/`TRANSPORT_UNAVAILABLE`) | 17/17 |
| `scripts/ops/runtime-contract.test.mjs` (eksik env, kısa key, yanlış proje, production+lemon, URL'ler, SMS PASS/WARN/FAIL, gerçek prod compose çözümlemesi) | 20/20 |
| `scripts/ops/ops-scripts.test.mjs` (sahte `docker` ile gerçek script'ler: preflight FAIL'leri, mutasyon yok, `--check` fetch/build/yazma yok, root uploads ± bayrak, fix tek volume + doğru uid:gid, 1b stop'tan önce) | 15/15 |
| `scripts/ops/compose-security.test.mjs` | 16/16 |
| shellcheck `-S warning` (0.11.0), `bash -n` | temiz |
| `@taktic/api` typecheck + build | temiz |

API spec'leri yerelde DB'siz bir vitest config'iyle koşuldu (staging DB'sine
bağlanmamak için); CI tam suite'i koşar.

CI `ops` job'u artık throwaway stack'i **staging sözleşmesiyle** boot eder
(`NODE_ENV=production`, `APP_ENVIRONMENT=staging`, `lemon-squeezy-test`,
Resend; yer tutucu değerler), sonra çalışan stack'e karşı preflight ve
`--check`'i koşar, root sahipli gerçek volume'da düzeltmeyi uygular ve ikinci
bir sentinel volume'un 0:0 kaldığını, içerik sha256'sının değişmediğini ve
API'nin yazabildiğini doğrular.

## 7. SMS staging sözleşmesi (final SMS blocker fix)

Karar: staging'e gerçek SMS sağlayıcısı bağlanmaz, staging `NODE_ENV=production`
kalır, mevcut console stand-in staging'de çalışır.

`apps/api/src/modules/notifications/sms-transport.ts` +
`common/app-environment.ts` `isSandboxIntegrationPermitted` (Lemon sandbox ile
**aynı** kural):

| `APP_ENVIRONMENT` | `NODE_ENV` | Console SMS adapter |
|---|---|---|
| `staging` | her değer (`production` dahil) | kodu **yalnız API process log'una** yazar, `SENT` |
| `production` | her değer | **reddeder**: kod/numara yazılmaz, audit `FAILED` / `TRANSPORT_UNAVAILABLE` |
| `local` / bildirilmemiş | `production` | reddeder (eski kural) |
| `local` / bildirilmemiş | diğer | yazar (eski kural) |
| geçersiz değer | — | boot reddi |

- **Gözlem yöntemi (staging):** host'ta `docker logs taktic-api`. Kod public API
  response'una konmaz (servis kodu hiçbir ortamda döndürmez — değişmedi), debug
  endpoint yok, DB'ye yazılmaz (audit satırı yalnız maskeli numara).
- **Production güvenlik değişmezi:** `APP_ENVIRONMENT=production` console
  adapter'ı `NODE_ENV`'den bağımsız reddeder; production log'una OTP yazılmaz.
  Kayıt transport'u (`NOTIFICATION_OUTBOX_DIR`) `NODE_ENV=production` altında
  (staging dahil) boot'ta reddedilir; gerçek/live SMS sağlayıcısı yok.
- **Bilinçli tercih:** production console SMS ile **boot eder** (SMS tek kanal;
  pazar yerinin geri kalanını kapatmamak için); kapanma adapter'ın gönderim
  reddiyle sağlanır ve runtime sözleşmesi production'da WARN yazar. Production
  boot'unun SMS sağlayıcısız tamamen reddedilmesi istenirse ayrı karar.
- **Boot / preflight:** boot listesine `sms-transport` eklendi (geçersiz
  `APP_ENVIRONMENT`, production'da kayıt transport'u → red; image içi 5c
  kontrolü bunu da çalıştırır). Runtime sözleşmesi: staging → `PASS SMS
  transport`, production → `WARN`, `NOTIFICATION_OUTBOX_DIR` set → `FAIL`.
- Telefon doğrulama **test bypass'ı** değişmedi: `NODE_ENV=production` altında
  (staging dahil) kullanılamaz; staging'de kod log'dan okunur.

## 8. Staging'de gerçek deploy için operatör adımları

1. `.env`: `COMPOSE_PROJECT_NAME=taktic-staging`, `PROMOTION_FINGERPRINT_KEY`
   (≥ 32, bir kez seçilir ve saklanır), önerilen `NEXT_PUBLIC_WEB_URL`,
   `WEB_TRUST_PROXY=true`. `API_NODE_ENV` yazılmaz.
2. Hedef commit'in script'leriyle `--check` (salt-okunur), sonra
   `build-images.sh <sha>` ve tekrar `--check` (exit 0 beklenir).
3. `deploy-staging.sh --sha <sha> --fix-uploads-ownership --allow-empty-uploads`.

## 9. PR / CI

- PR: [umutciftciii/taktic#143](https://github.com/umutciftciii/taktic/pull/143)
- SMS düzeltmesi öncesi head `60ed436` için CI (run 37206532430): **hepsi yeşil**
  (tablo aşağıda); SMS düzeltmesi sonrası exact-head CI PR'da.

| Job | Sonuç | Süre |
|---|---|---|
| ops (compose · scripts · production images) | pass | 5m3s |
| typecheck · lint · test · build | pass | 17m23s |
| e2e (chromium) | pass | 27m39s |
| e2e (webkit · sign-in and mobile shells) | pass | 28m1s |
| record tested merge commit | pass | 8s |
| post-merge gate | skipped (PR'da beklenen) | — |

`ops` kanıtı (log): node ops testleri 50/50; throwaway stack `NODE_ENV (api) = production`
ile boot etti, `PASS test-payment contract` (lemon-squeezy-test, APP_ENVIRONMENT=staging,
NODE_ENV=production), `boot-config: OK`; preflight 0 failure, `--check` "nothing was
changed" ve yedek dizini oluşmadı; root sahipli gerçek volume bayraksız FAIL
("4 entries not owned by 1000:1000"), bayrakla WARN, düzeltme sonrası sha256 aynı,
tümü 1000:1000, sentinel volume 0:0 kaldı, API yazabildi, preflight yeniden temiz;
yedek + izole restore provası geçti.
