# CMP-006 PR-B — Teslim raporu (destek talebine bağlı paket iade isteği + webhook mutabakatı)

Tarih: 2026-09-23 · Branch: `claude/cmp-006-prb-package-refund-032c11` · Taban: `main` @ `58c51e13` ·
Tasarım: [`2026-09-23-cmp-006-pr-b-package-refund-requests-design.md`](../specs/2026-09-23-cmp-006-pr-b-package-refund-requests-design.md) ·
Dry-run: [`2026-09-23-cmp-006-pr-b-migration-j-dryrun.txt`](2026-09-23-cmp-006-pr-b-migration-j-dryrun.txt)

**Kampanya motoru anahtarı okunmadı/yazılmadı. `PURCHASE_TERMS_GATE` varsayılan kapalı; kod açmaz. Gerçek Lemon,
gerçek checkout, gerçek e-posta/SMS kullanılmadı; yerel/staging `taktic` verisine dokunulmadı (yalnız izole
dry-run DB'si ve bu checkout'un test DB'leri). Hukuki metin değişmedi. Para/kredi hareketi yazan yeni kod yok.**

## 1. Sayılarla

| Ölçüm | Değer |
| --- | --- |
| Migration | **J** `20260923120000_add_package_refund_requests` — 76.; yalnız ekleme, **DML yok** |
| Yeni tablo / enum | `PackageRefundRequest`, `PackageRefundRequestEvent` / 7 enum (`SupportTicketTopic` + 6 `PackageRefund*`) |
| Yeni kolon | `SupportTicket.topic` (`GENERAL` varsayılanı gerçek backfill) |
| CHECK / partial unique / tetikleyici | 14 CHECK · 2 partial unique · 3 tetikleyici (doğum, durum makinesi, append-only audit) |
| İzin | +3 (`PACKAGE_REFUND_READ`, `PACKAGE_REFUND_REQUEST_CREATE`, `PACKAGE_REFUND_APPROVE`) → 77 → **80** |
| Yeni rota | Admin 7 (route-map'te) · Sağlayıcı 2 (`support/package-refund/*`) · `POST /support/tickets` += `topic`, `packagePurchaseId` |
| Yeni API testi | **62** (akış 27 · mutabakat 11 · yetki/sızıntı 10 · DB değişmezleri 14) |
| Tam API paketi | **162 dosya / 3492 test — hepsi geçti** (temiz test DB'sinde) |
| Web / admin birim | web 351/351 (yeni 5) · admin 74/74 (yeni 3) |
| Yeni E2E | 4 senaryo × Chromium + WebKit = **8/8** (purchase-terms runtime'ına admin süreci eklendi) |
| Tam E2E Chromium | **300/300** (yerel koşu, 8.9 dk) |
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

**B3 — Kısmi iade sınırı (RG-3'e eklendi).** Sandbox parser `refunded_amount` okumuyor; kısmi bir `order_refunded`
da talebi SETTLED yapar. Operasyon prosedürü paket iadesini **tam tutar** yapmalı; admin ekranı bunu yazıyor.

**B4 — Webhook onaydan önce gelirse.** Talep `UNDER_REVIEW`'da kalır (settle edilmez), satın alma bayraklanır ve
uygunluk `NOT_APPLICABLE` olur → onay 409; operatör reddeder. `SETTLEMENT_FAILED` sonrası geç gelen webhook
talebi canlandırmaz, yalnız mevcut bayrağı yazar.

**B5 — Tetikleyici güçlendirmesi.** Servis kanıtsız satın almayı zaten reddediyordu; doğum tetikleyicisi de artık
reddediyor (dry-run §12). Bu değişiklik geliştirme sırasında yapıldığı için eski sürümü uygulanmış iki test DB'si
(`taktic_<checkout>_test`, `taktic_e2e`) düşürülüp yeniden oluşturuldu; ilk tam koşudaki tek kırmızı buydu.

**B6 — `REFUNDED` artık yazılıyor.** S0 §3.5 gereği SETTLED anında `PackagePurchase.status = REFUNDED` +
`refundedAt`. Bugüne kadar hiçbir yol yazmıyordu; finans özetindeki REFUNDED sayacı ilk kez hareket edebilir.

**B7 — Bildirim yok.** Durum değişikliklerinde e-posta/SMS gönderilmiyor; sağlayıcı ticket'ı açınca görür.
Refund ticket'ı açılırken mevcut "destek talebi açıldı" bildirimi aynen çalışır.

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
