# ADMIN-BACKEND-TRUTH-001 — Birleşik Backend Truth Paketi · Teslim raporu

- **Taban:** main `96f014eeef828402c7ff6437cbb8410ddf038b82`
- **Branch:** `claude/backend-truth-paketi-14816b` (tek branch, tek PR)
- **Migration:** **84 → 85** (`20261003120000_add_scheduler_runs_and_showcase_purchase_index`, yalnız ekleme)
- **Kapsam:** A vitrin paketi satın alma filtresi · B vitrin hakkı durumu · C dashboard vitrin kuyruğu ·
  D dashboard şikayetli talep · E refund-scan sayfalama · F scheduler run kalıcılığı

## 1. Endpoint / projeksiyon değişiklik matrisi

| Metot | Yol | İzin | Değişiklik |
| --- | --- | --- | --- |
| GET | `/package-purchases` | `PACKAGE_PURCHASES_READ` | + `showcasePackageId` filtresi. `page`/`pageSize` verilirse `{items,total,page,pageSize,hasNextPage}` (pageSize ≤ 100, varsayılan 25); verilmezse eskisi gibi tüm filtreli dizi. Her satırda + `showcaseEntitlement` |
| GET | `/package-purchases/summary` | `PACKAGE_PURCHASES_READ` | **Yeni.** Aynı filtrelerle `{total, byStatus, paidRevenue[], activeRuns, entitlements{AVAILABLE,RESERVED,CONSUMED,EXPIRED}, asOf}` |
| GET | `/package-purchases/:id` | `PACKAGE_PURCHASES_READ` | + `showcaseEntitlement` |
| PATCH | `/package-purchases/:id/status` | `PACKAGE_PURCHASE_STATUS_WRITE` | yanıtta + `showcaseEntitlement` (davranış aynı) |
| GET | `/dashboard/admin-summary` | `DASHBOARD_READ` | + `reportedRequests` (yalnız `REQUEST_REPORTS_READ` ile), + `pendingShowcaseReviews` (yalnız `SHOWCASE_REVIEW_READ` ile); izin yoksa anahtar **yok** (`mayEmbed`). `refundableOffers` artık refund-scan predicate'i |
| GET | `/service-requests/reports` | `REQUEST_REPORTS_READ` | + `total` (görünümdeki talep sayısı, talep birimi) |
| GET | `/offers/refund-scan` | `OFFER_REFUND_SCAN_READ` | `limit` kaldırıldı; `page`/`pageSize` (varsayılan 50, en çok 100) + `total`, `totalCreditCost`, `page`, `pageSize`, `hasNextPage`; `eligibleCount` = `total` |
| POST | `/offers/refund-scan/execute` | `OFFER_REFUND_EXECUTE` | Değişmedi (limit 1–500, onay kanıtı, `createdById` aktör) |
| GET | `/operations-settings/schedulers` | `OPERATIONS_SETTINGS_READ` | `lastRun` artık DB'den: `{id,status,trigger,startedAt,finishedAt,summary,errorCode}` |

Yeni izin yok. `route-permission-map.ts`'e `/package-purchases/summary` eklendi.

## 2. Kanonik predicate / status yardımcıları

| Yardımcı | Dosya | Kullananlar |
| --- | --- | --- |
| `adminPurchaseWhere(filters)` | `package-purchases.service.ts` | liste, sayfa+total, özet |
| `effectiveShowcaseEntitlementStatus` / `showcaseEntitlementEffectiveWhere` / `toShowcaseEntitlementView` | `showcase/showcase-entitlement-status.ts` | admin liste/detay projeksiyonu, özet sayımı |
| `showcaseReviewQueueWhere()` | `showcase/showcase-review-queue.ts` | `GET /admin/showcase/versions` varsayılanı, dashboard |
| `reportQueueStateWhere` / `reportedRequestWhere` | `request-reports/request-report-queue.ts` | kuyruk listesi + `total`, dashboard |
| `refundCandidateWhere(now)` (export) | `offers/unviewed-offer-refund.service.ts` | refund-scan sayfa/total/kredi toplamı, execute, dashboard |

## 3. Vitrin hakkı (entitlement) durum sözleşmesi

`status` her zaman satırdan **türetilir**; UI hesaplamaz. Zaman karşılaştırması anlık (UTC ms), takvim günü değil.

| `status` | Koşul |
| --- | --- |
| `AVAILABLE` | kayıt AVAILABLE ve `expiresAt > now` |
| `RESERVED` | kayıt RESERVED ve (inceleme duraklaması açık **veya** `expiresAt > now`) |
| `CONSUMED` | kayıt CONSUMED ("kullanıldı"; `usedAt` = `consumedAt`, `placementId` dolu) |
| `EXPIRED` | kayıt EXPIRED, **veya** AVAILABLE ve `expiresAt ≤ now`, **veya** RESERVED, duraklamasız ve `expiresAt ≤ now` (süpürücü gecikmesi) |

Ek alanlar: `id`, `storedStatus`, `grantedAt`, `expiresAt`, `reservedAt`, `usedAt`, `pausedForReview`,
`remainingDays` (yukarı yuvarlanmış tam gün; saat işlemiyorsa `null`), `placementId`. Kredi paketi ve eski kart-bağlı
vitrin satın alması için `showcaseEntitlement: null`.

Domain'de CANCELLED/INVALID hak yok: iade/ters ibraz hakka dokunmuyor (webhook yalnız satın almayı manuel incelemeye
işaretliyor). Uydurulmadı; satın almanın kendi durumu her projeksiyonda hakkın yanında.

## 4. Scheduler kalıcılığı

