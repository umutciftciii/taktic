# REQ-UX-010 — Telefon doğrulaması bekleyen talep: makbuz, CTA ve yaşam döngüsü dili — Teslim Raporu

Tarih: 2026-09-17 · Branch: `claude/phone-verification-pending-request-df3d9c` (taban `main` @ `efda3e09`) · Merge: **yapılmadı**

Migration yok. Prisma/schema, `.env`, compose/Dockerfile, Turnstile, SMS sağlayıcı, ödeme,
outbox/dedupe, vitrin lead, e-posta şablonları, admin ve provider ekranları değişmedi. Yeni
endpoint yok. Staging, yerel container/DB, Cloudflare ve dış servislere dokunulmadı.

Tasarım notu: `docs/superpowers/specs/2026-09-17-req-ux-010-phone-verification-pending-design.md`.

---

## 1. Durum matrisi (oturumlu sahip, normal marketplace talebi)

| Auto | Kapı (`REQUIRE_PHONE_VERIFICATION`) | Telefon | API durumu | `awaitingPhoneVerification` | Başarı ekranı | Detay özeti / kart / çizelge |
| --- | --- | --- | --- | --- | --- | --- |
| AÇIK | kapalı | — | `APPROVED` (doğar) | `false` | `published` "Talebiniz yayınlandı" (aynen) | "iletildi" / kart isteğe bağlı / "Ön inceleme ✓" (aynen) |
| AÇIK | açık | doğrulanmamış | `SUBMITTED` | **`true`** | **`verify` "Telefonunuzu doğrulayın"** + "Telefonumu doğrula" CTA; "ön inceleme"/"yayınlandı" yok | **"henüz iletilmedi… doğrulayın"** / kart **zorunlu** + "…uygun hizmet verenlere iletilir" / **Telefon doğrulama (Sizi bekliyor)**, "Ön inceleme" adımı yok |
| AÇIK | açık | doğrulandı | `APPROVED` (`verifyCode` yayınlar) | `false` | `published` | "iletildi" / kart yok / "Ön inceleme ✓" (mevcut davranış, §7) |
| KAPALI | açık | doğrulanmamış | `SUBMITTED` | **`true`** | `verify` + "…ön incelemeye alınır; onay sonrasında…" | kart zorunlu (ön inceleme cümlesi) / Telefon doğrulama → Ön inceleme (ikisi de bekliyor) |
| KAPALI | açık | doğrulandı | `SUBMITTED` (operatör) | `false` | `review` "ön incelemeye gönderildi" | "Talebiniz ön incelemede…" / kart yok / "Ön inceleme" bekliyor |
| KAPALI | kapalı | — | `SUBMITTED` | `false` | `review` (aynen) | "Talebiniz ön incelemede…" (**yeni**, eskiden "iletildi") / kart isteğe bağlı (aynen) / aynen |
| — | — | misafir/oturumsuz | — | alan yok (çağrı yok) | `guest` nötr makbuz (aynen) | — |

## 2. Kanonik doğrulama ve yayın yolu (değişmedi)

