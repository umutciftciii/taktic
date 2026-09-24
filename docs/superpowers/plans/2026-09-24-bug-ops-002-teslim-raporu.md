# BUG-OPS-002 — teslim raporu

Tarih: 2026-09-24 · Taban: `main@8f7e5f38` · Staging'e geçilmedi · Migration yok · Yeni env yok

## Kapanan CMP-007 bulguları

| CMP-007 bulgusu | Durum |
|---|---|
| DRAFT kampanya ENDED yapılamıyor (409); reddedilen MOBILE taslak (K2) DRAFT'ta kalıyor | **Kapandı.** `DRAFT → ENDED` geçişi eklendi; admin'de "Taslağı kapat" |
| Yabancı / var olmayan satın alım detayı HTTP 500 (error boundary) | **Kapandı.** Web `fetchOrNotFound` → `notFound()`; gerçek HTTP 404 |

CMP-007 test kayıtları (`cmp007-local-*`, K2 `cmufj36h9003lr442wk2xtamd` dahil) silinmedi, değiştirilmedi. Bu PR yerel DB'ye yazmaz.

## 1. DRAFT → ENDED

- `TRANSITIONS.DRAFT = [ENDED]` (`campaigns.service.ts`). Aynı `POST /admin/campaigns/:id/end` rotası, aynı `CAMPAIGNS_LIFECYCLE` izni, aynı `ENDED` audit eylemi. Yeni rol veya izin yok.
- Motor anahtarı ve kanal kontrolü yalnızca `to === ACTIVE` yolunda koşar; taslağı kapatma bu kontrollere hiç girmez. MOBILE taslak motor açıkken de kapalıyken de kapatılabilir.
- **Finansal etkisi yok:** yazılan tek şey `Campaign.status = ENDED` ve bir `CampaignAuditLog(ENDED)` satırı (`campaignVersionId = null`, `summary = { reason, versionNumber: null, fromStatus: 'DRAFT' }`). `activeVersionId` null kalır. CampaignVersion satırları bit bit aynı kalır; trigger event, redemption, evaluation log, promo lot, lot consumption, provider/daily counter, ledger (`ProviderCreditTransaction`) sayıları 0 kalır; worker kuyruğa hiçbir şey almaz. API testi bunu motor açıkken ve kapalıyken ayrı ayrı doğrular.
- `fromStatus` alanı artık her ENDED satırında var (ACTIVE/PAUSED da yazılır). Eski satırlarda yok; admin etiketi yoksa "Kampanya sonlandırıldı" der.
- ENDED terminal kalır: activate / pause / resume / end → 409 `CAMPAIGN_INVALID_TRANSITION` (`from: ENDED`), yeni revizyon → 409 `CAMPAIGN_ENDED`, hiçbir şey yazılmaz.
- DRAFT → ACTIVE, ACTIVE ⇄ PAUSED → ENDED davranışı değişmedi (mevcut testler aynen geçiyor; DRAFT üzerinde pause/resume hâlâ 409).
- Admin: DRAFT panelinde ayrı bir form var. Başlığı "Taslağı kapat", açıklaması "kampanyayı hiç etkinleştirmeden kalıcı olarak Sona erdi durumuna alır; hak ediş, promosyon kredisi veya olay oluşmaz". DRAFT'ta "Sonlandır" düğmesi yok. Başarı notu "Taslak kapatıldı…". Denetim izinde "Taslak kapatıldı (hiç etkinleşmedi)", ENDED panel metninde "Taslak kapatıldı: kampanya hiç etkinleşmedi" yazar. Server action `close` niyetini `/end` rotasına çevirir; kararı yine API verir.

## 2. Paket detayında 404

- API değişmedi. Kendi panelinden yabancı veya var olmayan satın alım zaten aynı 404'ü veriyordu. Başka sağlayıcının paneli `ProviderAccessGuard` ile 403, parse edilemeyen id ise 400 alıyordu. Projection genişletilmedi.
- Web: `providers/[id]/package-purchases/[purchaseId]/page.tsx` artık `fetchOrNotFound` kullanıyor. 404/403/400 `notFound()` ile uygulamanın ortak not-found ekranına, gerçek HTTP 404'e gider. 500 maskelenmez, hata olarak kalır. Hata sayfasını 200 ile gösterme yoluna gidilmedi.
- Yabancı ve bilinmeyen kayıt için gövde metni ve `main` HTML'i aynı (URL'deki id maskelenince). Paket adı, işletme adı, fiyat ya da "forbidden/not found" gibi bir ipucu yok. Error boundary console hatası da yok.
- Kendi satın alımı 200 döner. İade CTA'sı ve gate davranışı `package-refund-request` E2E'siyle regresyonsuz doğrulandı.

## 3. Testler

| Katman | Sonuç |
|---|---|
| `pnpm typecheck` | 5/5 ✓ |
| `pnpm lint` | 4/4 ✓ |
| API (`pnpm test`) | 172 dosya / 3749 test ✓ |
| Web | 43 dosya / 368 test ✓ |
| Admin | 8 dosya / 81 test ✓ |
| Shared | 6 dosya / 168 test ✓ |
| `pnpm build` | 3/3 ✓ |
| E2E Chromium (yerel, hedefli: channel, lifecycle, purchase-detail, panel-access, package-refund) | 13/13 ✓ |
| E2E WebKit (yerel, hedefli) | 9/9 ✓ |
| CI Chromium/WebKit 3/3 | PR üzerinde bekleniyor |

Yeni ya da güncellenmiş testler:
- `apps/api/test/admin-campaign-lifecycle.spec.ts`: DRAFT→ENDED (motor açık/kapalı, MOBILE taslak), sıfır finansal/olay etkisi, terminal sonrası tüm geçişler 409, erişim sözleşmesi.
- `apps/api/test/provider-package-purchase-detail.spec.ts`: kendi 200; yabancı ve bilinmeyen için status + gövde + content-type aynı ve sızıntı yok; yabancı panel 403.
- `apps/web/test/package-purchase-detail-not-found.spec.ts`: 404/403/400 → `notFound()`, 500 maskelenmez, oturumsuz yönlendirme. Düzeltme olmadan 3 test kırmızıya düştü.
- `e2e/tests/admin-campaign-channel.spec.ts`: MOBILE taslak, activate `CHANNEL_SOURCE_UNAVAILABLE`, "Taslağı kapat", ENDED ve audit görünür, console hatası yok.
- `e2e/tests/provider-package-purchase-detail.spec.ts` (WebKit testMatch'e eklendi): own 200; foreign/unknown/başka panel/`not-an-id` → 404, eşdeğer gövde, console hatası yok.
- `e2e/tests/admin-campaign-lifecycle.spec.ts`: DRAFT'ta "Sonlandır" yok, "Taslağı kapat" var; ACTIVE'de tersi.

## Dış trafik ifadesinin düzeltilmesi

CMP-007 raporundaki dış trafik ifadesi şöyle düzeltilmeli: **"iş sağlayıcısı çağrısı yok"**. Yani ödeme (Lemon Squeezy), e-posta (Resend) ve SMS sağlayıcılarına çağrı yapılmadı. Ağda görülen dış bağlantılar container açılışında `registry.npmjs.org` ve `checkpoint.prisma.io` içindi. Bunlar iş sağlayıcısı değil; "hiç dış trafik yok" demek doğru olmaz. Bu PR'ın DRAFT→ENDED yolu da hiçbir iş sağlayıcısını çağırmaz.

## Merge ön koşulu

CI'da typecheck, lint, API/web/admin testleri, build ve Chromium/WebKit E2E işleri 3/3 yeşil olmadan merge önerilmez.
