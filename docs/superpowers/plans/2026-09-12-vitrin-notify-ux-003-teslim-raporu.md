# VIT-NOTIFY-UX-003 — Vitrin bildirimleri, ana sayfa, admin ₺ fiyatı ve SMS test modu: teslim raporu

Dal: `claude/vitrin-notifications-ux-4d71fa` (main ile ortak taban `62a4d921`).
Tek PR; yeni bağımlılık yok; compose, `.env`, staging ve sağlayıcı panolarına dokunulmadı.

## 1. Vitrin yaşam döngüsü e-postaları

Mevcut altyapı kullanıldı: `NotificationLog` + `(template, dedupeKey)` unique index,
`NotificationDispatcher.sendEmailOnce`, `TransactionalMailService`, 600px e-posta
tasarım sistemi (`templates/email-design.ts`). Paralel bir altyapı kurulmadı.

### Yeni şablonlar ve dedupe anahtarları

| Olay | Şablon | Dedupe anahtarı | Tetikleyen |
|---|---|---|---|
| Paket ödemesi başarılı (paket-önce satın alma) | `showcase-package-payment-succeeded` | `showcase-package-payment-succeeded:<purchaseId>` | Lemon webhook `notifySettled` ve mock `mock-pay`, commit sonrası |
| Paket ödemesi başarısız | `showcase-package-payment-failed` | `showcase-package-payment-failed:<purchaseId>` | Mock kart reddi (FAILED, `paymentFailureCode` NULL) ve admin `CANCELLED` |
| Onay + aynı transaction'da yayın | `showcase-card-approved-live` | `showcase-card-approved-live:<versionId>` | `AdminShowcaseService.approveVersion` commit sonrası |
| Onay, yayında değil | `showcase-card-approved` | `showcase-card-approved:<versionId>` | Aynı çağrı; ACTIVE placement yoksa |
| Sonradan yayın | `showcase-placement-activated` (mevcut) | `showcase-placement-activated:<placementId>` | `use-entitlement` publishNow, legacy kart-bağlı settlement |
| Bitişe 7 gün | `showcase-placement-ending-7d` | `showcase-placement-ending-7d:<placementId>` | Lifecycle outbox taraması |
| Bitişe 3 gün | `showcase-placement-ending-3d` | `showcase-placement-ending-3d:<placementId>` | Lifecycle outbox taraması |
| Süre bitti | `showcase-placement-expired` | `showcase-placement-expired:<placementId>` | Expiry transaction'ı içinde intent |

Tek bir çağrı (`sendShowcaseCardApprovalOutcome(versionId)`) onay sonucunu commit
edilmiş satırlardan okur: bu sürüme pinlenmiş ACTIVE placement varsa **tek birleşik**
e-posta (`revision=true/false` ile "ilk yayın" / "güncelleme yayında" cümlesi), yoksa
yalnız onay e-postası. Aynı olay için ikinci bir şablon üretilmez
(`showcase-lifecycle-notifications.spec.ts › approval`).

Fiyat yalnız `showcase-package-payment-succeeded`/`-failed`'da ve yalnız paketin kendi
snapshot bedeli; müşteri hizmet bedeli hiçbir şablonda yok. Başarısız ödeme şablonunda
kart, red nedeni ve kod bulunmaz; `PACKAGE_NOT_MAPPED`/`PROVIDER_UNAVAILABLE` gibi
checkout-açılış hataları (`paymentFailureCode` dolu) `loadFailedShowcasePurchase`
tarafından reddedilir ve e-posta üretmez.

### Outbox / scheduler kararı

- 7/3 gün ve bitiş bildirimleri **`showcase-placement-expiry` işinin içinde**, aynı
  operasyon toggle'ı altında çalışır (`ShowcasePlacementExpiryService.execute`):
  expire transaction'ı içinde `enqueueExpired(tx)` intent yazar; ardından
  `enqueueEndingReminders(now)` ACTIVE ve `endAt` penceredeki (7d: (3d,7d], 3d: (0,3d])
  yerleşimler için `createMany skipDuplicates`; tick sonunda `deliverPending`
  `composeRetryMessage` ile canlı veriden yeniden kurup gönderir.
- Ayrı toggle kurulmadı: hatırlatma ve süre dolumu aynı saati okur; "kimsenin
  kapatmayacağı bir bitişi hatırlat" hâli dürüst bir cümleye dönüşmez. Toggle varsayılanı
  değişmedi (kapalı, `SCHEDULER_JOB_DEFAULTS`), admin ekranı ve audit modeli aynı.
