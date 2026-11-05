# CI-HARDEN-001 — Test altyapısı güvenilirliği

Taban: `main@22bda0cc`. Hedef: `pnpm test:api`'nin gelecekteki değişikliklerle sessizce bozulmasını
önlemek. CI-PERF-005 §7'deki iki açık borcu kapatır. API iş kuralı, `TEST_DB_RESET` varsayılanı
(`truncate`), shard yapısı, timeout ve retry değişmedi.

## 1. Runner testleri CI'da

`pnpm test:api:runner` (66 test) `unit` job'ının son adımı oldu.

- **Neden `unit`:** Prisma client orada üretiliyor ve runner'ın ön kontrolü bunu okuyor; bu yüzden
  `pr-evidence` olmaz. Veritabanı gerektirmez (`docker` ve `pnpm` yerine stand-in'ler). `static`
  yerine burada, çünkü kırmızısı typecheck ve build sonucunu gizlemez.
- **`if: !cancelled()`:** kırmızı bir unit testi bu adımı, bu adım da unit raporunu gizlemez.
- **Korumalar `pr-evidence`'ta** (`ci-shards.test.mjs`), korudukları adımın dışında: adım var ve
  `db:generate`'ten sonra; `continue-on-error` yok; script `scripts/test/` altındaki her test dosyasını
  adıyla sayıyor; `skip`/`only`/`todo` yok; `unit` hâlâ tek job, servissiz, API shard'ı 4.

## 2. `planner-table-state.ts`: regex yerine açık liste

Regex yalnız varsayılan bir eksik değildi, bugün yanlış çalışıyordu: `admin-search-pagination`'ın ham
sorgusu `FROM "User" u` biçiminde olduğu için eşleşme yoktu, VACUUM hiç çalışmıyor ve test geçiyordu.

Spec artık listeyi yazar: `bitmapOnlyPlan(db, statement, ['User'])`. Birebir aynı üç kopya tek yere
taşındı, böylece kontrol atlanamaz. Düşüren durumlar:

| Durum | Nasıl anlaşılır |
| --- | --- |
| Boş liste | Doğrudan reddedilir |
| Liste dışı veya yanlış yazılmış ad | `pg_class` kataloğu; hiçbir tablo yeniden oluşturulmadan durur |
| VACUUM hatası | PostgreSQL hatası olduğu gibi yükselir |
| VACUUM'un sessiz atlaması | `relfilenode` değişmedi. Sahibi olunmayan tabloda VACUUM yalnız uyarı yazıp başarı döner |
| Plan listede olmayan tabloyu okuyor | `EXPLAIN`'in `Relation Name` alanları, alt planlar dahil |
| Listedeki tabloyu plan okumuyor | Aynı karşılaştırma, ters yönde |

## 3. Bağımsız incelemenin bulguları

Beşi de düzeltildi. Önemli olan ikisi:

- **Linux'ta flake:** "reaches a shard that ignores SIGTERM" testinin `alive()`'ı öldürülmüş ama henüz
  biçilmemiş süreci (zombi) canlı sayıyordu. Yetimleri biçmeyen PID 1 ile Debian container'ında her
  seferinde yeniden üretildi; CI'da ara sıra düşerdi. `alive()` artık `ps` ile durumu sorar. Bekleme
  veya retry eklenmedi; SIGKILL kaldırılınca test hâlâ düşüyor.
- **Tek yönlü liste kontrolü:** `admin-offer-search-optimization`'daki liste `ServiceRequest`'i fazladan
  sayıyordu. Kontrol iki yönlü oldu, liste `['Offer']`.

## 4. Doğrulama

Node 22.18 (CI ile aynı major), yerel makine:

| Komut | Sonuç |
| --- | --- |
| `pnpm test:api:runner` × 5 | 66/66, 45–46 sn |
| Aynısı, `pnpm test:api` yükü altında | 66/66, 49 sn |
| Aynısı, Debian container, biçmeyen PID 1 | 66/66, 40 sn |
| `pnpm test:api` × 2 (`delete` modu) | 253 dosya, 5893 test, 158 ve 185 sn (ikincisinde runner testleri de koştu) |
| `pnpm --filter @taktic/api test` (`truncate`) | 253 dosya, 5893 test, 826 sn, tmpfs tepe 393 MB |
| `pr-evidence` test listesi | 239 test, 0 hata |

14 kasıtlı mutasyonun hepsi düşürdü; aralarında eski regex'in geri konması, `relfilenode` kanıtının
kaldırılması, CI adımının silinmesi veya `db:generate` önüne alınması, `continue-on-error`, `it.skip`
ve `t.skip`, runner'dan SIGKILL'in kaldırılması var.

Üç plan spec'inin süresi, aynı container'da 3'er koşu: `admin-search-pagination` yaklaşık +0,4 sn
(VACUUM artık gerçekten çalışıyor), diğer ikisi farksız.

## 5. Açık riskler

1. Korumalar `ci.yml` metnine bakar. `pr-evidence`'ın `ci-shards.test.mjs`'i çalıştırmayı bırakması
   kendi başına yakalanmaz (önceden de öyleydi).
2. Skip koruması metin aramasıdır; `const s = it.skip` dışında dolaylı yazımları kaçırabilir. Test
   sayısı (66) bilerek sabitlenmedi, yoksa her yeni testte elle güncellenirdi.
3. `planner_state_*` rolü sunucu düzeyindedir. Spec koşarken süreç `kill -9` ile ölürse, uzun ömürlü bir
   sunucuda rol kalır; runner ve CI container'ları atılır.
4. Tüm paket tek veritabanında, runner ayarları olmadan (`max_wal_size` varsayılan 1 GB) 2 GiB tmpfs'i
   doldurdu: `pg_wal` 1 GB'ı aştı. Bunu elle kurulmuş geçici container'da gördük; CI'da her shard paketin
   dörtte birini koşar, runner ise `max_wal_size=256MB` kullanır (aynı koşu tepe 393 MB).
5. Yeni spec'in geçmiş süresi yok: runner tahmini ağırlıkla planlar. Vitest'in `--shard` dilimleri yeni
   dosyayla birkaç dosya kayabilir; her yeni spec'te olduğu gibi.
