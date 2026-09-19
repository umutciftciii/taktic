# CMP-002 S0/S1 — Teslim raporu

Tarih: 2026-09-19 · Branch: `claude/cmp-002-s0-s1-drafts-53cc8b` · Taban: `origin/main` @ `a972c6b7` ·
Tasarım notu: `2026-09-19-cmp-002-s0-s1-campaign-drafts-design.md` · Bağlayıcı sözleşme: CMP-001 (rev. 3).

PR: https://github.com/umutciftciii/taktic/pull/96 · head `7d4a4c64` · CI **3/3 yeşil** (run 35463355666: typecheck·lint·test·build ✅, e2e chromium ✅, e2e webkit ✅).

---

## 1. Teslim edilen

| Katman | Dosya | İçerik |
| --- | --- | --- |
| Katalog (tek kaynak) | `packages/shared/campaign-rules.json` | 3 tetikleyici, 3 olgu, 10 koşul (sabit argüman şemaları: `integer/enum/enumList/slugList`), fayda/limit/öncelik sınırları, tek stack politikası, **24 kapalı hata kodu** |
| S0 kural çekirdeği | `apps/api/src/modules/campaigns/rules/{catalog,types,errors,validator}.ts` | JSON → tipli sabitler; `validateCampaignDefinition(input, {knownPackageSlugs})` saf/deterministik; `collectPackageSlugs`; normalize çıktı + özet |
| Migration A | `prisma/migrations/20260919150000_add_campaign_drafts/migration.sql` | 6 enum, `Campaign`, `CampaignVersion`, `CampaignAuditLog`, `OperationsSettings.campaignEngineEnabled` (default false); 10 CHECK; yalnız additive |
| S1 API | `apps/api/src/modules/campaigns/{campaigns.module,campaigns.service,admin-campaigns.controller,campaign-engine-settings.service}.ts` + `dto/` | SUPER_ADMIN 5 uç; validate-before-write; Serializable tx + satır kilidi; immutable sürüm; audit |
| Admin | `apps/admin/lib/campaign-rules.ts`, `apps/admin/app/campaigns/{page,new/page,[id]/page,actions,form-state,campaign-definition-form,engine-notice}.tsx`, `lib/api.ts` (tipler), `lib/nav.ts`, `globals.css` | Liste, boş durum, kurucu form (katalog seçenekli), doğrulama özeti, sürüm geçmişi, denetim izi, motor kapalı ibaresi |
| Testler | `apps/api/test/{campaign-rules-validator,admin-campaigns,campaign-engine-isolation}.spec.ts`, `apps/admin/test/campaign-rules.spec.ts`, `e2e/tests/admin-campaign-drafts.spec.ts` | Aşağıda |

## 2. DSL sözleşmesi (schemaVersion 1)