`SchedulerRun` (yeni tablo): `jobKey`, `trigger` (`SCHEDULER`/`MANUAL`; yalnız `SCHEDULER` yazılıyor), `status`
(`RUNNING`/`SUCCESS`/`FAILED`), `startedAt`, `finishedAt`, `summary` (sayaç satırı), `errorCode` (hata sınıf adı),
`createdAt`. İndeks `(jobKey, startedAt DESC)`.

- Açık bir işin her çalışması başta RUNNING satırı açar, sonda bir kez SUCCESS/FAILED'a kapatır; kapalı işin tiki
  satır yazmaz.
- Tetikleyici: tek geçerli UPDATE RUNNING → terminal (kimlik kolonları sabit); DELETE ve kapalı satırı yeniden yazma
  reddedilir → FAILED üzerine yazılamaz, geçmiş append-only.
- CHECK: `finishedAt` yalnız terminal durumda (ve `≥ startedAt`), `errorCode` yalnız FAILED'da, metin uzunluk sınırı.
- Açılış insert'i başarısız olursa iş durmaz; bitişte tam satır tek seferde yazılır, o da olmazsa yalnız loglanır.
- Restart sonrası `lastRuns()` aynı satırı okur (test: taze registry). Hiç satırı olmayan iş "kayıtlı çalışma yok";
  süreç ortasında ölen çalışma "bitişi kaydedilmedi (sürüyor ya da yarıda kaldı)". Backfill yok.

## 5. Migration güvenliği (H)

- SQL shadow DB kullanılmadan `prisma migrate diff --from-schema-datamodel <taban şema>` ile üretildi; aktif DB
  shadow olarak kullanılmadı.
- Additive: 2 enum, 1 tablo (+ tetikleyici, CHECK'ler), `PackagePurchase(showcasePackageId, createdAt)` indeksi.
- Preflight: aktif `taktic` 84 migration. Yedek: `~/Backups/taktic-pre-admin-backend-truth-001-20261002-235156.dump`
  (+ `.sha256`).
- İzole doğrulama: yedek `taktic_backend_truth_verify`'a yüklendi → parmak izi aktif DB ile eşit → `migrate deploy`
  84→85 → mevcut tabloların veri parmak izi değişmedi, `SchedulerRun` boş, `migrate diff` "No difference detected".
- **Aktif yerel DB'ye dokunulmadı** (merge sonrası eşitleme: `migrate deploy` + yalnız `taktic-api` ve `taktic-admin`
  recreate; web kod farkı yok).

## 6. Count ↔ hedef liste eşitliği (API testleri `admin-backend-truth.spec.ts`)

- C: `pendingShowcaseReviews` == `GET /admin/showcase/versions` uzunluğu (2 bekleyen, 1 gönderilmemiş taslak sayılmaz);
  izinsiz oturumda anahtar yok.
- D: aynı talebe 2 bildirim → `reportedRequests` 1 (`openRequestReports` 2), 2 talep → 2, çözülmüş bildirim sayılmaz;
  dashboard değeri == kuyruğun `total`'ı; kuyruk sayfalıyken `total` bütün kalır.
- E: `refundableOffers` == refund-scan `total` (125 aday ve görüntülenen/engellenen düşürüldükten sonra).

## 7. Refund-scan sayfalama sonucu

125 aday fikstürü (yarısı aynı anda gönderilmiş, eşitliği id bozuyor): sayfa 1 = 100, sayfa 2 = 25, tekrar ve eksik
yok, sıra DB'nin `submittedAt asc, id asc` sırasıyla birebir, `total` = 125, `totalCreditCost` = 250. Varsayılan
sayfa 50; `pageSize=101` ve eski `limit` GET'te 400. Admin ekranı: sayfa `?page=`, özet tüm küme, limit yalnız
çalıştırma parti boyu (1–500 dışında onay kapalı); execute/onay kanıtı/aktör değişmedi.

## 8. Testler

**Ara hedefli:** API `admin-backend-truth` 21/21, `scheduler-settings` 39/39, etkilenen 19 dosya 352 test; admin
11 dosya 693 test; dar E2E 43/43 (dashboard, scheduler, refund-scan, vitrin ekranları, şikayet akışı).

**FINAL (1 kez):**

| Adım | Sonuç |
| --- | --- |
| API full | 190 dosya / 4208 test; ilk koşuda 2 başarısız (`request-publish-outbox`, `review-invitation-outbox` eski bellek-içi `registry.get().outcome`'u okuyordu; test dosyaları tsconfig dışında olduğu için typecheck yakalamadı) → kalıcı okumaya uyarlandı, iki dosya yeniden 13/13 |
| Admin full unit | 34 dosya / 980 test |
| Typecheck | api / admin / web / e2e temiz |
| Build | api / admin / web |
| Chromium full E2E | 484 passed (13.8 dk) |
| WebKit seçili | 81 passed: dashboard, vitrin ekranları, finans/paket, talep-teklif (refund-scan), kampanya/operasyon ayarları, RBAC, cross-domain projeksiyon |

## 9. Scope dışı kalan backend-truth borçları

- Ana `/package-purchases` liste ekranı hâlâ tüm listeyi çekiyor (sunucu filtreli, istemci süzmesi yok; API artık
  sayfalı modu destekliyor, ekranın taşınması ayrı iş).
- İade/ters ibraz vitrin hakkını iptal etmiyor (domain kararı; hak AVAILABLE kalabilir).
- Elle refund-scan çalıştırması `SchedulerRun`'a yazılmıyor (`MANUAL` tetik değeri ayrılmış, yazıcısı yok).
- Bitişi kaydedilmemiş RUNNING satırları için otomatik kapatma yok (bilinçli: tahmin yazılmıyor).
- P3: dashboard timeseries, global audit feed.

