# CI-PERF-004 — Veritabanı test reset optimizasyonu: mimari analiz ve ölçüm planı

Taban: `main@fd09ea5a`, PostgreSQL 16.6, 109 migration uygulanmış test veritabanı.
Kapsam yalnız `apps/api/test`; e2e'nin kendi TRUNCATE listesi (`e2e/src/database.ts`) değişmez.

## 1. Mevcut durum

`resetDatabase` (`apps/api/test/harness.ts`) önce her canlı uygulamanın arka plan işini
boşaltır, sonra elle yazılmış 99 tabloluk listeyi tek cümlede temizler ve
`OpsAlertRoutingSettings` satırını geri koyar:

    TRUNCATE TABLE <99 tablo> RESTART IDENTITY CASCADE;

Hedef veritabanı koruması URL düzeyindedir (`assertIsTestDatabase`): `_test` soneki,
checkout/shard başına ayrı ad. Sunucuya bağlanınca ne olduğu sorulmaz.

## 2. Katalogdan çıkan bulgular

| Olgu | Değer | Sonuç |
| --- | --- | --- |
| `public` tablo sayısı | 113 | |
| Elle yazılmış liste | 99 | **Eksik** |
| `CASCADE`'in gerçekte ulaştığı küme (FK kapanışı) | 112 | Liste + 13 tablo |
| Kapanış dışı | `_prisma_migrations` | Korunması gereken tek tablo |
| Sequence / identity sütunu | 0 / 0 | `RESTART IDENTITY` bugün etkisiz |
| Kullanıcı trigger'ı | 51 (36 tablo), hepsi `tgenabled='O'` | 24'ü `DELETE`'i reddediyor |
| Dahili FK trigger'ı | 1168 | |
| `ON TRUNCATE` trigger, rule, RLS, partition, kalıtım | 0 | |
| FK | 292 (247+2 RESTRICT, 20 CASCADE, 23 SET NULL; 2'si deferrable) | |

**En önemli bulgu:** liste 99, `TRUNCATE`'in temizlediği küme 112 tablodur. Listede
olmayan 13 tablo (`OperationsSettings`, `ManualCreditOperation`, `ShowcaseEntitlement`,
`ServiceRequestCancellation`, …) yalnız `CASCADE` sayesinde temizlenir. Listeyi olduğu gibi
`DELETE`'e çevirmek, replica rolünde FK kontrolü de kapalı olduğundan, bu 13 tabloda hem
kalıntı hem **sarkan referans** bırakırdı ve testler sessizce başka bir başlangıç durumunda
çalışırdı. Önceki "99 tablo DELETE 9–13 ms" ölçümleri eşdeğer bir işlemi ölçmüyordu; bu
nedenle kapanış katalogdan hesaplanır.

## 3. TRUNCATE ↔ DELETE eşdeğerliği

| Konu | TRUNCATE … CASCADE | DELETE (replica, tek işlem) | Karar |
| --- | --- | --- | --- |
| Temizlenen küme | Liste + FK kapanışı | Katalog kapanışı | Aynı küme; her reset sonrası doğrulanır |
| Foreign key | Kapanış gereği bütünlük korunur | FK trigger'ı susar, kapanış tamsa sarkan referans oluşamaz | Kapanış katalogdan, sıra önemsiz, döngüler sorun değil |
| ON DELETE aksiyonu | Çalışmaz | Çalışmaz (RI trigger'ı origin) | Eşit; küme dışına SET NULL gerekmez, çünkü referans veren her tablo kümede |
| Kullanıcı trigger'ı (append-only) | Satır trigger'ı çalışmaz | `replica` ile çalışmaz | Eşit |
| `ENABLE ALWAYS/REPLICA` trigger | — | `replica`'da çalışır | Bugün 0; varsa delete modu reddedilir |
| `ON TRUNCATE` trigger | Çalışır | Çalışmaz | Bugün 0; varsa delete modu reddedilir |
| Rule, RLS, partition, foreign table | — | Davranış değişir | Bugün 0; varsa delete modu reddedilir |
| Sequence/identity | Sahip olunanlar başa döner | Dönmez | Delete modu katalogdan bulup aynı `ALTER SEQUENCE … RESTART`'ı yapar; sahipsiz sequence iki modda da dokunulmaz |
| Kilit | `ACCESS EXCLUSIVE` | `LOCK TABLE … ACCESS EXCLUSIVE` açıkça alınır | Aynı; işlem ortasındaki yazıcı beklenir, snapshot sonrası kalıntı olamaz |
| Atomiklik | Tek cümle | Tek `DO` bloğu = tek işlem, tek gidiş-dönüş | Aynı; hata tamamını geri alır |
| MVCC | Eski snapshot boş görür | Eski snapshot eski satırı görür | Drain + kilit nedeniyle gözlenebilir değil |
| Fiziksel depo | Yeni relfilenode, 0 sayfa | Ölü satır, autovacuum | **Fark.** Bkz. §6 |
| Planlayıcı istatistiği | `relpages=0` | `relpages` kalır | **Fark.** Plan test eden 3 spec kendi `ANALYZE`'ını yapıp `enable_seqscan=off` kullanıyor; tam suite ile doğrulanır |
| Sırasız SELECT sırası | Ekleme sırası | Vacuum sonrası boş alan kullanımı değişebilir | **Fark.** Sırasız okumaya dayanan test varsa ortaya çıkar; tekrarlı tam koşuyla izlenir |

Arka plan işleri: drain her iki modda da önce çalışır (TEST-FLAKE-003). Sayaçlar
yılda bir dakikaya sabit olduğundan cron yarışı yoktur. 40P01 anlamı değişmez.

## 4. `session_replication_role = replica` ve alternatifler

| Seçenek | Yetki | Maliyet | Sorun |
| --- | --- | --- | --- |
| **`SET LOCAL session_replication_role`** (seçilen) | Süper kullanıcı **veya** PG15+ `GRANT SET ON PARAMETER` | ~2 ms | Yetki güçlü: o oturumda tüm FK/trigger'lar susar. `LOCAL` + tek işlem ile kapsam yalnız reset cümlesi |
| `GRANT SET ON PARAMETER` ile süper kullanıcısız rol | Tablo sahibi + parametre izni | Aynı | En düşük yetkili çalışan yol; kod aynı, ön kontrol kabul eder |
| `ALTER TABLE … DISABLE TRIGGER USER` + topolojik sıra | Tablo sahibi | Tablo başına katalog yazımı ve relcache geçersizleme | Döngülü FK'ler (kart↔sürüm, round↔talep) sıralanamaz; FK trigger'ı açık kalır |
| `DISABLE TRIGGER ALL` | Süper kullanıcı | Aynı | Yetki kazancı yok, üstüne katalog yazımı |
| Append-only fonksiyonlarına kaçış GUC'u | Migration | — | Üretim şemasına arka kapı; **reddedildi** ve migration yasak |
| Test başına transaction rollback | — | Çok hızlı | Uygulama kendi bağlantılarını açıyor; mümkün değil |
| Template veritabanından kopya | `CREATEDB` | 100 ms+ ve bağlantı koparır | Kazanç yok |

Güvenlik sınırı: uygulama kodu bu GUC'u kullanmaz, test rolü dışında yetki verilmez, migration
yoktur. Aynı `SET LOCAL` zaten `harness.ts`'te (`rewriteGrantFixture`) kullanılıyor.

## 5. Tasarım

`TEST_DB_RESET=truncate|delete`; boş/yok = `truncate`, başka değer = koşu hiç başlamaz.

Reset planı istemci başına bir kez kurulur (dosya başına bir; 1 katalog sorgusu):

1. **Hedef sunucuya sorulur:** `current_database()` `_test` kuralından geçmeli (URL korumasına
   ek); `pg_is_in_recovery()` false olmalı.
2. **Katalog:** kümeyi FK kapanışı belirler. `public`'te ne kümede ne de koruma listesinde olan tablo
   → hata (yeni FK'siz tablo bugün sessizce sızıyordu).
3. **Yetki:** TRUNCATE/DELETE izni, sequence sahipliği, delete modunda `session_replication_role`
   izni; eksikse statement çalıştırılmadan anlaşılır hata.
4. **Delete modu şartları:** §3'teki kaçış yolları (ALWAYS/REPLICA, ON TRUNCATE trigger, rule, RLS,
   partition/foreign table) varsa hata.

Her resette:

- **Önce:** bu bağlantıda `session_replication_role = origin` (sızıntı kontrolü) ve küme dışı tablolarda
  satır sayısı plan anındakiyle aynı.
- **Reset:** `truncate` cümlesi bugünküyle birebir; `delete` tek `DO $reset$` bloğu.
- **Sonra (commit dışından):** kümedeki her tablo boş; drain'in kaçırdığı geç yazıcı da burada yakalanır.
- **Hata:** resetçi kalıcı olarak kırılır. Dosyadaki sonraki her `resetDatabase`, veritabanına
  dokunmadan ilk hatayı atar. `beforeEach` hatası test gövdesini koşturmaz; koşu kırmızı biter.

Geri alma: `TEST_DB_RESET` silinir veya `truncate` kalır; `truncate` yolu aynı cümleyi çalıştırır.
Varsayılan bu PR'da değişmez.

## 6. Ölçüm planı

1. **Mikro ölçüm (yapıldı, §7):** gerçek Prisma yolu, 112 tablo, tmpfs ve disk, 150 tekrar.
2. **Yerel tam suite:** tek shard ve 4 paralel shard, iki mod, aynı sunucu; süre, başarısızlık, tmpfs/WAL,
   ölü satır, `pg_database_size`.
3. **CI, aynı runner:** `ci-perf-reset-compare.yml`; her shard aynı VM'de iki modu sırayla koşar, sıra
   koşudan koşuya değişir, Postgres aynı tmpfs ayarlarında. Çıktı: mod başına Test adımı süresi, başarısızlık,
   tmpfs tepesi.
4. **İzolasyon:** paralel shard koşusunda her shard kendi DB'si; koşu sonunda diğer DB'ler değişmemiş.

Kabul: tam suite iki modda da aynı testleri geçiyor, tmpfs tepesi 2 GiB altında, ölü satır sınırlı,
süre kazancı CI'da ölçülü.

## 7. Mikro ölçüm (Prisma üzerinden, satırsız, ms, medyan / p95)

| İşlem | tmpfs | disk |
| --- | --- | --- |
| TRUNCATE 99 liste + CASCADE | 88,8 / 115,2 | 306,7 / 444,1 |
| DELETE 112, kilitsiz | 1,5 / 4,0 | 1,6 / 1,9 |
| DELETE 112, SHARE ROW EXCLUSIVE | 2,0 / 2,9 | 1,8 / 2,2 |
| DELETE 112, ACCESS EXCLUSIVE | 1,9 / 2,1 | 2,0 / 2,3 |
| Kalıntı sorgusu (112 EXISTS) | 0,6 / 0,8 | 0,5 / 0,9 |

Kilit maliyeti ölçülemeyecek kadar küçük; TRUNCATE ile aynı kilit seviyesi korunur.
