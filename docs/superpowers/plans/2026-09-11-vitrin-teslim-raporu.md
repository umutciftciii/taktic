# VIT-DESIGN-002 — Vitrin paket-önce akışı: teslim raporu

Dal: `claude/vitrin-package-flow-redesign-27b4ed` (main ile ortak taban `90201b86`).
Tasarım: `docs/superpowers/specs/2026-09-11-vitrin-package-first-flow-design.md`.
Plan: `docs/superpowers/plans/2026-09-11-vitrin-package-first-flow.md` (13 görev).

Özet: vitrin satışı karttan ayrıldı. Hizmet veren önce paketi alır; ödeme bir
**yayın hakkı** (`ShowcaseEntitlement`) üretir; kart bu hakla açılır; adminin ilk
onayı hakkı tüketir ve yayını (placement) aynı transaction içinde doğurur.
"Onaylandı ama yayınlanamıyor" hâli artık temsil edilemez.

## 1. Hakkın geçerlilik süresi nasıl belirlendi?

- Kural: `ShowcasePackage.activationWindowDays INT NOT NULL DEFAULT 90`
  (`prisma/schema.prisma`, migration `20260911120000_add_showcase_entitlements`,
  `CHECK activationWindowDays > 0`). Satın alınmış ama kullanılmamış hak, ödeme
  anından itibaren bu kadar gün içinde ilk onayla tüketilmezse düşer.
- Gerekçe (spec §2.1): pakette böyle bir süre tanımlı değildi; sınırsız hak üretmek
  yerine açık ve paket başına değiştirilebilir bir kural konuldu. 90 gün, 30 günlük
  paket için üç yayın periyodu kadar hazırlık payı verir. Admin paket formunda
  "Kullanılmamış hakkın geçerliliği (gün)" alanıyla düzenlenir; değer hak satırına
  `expiresAt` olarak **snapshot'lanır**, paketin sonradan değişmesi satılmış hakkı
  kısaltmaz/uzatmaz.
- İnceleme süresi hakkı tüketmez (spec §2.5): 90 gün sağlayıcının kartı
  **incelemeye gönderme** yükümlülüğüdür, adminin karar süresi değildir. Kart
  `PENDING_REVIEW`'a girdiğinde `ShowcaseEntitlement.reviewPausedAt` yazılır ve saat
  durur; red / geri çekme / silme / onay ile duraklama kapanırken geçen süre
  `expiresAt`'e eklenir (`totalPausedSeconds` toplanır). Süpürücü
  (`ShowcasePlacementExpiryService`) `reviewPausedAt IS NOT NULL` hakları atlar;
  admin gecikmesi bir hakkı EXPIRED yapamaz.
- Denetim tablosu: `ShowcaseEntitlementReviewPause` (`entitlementId`,
  `cardVersionId`, `startedAt`, `endedAt?`, `expiresAtBefore`, `expiresAtAfter?`,
  `endReason? ∈ {REJECTED, WITHDRAWN, RELEASED, CONSUMED}`), append-only;
  `UNIQUE (entitlementId) WHERE endedAt IS NULL` ile bir hak aynı anda tek
  duraklamada. `ShowcasePlacementSuspension`'ın `endAtBefore/After` disiplini
  birebir uygulanmıştır.
