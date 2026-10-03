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

## 7. F — Vitrin hakkı iade/ters ibraz

İlk teslimde ürün kuralları belirsiz olduğu için implement edilmedi. Sonra gelen **ürün kararı** ile dar bir guard eklendi:
iade bildirimi alan (`manualReviewAt` dolu) ya da artık `PAID` olmayan satın alma **yeni değer teslim edemez**.

| Durum | Davranış |
| --- | --- |
| AVAILABLE | kart oluşturma / `use-entitlement` ile rezerve **edilemez**; adıyla seçilse de, aranırken de 409 (`SHOWCASE_ENTITLEMENT_PURCHASE_UNDER_REVIEW`, "Bu satın alma iade incelemesinde olduğu için vitrin hakkı şu anda kullanılamaz."). Adsız aramada temiz bir hak varsa o seçilir |
| RESERVED (canlı değil) | admin onayı / `use-entitlement` ile tüketime **ilerleyemez**; onay işlemi bütünüyle geri alınır (sürüm PENDING, inceleme satırı yok, placement yok) |
| CONSUMED + aktif placement | **dokunulmaz** (otomatik iptal/askı yok) |
| Chargeback / dispute | eklenmedi (ayrı ürün kararı) |

**Write noktaları:** `ShowcaseEntitlementService.reserveForCard` (kart oluşturma ve `use-entitlement`) ve
`ShowcaseEntitlementService.consumeForCard` (admin ilk onay ve `use-entitlement` ile anında yayın). Tüm reserve/consume
yazıları bu iki metottan geçer.

**Transaction / yarış:** `assertPurchaseDeliverable` yazıdan hemen önce, aynı transaction içinde
`SELECT … FROM "ShowcaseEntitlement" JOIN "PackagePurchase" … FOR SHARE OF p` ile satın almayı kilitleyip yeniden okur.
Webhook'un bayrak UPDATE'i bu kilitle sıraya girer: önce commit eden kazanır, ikinci gelen diğerini görür
(serializable yeniden deneme). Test: bayrak commit edilmeden tutulurken rezervasyon kilitte bekler, commit sonrası 409
verir ve hak AVAILABLE kalır. `FOR SHARE` kaldırılınca bu test düşüyor (mutasyonla doğrulandı).

Silme yok, geçmiş/audit yazısı yok, yeni izin yok, migration yok. Web yalnız destekleyici: hata kodu → Türkçe mesaj
(`showcase-errors.ts`) ve hub yönlendirmesi.

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

### Ek düzeltme (iade guard'ı) — hedefli testler

- API: yeni `showcase-entitlement-refund-guard.spec.ts` 8/8; vitrin + Lemon + backend-truth + paket satın alma setleri
  34 dosya / 460 test.
- Web unit 383/383; typecheck api/web/e2e; build api/web.
- Dar E2E: `showcase-package-first-flow` (+ yeni senaryo), `admin-showcase-review-screens`, `showcase-placement*` —
  Chromium 19/19, WebKit 19/19. Full regresyon talimat gereği tekrar koşulmadı.

- CI `37139230162` (head `3f11514d`): chromium ✓, test job'ında tek hata yine `resetDatabase` TRUNCATE deadlock'u
  (40P01, `status-transition-guards`). Test harness'ı deadlock'ta (yalnız 40P01) en çok 4 kez kısa beklemeyle yeniden
  dener; TRUNCATE geri alındığı için güvenli. Etkilenen dosyalar yerelde 87/87.

### Ek düzeltme — cuid/telefon deseni flake'i

- `e2e/tests/seo-indexing.spec.ts`: işletme JSON-LD'sinde `example.test` kontrolü tüm blokta aynen; telefon kontrolü
  (`\+90|05\d{2}`) canonical URL (işletme id'si) çıkarıldıktan sonra — kart kontrolünün mevcut yaklaşımıyla ve PR #140
  sitemap düzeltmesiyle aynı. Uygulama davranışı değişmedi.
- Tarama (`e2e/tests`, `apps/api/test`): cuid içeren JSON'a 4 haneli literal uygulayan 3 küçük assertion aynı sınıfta
  bulundu ve aynı şekilde düzeltildi — `provider-review-notifications` (davet verisi, `reviewUrl` içinde talep id'si),
  `provider-reviews-aggregate` ve `showcase-feed` (id alanları boşaltılır). Kimlik taşımayan `review-removed` verisi
  ve `"0555 123"` (boşluklu) kontrolleri değiştirilmedi.
- Testler: `pnpm e2e seo-indexing` 10/10; 3 API dosyası 35/35; api/e2e typecheck temiz.

## 10. Scope dışı kalan borçlar


- Chargeback/dispute davranışı ve webhook'u (ayrı ürün kararı); iade incelemesi sonuçlanınca hakkın akıbeti.
- Dashboard timeseries, global audit feed, Excel export, manual request create, support reopen, category hard delete,
  genel audit reason politikası (talimat gereği dokunulmadı).