- Ortak mekanizma `notification-intents.ts`'e çıkarıldı; `RequestExpiryOutbox` ve yeni
  `ShowcaseLifecycleOutbox` aynı claim-lease/compose/deliver döngüsünü kullanır.
- Kurallar: reminder yalnız ACTIVE; SUSPENDED/EXPIRED/ARCHIVED taranmaz; süresi
  ≤ eşikten kısa paketler o eşiği almaz; 7d penceresi kaçırılırsa yalnız 3d gider;
  compose anında pencere/durum doğrulanmazsa `SOURCE_UNAVAILABLE` ile FAILED (tekrar
  claim edilmez). Askı sonrası uzayan `endAt` güncel değerle taranır
  (`reminds against the extended end after a suspension that stopped the clock`).
- Yeni sekiz şablon `RETRY_DEDUPE_PREFIXES`'e eklendi; admin "yeniden gönder" bunları da
  canlı veriden yeniden kurabilir. Admin bildirim listesi etiketleri eklendi.

### Testler

`apps/api/test/showcase-lifecycle-notifications.spec.ts` (14 test): tek birleşik onay
mailinin idempotentliği (replay 409, servis tekrar çağrısı DUPLICATE), onay-yalnız,
revizyon, sonradan yayın; 7d→3d→bitiş sırası ve tekrar çalıştırmada duplicate yok;
kısa paket; askıda/expired reminder yok; askı sonrası uzamış `endAt`; crash sonrası
PENDING intent'in sonraki tick'te tek satırla teslimi; `SOURCE_UNAVAILABLE`; config
mapping hatasında e-posta yok; admin iptalinde tek failure maili (admin notu sızmaz);
ödeme başarısı tekrar çağrıda tek. `showcase-package-checkout.spec.ts` ve
`showcase-placement-settlement.spec.ts` yeni bildirime göre güncellendi (duplicate
webhook → tek entitlement, tek e-posta). `transactional-email-render.spec.ts` 39 şablon.

## 2. Ana sayfa vitrin alanı

`apps/web/app/showcase-shelf.tsx`: diğer bölümlerle aynı `lp-section-head` yapısı
(eyebrow + `h2` aynı sol kolonda, açıklama sağda, mobilde alta iner). Feed boşsa veya
yüklenemezse bileşen **`null`** döner: eyebrow, başlık, açıklama, boş grid, ayırıcı
çizgi yok. Karar sunucu tarafında (`/showcase/feed`, yalnız `ACTIVE` + pencere içi +
onaylı kart/sağlayıcı); client'ta render-sonra-gizle yok.

Kanıt: `e2e/tests/showcase-home-shelf.spec.ts` — aktif yerleşim yokken HTML'de
`showcase-section` / "Öne çıkan hizmetler" yok, bir yerleşimle tam basılır; 320/768/1440
px'te başlık sol kenarı eyebrow ve grid sol kenarıyla ≤1px, `text-align` ortalanmamış;
1440'ta açıklama sağda, 320'de altta. Ekran görüntüleri:
`docs/superpowers/plans/2026-09-12-vitrin-notify-screens/home-shelf-{320,768,1440}.png`.

## 3. Admin ₺ fiyat UX'i

- Ortak yardımcı `packages/shared/src/money.ts`: `parseTurkishLiraToMinor`
  (rakam kaydırma, floating point yok), `formatMinorAsTurkishLiraInput`,
  `formatMinorAsTurkishLira`. 33 birim testi (`money.spec.ts`).
- Kabul: `10`→1000, `10,5`→1050, `10,50`→1050, `1.250,75`→125075. Ret: boş/yalnız
  ayırıcı, sıfır, negatif, üç ondalık (`10,505`), nokta ondalık (`10.50`), bozuk binlik
  (`12.50,00`, `1.2500`), harf, üs.
- Admin vitrin paket formu: etiket `Yayın bedeli (₺) *`, `type=text inputMode=decimal`
  + pattern, kayıtlı 1000 → `10,00`; liste `₺10,00`. Geçersiz giriş
  `SHOWCASE_PACKAGE_PRICE_INVALID` ile forma döner. Teklif/kredi paketi formları da aynı
  yardımcıya taşındı (`parseDecimalToMinor`/`formatMinorAsInput` kaldırıldı).
