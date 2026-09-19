# CMP-002 S0/S1 — Güvenli kural çekirdeği, immutable kampanya taslakları, SUPER_ADMIN taslak yüzeyi

Tarih: 2026-09-19 · Taban: `origin/main` @ `a972c6b7` (AUTH-PROVIDER-CONTACT-001 merge, temiz worktree doğrulandı) ·
Branch: `claude/cmp-002-s0-s1-drafts-53cc8b` · Bağlayıcı sözleşme: `2026-09-19-cmp-001-campaign-engine-design.md` (rev. 3).

Bu dilim **yalnız tanım ve taslak** getirir. Kredi lotu, bakiye tüketimi, `CampaignTriggerEvent`,
`CampaignRedemption`, event handler, `FactSourceRegistry`, provider uygunluk değerlendirmesi, webhook
bağlama, expiry/revoke/scheduler, K1/K2 aktivasyonu ve **her türlü mali yan etki kapsam dışıdır**. Motor
varsayılan kapalıdır ve bu PR'da onu açan bir uç yoktur; provider onayı, e-posta/telefon kanıtı, paket
ödemesi veya teklif kredi harcaması bu PR'da hiçbir kampanya tablosuna yazmaz.

---

## 1. Mimari — üç katman, tek katalog

```
packages/shared/campaign-rules.json        ← tek katalog (tetikleyici, koşul, olgu, sınır, hata kodu)
        │ JSON import (CommonJS-uyumlu)             │ JSON import (Next transpile)
        ▼                                          ▼
apps/api/src/modules/campaigns/rules/       apps/admin/lib/campaign-rules.ts
  catalog.ts   (JSON → tipli sabitler)        (JSON → etiketler, form seçenekleri, hata mesajı eşlemesi)
  types.ts     (CampaignDefinition v1)
  validator.ts (saf; tek otorite)
  errors.ts    (kapalı hata kodları)
        ▲
apps/api/src/modules/campaigns/
  campaigns.service.ts  (Campaign/Version/Audit; Serializable tx; validate-before-write)
  admin-campaigns.controller.ts  (SUPER_ADMIN)
  campaign-engine-settings.service.ts (campaignEngineEnabled; fail-closed okuma; bu PR'da yalnız pano rozeti)
```

**Neden JSON katalog + API'de validator:** `apps/api` `@taktic/shared`'in TS kaynağını runtime'da
require edemez (`project_api_cannot_import_shared_package`), JSON'u edebilir (`turnstile.json`, `limits.json`
emsali). Doğrulama mantığı **tek yerde** (API) yaşar; admin aynı katalogdan form seçeneklerini ve etiketleri
türetir, kuralı **ikinci kez yazmaz**: form → tanım → `POST /admin/campaigns/validate` (DB yazmadan) →
alan bazlı hata. Admin tarafında yalnız "zorunlu alan boş" türü kaba kontroller vardır.

---

## 2. S0 — Güvenli kural DSL'i (`schemaVersion: 1`)

Tek JSON nesnesi, tamamı allowlist. Serbest JS/SQL/expression/regex/webhook URL/raw filter yok;
bilinmeyen üst-düzey anahtar, bilinmeyen koşul, bilinmeyen argüman **hata**.

```jsonc
{
  "schemaVersion": 1,
  "trigger": "PROVIDER_APPROVED" | "PACKAGE_PAYMENT_SUCCEEDED" | "PROVIDER_ELIGIBILITY_REACHED",
  "eligibility": { "facts": ["PROVIDER_APPROVED", "EMAIL_VERIFIED", "PHONE_VERIFIED"] },  // yalnız ELIGIBILITY tetikleyicisinde
  "conditions": { "all": [ <Condition> | { "any": [ <Condition>, ... ] } ] },
  "benefit": { "type": "PROMO_CREDITS", "credits": 10, "expiresInDays": 30 },
  "limits": { "maxRedemptionsPerProvider": 1, "maxRedemptionsGlobal": null, "maxRedemptionsPerDay": null, "budgetCredits": null },
  "window": { "startAt": null, "endAt": null },
  "stackPolicy": "EXCLUSIVE_CREDIT_BONUS",
  "priority": 100
}
```

