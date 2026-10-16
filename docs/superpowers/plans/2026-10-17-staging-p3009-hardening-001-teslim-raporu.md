# STAGING-P3009-HARDENING-001 — Teslim raporu

- Taban: `main` `af20f1b4` (#177), DB 104 migration. Migration **yok**.
- Dal: `claude/staging-p3009-hardening-001`
- Staging, production, aktif yerel DB ve backlog'a dokunulmadı. Önceki prova
  DB'leri (`taktic-rh-pg`: `taktic_rh`, `taktic_rh_guardprobe`,
  `taktic_rh_104`) değişmedi.
- Runbook: [docs/ops/deploy-runtime.md](../../ops/deploy-runtime.md) §4,
  "Migration veri ön koşulları", "Bakım penceresi", "P3009".

## 1. Sorun

STAGING-MIGRATION-REHEARSAL-001 izole provası şunu gösterdi:
`20261006120000_user_phone_e164_check` canonical olmayan bir telefonla
karşılaşınca P3018 ile duruyor. Prisma geride bitmemiş bir kayıt bırakıyor ve
sonraki her deploy P3009 alıyor. Guard `resolve`'u reddediyor ve
`deploy-staging.sh` API'yi zaten 2. adımda durdurmuş oluyor. Sonuç: staging
kapalı kalıyor ve tek çıkış yolu guard'sız, elle yapılan bir `resolve`.

## 2. Değişiklikler

| Parça | Ne yapar |
|---|---|
| `deploy-preflight.sh` **7b** | Bekleyen migration'ların veri ön koşullarını sayar. Bekleyen liste hedef commit'in git ağacından okunur, yani image gerekmez ve eski şemada çalışır. Sorgu `default_transaction_read_only=on` oturumunda koşar. Sayım 0 değilse FAIL verir ve deploy API durdurulmadan biter. Veri otomatik düzeltilmez. API image'ı varsa maskeli rapor eklenir. |
| `lib.sh` | `pg_query_ro`, `database_identity` (`system_identifier/datname/oid`), `MIGRATION_DATA_GUARDED` kaydı, guard predicate'i (migration'daki ile birebir aynı; test karşılaştırır). |
| `canonicalize-user-phones.ts --report` | Salt-okunur transaction, dosya yazmaz, numara ya da e-posta basmaz (sayı, id, rol; reddedilen değerin yalnız uzunluğu). Çıkış 0 = GO, 4 = NO-GO. |
| `deploy-staging.sh` adım 4 | API durduktan sonra, yedekten ve migration'dan önce aynı sayımı yeniden yapar. Arada bir satır yazılmışsa migration uygulanmadan durur. P3009 mesajları kurtarma aracını gösterir. |
| `prisma-migrate-guard.sh` | `resolve-rolled-back <ad>` eklendi. Yalnız `APP_ENVIRONMENT=staging`, geçerli bir migration dizini adı, image'da bulunan migration ve `TAKTIC_RESOLVE_CONFIRM=<ad>` ile çalışır. `resolve --applied` ve düz `resolve` hâlâ reddedilir. |
| `docker-compose.prod.yml` | `migrate` servisi `APP_ENVIRONMENT` alıyor (zorunlu, varsayılansız). |
| `migration-recovery.mjs` | Statik analiz. Transaction'ı bölen ifadeleri (`COMMIT`, `BEGIN`, `CONCURRENTLY`, `VACUUM`, `CALL` …) yorum, string ve dollar-quote gövdeleri ayıklandıktan sonra bulur. Dosyanın yarattığı nesneleri çıkarır ve yokluklarını doğrulayan salt-okunur SQL üretir. Drop edilip yeniden yaratılan nesneler atomiklik kapsamına bırakılır. Repodaki 104 migration'ın tamamı atomik. |
| `migration-recover.sh` | Operatör aracı. Varsayılan mod salt-okunur rapordur. Resolve için `--migration`, `--database-id` ve tam `--confirm` cümlesi zorunludur. Production'a ve host'ta `APP_ENVIRONMENT≠staging` olduğunda Docker'a dokunmadan reddeder. Aşağıdakileri doğrular: tek bitmemiş kayıt, checksum = image'daki dosya, API durmuş, dosya atomik, nesneler yok. Her deneme 0600 izinli JSONL audit'e yazılır. Çözülecek kayıt yoksa no-op çıkar. Kanıt yetersizse restore ya da fix-forward prosedürünü basar. |

## 3. Neden `applied_steps_count` kanıt değil

