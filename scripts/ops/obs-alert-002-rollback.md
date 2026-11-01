# OBS-ALERT-002 geri alma

Migration `20261102090000_add_ops_alert_recipients` (109) ve onu kullanan kod
için geri alma yolları. En sık durum R0'dır; R2 kod geri alımıdır ve şema
yerinde kalır; R3 önerilmez.

Önce bakılacaklar: hangi PR geri alınıyor (PR-A: API + migration, PR-B: admin
ekranları), yönlendirme modu (`ENV_LEGACY` / `MANAGED`), açık yönetilen
teslimat sayıları (`obs-alert-002-rollback-report.sql`). Anahtarlarla ilgili
her şey: `docs/ops/ops-alert-recipient-keys.md`.

## R0 — yalnız geçişi geri al (en sık)

Kod değişmez. SUPER_ADMIN, Bildirim Ayarları → yönlendirme paneli (PR-B; o
zamana kadar API):

1. `POST /ops-alerts/routing/revert/preview` — durum bazında sayılar: env
   adresine bağlanacak, iptal edilecek (eşleşmeyen), aktarılacak
   "bilgilendirilmiş" satırlar, engeller.
2. Sayıları operatöre gösterin. Eşleşmeyen satır varsa ayrıca "Eşleşmeyen N
   teslimatı iptal et" onayı gerekir (`cancelUnmatched: true`).
3. `POST /ops-alerts/routing/revert` önizleme token'ıyla (`applyRevert`).
   Önizlemeden sonra sayılar değiştiyse 409 `COUNTS_CHANGED` → yeniden önizle.

Sonuç: mod `ENV_LEGACY`; e-posta yeniden `OPS_ALERT_EMAIL`'e, OBS-ALERT-001
davranışıyla gider.

## R1 — PR-B'yi geri al

Yalnız admin imajı önceki sürüme döner; veri etkisi yoktur. Mod `MANAGED`
kalır. Geri dönüş gerekiyorsa R0'ı API üzerinden yapın.

## R2 — PR-A kodunu geri al (şema kalır)

Hedef: API'yi OBS-ALERT-001 sürümüne (`d7c195a2`) döndürmek; 109. migration
ve tabloları yerinde kalır. Eski kod yeni tabloları ve sütunları yok sayar;
eski tekilleştirme kısmi indeksle aynen sürer (bkz. "Prova sonuçları").

1. **Mod `MANAGED` ise önce R0.** Cancel script'i `MANAGED`'da reddeder.
2. **API'yi durdurun** (worker satır claim etmesin):
   `docker stop taktic-api`.
3. **Rapor** (salt-okunur, değer basmaz):

   ```bash
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/ops/obs-alert-002-rollback-report.sql
   ```

   PostgreSQL yalnız container'da çalışıyorsa:
   `docker exec -i taktic-postgres psql -U <kullanıcı> -d <db> -v ON_ERROR_STOP=1 -f - < scripts/ops/obs-alert-002-rollback-report.sql`

   `open_recipient_deliveries` satırları, eski kodun `OPS_ALERT_EMAIL`'e
   göndereceği yönetilen e-posta teslimatlarıdır; `expected` satırı bunların
   onay satırıdır (`PENDING=<n>,FAILED=<n>,SENDING=<n>`). Legacy satırlar
   (`open_legacy_deliveries`) bilgi içindir, dokunulmaz.