### 2.1 Karar: fayda adı

Görev tanımı faydayı `{ type: "PROMO_CREDITS", credits, expiresInDays }` olarak sabitler; CMP-001 §2.4
aynı mekanizmayı `PROMO_CREDIT_LOT { credits, validityDays }` diye adlandırmıştı. **Görev tanımı esas
alınır** (DSL ve `CampaignBenefitType` enum'u `PROMO_CREDITS`; kolonlar `benefitCredits`,
`benefitExpiresInDays`). Anlam birebir aynıdır: süreli promosyon kredi lotu; S2 lotu bu iki kolondan üretir.
CMP-001'de başka hiçbir isim değişmedi.

### 2.2 Tetikleyiciler (kapalı küme)

`PROVIDER_APPROVED`, `PACKAGE_PAYMENT_SUCCEEDED`, `PROVIDER_ELIGIBILITY_REACHED`. Başka değer →
`UNKNOWN_TRIGGER`. `eligibility` yalnız üçüncüsünde zorunlu (`ELIGIBILITY_REQUIRED`), diğer ikisinde yasak
(`ELIGIBILITY_NOT_ALLOWED`). Olgular `PROVIDER_APPROVED | EMAIL_VERIFIED | PHONE_VERIFIED`; küme 2–3 öğe
(katalogda üç olgu vardır; CMP-001'in 2–5 üst sınırı katalog büyüdükçe JSON'da yükselir), tekrar yok
(`FACT_SET_SIZE`, `UNKNOWN_FACT`, `DUPLICATE_FACT`).

### 2.3 Koşul allowlist'i (v1) — CMP-001 §2.2 tablosuyla birebir

