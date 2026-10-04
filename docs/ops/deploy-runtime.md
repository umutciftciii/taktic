# Deploy ve runtime güvenliği (OPS-DEPLOY-HARDENING-001)

Bu belge staging/production host'unun nasıl çalıştığını ve nasıl deploy
edildiğini anlatır. Komutların hepsi repo kökünden çalışır. Script'lerin kendi
`--help` çıktıları ayrıntının kaynağıdır; burası akışı ve kararları toplar.

> Bu PR hiçbir ortamda deploy çalıştırmadı. Aşağıdaki "ilk geçiş" adımları
> staging operatörünün planlı bir pencerede uygulaması içindir.

## 1. Model: geliştirme ve production runtime

| | Geliştirme (`docker-compose.yml` + `docker-compose.local.yml`) | Staging / production (`docker-compose.prod.yml`) |
|---|---|---|
| Kod | Checkout bind mount (`.:/app`) | Image içinde, değişmez (`Dockerfile`) |
| API | `ts-node-dev` (hot reload) | `node dist/main.js` (tsc çıktısı) |
| web / admin | `next dev` | `next start` (`next build` çıktısı) |
| node_modules | Container içi named volume, açılışta `pnpm install` | Image içinde, yalnız production bağımlılıkları |
| Prisma client | Her açılışta `pnpm db:generate` | Build sırasında, image platformu için |
| Kullanıcı | root | `node` (uid 1000); kod salt-okunur |
| `git pull` etkisi | Çalışan API anında yeni kodu yükler | Hiçbiri — yeni image + recreate gerekir |
| Migration | Elle / `scripts/ops/local-sync.sh` | Yalnız `scripts/ops/deploy-staging.sh` (guard'lı `migrate` image) |
| PID 1 | node | tini (`init: true`), SIGTERM'i iletir |

Geliştirme stack'inin davranışı değişmedi; tek fark portların artık yalnız
`127.0.0.1`'de yayınlanması (aşağıda).

### Image'lar (`Dockerfile`)

| Target | İçerik | Çalışma komutu |
|---|---|---|
| `api` | `dist/`, prod `node_modules` (+ `@taktic/shared` JSON tabloları), üretilmiş Prisma client | `node dist/main.js` |
| `web` | `.next/` build çıktısı, `public/`, derlenmiş `next.config.mjs`, prod `node_modules` | `next start -p 3000` |
| `admin` | Aynı yapı | `next start -p 3002` |
| `migrate` | Prisma CLI + bu commit'in `prisma/migrations` dizini | `taktic-migrate status\|deploy\|drift\|migrations` |

- Build bağlamı her zaman `git archive <sha>`: izlenmeyen dosya (`.env`, dump,
  override) image'a giremez. `.dockerignore` ayrıca allowlist'tir.
- `next.config.ts` image'a girmez; build aşamasında birebir `next.config.mjs`'e
  derlenir. Aksi halde `next start`, TypeScript'i **çalışma anında registry'den
  kurmaya** çalışıyor (provada yakalandı).
- `web`/`admin` image'ları `NEXT_PUBLIC_API_URL` (zorunlu) ve
  `NEXT_PUBLIC_WEB_URL` değerlerini build sırasında gömer (client bileşenleri
  okuyor). Bunlar public adreslerdir, sır değildir; image etiketine de yazılır
  ve preflight host'un değeriyle karşılaştırır.
- Hiçbir sır build argümanı değildir. `x-powered-by` kapalı ve güvenlik
  header'ları (HSTS, nosniff, frame-ancestors, X-Frame-Options,
  Referrer-Policy) aynen korunur; `smoke.sh` her deploy'da kontrol eder.
- Tarayıcı source map'i üretilmez (Next varsayılanı); API image'ından `.map` ve
  `.d.ts` dosyaları silinir.

## 2. Port matrisi

