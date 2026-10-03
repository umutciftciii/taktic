# ADMIN-BACKEND-TRUTH-002 — Liste/Pagination + Scheduler Dayanıklılığı · Teslim raporu

- **Taban:** main `4bb2ffd2f429b66a19bf2c3e5b6c8f5071662b9e`
- **Branch:** `claude/admin-pagination-scheduler-b90412` (tek branch, tek PR)
- **Migration:** **85 → 86** (`20261003180000_add_scheduler_run_lease_and_actor`, yalnız ekleme + guard yeniden tanımı)
- **Kapsam:** A paket satışları · B promosyon uygunluğu · C kampanya listesi · D elle refund-scan run kaydı ·
  E bayat RUNNING kurtarma · F vitrin hakkı iade/ters ibraz analizi (implement edilmedi)

## 1. Endpoint değişiklik matrisi

| Metot | Yol | İzin | Değişiklik |
| --- | --- | --- | --- |
| GET | `/package-purchases/summary` | `PACKAGE_PURCHASES_READ` | + `manualReview` (aynı filtrede `manualReviewAt` dolu satış sayısı) |
| GET | `/admin/promotion-eligibility/holds` | `PROMOTION_ELIGIBILITY_REVIEW` | + `page`/`pageSize` (≤ 100) ve yanıtta `total`, `page`, `pageSize`, `hasNextPage`. Parametresiz çağrı = sayfa 1 × 100 (eski istemcinin gördüğü satırlar) + sayım alanları. Sıra ve filtre semantiği aynı; karar endpoint'i değişmedi |
| GET | `/admin/campaigns` | `CAMPAIGNS_READ` | + `total` (kesin `count(*)`), + `previousCursor`, + `?before=<id>` (önceki sayfa). `items`/`nextCursor` aynen; `cursor`+`before` birlikte 400 |
| POST | `/offers/refund-scan/execute` | `OFFER_REFUND_EXECUTE` | Yanıt ve ledger aktörü aynı; ayrıca `SchedulerRun` (trigger `MANUAL`, `actorId` = oturum) yazar |
| GET | `/operations-settings/schedulers` | `OPERATIONS_SETTINGS_READ` | `lastRun` artık yalnız `SCHEDULER` tetikli; refund işinde + `lastManualRun` (operatör adıyla). Run görünümünde + `heartbeatAt`, `actor` |

Yeni izin ve yeni rota yok. Ortak `readPageParam` → `apps/api/src/common/page-param.ts`.

## 2. A — Paket satışları

`/package-purchases` ekranı `?page=` ile 25'lik sunucu sayfası okur (`GET /package-purchases?…&page&pageSize`).
Tüm listeyi çekme kalmadı: başlıktaki toplam/ödenen sayısı ve manuel inceleme bildirimi `/package-purchases/summary`
(aynı `adminPurchaseWhere`), açık kredi bekletmesi `creditHold=OPEN&pageSize=1` → `total`. Filtreler `status`,
`providerId`, `packageId`, **`showcasePackageId`** (yeni sabitleme), `creditHold`; filtre formu `page` taşımaz → filtre
değişince sayfa 1. Alt bilgi ortak `Pagination` ("30 kaydın 1–25 arası"). Detay/İşletme bağlantıları aynı.

## 3. B — Promosyon uygunluğu

Ekran 50'lik sayfa okur; iki sekmenin sayacı da gerçek `total` (öteki görünüm `pageSize=1` ile). "İlk 100, sayfalanmaz"
metni kalktı. Sağlayıcı detayı (filter=all, ilk 100) toplam fazlaysa "N incelemenin en yeni M tanesi" der.
Sayım + sayfa tek REPEATABLE READ anlık görüntüsünde; sıra `heldAt, id` ile kesin.

## 4. C — Kampanya cursor sözleşmesi

Kanonik anahtar cursor olarak kaldı (offset yok). İleri: `?cursor=<nextCursor>`; geri: `?before=<previousCursor>`
(Prisma negatif `take`, aynı `updatedAt desc, id desc` sırası). `total` filtresiz tablonun kesin sayısı (sayım +
sayfa aynı RR işlemi). UI: "Toplam N kampanya · bu sayfada M", Önceki/Sonraki, sayfalıyken "İlk sayfa".

