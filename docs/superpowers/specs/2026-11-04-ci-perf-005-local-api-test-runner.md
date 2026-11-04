# CI-PERF-005 — Yerel hızlı API test runner

Taban: `main@7c46aa3d`. Kapsam yalnız yerel geliştirici makinesi; `ci.yml`, `TEST_DB_RESET`
varsayılanı, `.env`, migration ve deploy değişmedi.

    pnpm test:api                  # 4 shard
    pnpm test:api --shards=2       # 1-8
    pnpm test:api --dry-run        # yalnız planı yazar
    pnpm test:api:runner           # runner'ın kendi testleri (Docker'sız, stand-in'lerle)

## 1. Akış

1. Ön kontrol: Prisma client şemayla aynı mı, Docker erişilebilir mi, `ps` cevap veriyor mu.
2. Süpürme: önceki koşulardan kalanlar (bkz. §3).
3. Container: `postgres:16.6-alpine`, CI ile aynı imaj. Benzersiz ad, `run-id` etiketi,
   `127.0.0.1::5432` (portu bağlama anında Docker seçer, arada başka süreç alamaz),
   2 GiB tmpfs, koşuya özel rastgele parola (komut satırına girmez).
4. Geri okuma: tmpfs, ayarlar, port. Beklenen değilse hiçbir test başlamaz.
5. Shard'lar: her biri ayrı süreç grubu, ayrı veritabanı (`taktic_api_shard_<n>_test`), ayrı log.
6. Rapor ve temizlik, sonra tek özet.

**Kabuk ortamı shard'a geçmez.** Yalnız araçların kendini bulması için gereken değişkenler
geçer. `TEST_DATABASE_URL` geçseydi her şeyin önüne geçip bütün shard'ları tek veritabanına
koyardı; `TEST_DB_RESET=delete` yalnız bu runner'ın shard ortamında atanır.

**Dağıtım.** `scripts/test/api-test-durations.json` geçmişiyle LPT, aynı commit her zaman aynı
planı verir. Süre, Nest açılışı ve import dahil olsun diye dosya sonları arasındaki farktan
hesaplanır; Vitest'in dosya başına süresi ilk testten başlar. Geçmişi olmayan dosya medyan
ağırlık alır, geçmiş bozuksa dosya sayısına düşülür. `api-test-plan.mjs update <rapor dizini>...`
yalnız yeşil koşulardan yeniler.

**PostgreSQL ayarları (yalnız bu container):** `fsync`, `synchronous_commit`, `full_page_writes`
kapalı; `wal_level=minimal`, `max_wal_senders=0`, `max_wal_size=256MB`, `checkpoint_timeout=30s`,
`max_connections=200`.

## 2. Bir koşu ne zaman yeşildir

Hepsi birden: her shard exit 0; CI'ın `checkVitest`'i (her dosya tam bir kez, her test `passed`,
skip/todo kabul edilmez); her shard tam planlandığı dosyaları koştu; test dışı hata yok; sunucuda
beklenmeyen veritabanı yok; `taktic` veritabanına sıfır satır yazıldı; hiçbir shard bağlantısı
başka bir shard'ın veritabanında görülmedi; container, port ve süreçler temizlendi.

Yeniden deneme ve timeout değişikliği yok; bilinmeyen `--retry` gibi seçenekler reddedilir.

## 3. Temizlik ve sahiplik

`EXIT`, `INT`, `TERM`, `HUP` (ve yakalanmamış hata) yalnız bu koşunun `run-id` etiketini taşıyan
container'ı siler; ad ile hiçbir şey silinmez. Shard'lara önce `SIGTERM`, 5 sn sonra `SIGKILL`.
`docker` çağrıları ayrı süreç grubunda çalışır, böylece Ctrl-C yarım kalmış bir `docker run`
bırakmaz; 30 sn zaman aşımı (`docker run` için imaj çekme payıyla 10 dk) durmuş daemon'da koşuyu
asılı bırakmaz.

