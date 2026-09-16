# SEC-ANTIABUSE-001 — Cloudflare Turnstile ile müşteri kaynaklı spam/bot koruması — tasarım

Tarih: 2026-09-16 · Durum: uygulamaya hazır · Önceki iş: kimlik gate'i (PR #75), REQ-UX paketi (PR #82)

## 0. Amaç, tehdit modeli, kapsam

**Sorun.** Beş müşteri kaynaklı yazma ucu oturumsuz ya da ucuz bir oturumla erişilebilir
ve her biri bir maliyet üretir: talep kaydı (moderasyon kuyruğu, otomatik yayın açıkken
doğrudan sağlayıcı önü), vitrin lead'i (işletmeye ulaşan mesaj + SLA saati), SMS gönderimi
(sağlayıcı ücreti), aktivasyon maili (posta itibarı), kimlik ön-kontrolü (hesap varlığı
sorgusu). Mevcut savunmalar — IP throttle, numara başına bütçeler, telefon kanıtı,
kimlik gate'i — bir script'in maliyetini yükseltir ama bir botnet'in dağıtık, düşük
hızlı gürültüsünü ayırt edemez.

**Tehdit modeli.**

| Saldırgan | Yol | Turnstile'ın katkısı |
|---|---|---|
| Kafasız script (curl, HTTP kütüphanesi) | Doğrudan API'ye POST | Token yok → 403, sıfır yan etki |
| Tarayıcısız bot, token taklidi | Uydurma/eski token | `siteverify` reddeder; hostname/action eşleşmez → 403 |
| Tek token'ı çoğaltan bot | Aynı token'ı tekrar/başka uçta | API tarafı tek-kullanım kilidi + Cloudflare tek-kullanım → 403 |
| Başka sitede alınmış token | Farklı hostname | Beklenen hostname listesi → 403 |
| Doğrulama altyapısını çökertme | siteverify timeout / 5xx | Fail-closed: 503, sıfır yan etki, "tekrar deneyin" |
| Yapılandırma hatası (secret eksik) | Sessiz korumasız çalışma | Boot reddi; `off`/`test` yalnız local/test'te |

**Kapsam — korunan uçlar (6 route, 5 operasyon).**

| # | Operasyon | Route | Action adı |
|---|---|---|---|
| 1 | Normal talep | `POST /service-requests` | `service-request-create` |
| 2 | Vitrin direct lead | `POST /showcase/cards/:cardId/leads` | `showcase-lead-create` |
| 3a | Telefon kodu (vitrin, oturumsuz) | `POST /showcase/lead-verification` | `phone-code-send` |
| 3b | Telefon kodu (normal talep, oturumlu) | `POST /service-requests/:id/phone-verification` | `phone-code-send` |
| 4 | Kimlik ön-kontrolü | `POST /auth/request-identity-check` | `identity-check` |
| 5 | Aktivasyon bağlantısı | `POST /auth/request-identity-check/activate` | `identity-activate` |

Kod *doğrulama* uçları (`…/verify`) kapsam dışı: SMS göndermez, deneme bütçeleri var.

**Değişmeyen.** Rate-limit'ler, telefon doğrulama, kimlik gate'i, RequestDraft,
activation redirect, hata sözleşmeleri (4xx/409/403 kodları ve metinleri). Migration,
Prisma şeması, ödeme, kredi, e-posta/SMS sağlayıcıları, scheduler yok.

---

## 1. Güvenlik sözleşmesi

1. **Yalnız API doğrular.** Tarayıcı token üretir, web sunucusu yalnız taşır. Web
   tarafında "widget başarılı" bir güvenlik kararı değildir.
2. **Taşıma: tek amaçlı header** `x-turnstile-token`. DTO'ya alan eklenmez; server
   action ve `/api/auth/request-identity-check*` proxy'leri header'ı API'ye iletir.
   Token bir server action'a **ayrı argüman** olarak gelir — FormData'ya, dolayısıyla
   `draftPayloadFromForm`'a asla girmez.
3. **Token hiçbir yere yazılmaz:** URL, RequestDraft, localStorage/sessionStorage,
   log, NotificationLog, hata gövdesi. Guard token'ın kendisini değil SHA-256
   özetini tek-kullanım kilidi için bellekte tutar (5 dk TTL).
4. **Her korunan eylem yeni token.** Web adapter'ı `acquire(action)` başına yeni
   challenge çalıştırır; tüketilen token bir daha verilmez. API, bir token'ı ilk
   görüşünde (sonuç ne olursa olsun) kilitler → tekrar ve çapraz-uç kullanımı 403.