## 5. D — Elle refund-scan `SchedulerRun`

Aynı `jobKey` (`unviewed-offer-refund`), `trigger = MANUAL`, yeni `actorId` (FK → User, Restrict). CHECK:
`(trigger = MANUAL) = (actorId IS NOT NULL)`. RUNNING → SUCCESS (`processed/refunded/skipped/failed`, scheduler ile
aynı `refundRunSummary`) veya FAILED (hata sınıfı) ve hata yine istemciye döner. 400/403 isteği run yazmaz (doğrulama
ve guard önce). Ledger `createdById` davranışı ve onay kanıtı (admin tarafı) değişmedi. Operasyon ekranında elle
çalıştırma ayrı satır; scheduler'ın "son çalışması" yerine geçmez.

## 6. E — Bayat RUNNING kurtarma (lease/heartbeat)

**Neden süreç belleği değil, neden cadence değil:** İşlerde dağıtık kilit yok; her API instance kendi tikinde kendi
RUNNING satırını açar. Bir satırın "ölü" olduğunu başka instance süreç belleğinden bilemez; `startedAt + cadence`
eşiği ise uzun ama canlı bir koşuyu yanlışlıkla kapatır. Bu yüzden DB'de **lease**:

- Açık koşu `heartbeatAt`'i 60 sn'de bir yeniler (DB saati, `GREATEST` ile yalnız ileri; timer `unref`).
- `COALESCE(heartbeatAt, startedAt) < now() − 5 dk` (5 kaçırılmış heartbeat) olan RUNNING satır →
  `FAILED`, `errorCode = PROCESS_INTERRUPTED`, `finishedAt = kapatıldığı an` (`≥ startedAt`). `startedAt`, özet,
  kimlik korunur; satır silinmez/üzerine yazılmaz.
- Ne zaman: aynı işin yeni koşusundan önce (yalnız o iş), açılışta (`onApplicationBootstrap`, tüm işler) ve 5 dk'lık
  süpürmede (kapalı işin yetimi de kapanır).
- Eşzamanlı instance'lar: UPDATE `status='RUNNING'` + lease koşullu → her satır bir kez kapanır.
- Lease'i dolmuş ama hâlâ yaşayan süreç bitişte 0 satır günceller → kurtarma kaydı kalır, gerçek sonuç warn loguna.
- Guard tetikleyici yeniden tanımlandı: önceki tüm retler aynı; tek yeni izin açık satırın yalnız `heartbeatAt`'i
  ileri alması. Kısmi indeks `SchedulerRun_running_idx (startedAt) WHERE status='RUNNING'`.