- `Sıra` → "Gelişmiş ayarlar" `<details>` altında "Listeleme sırası"; açıklama:
  yalnız paket listesindeki görünüm sırası, kartların vitrindeki sırasını etkilemez,
  hiçbir paket öncelik/sıralama avantajı vermez. Açıklama alanına da vaat uyarısı.
- Eski vaat: **DML** migration `20260912090000_showcase_package_description_no_priority_promise`
  (şema değişikliği değil, ürün talebiyle yetkilendirilmiş dar kapsamlı veri düzeltmesi):
  tek `UPDATE "ShowcasePackage" SET "description"`, WHERE `slug = 'vitrin-mini-30'` **ve**
  açıklama eski metinle birebir eşit (`"30 gün boyunca vitrinde yer al" + CRLF +
  "Taleplerde öncelik hizmeti"`, 2026-09-11 yedeğindeki orijinal). Operatörün düzenlediği
  açıklama, başka vitrin paketi ve teklif/kredi paketleri dokunulmaz; zaten düzeltilmiş
  satırda 0 etki. Kanıt: `apps/api/test/showcase-package-description-migration.spec.ts`
  (migration dosyasının kendisi seeded satırlara karşı çalıştırılır: 1 satır değişir,
  tekrar 0) ve izole dry-run (`…-migration-dryrun.txt`).
- Kanıt: `e2e/tests/showcase-package-price.spec.ts` (10,50 → DB 1050 → liste ₺10,50 →
  form 10,50; 1.250,75 → 125075; 10 → 1000; `10,505` tarayıcı pattern'ında, `0` server
  action'da reddedilir).

## 4. SMS doğrulama test modu (local/staging)

Ortam tanımı: yeni `APP_ENVIRONMENT ∈ {local, staging, production}` (sunucu env;
`common/app-environment.ts`). İstek başlıkları/IP/query hiçbir kararda okunmaz.
`NODE_ENV=production` her durumda kapatır; tanımsız ortam = kapalı.

Sözleşme (`phone-verification-test-bypass.config.ts`, her koşul fail-closed):
`PHONE_VERIFICATION_TEST_BYPASS_ENABLED=true` (tam olarak) ∧ ortam local/staging ∧
numara `PHONE_VERIFICATION_TEST_BYPASS_PHONES` (E.164, normalize edilir) içinde ∧ kod
`PHONE_VERIFICATION_TEST_BYPASS_CODE` ile sabit-zamanlı eşit ∧
`PHONE_VERIFICATION_TEST_BYPASS_EXPIRES_AT` geçerli ve gelecekte.

Servis entegrasyonu: `verifyCode` ve `verifyStandaloneCode` önce gönderilen kodu bcrypt
ile her zaman kontrol eder; eşleşmezse bypass eşleşmesi ikinci kabul edilebilir cevap
olur. Canlı/süresi dolmamış/kilitsiz satır zorunlu; yanlış kod attempt sayar; rate-limit,
TTL, attempt, lock değişmedi; SMS normal gönderilir. Kabulde satıra
`verifiedByTestBypass=true` yazılır (migration `20260912090100_…`, additive default
false). Kod/allowlist hiçbir yanıt, log, NotificationLog, hata mesajına girmez. Boot'ta
`assertPhoneVerificationTestBypassConfig`: production/tanımsız ortamda flag true → süreç
durur (yalnız değişken **adı**), eksik/bozuk expiry, kod, liste → durur; geçmiş expiry →
uyarı ve kapalı (staging dönemi kendiliğinden biter).

### Güvenlik matrisi (`apps/api/test/phone-verification-test-bypass.spec.ts`, 23 test)

| Durum | Sonuç |
|---|---|
| local + flag + listede + doğru kod + gelecek expiry | doğrulanır, `verifiedByTestBypass=true` |
| staging + aynı koşullar | doğrulanır |
| `APP_ENVIRONMENT=production` + flag | red (400 `PHONE_VERIFICATION_INVALID`) |
| `NODE_ENV=production` + `APP_ENVIRONMENT=staging` | red |
| `APP_ENVIRONMENT` tanımsız | red |
| expiry geçmiş / eksik / bozuk | red |
| yanlış kod | red, attempt +1 |
| listede olmayan numara | test koduyla red; gönderilen kodla normal doğrulama |
| flag kapalı / `1`,`yes`,`TRUE`,`on` | red |
| Origin/Host/Referer/X-Forwarded-*/query spoof | red |
| satır yok / süresi dolmuş / kilitli | red |
| gönderim bütçesi | değişmedi (3/saat) |
| istek-bağlı yol | doğrulanır, `phoneVerifiedAt` set |
| API/HTML/log/NotificationLog çıktısı | kod ve numara yok |
| boot: production+flag, eksik expiry/kod/liste, bozuk ortam adı | throw (değer içermez) |

E2E `showcase-phone-bypass.spec.ts`: phone-gate runtime'ında (env'de sözleşme tam)
listeli numara + test kodu → lead formu; aynı adımlar primary runtime'ında → "Doğrulama
kodu geçersiz". Sayfa HTML'inde kod/"test modu" yok. `.env`/staging değerleri
değiştirilmedi; e2e runtime'ındaki değerler yalnız o suite'e ait placeholder'lardır.