Tasarım notu §2 ile birebir. Kabul edilen tek fayda `{ type: "PROMO_CREDITS", credits 1–1000, expiresInDays 1–365 }`
(görev tanımı; CMP-001'deki `PROMO_CREDIT_LOT/validityDays` adının aynı mekanizması — notta gerekçelendirildi).
Hata modeli `{ path, code, message }`; kodlar:

`SCHEMA_INVALID, UNSUPPORTED_SCHEMA_VERSION, UNKNOWN_FIELD, UNKNOWN_TRIGGER, UNKNOWN_CONDITION,
CONDITION_TRIGGER_MISMATCH, USE_ELIGIBILITY_TRIGGER, ELIGIBILITY_REQUIRED, ELIGIBILITY_NOT_ALLOWED, UNKNOWN_FACT,
DUPLICATE_FACT, FACT_SET_SIZE, GROUP_DEPTH_EXCEEDED, GROUP_SIZE_EXCEEDED, GROUP_EMPTY, ARGUMENT_INVALID,
UNKNOWN_ARGUMENT, UNKNOWN_PACKAGE_SLUG, DUPLICATE_CONDITION, BENEFIT_INVALID, LIMIT_INVALID, WINDOW_INVALID,
STACK_POLICY_INVALID, PRIORITY_INVALID`

Unit spec'in son testi katalogdaki her kodun suite tarafından en az bir kez üretildiğini ve kümenin 24 olduğunu
doğrular. `FACT_SOURCE_UNAVAILABLE` / `LIMIT_BELOW_CONSUMED` aktivasyona özgüdür; bu dilimde üretilmez.

## 3. API sözleşmesi (`/admin/campaigns`, SUPER_ADMIN; anonim 401, diğer roller 403)

| Uç | Gövde | Yanıt |
| --- | --- | --- |
| `GET /admin/campaigns?limit=1..50&cursor=` | — | `{ engineEnabled, items[{…campaign, currentVersion: özet}], nextCursor }` |
| `GET /admin/campaigns/:id` | — | `{ engineEnabled, campaign, currentVersion (definition dâhil), versions[] (desc), audit[] (≤100) }`; 404 `CAMPAIGN_NOT_FOUND` |
| `POST /admin/campaigns` | `{ key, name, definition }` | 201 detay; 400 `CAMPAIGN_DEFINITION_INVALID {errors[]}`; 409 `CAMPAIGN_KEY_TAKEN` |
| `POST /admin/campaigns/:id/versions` | `{ definition }` | 201 detay (yeni `currentVersion`); 400/404; 409 `CAMPAIGN_NOT_DRAFT`; 409 `CONCURRENT_MODIFICATION` |
| `POST /admin/campaigns/validate` | `{ definition }` | 201 `{ valid, errors[], summary|null }` — DB yazmaz |

Yazma yolu: `runSerializable` içinde önce `Campaign` satırına model `update` (satır kilidi; eşzamanlı ikinci
tx 40001 → P2034 → yeniden deneme), sonra `max(versionNumber)+1`, `CampaignVersion.create`,
`Campaign.currentVersionId` güncelle, `CampaignAuditLog(VERSION_CREATED, summary)`. `CampaignVersion` için
**hiçbir update/delete çağrısı yok** (grep: `campaignVersion.update` → 0 sonuç).

Audit `summary` yalnız yapısal alanlar taşır: `{ versionNumber, trigger, benefitCredits, benefitExpiresInDays,
maxRedemptionsPerProvider, changedFields[] }` (jsonb anahtar sırasından bağımsız kararlı karşılaştırma).

## 4. Motorun mali yan etki üretmediğinin kanıtı

- `CampaignsModule` hiçbir domain modülünü import etmez, hiçbir şey export etmez; `providers`, `payments`,
  `entitlements`, `email/phone-verification`, `offers` modüllerine **dokunulmadı** (`git diff --stat` bkz.).
- `CreditTransactionType` enum'u değişmedi; ledger'a yazan yeni kod yok.
- `campaign-engine-isolation.spec.ts` (5 test): taslak kampanyalar DB'deyken sağlayıcı onayı, e-posta + telefon
  kanıtı (üç olgu birlikte true), Lemon webhook settle (ONE_TIME 25 kredi → yalnız `PACKAGE_PURCHASE`), mock
  period settle, teklif kredi harcaması → `Campaign/CampaignVersion/CampaignAuditLog` sayıları değişmez,
  `campaignEngineEnabled` false, ledger türleri eski altı türden ibaret.
- `campaignEngineEnabled` yalnız okunur (`CampaignEngineSettingsService.isEngineEnabled`, fail-closed); onu yazan
  uç yok (`PUT /operations-settings {campaignEngineEnabled}` → 400, testte kanıtlı).
- Seed/demo/varsayılan satır yok; migration `INSERT` içermez.

## 5. Test sonuçları (yerel, worktree)

| Suite | Sonuç |
| --- | --- |
| `campaign-rules-validator.spec.ts` (unit, 31) | ✅ kabul matrisi (K1/K2/ilk onay, boş kök, tek seviye any, slug), red matrisi — her kod ≥1, derinlik/boyut/boş grup, uyumsuzluk, `USE_ELIGIBILITY_TRIGGER`, duplicate/çelişki, tür/argüman, fayda/limit/pencere/stack/priority, determinizm |
| `admin-campaigns.spec.ts` (integration, 13) | ✅ RBAC 401/403; create → 1 sürüm + 2 audit; geçersiz → 0 satır; slug DB denetimi; key 409 / DTO 400; validate DB yazmaz; revizyon (eski sürüm `toEqual` bit-bit, pointer, audit `changedFields`); geçersiz revizyon 0 satır + 404 sızdırmaz; DRAFT dışı 409; **8 paralel save → boşluksuz monoton, 409 yalnız `CONCURRENT_MODIFICATION`**; liste/cursor/limit sınırı/detay; engine satır yok/false/true |
| `campaign-engine-isolation.spec.ts` (5) | ✅ §4 |
| API tam suite | bkz. teslim kaydı |
| `apps/admin` unit (64, +9 yeni) | ✅ katalog projeksiyonu, tetikleyiciye göre daralan seçenekler, hata cümlesi kapsamı, form→tanım (any grubu, tipli argüman, açık null), onarmama, round-trip, path→alan eşlemesi, nav |
| `packages/shared` (168) | ✅ |
| E2E `admin-campaign-drafts` Chromium | ✅ 2/2 — liste+ibare → kurucu (textarea yok, katalog dışı seçenek yok) → Doğrula: `BENEFIT_INVALID` alan yanında, DB 0 → düzelt → geçerli, DB 0 → kaydet v1 → revizyon v2, v1 DB'de `toEqual` → liste → 320/768/1024/1440 taşma yok (liste/detay/kurucu ekran görüntüleri `e2e/.artifacts/admin-campaign-drafts/`); sağlayıcı oturumu → `/login` |
| E2E WebKit | ✅ 2/2 (testMatch'e eklendi) |
| `pnpm lint` | ✅ 4/4 · `typecheck` api/admin/shared/e2e ✅ |

## 6. Migration dry-run (izole, gerçek yerel DB'ye komut yok)

Geçici `taktic_cmp002_dryrun` DB'sinde tüm zincir `prisma migrate deploy` → **66 migration uygulandı**;
`prisma migrate diff --from-url <dryrun> --to-schema-datamodel` → **"No difference detected"**; `\d` çıktısı
(3 tablo, indeksler, 10 CHECK, FK'ler RESTRICT), `campaignEngineEnabled boolean NOT NULL DEFAULT false`,
`Campaign` sayısı 0. Geçici DB'ler düşürüldü. `migrate diff` üretimi de geçici shadow DB ile yapıldı.

## 7. Değişmeyenler

`ProviderCreditTransaction`, `PackagePurchase`, `ProviderPackageEntitlement`, `OfferCreditPackage`, Lemon
adapter/webhook, `updateProviderStatus`, e-posta/telefon kanıt servisleri, entitlement resolver, scheduler'lar,
mevcut admin ekranları (yalnız `nav.ts` + `globals.css` ek), `.env`, compose, Cloudflare, dış servisler.
Merge/deploy/yerel-staging eşitlemesi **yapılmadı**.

## 8. Açık kalanlar (S2+)

Aktivasyon/pause/end uçları ve `activeVersionId`; `CampaignTriggerEvent`, `CampaignRedemption`, sayaçlar, lot,
`FactSourceRegistry`, `onProviderFact` bağlama (`// CMP-002 fact callback:` noktaları), webhook hook, expiry
süpürücü, `FACT_SOURCE_UNAVAILABLE`/`LIMIT_BELOW_CONSUMED`, engine anahtarı toggle ucu, kampanya adı düzenleme.

## 9. Teslim kaydı

- PR #96 açıldı (`481eca59`); ilk CI: typecheck/test/build ✅, chromium ✅, **webkit ✗** — Linux WebKit'te detay sayfası 320px'te 9px taşma, görünür suçlu eleman yok.
- `1e9e92e8`: form girdilerine `width:100%/min-width:0` (yetmedi). `50356d86`: yerelde macOS WebKit 260px'te aynı "suçlusuz" taşma üretildi; bisect teşhisi (blokları gizleyerek) koşul türü `<select>`'ini gösterdi → select kırpma + iç içe grid `min-width:0` (macOS ✅, Linux ✗: native menulist select üzerindeki `overflow`'u yok sayıyor). `7d4a4c64`: kırpma bir üst seviyeye, `.campaign-fieldset .field`'e alındı (3px padding/−3px margin ile odak halkası korunur) → **CI 3/3 ✅**.
- Aynı koşuda `showcase-screens-viewport` WebKit'te bir kez "WebKit encountered an internal error" ile düşüp retry'da geçti; bu PR'la ilgisiz, mevcut flake.
- Merge/deploy/yerel-staging eşitlemesi yapılmadı; branch açık bırakıldı.
