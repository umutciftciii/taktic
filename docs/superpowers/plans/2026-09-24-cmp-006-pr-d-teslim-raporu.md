# CMP-006 PR-D — Kampanya kanal hedeflemesi: teslim raporu

Taban: `main@6ac194dd`. Tasarım kaynağı: `docs/superpowers/specs/2026-09-22-cmp-006-s0-refund-rbac-fraud-channel-design.md`
§8 (D23–D26, I1–I7). Migration: **L** `20260924150000_add_campaign_channel`.

## 1. Kod öncesi envanter (main@6ac194dd, dosya:satır)

| Konu | Yer | Bulgu |
| --- | --- | --- |
| Sürüm satırı | `prisma/schema.prisma:4083` `CampaignVersion` | Değişmez anlık görüntü; kanal alanı yok |
| Olay satırı | `prisma/schema.prisma:4224` `CampaignTriggerEvent` | `triggerEventKey @unique`; kanal alanı yok |
| Olay anahtarı | `apps/api/src/modules/campaigns/engine/trigger-event-key.ts:38` | Üç biçim; kanal yok — **bu PR'da dosyaya dokunulmadı** |
| Bekleyen olay yazımı | `engine/campaign-engine.repository.ts` `ensurePendingEvent` | create + (varsa) `lastSeenAt`/reopen update |
| Hook'lar | `engine/campaign-engine.hooks.ts` `providerApproved` / `accountFactProven` / `packagePaymentSucceeded` | Kanal bilgisi yok |
| Motor boru hattı | `engine/campaign-engine.service.ts:243` civarı (4. adım: pencere → koşullar) | Kanal filtresi yok |
| Aktivasyon kapısı | `campaigns.service.ts:759` `judgeActivation` + `FactSourceRegistry.hasProviderWriter` | `FACT_SOURCE_UNAVAILABLE` örneği |
| Checkout | `payments/payments.controller.ts:65` → `payments.service.ts:96` → `package-purchases.service.ts:92` | Satın almada kanal yok; `readRequestMeta().sourceChannel` yalnız istemci beyanı (`x-taktic-client-channel`), yalnız `PurchaseTermsAcceptance`'a yazılıyor |
| Mock satın alma | `package-purchases.controller.ts:25` | Sağlayıcı ya da operatör (ProviderAccessGuard) açabilir |
| Başvuru | `providers.controller.ts:34` (`POST /providers`), `provider-invites.controller.ts:49` → `providers.service.ts:331` `createApplicationRecord` | Kanal yok |
| Onay | `providers.service.ts:1084` `campaignHooks.providerApproved` | İstek **operatörün** isteği |
| E-posta kanıtı | `auth/email-verification.controller.ts:48` → `email-verification.service.ts:183` | Tek çağıran |
| Telefon kanıtı | `phone-verification/provider-phone-verification.controller.ts:46` → `phone-verification.service.ts:435` | Tek çağıran |
| Ödeme webhook'u | `payments-webhook.service.ts:572/630` | Asenkron; kendi kanalı yok |

## 2. Kanal kaynak matrisi

| Tetikleyici | Kanal nereden türer (sunucu) | Kanonik kolon | WEB ne zaman | UNKNOWN ne zaman |
| --- | --- | --- | --- | --- |
| `PACKAGE_PAYMENT_SUCCEEDED` | Satın alma satırı; hook satırı kendisi okur (`campaign-engine.hooks.ts` `packagePaymentSucceeded`) | `PackagePurchase.sourceChannel` | Sağlayıcı hesabının kendisi checkout (`POST /providers/:id/checkout-sessions`) veya paket satın alma rotasından açtıysa | Operatörün işletme adına açtığı satın alma; bu migration'dan önceki tüm satırlar |
| `PROVIDER_APPROVED` | Başvurunun kanalı; hook profili kendisi okur (`providerApproved`) | `ProviderProfile.applicationSourceChannel` | Misafir veya sağlayıcı hesabı `POST /providers` ya da davet başvurusu rotasından başvurduysa | Operatörün doldurduğu başvuru; eski profiller |
| `PROVIDER_ELIGIBILITY_REACHED` | Kümeyi **tamamlayan son kanıtın** kanalı | `CampaignTriggerEvent.sourceChannel` (hook çağrısında verilir) | Son kanıt e-posta onay rotası veya sağlayıcı OTP rotası ise; son kanıt onaysa başvuru WEB ise | Son kanıt onay ve başvuru UNKNOWN ise; eski olaylar |

Kural: kanal **rotadan** türer, istekten değil. `apps/api/src/common/web-surface-channel.ts` → `WEB_SURFACE_CHANNEL`
yalnız web uygulamasının kendi rotalarından (checkout, paket satın alma, başvuru, davet başvurusu, e-posta onayı,
OTP onayı) servis katmanına verilir. Hiçbir header/query/body kanal belirlemez; testler `x-taktic-client-channel:
mobile` gönderilse bile satırın `WEB` kaldığını doğrular. Servis parametreleri varsayılan `UNKNOWN`'dır: kanıt
veremeyen her çağıran dürüstçe UNKNOWN yazar. `readRequestMeta().sourceChannel` (istemci etiketi) yalnız
`PurchaseTermsAcceptance`'ta kalır; davranışı değişmedi.