- Kanıt: `apps/api/test/showcase-entitlement-lifecycle.spec.ts`
  ("stops the clock in review, gives the time back on rejection, and never expires a
  paused right"; "expires stale unreserved and reserved-but-idle rights") ve
  `showcase-entitlement-review-flow.spec.ts`.

## 2. Mevcut veri migration'dan nasıl etkilenmedi?

- Migration tek ve **additive**: yalnız enum, kolon (default'lu / nullable), tablo,
  index ve CHECK ekler. Dosyanın başındaki not ve gövdesi doğrulandı: hiçbir
  `UPDATE`, `DELETE`, `DROP TABLE`/`DROP COLUMN` yok; tek `DROP CONSTRAINT`,
  `PackagePurchase_showcase_card_matches_kind` CHECK'inin aynı isimle yeniden
  tanımlanmasıdır.
- Yeniden yazılan CHECK üç şekli kabul eder: `OFFER_PACKAGE` (tüm vitrin alanları
  NULL), **legacy kart-bağlı vitrin satın alması** (`showcaseCardId` +
  `showcaseCardVersionId` + `showcasePriceTermsAcceptanceId` dolu — yalnız tarih,
  artık hiçbir kod yazmaz) ve **paket-önce satın alma** (`showcasePackageTermsAcceptanceId`
  dolu, kart alanları NULL). Mevcut her satır bu dallardan birini zaten sağlar.
- `activationWindowDays` bir backfill değil DEFAULT'tur: katalog düzeyi işlem, paket
  satırı yeniden yazılmaz. Mevcut paket ("1 Aylık Vitrin Paketi") 90 alır.
- Dry-run kanıtı (`docs/superpowers/plans/2026-09-11-vitrin-migration-dryrun.txt`):
  aktif DB'nin `pg_dump` kopyası izole `taktic_vitdesign002_dryrun` veritabanına
  yüklendi, `prisma migrate deploy` yalnız bu migration'ı uyguladı. Öncesi ve
  sonrası satır sayıları `1|1|6|0|1|11|10|6|9` ve iki içerik md5'i
  (`5c985341…`, `b74ad286…`) birebir aynı; sonrasında paket
  `1 Aylık Vitrin Paketi|90`, `ShowcaseEntitlement` satır sayısı 0. Aktif
  `DATABASE_URL` shadow olarak kullanılmadı.

## 3. Eski kart-first akışının kaldırılan / dönüştürülen ekranları

| Eski | Yeni |
|---|---|
| `apps/web/app/providers/[id]/vitrin/publish-panel.tsx` (`PublishPanel`, kart içinde paket satışı + şart onayı + ödeme) | **Silindi.** Paket satışı `/providers/:id/vitrin/paketler`'e taşındı (paket seçici + sorumluluk kabulü + `Güvenli ödemeye geç`). |
| Kart ekranındaki "İncelemeye gönder" şart onay kutusu | Kaldırıldı. Şartlar paket alınırken kabul edilir (`ShowcasePackageTermsAcceptance`), metin rezerve haktan snapshot olarak taşınır. |
| Kart durumları `TERMS_REQUIRED` / `READY_TO_PUBLISH` / `AWAITING_PAYMENT` ("Şart onayı bekliyor / Yayına hazır / Ödeme bekliyor") | Kalktı. `ShowcasePublicationService` sunucuda çözer: `DRAFT · IN_REVIEW · NEEDS_PACKAGE (Pakete hazır) · LIVE · REJECTED · EXPIRED · …`; kart girdisi `entitlement`, `needsPackage`, `hasRunBefore` taşır. |
| API uçları `POST …/showcase/placements/checkout`, `GET …/placements/eligibility`, `GET/POST …/cards/:id/price-terms(-acceptances)` | Kaldırıldı. `apps/api/test/showcase-legacy-routes.spec.ts` 404 döndüklerini, `apps/web/test/showcase-legacy-routes.spec.ts` web+admin ağacında sıfır referans olduğunu doğrular. Yerine `POST …/showcase/packages/checkout`, `GET …/showcase/packages/terms`, `GET …/showcase/entitlements`, `GET …/showcase/publication` ve `POST …/cards/:id/use-entitlement`. |
| Lemon dönüş URL'si (`/providers/:id/vitrin/odeme/:purchaseId`) 404 veriyordu | Rota eklendi: PAID → `Vitrin hakkınız hazır` / `Şimdi kartınızı oluşturun`; PENDING → `Ödemeye devam et`; FAILED/CANCELLED → "Ödeme tamamlanmadı, hak oluşmadı". |
| Admin menüsü (dağınık vitrin girdileri) | `Paketler`, `Kart incelemeleri`, `Yayındaki kartlar`, `Vitrin talepleri` (`apps/admin/lib/nav.ts`). İnceleme detayında yayın hakkı satırı ve hak yoksa `Onayla` yanında neden. |
| Ana sayfa rafı ve kart detayı (panel/operasyon görünümü) | Tek `ShowcaseCardFace` bileşeni (`apps/web/app/showcase-card-face.tsx`): raf, sağlayıcı grid'i, kart özeti ve public kart aynı yüzü çizer. |

## 4. Yeni kullanıcı akışı ekran ekran

1. **Vitrinde yer alın** (`/providers/:id/vitrin`) — sayaç `N kullanılabilir vitrin
   hakkınız var`; hak yoksa tek CTA `Vitrin paketi al`. Grid "Yayında" / "Hazırlık"
   başlıklarında kart yüzü + rozet (`Taslak · İncelemede · Pakete hazır · Yayında ·
   Reddedildi · Süresi doldu`) + tek bağlamsal eylem.
2. **Vitrin paketi al** (`/vitrin/paketler`) — paket kartları; seçilince sorumluluk
   metni kutusu (daha önce kabul edildiyse görünmez). Kabulsüz CTA pasif:
   "Devam etmek için sorumluluk metnini kabul edin." Yapılandırmasız paket:
   `Bu paket şu an satın alınamıyor`.
3. **Güvenli ödemeye geç** — Lemon Squeezy checkout (test ortamında mock form);
   ödeme dönüşü `/vitrin/odeme/:purchaseId`.
4. **Vitrin hakkınız hazır** — `Şimdi kartınızı oluşturun` (`?card=` ile gelindiyse
   `Kartı yayınla`).
5. **Vitrin kartını oluştur** (`/vitrin/yeni`) — yalnız geçerli hak olana; üstte
   kullanılacak hak ("1 Aylık Vitrin Paketi · 30 gün"). Gruplar: Temel bilgiler /
   Hizmet ve fiyat / Yanıt taahhüdü / Hizmet bölgeleri.
6. **Kartınızı incelemeye gönderin** (`/vitrin/:cardId`) — kart özeti
   (`ShowcaseCardFace`) + yayın durumu paneli; `İncelemeye gönder`, `Kartı düzenle`,
   `⋯` → `Kartı sil ve yayın hakkını serbest bırak`.
7. **Kartınız inceleniyor** — rozet `İncelemede`; hak saati durur; `İncelemeyi geri çek` ile
   düzenleme.
8. **Admin — Onayla** (`Kart incelemeleri`) — tek Serializable tx'te: RESERVED +
   geçerli hak (yoksa `SHOWCASE_ENTITLEMENT_MISSING`, yazım yok), sağlayıcı hâlâ
   APPROVED, kategori açık, bölgeler kapsam içinde; sonra sürüm APPROVED, hak
   CONSUMED (`count = 1`), placement `createForEntitlement` (haktan snapshot),
   duraklama `CONSUMED` ile kapanır, raf satırları. Red: not + `Düzenle ve yeniden
   gönder`; hak süresi dolduysa eldeki kullanılabilir hak karta bağlanır (mağazaya
   döngü yok).
9. **Kartınız yayında** — rozet `Yayında`, bitiş tarihi, `Yayını görüntüle`;
   arşiv yalnız canlı sürümde.
10. **Ana sayfa rafı** — konumsuz `Öne çıkan hizmetler`; yalnız `livePlacementWhere`
    ile onaylı + aktif kartlar.
11. **Bu hizmeti incele** → kart detayı (aynı kart yüzü) → **Devam et / Vazgeç**.
12. **Adres** — gerçek adres girişi, sunucu kapsam kontrolü.
13. **Kapsam dışı reddi** — kapsam dışında `ServiceRequest`/`ShowcaseLead` yazılmaz,
    genel talep CTA'sı gösterilir; kapsam içinde talep yalnız kart sahibine gider.

Ekran görüntüleri (`docs/superpowers/plans/2026-09-11-vitrin-screens/`, 18 PNG,
1440 ve 320 px; `e2e/tests/showcase-screens-viewport.spec.ts` üretir ve yatay
taşmanın 0 olduğunu doğrular): `hub`, `packages`, `payment-paid`, `create`,
`card-draft`, `card-edit`, `admin-review`, `public-home`, `public-card`.

## 5. Migration dry-run ve veri bütünlüğü kanıtı

- `docs/superpowers/plans/2026-09-11-vitrin-migration-dryrun.txt`: izole kopya DB'de
  `migrate deploy`; öncesi = sonrası satır sayıları ve md5'ler (bkz. §2).
- `apps/api/test/showcase-entitlement-lifecycle.spec.ts › schema › applies the
  entitlement migration: the tables exist and the package default is 90 days` —
  test DB'de migration'ın uygulandığını, `ShowcaseEntitlement` /
  `ShowcaseEntitlementReviewPause` / `ShowcasePackageTermsAcceptance` tablolarını ve
  90 gün default'unu doğrular. Aynı dosya: tek settlement → tek hak (ikinci grant
  reddedilir), rezervasyon yarışı (iki kart, bir hak → tam biri), serbest bırakma,
  tek tüketim, duraklama ve süpürme.
- `showcase-package-checkout.spec.ts`: webhook + mock settlement aynı dallanma,
  yeniden teslim ikinci hak üretmez; `showcase-placement-settlement.spec.ts`:
  legacy kart-bağlı purchase settlement'ı bozulmadı.
- `apps/api` `@taktic/shared` import etmez; yeni bağımlılık yok; Lemon/Resend/
  Cloudflare/`.env`/compose ayarlarına dokunulmadı; iade davranışı eklenmedi.

## Doğrulama

Kökten, sırayla (`DATABASE_URL='postgresql://taktic_user:taktic_password@localhost:5433/taktic?schema=public'`):

| Komut | Sonuç |
|---|---|
| `pnpm typecheck` | `Tasks: 5 successful, 5 total` |
| `pnpm lint` | `Tasks: 4 successful, 4 total` |
| `pnpm test` | `Tasks: 4 successful, 4 total` — `@taktic/api` 92 dosya / **1951 passed**; `@taktic/web` 10 / **80 passed**; `@taktic/admin` 2 / **39 passed**; `@taktic/shared` 3 / 60 passed. Vitrin API spec'leri: 20 dosya / 267 test (`showcase-*.spec.ts`). |
| `pnpm build` | `Tasks: 3 successful, 3 total` |
| `pnpm e2e` (Chromium) | **200 passed (7.0m)**, 0 failed — vitrin spec'leri: `showcase-cards` 8, `showcase-package-first-flow` 6, `showcase-placement-lead` 5, `showcase-screens-viewport` 4 |
| `pnpm e2e:webkit` (WebKit) | **47 passed (1.8m)**, 0 failed — WebKit projesi `testMatch` gereği giriş/oturum/responsive spec'leri ile **tüm** `showcase-*` spec'lerini koşar: `showcase-cards` 8, `showcase-package-first-flow` 6, `showcase-placement-lead` 5, `showcase-screens-viewport` 4 |

Hiçbir test yeniden koşulmadı; flaky ya da atlanan spec yok.

Ekran görüntüsü dizini `docs/superpowers/plans/2026-09-11-vitrin-screens/`:
`admin-review-{1440,320}.png`, `card-draft-{1440,320}.png`, `card-edit-{1440,320}.png`,
`create-{1440,320}.png`, `hub-{1440,320}.png`, `packages-{1440,320}.png`,
`payment-paid-{1440,320}.png`, `public-card-{1440,320}.png`, `public-home-{1440,320}.png`.

### Bilinen sınırlar / ertelenen cila

Görev defterinden (`.superpowers/sdd/.../progress.md`) özet; hiçbiri davranışı
bozmaz, hepsi ayrı küçük PR'lara uygundur:

- **Servis katmanı:** `pauseForReview` / `closePause` düz `update` kullanır (DB
  CHECK arka koruma); `expireStale` satır satır döner; `archiveCard`,
  `withdrawSubmission` tx gövdesini tekrarlar (ortak `withdrawPendingVersion`
  çıkarılabilir); `getVersion` geçerlilik yüklemini yeniden yazar; `useEntitlement`
  doc yorumu güncel değil; P2002 yakalayıcı `.code` da kontrol edebilir;
  `expireStale` placement `try` bloğu dışında.
- **Satın alma:** şart metni sürümü yükseldikten sonra eski kabulle yeniden
  kullanılan Lemon purchase; `listForAdmin` 200+200 satır birleştirir; kullanılmayan
  hata dışa aktarımları (`showcasePackageKindMismatch` vb.).
- **Web:** `.vitrin-card-foot form` `display: contents` (a11y ağacı notu); REJECTED
  kartta `Düzenle ve yeniden gönder` ve ghost `Kartı düzenle` aynı hedefe; hak
  bağlanmamışken de "hak yeniden kullanılabilir" bildirimi; `odeme` sayfası
  REFUNDED'ı FAILED metniyle gösterir; ödeme nedeni pasif butona `aria-describedby`
  ile bağlı değil; LIVE panel yalnız `endAt` gösterir; görselsiz kartta 16:9 medya
  alanı çok uzun; paket seçici legend'ının üst boşluğu yok; `?saved=1` metni
  daraltma kaydında kesin değil.
- **Admin:** onay öncesi GET hatasında başarı metni "revizyon"a düşer; sayfa içi
  başlıklar eski büyük harf düzeninde ("Kart İncelemeleri" vs. menü "Kart
  incelemeleri").
- **Test:** seed yardımcıları vitrin spec'lerinde üç kez tekrarlanmış; ana sayfa
  12 kart limiti gizli flake; `CATEGORY_NOT_OFFERED` / `AREA_NOT_COVERED` için onay
  üzerinden e2e yok; paket seçenek sayısı dalı veriye bağlı.
- **Ortam:** dry-run kopya DB `taktic_vitdesign002_dryrun` container'da bırakıldı;
  merge sonrası düşürülebilir.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
