# CMP-006 PR-C — Teslim raporu (kanonik işletme kaydı + promosyon fraud uygunluğu)

Tarih: 2026-09-23 · Branch: `claude/cmp-006-business-registration-fraud-bb7092` · Taban: `main` @ `b4dc5f51` ·
Tasarım: [`2026-09-23-cmp-006-pr-c-business-registration-promotion-eligibility-design.md`](../specs/2026-09-23-cmp-006-pr-c-business-registration-promotion-eligibility-design.md) ·
Dry-run: [`2026-09-23-cmp-006-pr-c-migration-k-dryrun.txt`](2026-09-23-cmp-006-pr-c-migration-k-dryrun.txt)

**Kampanya motoru anahtarı ve `PURCHASE_TERMS_GATE` kapalı kaldı; hiçbir kod onları açmaz. Gerçek checkout, Lemon,
e-posta/SMS veya staging işlemi yapılmadı; yerel `taktic` verisine dokunulmadı (yalnız izole dry-run DB'si ve bu
checkout'un test/e2e DB'leri). Kampanya DSL'i (`campaign-rules.json`) değişmedi. Merge ve yerel eşitleme yapılmadı.**

## 1. Sayılarla

| Ölçüm | Değer |
| --- | --- |
| Migration | **K** `20260923180000_add_business_registration_and_promotion_eligibility` — 77.; yalnız ekleme, **DML yok**, `taxType/taxNumber` dönüştürülmedi |
| Yeni tablo | `ProviderBusinessRegistration`, `ProviderBusinessRegistrationChange`, `SensitiveDataAccessLog`, `CampaignRegistrationCounter`, `PromotionEligibilityHold`, `PromotionEligibilityReview` |
| Yeni enum / değer | 4 enum · `CampaignTriggerEventStatus += HELD_FOR_REVIEW` · `CampaignEvaluationOutcome += PROMOTION_REVIEW_HELD, PROMOTION_INELIGIBLE` |
| CHECK / tetikleyici | 6 CHECK · 5 tetikleyici (4 append-only + karar↔hold eşleşmesi) |
| İzin | +2 (`PROVIDER_REGISTRATION_READ_SENSITIVE`, `PROMOTION_ELIGIBILITY_REVIEW`) → 80 → **82** |
| Yeni rota | Admin 4 (route-map'te) · Sağlayıcı 2 (`GET/PUT /providers/me/business-registration`) · başvuru gövdeleri += kayıt çifti |
| Yeni env | `PROMOTION_FINGERPRINT_KEY`, `PROMOTION_FINGERPRINT_KEY_VERSION` — local/test'te boş geçer, staging/prod'da zorunlu (boot reddi); compose + `.env.example` güncellendi |
| Yeni API testi | **111** (kurallar/normalizasyon 13 blok · anahtar sözleşmesi 6 · karar matrisi 8 blok · HTTP kayıt/sızıntı/audit 24 · kapı/hold/karar/sayaç 25) |
| Tam API paketi | **168 dosya / 3652 test** — ilk koşuda 1 gerileme (`campaign-engine-settings`, fixture), düzeltildi ve yeniden geçti |
| Web / admin birim | web 355/355 (yeni 4) · admin 78/78 (yeni 4) |
| E2E | Yeni 2 senaryo · tam Chromium **301/302** → tek hata B7 ile düzeltildi, dosya yeniden 2/2 · mevcut 3 başvuru spec'i tür seçimiyle güncellendi |
| typecheck | api (src + test), web, admin, e2e, shared temiz |

## 2. Görev tanımının maddeleri

| İstenen | Nerede / kanıt |
| --- | --- |
| Başvuru + şirket bilgileri ekranında tür + numara | `business-registration-fields.tsx` (açık ve davetli form), `/providers/[id]/edit` "İşletme kaydı" formu → `PUT /providers/me/business-registration` |
| `NONE_DECLARED` numarasız; diğerleri zorunlu, normalize, türüyle | `business-registration.rules.ts` + DB CHECK `number_matches_type`; 13 kural bloğu + HTTP 400 kodları |
| Eski `taxType/taxNumber` kör backfill yok, "belirsiz/eski kayıt" | dry-run §6 (0 satır, eski değer aynen); `registrationView` → `UNSPECIFIED`; **ek düzeltme:** profil kaydı artık eski vergi alanlarını sessizce silmiyor |
| Başvuru, sağlayıcı ekranı, izinli admin detayında tutarlı | tek görünüm `BusinessRegistrationView`; web + admin `describeBusinessRegistration` |
| Listelerde maskeli, ham yalnız hassas izinli detayda | sızıntı matrisi testi (public/owner/me/dashboard/staff/list/detail); ham yalnız `…/business-registration/raw` |
| Her ham okumada audit, liste/public projeksiyonuna sızmaz | `SensitiveDataAccessLog` (aynı tx, değer yok, append-only); E2E: göster düğmesi yalnız izinli, tek okuma = tek satır |
| `SOLE_PROPRIETOR_TR_ID` yüksek hassasiyet | TCKN sağlaması; sağlayıcıya da maskeli; log/e-posta/bildirim/audit/snapshot'ta ham yok (T-LEAK testleri) |
| Tek kanonik sonuç `ELIGIBLE/REVIEW/INELIGIBLE`, DSL'e kural yok | `promotion-eligibility.ts` (saf) + reader; katalog değişmedi |
| `NONE_DECLARED`/eksik/şüpheli → REVIEW | `REGISTRATION_NONE_DECLARED`, `REGISTRATION_UNSPECIFIED`, `REGISTRATION_SHARED` |
| Aynı IP/cihaz tek başına INELIGIBLE değil | yalnız IP → iki sağlayıcı da grant (test); IP yalnız başka REVIEW varken gerekçe; cihaz verisi toplanmıyor |
| IP sinyali ham değil sürümlü HMAC; RG-2 açık | `sessionIpFingerprint` `v1:<hex>`; snapshot'ta adres yok (test); tasarım §9 + S0 RG-2 notu |
| Aynı kayıt farklı hesapta → gerekçeli REVIEW, sayaçta ham yok | `REGISTRATION_PROMOTION_CONSUMED` (diğer sağlayıcı id'siyle); sayaç kolonları dry-run §10 |
| Sayaç yalnız gerçek grantte | aday savepoint'i içinde; limit reddi / motor hatası / REVIEW / INELIGIBLE → 0 (testler) |
| Aynı provider ikinci intro yok | mevcut `maxRedemptionsPerProvider` + anahtar tekilliği; karar sonrası yeniden yükselme → grant sayısı 1, sayaç 1 |
| REVIEW → `HELD_FOR_REVIEW`, worker almaz | `claimDueEvent` durum filtresi; zaman 30 gün ileri + yeniden yükselme → claim 0; retry rotası 409 |
| Hold anındaki sonuç immutable snapshot | `PromotionEligibilityHold` (append-only tetikleyici), olay başına bir; karar sonrası kapı yeniden hesaplanmaz |
| Dar admin aksiyonu, açık gerekçe | `POST /admin/promotion-eligibility/holds/:eventId/decision` (10–1000); admin kuyruk + detay + form |
| Ayrı izinler, SUPER_ADMIN örtük | 2 yeni izin; `CAMPAIGNS_READ` kuyruğu açamaz (API 403 + E2E `/yetkisiz`) |
| Karar auditli; ham veri audit özetinde yok | `PromotionEligibilityReview` (karar veren, zaman, gerekçe, hold); append-only |
| Karar sonrası tek dönüş, çift grant yok | koşullu `HELD → PENDING` + unique; eşzamanlı iki karar → 201 + 409; karar + 4 eşzamanlı worker → 1 grant/1 lot/1 sayaç |

## 3. Uygulama sırasında çıkan bulgular

- **B1 — Mevcut motor testleri kapıya takıldı (beklenen).** Giriş tetikleyicili grant senaryoları kayıtsız,
  doğrulanmamış sağlayıcılarla kuruluydu; kapı onları doğru olarak REVIEW/INELIGIBLE yaptı. Fixture'lar
  `declareBusinessRegistration` / `makePromotionEligible` ile "doğrulanmış + kayıtlı" hâle getirildi; iddialar
  değişmedi. **Ürün sonucu:** telefon doğrulamasını koşul olarak istemeyen bir giriş kampanyası artık telefonsuz
  sağlayıcıya grant vermez (önkoşul).
- **B2 — `PATCH /providers/:id` eski vergi alanlarını siliyordu.** Tam değiştirme + formun bu alanları göndermemesi.
  Düzeltildi (alan yoksa değişmez); test var.
- **B3 — `PHONE_SHARED` sinyali uygulanmadı.** `PhoneVerification.consumedAt` hem doğrulanan hem yenisiyle geçersizlenen
  kodda doluyor; "güvenilir sinyal" değil (tasarım §0).
- **B4 — `REGISTRATION_SHARED` iki hesabı birden incelemeye alır.** Aynı numarayı iki hesap beyan ettiyse, hiçbiri
  henüz promosyon almamış olsa da ikisi de REVIEW olur — kasıtlı ("şüpheli işletme bilgisi").
- **B5 — Sayaç geri alınmaz.** Revoke edilen bir grant sayaçta kalır (kampanya `redemptionCount` ile aynı ilke:
  kümülatif). Bir sonraki hesapta REVIEW üretir, hard reject değil.
- **B6 — Admin kuyruğu `admin/promotion-eligibility` altında**; `admin/campaigns/:id` onu yakalardı.
- **B7 — Admin sağlayıcı detayı rol atanmış hiçbir ADMIN'e açılmıyordu (PR-0'dan kalan hata).** Sayfa değerlendirme
  kartını `GET /providers/:providerId/reviews`'tan okuyor; o rotanın `ProviderAccessGuard`'ı yalnız sahip +
  SUPER_ADMIN kabul ediyor ve `apiFetch` 403'ü `/yetkisiz`e yönlendiriyor. E2E bunu yakaladı. Asgari düzeltme: kart
  yalnız SUPER_ADMIN için çekiliyor (kart bağlamdır, sayfanın konusu değil). Rolle değerlendirme okumanın düzgün
  yolu (`PROVIDER_REVIEWS_READ` ile admin rotası) ayrı iş.

## 4. Değişmeyenler

`PACKAGE_PAYMENT_SUCCEEDED` değerlendirmesi (kapı yok — test), `triggerEventKey` biçimleri, S2B1 grant primitive'i,
S3 revoke, S4 net iade, PR-A kanıt, PR-B iade akışı, `Session` yazımı/retention'ı, `PurchaseTermsAcceptance.clientIp`
erişimi, public projeksiyonlar.

## 5. Açık kararlar / release kapıları

- **RG-2 (açık, güncellendi):** tasarım §9 — kayıt numarası ve eski vergi numarası saklama süresi, TCKN işleme
  dayanağı ve aydınlatma metni, `Session.ipAddress` süpürücüsü (bugün hiç silinmiyor), snapshot fingerprint'lerinin
  saklama süresi, `SensitiveDataAccessLog` saklama süresi.
- **RG-4 (açık):** staging/prod için `PROMOTION_FINGERPRINT_KEY` üretilmeli ve gizli tutulmalı; rotasyon bir migration'dır.
  **Staging'e çıkmadan önce anahtar tanımlanmazsa API boot etmez.**
- **Açık işler:** `PACKAGE_PAYMENT_SUCCEEDED` kapısı · Lemon ödeme kimliği sinyali · clawback/`unrecoveredCreditBenefit` ·
  operatörün kaydı düzeltmesi/doğrulaması · VKN/MERSİS sağlaması · PR-D kanal.

## 6. E2E ve CI

- Yerel tam E2E (Chromium, `pnpm e2e`): **301 geçti / 1 hata** (8.8 dk). Hata yeni senaryodaydı ve B7'yi ortaya
  çıkardı; düzeltme sonrası `pnpm e2e provider-business-registration` **2/2**. Diğer 300 senaryoya dokunan tek değişiklik
  admin sağlayıcı detayındaki kart koşuludur (SUPER_ADMIN davranışı aynı).
- CI: PR açıldıktan sonra izlenir; **3/3 yeşil olmadan merge ve yerel eşitleme yapılmaz.**