| `type` | Argüman | İzinli tetikleyici |
| --- | --- | --- |
| `FIRST_PROVIDER_APPROVAL` | — | PROVIDER_APPROVED |
| `EMAIL_VERIFIED` | — | PACKAGE_PAYMENT_SUCCEEDED, PROVIDER_ELIGIBILITY_REACHED (PROVIDER_APPROVED'da `USE_ELIGIBILITY_TRIGGER`) |
| `PHONE_VERIFIED` | — | aynı |
| `FIRST_SUCCESSFUL_PAID_PURCHASE` | — | PACKAGE_PAYMENT_SUCCEEDED |
| `PACKAGE_SLUG_IN` | `slugs: string[]` 1–20, slug deseni, katalogda var olmalı | PACKAGE_PAYMENT_SUCCEEDED |
| `PACKAGE_TYPE_IN` | `types: OfferPackageType[]` 1–3 | PACKAGE_PAYMENT_SUCCEEDED |
| `PURCHASE_KIND_IN` | `kinds: ["OFFER_PACKAGE"]` (SHOWCASE_PACKAGE reddedilir) | PACKAGE_PAYMENT_SUCCEEDED |
| `MIN_PAID_AMOUNT` | `minor: int 100–100_000_000, currency: "TRY"` | PACKAGE_PAYMENT_SUCCEEDED |
| `NO_PRIOR_REVOCATION` | — | hepsi |
| `PROVIDER_APPROVED_WITHIN_DAYS` | `days: 1–365` | PACKAGE_PAYMENT_SUCCEEDED, PROVIDER_ELIGIBILITY_REACHED |

"Sağlayıcı onaylı" koşulu ayrı bir koşul değildir: `PROVIDER_APPROVED` tetikleyicisi olayın kendisi,
uygunluk geçişinde `eligibility.facts` içindeki `PROVIDER_APPROVED` olgusudur (CMP-001 §8). `EMAIL_VERIFIED` /
`PHONE_VERIFIED` koşulu, aynı olgu `eligibility.facts` içindeyken de yazılırsa `DUPLICATE_CONDITION`
(anlamsız tekrar).

### 2.4 Grup kuralları

Kök `conditions.all` zorunlu dizi (boş olabilir: "tetikleyici tek başına yeter"). İçinde koşul veya **tek
seviye** `{ any: [...] }`; `any` içinde `any`/`all` → `GROUP_DEPTH_EXCEEDED`; boş `any` → `GROUP_EMPTY`;
`all` > 16 veya `any` > 8 → `GROUP_SIZE_EXCEEDED`; `NOT` yok. Aynı `type` bir grupta iki kez veya hem `all`
hem bir `any` içinde → `DUPLICATE_CONDITION` (argümanlı türler dâhil — iki `MIN_PAID_AMOUNT` çelişkidir,
iki `PACKAGE_SLUG_IN` tek listeye indirgenir; ikisi de reddedilir).

### 2.5 Fayda, limit, pencere, stack, öncelik

- `benefit`: yalnız `PROMO_CREDITS`; `credits` tam sayı 1–1000, `expiresInDays` tam sayı 1–365; başka tür
  (indirim, vitrin, para) veya bilinmeyen alan → `BENEFIT_INVALID`.
- `limits`: `maxRedemptionsPerProvider` zorunlu 1–100; `maxRedemptionsGlobal` null|1–1_000_000;
  `maxRedemptionsPerDay` null|1–100_000; `budgetCredits` null|1–10_000_000; ayrıca `budgetCredits <
  benefit.credits` → `LIMIT_INVALID` (bütçe tek lotu bile karşılamıyor).
- `window`: `startAt`/`endAt` null veya ISO-8601 UTC (`Z`); `startAt >= endAt` → `WINDOW_INVALID`.
- `stackPolicy`: yalnız `EXCLUSIVE_CREDIT_BONUS` (`STACK_POLICY_INVALID`). Additive/enum alanı **icat
  edilmez**.
- `priority`: tam sayı 1–1000 (`PRIORITY_INVALID`).

### 2.6 Kapalı hata modeli

`{ path, code, message }` listesi; kodlar (kapalı küme, katalogda):
`SCHEMA_INVALID, UNSUPPORTED_SCHEMA_VERSION, UNKNOWN_FIELD, UNKNOWN_TRIGGER, UNKNOWN_CONDITION,
CONDITION_TRIGGER_MISMATCH, USE_ELIGIBILITY_TRIGGER, ELIGIBILITY_REQUIRED, ELIGIBILITY_NOT_ALLOWED,
UNKNOWN_FACT, DUPLICATE_FACT, FACT_SET_SIZE, GROUP_DEPTH_EXCEEDED, GROUP_SIZE_EXCEEDED, GROUP_EMPTY,
ARGUMENT_INVALID, UNKNOWN_ARGUMENT, UNKNOWN_PACKAGE_SLUG, DUPLICATE_CONDITION, BENEFIT_INVALID,
LIMIT_INVALID, WINDOW_INVALID, STACK_POLICY_INVALID, PRIORITY_INVALID`.
CMP-001'in aktivasyona özgü `FACT_SOURCE_UNAVAILABLE` ve `LIMIT_BELOW_CONSUMED` kodları bu dilimde
**üretilmez** (aktivasyon yok); S2'de eklenir. Validator saf ve deterministiktir; `UNKNOWN_PACKAGE_SLUG`
için slug varlığı servis katmanında tek `findMany` ile sağlanır ve sonuç aynı hata listesine eklenir.

---

## 3. S1 — Veri modeli (Migration A, yalnız additive)

```
enum CampaignStatus          { DRAFT ACTIVE PAUSED ENDED }      // bu PR yalnız DRAFT yazar
enum CampaignTrigger         { PROVIDER_APPROVED PACKAGE_PAYMENT_SUCCEEDED PROVIDER_ELIGIBILITY_REACHED }
enum CampaignEligibilityFact { PROVIDER_APPROVED EMAIL_VERIFIED PHONE_VERIFIED }
enum CampaignBenefitType     { PROMO_CREDITS }
enum CampaignStackPolicy     { EXCLUSIVE_CREDIT_BONUS }
enum CampaignAuditAction     { CREATED VERSION_CREATED }        // S2+: ACTIVATED, PAUSED, …

model Campaign {
  id, key @unique (slug), name, status=DRAFT,
  currentVersionId String? @unique → CampaignVersion (Restrict)   // "current draft" referansı
  createdById → User, createdAt, updatedAt
  @@index([status, updatedAt])
}
model CampaignVersion {                       // immutable: UPDATE/DELETE yolu yok
  id, campaignId → Campaign (Restrict), versionNumber Int,
  trigger, eligibilityFacts CampaignEligibilityFact[], factSetKey String?,
  definition Json,                            // doğrulanmış tam DSL snapshot'ı (normalize edilmiş)
  benefitType, benefitCredits, benefitExpiresInDays,
  maxRedemptionsPerProvider, maxRedemptionsGlobal?, maxRedemptionsPerDay?, budgetCredits?,
  windowStartAt?, windowEndAt?, stackPolicy, priority,
  createdById → User, createdAt
  @@unique([campaignId, versionNumber])  @@index([trigger, factSetKey])
  CHECK'ler: benefitCredits 1–1000, benefitExpiresInDays 1–365, perProvider 1–100, global/day/budget
  NULL veya aralık, priority 1–1000, versionNumber >= 1,
  (trigger='PROVIDER_ELIGIBILITY_REACHED') = (factSetKey IS NOT NULL), window start<end
}
model CampaignAuditLog {
  id, campaignId → Campaign, action, campaignVersionId?, actorId → User,
  summary Json?,                              // güvenli özet: {versionNumber, trigger, benefitCredits, changedFields[]}
  createdAt
  @@index([campaignId, createdAt])
}
OperationsSettings + campaignEngineEnabled Boolean @default(false)   // satır yoksa false; toggle ucu yok
```

CMP-001 §3.2'de sayılan `activeVersionId, redemptionCount, budgetConsumedCredits, revokeAlertThreshold,
activatedAt/pausedAt/endedAt` **S2'de** gelir (aktivasyon ve sayaç anlamı orada doğar). Silme yok;
`onDelete: Cascade` yok. Mevcut kredi/ödeme tabloları değişmez. Seed/demo satırı yok.

`summary` içeriği yalnız yapısal alanlardan üretilir (sürüm no, tetikleyici, kredi, gün, limit değerleri,
değişen alan adları); token, secret, PII, ödeme gövdesi, serbest metin girmez.

---

## 4. S1 — Servis ve yazma sözleşmesi

- **Validate-before-write:** tanım önce saf validator + slug denetiminden geçer; hata varsa **hiçbir**
  satır (Campaign/Version/Audit) yazılmaz, 400 döner.
- **Oluşturma** `POST /admin/campaigns {key, name, definition}` → tek `runSerializable` tx: Campaign
  (DRAFT) + CampaignVersion #1 + `currentVersionId` + Audit(CREATED) + Audit(VERSION_CREATED). Bir
  kampanya her zaman en az bir sürüme sahiptir; "boş kampanya" yok.
- **Revizyon** `POST /admin/campaigns/:id/versions {definition}` → aynı tx içinde `max(versionNumber)+1`
  hesaplanır, yeni immutable satır yazılır, `Campaign.currentVersionId` atomik güncellenir,
  Audit(VERSION_CREATED, summary.changedFields = önceki tanıma göre farklı üst-düzey alanlar). Önceki
  sürüm satırına **UPDATE yok**. Kampanya `DRAFT` değilse `409 CAMPAIGN_NOT_DRAFT` (bu PR'da başka durum
  üretilmez; kapı yine de var).
- **Paralel kaydetme:** Serializable + `@@unique([campaignId, versionNumber])`; çakışan tx `P2034` ile
  yeniden denenir (`runSerializable`, 3 deneme), bütçe biterse `409 CONCURRENT_MODIFICATION`. Test: 8
  eşzamanlı save → tüm sürüm numaraları farklı, boşluksuz artan, `currentVersionId` = en büyük.
- **Doğrulama** `POST /admin/campaigns/validate {definition}` → `{ valid, errors[], summary? }`; DB
  yazmaz (test: satır sayıları değişmez).
- **Liste** `GET /admin/campaigns?limit&cursor` → `{ engineEnabled, items[], nextCursor }`; `limit` 1–50
  (varsayılan 25); sıralama `updatedAt desc, id desc`.
- **Detay** `GET /admin/campaigns/:id` → `{ engineEnabled, campaign, currentVersion, versions[] (desc),
  audit[] (desc, ≤100) }`.
- **Hata kodları** (kapalı): `CAMPAIGN_DEFINITION_INVALID` (400, `errors[]`), `CAMPAIGN_KEY_TAKEN` (409),
  `CAMPAIGN_NOT_FOUND` (404), `CAMPAIGN_NOT_DRAFT` (409), `CONCURRENT_MODIFICATION` (409). 404 mesajı
  başka varlık hakkında bilgi taşımaz.
- **RBAC:** `AuthGuard + RolesGuard + @Roles(SUPER_ADMIN)` sınıf düzeyinde; anonim 401, CUSTOMER/PROVIDER
  403. Provider/customer/public uç yok.
- `campaignEngineEnabled` yalnız okunur (fail-closed: satır yok/okunamıyor/false → false) ve yanıtlarda
  `engineEnabled` olarak taşınır; UI rozetini besler. Motor bu bayrağa göre **hiçbir şey çalıştırmaz**.

---

## 5. Admin UI (`apps/admin/app/campaigns`)

- `/campaigns` — liste (ad, anahtar, durum rozeti "Taslak", tetikleyici, kredi, sürüm no, güncellenme) +
  kalıcı "Kampanya motoru kapalı — kampanyalar yalnız taslaktır, kredi verilmez" uyarısı + boş durum +
  "Yeni taslak" düğmesi. Sidebar: **Yönetim › Kampanyalar**.
- `/campaigns/new` — `CampaignDefinitionForm` (client bileşeni): ad/anahtar; tetikleyici seçimi (radyo);
  uygunluk olguları (yalnız ELIGIBILITY'de, onay kutuları); koşul satırları (tür seçici tetikleyiciye göre
  daralır; argüman alanları türe göre; her satır "zorunlu (hepsi)" veya "alternatif (en az biri)" —
  ikincisi tek `any` grubuna düşer); fayda (kredi, gün); limitler; pencere; öncelik; stack politikası
  salt-okunur "Özel kredi bonusu". Düğmeler: **Doğrula** (yalnız validate) ve **Taslağı kaydet**.
  Sonuç: alan bazlı hata listesi (`path` → satır) ve doğrulama özeti. Ham JSON alanı **yok**.
- `/campaigns/[id]` — özet, "motor kapalı / taslak" rozeti, güncel sürüm tanımı (okunur özet),
  **sürüm geçmişi** (her sürüm: no, tarih, oluşturan, tetikleyici, kredi, gün, limitler), denetim izi,
  "Yeni revizyon" formu (güncel sürümle önceden dolu; kaydetme yeni sürüm üretir).
- Tüm ekranlar 320/768/1024/1440'ta yatay taşmasız; mevcut `section-card / field / compact-form / badge /
  notice` sınıfları. Hiçbir yerde "etkin", "kredi verildi" ifadesi yok.
- Server action'lar `useActionState` ile hata/özet durumunu forma geri taşır (query-string ile JSON
  taşınmaz). Doğrulama sonucu API'nin `errors[]`'ünden, mesajlar katalogdan (`campaign-rules.ts`).

---

## 6. Test planı

| Katman | Kapsam |
| --- | --- |
| API unit (`campaign-rules-validator.spec.ts`) | kabul matrisi (3 tetikleyici × örnek tanımlar, CMP-001 §7 K1/K2), red matrisi — **her hata kodu ≥1 vaka**, derinlik/boyut/boş grup, tetikleyici-koşul uyumsuzluğu, `USE_ELIGIBILITY_TRIGGER`, duplicate/çelişki, tür hataları, fayda/limit/pencere/stack/priority sınırları, normalize çıktısı deterministik |
| API integration (`admin-campaigns.spec.ts`) | RBAC 401/403; create → Campaign+Version#1+2 audit; geçersiz tanım → hiçbir satır yok; validate → DB değişmez; revizyon → yeni satır, eski satır bit-bit aynı, `currentVersionId` güncel, audit `changedFields`; 8 paralel save → monoton, çakışmasız; key çakışması 409; `UNKNOWN_PACKAGE_SLUG` DB destekli; bilinmeyen id 404 (gövde sızdırmaz); `engineEnabled` satır yok/false/true; bilinmeyen üst-düzey alan 400 |
| API izolasyon (`campaign-engine-isolation.spec.ts`) | provider onayı (PATCH status), e-posta confirm, telefon OTP verify, Lemon webhook settle (ONE_TIME + MONTHLY), teklif kredi harcaması → `Campaign/CampaignVersion/CampaignAuditLog` sayıları 0 kalır, ledger türleri yalnız mevcut altı tür; taslak kampanya varken de aynı |
| Admin unit (vitest) | `campaign-rules.ts`: form durumu → tanım dönüşümü, `any` grubu, hata `path` → satır eşlemesi, etiketler katalogla eşit; `nav.spec` Kampanyalar girişi |
| E2E (Chromium + WebKit) | admin girişi → boş liste + motor kapalı ibaresi → yeni taslak (K2 örneği) → Doğrula → geçersiz (kredi 0) hata görünür → düzelt → kaydet → detayda sürüm 1 → revizyon → sürüm 2 + geçmişte 2 satır; PROVIDER rolü `/campaigns` → login'e yönlenir; 320/768/1024/1440 taşma yok |
| Migration | geçici DB'de `migrate deploy` (tüm zincir) + `migrate diff --from-migrations --to-schema-datamodel` boş + `\d` çıktısı; gerçek yerel DB'ye komut yok |

---

## 7. Değişmeyenler (bu PR'da dokunulmaz)

`ProviderCreditTransaction`, `PackagePurchase`, `ProviderPackageEntitlement`, Lemon webhook/adapter,
`providers.service.updateProviderStatus`, e-posta/telefon kanıt servisleri, entitlement resolver,
scheduler'lar, `.env`/compose, Cloudflare, dış servisler, mevcut admin ekranları. `OperationsSettings`'e
yalnız bir kolon eklenir; okuyan mevcut kod değişmez.

## 8. Uygulama sırası

1. Katalog JSON + API `rules/` (types, catalog, errors, validator) — TDD, unit spec.
2. Prisma şeması + Migration A SQL + izole dry-run.
3. `campaigns` modülü: settings okuyucu, servis, controller, DTO; integration spec; izolasyon spec.
4. Admin: `lib/campaign-rules.ts`, `lib/api.ts` tipleri, sayfalar, form, action'lar, nav; unit spec.
5. E2E spec (Chromium; WebKit testMatch'e ekle).
6. typecheck/lint/test/build/E2E; PR; CI 3/3; teslim raporu.