4. **Operatör onayı.** Sayıları operatöre gösterin. Onay yoksa **durun**
   (API'yi aynı sürümle tekrar açın). Onay varsa, onaylanan satırla:

   ```bash
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
     -v expected='PENDING=<n>,FAILED=<n>,SENDING=<n>' \
     -f scripts/ops/obs-alert-002-rollback-cancel.sql
   ```

   Script tek transaction'dır: bulduğu sayılar `expected` ile birebir değilse
   `counts changed` ile reddeder ve **hiçbir şey değiştirmez** → 3. adıma dönün.
   `expected` yoksa / biçimi bozuksa veya mod `MANAGED` ise de reddeder.
   Başarılıysa satırlar `CANCELLED`, `errorCode = 'ROLLED_BACK'`, claim
   alanları `NULL` olur ve `NOTICE` iptal edilen sayıları yazar. Raporu tekrar
   çalıştırın: `expected` `PENDING=0,FAILED=0,SENDING=0` olmalı.
5. **`OPS_ALERT_EMAIL`'in env'de durduğunu doğrulayın** (değer basmadan):
   `grep -c '^OPS_ALERT_EMAIL=.' "$ENV_FILE"` → `1`. Eski kodun tek e-posta
   hedefi budur.
6. **`d7c195a2` API imajını başlatın — `deploy-staging.sh --sha d7c195a2`
   ile değil.** O sürümün preflight'ı (adım 7) veritabanında "bu commit'in
   içermediği uygulanmış migration" görünce (`20261102090000_…`) ve drift
   kontrolü yeni tabloları görünce deploy'u reddeder; bu tasarım gereğidir
   (bkz. "Prova sonuçları" §3). Yalnız API container'ı eski imajla yeniden
   oluşturulur:

   ```bash
   TAKTIC_IMAGE_TAG=<d7c195a2 imaj etiketi> \
     docker compose --project-directory "$REPO_ROOT" -f docker-compose.prod.yml up -d --no-deps api
   ```

   Eski imaj yerelde yoksa önce `scripts/ops/build-images.sh` ile o commit'ten
   üretilir. `migrate deploy` **çalıştırılmaz** (gerekmez; çalışsa da bir şey
   yapmaz, bkz. prova). Admin PR-B içeriyorsa onu da önceki imaja alın (R1).
7. **Doğrulama:** `/health/ready` 200 (applied migration sayısı 109 görünür,
   beklenen), ilk alarm tick'i başarılı (Sistem Sağlığı → Operasyon alarmları,
   motor gecikmesi), bir kabul olayıyla OPENED/RESOLVED'ın `OPS_ALERT_EMAIL`'e
   ve Telegram'a gittiği.

