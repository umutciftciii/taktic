# CMP-006 S0 — Teslim raporu

Tarih: 2026-09-22 · Branch: `claude/refund-policy-campaign-design-dfb3d6` ·
Taban: `origin/main` @ `54183784` (PR #102 merge) · Worktree temiz doğrulandı, `merge-base == origin/main`.
Tasarım notu: [`docs/superpowers/specs/2026-09-22-cmp-006-s0-refund-rbac-fraud-channel-design.md`](../specs/2026-09-22-cmp-006-s0-refund-rbac-fraud-channel-design.md)

## 1. Bu PR'da ne var, ne yok

**Var:** iki markdown dosyası — tasarım notu ve bu rapor.

**Yok:** kod, migration, Prisma şema değişikliği, test, `.env`, container, `docker-compose*.yml`, sözleşme metni,
seed, gerçek veri. `git diff --stat` yalnız `docs/` altını gösterir.

**Kampanya motoru:** `OperationsSettings.campaignEngineEnabled` bu PR'da okunmaz, yazılmaz, açılmaz. Yerel ve
staging'de **kapalı** kalır. Planlanan PR-0…PR-D dilimlerinin hiçbiri de açmaz (tasarım RG-5).

## 2. Kullanıcı kararlarının nereye işlendiği

| Kullanıcı kararı | Tasarımda |
| --- | --- |
| Para hareketi dışarıda + webhook mutabakatı | D3, §3.1, §3.5 |
| Maker-checker CHECK'i güçlendirilsin (NULL kaçağı) | **D5**, §3.1 tablosu, T1–T2 |
| `SETTLED`'a yalnız webhook geçirsin | **D4**, §3.1, §10.1 ("`SETTLED` yazan rota yoktur"), T3 |
| Bir webhook olayı en fazla bir talebi settle etsin | **D6**, §9 Migration J, T4–T5 |
| Talebi olmayan dış iade mevcut S3 revoke yolunu çalıştırsın | **D7**, §3.3, §3.5, T6 |
| Rol dinamik, izin kataloğu sabit | **D11**, §6.1, §6.4 ("izin üreten rota yoktur"), T15 |
| `SUPER_ADMIN` atamasız tüm izinlere sahip | **D12**, §6.2, T11 |
| Panel erişimini API zorlasın | **D12**, `AdminAccessGuard`, T12, E1 |
| Sayaç ham numara taşımasın, sürümlü HMAC | **D19**, §5, §7.5, T16, RG-4 |
| Eski `taxType/taxNumber` dönüştürülmesin | **D20**, §9 Migration K (DML yok), T17 |
| Destek girişi PR-B'nin bağlayıcı parçası | **D14**, §10.1, §10.2, §12 PR-B, E4 |
| Aynı paket için açık talep tekil | **D15**, §9 Migration J, T7 |
| `HELD_FOR_REVIEW` izinli ve auditli çözülsün, snapshot saklansın | **D21**, **D22**, §7.4, T19–T21, E7 |
| PR sırası: RBAC → iade/onay → destek/fraud → kanal | §12 (PR-0 → PR-A → PR-B → PR-C → PR-D) |
| **`ADMIN` personel hesabı türüdür; davetle doğar, atamasız giremez, çift kimlik yok** | **D12a**, **D12b**, §6.1, T12–T12b, RG-6 |
| **Birleşik kabul metni üç belgenin tam metnini içersin; hash ona ait olsun; geçmiş kanıt değişmesin** | **D8a**, §4.1, T8a–T8c |
| **Geri alım varsayılanı 0, elle ve gerekçeli; eksik kısım borç değil `unrecoveredCreditBenefit`** | **D27**, **D27a**, **D27b**, §7.2, §7.3, T27–T27c |
| **PR-0 öncesi eşleme rota + HTTP metodu + aksiyon düzeyinde olsun** | §6.3 uyarısı, §12 ön koşulu, T12c, **RG-7** |

## 3. Envanterin tasarımı değiştiren bulguları

| # | Bulgu | Etkisi |
| --- | --- | --- |
| E1 | `refund-policy` adı **teklif kredisi** iadesi için kullanımda (`offers/refund-policy.ts`, public `GET /refund-policy`, S4 `OfferRefundSettlement`) | Ayrı ad alanı zorunlu → **D0** |
| E2 | `PaymentProviderPort` iade/capture yeteneği taşımıyor (`payment-provider.port.ts:11`) | Para hareketi dışarıda → **D3** |
| E3 | Teklif kredisi checkout'unda hiç onay kutusu yok; web'de tek sözleşme sayfası var | Üç yeni sayfa + kanıt modeli → **D8, D9**, §4.4 |
| E4 | RBAC tek `UserRole` enum'u; 28 controller'da 72 `@Roles(SUPER_ADMIN)`; `roles.guard.ts:11` izin okumuyor; `nav.ts` statik | **Kanıt: dinamik izin desteklenmiyor** → PR-0 bağımsız temel dilim |
| E5 | `taxType/taxNumber` serbest metin, `@IsString()` dışında doğrulama yok, web başvuru formunda toplanmıyor | Kanonik kayıt sıfırdan; eski alanlar dokunulmaz → **D20** |
| E6 | Lemon webhook'u hiçbir müşteri/ödeme kimliği çıkarmıyor (`lemon-squeezy.webhook.ts:137`) | "Ödeme sinyali" bugün yok; HMAC'li `paymentIdentityHash` PR-C'de eklenecek → §7.2 |
| E7 | `PROVIDER_APPROVED` olayını yazan istek **operatörün** isteği (`providers.service.ts:1043`) | Kanal, onayın değil **başvurunun** kanalından türer → §8.2 |
| E8 | `fact-source-registry.ts` + `FACT_SOURCE_UNAVAILABLE` hazır örüntü | `ChannelSourceRegistry` + `CHANNEL_SOURCE_UNAVAILABLE` birebir ikiz → **D26** |
| E9 | `ShowcasePackageTermsAcceptance` + `PackagePurchase.showcasePackageTermsAcceptanceId` aynı tx'te yazılıyor | Kanıt bağlama örüntüsü hazır → **D9** |
| E10 | IP/UA okuması üç yerde kopyalanmış (`phone-verification.controller.ts:65`, `showcase-public.controller.ts:141`, `turnstile.guard.ts:108`) | Tek `readRequestMeta` helper'ı; mevcut üç kopya **bu dilimde değişmez** → **D10** |

## 4. En önemli beş invariant

1. **`triggerEventKey` kanal içermez (I1–I3).** İçerseydi kanalın farklı türetilmesi ikinci anahtar → ikinci grant
   üretirdi. Kanal event satırının değişmez bir alanıdır; `ensurePendingEvent` onu yalnız `create`'te yazar.
2. **Maker-checker DB'de, NULL kaçağı kapalı (D5).** `approvedById <> createdById` tek başına yetmez: `NULL`
   karşılaştırması UNKNOWN döner ve CHECK'i geçer. `IS NOT NULL` konjunktı şart.
3. **`SETTLED`'a yalnız webhook geçirir (D4).** "İade yaptım" beyanı ile "iade gerçekten oldu" farklı olgulardır;
   sistemin sakladığı ikincisidir ve DB yarısı `settledByWebhookEventId IS NOT NULL` CHECK'idir.
4. **Kabul kanıtı link değil metindir (D8a).** `documentTextSnapshot` üç belgenin kabul anındaki tam metnini
   taşır, `documentSha256` o birleşik içeriğin özetidir ve satırın `update` yolu yoktur. Sayfa sonradan değişse
   "neyi kabul etti" sorusu cevaplanabilir kalır.
5. **Geri alım varsayılanı sıfırdır ve borç üretmez (D27, D27a).** "Onayla" düğmesi kendiliğinden bakiye
   düşürmez; miktar ikinci yetkilinin gerekçeli kararıdır, bakiye eksiye düşmez ve karşılanamayan kısım
   `unrecoveredCreditBenefit` olarak **kayıt**tır — tahsil edilmez, yalnız sonraki uygunlukta `REVIEW` sinyalidir.

## 5. Bilerek kapsam dışı

`PaymentProviderPort`'a iade çağrısı · self-service para iadesi · kısmi iade · teklif kredisi iade politikası,
S4 net-iade ve S3 revoke'a dokunma · kampanya DSL'ine yeni koşul türü · `taxType/taxNumber` taşıma/silme ·
mobil istemci · `Session.ipAddress/userAgent` retention değişikliği.

## 6. Açık riskler ve bağımlılıklar

| # | Risk | Durum |
| --- | --- | --- |
| R1 | "Anında ifa"nın cayma hakkına etkisi hukuki görüş gerektiriyor | **RG-1** — PR-A kodu merge edilebilir, sözleşme metni placeholder kalır |
| R2 | IP/UA ve sicil numarası KVKK yükümlülüğü doğuruyor | **RG-2** — §5 saklama/maskeleme/audit kuralları |
| R3 | Webhook hiç gelmezse `APPROVED_PENDING_SETTLEMENT` süresiz bekler | **RG-3** — SLA + `SETTLEMENT_ABANDONED` prosedürü yazılacak |
| R4 | HMAC pepper'ının sessiz değişimi aynı işletmeye ikinci ilk-bonus açar | **RG-4** — rotasyon bir migration'dır, `.env` değişikliği değil |
| R5 | PR-0, 72 rotaya dokunduğu için en geniş regresyon yüzeyi | İzin matrisi tablo testi (T14) + E2E E1/E2 |
| R6 | `main` CI'da `account-email-role-conflict` yarış flake'i biliniyor | Bu PR kod çalıştırmıyor; CI kırmızısı görülürse flake olarak değerlendirilir |

## 7. Sıradaki iş

**PR-0 — RBAC temeli.** Tasarım §6, §9 Migration H, §11.1 T11–T15 + T12a–T12c, §11.2 E1–E2.

**Kod yazılmadan önceki bağlayıcı ön koşul (RG-7):** 72 `@Roles(UserRole.SUPER_ADMIN)` kullanımının her biri
**rota yolu + HTTP metodu + aksiyon** üçlüsüyle listelenip tek tek bir `AdminPermission` değerine eşlenecek ve
eşleme `docs/superpowers/plans/<tarih>-pr0-route-permission-map.md` olarak depoya yazılacak. Controller düzeyinde
toplu eşleme yapılmayacak: aynı controller'ın `GET :id`'si ile `DELETE :id`'si veya `POST :id/approve`'u aynı izne
bağlanırsa, okuma izni verilen bir role sessizce yıkıcı aksiyon açılır. Tasarımın §6.3 tablosu bu eşlemenin
**alt sınırıdır**, yerine geçmez; eşleme tablosu T12c'nin girdisidir.

## 8. CI

PR [#103](https://github.com/umutciftciii/taktic/pull/103) · run
[35734636478](https://github.com/umutciftciii/taktic/actions/runs/35734636478) · **3/3 geçti**.

| Job | Sonuç |
| --- | --- |
| `typecheck · lint · test · build` | pass |
| `e2e (chromium)` | pass |
| `e2e (webkit · sign-in and mobile shells)` | pass |

Bu PR kod çalıştırmıyor (diff yalnız `docs/`); CI, `main`'in yeşil kaldığını doğrular.
Merge, deploy ve yerel eşitleme **yapılmadı** — görev tanımı gereği.
