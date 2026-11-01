# OBS-ALERT-002 geri alma

Migration `20261102090000_add_ops_alert_recipients` (109) ve onu kullanan kod
için geri alma yolları. En sık durum R0'dır; R2 (eski imajı yeni şemada
çalıştırmak) desteklenmez; R3 önerilmez, şema gerekiyorsa dump'tan dönülür.

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

## R2 — PR-A kodunu eski imajla geri al: desteklenmez

R2 (109. migration uygulanmışken eski `d7c195a2` API imajını yeni şemada
çalıştırmak) **desteklenen bir geri alma yöntemi değildir.**
`docs/ops/deploy-runtime.md` "Geri dönüş" kuralı ("Migration uygulandıysa:
eski API image'ını yeni şemada başlatma") geçerlidir ve bu belge onu
değiştirmez; R2 ancak o kurala istisna verilerek yapılabilir ve böyle bir
istisna **verilmemiştir.** İzole prova (aşağıda, "Eski imaj provası") kuralın
bu migration için de gerekçeli olduğunu gösterdi: eski worker, kuyrukta kalan
yönetilen teslimatları alıcıya bakmadan `OPS_ALERT_EMAIL`'e gönderir.

PR-A kodunda sorun çıkarsa sırayla:

1. **R0** — yönlendirmeyi `ENV_LEGACY`'ye döndürün; e-posta OBS-ALERT-001
   davranışıyla `OPS_ALERT_EMAIL`'e gider, kod değişmez.
2. **Fix-forward** — nedeni düzeltip aynı deploy'u yeniden çalıştırın
   (`deploy-runtime.md`, "Geri dönüş").
3. **Dump'tan dönüş** — zorunluysa pre-deploy dump'ını
   `deploy-runtime.md`'deki adımlarla geri yükleyip önceki SHA'yı deploy edin
   (bkz. R3). Dump 109'dan önceki şemadır; yönetilen teslimat satırı içermez.

`obs-alert-002-rollback-report.sql` salt-okunur durum raporu olarak
kullanılabilir. `obs-alert-002-rollback-cancel.sql` R2 için yazılmıştı; R2
desteklenmediği için hiçbir geri alma adımı onu çağırmaz.

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

Bu prova CLI ve client düzeyindedir; imaj boot'u ve gerçek alarm turu
aşağıdaki "Eski imaj provası"ndadır.

## Eski imaj provası (2026-11-01, yerel, izole)

Amaç kanıttı, R2'yi desteklemek değil. Kendi `postgres:16` container'ı ve
`--internal` (dışarı çıkışsız) Docker ağı; geliştirme stack'i, `taktic`
veritabanı, staging/UAT/production'a dokunulmadı. Gerçek sır yok: e-posta
console adaptörüne, sahte `ops-r2@example.invalid` adresine; Telegram
tanımsız. İmajlar her revizyonun kendi Dockerfile'ıyla `git archive`'dan
üretildi (`d7c195a2` API + migrate, `62339fa9` API + migrate); 109 migration
yeni migrate imajıyla uygulandı. Prova sonunda container, ağ ve volume
silindi.

a. **Boot:** eski API 109'luk veritabanında açılır; eski `migrate status`
   "Database schema is up to date!", `migrate deploy` exit 0 — bilinmeyen
   migration'ı fark etmez. Yalnız eski deploy kapıları reddeder
   (`deploy-staging.sh`/`local-sync.sh` adım 4 bilinmeyen migration'ı listeler,
   adım 7 drift exit 2; mantık aynı sorgularla yeniden üretildi, script'ler
   koşulmadı). Boot `NODE_ENV=development`, `APP_ENVIRONMENT=local`, console
   e-posta ile yapıldı; production/staging sözleşmesiyle boot (Resend,
   Turnstile) **koşulmadı.**
b. **Sağlık:** `/health` 200; `/health/ready` 200,
   `{"database":"ok","migrations":{"applied":109}}`.
c. **Zamanlayıcı/worker:** dakikalık tick'te evaluator ve teslimat geçişi
   koşar, `OpsAlertEngineState.lastSucceededAt` ilerler, hata yok.
d. **Alarm turu (`ENV_LEGACY`): geçti.** FAILED bir `SchedulerRun` alarm açtı,
   OPENED e-postası `OPS_ALERT_EMAIL`'e gitti; SUCCESS koşusu RESOLVED
   e-postasını gönderdi. Satırlarda `recipientId` NULL, CHECK/trigger hatası
   yok; eski `createMany(skipDuplicates)` tekilleştirmesi kısmi indeksle
   korunur.
e. **Mevcut PR-A satırları: başarısız — yönlendirme.** Eski worker vadesi
   gelen her `OpsAlertDelivery` satırını claim edip `OPS_ALERT_EMAIL`'e
   gönderir: `recipientId`'yi, alıcının durumunu (ACTIVE/PAUSED/DELETED),
   tercihlerini, yönlendirme modunu (`MANAGED` ve `ENV_LEGACY` denendi) ve
   alarm durumunu (çözülmüş alarmın satırı da gitti) yok sayar. Üç yönetilen
   OPENED satırı aynı adrese üç e-posta üretti. Yönetilen SENT satırları
   "bilgilendirildi" sayılır ve legacy bir RESOLVED kuyruklanır. Eski kod
   yönlendirme satırını okumaz; yeni olaylar hep legacy satır alır.
   `OPS_ALERT_EMAIL` tanımsızken yönetilen satırlar `NOT_CONFIGURED` ile
   ABANDONED olur (yönlendirme yok ama hiç e-posta kanalı da yok).
f. **Hata logları:** `OPS_ALERT_EMAIL` tanımlı koşularda WARN/ERROR yok.
   Karşılaştırma: `62339fa9` imajı aynı veritabanında açılır, `ENV_LEGACY`
   turu OPENED/RESOLVED gönderir; `MANAGED` modda koşulmadı.

Sonuç: eski imaj ancak bütün açık yönetilen teslimatlar önceden iptal
edilirse güvenli olurdu ve yine de kural istisnası gerektirir; bu yüzden R2
desteklenmez.
