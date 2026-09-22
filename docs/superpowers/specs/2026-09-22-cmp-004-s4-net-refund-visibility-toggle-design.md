# CMP-004 S4 — Net iade iletişimi, görünürlük, sistem audit aktörü ve kampanya motoru anahtarı

Tarih: 2026-09-22 · Taban: `origin/main` @ `0e0c17fb` (PR #101 merge, temiz worktree doğrulandı) ·
Branch: `claude/cmp-004-s4-net-refund-visibility-toggle` · Bağlayıcı sözleşme: CMP-001 (rev. 3) §2.6, §10, §12 ·
Önceki dilimler: S2B1 (`2026-09-20-cmp-002-s2b1-promo-credit-accounting-design.md`), S2B2
(`2026-09-21-cmp-002-s2b2-lifecycle-hooks-design.md`), S3 (`2026-09-21-cmp-003-s3-refund-revoke-design.md`).

Bu dilim kampanya sistemini **operatör ve sağlayıcı için anlaşılır** kılar ve motorun **kontrollü** açılıp kapatılabileceği
yüzeyi ekler. Para kuralları değişmez: S2B1 primitive'leri, S3 revoke/auto-pause, webhook idempotency'si ve worker lease
davranışı bire bir korunur. Bu PR merge edilse bile `campaignEngineEnabled` kendiliğinden `true` olmaz; yerel/staging
DB'de anahtar açılmaz.

---

## 1. Kararlar (gerekçeli)

| # | Karar | Gerekçe |
| --- | --- | --- |
| D1 | **Kanonik iade sonucu = `OfferRefundSettlement`**, tek saf fonksiyondan (`summarizeOfferRefundSettlement`) üretilir ve iki yerden beslenir: (a) `refundOfferCreditInTransaction` yazdığı satırlardan (S2B1 `PromoRefundOutcome`) aynı tx içinde; (b) sonradan okuyanlar için `readOfferRefundSettlements(prisma, refundTransactionIds)` — `OFFER_REFUND` satırı + `PromoCreditLotConsumption.refundTransactionId = refund.id` olan payların `refundedCredits/forfeitedCredits/forfeitTransaction.balanceAfter/lot.status` alanları. Şekil: `{ refundTransactionId, grossCredits, promoRestoredCredits, promoForfeitedCredits: { expired, revoked, total }, netCredits, balanceBefore, balanceAfter }`; `netCredits = gross − forfeited.total`, `balanceAfter` = son forfeit satırının `balanceAfter`'ı ya da (forfeit yoksa) iade satırınınki. | Görev tanımı A: "tek kaynak; e-posta/web sonradan ledger sorgulayıp belirsiz hesap yapmasın." Okuma **tam FK bağıyla** (`refundTransactionId`, `forfeitTransactionId`) yapılır, sezgisel/zaman aralığı sorgusu yoktur; yeni tablo/kolon eklenmez (denormalize ikinci bir "gerçek" oluşturmamak için). Test: aynı iade için (a) ve (b) `toEqual`. |
| D2 | **Promosuz iade bire bir korunur.** `forfeited.total === 0 && restored === 0` iken e-posta verisi (`creditRefundedData`) ve şablon çıktısı bugünkü ile aynı alan/satır kümesini üretir (`refundedCredits`, `previousBalance`, `currentBalance` aynı değerler; yeni alanlar `null`). Web teklif satırı/detayı da aynı metni gösterir. | Görev tanımı A ve zorunlu test 1. Şablonda yeni satırlar yalnız ilgili değer `> 0` iken `compact()` ile eklenir. |
| D3 | **Promo içeren iade metni:** e-posta tablosu `İade edilen: X`, `Geri alınan promosyon kredisi: −Y` (yalnız Y>0), `Net değişim: +Z` (yalnız Y>0), `Önceki bakiye`, `Güncel bakiye` (= `settlement.balanceAfter`, forfeit sonrası gerçek bakiye). Konu/başlık: Y>0 iken `Krediniz iade edildi · net +Z kredi` / `X kredi iade edildi`; Y=0 iken bugünkü. Not satırı Y>0: "Y promosyon kredisi, ait olduğu kampanyanın süresi dolduğu (ya da promosyon geri alındığı) için bakiyenize dönmedi; ücretli bakiyenizden düşülmedi, borç oluşmadı." Geri dönen promo (`restored > 0`) için tek bilgi satırı: "Bunun R kredisi promosyon kredisi olarak geri döndü; son kullanma tarihi değişmedi." | Görev tanımı A: net değişim açık, negatif/boş satır yok, "borç/ücretli bakiye" izlenimi yok. |
| D4 | **Web sağlayıcı yüzeyi:** `listProviderOffers` / `getProviderOffer` projeksiyonuna `creditRefundSettlement: OfferRefundSettlement \| null` eklenir (yalnız iade edilmiş teklifte dolu; D1(b) ile tek toplu sorgu). Teklif listesi "Kredi" hücresi ve detay "Kredi ve İade" kartı Y>0 iken `+X iade · −Y promosyon geri alındı · net +Z` gösterir; Y=0 iken bugünkü metin. Sağlayıcı kredi geçmişinde `CAMPAIGN_*` türleri ve `PROMO_*` reason kodları Türkçe etiketle görünür (ham kod değil). | Görev tanımı A "sağlayıcı web yüzeyindeki refund/offer geçmişi aynı kanonik sonucu kullansın". |
| D5 | **Bildirim idempotency'si değişmez:** `credit-refunded` `dedupeKey = credit-refunded:<refundTransactionId>`; e-posta verisi iade satırından ve ona bağlı paylardan okunur — ikinci gönderim aynı veriyi üretir, ikinci iade zaten 409/unique index'e takılır. `RETRY_SOURCE_ID_COUNT` aynı. | Görev tanımı A son madde. |
| D6 | **Admin ledger:** `FinanceService.listCreditLedger` satırlarına `campaign: { id, name, versionNumber } \| null` eklenir (`referenceType ∈ {CampaignRedemption, PromoCreditLot, PromoCreditLotConsumption}` için tek toplu lookup; başka türde `null`). Admin UI: üç `CAMPAIGN_*` türü etiket + rozet (`GRANT` yeşil, `EXPIRE` nötr, `REVOKE` kırmızı), tür filtresine eklenir; reason kodları (`CAMPAIGN_GRANT`, `PROMO_LOT_EXPIRED`, `PROMO_LOT_REVOKED:<PAYMENT_REVERSED\|ADMIN_REVOKED>`, `PROMO_FORFEIT_ON_REFUND:<EXPIRED\|REVOKED>`) Türkçe etikete çevrilir — `:` sonrası "Not:" olarak değil, etiketin parçası olarak. İlişkili kayıt: "Kampanya · <ad> · sürüm N" + `/campaigns/<id>` bağlantısı. `revokeNote`, ham payload, PII yok. Toplam/bakiye UI'da hesaplanmaz (bugün de `previousBalance` API'den geliyor). Sağlayıcı kredi paneli (`transactions-panel.tsx`) aynı tür/reason etiketlerini alır. | Görev tanımı B. Eski türler/filtre/sıralama/pagination dokunulmaz. |
| D7 | **Sağlayıcı promo görünürlüğü (rev. 2, pre-merge güvenlik revizyonu):** yalnız `GET /providers/me/credits/promo` — `AuthGuard + RolesGuard`, **PROVIDER** rolü (anon 401; CUSTOMER ve SUPER_ADMIN 403); sağlayıcı kimliği yalnız oturumdan (`providerProfile.findFirst({ userId })`), handler'da `@Param/@Query/@Body/@Headers` yok; profilsiz hesap 404. Yanıt `{ spendableCredits, lots: [{ id, remainingCredits, expiresAt, campaignName }] }`; lot seçimi S2B1 ile aynı predicate (`ACTIVE ∧ remainingCredits > 0 ∧ expiresAt > now`), `PROMO_SPENDABLE_LOT_ORDER` (en yakın son kullanma önce); kampanya adı dışında kural/koşul/limit/başka sağlayıcı/`providerId` yok. `GET /providers/:id/credits` yanıtında `promo` **yoktur**; `/providers/<id>/credits/promo` hiçbir id için route değildir (404). Web kredi sayfası promo'yu yalnız `me` yolundan okur (`loadOwnPromoCredits`; 403/404 → boş blok), `id`'den yol kurmaz; blok yalnız lot varken render edilir. | Görev tanımı C + pre-merge revizyonu. Rev. 1 promo'yu `:id` yoluna eklemişti; sahibi olmayan sağlayıcının farklı id'leri denemesi 403/404 ayrımı ya da zamanlama farkıyla **sağlayıcı kimliği yoklama (ID enumeration) yüzeyi** açıyordu. Statik `me` yolu id almadığından ayrım da, zamanlama sinyali de yoktur; eski yol alias/redirect/403 değil, var olmayan route olarak 404'tür ki id'nin varlığı hakkında hiçbir şey söylemesin. |
| D8 | **Sistem aktörü:** Migration G `CampaignAuditLog.actorId` → nullable (**tek `ALTER COLUMN` istisnası**) + CHECK `CampaignAuditLog_system_actor_marked`: `"actorId" IS NOT NULL OR ("summary"->>'actorKind') = 'SYSTEM'`. Backfill yok. Webhook kaynaklı revoke: `REDEMPTION_REVOKED{actorKind:'SYSTEM', source:'PAYMENT_REVERSED', redemptionId, versionNumber, revokedCredits, spentAtRevoke, revokeCountToday, autoPaused}` audit satırı `actorId=null` ile (S3'te webhook revoke audit yazmıyordu; muhasebe değil kayıt eklenir) ve `AUTO_PAUSED` (`PAYMENT_REVERSED` kaynaklı) `actorId=null` — nominal `createdById` kaldırılır. Admin kaynaklı tüm aksiyonlar (`campaigns.service`) oturumdaki admin `user.id`'siyle yazılmaya devam eder; controller `user.id` yoksa 403. API audit görünümü `actor: ActorView \| null`; UI `actor === null` (ya da eski nominal satırlar için `summary.actorKind === 'SYSTEM'`) → "Sistem (ödeme iadesi)". | Görev tanımı D. CHECK, "actorId null ama SYSTEM işareti yok" satırını DB'de imkânsız kılar; admin yolunda actorId oturumdan gelir, payload'dan asla. |
| D9 | **Motor anahtarı yazıcısı:** `OperationsSettingsModule` içinde `CampaignEngineSettingsController` `GET/PUT /operations-settings/campaign-engine` (SUPER_ADMIN, `AuthGuard+RolesGuard`, `SetSchedulerEnabledDto {enabled}`) + `CampaignEngineSwitchService` — `MarketplacePublishSettingsService` ile aynı sözleşme: `runSerializable`, yalnız gerçek değişimde `upsert` + `OperationsSettingsChange{setting:'campaignEngineEnabled', previousValue, newValue, changedById}`; aynı değere yazım → yazım/audit yok; satır yoksa `create` şipped default'larla. Varsayılan `false`; seed/migration/env anahtarı açmaz. Mevcut okuyucular (hooks/worker/engine/campaigns) değişmez. | Görev tanımı E. Mevcut operations-settings sözleşmesi; audit `OperationsSettingsChange` zinciri Serializable ile tutarlı. |
| D10 | **Toggle UI:** Operasyon Ayarları sayfasına `#kampanya-motoru` kartı: durum pili, açık/kapalı etkisi metni, son değişiklikler tablosu ve **açık onay** gerektiren form: zorunlu onay kutusu ("Etkisini anladım") + "Motoru aç"/"Motoru kapat" düğmesi; server action onay yoksa hata ile geri döner, API'ye gitmez. Kampanya listesi/detayındaki "bu ekranda motoru açan düğme yoktur" metni Operasyon Ayarları bağlantısına çevrilir. | Görev tanımı E "açık onay gerektiren toggle işlemi". Diğer switch'ler tek tık; motor para veren tek switch olduğundan onay kutusu ek kapıdır. |
| D11 | **Toggle etkileri (test edilir, kod değişmez):** açılış geçmiş event üretmez (hook yalnız iş tx'inde, açılış anında kayıt yok); kapanış yeni event/evaluation durdurur (hooks/worker mevcut okuyucu); S3 revoke motor anahtarını okumaz → kapalıyken paket iadesi eski lotu yine revoke eder; açıkken aktif kampanya yoksa worker `EVALUATED`/grant yok. | Görev tanımı E; S2B2/S3 sözleşmeleri. |

## 2. Net iade muhasebe tablosu (hedef; testle kanıtlanır)

| Durum | Ledger satırları | `OfferRefundSettlement` | E-posta / web |
| --- | --- | --- | --- |
| Promosuz teklif (maliyet 5), iade | `OFFER_REFUND +5` | gross 5, restored 0, forfeited 0, net 5, before B, after B+5 | Bugünkü metin bire bir |
| Tam promo (lot 10, teklif 5), lot geçerli, iade | `OFFER_REFUND +5` | gross 5, restored 5, forfeited 0, net 5 | "İade edilen 5"; not: 5 promosyon kredisi geri döndü |
| Kısmi promo (lot 3 kaldı, teklif 5 → 3 promo + 2 ücretli), lot geçerli | `OFFER_REFUND +5` | gross 5, restored 3, forfeited 0, net 5 | aynı, not: 3 promo geri döndü |
| Kısmi promo, lot süresi dolmuş (sweeper geçmiş/geçmemiş) | `OFFER_REFUND +5`, `CAMPAIGN_EXPIRE −3` | gross 5, restored 0, forfeited {expired 3}, net 2, after B+2 | "İade edilen 5 · Geri alınan promosyon −3 · Net +2"; açıklama: süresi dolduğu için dönmedi |
| Kısmi promo, lot revoke edilmiş | `OFFER_REFUND +5`, `CAMPAIGN_REVOKE −3` | gross 5, forfeited {revoked 3}, net 2 | aynı, açıklama: promosyon geri alındığı için |
| Duplicate iade (worker + admin / ikinci istek) | ek satır yok (409) | değişmez | ikinci e-posta yok (`dedupeKey`) |

Her satırda `walletInvariant`: `Σ amount = son balanceAfter`, `paid ≥ 0`, `balance = paid + Σ remaining(ACTIVE/EXHAUSTED)`.

## 3. Migration G (`20260922120000_campaign_audit_system_actor`)

```sql
ALTER TABLE "CampaignAuditLog" ALTER COLUMN "actorId" DROP NOT NULL;
ALTER TABLE "CampaignAuditLog"
  ADD CONSTRAINT "CampaignAuditLog_system_actor_marked"
  CHECK ("actorId" IS NOT NULL OR ("summary" ->> 'actorKind') = 'SYSTEM');
```

Prisma: `actorId String?`, `actor User? @relation(...)`. DML/backfill/DROP yok; FK ve index'ler aynen kalır. İzole geçici DB'de
`migrate deploy` + `migrate diff` dry-run yapılır (`docs/superpowers/plans/2026-09-22-cmp-004-s4-migration-g-dryrun.txt`).
Gerçek yerel/staging DB'ye dokunulmaz.

## 4. Akışlar

- **Teklif iadesi (worker/admin):** `refundOfferCreditInTransaction` → `OFFER_REFUND` (aynen) → `restorePromoConsumptionsForRefund` (aynen) → `settlement = summarizeOfferRefundSettlement(refundRow, promoOutcome)` → dönüş `{ refundTransaction, balanceAfter, promo, settlement }`. Manuel iade API yanıtı `settlement` taşır. `sendCreditRefunded(refundTransactionId)` → `readOfferRefundSettlements([id])` → `creditRefundedData(provider, offer, settlement)`; retry yolu aynı.
- **Sağlayıcı teklifleri:** `listProviderOffers` → iade edilmiş tekliflerin `creditRefundedTransactionId`'leri → `readOfferRefundSettlements` → `creditRefundSettlement`.
- **Sağlayıcı kredileri:** `getProviderCredits` → mevcut bakiye + son 20 işlem (promo yok). **Sağlayıcı promosu:** `GET /providers/me/credits/promo` → `CreditsService.getMyPromoCredits(user.id)` → `readSpendablePromoLots`.
- **Admin ledger:** `listCreditLedger` → `lookupSourceNumbers` genişler: kampanya referansları için `campaign` lookup.
- **Webhook revoke:** `CampaignRevokeService.revokeForRefundedPurchase` → mevcut revoke çekirdeği → `REDEMPTION_REVOKED` (SYSTEM, actorId null) → eşik → `AUTO_PAUSED` (SYSTEM, actorId null). Admin revoke: `campaigns.service.revokeRedemption` bugünkü gibi admin actorId; auto-pause admin kaynaklıysa aktör admin (`actorKind:'ADMIN'`).
- **Toggle:** admin formu (onay kutusu) → server action → `PUT /operations-settings/campaign-engine {enabled}` → `CampaignEngineSwitchService.setEnabled` (Serializable; değişim yoksa no-op) → `GET` görünümü.

## 5. Test planı (zorunlu matris → dosya)

| # | Kapsam | Dosya |
| --- | --- | --- |
| 1 | Promosuz iade: API yanıtı (`settlement` net = gross), `creditRefundedData` alanları bugünkü değerlerle, şablon satırları değişmedi | `apps/api/test/offer-refund-settlement.spec.ts` (yeni), `transactional-email-render.spec.ts` (+) |
| 2 | Tam/kısmi promo iadesi: gross/restored/forfeited/net; in-tx ve re-read `toEqual`; duplicate iade 409 + tek outbox kaydı | `offer-refund-settlement.spec.ts` |
| 3 | Expired/revoked lot payı: net ve açıklama; `walletInvariant`; bakiye canlanmaz | `offer-refund-settlement.spec.ts` |
| 4 | Admin ledger: üç tür `campaign` alanı dolu, eski türlerde `null`, `revokeNote`/e-posta sızmaz, filtre/pagination aynı | `apps/api/test/finance-credit-ledger-campaign.spec.ts` (yeni); `apps/admin/test/finance-format.spec.ts` (+) |
| 5 | `GET /providers/me/credits/promo`: kendi lotları (sıra, toplam), expired/revoked/exhausted dışarıda; anon 401, CUSTOMER/SUPER_ADMIN 403; ikinci PROVIDER query/header/body ile başka id verse de yalnız kendi lotları; profilsiz 404; `:id/credits` yanıtında `promo` yok; `/providers/<id>/credits/promo` her id ve her oturum için 404; handler'da `@Param` yok (kaynak sözleşme testi); web yalnız `me` yolunu çağırır (kaynak testi) | `apps/api/test/provider-promo-visibility.spec.ts`, `apps/web/test/provider-promo-endpoint.spec.ts` |
| 6 | Webhook revoke → `REDEMPTION_REVOKED`+`AUTO_PAUSED` actorId null/SYSTEM; admin revoke → admin actorId; CHECK ihlali (null actor, SYSTEM yok) reddedilir | `campaign-refund-revoke.spec.ts` (güncel), `admin-campaign-operations.spec.ts` (güncel), `campaign-engine-schema.spec.ts` (+) |
| 7 | Toggle: varsayılan kapalı; anon 401, CUSTOMER/PROVIDER 403; ilk aç/kapa audit (previous null → 'true' → 'false'); aynı değer no-op; 6 eşzamanlı PUT → son durum tutarlı, audit zinciri sıralı (her `previousValue` bir önceki `newValue`) | `apps/api/test/campaign-engine-settings.spec.ts` (yeni) |
| 8 | Kapalı: hook event yazmaz; açık: tek event/tek grant; tekrar kapalı: event yok | `campaign-engine-settings.spec.ts` |
| 9 | Kapalıyken paket iadesi eski lotu revoke eder | mevcut `campaign-refund-revoke.spec.ts` #4 (korunur) |
| 10 | Regresyon: worker/lifecycle/webhook/revoke/offer spend-refund suite'leri | mevcut spec'ler |
| 11 | E2E: sağlayıcı kredi sayfası promo bloğu + iade satırı (320/768/1024/1440), admin ledger etiketleri, operasyon ayarları toggle (fixture DB'de aç/kapa, onay kutusu olmadan reddedilir) | `e2e/tests/provider-promo-credits.spec.ts`, `e2e/tests/admin-campaign-engine-toggle.spec.ts` (yeni; WebKit `testMatch`'e eklenir) |

## 6. Kapsam dışı

- Ücretli kredinin paket iadesinde geri alınması (bayrak + insan kararı; değişmedi).
- Motorun gerçek DB'de açılması; staging adımları teslim raporunda listelenir.
- Sağlayıcıya lot bazında geçmiş (expired/revoked) listesi; yalnız kullanılabilir lotlar gösterilir.
- `CampaignAuditLog.actorKind` ayrı kolon (summary JSON + CHECK yeterli; şema büyümesi yok).