- Gönder: `POST /service-requests/:id/phone-verification` (Turnstile + AuthGuard + sahiplik; SMS test adapter). Doğrula: `POST …/phone-verification/verify` → `PhoneVerificationService.verifyCode`: serializable işlemde kodu tüketir, `phoneVerifiedAt` damgalar (`updateMany where phoneVerifiedAt: null`), ardından **aynı işlemde** `isAutoPublishEnabled() && publishRequestInTransaction(tx)` (`SUBMITTED` + `directShowcaseProviderId: null` koşullu `updateMany` → `APPROVED`, `approvedAt = now`, `moderatedAt` NULL) ve `publishOutbox.enqueue`. Commit sonrası `deliverSoon()`.
- Web server action'ları (`sendPhoneCodeAction` / `verifyPhoneCodeAction`) aynen; sonuç yalnız `?verification=<kelime>` ile döner. Kod/token URL, storage, SSR HTML veya log'a yazılmaz (mevcut sözleşme; API `code`'u hiçbir ortamda döndürmez).
- Frontend yayın kararı vermez: başarı ekranı ve detay sayfası yalnız `status` + `awaitingPhoneVerification`'ı okur; "sonra ne olur" cümlesi için mevcut fail-closed `GET /marketplace-publish-policy` okuması (REQ-UX-008/009 ile aynı) kullanılır, yalnız bekleyen talepte çağrılır.

## 3. Eklenen salt-okunur alan ve erişim sözleşmesi

`awaitingPhoneVerification: boolean` — yalnız `toCustomerServiceRequest` projeksiyonunda, yani
`GET /service-requests/my` ve `GET /service-requests/my/:id` (`AuthGuard` + `Roles(CUSTOMER)` +
`where { id, customerId }`).

`true` ⇔ `isPhoneVerificationRequired() && phoneVerifiedAt === null && status === SUBMITTED && directShowcaseProviderId === null`.
Otomatik yayın ayarını okumaz (kapı açıkken operatör de onaylayamaz — `PHONE_NOT_VERIFIED`), vitrin lead'i hiç işaretlemez, `SUBMITTED`'ı tek başına yorumlamaz.

Sızıntı sınırı (API testiyle kanıtlı): oturumsuz `my/:id` → 401; başka müşteri → 404; provider → 403 ve `GET /service-requests/:id/offers` 200 dönmez, gövdede alan yok; admin `GET /service-requests/:id` → 200 ama alan **yok**. Misafir makbuzu API çağrısı yapmaz; id üzerinden doğrulama durumu sızmaz. Misafir aktivasyon `redirectTo` zaten `/requests/:id/offers` — sahip olduktan sonra kart orada zorunlu kopyasıyla görünür.

## 4. Fanout / idempotency kanıtı

`apps/api/test/request-phone-verification-pending.spec.ts › the same request, once verified`:
doğrulama sonrası `APPROVED`, ikinci `verify` ve ikinci `send` **409**, iki `deliverPending()` sonra
`request-available` 1 SENT + `request-published` 1 SENT, bu iki şablon için toplam **2** `NotificationLog`
satırı (ikinci enqueue yok), `approvedAt === phoneVerifiedAt`, `moderatedAt` NULL.
E2E aynı şeyi gerçek stack'te doğrular (SENT=2, toplam=2). KAPALI + doğrulama: `request-available` 0.

## 5. Değişen yüzeyler

| Dosya | Değişiklik |
| --- | --- |
| `apps/api/src/modules/service-requests/service-requests.service.ts` | `isAwaitingPhoneVerification()` + projeksiyona alan |
| `apps/web/lib/request-lifecycle.ts` (**yeni**) | `afterVerificationSentence`, `maskPhoneForDisplay` (sayfadan taşındı), `requestSummaryBody`, `requestTimelineSteps`, `phoneVerificationCardCopy`, `noOffersYetText`, `VERIFY_PHONE_TITLE`, `PHONE_VERIFICATION_ANCHOR` |
| `apps/web/app/requests/success/page.tsx` | `verify` varyantı, `data-testid="request-success-verify-cta"` → `/requests/:id/offers#telefon-dogrulama` |
| `apps/web/app/requests/[id]/offers/page.tsx` | özet/çizelge yardımcılardan; `data-testid` `request-summary-body`, `request-timeline`; policy yalnız bekleyen talepte okunur |
| `…/phone-verification-card.tsx` | `required`/`autoPublishEnabled` prop'ları, `id="telefon-dogrulama"`, `data-required`, zorunluyken başlık |
| `…/offers-view.tsx` | `emptyText` prop'u; boş kutu bekleyen talepte "ulaştı" demez |
| `apps/web/lib/api.ts`, `apps/web/app/globals.css` | tip alanı; `.cdash-verify-title` |

Admin ve provider ekranları, e-posta şablonları (`request-received` zaten `nextStep: 'verify'` taşıyor) ve `/requests/my` panosu değişmedi.

## 6. Test / CI

- API (RED→GREEN): `request-phone-verification-pending.spec.ts` 6 test — dört hücre + KAPALI/kapalı + yetki/sızıntı. Tam API paketi: 127 dosya / 2951 test yeşil.
- Web (RED→GREEN): `request-success-screen.spec.ts` +4 (verify AÇIK/KAPALI/okunamadı, `SUBMITTED`+`false` → `review` ve policy çağrılmaz); `request-lifecycle.spec.ts` 13 test (özet, çizelge, kart, boş kutu). Web toplam 207 yeşil; admin 49, shared 165 yeşil.
- E2E: `phone-verification-gate.spec.ts › gate on + instant publish…` — `phoneGateRuntime` + `setAutoPublish(true)` (afterEach geri alır), iki tarayıcı (müşteri + provider, admin yok): makbuz `verify` → CTA → kart zorunlu → 320/768/1440'ta sayfa taşması yok, kart ve çizelge viewport içinde, buton metni kesilmemiş → provider listesi boş → kod test SMS outbox'ından → `APPROVED`, `approvedAt === phoneVerifiedAt`, `moderatedAt` NULL → sayfa "Onaylandı", kart yok → provider görür → SENT 2 / toplam 2. Ekran görüntüleri `e2e/.artifacts/req-ux-010/` (gitignored). İlgili 8 spec (43 test) + gate spec'inin 3 testi yerelde yeşil.
- `pnpm typecheck`, `pnpm lint`, `pnpm build` yeşil. CI üçlüsü PR üzerinde.

## 7. Açık riskler / kapsam dışı bırakılanlar

- AÇIK + doğrulama sonrası `APPROVED` talepte zaman çizelgesi "Ön inceleme ✓" gösterir — REQ-UX-009 §7'deki mevcut davranış (auto-yayınlanan her talepte aynı); "doğrulama bekleyen" durumda düzeltildi, gate-kapalı davranışı korumak için genel etiket değiştirilmedi.
- `/requests/my` panosu bekleyen talebi "Gönderildi" rozeti ve "İncelemede" sekmesiyle gösterir; alan listede de var, rozet eklenmedi (kapsam dışı).
- Landing pazarlama kopyası ("Admin ön inceleme") REQ-UX-009'dan beri açık.
- Policy okuma başarısızsa bekleyen talepte "ön incelemeye alınır" cümlesi gösterilir (fail-closed, mevcut sözleşme).
