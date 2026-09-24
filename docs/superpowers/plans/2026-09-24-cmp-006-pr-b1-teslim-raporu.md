# CMP-006 PR-B.1 — Teslim raporu (paket geçmişinden iade talebi + `PURCHASE_TERMS_GATE=test`)

Tarih: 2026-09-24 · Branch: `claude/package-refund-terms-test-36bc0b` · Taban: `main` @ `ff340ba3`

**PR-B iade yaşam döngüsü değişmedi**: durum makinesi, maker-checker, yalnız webhook ile SETTLED, tam iade
mutabakatı, S3 revoke, ledger ve e-posta dedupe'a dokunulmadı. Migration yok (DB 77). Kampanya motoru kapalı.
`PURCHASE_TERMS_GATE` varsayılanı her yerde kapalı; `.env.example` ve compose test modunu açmaz. Production için
RG-1, RG-2, RG-3 yerinde.

## 1. Ne değişti

| Alan | Değişiklik |
| --- | --- |
| Gate sözleşmesi | `PURCHASE_TERMS_GATE` artık `off` (boş/unset) · `on` · `test`; başka değer boot'u reddeder. `on` eskisi gibi (PRODUCTION seti; staging/prod'da APPROVED şart, RG-1). |
| `test` modu | Yalnız `APP_ENVIRONMENT=local`/`staging` ya da tanımsız ortam + `NODE_ENV=test` (birim test worker'ı). `APP_ENVIRONMENT=production`, `NODE_ENV=production` veya tanımsız ortamda **boot reddi**; `on`'a geri düşmez. |
| TEST belge seti | `purchase-terms.test-documents.ts`: `purpose: 'TEST'`, sürüm `test-2026-09-24.1`, her belge "TEST ORTAMI — ÜRETİM SÖZLEŞMESİ DEĞİLDİR" ile başlar. Doğrulayıcı: TEST seti notsuz / APPROVED iddialı ise ret; PRODUCTION seti notu taşırsa ret; `on` TEST setini, `test` PRODUCTION setini asla sunmaz. |
| Kanıt | Test modunda da aynı `PurchaseTermsAcceptance`: snapshot, SHA-256, IP, UA, kanal (DB CHECK'leri değişmeden geçer). |
| Checkout UI | `GET /payments/purchase-terms` += `testMode`; web "Test ortamı — üretim sözleşmesi değildir." bandı (TASLAK bandı yerine). |
| Uygunluk API'si | `GET /support/package-refund/options` artık **yalnız talep açılabilir** satın alımları döner (`selectable`/`notes` kaldırıldı), her birinde sunucunun yazacağı `ticketSubject`, üstte `testMode`. Yeni `GET /support/package-refund/purchases/:id/availability` → `{ available }`; yabancı/uydurma/uygunsuz/kapalı hepsi aynı `false`. İkisi de aynı `requestablePurchases` yolu + kanonik `evaluatePackageRefundEligibility`. |
| Paket detayı | "İade" kartı + `İade talebi oluştur` → `/destek/yeni?type=PACKAGE_REFUND&purchaseId=<id>`; yalnız API `available: true` derse. |
| Destek formu | "Talep türü": Genel destek / Paket ve kredi iadesi. İadede konu alanı yok; sunucunun konusu salt okunur gösterilir. Query yalnız API listesindeki satın alımı ön-seçer; listede olmayan id sessizce düşer. Oturumsuz girişte query `redirectTo` ile korunur. |
| Oluşturma | Değişmedi: `POST /support/tickets` → `openProviderRefundTicket` (ticket + mesaj + istek + audit tek Serializable işlem). İstemcinin `subject`'i yazılmaz (test ile kanıtlı). |
| E2E | Purchase-terms runtime'ı `PURCHASE_TERMS_GATE=test` ile koşar (`Runtime.purchaseTermsGate: 'off'|'on'|'test'`). |

## 2. Testler

- API yeni: `package-refund-purchase-entry.spec.ts` (17) — availability: kendi/yabancı/uydurma, kanıtsız eski satın alım,
  14 gün sınırı, kredi harcaması, bağlı promo tüketimi, açık istek (geri çekince tekrar true), PAID olmayan, müşteri 403 /
  anonim 401; gate matrisi (unset/off/geçersiz kapalı + sıfır yazı, `on` açık, `test` açık + `testMode`); TEST setiyle
  atomik ticket+istek, sunucu konusu, spoof id 404 + sıfır yazı.
- `purchase-terms-gate.spec.ts`: TEST seti bütünlüğü/işareti, `test` ortam matrisi (local/staging/test-worker açık;
  production, NODE_ENV=production, tanımsız, yanlış yazım ret), `on`/`test` set çaprazlaması.
- `purchase-terms-acceptance.spec.ts`: `test` modunda TEST setinin sunulması, eski sürümün reddi, tam kanıt satırı;
  boot: `APP_ENVIRONMENT=production` + `test` → uygulama başlamaz.
- Web: form (tür etiketi, ön seçim, sabit konu, yabancı id ön-seçilmez, test bandı), `initialPackageRefundSelection`,
  link üretimi, terms bandı (test/taslak/onaylı).
- E2E: Paket geçmişi → Detay → CTA → ön-seçili form → gönder → CTA kaybolur; düz destek formunda tür + paket seçimi +
  geri çekme; uygunsuz satın almada CTA ve tür yok; gate kapalıyken CTA/tür yok; query spoof sızıntı/işlem yok.

| Koşu | Sonuç |
| --- | --- |
| typecheck + lint (api src+test, web, admin, shared, e2e) | temiz |
| API | 170 dosya / **3700** test yeşil |
| web / admin / shared | 363 / 78 / 168 yeşil |
| E2E Chromium (yerel) | §4 |
| E2E WebKit (yerel) | §4 |
| CI | PR üzerinde |

## 3. Yerel kabul testi (2026-09-24)

Docker stack (main kodu) **hiç değiştirilmedi**; main `test` değerini tanımadığı için orada açılamazdı (boot reddi).
Branch kodu worktree'den ayrı süreçlerle koşuldu: API `:3011` (`APP_ENVIRONMENT=local`, `PURCHASE_TERMS_GATE=test`,
`PAYMENT_PROVIDER=mock`, `EMAIL_TRANSPORT=console`, Lemon anahtarları boş), web `:3010`; aktif yerel `taktic` DB'si.

1. Krediler ekranı: "Test ortamı — üretim sözleşmesi değildir." bandı, sürüm `test-2026-09-24.1`, üç kartta onay kutusu.
2. Kutu işaretli satın alma → `PurchaseTermsAcceptance`: `test-2026-09-24.1`, SHA `06a038e8…`, snapshot 2551 karakter
   (TEST notu içerir), IP `::1`, tarayıcı UA, kanal `WEB`.
3. Ödeme mock formu doldurulmadı; E2E ile aynı yöntemle satın alma DB'de `PAID` işaretlendi (kredi yüklenmedi).
4. Paket detayı → "İade" kartı + `İade talebi oluştur` → `/destek/yeni?type=PACKAGE_REFUND&purchaseId=…`: iade türü
   seçili, paket seçili, konu `Paket ve kredi iadesi: Başlangıç Paketi (PKG-2026-000008)` salt okunur, test bandı.
5. Spoof: başka sağlayıcının PAID satın alımı query'de → tür seçili ama paket seçili değil, gönder pasif, görünür metinde
   id/paket yok (id yalnız Next router state'inde, saldırganın kendi URL'si); `availability` → `false`;
   doğrudan `POST /support/tickets` → 404; ticket/istek sayısı değişmedi.
6. Gönderim → `SUBMITTED`, ticket + 1 mesaj + istek + 1 olay, kredi hareketi 0; sonra `availability` `false`,
   `options` boş.
7. Gate `off` ile yeniden başlatıldı: istek geri çekildi (gate kapalıyken de mümkün) → `WITHDRAWN`; `availability`
   `false`, `options` `{available:false,testMode:false}`, `purchase-terms` `{required:false}`; detayda kart/CTA yok,
   `/destek/yeni?type=PACKAGE_REFUND…` düz genel form. Worktree süreçleri durduruldu; Docker API'de
   `PURCHASE_TERMS_GATE` boş.

**Üretilen test verisi (yerel `taktic`, silinmedi):**

| Tablo | Kayıt |
| --- | --- |
| `User` | `cmufad36f0000lwootf5jhklb` — `prb1-kabul-114434@example.test`, PROVIDER (+3 `Session`) |
| `ProviderProfile` | `prb1-kabul-provider` — "PR-B.1 Kabul İşletmesi", APPROVED (SQL ile) |
| `PackagePurchase` | `538f043a-9744-4bd1-8e95-df22683ca7f8` — `PKG-2026-000008`, Başlangıç Paketi, PAID (DB ile) |
| `PurchaseTermsAcceptance` | `cmufae2kl0006lwoo3gcb17o2` — `test-2026-09-24.1` |
| `SupportTicket` | `cmufagjbl0008lwooxn9tzjam` (+1 mesaj) |
| `PackageRefundRequest` | `cmufagjbp000clwoo6g661mkn` — WITHDRAWN, 2 olay |
| `NotificationLog` | 4 satır (e-posta doğrulama, 2 destek bildirimi, 1 `package-refund-status`) — console transport, dışarı çıkış yok |

## 4. E2E

(koşu sonuçları aşağıda güncellenir)

## 5. Açık / sonraki

- Staging'de `test` açmak ayrı ve açık bir adım: host env'inde `PURCHASE_TERMS_GATE=test` + `APP_ENVIRONMENT=staging`.
- Production'da `on` için RG-1 (onaylı metin), RG-2 (KVKK saklama), RG-3 (sandbox tam iade kanıtı) hâlâ şart.