Mobil istemci yok → hiçbir yol `MOBILE` üretmez, sahte header ile de üretilemez.

## 3. Eşleşme kuralı ve UNKNOWN fail-closed gerekçesi

Saf fonksiyon: `engine/campaign-channel.ts` `matchChannel(target, source)`; motor 4. adımda pencereden sonra,
koşullardan önce uygular (`campaign-engine.service.ts:280`).

| Sürüm | WEB olay | MOBILE olay | UNKNOWN olay |
| --- | --- | --- | --- |
| `ALL` | eşleşir | eşleşir | eşleşir |
| `WEB` | eşleşir | `CHANNEL_MISMATCH` / `SOURCE_MOBILE` | `CHANNEL_MISMATCH` / `SOURCE_UNKNOWN` |
| `MOBILE` | `CHANNEL_MISMATCH` / `SOURCE_WEB` | eşleşir | `CHANNEL_MISMATCH` / `SOURCE_UNKNOWN` |

**Neden UNKNOWN fail-closed:** Kanal ayrımı yapan bir sürüm, kaynağını kimsenin doğrulayamadığı olaya hak ediş
veremez. UNKNOWN; migration öncesi olaylar, operatörün işletme adına açtığı satın alma/başvuru ve kanal
bildiremeyen her yol demektir. Bunları WEB saymak, "nereden geldiğini söylemeyen" her şeye WEB'e özel promosyonu
dağıtmak olur. `ALL` ise "kanal koşulu yok" demektir ve UNKNOWN dahil her şeyle eşleşir; bugünkü her sürüm ALL,
bugünkü her olay UNKNOWN olduğundan mevcut hiçbir senaryonun sonucu değişmez (I4).

Uyumsuzluk hata/retry değildir: aday `CHANNEL_MISMATCH` (neden kodu `SOURCE_<kanal>`) ile loglanır, olay
`EVALUATED` biter, hiçbir sayaç/bütçe/limit tüketilmez. Stack sıralaması, limitler, bütçe, event idempotency,
`(campaignId, triggerEventKey)` unique'i ve worker lease davranışı değişmedi; kanal yalnız aday **elemesidir**.

## 4. Olay anahtarına kanal eklenmedi (I1–I3)

- `trigger-event-key.ts` bu PR'da **değişmedi** (`git diff 6ac194dd -- …/trigger-event-key.ts` boş). Test üç
  biçimi aynen doğrular.
- `CampaignTriggerEvent.sourceChannel` yalnız `create` yolunda yazılır (`ensurePendingEvent`,
  `ensureTriggerEvent`); update yolları alanı adlandırmaz.
- Veritabanı da korur: `CampaignTriggerEvent_source_channel_immutable` tetikleyicisi farklı değerle UPDATE'i
  reddeder. Aynı tetikleyici `CampaignVersion.channel`, `PackagePurchase.sourceChannel` ve
  `ProviderProfile.applicationSourceChannel` için de bağlıdır.
- Test: aynı anahtar MOBILE ve UNKNOWN ile yeniden raise edilir → tek satır, kanal WEB kalır, ikinci redemption
  ve ikinci `CAMPAIGN_GRANT` yok.

## 5. MOBILE aktivasyon kapısı

- `FactSourceRegistry.registerChannel(source, channel, producer)` / `hasChannelProducer` —
  `FACT_SOURCE_UNAVAILABLE` ile aynı sözleşme. Boot'ta kayıtlar: `providers` (PROVIDER_APPROVED/WEB),
  `package-purchases` (PACKAGE_PAYMENT_SUCCEEDED/WEB), `email-verification` (EMAIL_VERIFIED/WEB),
  `phone-verification` (PHONE_VERIFIED/WEB). **MOBILE kaydeden modül yok**; UNKNOWN kaydedilemez (hata atar).
- `judgeActivation` 3b adımı: WEB/MOBILE hedefli sürümün olay kaynaklarının (tetikleyici ya da uygunluk kümesinin
  olguları) her biri için o kanalın üreticisi yoksa 400 `CAMPAIGN_ACTIVATION_REFUSED` +
  `{ path: 'channel', code: 'CHANNEL_SOURCE_UNAVAILABLE' }`; işlem geri alınır, **sıfır yazı** (test snapshot eşitliği).
- WEB ve ALL mevcut web kaynaklarıyla etkinleşir (API testi + E2E). Motor anahtarı kapalıyken aktivasyon zaten
  `CAMPAIGN_ENGINE_DISABLED` ile reddedilir; testler anahtarı yalnız test DB'sinde açar.
- Admin detay yanıtı `currentVersionChannel` / `activeVersionChannel` (`available`, `missingSources`) taşır;
  panel yalnız yansıtır: uyarı + devre dışı buton. Zorla gönderimde API reddi ekranda görünür (E2E).