Süpürme bir container'ı yalnız **hepsi** doğrulanırsa siler: etiketleri tam ve bu runner'ın, bu
makine, sahibi yaşamıyor (pid + başlangıç zamanı; `ps` UTC'ye sabit, çünkü `lstart` yerel saattir)
ve 3 sn arayla iki örnekte de bağlantı yok. Bilinmeyen her şey container'ı korur.

## 4. Doğrulama sırasında bulunan üç test hatası

Üçü de runner'ın değil, mevcut testlerin hatasıydı; runner'ın başka zamanlaması ve `delete` modu
ortaya çıkardı. Yeniden deneme eklenmedi, kök neden düzeltildi.

| Test | Kök neden | Yeniden üretim | Düzeltme |
| --- | --- | --- | --- |
| `admin-search-index` plan testi | `delete` reset'i dosya sayfalarını bırakır. Planner maliyeti sayfaya ve son ANALYZE'a bağlı; `ProviderProfile_phone_idx` 4 satırda 38 sayfa, 1 satırda 23 sayfa görüldü, plan iki indeks arasında değişti | Şişmiş veritabanında tek başına koşunca her seferinde kırmızı | `planner-table-state.ts`: EXPLAIN'den önce `VACUUM (FULL)`; üç plan spec'inde |
| `showcase-entitlement-refund-guard` yarış testi | Hata işleyicisi `await webhook`'tan sonra bağlanıyordu; rezervasyon daha önce reddedilirse Vitest unhandled rejection sayıp shard'ı düşürüyor, testler yeşil kalıyor. Reset modundan bağımsız, CI'da da olabilir | Pencereyi 200 ms açınca her seferinde kırmızı | İşleyici promise oluşur oluşmaz bağlanır |
| `admin-backend-truth-002` E | `startedAt` süreç saati, `finishedAt` sunucunun `now()`'ı. Docker Desktop VM saati 1 ms geride kaldı, CHECK reddetti | Bir koşuda görüldü; satır değerleri log'da (22:06:58.566 < .567) | Gerçek kurtarma kodu gibi `GREATEST(now(), startedAt)` |

## 5. Ölçümler

Makine: Apple M5, 10 çekirdek, 16 GB; Docker VM 7,75 GiB. Mac'te aynı anda geliştirme stack'i,
Chrome ve Claude açık (yük ortalaması 7–10).

Son commit üzerinde arka arkaya 5 koşu (252 dosya, 5879 test, 0 hata):

| Koşu | Toplam | Shard'lar (sn) | Container | tmpfs | Test süreçleri |
| --- | --- | --- | --- | --- | --- |
| 1 | 265 sn | 258/256/262/258 | 689 MB | 397 MB | 1511 MB |
| 2 | 301 sn | 293/298/298/294 | 671 MB | 383 MB | 1602 MB |
| 3 | 289 sn | 282/286/286/284 | 697 MB | 374 MB | 1785 MB |
| 4 | 336 sn | 330/332/334/331 | 681 MB | 377 MB | 1931 MB |
| 5 | 321 sn | 305/316/318/311 | 674 MB | 380 MB | 1625 MB |

Aynı oturumun başındaki, daha önceki commit'lerdeki koşular 165, 172, 180, 188, 196 sn sürdü; artışın nedeni kesin olarak belirlenmedi. Ek bir koşu (294 sn) sırasında host CPU ortalama %54 user, %24 sys, %22 boştaydı; termal uyarı yoktu. Container açılışı
1–2 sn, temizlik 1 sn'nin altında. Süre dengesi: en yavaş ile en hızlı shard arasındaki fark
en çok 13 sn (dosya sayısına göre dağılımda 26 sn).

Karşılaştırma, aynı makine, aynı tmpfs: mevcut `pnpm --filter @taktic/api test` (tek süreç,
truncate) 847 sn, 252 dosya yeşil.

`ETIMEDOUT` 0 ve `401` kaynaklı hata 0. Log'daki tek `ECONNRESET`, Turnstile testinin bilerek
ürettiği hata.

## 6. Doğrulanan senaryolar (gerçek container)

| Senaryo | Sonuç |
| --- | --- |
| Testler sürerken `SIGINT` / `SIGTERM` | exit 130 / 143; container, port, süreç yok |
| `kill -9` | Container ve shard'lar kalır (engellenemez) |
| Yetim shard'lar sürerken yeni koşu | Container'a dokunmaz: "something is still connected" |
| Yetimler bitince yeni koşu | Container'ı siler, etiketsiz benzer adlı `taktic-api-test-foreign` kalır |
| Başlangıç sırasında `SIGINT` | exit 130, kalıntı yok |
| Eşzamanlı iki koşu | Ayrı port ve container; B canlı A'yı bırakır, B durdurulunca A bitmeye devam eder |
| Kasıtlı kırmızı spec | Özette adıyla görünür, exit 1, temizlik tam |
| Yazılamayan rapor dizini | Hiçbir şey başlamadan exit 1 |

Geliştirme veritabanı: her koşu öncesi ve sonrası tablo başına satır sayısı + `md5`, veritabanı
listesi, container kimliği, başlangıç zamanı, yeniden başlatma sayısı karşılaştırıldı. Değişen
yalnız `OpsAlertEngineState` (beş dakikada bir) ve `SchedulerRun` (saat başı `unviewed-offer-refund`):
ikisi de `taktic-api`'nin kendi zamanlayıcısı; zaman damgaları koşu başlangıçlarıyla değil cron
tikleriyle hizalı. `taktic-postgres` hiç yeniden başlamadı, 5433 dinlemede kaldı.

## 7. Açık riskler

1. `scripts/test/*.test.mjs` CI'da koşmuyor, çünkü CI yapılandırması bu işin kapsamı dışında.
   `pnpm test:api:runner` elle çalışır.
2. "Başka shard'ın veritabanı" kontrolü 5 sn'de bir örneklemedir. Sıra dışı kısa bir bağlantıyı
   kaçırabilir; ama şu an kod yolu yok (`setup-env.ts` adı aynı slug'tan türetir).
3. `kill -9` sonrası shard'lar bitene kadar container durur, sonraki koşu temizler. Makinenin
   hostname'i değişmişse (Mac'te ağa göre olabiliyor) otomatik silinmez; koşu silme komutunu yazar.
4. `delete` modu yalnız bu runner'da. Sayfa-şişmesine bağlı başka bir plan veya boyut varsayımı
   bugünkü üç EXPLAIN spec'i dışında bulunmadı, ama tarama bu kadarıyla sınırlı.
5. `contact-detection.spec.ts` `performance.now()` ile 200 ms bütçesi ölçüyor; ağır yükte kırılabilir.
   Bu işteki hiçbir koşuda kırılmadı.
6. Süre makine yüküne çok bağlı: 165–336 sn. 5 dk hedefini aşan bir koşu ölçüldü (336 sn).
7. Rapor dizinleri (`apps/api/reports/test-api/`, koşu başına ~2 MB) otomatik silinmez; git'e girmez.
