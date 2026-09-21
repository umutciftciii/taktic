# TEST-FLAKE-002 — Teslim raporu: campaign revoke eşzamanlı webhook testi gerçek retry sözleşmesine hizalandı

Tarih: 2026-09-22 · Branch: `claude/test-flake-002-campaign-revoke-retry` · Taban: `origin/main` @ `c63e459a` (PR #100 merge) ·
Kapsam: **yalnız test** — `apps/api/test/campaign-refund-revoke.spec.ts` içindeki tek bir `it` bloğu + bu rapor.

PR: https://github.com/umutciftciii/taktic/pull/101 (açık; **merge edilmedi**) · Test commit'i `528acc4c` · CI: §4

Üretim kodu, migration, API sözleşmesi, `runSerializable` retry bütçesi, webhook HTTP davranışı, env, compose, deployment
**değişmedi** (`git diff --stat origin/main` yalnız spec + rapor). Merge, yerel migration/eşitleme, staging **yapılmadı**;
PR #100'ün yerel eşitlemesi bu iş bitene kadar bekletildi ve hâlâ bekliyor.

---

## 1. Neden ürün değil, test hatalıydı

Eski test dört paralel `order_refunded` teslimin **ilk denemede** dördünün de 200 dönmesini bekliyordu
(`expect(response.status).toBe(200)`). Kanonik sözleşme bunu vaat etmiyor:

| Sözleşme maddesi | Kaynak |
| --- | --- |
| Dört teslim aynı `CampaignRevokeDailyCounter(campaignId, day)` satırını (ve eşik aşımında aynı `Campaign` satırını) Serializable izolasyonda günceller; PostgreSQL kaybedene 40001 (Prisma P2034) fırlatır. | `campaign-revoke.service.ts` (upsert+increment, P2002→P2034 replay), CMP-001 §10.3 |
| `runSerializable` yalnız P2034'ü, 3 deneme bütçesiyle (15/30 ms + jitter) yeniden oynatır; bütçe biterse `409 CONCURRENT_MODIFICATION`. | `common/serializable-transaction.ts:60-100` |
| Webhook bu 409'da committed duruma bakar: olay `MANUAL_REVIEW_REQUIRED` değilse 409 **rethrow** edilir — çünkü bu süreç hiçbir şey commit etmemiştir ve `duplicate` demek sağlayıcıya yalan olur. | `payments-webhook.service.ts` `flagForManualReview` → `reportFlaggedOrRethrow` (satır ~769, ~903) |
| Lemon Squeezy non-2xx'i yeniden gönderir; yeniden teslim aynı `eventKey` ile idempotent tamamlanır. | `payments-webhook.service.ts` sınıf yorumu; PR #100 raporu §3 |

Yani "ilk turda 4×200" bir **zamanlama** özelliğiydi: yerelde retry bütçesi çekişmeyi hep çözüyor (12/12 koşumda doğal 409 yok),
CI'ın tmpfs Postgres'inde ise bazen üçüncü deneme de kaybediyor ve test `expected 409 to be 200` ile düşüyordu. Ürün tam
olarak tasarlandığı gibi davranıyordu; test sözleşmenin izin verdiği bir sonucu hata sayıyordu.

## 2. 409 neden güvenli ve yeniden teslimle tamamlanır

- 409'a giden yol tek Serializable tx içindedir: bayrak (`manualReviewAt`), `PaymentWebhookEvent` satırı, ledger `CAMPAIGN_REVOKE`,
  lot/redemption `REVOKED`, sayaç ve `AUTO_PAUSED` audit'i **birlikte** rollback olur. Test bunu doğrudan okur: 409 alan her teslim için
  `manualReviewAt = null`, `MANUAL_REVIEW_REQUIRED` olay sayısı 0, redemption hâlâ `GRANTED`.
- Yeniden teslim (aynı payload, aynı olay kimliği) `duplicate` değil `manual_review_required` döner — çünkü ilk teslim iz bırakmamıştır;
  test bunu da assert eder (sessiz yutma yok).
- Ondan sonra dördüncü kopya dahil her tekrar `duplicate` döner ve hiçbir finansal/operasyonel sayı değişmez (test son bloğu).

## 3. Yapılan değişiklik (yalnız test)

`counts concurrent revokes exactly and writes exactly one AUTO_PAUSED row` → `…, with a 409 loser completed by its redelivery`:

1. İlk dört paralel teslimin sonuçları toplanır. 200 → gövde `manual_review_required`; **yalnız** `409 {code: CONCURRENT_MODIFICATION}`
   geçici kabul edilir ve `lost` listesine alınır. Başka herhangi bir status/gövde → `toBe(409)` / `toMatchObject` ile test düşer.
2. Kaybedenlerin hiçbir şey commit etmediği doğrulanır (§2).
3. Kaybedenler aynı payload ile **sıralı** yeniden gönderilir; her biri 200 + `manual_review_required`.
4. Nihai assert'ler ilk turdan bağımsız: sayaç 4; 4 redemption `REVOKED`; 4 lot `REVOKED`; 4 `CAMPAIGN_REVOKE`; 4 `MANUAL_REVIEW_REQUIRED`
   olayı; kampanya `PAUSED`; tam 1 `AUTO_PAUSED` audit; her sağlayıcı ledger'ında tam bir `CAMPAIGN_REVOKE = −10` ve bakiye 25;
   `walletInvariant`.
5. Tüm teslimlerin ikinci kopyası → `duplicate`; sayaç/ledger/audit/bakiye değişmez.

**Deterministik kanıt (madde 3–4'ün birlikte karşılanması):** Doğal çekişmenin 409 üretip üretmeyeceği zamanlamaya bağlıdır; 409'u
yalnız tolere eden bir test, 409 oluşmayan koşumlarda retry yolunu hiç sınamaz. Bu yüzden `fixtures[0]` teslimi yalnız ilk turda
kaybettirilir: `vi.spyOn(CampaignRevokeService, 'revokeForRefundedPurchase')` o purchase için P2034 fırlatır, diğerleri gerçek
metoda geçer (`campaign-engine-hooks.spec.ts:805`'teki mevcut fault-injection örüntüsü). Stub'lanan tek şey bu throw'dur; retry döngüsü,
rollback, 409 eşlemesi, committed-state kontrolü ve yeniden teslim üretim kodudur. Spy `Promise.all(...).finally` içinde kaldırılır.
Diğer üç teslim gerçek Serializable çekişmesine girer; doğal 409 alırlarsa aynı dal onları da yeniden teslim eder.

## 4. Doğrulama

| Adım | Sonuç |
| --- | --- |
| RED — eski `4×200` assertion + deterministik P2034 | `AssertionError: expected 409 to be 200` @ spec:432 (CI flake imzasının aynısı, artık her koşumda) |
| GREEN — retry-aware assertion | `Tests 1 passed` |
| Uç deney (commit edilmedi): dört teslimin dördü ilk turda kaybettirildi | `Tests 1 passed` — çoklu kaybeden + sıralı yeniden teslim dalı da geçiyor |
| Tekrar koşum: `campaign-refund-revoke.spec.ts` tam dosya ×12 | 12/12 `Tests 11 passed (11)`; her koşumda tam 1 "unresolved after 3 attempts" (zorunlu kaybeden), doğal 409 yok |
| `pnpm typecheck` / `pnpm lint` | 5/5, 4/4 başarılı |
| `pnpm test` | shared 6/168, admin 5/65, web 37/338, **api 147 dosya / 3288 test** — tümü geçti (api süresi 676 s) |
| `pnpm build` | 3/3 başarılı |
| `pnpm e2e` (chromium, yerel) | 288 passed (8.7 dk); webkit yalnız CI |
| CI run 35656541011 (head `528acc4c`) | **3/3 yeşil**: typecheck·lint·test·build, e2e chromium, e2e webkit |

Dokunulmayan: `account-email-role-conflict` flake'i (backlog), diğer spec'ler, `runSerializable`, webhook servisi.
