# CMP-006 PR-C — Kanonik işletme kaydı ve promosyon fraud uygunluğu

Tarih: 2026-09-23 · Taban: `main` @ `b4dc5f51` (PR #107 merge) · Branch: `claude/cmp-006-business-registration-fraud-bb7092` ·
Bağlayıcı üst belge: [CMP-006 S0](2026-09-22-cmp-006-s0-refund-rbac-fraud-channel-design.md) §5, §7, §9 (K), §10, §13 ·
Önceki dilimler: [PR-0 RBAC](2026-09-22-pr0-admin-rbac-design.md), [PR-A](2026-09-22-cmp-006-pr-a-package-refund-terms-design.md),
[PR-B](2026-09-23-cmp-006-pr-b-package-refund-requests-design.md).

**Kampanya motoru anahtarı (`campaignEngineEnabled`) ve `PURCHASE_TERMS_GATE` kapalı kalır.** Gerçek checkout, Lemon,
e-posta/SMS veya staging işlemi yok. Kampanya DSL'i (`campaign-rules.json`) **değişmez** (S0 D17).

---

## 0. Görev tanımının S0'dan ayrıldığı yerler (bu PR'ı bağlayan görev tanımıdır)

| S0 | Bu PR | Gerekçe |
| --- | --- | --- |
| Aynı kanonik kayıt ilk bonusu almışsa **INELIGIBLE** (`REGISTRATION_BONUS_CONSUMED`) | **REVIEW** (`REGISTRATION_PROMOTION_CONSUMED`), gerekçeli | Görev tanımı: "hard reject yerine gerekçeli REVIEW". Yanlış girilmiş numara/şube gerçek bir yanlış pozitiftir |
| `PRIOR_REFUND` **INELIGIBLE** | **REVIEW** (`PRIOR_PACKAGE_REFUND`) | Görev tanımının ilkesi: **risk sinyali otomatik INELIGIBLE üretmez.** Otomatik INELIGIBLE yalnız eksik **önkoşuldur** (§2.2) |
| `PHONE_SHARED` sinyali | **Yok** | Güvenilir kaynak yok: `PhoneVerification.consumedAt` hem doğrulanan hem yenisiyle geçersizlenen kodda doluyor, geçmiş doğrulamayı ayırt etmiyor. `User.phone @unique` eşzamanlı paylaşımı zaten imkânsız kılıyor |
| `SHARED_DEVICE` sinyali | **Yok** | "Yeni, izinsiz tarayıcı/device fingerprint toplama ekleme." Cihaz verisi toplanmıyor |
| `PAYMENT_IDENTITY` (Lemon `customer_id` HMAC'i) | **Yok** (açık iş) | Görev tanımı "mevcut güvenilir sinyaller" diyor; bu yeni bir veri toplama yüzeyi ve Lemon webhook sözleşmesi değişikliği. Ayrı dilim |
| `PRIOR_UNRECOVERED_BENEFIT` | **Yok** (açık iş) | Kolon PR-B'de doğmadı (clawback 0'a kilitli); okunacak veri yok |
| Kapı **her** tetikleyicide | **Yalnız giriş promosyonu tetikleyicileri:** `PROVIDER_APPROVED`, `PROVIDER_ELIGIBILITY_REACHED` | Görev tanımı "ilk sağlayıcı promosyonu". `PACKAGE_PAYMENT_SUCCEEDED` bonusu gerçek ödemeye bağlı ve ters işlemde S3 revoke'la zaten geri alınıyor; kapıyı oraya genişletmek ayrı bir ürün kararıdır (§10) |
| `CampaignRegistrationCounter` kayıt başına **tek satır** | **Kayıt × sağlayıcı** başına satır: `(type, fingerprint, fingerprintVersion, providerId)` | "Başka bir sağlayıcı bu kayıtla promosyon aldı mı?" sorusu, ham numara ve sağlayıcının *bugünkü* kaydı olmadan, yalnız sayaçtan cevaplanabilsin. Sağlayıcı sonradan numarasını değiştirse bile grant anındaki kayıt sayaçta kalır |
| Karar snapshot'ı event satırında (`eligibilitySignals`) | **Ayrı, append-only `PromotionEligibilityHold`** satırı | "Immutable snapshot" DB'de tutulsun: event satırı sık güncellenir; tetikleyiciyle değişmezliği ayrı tabloda zorlamak kolon düzeyi istisnadan basit |
| `SensitiveDataAccessLog` PR-0'da doğacaktı | **Bu PR'da doğar** | PR-0 tabloyu açmadı; ilk kullanıcısı bu PR |
| Admin `PUT …/business-registration` | **Yok** | Görev tanımı yazma yüzeyini başvuru + sağlayıcının kendi şirket bilgisi olarak sayıyor; operatör düzeltmesi ayrı dilim |
| Sağlayıcı kendi numarasını **maskesiz** görür | **Maskeli görür**, yeniden girerek değiştirir | `SOLE_PROPRIETOR_TR_ID` bir TCKN'dir; "maskesiz değer yalnız gerekli izinde". Ham numara API'den yalnız izinli admin rotasıyla çıkar |

## 1. Kanonik işletme kaydı

### 1.1 Model

```prisma
enum BusinessRegistrationType {
  TRADE_REGISTRY          // Ticaret sicil no
  MERSIS                  // MERSİS no (16 hane)
  TAX_NUMBER              // Vergi kimlik no (10 hane)
  CRAFTSMAN_REGISTRY      // Esnaf ve sanatkâr sicil no
  SOLE_PROPRIETOR_TR_ID   // Şahıs işletmesi — T.C. kimlik no (11 hane, sağlama haneli)
  NONE_DECLARED           // Beyan edilmedi — numara YOK
}

model ProviderBusinessRegistration {        // sağlayıcı başına en fazla bir satır
  providerId @unique, type,
  numberCanonical String?     // HAM — tek yer; hiçbir liste/detay select'i seçmez
  numberMasked String?        // son 2 hane dışında '*'
  fingerprint String?  fingerprintVersion Int?   // HMAC (§3)
  declaredByUserId, createdAt, updatedAt
  // CHECK: NONE_DECLARED ⇔ dört kolon NULL; diğer türlerde dördü NOT NULL
}
```

**Satır yoksa** kayıt **"belirsiz / eski kayıt"** (`UNSPECIFIED`) okunur. Migration **DML içermez**: hiçbir satır doğmaz,
`ProviderProfile.taxType/taxNumber` dönüştürülmez (S0 D20). Ayrı tablo seçimi bilinçli: `providerInclude` bir `include`
(tam satır) ve 7+ yanıt onu kullanıyor; ham numarayı `ProviderProfile` üzerine koymak onu bu yanıtların hepsine
sızdırırdı. Relation ancak açıkça seçilirse gelir ve biz yalnız `{ type, numberMasked, updatedAt }` seçeriz.

### 1.2 Normalizasyon ve doğrulama (tek kaynak `packages/shared/business-registration.json`)

1. NFKC (tam genişlikli rakamlar ASCII olur), ardından boşluk, `.`, `-`, `/` silinir.
2. Kalan yalnız `0-9` olmalı; aksi `BUSINESS_REGISTRATION_NUMBER_INVALID`.
3. Uzunluk: `TRADE_REGISTRY` 1–12, `MERSIS` 16, `TAX_NUMBER` 10, `CRAFTSMAN_REGISTRY` 1–12, `SOLE_PROPRIETOR_TR_ID` 11.
4. `SOLE_PROPRIETOR_TR_ID`: ilk hane ≠ 0 + T.C. kimlik sağlama haneleri (10. ve 11. hane). VKN (`TAX_NUMBER`) sağlaması
   **uygulanmadı** — algoritmayı doğrulanmış bir kaynağa bağlamadan gerçek VKN'leri reddetme riski alınmadı (§10).
5. `NONE_DECLARED` + numara (boş olmayan) → `BUSINESS_REGISTRATION_NUMBER_NOT_ALLOWED`; diğer tür + numara yok →
   `BUSINESS_REGISTRATION_NUMBER_REQUIRED`; numara var tür yok → `BUSINESS_REGISTRATION_TYPE_REQUIRED`.
6. Hata yanıtı **numarayı yansıtmaz** (ne ham, ne maskeli).

### 1.3 Yazma yüzeyleri

| Yüzey | Rota | Kural |
| --- | --- | --- |
| Açık başvuru | `POST /providers` | `businessRegistrationType` + `businessRegistrationNumber` (opsiyonel çift; ikisi de yoksa satır yazılmaz). Web formu türü **zorunlu** seçtirir |
| Davetli başvuru | `POST /provider-invites/applications` | Aynı |
| Sağlayıcının kendi şirket bilgisi | `GET/PUT /providers/me/business-registration` | Yalnız `PROVIDER` rolü, yalnız kendi profili (oturumdan). Operatör bu rotadan yazamaz |

Her yazım (ilk dahil) append-only `ProviderBusinessRegistrationChange` satırı yazar: aktör, önceki/yeni **tür +
fingerprint + sürüm** — ham ya da maskeli numara **yok**. Aynı değerin tekrar kaydı değişiklik satırı üretmez.

**Mevcut hata (düzeltildi):** `PATCH /providers/:id` bir tam değiştirmedir ve web düzenleme formu `taxType/taxNumber`
göndermediği için her sağlayıcı kaydı eski vergi alanlarını `NULL`'a çekiyordu. Görev tanımı "eski kayıtlar dürüstçe
kalsın" dediği için: gövdede **yoksa** bu iki alan artık **değişmez** (açıkça `null` gönderen hâlâ temizler).

### 1.4 Okuma yüzeyleri ve sızıntı matrisi

| Yüzey | Tür | Numara | Eski `taxNumber` |
| --- | --- | --- | --- |
| Public profil / vitrin / SEO / teklif / iletişim paylaşımı | — | — | — (allow-list, değişmedi) |
| Sağlayıcı: `GET /providers/me/business-registration`, `GET /providers/:id` (sahibi) | ✅ | **maskeli** | **maskeli** (`taxNumberMasked`) |
| Admin liste `GET /providers` (`PROVIDERS_READ`) | ✅ | **maskeli** | **yok** |
| Admin detay `GET /providers/:id/admin-detail` (`PROVIDERS_READ_DETAIL`) | ✅ | **maskeli** | **maskeli** |
| Staff `GET /providers/:id` | ✅ | **maskeli** | **maskeli** |
| **`GET /providers/:id/business-registration/raw`** | ✅ | **ham** | **ham** |

Ham rota `PROVIDER_REGISTRATION_READ_SENSITIVE` ister; **her çağrı**, yanıttan önce ve aynı transaction'da
`SensitiveDataAccessLog` satırı yazar (aktör, sağlayıcı, okunan alan adları, zaman — **değer yok**). Yanıt
`Cache-Control: no-store`. Satır yoksa ve eski alanlar boşsa da okuma denemesi kaydedilir (neye bakıldığı bilgisi).

`SOLE_PROPRIETOR_TR_ID`: ham değer hiçbir log (`Logger`), e-posta, bildirim, audit özeti, hata mesajı veya kampanya
snapshot'ına yazılmaz. Test: tüm yeni tabloların JSON/metin kolonlarında ham numara string araması (T-LEAK).

## 2. Promosyon fraud uygunluğu

### 2.1 Tek kanonik sonuç

`PROVIDER_PROMOTION_ELIGIBLE = ELIGIBLE | REVIEW | INELIGIBLE` — `promotion-eligibility.ts` içindeki **saf** `decide()`
fonksiyonu + onu besleyen okuyucu (`PromotionEligibilityReader`). Motorun **önünde**, boru hattının 4. adımından
(pencere + koşul) sonra, 5. adımdan (sıralama + grant) önce; yalnız giriş tetikleyicilerinde ve yalnız en az bir
uygun aday varken çalışır (aday yoksa operatöre boş iş üretilmez).

### 2.2 Sinyaller ve karar matrisi

| Kod | Kaynak | Etki |
| --- | --- | --- |
| `NO_ACCOUNT` | `ProviderProfile.userId IS NULL` | **INELIGIBLE** (önkoşul) |
| `PROVIDER_NOT_APPROVED` | `status ≠ APPROVED` | **INELIGIBLE** (önkoşul) |
| `EMAIL_UNVERIFIED` | `User.emailVerifiedAt IS NULL` | **INELIGIBLE** (önkoşul) |
| `PHONE_UNVERIFIED` | `User.phoneVerifiedAt IS NULL` | **INELIGIBLE** (önkoşul) |
| `REGISTRATION_UNSPECIFIED` | kayıt satırı yok (eski kayıt) | **REVIEW** |
| `REGISTRATION_NONE_DECLARED` | `type = NONE_DECLARED` | **REVIEW** — şahıs/esnaf dışlanmaz |
| `REGISTRATION_PROMOTION_CONSUMED` | Sayaçta aynı `(type, fingerprint, version)` ile **başka** sağlayıcının grant'i var | **REVIEW** (hard reject değil) |
| `REGISTRATION_SHARED` | Başka bir sağlayıcının **bugünkü** kaydı aynı fingerprint | **REVIEW** (şüpheli işletme bilgisi) — iki hesap aynı numarayı beyan ettiyse **ikisi de** incelemeye düşer |
| `PRIOR_PACKAGE_REFUND` | `PackageRefundRequest.status = SETTLED` ∨ `PackagePurchase.status = REFUNDED` ∨ `manualReviewAt` dolu | **REVIEW** |
| `SHARED_IP` | Bu hesabın bir oturum IP'si, başka bir sağlayıcı hesabının oturum IP'siyle eşit (`Session.ipAddress`) | **Yalnız katkı** — tek başına sonuç değiştirmez |

**Öncelik:** herhangi bir önkoşul eksikse `INELIGIBLE`; yoksa en az bir *bağımsız* REVIEW sinyali varsa `REVIEW`;
yoksa `ELIGIBLE`. `SHARED_IP` bağımsız değildir: yalnız başka bir REVIEW sinyali varken snapshot'a gerekçe olarak
eklenir, tek başına `ELIGIBLE`'ı değiştirmez ve **hiçbir koşulda** `INELIGIBLE` üretmez (S0 D18).

**Otomatik `INELIGIBLE` kalıcı değildir.** Önkoşul eksikliği bir risk yargısı değil "henüz değil"dir: event
`EVALUATED` olur ve aynı anahtarın yeniden yükselmesi (ör. telefon doğrulanınca `PROVIDER_ELIGIBILITY_REACHED`) onu
bugünkü gibi yeniden açar. Kalıcı olan yalnız **insanın** kararıdır (§2.4).

**Doğrulama sıraları:** e-posta → telefon → onay; onay → e-posta → telefon; telefon → onay → e-posta vb. her sırada
kapı yalnız **son** fact düştüğünde `ELIGIBLE/REVIEW` üretir, öncekilerde `INELIGIBLE` + yeniden açılma (test T-ORDER).

### 2.3 IP sinyali (RG-2)

- Kaynak yalnız **mevcut** `Session.ipAddress`; yeni toplama yok, `PurchaseTermsAcceptance.clientIp` **okunmaz**
  (S0 §5 kural 3: o IP'nin tek amacı sözleşme kabul ispatıdır).
- Eşitlik SQL'de hesaplanır; uygulamaya dönen eşleşen IP değeri **yalnız** HMAC'lenmek için bellekte kalır.
- Snapshot'a `ipFingerprints: ["v1:<hex>"…]` (en fazla 3) + `otherProviderCount` yazılır — **ham IP asla**.
- `Session` satırları bugün **hiç silinmiyor**; retention kararı bu PR'da **alınmadı** (RG-2, §9).

### 2.4 Hold, snapshot, insan kararı

```
PENDING ─claim─▶ PROCESSING ─gate=REVIEW─▶ HELD_FOR_REVIEW ──(karar ELIGIBLE)──▶ PENDING ─▶ … ─▶ SETTLED | EVALUATED
                                   │                        └─(karar INELIGIBLE)─▶ EVALUATED
                                   └─gate=INELIGIBLE─▶ EVALUATED (yeniden yükselme açar)
```

- `CampaignTriggerEventStatus += HELD_FOR_REVIEW`. Worker'ın claim sorgusu yalnız `PENDING/RETRY_WAIT/PROCESSING`
  alır; **held event asla claim edilmez**, `nextAttemptAt` ne olursa olsun. `ensurePendingEvent` yalnız `EVALUATED`'ı
  yeniden açar; held event yeniden yükselince **held kalır** (yalnız `lastSeenAt`).
- `CampaignEvaluationOutcome += PROMOTION_REVIEW_HELD, PROMOTION_INELIGIBLE`; her aday için bir log satırı,
  `reasonCode` = ilk sinyal kodu (kapalı küme).
- **Snapshot:** `PromotionEligibilityHold { triggerEventId @unique, providerId, signals Json, snapshotVersion, heldAt }`
  — append-only (UPDATE/DELETE tetikleyiciyle reddedilir). `signals` kapalı kodlar + sayılar + HMAC fingerprint'leri;
  ham numara/IP/telefon **yok**. Bir event en fazla bir kez hold edilir (karar satırı varken motor yeniden hesaplamaz).
- **Karar:** `PromotionEligibilityReview { triggerEventId @unique, holdId @unique, decision ELIGIBLE|INELIGIBLE,
  reason (10–1000, CHECK), decidedById, decidedAt }` — append-only. Karar satırının kendisi audit'tir (aktör, an,
  gerekçe, dayanak hold). Ham kayıt/ağ sinyali karar satırına yazılmaz; gerekçe serbest metindir ve UI uyarır.
- `POST /admin/campaigns/eligibility-holds/:eventId/decision` (`PROMOTION_ELIGIBILITY_REVIEW`), Serializable:
  karar satırı + koşullu `updateMany(status = HELD_FOR_REVIEW)` → `ELIGIBLE` ise `PENDING` (`nextAttemptAt = now`),
  `INELIGIBLE` ise `EVALUATED` + `PROMOTION_INELIGIBLE` log (`reasonCode = HUMAN_DECISION`). Koşullu güncelleme 0
  satır dönerse veya `@unique` çakışırsa **409 `ELIGIBILITY_DECISION_ALREADY_RECORDED`** — ikinci karar, eşzamanlı
  karar ve karar sonrası tekrar aynı sonucu verir. Motor anahtarını okumaz (karar bir muhasebe değil, bir kayıttır).
- **Karar sonrası motor:** event'in karar satırı varsa kapı **yeniden hesaplanmaz**: `ELIGIBLE` → grant yoluna devam;
  `INELIGIBLE` → `PROMOTION_INELIGIBLE` (`HUMAN_DECISION`), grant yok — sonraki yeniden yükselmelerde de.
  Event karar sonrası **yalnız bir kez** `PENDING`'e döner; grant'in tekilliği mevcut `(campaignId, triggerEventKey)`
  unique'i, `settledRedemptionId @unique` ve worker lease'iyle korunur — aynı grant/lot ikinci kez oluşamaz.

### 2.5 Kayıt sayacı

`CampaignRegistrationCounter { registrationType, fingerprint, fingerprintVersion, providerId, redemptionCount,
firstRedemptionId, lastRedemptionId, … } @@unique([registrationType, fingerprint, fingerprintVersion, providerId])`.

- **Yalnız gerçek grant'te artar:** motorun aday savepoint'i içinde, `grantPromoCreditLot` ve `settleEvent`'ten
  sonra; limit reddi, `P2002`, hata veya rollback sayacı geri alır. `REVIEW`, `INELIGIBLE` ve hata hiç dokunmaz.
- Sağlayıcının kaydı yoksa / `NONE_DECLARED` ise (ancak insan `ELIGIBLE` dediyse grant olur) sayaç satırı yazılmaz.
- Ham numara hiçbir kolonda yok (T16). Sayaç yalnız giriş tetikleyicilerinin grant'lerini sayar (kapının kapsamı).
- **Aynı sağlayıcının ikinci giriş bonusu** yine mevcut `maxRedemptionsPerProvider` + anahtar tekilliğiyle engellenir;
  kayıt sayacı bunun yerine geçmez, yanına eklenir.

## 3. Fingerprint anahtarı (RG-4)

`PROMOTION_FINGERPRINT_KEY` (≥32 karakter) + `PROMOTION_FINGERPRINT_KEY_VERSION` (pozitif tamsayı, varsayılan 1).
`HMAC-SHA256(key, "business-registration:" + type + ":" + canonical)`, IP için `"session-ip:" + ip` (alan ayrımı).

| Ortam | Anahtar yoksa |
| --- | --- |
| `NODE_ENV=test` veya `APP_ENVIRONMENT=local` | Sabit, depoda yazılı **geliştirme anahtarı** (yalnız yerel/test) |
| `staging`, `production`, tanımsız (`= production`) | **Boot reddi** (değer değil, değişken adı loglanır) |

Yerel stack değersiz `.env` ile boot eder (`docker-compose.local.yml` zaten `APP_ENVIRONMENT=local`);
`docker-compose.yml` iki değişkeni boş varsayılanla geçirir. **Anahtar/sürüm değişimi bir migration'dır**:
sayaç ve kayıt fingerprint'leri ham numaradan yeniden hesaplanmadan anahtar değiştirmek, aynı işletmeye yeni bir
giriş bonusu açar (S0 §5 kural 2).

## 4. İzinler (80 → 82)

| İzin | Rotalar |
| --- | --- |
| `PROVIDER_REGISTRATION_READ_SENSITIVE` | `GET /providers/:providerId/business-registration/raw` |
| `PROMOTION_ELIGIBILITY_REVIEW` | `GET /admin/campaigns/eligibility-holds`, `GET …/:eventId`, `POST …/:eventId/decision` |

Kuyruk okuması da `PROMOTION_ELIGIBILITY_REVIEW` ister: snapshot, sağlayıcı başına risk gerekçesidir ve
`CAMPAIGNS_READ` taşıyan her role açılması gerekmiyor. Mevcut event listesi (`CAMPAIGNS_READ`) held durumunu
görür, snapshot'ı görmez. `SUPER_ADMIN` her ikisine örtük sahiptir. `PROVIDERS_READ_DETAIL` artık ham vergi
numarası taşımaz (enum yorumu güncellendi).

## 5. UI

- **Web başvuru** (açık + davetli): "İşletme kaydı" bölümü — tür seçimi (zorunlu, `NONE_DECLARED` dahil) + numara;
  "Beyan etmiyorum" seçilince numara alanı gizlenir ve gönderilmez. Hata kodları `?error=registration-*` ile.
- **Web sağlayıcı paneli:** `/providers/[id]` İşletme bilgileri kartında tür + maskeli numara ("Eski kayıt: belirtilmemiş"
  durumu dahil) ve `/providers/[id]/edit` altında ayrı "İşletme kaydı" formu (`PUT /providers/me/business-registration`).
- **Admin sağlayıcı detayı:** "İşletme kaydı" kartı (tür, maskeli numara, durum rozeti) + eski "Vergi bilgisi" kartı
  "Doğrulanmamış eski beyan" etiketiyle ve maskeli; "Ham değeri göster" düğmesi yalnız
  `PROVIDER_REGISTRATION_READ_SENSITIVE` ile görünür, her tıklama audit'li API çağrısıdır.
- **Admin liste:** tür + maskeli numara sütunu.
- **Admin "Uygunluk incelemesi" kuyruğu** (`/campaigns/eligibility-holds`, nav: `PROMOTION_ELIGIBILITY_REVIEW`): held
  event'ler, sinyal kodlarının Türkçe açıklamaları, detayda karar formu (ELIGIBLE/INELIGIBLE + gerekçe 10–1000).

## 6. Migration K

`20260923180000_add_business_registration_and_promotion_eligibility` — iki `AdminPermission` değeri,
`CampaignTriggerEventStatus += HELD_FOR_REVIEW`, iki `CampaignEvaluationOutcome` değeri, `BusinessRegistrationType`,
`PromotionEligibilityDecision`, `SensitiveDataSubject`, `ProviderBusinessRegistrationChangeActor` enum'ları;
`ProviderBusinessRegistration`, `ProviderBusinessRegistrationChange`, `SensitiveDataAccessLog`,
`CampaignRegistrationCounter`, `PromotionEligibilityHold`, `PromotionEligibilityReview`; CHECK'ler ve append-only
tetikleyiciler. **DML yok**, `SET NOT NULL` yok. Dry-run: `docs/superpowers/plans/2026-09-23-cmp-006-pr-c-migration-k-dryrun.txt`.

## 7. Test planı (zorunlu → dosya)

| # | Test | Dosya |
| --- | --- | --- |
| T-NORM | Her tür: geçerli, eksik, uyumsuz, fazla/az hane, ayraç/NFKC normalizasyonu, TCKN sağlaması, NONE_DECLARED + numara | `business-registration-rules.spec.ts` (saf) |
| T-APP | Açık/davetli başvuru her türle; eksik tür/numara 400; satır yok = eski kayıt; PATCH eski vergi alanlarını silmez | `provider-business-registration.spec.ts` |
| T-MASK | Sızıntı matrisi §1.4: public, owner, staff, liste, detay, contact-reveal yanıtlarında ham numara yok | aynı |
| T-RAW | Ham rota: izinsiz 403 (liste/detay izni yetmez), SUPER_ADMIN geçer, her okuma bir audit satırı, audit'te değer yok, `no-store` | aynı |
| T-LEAK | Ham numara (özellikle TCKN) hiçbir yeni tablo kolonunda, sayaçta, hold snapshot'ında, değişiklik satırında yok | aynı + eligibility |
| T-GATE | `decide()` matrisi: her önkoşul, her REVIEW sinyali, yalnız SHARED_IP → ELIGIBLE, SHARED_IP + başka → REVIEW, hiçbir risk sinyali INELIGIBLE değil | `promotion-eligibility-decide.spec.ts` (saf) |
| T-TWO | Aynı kayıt iki sağlayıcı: ilki grant, ikincisi REVIEW (`REGISTRATION_PROMOTION_CONSUMED`); yalnız aynı IP → grant | `promotion-eligibility.spec.ts` |
| T-ORDER | Doğrulama sıraları; NONE_DECLARED → REVIEW | aynı |
| T-HOLD | REVIEW → HELD, sayaç/bütçe/limit tüketilmez, worker claim etmez (zaman ileri alınsa da), yeniden yükselme held bırakır | aynı |
| T-DEC | REVIEW → ELIGIBLE → grant + sayaç +1; REVIEW → INELIGIBLE → grant yok, yeniden yükselmede de yok; gerekçesiz 400; ikinci karar 409; eşzamanlı iki karar tek satır; karar + eşzamanlı iki worker tek grant | aynı |
| T-CNT | Sayaç yalnız gerçek grant'te artar (limit reddi, hata, REVIEW, INELIGIBLE → değişmez); ikinci giriş bonusu yok | aynı |
| T-RBAC | Rota haritası 82 izin; yeni rotalar izinsiz 403 | `admin-rbac-route-map.spec.ts`, `promotion-eligibility.spec.ts` |
| T-BOOT | Anahtar: local/test varsayılan, staging/prod boşsa boot reddi, kısa anahtar reddi, sürüm doğrulaması | `promotion-fingerprint-config.spec.ts` |
| Gerileme | Mevcut başvuru, e-posta/telefon doğrulama, kampanya motoru, kredi, paket iade spec'leri — giriş tetikleyicili grant fixture'ları doğrulanmış + kayıtlı sağlayıcıya geçirildi (`declareBusinessRegistration`, `makePromotionEligible`) | mevcut spec'ler |
| E2E | Başvuruda tür+numara (uyumsuz numara reddi, NONE_DECLARED numara alanını gizler) → admin detay/listede maskeli, ham göster yalnız izinli + audit · held kuyruğunda gerekçeli tek karar, `CAMPAIGNS_READ` kuyruğu açamaz · mevcut başvuru E2E'leri tür seçimiyle güncellendi | `e2e/tests/provider-business-registration.spec.ts` |

## 8. Değişmeyenler

Kampanya DSL'i ve katalog, `triggerEventKey` biçimleri, `PACKAGE_PAYMENT_SUCCEEDED` değerlendirmesi, S2B1 grant
primitive'i, S3 revoke, S4 net iade, PR-A kabul kanıtı, PR-B iade akışı, `Session` yazımı ve retention'ı,
`PurchaseTermsAcceptance.clientIp` erişimi.

## 9. RG-2 — KVKK açık kararı (güncellendi)

| Veri | Bu PR'daki durum | Açık karar |
| --- | --- | --- |
| `ProviderBusinessRegistration.numberCanonical` (TCKN dahil) | Tek yerde, yalnız izinli ham rota, her okuma `SensitiveDataAccessLog` | Saklama süresi (profil kapanınca?), aydınlatma metni, TCKN için açık rıza/meşru menfaat dayanağı |
| `ProviderProfile.taxNumber` (eski) | Tüm yanıtlarda maskeli, ham yalnız aynı izinli rota + audit | Eski serbest metnin ne zaman silineceği |
| `fingerprint` (işletme, IP) | Anahtarlı HMAC, geri döndürülemez ama **anahtar sahibi için eşleştirilebilir** → takma adlı kişisel veri | Snapshot'lardaki IP fingerprint'lerinin saklama süresi |
| `Session.ipAddress` | **Hiç silinmiyor** (bugünkü durum), bu PR yalnız eşitlik için okur | Retention süresi + süpürücü; o gelene kadar IP sinyalinin geriye bakış penceresi sınırsız |
| `SensitiveDataAccessLog` | Süresiz, append-only | Audit saklama süresi |

**RG-2 kapanmadan motor açılmaz** (RG-5). RG-4 (anahtar yönetimi) de üretim ön koşuludur.

## 10. Açık işler

`PACKAGE_PAYMENT_SUCCEEDED` bonusuna kapı · Lemon ödeme kimliği sinyali · `unrecoveredCreditBenefit` (clawback) ·
operatörün kanonik kaydı düzeltmesi/doğrulaması (`verifiedAt`) · VKN/MERSİS sağlama algoritması (doğrulanmış kaynakla) ·
anahtar rotasyon migration'ı (RG-4) · PR-D kanal.
