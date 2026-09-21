# CMP-004 S4 — Teslim raporu: net iade iletişimi, görünürlük, sistem audit aktörü ve kampanya motoru anahtarı

Tarih: 2026-09-22 · Branch: `claude/cmp-004-s4-net-refund-visibility-toggle` · Taban: `origin/main` @ `0e0c17fb` (PR #101 merge; temiz
worktree doğrulandı) · Tasarım notu: `docs/superpowers/specs/2026-09-22-cmp-004-s4-net-refund-visibility-toggle-design.md` · Plan:
`docs/superpowers/plans/2026-09-22-cmp-004-s4-net-refund-visibility-toggle.md` · Dry-run kaydı:
`docs/superpowers/plans/2026-09-22-cmp-004-s4-migration-g-dryrun.txt` · Bağlayıcı sözleşme: CMP-001 (rev. 3) §2.6, §10, §12.

PR: https://github.com/umutciftciii/taktic/pull/102 (açık; **merge edilmedi**) · CI: bkz. §7.

Merge, deploy, yerel/staging eşitlemesi, gerçek `.env`, Cloudflare, Lemon ayarı veya gerçek veri işlemi **yapılmadı**. Motor anahtarı
(`campaignEngineEnabled`) yalnız izole test DB'lerinde (`taktic_<slug>_test`, `taktic_e2e`) açılıp kapatıldı; yerel `taktic` DB'de `false`
kaldı. Geçici DB `taktic_cmp004_s4_dryrun` yalnız dry-run için oluşturuldu ve düşürüldü. S2B1 primitive'leri (`promo-credit-ledger.ts`
grant/consume/refund/expire/revoke), S3 revoke/auto-pause/sayaç kuralları, webhook idempotency'si ve worker lease davranışı **değişmedi**
(`promo-credit-ledger.ts`'e yalnız salt-okunur `readSpendablePromoLots` eklendi; `campaign-revoke.service.ts`'te yalnız audit satırları değişti).

---

## 1. Teslim edilen

| Katman | Dosya | İçerik |
| --- | --- | --- |
| **A · Kanonik iade sonucu** | `credits/offer-refund-settlement.ts` (yeni) | `OfferRefundSettlement { refundTransactionId, grossCredits, promoRestoredCredits, promoForfeitedCredits{expired,revoked,total}, netCredits, balanceBefore, balanceAfter }`; saf `summarizeOfferRefundSettlement(refundRow, shares)`; `readOfferRefundSettlements(db, ids)` — yalnız `OFFER_REFUND` satırı + `promoConsumptionsAsRefund` (tam FK), sezgisel/zaman sorgusu yok, iade olmayan id → yok. |
| A · Yazıcı / API | `offers/offers.service.ts` | `refundOfferCreditInTransaction` aynı tx'te forfeit satırlarını id ile okuyup `settlement` döner; manuel iade yanıtı `settlement` taşır (`balance` aynen). |
| A · E-posta | `notifications/transactional-mail.service.ts`, `templates/transactional-templates.ts` | `creditRefundedData(provider, offer, tx, settlement)`; yeni anahtarlar `promoRestoredCredits`, `promoForfeitedCredits`, `promoForfeitedExpiredCredits`, `promoForfeitedRevokedCredits`, `netCredits` (0 → null); `previousBalance/currentBalance` settlement'tan. Şablon: Y>0 iken `Geri alınan promosyon kredisi −Y`, `Net değişim +Z`, konu `net +Z kredi`, açıklama notu; R>0 iken "R kredisi promosyon kredisi olarak geri döndü". Retry yolu aynı okuyucu; `dedupeKey` değişmedi. |
| A · Web | `providers/providers.service.ts`, `apps/web/lib/{api,formatters}.ts`, `offers/offers-table.tsx`, `offers/[offerId]/page.tsx`, `credits/page.tsx` | `creditRefundSettlement` (liste + detay, tek toplu sorgu); `refundSettlementSummary` → `+X iade` / `+X iade · −Y promosyon geri alındı · net +Z` + neden; `creditTxnTypeLabel` + `creditReasonLabel` (kod yerine Türkçe). |
| **B · Admin ledger** | `finance/finance.service.ts`, `apps/admin/lib/{api,finance-format}.ts`, `finance/credit-ledger/page.tsx`, `providers/[id]/credits/transactions-panel.tsx` | `items[].campaign {id,name,versionNumber}` (3 referans türü için toplu lookup, diğerlerinde null); üç `CAMPAIGN_*` etiket + rozet (GRANT yeşil / EXPIRE nötr / REVOKE kırmızı) + tür filtresi; reason kuyrukları etikete katlanır; "Kampanya · ad · sürüm N" → `/campaigns/<id>`; sağlayıcı kredi panelinde "Promosyon" filtresi + aynı etiketler. |
| **C · Sağlayıcı promo** | `credits/promo-credit-ledger.ts` (+`readSpendablePromoLots`), `credits/credits.service.ts`, web `credits/page.tsx`, `globals.css` | `GET /providers/:id/credits.promo = { spendableCredits, lots[{id, remainingCredits, expiresAt, campaignName}] }` (spend predicate + sıra); kredi sayfasında yalnız lot varken görünen blok (`data-testid=promo-credits`). |
| **D · Migration G** | `prisma/migrations/20260922120000_campaign_audit_system_actor/`, `schema.prisma`, `campaign-revoke.service.ts`, `campaigns.service.ts`, admin `campaigns/[id]/page.tsx`, `lib/api.ts` | `actorId DROP NOT NULL` + CHECK `CampaignAuditLog_system_actor_marked`; `actor User? … onDelete: Restrict` (açık); webhook revoke → `REDEMPTION_REVOKED` SYSTEM audit, `AUTO_PAUSED` `actorId=null`; `CampaignAuditView.actor: ActorView \| null`; UI "Sistem (ödeme iadesi)". |
| **E · Motor anahtarı** | `operations-settings/campaign-engine-settings.{service,controller}.ts`, `operations-settings.module.ts`, admin `operations-settings/{page,actions,campaign-engine-toggle}.tsx`, `campaigns/engine-notice.tsx`, `campaigns/[id]/page.tsx`, `globals.css` | `GET/PUT /operations-settings/campaign-engine` (SUPER_ADMIN); `#kampanya-motoru` kartı: durum pili, etki metni, zorunlu onay kutusu + "Motoru aç/kapat", son değişiklikler; kampanya ekranları karta bağlanır. |
| Testler | §5 | API +5 spec/+27 test, güncellenen 4 spec; web +1 spec (6); admin +1 spec (5); E2E +2 spec (Chromium + WebKit). |