İleri dönüş (PR-A'yı yeniden açmak): normal `deploy-staging.sh --sha <PR-A
sha>`; migration zaten uygulanmış olduğundan adım 6 atlanır. `ROLLED_BACK`
satırları kalıcıdır, yeniden gönderilmez.

## R3 — şemayı geri al: yapmayın

Script yazılmadı ve yazılmayacak. Alıcıya bağlı teslimat satırları varken
eski tam benzersiz indeks `(alertId, kind, sequence, channel)` kurulamaz (bir
bildirim için legacy satırın yanında yönetilen satırlar vardır); bu ancak
alarm geçmişi silinerek olur. `AdminPermission`'a eklenen altı değer
PostgreSQL'de zaten geri alınamaz. Şema gerçekten geri dönmeliyse: deploy
öncesi alınan **dump'tan dönün** (`docs/ops/deploy-runtime.md`, "Geri dönüş"),
açık bir kararla ve anahtar runbook'undaki geri yükleme kontrolleriyle.

## Prova sonuçları (2026-11-01, yerel)

İzole prova; staging, UAT, geliştirme veritabanı `taktic` ve test
veritabanlarına dokunulmadı. Yerel `taktic-postgres` (PostgreSQL 16) üzerinde
atılabilir `taktic_obs002_rehearsal` veritabanı, `d7c195a2`'nin ayrık bir git
worktree'si (yalnız kök bağımlılıklar: Prisma CLI 6.19.3 + eski şemadan
üretilmiş client). Prova sonunda veritabanı silindi, worktree kaldırıldı.

1. **108 → 109, veri varken.** `d7c195a2`'nin `prisma migrate deploy`'u boş
   veritabanını 108'e getirdi; eski client'la OBS-ALERT-001'in kuyruklama
   çağrısı (`createMany({ data, skipDuplicates: true })`) bir alarm için
   EMAIL + TELEGRAM satırı yazdı (`count 2`). Ardından bu dalın
   `migrate status`'u yalnız `20261102090000_add_ops_alert_recipients`'ı
   bekleyen gösterdi, `migrate deploy` onu uyguladı; son durum
   "109 migrations found … Database schema is up to date!".
2. **Eski Prisma CLI bilinmeyen uygulanmış migration'ı tolere ediyor.**
   109'luk veritabanında `d7c195a2`'nin CLI'ı:
   - `prisma migrate status` → "108 migrations found in prisma/migrations …
     Database schema is up to date!", exit 0 (bilinmeyen migration için uyarı
     yok);
   - `prisma migrate deploy` → "108 migrations found … No pending migrations
     to apply.", exit 0.
3. **Ama `d7c195a2`'nin kendi deploy kapıları reddeder.** O sürümün
   `prisma migrate diff --from-url … --to-schema-datamodel prisma/schema.prisma
   --exit-code`'u exit 2 verdi (üç tablo, üç enum, altı `AdminPermission`
   değeri, iki sütun, yeni FK'ler "removed"; eski tam benzersiz indeks
   "added"). `deploy-preflight.sh` adım 7 ve `deploy-staging.sh` adım 7 bu
   drift'i ve "applied migrations this commit does not contain" durumunu FAIL
   sayar (kod okuması; preflight provada koşulmadı). Bu yüzden R2.6 yalnız
   API container'ını değiştirir.
4. **Eski client + kısmi indeks.** 109'da, eski client'la aynı bildirim için
   `createMany(skipDuplicates)` iki kez: ilk `count 2`, ikinci `count 0`
   (tekilleştirme korunuyor). Aynı bildirim için yönetilen bir EMAIL satırı
   (`recipientId` dolu) zaten varken eski client yine bir legacy EMAIL satırı
   ekledi (ilk 2, ikinci 0) — kısmi indeksin tasarımı: legacy ve yönetilen
   tekillik ayrı. Eski client'ın okuduğu satır alanlarında `recipientId` ve
   `noticeSnapshot` yok (yok sayıyor), sorgular hatasız.
5. **Rapor ve iptal, gerçek psql ile** (container'daki psql 16, `-f -`):
   - Rapor: `open_recipient_deliveries` PENDING 1 / FAILED 1 / SENDING 1,
     `expected` `PENDING=1,FAILED=1,SENDING=1`, legacy PENDING 6, mod
     `ENV_LEGACY`, alıcılar ACTIVE 1 / PAUSED 0 / DELETED 0, `v1` → 1,
     HMAC sürümü 1 → 1. Çıktıda adres, maskeli adres, HMAC, şifreli metin
     ya da satır kimliği yok; `BEGIN` … `ROLLBACK` (READ ONLY).
   - `expected` olmadan: "expected counts are required …", exit 3.
   - Yanlış sayıyla (`PENDING=1,FAILED=1,SENDING=0`): "counts changed
     (expected …, found PENDING=1,FAILED=1,SENDING=1); nothing was cancelled",
     exit 3; satırlar değişmedi.
   - Mod geçici olarak `MANAGED` iken doğru sayıyla: "email routing is
     MANAGED; revert to ENV_LEGACY first …", exit 3.
   - Mod `ENV_LEGACY`, doğru sayıyla: `NOTICE … cancelled PENDING=1,FAILED=1,
     SENDING=1 (errorCode ROLLED_BACK)`, `COMMIT`, exit 0. Üç yönetilen satır
     `CANCELLED` / `ROLLED_BACK` / claim NULL; yönetilen SENT satırı ve altı
     legacy satır aynen kaldı. Sonraki rapor `PENDING=0,FAILED=0,SENDING=0`.

Kanıtlanmayanlar: `d7c195a2` **Docker imajının** boot'u ve gerçek bir alarm
turu (evaluator + worker) koşulmadı — prova CLI ve client düzeyindedir; eski
API'nin boot'ta migration ya da şema kontrolü yapmadığı kod okumasıyla
doğrulandı (`/health/ready` yalnız uygulanmış migration sayısını raporlar).
Eski `deploy-preflight.sh` koşulmadı (madde 3, kod okuması). Staging'de R2
yapılacaksa ilk tick ve bir kabul olayı R2.7'de doğrulanmalıdır.