5. **`siteverify` değerlendirmesi:** `success === true` **ve** `hostname ∈
   TURNSTILE_EXPECTED_HOSTNAMES` **ve** `action === beklenen action`. Diğer her şey
   (`error-codes`, eksik alan, JSON değil, 2xx değil, timeout, ağ hatası) ret.
6. **Gerçek IP.** `remoteip` yalnız Express `req.ip`'ten (TRUST_PROXY sözleşmesi);
   X-Forwarded-For doğrudan okunmaz.
7. **Fail-closed.** Guard, controller'dan önce çalışır; ret → hiçbir servis metodu
   çağrılmaz → hiçbir yazma, SMS, mail, taslak tüketimi, NotificationLog olmaz.
8. **Boot stratejisi.** `TURNSTILE_MODE` (`cloudflare` | `test` | `off`; varsayılan
   `cloudflare`). `cloudflare` → `TURNSTILE_SECRET_KEY` ve
   `TURNSTILE_EXPECTED_HOSTNAMES` zorunlu, yoksa **boot reddi** (değer değil, ad
   loglanır). `test`/`off` → yalnız `NODE_ENV=test` ya da (`APP_ENVIRONMENT=local`
   ve `NODE_ENV≠production`) iken; staging/production benzeri her yapılandırmada
   boot reddi. Cloudflare'ın test anahtarları hiçbir yerde varsayılan değildir.

**Hata sözleşmesi (guard).**

| Durum | HTTP | `code` |
|---|---|---|
| Header yok / boş | 403 | `TURNSTILE_REQUIRED` |
| Geçersiz, süresi dolmuş, hostname/action uyuşmaz, tekrar kullanım | 403 | `TURNSTILE_FAILED` |
| siteverify timeout / 5xx / bozuk yanıt / ağ hatası | 503 | `TURNSTILE_UNAVAILABLE` |

Hiçbir gövde kimlik/telefon durumu hakkında bilgi taşımaz. Guard sırası:
throttle guard → Turnstile guard → auth guard; böylece rate-limit Turnstile'dan
bağımsız çalışmayı sürdürür ve geçerli token'lı sel yine bütçeye takılır.

---

## 2. API tasarımı — `apps/api/src/modules/turnstile/`

- `turnstile.config.ts` — `resolveTurnstileConfig(env)`, `assertTurnstileConfig()`
  (main.ts'te diğer assert'lerin yanında), `isTurnstileBypassPermitted()`.
- `turnstile-verifier.port.ts` — `abstract class TurnstileVerifierPort { verify({token, action, remoteIp}) → Verdict }`.
  Verdict: `{ ok: true } | { ok: false; reason: 'TOKEN_MISSING' | 'TOKEN_INVALID' | 'ACTION_MISMATCH' | 'HOSTNAME_MISMATCH' | 'VERIFIER_UNAVAILABLE' }`.
- `cloudflare-turnstile.verifier.ts` — `fetch` enjekte edilir (test için stub),
  `AbortController` timeout (`TURNSTILE_SITEVERIFY_TIMEOUT_MS`, varsayılan 5000),
  form-encoded POST, `idempotency_key` yok (tek deneme; fail-closed).
- `test-turnstile.verifier.ts` — deterministik: `turnstile-test:<action>:<nonce>`
  kabul; `<action>` beklenenle eşleşmeli; `__unavailable__` → `VERIFIER_UNAVAILABLE`;
  başka her şey `TOKEN_INVALID`.
- `off-turnstile.verifier.ts` — her zaman `ok` (yalnız izinli ortamda bağlanır).
- `turnstile-replay.cache.ts` — SHA-256 özet → son kullanma; `claim(token)`.
- `turnstile.guard.ts` + `turnstile.decorators.ts` — `@TurnstileAction('…')`
  metadata; metadata yoksa guard reddeder (yanlış kullanım fail-closed).
- `turnstile.module.ts` — `@Global()`, port'u moda göre factory ile bağlar.

Paylaşılan sabitler (`packages/shared/turnstile.json`): header adı, test-token
öneki, action adları. JSON olduğu için API'den de (CommonJS) güvenle import edilir.

---

## 3. Web tasarımı