## 2. Net iade muhasebe tablosu (testle kanıtlı — `offer-refund-settlement.spec.ts`)

| Durum | Ledger | `settlement` | E-posta verisi | Test |
| --- | --- | --- | --- | --- |
| Promosuz (maliyet 3, ücretli 10) | `ADMIN_GRANT +10`, `OFFER_SPEND −3`, `OFFER_REFUND +3` | gross 3, restored 0, forfeited 0/0/0, net 3, before 7, after 10 | `refundedCredits '3', previousBalance '7', currentBalance '10'`; promo anahtarları **null** → şablon satır yazmaz; konu `Krediniz iade edildi — 3 kredi` (render spec: `— 2 kredi` fixture'ı bire bir) | #3, render #1 |
| Tam promo (lot 3 geçerli, maliyet 5 = 3 promo + 2 ücretli) | `OFFER_REFUND +5` | gross 5, restored 3, forfeited 0, net 5, after 5 | net satırı yok; "3 kredisi promosyon olarak geri döndü" notu | #4, render #3 |
| Lot süresi dolmuş (sweep sonrası) | `OFFER_REFUND +5`, `CAMPAIGN_EXPIRE −3` | gross 5, forfeited {expired 3}, net 2, before 0, after 2 | `refundedCredits '5', promoForfeitedCredits '3', promoForfeitedExpiredCredits '3', netCredits '2', currentBalance '2'`; konu `— net +2 kredi`; "süresi dolduğu için … eksi bakiye oluşmadı" | #5, render #2 |
| Lot revoke edilmiş | `OFFER_REFUND +5`, `CAMPAIGN_REVOKE −3` | forfeited {revoked 3}, net 2 | "geri alındığı için" | #6, render #3 |
| Duplicate iade | ek satır yok (409) | değişmez | tek `credit-refunded` | #7 |
| İade olmayan id | — | reader `Map.size 0` | — | #8 |

Her senaryoda API yanıtı `settlement` ≡ `readOfferRefundSettlements` (`toEqual`) ve `walletInvariant` (`Σ amount = son balanceAfter`,
`paid ≥ 0`). Sağlayıcı teklif listesi/detayı aynı nesneyi taşır; müşteri görünümünde anahtar yok, "promo" geçmez (#9).
**Promosuz davranış korunur:** `promo-credit-ledger.spec` "byte-for-byte" bekçileri (worker + manuel) ve `unviewed-offer-refund.spec`,
`request-removal-refund.spec` değişmeden geçer; render spec'in mevcut `credit-refunded` fixture'ı promosyon metni içermez.

## 3. `actorId` nullable gerekçesi (Migration G)

S3, `CampaignAuditLog.actorId NOT NULL` ve "ALTER COLUMN yasak" kuralı yüzünden webhook kaynaklı `AUTO_PAUSED` satırına **nominal** aktör
(`campaign.createdById`) yazıyordu (S3 D9). Bu, kampanya yaratıcısını sistem aksiyonunun faili gibi gösteriyordu. S4'ün bilinçli tek `ALTER
COLUMN`'ı bunu kaldırır:

```sql
ALTER TABLE "CampaignAuditLog" ALTER COLUMN "actorId" DROP NOT NULL;
ALTER TABLE "CampaignAuditLog" ADD CONSTRAINT "CampaignAuditLog_system_actor_marked"
  CHECK ("actorId" IS NOT NULL OR COALESCE("summary" ->> 'actorKind', '') = 'SYSTEM');
```

- CHECK, `actorId` NULL olan her satırın `summary.actorKind='SYSTEM'` taşımasını zorunlu kılar (`COALESCE`: `summary` NULL ya da anahtarsızsa
  da reddedilir — ilk taslakta bu eksikti, şema testi yakaladı). Admin yolları aktörü **oturumdan** alır (controller `user.id` yoksa 403),
  payload'dan asla; dolayısıyla "sistem görünümü" elle üretilemez.
- FK `onDelete: Restrict` şemada açıkça yazıldı: opsiyonel ilişkide Prisma varsayılanı SetNull'dur ve `migrate diff` bunu FK farkı olarak
  raporlar; DB'deki FK değişmedi.
- Backfill/DML yok; S3 döneminden nominal aktörlü satır gerçek DB'lerde yoktur (motor hiç açılmadı), olsa da UI `summary.actorKind==='SYSTEM'`
  ile yine "Sistem" gösterir.
- Ek kayıt: webhook kaynaklı revoke artık `REDEMPTION_REVOKED{actorKind:'SYSTEM', source:'PAYMENT_REVERSED', redemptionId, versionNumber,
  revokedCredits, spentAtRevoke, revokeCountToday, autoPaused}` yazar (S3'te yalnız eşik aşımında `AUTO_PAUSED` vardı). Para hareketi
  değişmez; `campaign-refund-revoke.spec` sayımları buna göre güncellendi (duplicate/yarış teslimlerinde yine tek satır).
- Dry-run (`…-migration-g-dryrun.txt`): geçici DB'de `migrate deploy` 72 ✓, `migrate diff` "No difference detected", `actorId is_nullable=YES`,
  CHECK tanımı kayıtta; DB düşürüldü.

## 4. Motor anahtarı güvenlik / işlem matrisi

| Durum | Sonuç | Test |
| --- | --- | --- |
| Varsayılan (satır yok) | `GET → {enabled:false, recentChanges:[]}`; DB'de satır yok | settings #1 |
| Anon GET/PUT | 401 | #2 |
| CUSTOMER / PROVIDER GET/PUT | 403; yazım/audit yok | #2 |
| `enabled` boolean değil / eksik | 400; yazım yok | #3 |
| İlk açma | `campaignEngineEnabled=true`, `OperationsSettingsChange{previous:null, new:'true', changedBy:admin}` | #4 |
| Aynı değere tekrar PUT | yazım yok, audit sayısı aynı | #4 |
| Kapatma | `{previous:'true', new:'false'}` zincir | #4 |
| Satır yokken kapatma | no-op, satır oluşmaz | #4 |
| Diğer ayarlar | `unviewedOfferRefundWindowHours`, scheduler bayrakları, auto-publish dokunulmaz | #5 |
| 6 eşzamanlı PUT (T/F/T/T/F/T) | hepsi 200; audit zinciri sıralı (her `previousValue` = önceki `newValue`, ilki null, ardışık eşit yok); son durum = son audit | #6 (`runSerializable`) |
| Kapalı → onay → açık → kapalı | UI: onaysız submit form'dan çıkmaz (`required` + action `confirm==='yes'` kontrolü), durum/DB/audit değişmez; onaylı → `ok=campaign-engine-on`, pil "Açık", tablo satırı; kampanya listesi `data-engine=on`; kapatma → 2. satır | E2E toggle #1 (Chromium+WebKit) |
| Sağlayıcı oturumu `/operations-settings` | `/login`'e; kart yok; anahtar açılmaz | E2E toggle #2 |
| Motor kapalı: gerçek onay | event yazılmaz | settings #7 |
| Açılış | geçmiş onay için event üretilmez; sonraki onay → 1 PENDING event → worker `SETTLED` → 1 redemption + 1 `CAMPAIGN_GRANT` | #7 |
| Tekrar kapalı | `engineWriteSnapshot` eşit, worker `skipped: ENGINE_DISABLED` | #7 |
| Açık + aktif kampanya yok (DRAFT) | event `EVALUATED`, redemption/lot/grant 0 | #8 |
| Kapalıyken paket iadesi | eski lot revoke edilir (`CAMPAIGN_REVOKE`), worker yeni hak ediş üretmez | `campaign-refund-revoke.spec` #4 (S3, korunur) |
| Açıkken pause/end/revoke | S3 spec'leri değişmeden geçer | `campaign-refund-revoke`, `admin-campaign-operations`, `admin-campaign-lifecycle` |

## 5. Veri sızıntısı ve yetki testleri

| Yüzey | Kontrol | Test |
| --- | --- | --- |
| `GET /providers/:id/credits` | anon 401; CUSTOMER 403; başka PROVIDER 403 (kendi görünümü boş promo); SUPER_ADMIN 200; JSON'da `definition/rulesSnapshot/conditions/limits/maxRedemptions/redemptionId/campaignId/key` yok; expired/unswept/revoked/exhausted lot dışarıda, sıra en yakın son kullanma | `provider-promo-visibility.spec` #1–#4 |
| Sağlayıcı teklif listesi/detayı | yalnız iade edilmiş teklifte `creditRefundSettlement`; müşteri `GET /service-requests/:id/offers` anahtarsız, "promo" geçmez | `offer-refund-settlement.spec` #9 |
| Admin ledger | SUPER_ADMIN dışı 401/403; `revokeNote` (`GIZLI-NOT`), `rulesSnapshot`, `definition` yok; bilinmeyen tür 400; eski filtre/pagination | `finance-credit-ledger-campaign.spec` #2–#4 |
| Audit JSON | `LEMON_BUYER_EMAIL`/isim/referans/secret yok (SYSTEM satırları dahil) | `campaign-refund-revoke.spec` "stores no buyer detail" + eşik testi |
| E-posta | `UNVIEWED_OFFER_48H` kodu yok; "borç" kelimesi yok | events spec (mevcut), render #2 |
| Web E2E | sağlayıcı sayfasında başka işletmenin adı/kampanya adı yok; başka sağlayıcı kimliğiyle sayfa 404 ve blok yok; HTML'de `PROMO_LOT_EXPIRED`/`CAMPAIGN_GRANT` kodu yok | `provider-promo-credits` |
| Admin E2E | sağlayıcı oturumu `/login`; ekran HTML'inde sağlayıcı e-posta/telefon yok (S3 spec korunur) | `admin-campaign-engine-toggle` #2, `admin-campaign-operations` #1 |

## 6. Değişen dosyalar

48 dosya, +2896/−170 (`git diff --stat origin/main...HEAD`). Şema: `prisma/schema.prisma` (CampaignAuditLog), 1 migration. API: 11 kaynak
(+3 yeni: `offer-refund-settlement.ts`, `campaign-engine-settings.service.ts`, `campaign-engine-settings.controller.ts`), 7 spec (+5 yeni). Web:
6 dosya + 1 spec. Admin: 9 dosya (+1 yeni `campaign-engine-toggle.tsx`) + 1 spec. E2E: `campaign-fixtures.ts` (yeni, `admin-campaign-operations`'tan
çıkarıldı), 2 yeni spec, `playwright.config.ts` WebKit `testMatch`. Docs: tasarım, plan, dry-run, bu rapor.

## 7. Kalite kapıları

| Kapı | Sonuç |
| --- | --- |
| `pnpm typecheck` | 5/5 ✓ |
| `pnpm lint` | 4/4 ✓ |
| `pnpm build` | 3/3 ✓ |
| API `vitest run` (tam) | 151 dosya / **3317** test ✓ (yeni 27 + güncellenen spec'ler) |
| web / admin / shared | 344 / 71 / 168 ✓ |
| E2E Chromium (`provider-promo-credits`, `admin-campaign-engine-toggle`, `admin-campaign-operations`) | 5/5 ✓ — 320/768/1024/1440 taşma yok; ekran görüntüleri `e2e/.artifacts/{provider-promo-credits,admin-campaign-engine-toggle}/` |
| E2E WebKit (`e2e:webkit`, aynı filtre, taze DB) | 5/5 ✓ |
| Migration G dry-run | geçici DB: `migrate deploy` 72 ✓, `migrate diff` boş, CHECK/FK kayıtta; DB düşürüldü |
| RED→GREEN | her dilimde önce kırmızı görüldü: settlement (modül yok → 8 ✗), e-posta (5 ✗), provider projection (1 ✗), ledger (2 ✗), promo (3 ✗), Migration G (6 ✗; ilk CHECK NULL summary'yi geçirdi → COALESCE), toggle (8 ✗ 404), web etiketleri (5 ✗), admin format (5 ✗), E2E promo (unique key → fixture düzeltildi) |
| CI (GitHub Actions run 35666624866, head `a237c602`) | **3/3 yeşil** — typecheck·lint·test·build, e2e (chromium), e2e (webkit) |

## 8. S4 sonrası kampanya açılışına kalan kontrollü staging adımları

1. **Merge + yerel eşitleme** (istenirse): ana checkout ff-pull → dump (`~/Backups/taktic-pre-cmp-004-s4-*`) → `compose run --rm --no-deps api sh -lc "corepack enable; pnpm exec prisma migrate deploy"` (DB 71→72, Migration G) → api/web/admin force-recreate → `campaignEngineEnabled=false` doğrula, `CampaignAuditLog` CHECK'i `pg_constraint`'ten oku.
2. **Staging şema**: aynı migration; `OperationsSettingsChange`'de `campaignEngineEnabled` satırı olmadığını ve motorun kapalı olduğunu doğrula.
3. **Staging kabul (motor kapalı)**: promosuz teklif iadesi e-postası (Apple Mail/Outlook/Gmail) — metin S3 öncesiyle aynı; admin ledger'da eski satırlar; sağlayıcı kredi sayfasında promo bloğu **yok**.
4. **Kampanya hazırlığı**: DRAFT kampanya + sürüm (DSL, `maxRevokesPerDay` eşiği, bütçe); fact-writer kaydı (`FactSourceRegistry`) canlı; `CAMPAIGN_EVALUATION_RETRY_CRON` ve `promo-credit-lot-expiry` sweeper zamanlaması onaylı.
5. **Motoru aç** (yalnız SUPER_ADMIN, Operasyon Ayarları `#kampanya-motoru`, onay kutusu): audit satırı ve kampanya listesinde `data-engine=on` doğrula. Aktif kampanya olmadan worker'ın grant üretmediğini (`EVALUATED`) gözle.
6. **Kampanyayı etkinleştir** (aktivasyon kapısı: fact source, limit, pencere); ilk gerçek hak edişte: `CAMPAIGN_GRANT` ledger satırı + kampanya adı (admin), sağlayıcı promo bloğu, sonra bir teklif + iade ile net iade e-postası ve web satırı.
7. **Geri dönüş**: motoru kapat (yeni hak ediş durur; S3 revoke sürer); gerekirse kampanyayı `PAUSED/ENDED`; lot/ledger dokunulmaz.

## 9. Kapsam dışı / bilinen ödünler

- Sağlayıcıya expired/revoked lot geçmişi listesi (yalnız ledger satırları); `CampaignAuditLog.actorKind` ayrı kolon (summary + CHECK yeterli).
- Ücretli kredinin paket iadesinde geri alınması (bayrak + insan kararı; değişmedi).
- Toggle UI'ında API düzeyinde ikinci onay alanı yok; onay kutusu UI kuralıdır, API sözleşmesi diğer switch'lerle aynı (`{enabled}`).
- Yerel Docker eşitlemesi ve DB 71→72 merge sonrası; bu PR'da yapılmadı.