- Yeni public endpoint yok; kanal yalnız mevcut admin rotalarında (`/admin/campaigns*`) okunur/yazılır.

## 6. Migration L ve dry-run

`prisma/migrations/20260924150000_add_campaign_channel/migration.sql`: `CampaignChannel` enum;
`CampaignEvaluationOutcome += CHANNEL_MISMATCH`; dört `ADD COLUMN … NOT NULL DEFAULT`; bir tetikleyici
fonksiyonu + dört `BEFORE UPDATE OF <kolon>` tetikleyicisi. **DML/backfill/DROP/ALTER COLUMN yok.**

İzole dry-run (`docs/superpowers/plans/2026-09-24-cmp-006-pr-d-migration-l-dryrun.txt`): main'in 77 migration'ı →
eski sağlayıcı/satın alma/kanalsız sürüm/olay → Migration L → `migrate diff` boş (drift yok) → 78 migration.
Eski sürüm `channel=ALL`, eski olay/satın alma/profil `UNKNOWN`; sürümün `definition` JSON md5'i ve olay
anahtarı değişmedi; dört tetikleyici farklı değeri reddetti, aynı değer ve diğer kolonlar serbest; DB silindi.

**Mevcut sürümler ALL olarak taşındı:** kolon varsayılanı ile (DML değil); validator kanalı olmayan eski
`definition`'ı `ALL`'a normalleştirir, böylece kolon ile JSON tutarlıdır.

## 7. Admin UI

- Builder: "Kanal" alanı (Web / Mobil / Tümü, varsayılan Tümü); Mobil seçilince uyarı; sonuç panelinde kanal.
- Liste: "Kanal" sütunu (çalışan, yoksa son sürüm). Detay: tanımda kanal rozeti, sürüm geçmişinde kanal sütunu,
  denetim izinde `kanal: …` (VERSION_CREATED/VERSION_ACTIVATED özetinde `channel`), değerlendirme kuyruğunda
  olayın kaynak kanalı.
- ACTIVE sürümde kanal yerinde değişmez; revizyon yeni sürüm üretir ve `changedFields` `channel` içerir.

## 8. Değişmeyenler

`campaignEngineEnabled=false` (hiçbir kod açmaz), `PURCHASE_TERMS_GATE` kapalı, fraud uygunluk kuralları, HMAC
fingerprint, işletme kayıt modeli, iade yaşam döngüsü, Lemon/webhook mutabakatı ve kredi ledger davranışı
değişmedi. Kanal kolonları hiçbir satın alma veya sağlayıcı projeksiyonunda dönmez (`packagePurchaseOmit`,
`toProviderRecord`). Staging, gerçek `.env`, gerçek Lemon, e-posta/SMS ve gerçek veriye dokunulmadı.

## 9. Doğrulama

Yerel (worktree, izole test DB'leri):

| Kontrol | Sonuç |
| --- | --- |
| `pnpm typecheck` / `pnpm lint` | 5/5, 4/4 başarılı |
| API tam paket (`vitest run`) | 171 dosya / 3743 test yeşil (yeni `campaign-channel.spec.ts` 31 test dahil) |
| Admin / web / shared | 81 / 363 / 168 test yeşil |
| `pnpm build` | 3/3 başarılı |
| E2E Chromium `admin-campaign*` | 8/8 (yeni `admin-campaign-channel.spec.ts` dahil) |
| E2E Chromium satın alma/promosyon/iade/başvuru/kanıt/davet | 20/20 |
| E2E WebKit `admin-campaign*` | 8/8 (kanal spec'i WebKit listesine eklendi) |

Yeni API testleri (`apps/api/test/campaign-channel.spec.ts`): 9'luk eşleşme matrisi; anahtarın üç biçimi;
kayıtlı üreticiler (WEB var, MOBILE yok, UNKNOWN kaydedilemez); Lemon checkout + webhook → WEB (header `mobile`
yok sayılır); paket satın alma sağlayıcı → WEB, operatör → UNKNOWN; başvuru misafir → WEB, operatör → UNKNOWN,
onay devralır; e-posta/telefon kümeyi tamamlarsa WEB, onay tamamlarsa başvurunun kanalı; UNKNOWN olay WEB/MOBILE
sürümde `CHANNEL_MISMATCH`, olay `EVALUATED`, sıfır sayaç/ledger; ALL aynı olayda grant; WEB olayda stack sırası
aynen; bütçe reddi kanal geçtikten sonra aynen; aynı anahtar farklı kanalla yeniden raise → tek olay, tek grant;
DB tetikleyicileri; MOBILE aktivasyonu `CHANNEL_SOURCE_UNAVAILABLE` + snapshot eşitliği (sıfır yazı); WEB/ALL
aktivasyonu + audit `channel`; revizyonda `changedFields: ['channel']`, `CHANNEL_INVALID`; operasyon masasında
kaynak kanal; motor kapalıyken kampanya tarafında sıfır satır.

CI (Chromium, WebKit ve API/birim işleri): PR üzerinde 3/3 yeşil görülmeden merge önerilmez.