- `apps/web/lib/turnstile.ts` — `readTurnstileWebConfig(env)`: `TURNSTILE_MODE` +
  `TURNSTILE_SITE_KEY` (site key **public**, secret ile ayrı; sunucuda çalışma
  zamanında okunur, `NEXT_PUBLIC_` derleme zamanı sabiti değildir — E2E her
  runtime'a ayrı env verebilsin). `test`/`off` yalnız `APP_ENVIRONMENT=local`.
  `turnstileHeaders(token)`, `makeTestTurnstileToken(action, nonce)`.
- `apps/web/app/request-fields/turnstile.tsx` — `useTurnstile(config)` +
  `<TurnstileSlot>`. Modlar: `cloudflare` (api.js explicit render,
  `execution: 'execute'`, `appearance: 'interaction-only'`, action başına
  remove+render+execute, callback → token, error/expired/timeout → ret),
  `test` (ağ yok; `window.__TAKTIC_TURNSTILE_TEST__` ile E2E'nin `error` /
  `invalid` / `unavailable` senaryoları), `off` (token yok), `unconfigured`
  (acquire reddeder; slot "kullanılamıyor" der — UI'da da fail-closed).
- `useIdentityCheck` → opsiyonel `acquireToken`; alım/doğrulama hatası mevcut
  `error` durumuna düşer ("İletişim bilgileri doğrulanamadı, tekrar deneyin.").
- Server action imzaları: `submitServiceRequestAction(formData, token)`,
  `createShowcaseLeadAction(formData, token)`, `startShowcaseLeadVerificationAction(phone, token)`,
  `sendPhoneCodeAction(requestId, token)`. Proxy route'lar `x-turnstile-token`'ı iletir.
- Kullanıcı metinleri (`REQUEST_REFUSAL_TEXTS`): `TURNSTILE_REQUIRED`/`TURNSTILE_FAILED`
  → "Güvenlik doğrulaması başarısız oldu. Lütfen tekrar deneyin.";
  `TURNSTILE_UNAVAILABLE` → "Güvenlik doğrulaması şu anda yapılamıyor. Lütfen birkaç
  saniye sonra tekrar deneyin."; widget hatası (`TURNSTILE_CHALLENGE_FAILED`) →
  "Güvenlik doğrulaması tamamlanamadı. Lütfen tekrar deneyin."
- Slot her iki formda adım panellerinin dışında, eylem düğmelerinin hemen üstünde:
  etkileşimli challenge son adımda da görünür. Form sırası, taslak, identity
  notice, SMS akışı değişmez. Teklifler sayfasındaki "Doğrulama kodu gönder"
  formu bir client bileşenine taşınır.

---

## 4. Konfigürasyon

| Değişken | Uygulama | Ortam | Güvenli varsayılan |
|---|---|---|---|
| `TURNSTILE_MODE` | api, web | hepsi | yok → `cloudflare` (anahtar ister) |
| `TURNSTILE_SECRET_KEY` | **yalnız api** | staging/prod | yok → boot reddi |
| `TURNSTILE_EXPECTED_HOSTNAMES` | api | staging/prod | yok → boot reddi |
| `TURNSTILE_SITEVERIFY_TIMEOUT_MS` | api | opsiyonel | 5000 |
| `TURNSTILE_SITE_KEY` | web | staging/prod | yok → widget "kullanılamıyor" |
| `APP_ENVIRONMENT=local` | api, web | local | `test`/`off` için ön koşul |

`.env.example`'a yorumlu, değersiz. Gerçek `.env`, compose, GitHub secret,
Cloudflare paneli bu işte değişmez. **Not:** compose API/web servislerine yeni
değişken geçirmediği için yerel Docker stack'i merge sonrası `TURNSTILE_MODE` +
`APP_ENVIRONMENT` eklenene kadar boot etmez — bilinçli, gürültülü fail-closed.

---

## 5. Test planı

- API birim: config (her mod/ortam kombinasyonu, boot reddi), Cloudflare verifier
  (stub fetch: success, hostname/action uyuşmazlığı, error-codes, timeout, 5xx,
  bozuk JSON, secret/token'ın loga düşmediği), test verifier, replay cache.
- API entegrasyon (`turnstile-protection.spec.ts`): 6 route × {geçerli token →
  eski davranış; eksik; geçersiz; action uyuşmaz; hostname uyuşmaz; tekrar; çapraz
  uç; timeout; 5xx; bozuk yanıt} → statü + **0 yan etki** (ServiceRequest,
  ShowcaseLead, PhoneVerification, NotificationLog, RequestDraft.consumedAt,
  CustomerActivationToken, sms/notification recorder). Rate-limit'in geçerli
  token'la da 429 verdiği.
- Web birim: config çözümü, header yardımcıları, test token biçimi, token'ın
  taslak payload'una girmediği.
- E2E (`turnstile-protection.spec.ts`, Chromium + WebKit): normal form, vitrin
  lead + OTP, teklif sayfası OTP, identity gate — `test` modunda başarı;
  `invalid`/`unavailable`/`error` override'larıyla kısa Türkçe hata ve "tekrar
  deneyin"; token'ın URL/DOM'da/depoda olmadığı.