## 5. Doğrulama

- `pnpm typecheck` ✔ (5/5), `pnpm lint` ✔, `pnpm build` ✔.
- `pnpm test` — bkz. §7.
- E2E (Chromium/WebKit) — bkz. §7.
- Migration dry-run (izole DB, aktif URL kullanılmadı; 14 tabloda önce/sonra satır sayısı ve
  md5 parmak izi, beklenen tek fark `vitrin-mini-30.description` eski→yeni):
  `docs/superpowers/plans/2026-09-12-vitrin-notify-migration-dryrun.txt`.

## 6. Ortam değişkenleri (deploy notu; değer bu PR'da yok)

`APP_ENVIRONMENT`, `PHONE_VERIFICATION_TEST_BYPASS_ENABLED`,
`PHONE_VERIFICATION_TEST_BYPASS_PHONES`, `PHONE_VERIFICATION_TEST_BYPASS_CODE`,
`PHONE_VERIFICATION_TEST_BYPASS_EXPIRES_AT`. Staging'de yalnız test dönemi için, süreli
girilir; production'a `APP_ENVIRONMENT=production` verilmesi ve bypass değişkenlerinin
hiç bulunmaması beklenir (flag varsa boot durur).

## 7. Test sonuçları (yerel, 2026-09-12)

- `pnpm typecheck`: 5/5 paket ✔ · `pnpm lint`: 4/4 ✔ · `pnpm build`: 3/3 ✔
- `pnpm test`: 4/4 paket ✔ — API 94 dosya / 2051 test (yeni: `showcase-lifecycle-notifications` 14,
  `phone-verification-test-bypass` 23; güncellenen: render 39 şablon, checkout/settlement),
  shared 97 test (`money.spec.ts` 33).
- E2E Chromium (`pnpm e2e showcase-home-shelf showcase-package-price showcase-phone-bypass
  showcase-placement-lead showcase-screens-viewport phone-verification-gate
  showcase-package-first-flow notification-history scheduler-settings`): 28/28 ✔
  (ilk koşuda iki yeni spec'in kendi fixture/locator hataları düzeltildi; ürün kodu değişmedi).
- E2E WebKit (`--project=webkit`, showcase-home-shelf / -package-price / -phone-bypass /
  -placement-lead): 9/9 ✔.
- Ekran kanıtı: `2026-09-12-vitrin-notify-screens/home-shelf-{320,768,1440}.png`
  (Chromium, section-only screenshot).
- CI (PR #72, son run 34654053607, commit `43d880f9`, daraltılmış DML dahil): üç iş ✔.
  Önceki run (`93dc80ac`) WebKit'te bir tarayıcı çökmesi ("internal error") ve retry'da
  spec fixture adı çakışması verdi; `showcase-placement-lead` kart adı deneme başına
  tekilleştirildi (ürün kodu değişmedi).
- Önceki CI (run 34650664154, commit `a19b567a`): `typecheck · lint · test · build` ✔,
  `e2e (chromium)` ✔, `e2e (webkit)` ✔. İlk koşuda WebKit'te `showcase-cards` 375px adımı
  (geri çekme re-render'ı beklenmeden ⋯ menüsü) ve yeni fiyat spec'inde aynı-URL redirect
  yarışı flake verdi; ikisi de spec tarafında sağlamlaştırıldı (ürün kodu değişmedi).
  Merge edilmedi.