- Yeni enum değeri gerekmedi (FAILED + makine-okunur kod; mevcut CHECK'lerle uyumlu).
- UI: "yarıda kaldı (süreç durdu; X itibarıyla kapatıldı)" — "hata verdi" değil. Satırı olmayan iş yine
  "kayıtlı çalışma yok".

**Kalan risk (bilinçli):** Rolling deploy sırasında heartbeat yazmayan eski sürüm instance'ının 5 dk'dan uzun süren
koşusu yeni instance tarafından kapatılabilir (eski koşular saniyeler mertebesinde). Event loop'u 5 dk bloklayan
senkron iş de aynı şekilde kapanır; gerçek sonuç loglanır, geçmiş yeniden yazılmaz.

## 7. F — Vitrin hakkı iade/ters ibraz: **implement edilmedi**

Bugünkü akış (kod incelemesi): Lemon `order_refunded` / `subscription_payment_refunded` satın almayı yalnız manuel
incelemeye işaretler (+ kanıtlı tam iadede promo geri alma ve iade isteği varsa SETTLED); dispute/chargeback olayı
yok sayılır (`UNHANDLED_EVENT`). Vitrin satın alması paket iade isteği akışına giremez (DB tetikleyici). Hiçbir yol
`ShowcaseEntitlement`/`ShowcasePlacement`'a dokunmaz; domain'de CANCELLED/REVOKED hak yok.

Kod ve dokümanda cevabı olmayan sorular: AVAILABLE hak iadede iptal mi; RESERVED (inceleme bekleyen kart) ne olur;
CONSUMED + yayındaki placement geri alınır mı; teslim edilmiş yayın için sağlayıcı borcu; chargeback = iade mi;
iade kaynaklı iptalin audit biçimi. Bu yüzden davranış eklenmedi.

**Önemli bulgu (ürün kararı bekliyor):** rezerv/tüketim yalnız hak durumu ve süreye bakıyor, satın almanın
`REFUNDED`/manuel inceleme durumuna bakmıyor → iadesi bildirilmiş satın almanın AVAILABLE hakkı hâlâ karta bağlanıp
yayına girebilir. Öneri: (1) karar verilene kadar manuel incelemedeki satın almanın hakkının rezervini engelleyen
"bekletme" kuralı, (2) ayrı bir ürün kararıyla `REVOKED` durumu + audit satırı + placement için mevcut manuel iptal.

## 8. Migration güvenliği

- SQL shadow DB'siz `prisma migrate diff --from-schema-datamodel <85 şeması>` ile üretildi; CHECK/kısmi indeks/guard elle.
- Preflight: aktif `taktic` 85 migration, `SchedulerRun` 0 satır.
- Yedek: `~/Backups/taktic-pre-admin-backend-truth-002-20261003-114156.dump` (+ `.sha256`).
- İzole doğrulama: yedek → `taktic_btruth002_verify` → veri parmak izi aktif DB ile eşit
  (`1343132d49dcedb5aa0c3e1686167016`) → `migrate deploy` 85→86 → parmak izi değişmedi → `migrate diff`
  "No difference detected". Doğrulama DB'si silindi. **Aktif yerel DB'ye dokunulmadı**, backfill yok.

## 9. Testler

**Ara hedefli:** yeni `admin-backend-truth-002.spec.ts` 25/25; etkilenen 17 API dosyası 364 test; admin 10 dosya
343 test (+ yeni `scheduler-run.spec.ts`); dar E2E 16/16 (yeni spec + scheduler + kampanya/ayar ekranları).

**FINAL (1 kez):**

| Adım | Sonuç |
| --- | --- |
| API full | 191 dosya / 4233 test; 1 hata: `request-reports-admin` `resetDatabase` TRUNCATE deadlock (40P01, bilinen flake; bekleyen kilit AccessShare okuma) → dosya tek başına 7/7 |
| Admin full unit | 35 dosya / 984 test |
| Typecheck | api / admin / web / e2e temiz |
| Build | api / admin / web |
| Chromium full E2E | 1. koşu 486 ✓ / 2 ✘ — **bu PR'ın fikstürü**: 105 eski açık inceleme `provider-business-registration`'ın kaydını kuyruğun 1. sayfasından itiyordu; kategori adındaki "uygunluk" `category-wave-2-drafts` sızıntı testine takılıyordu → fikstür kendi incelemelerini kapatır, ad değişti (3 spec 10/10). 2. koşu 487 ✓ / 1 ✘ `seo-indexing` — rastgele cuid'de `0535` telefon desenine uydu (PR'dan bağımsız flake) → spec tekrar 10/10 |
| WebKit seçili | 79 ✓: paket satışları/finans, kampanya ekranları (uygunluk + operasyon ayarları dahil), talep-teklif (refund-scan), RBAC, uygunluk kuyruğu, yeni spec |

## 10. Scope dışı kalan borçlar

- `seo-indexing` E2E telefon deseni cuid flake'i (ayrı iş önerildi).

- F: vitrin hakkı iade/chargeback ürün kararı (yukarıdaki öneri), dispute webhook'u.
- Dashboard timeseries, global audit feed, Excel export, manual request create, support reopen, category hard delete,
  genel audit reason politikası (talimat gereği dokunulmadı).