| Servis | Geliştirme (önce) | Geliştirme (şimdi) | Prod compose |
|---|---|---|---|
| postgres | `0.0.0.0:5433` | `127.0.0.1:5433` | **yayınlanmaz** (`docker exec` ile erişim) |
| api | `0.0.0.0:3001` | `127.0.0.1:3001` | `127.0.0.1:${API_PORT:-3001}` |
| web | `0.0.0.0:3000` | `127.0.0.1:3000` | `127.0.0.1:${WEB_PORT:-3000}` |
| admin | `0.0.0.0:3002` | `127.0.0.1:3002` | `127.0.0.1:${ADMIN_PORT:-3002}` |
| migrate | — | — | yayınlanmaz, yalnız `run --rm` |

- Adres compose dosyasında **literal**; hiçbir `.env` değeri onu `0.0.0.0`'a
  çeviremez (test: `API_PORT=0.0.0.0:3001` denenir).
- `docker compose -f docker-compose.prod.yml` kullanıldığında Compose otomatik
  `docker-compose.override.yml` okumaz; güvenlik takip dışı bir dosyaya bağlı
  değildir (OPS-006). Test bunu negatif kontrolle kanıtlar.
- cloudflared host üzerinde çalıştığı için `127.0.0.1` yeterlidir.
- Denetim: `node scripts/ops/compose-security.mjs prod` (ve `dev`). CI'da
  `ops` job'u çalıştırır; host kendi `.env`'iyle `--use-env` ekleyebilir.

## 3. Host gereksinimleri (`.env`)

`docker-compose.prod.yml` şunlar olmadan çözümlenmez:

| Anahtar | Not |
|---|---|
| `COMPOSE_PROJECT_NAME` | **Mevcut volume'ların sahibi olan proje adı.** Yanlış ad = boş yeni veritabanı. Asla dizin adından tahmin edilmez. |
| `APP_ENVIRONMENT` | `staging` veya `production` |
| `POSTGRES_PASSWORD` | Varsayılan şifre yok. Volume ilk oluşturulduğundaki şifre olmalı (dev compose varsayılanı kullanılmışsa açıkça `taktic_password` yazılır). |
| `TAKTIC_IMAGE_TAG` | Script'ler hedef SHA ile kendileri verir. |

**Runtime sözleşmesi (STAGING-CUTOVER-BLOCKERS-001).** Staging dahil her
deploy edilmiş ortam production build'i `NODE_ENV=production` ile çalıştırır;
prod compose bunu **literal** yazar, `API_NODE_ENV` override'ı kaldırıldı.
Staging ile production'ı ayıran tek şey `APP_ENVIRONMENT`'tır ve ortama bağlı
kurallar onu okur:

