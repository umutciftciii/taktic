# CMP-006 PR-B — Teslim raporu (destek talebine bağlı paket iade isteği + webhook mutabakatı)

Tarih: 2026-09-23 · Branch: `claude/cmp-006-prb-package-refund-032c11` · Taban: `main` @ `58c51e13` ·
Tasarım: [`2026-09-23-cmp-006-pr-b-package-refund-requests-design.md`](../specs/2026-09-23-cmp-006-pr-b-package-refund-requests-design.md) ·
Dry-run: [`2026-09-23-cmp-006-pr-b-migration-j-dryrun.txt`](2026-09-23-cmp-006-pr-b-migration-j-dryrun.txt)

**Kampanya motoru anahtarı okunmadı/yazılmadı. `PURCHASE_TERMS_GATE` varsayılan kapalı; kod açmaz. Gerçek Lemon,
gerçek checkout, gerçek e-posta/SMS kullanılmadı; yerel/staging `taktic` verisine dokunulmadı (yalnız izole
dry-run DB'si ve bu checkout'un test DB'leri). Hukuki metin değişmedi. Para/kredi hareketi yazan yeni kod yok.**

> **Rev. 2 (2026-09-23, merge öncesi):** tam tutar mutabakatı (Seçenek 1) ve altı durum e-postası eklendi — §8.
> **Rev. 3:** iade webhook idempotency'si iade durumuna bağlandı; `SETTLEMENT_FAILED` terminal değil — §9.
> §1 tablosu en güncel sayıları taşır.

## 1. Sayılarla

| Ölçüm | Değer |
| --- | --- |
| Migration | **J** `20260923120000_add_package_refund_requests` — 76.; yalnız ekleme, **DML yok** |
| Yeni tablo / enum | `PackageRefundRequest`, `PackageRefundRequestEvent` / 7 enum (`SupportTicketTopic` + 6 `PackageRefund*`) |
| Yeni kolon | `SupportTicket.topic` (`GENERAL` varsayılanı gerçek backfill) · `PackagePurchase.providerOrderTotalAmount/Currency` (NULL, backfill yok) |
| CHECK / partial unique / tetikleyici | 16 CHECK · 2 partial unique (açık istek `SETTLEMENT_FAILED` dahil) · 4 tetikleyici (doğum, durum makinesi, append-only audit, sağlayıcı toplamı değişmezliği) |
| İzin | +3 (`PACKAGE_REFUND_READ`, `PACKAGE_REFUND_REQUEST_CREATE`, `PACKAGE_REFUND_APPROVE`) → 77 → **80** |
| Yeni rota | Admin 7 (route-map'te) · Sağlayıcı 2 (`support/package-refund/*`) · `POST /support/tickets` += `topic`, `packagePurchaseId` |
| Yeni API testi | **111** (akış 27 · mutabakat + e-posta + çoklu iade 29 · yetki/sızıntı 10 · DB değişmezleri 18 · S3 tam/kısmi 8 · olay anahtarı 3 · şablon render/koyu mod 16) |
| Tam API paketi | **163 dosya / 3541 test — hepsi geçti** (rev. 3, temiz test DB'sinde) |
| Web / admin birim | web 351/351 (yeni 5) · admin 74/74 (yeni 3) |
| Yeni E2E | 4 senaryo × Chromium + WebKit = **8/8** (purchase-terms runtime'ına admin süreci eklendi) |
| Tam E2E Chromium | **300/300** (rev. 3 yerel koşu, 9.0 dk) · WebKit iade + purchase-terms 7/7 |
| typecheck / lint / build | api, web, admin, e2e temiz |

## 2. Görev tanımının maddeleri

| İstenen | Nerede / kanıt |
| --- | --- |
| Destek > yeni talep > "Paket ve kredi iadesi", yalnız kendi PAID paketi | `new-ticket-form.tsx`, `providerOptions`; "yalnız kendi…" + "başkasının paketi 404" testleri |
| Tek `SupportTicket` + bağlı tek `PackageRefundRequest`, aynı transaction | `openProviderRefundTicket` (Serializable); `supportTicketId @unique`; eşzamanlı iki gönderim → 201 + 409, tek satır |
| Operatör dışarıda iade eder, TakTic'te para çağrısı yok | `PaymentProviderPort` değişmedi; settlement ledger sayısını değiştirmiyor testi |
| Yalnız imzalı ilgili `order_refunded` → SETTLED; admin yazamaz | `PackageRefundSettlementService` tek yazar; CHECK `settled_by_webhook` + tetikleyici; `settle/complete/...` rotaları 404, `status` alanı 400 |
| Talebe bağlı olmayan `order_refunded` → S3 aynen | "no request" testi (bayrak, event, satın alma PAID, 0 istek); mevcut `campaign-refund-revoke`/`lemon-squeezy-webhook` spec'leri değişmeden geçti |
| Durum makinesi + WITHDRAWN yan çıkışı | servis CAS + `PackageRefundRequest_transition_guard`; geri çekme onaydan önce var, sonra 409/DB reddi |
| `SETTLEMENT_FAILED` yalnız gerekçeli izinli aksiyon, para/kredi yok | `settlement-failed` rotası (`PACKAGE_REFUND_APPROVE`, 10–1000 karakter); ledger değişmez testi |
| Her geçiş audit + ticket zaman çizelgesi | `PackageRefundRequestEvent` (append-only); sağlayıcı/admin zaman çizelgesinde `PACKAGE_REFUND_EVENT` |
| Gate kapalı / set geçersiz / kanıt yok → konu görünmez, API fail-closed | `isPackageRefundFlowOpen` (geçersiz değer = kapalı); `closed` ve `maybe` testleri; E2E "gate closed"; DB tetikleyicisi kanıtsız satın almayı da reddeder |
| Snapshot + onay öncesi yeniden hesap | `submittedEligibility` / `approvalEligibility`; "spend after submission → 409" testi |
| 14 gün, harcama, promo kuralları submit + onay | pencere içi/dışı, `CREDIT_SPENT`, `LINKED_PROMO_CONSUMED`, dönemsel paket testleri |
| İstisna kapalı küme + gerekçe + audit | enum + CHECK `exception_shape`; audit `note` testi |
| Clawback yok, borç/negatif bakiye yok | CHECK `no_clawback` (= 0); hiçbir yol ledger yazmıyor |
| 3 devredilebilir izin, SUPER_ADMIN örtük, tek rolde üçü | `route-permission-map.ts`; "one role may hold all three" testi |
| Maker-checker, NULL kaçağı yok | CHECK `exception_maker_checker` (IS NOT NULL konjunktları); servis 409; dry-run §14 |
| Sızıntı matrisi | anonim 401, müşteri 403/404, diğer sağlayıcı 404, izinsiz ADMIN 403 + ticket'ta iade bloğu yok; canary (IP, UA, digest, metin, kabul id, paymentReference, providerOrderId) 5 yüzeyde yok |
| UI dili | "Talep gönderildi; ödeme iadesi onaylanırsa ödeme sağlayıcısı üzerinden işlenir." — birim testi + E2E birebir |
| Admin liste/detay, ticket bağlantısı, snapshot, audit, izinli aksiyonlar | `/package-refunds`, `/package-refunds/[id]`, destek detayında iade bloğu; E2E |

## 3. Uygulama sırasında çıkan bulgular

**B1 — İstisna yolu nasıl başlar?** Görev tanımı "submit anında 14 gün/harcama/promo doğrulanır" diyor; sağlayıcı
bu yüzden yalnız `REFUNDABLE` satın almayla talep açabiliyor. İstisna (çift çekim, yetkisiz işlem…) için sağlayıcı
genel konuyla yazar, operatör **o talep üzerinden** iade isteği açar (`POST /admin/package-refund-requests`).
Admin tarafında hâlâ ticket oluşturma yolu yok (mevcut destek sözleşmesi korunur).

**B2 — Maker-checker kapsamı.** Görev tanımına uygun olarak yalnız **istisna** onayında zorunlu; normal onayı
işleme alan kişi verebilir (kanonik uygunluk + onay anı yeniden hesap). S0 D5 her onayı kapsıyordu; fark
tasarım §0'da gerekçeli.

**B3 — Kısmi iade sınırı → rev. 2'de kapatıldı (§8).** İlk sürümde kısmi bir `order_refunded` da talebi SETTLED
yapıyordu; artık yalnız saklı Lemon toplamına karşı kanıtlanmış tam iade SETTLED yazar.

**B4 — Webhook onaydan önce gelirse.** Talep `UNDER_REVIEW`'da kalır (settle edilmez), satın alma bayraklanır ve
uygunluk `NOT_APPLICABLE` olur → onay 409; operatör reddeder. `SETTLEMENT_FAILED` sonrası geç gelen, tam iadeyi
kanıtlayan webhook isteği `SETTLED` yapar (rev. 3, §9); kanıtlamayan bildirim yalnız bayrağı yazar.

**B5 — Tetikleyici güçlendirmesi.** Servis kanıtsız satın almayı zaten reddediyordu; doğum tetikleyicisi de artık
reddediyor (dry-run §12). Bu değişiklik geliştirme sırasında yapıldığı için eski sürümü uygulanmış iki test DB'si
(`taktic_<checkout>_test`, `taktic_e2e`) düşürülüp yeniden oluşturuldu; ilk tam koşudaki tek kırmızı buydu.

**B6 — `REFUNDED` artık yazılıyor.** S0 §3.5 gereği SETTLED anında `PackagePurchase.status = REFUNDED` +
`refundedAt`. Bugüne kadar hiçbir yol yazmıyordu; finans özetindeki REFUNDED sayacı ilk kez hareket edebilir.

**B7 — Bildirim yok.** Durum değişikliklerinde e-posta/SMS gönderilmiyor; sağlayıcı ticket'ı açınca görür.
Refund ticket'ı açılırken mevcut "destek talebi açıldı" bildirimi aynen çalışır.

**B8 — CI WebKit yarışı (ilk CI koşusu).** `DASHBOARD_READ` taşımayan personel girişte `/` → `/yetkisiz`
yönlendirmesi alıyor; WebKit'te bu ikinci navigasyon testin sıradaki `goto`'sunu kesti ("interrupted by another
navigation"). Ürün hatası değil: E2E personeline `DASHBOARD_READ` verildi ve giriş sonrası sidebar görünene kadar
bekleniyor. Aynı koşudaki sonraki `TEST_WORKER_INDEX … no location block` hataları, bilinen art arda başarısızlık
artçısıdır (showcase-package-price 45 sn zaman aşımı sonrası).

## 4. Davranış değişiklikleri (dikkat)

| Değişiklik | Kim etkilenir |
| --- | --- |
| Gate kapalı: sağlayıcı formu ve tüm yanıtlar aynı; yalnız ticket özetinde yeni `topic` alanı (`GENERAL`) | Destek API tüketicileri |
| `POST /support/tickets` `topic`/`packagePurchaseId` kabul eder; iade konusunda `subject` sunucu yazar | Web |
| Admin destek detayı `packageRefund` (izinsizde `null`) ve zaman çizelgesinde `PACKAGE_REFUND_EVENT` | Admin |
| SETTLED'da satın alma `REFUNDED` | Finans ekranları |
| E2E: purchase-terms runtime'ı artık admin süreci de başlatır (:3272) | CI süresi (+1 Next süreci) |

## 5. Açık release kapıları

- **RG-1, RG-2 (PR-A) — açık.** Kapı açılmadan bu akış görünmez.
- **RG-3 — açık, bu PR'ın üretim kapısı.** Lemon'da tam tutar iade adımları, `APPROVED_PENDING_SETTLEMENT` SLA'sı,
  webhook gelmezse `SETTLEMENT_FAILED` kaydı, sağlayıcıya ticket'tan bilgi.
- Sonraki dilim: clawback + `unrecoveredCreditBenefit` risk sinyali (CHECK `no_clawback` bilinçli olarak gevşetilecek),
  durum bildirimleri.

## 6. Merge sonrası yerel eşitleme (CI 3/3 ve merge'den sonra)

Yerel DB **75 → 76** (Migration J, yalnız ekleme). `.env` değişikliği gerekmez. Önce dump, sonra `migrate deploy`,
ardından api/web/admin restart. Kapı yerelde açılmaz → iade konusu görünmez; admin'de "Paket İadeleri" boş liste.

## 7. Doğrulama komutları ve sonuçları

- `pnpm --filter @taktic/api test` → 162/162 dosya, 3492/3492 test
- `pnpm --filter @taktic/web exec vitest run` → 351/351 · `pnpm --filter @taktic/admin exec vitest run` → 74/74
- `pnpm typecheck` (api, web, admin, e2e), `lint`, `pnpm build` → temiz
- `pnpm e2e package-refund-request` → Chromium 4/4 · `pnpm e2e:webkit package-refund-request` → WebKit 4/4
- `pnpm e2e` (tam Chromium) → 300/300

## 8. Rev. 2 — tam iade mutabakatı ve durum e-postaları

### 8.1 Sağlayıcı sözleşmesinin tespiti

Resmi Order nesnesi: `total`, `refunded_amount` (sipariş para biriminde kuruş), `currency`, `refunded` (tamamen iade
edildiyse `true`), `status` (`refunded` | `partial_refund`); `order_refunded` tam ve kısmi iadede gelir. Yerel parser
bu alanları okumuyordu. Sipariş düzeyi tutarlar USD normalizasyonuyla `priceAmountSnapshot`'tan kayar (99900 → 99904,
`624f843d`) → `priceAmountSnapshot` eşitliği doğru bir tam iadeyi reddederdi. Seçenek 1 uygulandı. Ham payload,
ödeme referansı veya tutar hiçbir log/yanıt/rapora yazılmadı (log yalnız kısa kod taşır).

### 8.2 A — yapılanlar

| Madde | Uygulama / kanıt |
| --- | --- |
| Kanonik toplam ödeme anında, tek yazıcı, değişmez, sızmaz | `providerOrderTotal(event)` yalnız PAID yapan iki settlement dalında; CHECK pair/shape + `PackagePurchase_provider_order_total_immutable`; `packagePurchaseOmit`; "stores … once" testi |
| Tam kanıt: saklı toplam var ∧ `refunded===true` ∧ `status==='refunded'` ∧ `refunded_amount===toplam` ∧ `currency` | `fullRefundFailure()`; normalizasyon farkıyla (49900 fiyat, 49902 toplam) tam iade SETTLED testi |
| Kısmi/fazla/eksik/para birimi/tutar yok/eski satın alma → SETTLED yok, REFUNDED yok, mali etki yok, tek `SETTLEMENT_FAILED` + audit + ticket olayı | 8 senaryolu matris + eski satın alma testi; `failFromWebhook`; ticket'ta sabit açıklama |
| Tekrar teslimde tek durum/audit | matris her senaryoda aynı olayı iki kez teslim eder |
| Talebe bağlı olmayan kısmi iade S3 revoke tetiklemez (main hatası) | `campaign-refund-revoke.spec.ts` 6 senaryolu kısmi matris; tam iade revoke bir kez |
| Eski satın almalar backfill/tahmin/Lemon çağrısı olmadan fail-closed | Migration J DML içermez; `PROVIDER_TOTAL_MISSING` |

### 8.3 B — durum e-postaları

`package-refund-status` şablonu; niyet geçişle aynı transaction'da, dedupe anahtarı geçişin audit satırı; commit
sonrası `deliverSoon`, kalan niyetleri request lifecycle tick'i süpürür. Testler: tam akış 4 mesaj (SUBMITTED,
UNDER_REVIEW, APPROVED_PENDING_SETTLEMENT, SETTLED), tekrar webhook ve ikinci süpürme ek mesaj üretmez; REJECTED ve
operatör SETTLEMENT_FAILED birer kez ve iç gerekçe olmadan; uyumsuz webhook SETTLEMENT_FAILED bir kez
(`failureSource=WEBHOOK`, tutar yok); geri çekme mesaj üretmez; gönderim hatası niyeti FAILED yapar, durum kalır.
Canary: referans, sipariş no, digest, kabul id, UA, Lemon toplamı ve olay adı hiçbir mesajda yok.

### 8.4 Bulgular

**B9 — Aynı siparişe ikinci iade olayı → rev. 3'te kapatıldı (§9).** Rev. 2'de anahtar sipariş başınaydı ve
tamamlayıcı tam iade "tekrar" sayılıyordu; artık anahtar iade durumuna bağlı ve `SETTLEMENT_FAILED → SETTLED` webhook
ile mümkün.

**B10 — Davranış değişikliği (main'e göre).** Talebe bağlı olmayan `order_refunded` artık yalnız kanıtlanmış tam
iadede S3 revoke çalıştırır. Bu PR'dan önce ödenmiş satın almalarda saklı toplam olmadığı için **hiçbir** `order_refunded`
revoke tetiklemez (bayrak yazılmaya devam eder). Kampanya motoru kapalı olduğundan bugün etkilenen lot yok.

### 8.5 RG-3 (güncel)

Motor veya `PURCHASE_TERMS_GATE` açılmadan önce staging'de **gerçek Lemon sandbox** üzerinde bir **tam** ve bir
**kısmi** iade webhook'u doğrulanacak: tam iadede `refunded=true`, `status=refunded`, `refunded_amount` = saklı
`total`, para birimi eşleşmesi → `SETTLED`; kısmi iadede `partial_refund` → `SETTLEMENT_FAILED`, revoke yok. Aynı
sipariş için kısmi → tam dizisinin iki ayrı olay ürettiği ve tekrar denemenin aynı iade durumunu taşıdığı da bu
koşuda gözlenecek (§9).

## 9. Rev. 3 — iade durumu olayı ve `SETTLEMENT_FAILED → SETTLED`

**`SETTLEMENT_FAILED` terminal değildir.** Dış ödemenin henüz kesinleşmemiş olduğunu kaydeden bir mutabakat
hatasıdır; yalnız güvenilir, tam iadeyi kanıtlayan imzalı webhook onu `SETTLED`'a taşıyabilir. (Önceki metinlerde
geçen "SETTLEMENT_FAILED terminaldir" ifadeleri bu sürümle geçersizdir.) Terminal durumlar: `REJECTED`, `SETTLED`,
`WITHDRAWN`.

| Konu | Uygulama / kanıt |
| --- | --- |
| Güvenilir teslim/olay kimliği | Lemon belgelerinde yok (`X-Event-Name`, `X-Signature`, `meta.event_name`, `meta.custom_data`) |
| İade olay anahtarı | `order_refunded:orders:<id>:<sha256(status, refunded, refunded_amount, currency)[:32]>`; `order_created` ve diğerleri değişmedi; birim testi |
| Zaman damgası | Anahtara **alınmadı**: tekrar denemede `updated_at`'in aynı kalacağı belgelenmemiş; kümülatif tutar + tam bayrağı yeni iadeyi ayırt etmeye yeter. Görev tanımındaki "güncelleme/olay zamanı" öğesinden bilinçli sapma |
| Sızıntı | Anahtar özetli: tutar/para birimi/ham payload saklanmaz, loglanmaz |
| `SETTLEMENT_FAILED → SETTLED` | Tetikleyici: tek izinli çıkış; CHECK: webhook olayı zorunlu, başarısızlık kaydı korunur; açık istek index'ine dahil |
| Operatör | `SETTLED` yazamaz; `SETTLEMENT_FAILED` satırında ret/onay/ikinci başarısızlık 409, DB reddi |
| Operatör kaydı sonrası geç gelen kanıtlı tam iade | `SETTLED` (önceki "canlandırmaz" davranışı değişti) |

**Test matrisi (yeni):** kısmi → aynı kısmi → tam → aynı tam (her adımda olay sayısı 1/1/2/2, durum, webhook audit
sayıları, ticket olayları, e-posta 1 `SETTLEMENT_FAILED` + 1 `SETTLED`, `REFUNDED`, ledger, S3 revoke çağrısı tam 1) ·
tam → sonraki 3 farklı olay sıfır etki · iki farklı kısmi tutar = 2 olay, 1 başarısızlık · kısmi sonrası
para birimi/status/refunded/tutar uyumsuz 5 "tam" bildirimi durum değiştirmez, doğrusu `SETTLED` yapar · operatör
sınırları · talebe bağlı olmayan S3 yolunda gerçek lotla kısmi → aynı → tam → aynı: revoke tam bir kez · DB:
`SETTLEMENT_FAILED` yalnız `SETTLED`'a gider, kaydını korur, `SETTLED` terminal · olay anahtarı birim testleri ·
`order_created` anahtarı ve mevcut Lemon webhook paketi değişmeden geçti.