Gerçek Prisma (migrate image) ve PostgreSQL 16 ile lab sonuçları:

| Senaryo | Sonuç |
|---|---|
| DDL + DML, ardından RAISE | Tamamı geri alındı; `applied_steps_count=0` |
| `CREATE TABLE LabB; COMMIT; CREATE TABLE LabC; SELECT 1/0` | **LabB kaldı**; Prisma yine `applied_steps_count=0` yazdı |
| Başarılı migration'a `resolve --rolled-back` | Prisma P3012 ile reddetti |
| Kaydı olmayan migration'a resolve | P3011 |

Bu yüzden resolve için hem statik atomiklik hem nesne yokluğu şart. İki kanıt
da CI `ops` job'unda her koşuda yeniden üretiliyor.

## 4. Uçtan uca prova (yerel, geçici `taktic-rhr` prod compose projesi)

Kaynak: 2026-09-10 staging dump'ının kopyası.

1. 43 → 87, ardından hedef image ile `migrate deploy`: gerçek **P3018**, tekrarında **P3009**.
2. `migration-recover.sh`:
   - Rapor: RESOLVABLE (checksum eşleşti, API yok, ATOMIC, 1 nesne yok).
   - Yanlış `--database-id`: reddedildi.
   - Doğru onay: guard ve Prisma kaydı rolled-back yaptı.
   - Tekrar çalıştırma: no-op.
   - Audit: `refused`, `attempt`, `resolved`, `noop` satırları; dosya 0600.
3. Preflight (gerçek veri): bitmemiş kayıt için FAIL ve 7b FAIL (6 satır).
   Maskeli raporda 1 çakışma grubu yalnız id ve rol ile göründü, numara yok.
4. Deploy yeniden başarısız oldu, ikinci kurtarma da başarılı (tekrarlı kurtarma).
5. Resolutions ile apply: iki hesap NULL (sahiplik kanıtsız), `--report` GO,
   7b ok, deploy → **104**, status güncel, drift yok. Kayıtlar: 104 bitmiş,
   0 bitmemiş, 2 rolled-back.

Bu sırada bulunan bir hata düzeltildi: `docker run … migrations | grep -qx`
hattı `pipefail` altında SIGPIPE ile aralıklı olarak "taşımıyor" sonucu
veriyordu. Hata fail-closed tarafındaydı; audit kaydı sayesinde yakalandı.
Artık here-string kullanılıyor.

Ayrıca gözlendi (değiştirilmedi): `lib.sh`, `TAKTIC_CONTAINER_PREFIX`'i yalnız
shell'den okuyor, `.env`'den okumuyor. Yanlış öneke rağmen araç aktif yerel
`taktic-postgres`'i proje etiketi uyuşmadığı için **sorgu atmadan** reddetti.

## 5. Testler

| Kapsam | Sonuç |
|---|---|
| `scripts/ops/migration-recovery.test.mjs` (analiz, 104 migration, guard: staging/production/onay/ad/ek argüman/`--applied`) | 27/27 |
| `scripts/ops/ops-scripts.test.mjs`. 7b: temiz DB, çakışma (maske dahil), image yok, uygulanmış guard, preflight FAIL'de API ayakta, API durunca yeniden sayım. Kurtarma: temiz DB, rapor, resolve + audit + tekrar, ikinci başarısızlık, yanlış DB, yanlış cümle, başarılı migration, production (bayrak ve `.env`), kısmi DDL, nesne var, API çalışıyor, checksum, iki kayıt, Prisma reddi | 34/34 |
| compose-security + runtime-contract | 39/39 (toplam ops node 100/100) |
| `apps/api` `canonicalize-user-phones.spec.ts` + `user-phone-e164-migration.spec.ts` (izole geçici PostgreSQL) | 22/22 |
| `@taktic/api` typecheck · lint · build | temiz |
| shellcheck 0.11.0 `-S warning`, `bash -n` | temiz |
| CI `ops` job'una eklenen gerçek Prisma/PostgreSQL lab adımı (yerelde aynı image ile koşuldu) | geçti |

## 6. Kalan riskler / staging için operatör adımları

- Dump 5 hafta eski: canlı staging'de 7b ve `--report` yeniden çalıştırılmalı.
- Telefon düzeltmesi deploy'dan hemen önce, kısa bir bakım penceresinde yapılmalı
  (runbook "Bakım penceresi"). Adım 4'teki yeniden sayım, P3009'u kesintiye çevirir.
- Kurtarma aracı yalnız staging içindir. Production'da kurtarma restore ya da
  fix-forward ile yapılır.