| | `APP_ENVIRONMENT=staging` | `APP_ENVIRONMENT=production` |
|---|---|---|
| `PAYMENT_PROVIDER` | `mock` veya `lemon-squeezy-test` (sandbox) | yalnız `mock` |
| Live ödeme anahtarları (`LEMON_SQUEEZY_LIVE_*`, `PAYMENT_LIVE_ENABLED`, `LEMON_SQUEEZY_MODE`≠`test`) | boot reddi | boot reddi |
| `PROMOTION_FINGERPRINT_KEY` | zorunlu, ≥ 32 karakter, geliştirme anahtarı değil | aynı |
| E-posta | `EMAIL_TRANSPORT=resend`, `RESEND_API_KEY`, `EMAIL_FROM` = `noreply@notify.taktick.com.tr` | aynı |
| Turnstile | `cloudflare`: `TURNSTILE_SECRET_KEY`, `TURNSTILE_EXPECTED_HOSTNAMES` (api), `TURNSTILE_SITE_KEY` (web) | aynı |
| Public URL'ler | `API_PUBLIC_URL`, `WEB_APP_URL`, `WEB_ORIGIN`, `ADMIN_ORIGIN`, `NEXT_PUBLIC_API_URL`: https, loopback değil; `NEXT_PUBLIC_WEB_URL` önerilir (uyarı) | aynı |
| SMS (sağlayıcı yok) | Console stand-in: kod **yalnız API container log'una** yazılır (`docker logs taktic-api`, host operatörü okur); telefona, response'a, DB'ye, endpoint'e gitmez (preflight PASS) | Console adapter **her gönderimi reddeder**, kod hiçbir yere yazılmaz, audit `TRANSPORT_UNAVAILABLE` (preflight WARN) |
| `NOTIFICATION_OUTBOX_DIR` (kayıt transport'u) | boot reddi (`NODE_ENV=production`) | boot reddi |

Lemon sandbox ve console SMS aynı kuralı paylaşır
(`common/app-environment.ts` → `isSandboxIntegrationPermitted`):
`production` → asla; `staging` → her `NODE_ENV`'de; `local`/bildirilmemiş →
eskisi gibi yalnız `NODE_ENV≠production`. Staging'de bir testçinin OTP'sini
okumak: host'ta `docker logs taktic-api 2>&1 | grep -A5 'SMS (console adapter'`.

Diğerleri: `TRUST_PROXY`, `WEB_TRUST_PROXY`, origin/URL anahtarları. Tam liste
`docker-compose.prod.yml` içinde servis servis yazılıdır; web/admin API'nin
sırlarını almaz (denetim bunu da kontrol eder).

## 4. Deploy akışı

```bash
scripts/ops/deploy-staging.sh --sha <commit> --check      # yalnız preflight, salt-okunur
scripts/ops/deploy-staging.sh --sha <commit> --dry-run    # değiştiren her komutu yazdırır
scripts/ops/deploy-staging.sh --sha <commit>              # deploy
```

Script önce hedef commit'in `scripts/ops` + `docker-compose.prod.yml`
dosyalarını `git archive` ile geçici bir dizine çıkarır ve kendini oradan
yeniden çalıştırır: checkout ne olursa olsun deploy daima **hedef sürümün**
script'leriyle yapılır.

| # | Adım | Başarısızlıkta |
|---|---|---|
| 0 | `build-images.sh <sha>` (`git archive` bağlamı; çalışan hiçbir şeye dokunmaz) | durur |
| 1 | `deploy-preflight.sh` (salt-okunur, aşağıda): runtime sözleşmesi **ve yeni API image'ının kendi boot kontrolleri** dahil | durur, hiçbir şey değişmemiştir |
| 1b | (`--fix-uploads-ownership`) API container'ının **bağlı olduğu** uploads volume'u image'ın runtime uid:gid'ine verilir; dosya listesi + sha256 önce/sonra aynı olmalı | durur, hiçbir şey durdurulmamış/migrate edilmemiştir |
| 2 | API container'ı **durdurulur** | — |
| 3 | `git checkout --detach <sha>` (yalnız API durduktan sonra) | eski API `docker start` ile açılabilir |
| 4 | `migrate status` + image/DB migration listesi birebir karşılaştırma | durur |
| 5 | Taze `pg_dump` (sha256, `pg_restore --list`, migration sayısı = canlı) + uploads arşivi; veya `--backup` ile verilen dump doğrulanır | durur |
| 6 | Yalnız `prisma migrate deploy` (bekleyen yoksa atlanır) | durur; "migration uygulandı" uyarısı |
| 7 | `migrate status` = güncel **ve** drift = fark yok | durur, **API başlatılmaz** |
| 8 | API `taktic-api:<sha>`'dan recreate, healthy beklenir | durur |
| 9 | web/admin recreate, healthy beklenir | durur |
| 10 | `smoke.sh` + PostgreSQL container ID'si 1. adımdakiyle aynı | durur |

Preflight kontrolleri: araçlar; proje adı; hedef commit `origin/main`'den
erişilebilir ve izlenen ağaç temiz; dört image doğru `revision` etiketiyle var;
prod compose çözümlenir ve güvenlik denetiminden geçer (denetimin açık "OK"
satırı aranır); **5b runtime sözleşmesi** (`scripts/ops/runtime-contract.mjs`,
çözümlenmiş yapılandırma üzerinde: `COMPOSE_PROJECT_NAME` = beklenen proje —
staging için `taktic-staging`, `--project` ile değişir —, `APP_ENVIRONMENT`
api+web, `NODE_ENV=production`, `PROMOTION_FINGERPRINT_KEY`, ortamın izinli
ödeme sağlayıcısı ve sandbox anahtarları, live anahtar yokluğu, public URL'ler,
e-posta, Turnstile; çıktı yalnız **değişken adı + PASS/WARN/FAIL**);
**5c boot yapılandırması** (yeni `taktic-api:<sha>` image'ında
`node dist/boot-config-check.js`, `compose run --rm --no-deps` ile — yeni API'nin
alacağı env'in birebir aynısıyla, DB bağlantısı ve listener olmadan; API'nin
`main.ts`'te çalıştırdığı kontrol listesinin aynısı, `apps/api/src/boot-config.ts`);
PostgreSQL çalışıyor, sağlıklı, bu projeye ait, projenin veri volume'unda ve
ağa yayınlı değil; migration geçmişi temiz (başarısız/yabancı migration yok) ve
bekleyen yoksa drift sıfır; uploads: API container'ının gerçekten bağladığı
volume projenin olanı, **her girdi** image'ın runtime uid:gid'ine ait, link/özel
dosya yok; çalışan API'nin **değer taşıyan** her env değişkeni yeni
yapılandırmada da iletiliyor (yalnız adlar, değerler asla yazılmaz); yedek
dizininde (yoksa oluşturulacağı üst dizinde) yer var. Preflight dizin
oluşturmaz, build etmez, hiçbir şeyi durdurmaz.

Böylece yeni build'in açılışta reddedeceği bir yapılandırma **API durdurulmadan
ve migration uygulanmadan önce** yakalanır; migration'dan sonra öğrenilen
startup blocker kalmaz.

**`--check`**: salt-okunur preflight ve dur. `git fetch` yok, image build yok,
log dosyası/dizin yok; durdurma, checkout, migration, recreate yok. Image'lar
henüz yoksa image gerektiren kontroller (5c, 7) **NOT RUN** olarak raporlanır
ve çıkış kodu `3` olur (hata yok ama eksik); tam kontrol için önce
`scripts/ops/build-images.sh <sha>` çalıştırılır (o zaman çıkış `0`). FAIL → `1`.

Bayraklar: `--environment <staging|production>` (varsayılan staging),
`--project <ad>`, `--accept-legacy-postgres-publish`, `--accept-env-drop`,
`--fix-uploads-ownership` (adım 1b), `--allow-empty-uploads`,
`--backup <dump>`, `--skip-build`, `--deploy-ref`.

### Migration-before-code garantisi

- Prod container'larda bind mount yok: checkout değişse bile çalışan kod
  değişmez.
- Checkout yalnız API durduktan sonra taşınır; yeni API yalnız `migrate deploy`
  + temiz status + sıfır drift'ten sonra başlar.
- `migrate` image'ının giriş noktası (`scripts/ops/prisma-migrate-guard.sh`)
  yalnız `status`, `deploy`, `drift`, `migrations` kabul eder; `migrate dev`,
  `reset`, `db push`, `resolve` ve ek argümanları reddeder. Drift kontrolü
  `migrate diff --from-url … --to-schema-datamodel …` ile yapılır: shadow
  database yoktur (`--from-migrations` shadow DB isterdi, kullanılmaz).
- PostgreSQL'e dokunan her compose komutu `--no-deps` ve servis adı içerir;
  script PostgreSQL'i asla oluşturmaz, recreate etmez, durdurmaz. Container ID
  başta ve sonda karşılaştırılır.

### İlk geçiş (dev compose → prod compose)

Staging host bugün dev compose'u (+ takip dışı override) çalıştırıyor. Bir
kerelik sıra:

1. Override içinde ne varsa (`APP_ENVIRONMENT`, `TRUST_PROXY`, `WEB_TRUST_PROXY`,
   port vb.) `.env`'e taşı. `POSTGRES_PASSWORD` (volume'un gerçek şifresi),
   `COMPOSE_PROJECT_NAME` (mevcut volume önekiyle aynı), `PROMOTION_FINGERPRINT_KEY`
   (≥ 32 karakter, bir kez seçilir), `NEXT_PUBLIC_API_URL` ve
   `NEXT_PUBLIC_WEB_URL` (public https adresleri) ekle. `API_NODE_ENV` artık
   yok; `.env`'de kalmışsa etkisizdir.
2. Checkout henüz bu script'leri içermediği için hedef commit'in script'lerini
   geçici dizine çıkar ve oradan çalıştır:

   ```bash
   git fetch origin
   ops="$(mktemp -d)"
   git archive <sha> scripts/ops docker-compose.prod.yml | tar -x -C "$ops"
   TAKTIC_REPO_ROOT="$PWD" "$ops/scripts/ops/deploy-staging.sh" --sha <sha> --check
   TAKTIC_REPO_ROOT="$PWD" "$ops/scripts/ops/build-images.sh" <sha>    # sonra --check yine: tam kontrol
   ```
3. `--check` çıktısındaki FAIL'leri tek tek kapat. Beklenenler:
   PostgreSQL ağa yayınlı (→ `--accept-legacy-postgres-publish`, sonra 5. adım),
   uploads root sahipli (→ `--fix-uploads-ownership`), override'a özgü env
   (→ `.env`'e taşı ya da gerçekten eskiyse `--accept-env-drop`), boş uploads
   (→ OPS-003'e bak, gerçekten boşsa `--allow-empty-uploads`).
4. Aynı komutu `--check` olmadan çalıştır.
5. Planlı pencerede bir kez: `scripts/ops/postgres-cutover.sh
   --confirm-recreate-postgres` (PostgreSQL yayın geçişi / PostgreSQL publish
   cutover — aşağıda).
6. Takip dışı `docker-compose.override.yml` artık okunmuyor; yedeğini alıp
   kaldır.

### PostgreSQL yayın geçişi (PostgreSQL publish cutover)

Deploy PostgreSQL'e dokunmadığı için dev compose'un oluşturduğu container,
yeniden oluşturulana kadar eski port yayınını korur.
`scripts/ops/postgres-cutover.sh` bunu bir kez, açık onayla yapar: API'yi
durdurur, yedek alır, `up -d --no-deps --force-recreate postgres` çalıştırır,
aynı volume'un bağlandığını, portun yayınlanmadığını, migration sayısının ve
**her tablonun satır sayısının** yedekle aynı olduğunu doğrular, API'yi aynı
image ile açar ve smoke çalıştırır. Onaysız çağrı yalnız kontrol eder.

### Geri dönüş (Rollback)

- **Migration uygulanmadıysa** (adım 6'dan önce durduysa): `docker start
  taktic-api` ve gerekirse `git checkout --detach <önceki-sha>`. Script çıktısı
  ikisini de yazar.
- **Migration uygulandıysa**: eski API image'ını yeni şemada başlatma. Tercih
  edilen: nedeni düzelt ve deploy'u tekrar çalıştır (fix-forward; script
  idempotenttir, bekleyen migration yoksa adım 6'yı atlar). Zorunluysa
  pre-deploy dump'ını geri yükle: önce `restore-rehearsal.sh` ile dump'ı
  doğrula, sonra API durmuşken boş bir veritabanına `pg_restore` uygula ve
  önceki SHA'yı deploy et. Canlı veritabanına restore ayrı bir karar ve
  komuttur; hiçbir script bunu otomatik yapmaz.

## 5. Yedekleme ve geri yükleme (OPS-002)

```bash
scripts/ops/backup-db.sh --label <etiket>
scripts/ops/backup-uploads.sh --label <etiket> [--allow-empty]
scripts/ops/restore-rehearsal.sh --db-dump <dump> --uploads-archive <arşiv> \
  [--migrate-image taktic-migrate:<sha>]
```

Varsayılan dizin `$TAKTIC_BACKUP_DIR` ya da `~/Backups/taktic` (0700, dosyalar
0600). Yedekler repo'ya girmez.

**Veritabanı**: sunucunun kendi `pg_dump`'ı (container içinde, yerel socket;
şifre container'dan çıkmaz) `--format=custom --no-owner --no-privileges`.
`.partial` dosyaya yazılır, `pg_restore --list` okuyabildiği ve
`_prisma_migrations` verisini listelediği kanıtlanmadan yeniden
adlandırılmaz. Yanında `.sha256` (`shasum -c` biçimi) ve `.manifest`
(sunucu sürümü, migration sayısı ve son migration, TOC sayıları, **her
tablonun satır sayısı**).

**Uploads**: volume, API container'ının `/app/apps/api/uploads` bağlantısından
okunur (proje adından tahmin edilmez); host'ta başka `*_taktic-api-uploads`
volume'u varsa uyarılır. Symlink, hard link, cihaz/FIFO/socket varsa yedek
reddedilir. Arşiv göreli yollarla yazılır ve listesi tekrar denetlenir (mutlak
yol, `..`, dosya/dizin dışı tür yok; dosya sayısı eşit). Boş kaynak **hata**dır
(exit 3, arşiv yok); `--allow-empty` açık uyarıyla boş arşiv yazar ve
manifest'e `empty=true` koyar. Yanında `.sha256`, `.manifest` ve dosya bazında
`.files.sha256`.

**Silme yok**: hiçbir script yedek silmez; retention operatörün açık kararıdır.

**Restore provası**: canlı veritabanına asla dokunmaz. Kendi oluşturduğu,
internal ağlı (dışarı rota yok, port yayını yok), veri dizini tmpfs'te, rastgele
şifreli tek kullanımlık bir PostgreSQL'e restore eder ve çıkışta siler. Kontrol:
sidecar sha256 → `pg_restore --exit-on-error` → migration sayısı/son migration =
manifest → tablolar ve satır sayıları = manifest → (`--migrate-image` ile)
`migrate status` + drift → uploads arşivinde liste güvenliği, tmpfs'e açma ve
her dosyanın sha256'sı.

## 6. Yerel eşitleme

Merge sonrası yerel stack (ana checkout) için:

```bash
scripts/ops/local-sync.sh            # origin/main
scripts/ops/local-sync.sh --dry-run
```

Bind mount'lu dev API checkout değiştiği an hot-reload yaptığı için sıra burada
da zorlanır: migrate image build → API durdur → `git merge --ff-only` →
bekleyen listesi → yedek → `migrate deploy` → status + drift → api/web/admin
recreate → `/health`. Compose proje adı PostgreSQL container'ının etiketinden
okunur (`-p` tuzağı). Bu PR'dan önceki commit'ler `Dockerfile` içermediği için
script ancak merge sonrası hedeflerle çalışır.

## 7. OPS-003 araştırması: upload export neden boş?

**Kod gerçekleri**

- Upload kökü `process.cwd()/uploads`; API `apps/api`'den çalıştığı için hem
  dev hem prod image'da `/app/apps/api/uploads`
  (`apps/api/src/modules/uploads/uploads.constants.ts`). Alt dizinler
  `category-images/` (admin) ve `showcase-images/` (sağlayıcı vitrin kartı).
- Volume anahtarı `taktic-api-uploads`; gerçek adı
  `<COMPOSE_PROJECT_NAME>_taktic-api-uploads`.
- DB, yükleme anındaki `API_PUBLIC_URL` ile birleştirilmiş **mutlak URL**
  saklar: `ServiceCategory.imageUrl`, `ServiceCategory.coverImageUrl`,
  `ShowcaseCardVersion.imageUrl` → `<API_PUBLIC_URL>/uploads/<alt-dizin>/<dosya>`.
  O sırada `API_PUBLIC_URL` varsayılan `http://localhost:3001` ise URL de
  yanlıştır (ayrı bir veri sorunu olur).
- Kategori görselleri çoğunlukla upload değildir: `imageUrl` yoksa
  `apps/web/public/categories/*.png` (git'te 7 dosya) ve `iconKey` kullanılır
  (`apps/web/app/category-art.ts`).

**Repo'dan ve yerelden kanıt (2026-10-04)**

- Yerel DB (2026-09-10'da staging verisinden taşındı): 49 kategori, `imageUrl`
  0, `coverImageUrl` 0; `ShowcaseCardVersion` 2 satır, `imageUrl` 0.
- Yerel API'nin bağladığı `priceless-jemison-b5a4bf_taktic-api-uploads`: 0
  dosya. Host'ta ikinci bir `tactic_taktic-api-uploads` (proje `tactic`,
  2026-09-15) var: 0 dosya. Yanlış volume'u export etme riski gerçek.
- 2026-08-31 Mac Air → Mac mini devir notu: aktarılan arşiv 0 dosyaydı, çünkü
  49 kategorinin hiçbirinde `imageUrl` yoktu.

**Sonuç**: elimizdeki her kanıt boş export'un *doğru* olduğunu (hiç upload
yapılmamış) gösteriyor, ama **bugünkü staging doğrulanamadı**; OPS-003 bu
PR'da kapanmıyor. `backup-uploads.sh` artık volume'u API'nin gerçek
bağlantısından seçiyor, diğer upload volume'larını uyarıyor ve boş kaynağı hata
sayıyor.

**Staging'de çalıştırılacak salt-okunur komutlar**

```bash
docker inspect taktic-api --format '{{range .Mounts}}{{.Type}} {{.Name}} -> {{.Destination}}{{println}}{{end}}'
docker volume ls --format '{{.Name}} {{.Labels}}' | grep -i upload
for v in $(docker volume ls -q | grep -i upload); do
  echo "== $v"
  docker run --rm --network none -v "$v:/u:ro" postgres:16.6-alpine \
    sh -c 'echo files=$(find /u -type f | wc -l); find /u -type f | head -20'
done
docker exec taktic-postgres sh -c 'psql -X -tA -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
  SELECT count(*), count(\"imageUrl\"), count(\"coverImageUrl\") FROM \"ServiceCategory\";
  SELECT count(*), count(\"imageUrl\") FROM \"ShowcaseCardVersion\";
  SELECT \"imageUrl\" FROM \"ServiceCategory\" WHERE \"imageUrl\" IS NOT NULL
  UNION ALL SELECT \"coverImageUrl\" FROM \"ServiceCategory\" WHERE \"coverImageUrl\" IS NOT NULL
  UNION ALL SELECT \"imageUrl\" FROM \"ShowcaseCardVersion\" WHERE \"imageUrl\" IS NOT NULL LIMIT 20;"'
```

Karar kuralı: DB referansı 0 ve bağlı volume 0 dosya → "veri yok, export doğru";
OPS-003 kapanır ve deploy'da `--allow-empty-uploads` bilinçli kullanılır. DB
referansı > 0 ama bağlı volume boş → veri kaybı ya da yanlış volume; diğer
upload volume'larının listesine bak, hiçbir şeyi silme.

## 8. OPS-007 analizi: FileVault sonrası gözetimsiz açılış

Bu PR host'ta hiçbir şeyi değiştirmedi (LaunchDaemon yok, FileVault ayarı yok).

**Bugünkü durum**: FileVault açık bir Mac yeniden başladığında disk, biri
açılış ekranında kimlik doğrulayana kadar kilitlidir; bu noktaya kadar
LaunchDaemon'lar da dahil hiçbir şey çalışmaz. Kilit açılıp oturum açıldıktan
sonra Docker Desktop (oturum uygulaması) ve cloudflared kullanıcı
LaunchAgent'ı başlar; container'lar `restart: unless-stopped` ile geri gelir.
Yani bugün her yeniden başlatma fiziksel (ya da uzaktan) kilit açma + oturum
açma ister.

**Docker Desktop'a bağlı mimaride otomatik açılış mümkün mü?** Kısmen hayır.
Docker Desktop kullanıcı oturumu ister; oturum açmadan başlatmanın desteklenen
yolu yok. FileVault açıkken otomatik oturum açma da kapalıdır.

**Seçenekler**

| Seçenek | Ne sağlar | Riskler / maliyet |
|---|---|---|
| A. Bugünkü mimari + runbook | Değişiklik yok. Yeniden başlatma sonrası: kilit aç → oturum aç → container'lar ve tunnel gelir → `scripts/ops/smoke.sh`. | Gözetimsiz kurtarma yok; kesinti süresi insana bağlı. |
| B. A + planlı yeniden başlatmalarda `sudo fdesetup authrestart` | Güncelleme sonrası disk kilidi bir kez atlanır. | Oturum yine açılmaz → Docker Desktop ve LaunchAgent başlamaz; tek başına yetmez. |
| C. cloudflared LaunchDaemon + oturumsuz container runtime (ör. Colima'yı ayrı bir kullanıcıyla LaunchDaemon olarak) | Disk kilidi açıldıktan sonra (authrestart ya da uzaktan kilit açma) oturum açmadan stack ve tunnel gelir. | Colima/Lima'nın daemon bağlamında Virtualization.framework ile çalışması PoC ister; Docker Desktop'tan göç (volume'ların taşınması = yedek/restore ile); bakım yükü. |
| D. Linux host (VM ya da sunucu): Docker Engine + systemd, LUKS + ağ tabanlı kilit açma (Clevis/Tang) ya da bulut disk şifrelemesi | Standart gözetimsiz açılış, şifreleme korunur. | Yeni altyapı ve maliyet; göç projesi. |
| E. FileVault'u kapatmak | Otomatik oturum açma mümkün olur. | **Önerilmez**: staging gerçek kişisel veri kopyası taşıyor (KVKK); cihaz çalınırsa veri açıkta. |

**cloudflared LaunchDaemon güvenlik modeli**: `cloudflared service install`
varsayılan olarak root çalışan bir LaunchDaemon kurar. Daha iyisi: ayrı bir
hizmet kullanıcısı (`UserName` anahtarı), `/usr/local/etc/cloudflared/`
altında o kullanıcıya ait 0600 kimlik bilgisi; tunnel token'ı hostname'leri
sunma yetkisidir, sır gibi korunur. Tunnel yalnız `127.0.0.1` portlarına
yönlenir (bu PR'ın port modeli bunu destekler).

**Sırlar**: daemon mimarisinde compose'u çalıştıran hizmet kullanıcısı `.env`'i
okur. Dosya ev dizini yerine örn. `/usr/local/etc/taktic/staging.env` (sahibi
hizmet kullanıcısı, 0600) ve `--env-file` ile verilir. Docker socket erişimi
root eşdeğeridir; yalnız bu kullanıcıya verilir.

**FileVault güvenliği nasıl korunur**: FileVault açık kalır; planlı
yeniden başlatmalarda `authrestart`; plansız (elektrik) için UPS + "elektrik
kesintisinden sonra otomatik başlat"; uzaktan kilit açma yolu (yeni macOS
sürümlerinde SSH ile FileVault kilidi açma bildirilmiştir — staging Mac
mini'nin sürümünde doğrulanmalı).

**Önerilen hedef**: kısa vadede A + B ve yazılı kurtarma runbook'u; orta vadede
C için PoC (önce cloudflared LaunchDaemon, sonra container runtime); uzun vadede
production için D. Her adım ayrı bir karar ve ayrı bir iştir.

## 9. Bilinen sınırlamalar / takip

- Image boyutu: web/admin ~930–980 MB. Neden: pnpm hem glibc hem musl
  `@next/swc` ikililerini kuruyor ve Next'in opsiyonel `@playwright/test` peer'ı
  lockfile'daki `autoInstallPeers` ile geliyor. Çözüm (`supportedArchitectures`
  ya da `output: 'standalone'`) kök `package.json` / Next yapılandırmasını
  değiştirir; ayrı iş.
- API image'ında Prisma CLI (`@prisma/client`'ın peer'ı) bulunuyor; aynı neden.
  Kullanılmıyor, `tsx`/`esbuild` ise budanıyor.
- Image'lar host'ta build edilir (registry yok); build ~2 dakika.
- `NEXT_PUBLIC_*` değişirse web/admin yeniden build edilmelidir (preflight
  uyuşmazlığı yakalar).
